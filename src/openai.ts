import { Request, Response } from 'express';
import { config } from './config.js';
import { selectNextKey, handleKeyFailure, handleKeySuccess, SelectedKey } from './router.js';
import { logRequest, updateDailyUsage } from './db.js';

interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export async function forwardChatCompletions(req: Request, res: Response, retryCount = 0): Promise<void> {
  const startTime = Date.now();
  let body = { ...req.body };

  // 1. Normalize Model & Token Limits
  if (!body.model) {
    body.model = config.openaiDefaultModel;
  }

  const hasMaxTokens = body.max_tokens !== undefined;
  const hasMaxCompletionTokens = body.max_completion_tokens !== undefined;

  if (hasMaxTokens && hasMaxCompletionTokens) {
    res.status(400).json({
      error: {
        message: 'Cannot specify both max_tokens and max_completion_tokens. Please use max_completion_tokens.',
        type: 'invalid_request_error',
        code: 'ambiguous_token_limit'
      }
    });
    return;
  }

  // Normalize max_tokens to max_completion_tokens
  if (hasMaxTokens) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  const isStream = body.stream === true;

  // For streaming, inject stream_options to get usage details at the end
  if (isStream) {
    body.stream_options = {
      ...body.stream_options,
      include_usage: true
    };
  }

  let selectedKey: SelectedKey;
  try {
    selectedKey = selectNextKey();
  } catch (error: any) {
    if (error.message === 'upstream_quota_exhausted') {
      res.status(429).json({
        error: {
          message: 'All upstream keys are exhausted or unavailable. Please try again later.',
          type: 'proxy_error',
          code: 'upstream_quota_exhausted'
        }
      });
      return;
    }
    res.status(500).json({
      error: {
        message: 'Internal Proxy Error: ' + error.message,
        type: 'proxy_error',
        code: 'internal_error'
      }
    });
    return;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);

  // Hook into client disconnection to cancel upstream request immediately
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`🔌 Client disconnected. Aborting upstream request on key ${selectedKey.hash.substring(0, 8)}.`);
      controller.abort();
    }
  });

  try {
    const upstreamUrl = `${config.openaiBaseUrl}/chat/completions`;
    
    const response = await fetch(upstreamUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${selectedKey.key}`
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    // 2. Handle Upstream Errors (Retryable vs Permanent)
    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: any = {};
      try {
        errorJson = JSON.parse(errorText);
      } catch {}

      const errorMsg = errorJson?.error?.message || errorText || response.statusText;
      
      // Update key failure status in SQLite
      handleKeyFailure(selectedKey.hash, selectedKey.type, response.status, errorMsg);

      // Attempt retry if limits permit and it's a retryable error status (429, 500, 502, 503, 504)
      const isRetryable = [429, 500, 502, 503, 504].includes(response.status);
      if (isRetryable && selectedKey.type === 'free' && retryCount < config.maxRetries) {
        console.log(`🔄 Retryable error ${response.status}. Retrying another key... (Attempt ${retryCount + 1}/${config.maxRetries})`);
        return forwardChatCompletions(req, res, retryCount + 1); // Recurse to try next key
      }

      // Propagate the upstream error back to client
      res.status(response.status).json(errorJson || {
        error: {
          message: errorMsg,
          type: 'upstream_error',
          code: 'upstream_failed'
        }
      });
      return;
    }

    // Key succeeded! Update success state in SQLite
    handleKeySuccess(selectedKey.hash, selectedKey.type);

    // Set custom headers to inform client about model and routing tier
    res.setHeader('X-Proxy-Upstream-Model', body.model);
    res.setHeader('X-Proxy-Upstream-Key-Type', selectedKey.type);

    if (isStream) {
      // 3. STREAMING FLOW (SSE)
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      if (!response.body) {
        throw new Error('Response body is empty');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      
      let sseBuffer = '';
      let promptTokens = 0;
      let completionTokens = 0;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk); // write chunk back to client immediately

        // Parse SSE chunk to extract token usage
        sseBuffer += chunk;
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || ''; // keep partial line in buffer

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.substring(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.usage) {
                const u = parsed.usage as Usage;
                promptTokens = u.prompt_tokens;
                completionTokens = u.completion_tokens;
              }
            } catch {}
          }
        }
      }

      res.end(); // finish client response

      const latency = Date.now() - startTime;
      const totalTokens = promptTokens + completionTokens;

      // Fallback rough token estimation if upstream didn't provide usage in stream
      let finalInputTokens = promptTokens;
      let finalOutputTokens = completionTokens;
      if (totalTokens === 0) {
        const promptLength = JSON.stringify(body.messages).length;
        finalInputTokens = Math.max(1, Math.round(promptLength / 4));
        finalOutputTokens = 100; // conservative estimate for stream
      }

      // Log statistics
      logRequest({
        upstreamKeyHash: selectedKey.hash,
        model: body.model,
        statusCode: 200,
        latencyMs: latency,
        estimatedInputTokens: finalInputTokens,
        estimatedOutputTokens: finalOutputTokens,
        keyType: selectedKey.type
      });

      updateDailyUsage(selectedKey.hash, finalInputTokens + finalOutputTokens);

    } else {
      // 4. NON-STREAMING FLOW
      const responseJson = await response.json() as any;
      res.json(responseJson); // return JSON response

      const latency = Date.now() - startTime;
      let promptTokens = responseJson.usage?.prompt_tokens;
      let completionTokens = responseJson.usage?.completion_tokens;

      // Fallback estimation
      if (promptTokens === undefined) {
        const promptLength = JSON.stringify(body.messages).length;
        const respLength = JSON.stringify(responseJson).length;
        promptTokens = Math.max(1, Math.round(promptLength / 4));
        completionTokens = Math.max(1, Math.round(respLength / 4));
      }

      // Log statistics
      logRequest({
        upstreamKeyHash: selectedKey.hash,
        model: body.model,
        statusCode: 200,
        latencyMs: latency,
        estimatedInputTokens: promptTokens,
        estimatedOutputTokens: completionTokens,
        keyType: selectedKey.type
      });

      updateDailyUsage(selectedKey.hash, promptTokens + completionTokens);
    }

  } catch (error: any) {
    clearTimeout(timeoutId);
    
    // Check if it was an aborted request
    const isAbort = error.name === 'AbortError';
    const status = isAbort ? 499 : 500;
    const msg = isAbort ? 'Client Aborted Request or Connection Timeout' : error.message;

    console.error(`❌ Request failed on key ${selectedKey.hash.substring(0, 8)}:`, msg);

    if (!isAbort) {
      handleKeyFailure(selectedKey.hash, selectedKey.type, 500, error.message);
    }

    if (!res.headersSent) {
      res.status(status).json({
        error: {
          message: msg,
          type: 'proxy_error',
          code: isAbort ? 'request_aborted' : 'internal_error'
        }
      });
    }
  }
}

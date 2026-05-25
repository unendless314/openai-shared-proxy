import { Request, Response } from 'express';
import { config } from './config.js';
import { selectNextKey, handleKeyFailure, handleKeySuccess, SelectedKey } from './router.js';
import { logRequest, updateDailyUsage } from './db.js';

export interface ProxyUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ProxyAdapter {
  name: 'chat_completions' | 'responses';
  upstreamPath: string;
  normalizeBody(body: any): { ok: true; body: any } | { ok: false; status: number; error: any };
  isStreamRequest(body: any): boolean;
  extractUsageFromJson(body: any, upstreamJson: any): { usage: ProxyUsage | null; statusCode?: number };
  createStreamTracker(body: any): {
    onChunk(chunk: string): void;
    finalize(): { usage: ProxyUsage | null; statusCode?: number };
  };
  estimateUsageFallback(body: any, responseJson?: any): ProxyUsage;
}

// ----------------------------------------------------
// Chat Completions Adapter
// ----------------------------------------------------
export const chatAdapter: ProxyAdapter = {
  name: 'chat_completions',
  upstreamPath: '/chat/completions',

  normalizeBody(body: any) {
    const nextBody = { ...body };

    if (!nextBody.model) {
      nextBody.model = config.openaiDefaultModel;
    }

    const hasMaxTokens = nextBody.max_tokens !== undefined;
    const hasMaxCompletionTokens = nextBody.max_completion_tokens !== undefined;

    if (hasMaxTokens && hasMaxCompletionTokens) {
      return {
        ok: false,
        status: 400,
        error: {
          error: {
            message: 'Cannot specify both max_tokens and max_completion_tokens. Please use max_completion_tokens.',
            type: 'invalid_request_error',
            code: 'ambiguous_token_limit'
          }
        }
      };
    }

    if (hasMaxTokens) {
      nextBody.max_completion_tokens = nextBody.max_tokens;
      delete nextBody.max_tokens;
    }

    if (nextBody.reasoningSummary !== undefined) {
      delete nextBody.reasoningSummary;
    }

    if (nextBody.tools && nextBody.reasoning_effort !== undefined) {
      console.log("🛠️ Tool call detected along with reasoning_effort. Stripping 'reasoning_effort' to ensure compatibility.");
      delete nextBody.reasoning_effort;
    }

    if (nextBody.stream === true) {
      nextBody.stream_options = {
        ...nextBody.stream_options,
        include_usage: true
      };
    }

    return { ok: true, body: nextBody };
  },

  isStreamRequest(body: any) {
    return body.stream === true;
  },

  extractUsageFromJson(body: any, upstreamJson: any) {
    if (!upstreamJson?.usage) return { usage: null };
    const u = upstreamJson.usage;
    return {
      usage: {
        inputTokens: u.prompt_tokens || 0,
        outputTokens: u.completion_tokens || 0,
        cachedInputTokens: u.prompt_tokens_details?.cached_tokens || 0
      }
    };
  },

  createStreamTracker(body: any) {
    let sseBuffer = '';
    let promptTokens = 0;
    let completionTokens = 0;
    let cachedTokens = 0;

    return {
      onChunk(chunk: string) {
        sseBuffer += chunk;
        const lines = sseBuffer.split('\n');
        sseBuffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith('data: ')) {
            const dataStr = trimmed.substring(6).trim();
            if (dataStr === '[DONE]') continue;
            try {
              const parsed = JSON.parse(dataStr);
              if (parsed.usage) {
                const u = parsed.usage;
                promptTokens = u.prompt_tokens || 0;
                completionTokens = u.completion_tokens || 0;
                if (u.prompt_tokens_details?.cached_tokens) {
                  cachedTokens = u.prompt_tokens_details.cached_tokens;
                }
              }
            } catch {}
          }
        }
      },
      finalize() {
        if (promptTokens === 0 && completionTokens === 0) return { usage: null };
        return {
          usage: {
            inputTokens: promptTokens,
            outputTokens: completionTokens,
            cachedInputTokens: cachedTokens
          }
        };
      }
    };
  },

  estimateUsageFallback(body: any, responseJson?: any) {
    const promptLength = JSON.stringify(body.messages || []).length;
    const inputEst = Math.max(1, Math.round(promptLength / 4));
    let outputEst = 100;

    if (responseJson) {
      const respLength = JSON.stringify(responseJson).length;
      outputEst = Math.max(1, Math.round(respLength / 4));
    }

    return {
      inputTokens: inputEst,
      outputTokens: outputEst,
      cachedInputTokens: 0
    };
  }
};

// ----------------------------------------------------
// Responses Adapter
// ----------------------------------------------------
export const responsesAdapter: ProxyAdapter = {
  name: 'responses',
  upstreamPath: '/responses',

  normalizeBody(body: any) {
    const nextBody = { ...body };

    if (!nextBody.model) {
      nextBody.model = config.openaiDefaultModel;
    }

    const hasMaxTokens = nextBody.max_tokens !== undefined;
    const hasMaxOutputTokens = nextBody.max_output_tokens !== undefined;

    if (hasMaxTokens && hasMaxOutputTokens) {
      return {
        ok: false,
        status: 400,
        error: {
          error: {
            message: 'Cannot specify both max_tokens and max_output_tokens. Please use max_output_tokens.',
            type: 'invalid_request_error',
            code: 'ambiguous_token_limit'
          }
        }
      };
    }

    if (hasMaxTokens) {
      nextBody.max_output_tokens = nextBody.max_tokens;
      delete nextBody.max_tokens;
    }

    return { ok: true, body: nextBody };
  },

  isStreamRequest(body: any) {
    return body.stream === true;
  },

  extractUsageFromJson(body: any, upstreamJson: any) {
    const u = upstreamJson?.usage;
    const usage = u ? {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cachedInputTokens: u.input_tokens_details?.cached_tokens || 0
    } : null;

    let statusCode = 200;
    const status = upstreamJson?.status;
    if (status === 'failed') {
      statusCode = 500;
    } else if (status === 'incomplete') {
      statusCode = 400;
    }

    return {
      usage,
      statusCode
    };
  },

  createStreamTracker(body: any) {
    let sseBuffer = '';
    let extractedUsage: ProxyUsage | null = null;
    let terminalStatus: 'completed' | 'failed' | 'incomplete' | null = null;

    return {
      onChunk(chunk: string) {
        sseBuffer += chunk;
        
        // Normalize CRLF to LF, and split by double line breaks
        const normalizedBuffer = sseBuffer.replace(/\r\n/g, '\n');
        const blocks = normalizedBuffer.split('\n\n');
        sseBuffer = blocks.pop() || '';

        for (const block of blocks) {
          const lines = block.split('\n');
          let eventName = '';
          const dataLines: string[] = [];

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('event:')) {
              eventName = trimmed.substring(6).trim();
            } else if (trimmed.startsWith('data:')) {
              dataLines.push(trimmed.substring(5).trim());
            }
          }

          const dataStr = dataLines.join('\n');

          if (dataStr && dataStr.trim() !== '[DONE]') {
            try {
              const eventData = JSON.parse(dataStr);
              const effectiveEventName = eventName || eventData.type;

              if (effectiveEventName === 'response.completed') {
                terminalStatus = 'completed';
                const usage = eventData.response?.usage;
                if (usage) {
                  extractedUsage = {
                    inputTokens: usage.input_tokens || 0,
                    outputTokens: usage.output_tokens || 0,
                    cachedInputTokens: usage.input_tokens_details?.cached_tokens || 0
                  };
                }
              } else if (effectiveEventName === 'response.failed') {
                terminalStatus = 'failed';
                const usage = eventData.response?.usage;
                if (usage) {
                  extractedUsage = {
                    inputTokens: usage.input_tokens || 0,
                    outputTokens: usage.output_tokens || 0,
                    cachedInputTokens: usage.input_tokens_details?.cached_tokens || 0
                  };
                }
              } else if (effectiveEventName === 'response.incomplete') {
                terminalStatus = 'incomplete';
                const usage = eventData.response?.usage;
                if (usage) {
                  extractedUsage = {
                    inputTokens: usage.input_tokens || 0,
                    outputTokens: usage.output_tokens || 0,
                    cachedInputTokens: usage.input_tokens_details?.cached_tokens || 0
                  };
                }
              }
            } catch (err) {
              console.error('Failed to parse response.completed SSE JSON:', err);
            }
          }
        }
      },
      finalize() {
        let statusCode = 200;
        if (terminalStatus === 'failed') {
          statusCode = 500;
        } else if (terminalStatus === 'incomplete') {
          statusCode = 400;
        }
        return {
          usage: extractedUsage,
          statusCode
        };
      }
    };
  },

  estimateUsageFallback(body: any, responseJson?: any) {
    const promptLength = JSON.stringify(body.input || body).length;
    const inputEst = Math.max(1, Math.round(promptLength / 4));
    let outputEst = 100;

    if (responseJson) {
      const respLength = JSON.stringify(responseJson).length;
      outputEst = Math.max(1, Math.round(respLength / 4));
    }

    return {
      inputTokens: inputEst,
      outputTokens: outputEst,
      cachedInputTokens: 0
    };
  }
};

// ----------------------------------------------------
// Shared Transport Executor
// ----------------------------------------------------
export async function forwardWithAdapter(
  req: Request,
  res: Response,
  adapter: ProxyAdapter,
  retryCount = 0
): Promise<void> {
  const startTime = Date.now();

  // 1. Normalize Body & Parameter Validations
  const normResult = adapter.normalizeBody(req.body);
  if (!normResult.ok) {
    res.status(normResult.status).json(normResult.error);
    return;
  }
  const body = normResult.body;
  const isStream = adapter.isStreamRequest(body);

  // 2. Upstream Key Selection
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

  // Client disconnection listener
  res.on('close', () => {
    if (!res.writableEnded) {
      console.log(`🔌 Client disconnected. Aborting upstream request for /v1${adapter.upstreamPath} on key ${selectedKey.hash.substring(0, 8)}.`);
      controller.abort();
    }
  });

  try {
    const upstreamUrl = `${config.openaiBaseUrl}${adapter.upstreamPath}`;

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

    // 3. Handle Upstream Errors (Retryable vs Permanent)
    if (!response.ok) {
      const errorText = await response.text();
      let errorJson: any = {};
      try {
        errorJson = JSON.parse(errorText);
      } catch {}

      const errorMsg = errorJson?.error?.message || errorText || response.statusText;

      handleKeyFailure(selectedKey.hash, selectedKey.type, response.status, errorMsg);

      const isRetryable = [429, 500, 502, 503, 504].includes(response.status);
      if (isRetryable && selectedKey.type === 'free' && retryCount < config.maxRetries) {
        console.log(`🔄 Retryable error ${response.status} on /v1${adapter.upstreamPath}. Retrying next key... (Attempt ${retryCount + 1}/${config.maxRetries})`);
        return forwardWithAdapter(req, res, adapter, retryCount + 1);
      }

      const hasErrorStructure = errorJson && typeof errorJson === 'object' && errorJson.error;
      res.status(response.status).json(hasErrorStructure ? errorJson : {
        error: {
          message: errorMsg,
          type: 'upstream_error',
          code: 'upstream_failed'
        }
      });
      return;
    }

    // Success: Update state
    handleKeySuccess(selectedKey.hash, selectedKey.type);

    res.setHeader('X-Proxy-Upstream-Model', body.model || 'default');
    res.setHeader('X-Proxy-Upstream-Key-Type', selectedKey.type);

    if (isStream) {
      // --- STREAMING MODE (SSE) ---
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      if (!response.body) {
        throw new Error('Response body is empty');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const streamTracker = adapter.createStreamTracker(body);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        res.write(chunk);

        streamTracker.onChunk(chunk);
      }

      res.end();

      const latency = Date.now() - startTime;
      const trackerResult = streamTracker.finalize();
      let finalUsage = trackerResult.usage;
      const loggedStatus = trackerResult.statusCode || 200;

      if (!finalUsage) {
        finalUsage = adapter.estimateUsageFallback(body);
      }

      logRequest({
        upstreamKeyHash: selectedKey.hash,
        model: body.model || 'default',
        statusCode: loggedStatus,
        latencyMs: latency,
        estimatedInputTokens: finalUsage.inputTokens,
        estimatedOutputTokens: finalUsage.outputTokens,
        cachedInputTokens: finalUsage.cachedInputTokens,
        keyType: selectedKey.type
      });

      updateDailyUsage(selectedKey.hash, finalUsage.inputTokens, finalUsage.outputTokens, finalUsage.cachedInputTokens);

    } else {
      // --- NON-STREAMING MODE ---
      const responseJson = await response.json() as any;
      res.json(responseJson);

      const latency = Date.now() - startTime;
      const result = adapter.extractUsageFromJson(body, responseJson);
      let finalUsage = result.usage;
      const loggedStatus = result.statusCode || 200;

      if (!finalUsage) {
        finalUsage = adapter.estimateUsageFallback(body, responseJson);
      }

      logRequest({
        upstreamKeyHash: selectedKey.hash,
        model: body.model || 'default',
        statusCode: loggedStatus,
        latencyMs: latency,
        estimatedInputTokens: finalUsage.inputTokens,
        estimatedOutputTokens: finalUsage.outputTokens,
        cachedInputTokens: finalUsage.cachedInputTokens,
        keyType: selectedKey.type
      });

      updateDailyUsage(selectedKey.hash, finalUsage.inputTokens, finalUsage.outputTokens, finalUsage.cachedInputTokens);
    }

  } catch (error: any) {
    clearTimeout(timeoutId);

    const isAbort = error.name === 'AbortError';
    const status = isAbort ? 499 : 500;
    const msg = isAbort ? 'Client Aborted Request or Connection Timeout' : error.message;

    console.error(`❌ Request failed on key ${selectedKey.hash.substring(0, 8)} for /v1${adapter.upstreamPath}:`, msg);

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

// ----------------------------------------------------
// Public Entry Wrappers
// ----------------------------------------------------
export async function forwardChatCompletions(req: Request, res: Response): Promise<void> {
  return forwardWithAdapter(req, res, chatAdapter);
}

export async function forwardResponses(req: Request, res: Response): Promise<void> {
  return forwardWithAdapter(req, res, responsesAdapter);
}

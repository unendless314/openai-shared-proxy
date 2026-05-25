# OpenAI Shared Routing Proxy - `POST /v1/responses` MVP 支援與優化重構方案 (Revised Plan)

本方案為綜合評估 Version B 設計立場後的**修訂版重構方案**。我們將採納 Version B 的**「共享執行層 + 端點適配器」**架構，以極低的維護風險，優雅地實現 `POST /v1/responses` MVP 支援，同時徹底解決前一版方案中的各項潛在風險。

---

## 1. 核心評估與修訂要點

針對前一版方案的審查意見，本修訂版做出了以下關鍵修正：

1.  **修正 Responses Usage 與快取統計 (高風險修正)**：
    *   **欄位映射**：不再混淆傳統的 `prompt`/`completion`。在上游回應中，精確擷取官方的 `input_tokens`、`output_tokens`，以及 `input_tokens_details.cached_tokens`。
    *   **串流事件解析 (SSE Event Parser)**：Responses 串流是語義化事件流（如 `response.completed`），我們將實作**事件區塊級（Event Block-based）**的旁路觀察器。解析器以 SSE block 為單位處理資料，支援多行 `data:`、容忍 `\r\n` 換行差異，並以 `event:` 欄位或 JSON 內的 `type` 作為事件辨識依據。僅在監聽到包含完整 usage 數據的完成事件時提取統計資訊，其餘 chunk 原樣傳回客戶端。
2.  **明確定義 MVP 範圍 (中風險修正)**：
    *   本方案定位為 **`POST /v1/responses` MVP 支援**。不牽涉 Conversations 家族及其他輔助端點，但保留其後續擴充的介面空間。
3.  **補齊 Token 參數歧義檢查 (中風險修正)**：
    *   嚴格防禦：若同時提供 `max_tokens` 與 `max_output_tokens`，立即回傳 **`400 Bad Request`**，與現有 `chat/completions` 的防禦風格保持百分之百一致。
4.  **改進 Fallback 估算策略 (中風險修正)**：
    *   捨棄硬編碼固定值，改採與現有系統風格一致的「動態字元長度估算」（`JSON.stringify(input).length / 4`），並精準統計 `cachedInputTokens`。
5.  **防止程式漂移**：
    *   抽取 `forwardWithAdapter` 作為共享執行層，避免複製貼上大段程式碼；並透過 `chatAdapter` 的完美封裝，保證現有 Chat Completions **零回歸（Zero Regression）**。

---

## 2. 系統架構設計

```mermaid
graph TD
    Client[客戶端] -->|HTTP| Index[src/index.ts]
    
    subgraph Express Routing & Adaption
        Index -->|POST /v1/chat/completions| ChatRoute[forwardChatCompletions]
        Index -->|POST /v1/responses| ResponsesRoute[forwardResponses]
    end

    subgraph Adapters (端點適配層)
        ChatRoute -->|載入| ChatAdapter[chatAdapter]
        ResponsesRoute -->|載入| ResponsesAdapter[responsesAdapter]
    end

    subgraph Shared Executor (共享執行層)
        ChatAdapter -->|調用| SharedExecutor[forwardWithAdapter]
        ResponsesAdapter -->|調用| SharedExecutor
        
        SharedExecutor -->|1. Key Selection| Router[src/router.ts]
        SharedExecutor -->|2. HTTP Fetch| Upstream[OpenAI Upstream]
        SharedExecutor -->|3. Streaming / JSON Parse| StreamTracker[SSE Parser / JSON Mapper]
        SharedExecutor -->|4. Log usage| SQLite[(SQLite proxy.db)]
    end
```

---

## 3. 共用執行器與適配器介面設計

我們將在 `src/openai.ts` 中定義以下抽象介面與共享執行器：

### 3.1 適配器介面 (`ProxyAdapter`)

```typescript
export interface ProxyUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}

export interface ProxyAdapter {
  name: 'chat_completions' | 'responses';
  upstreamPath: string;
  
  // 參數整理與防禦，出錯時直接回傳 HTTP Status 與 Error Body
  normalizeBody(body: any): { ok: true; body: any } | { ok: false; status: number; error: any };
  
  isStreamRequest(body: any): boolean;
  
  // 從非串流 JSON 回應中擷取 Usage
  extractUsageFromJson(body: any, upstreamJson: any): ProxyUsage | null;
  
  // 建立串流追蹤器，以 SSE Event Block 為基礎解析 usage。
  // 對 Responses 而言，建議同時支援 event: 欄位與 JSON payload.type 的辨識方式。
  createStreamTracker(body: any): {
    onChunk(chunk: string): void;
    finalize(): ProxyUsage | null;
  };
  
  // 當上游未回傳 usage 時的動態保險估算
  estimateUsageFallback(body: any, responseJson?: any): ProxyUsage;
}
```

---

## 4. 具體適配器實作細節

### 4.1 Responses Adapter (`responsesAdapter`)

```typescript
const responsesAdapter: ProxyAdapter = {
  name: 'responses',
  upstreamPath: '/responses',

  normalizeBody(body: any) {
    const nextBody = { ...body };

    // 1. 補上預設模型
    if (!nextBody.model) {
      nextBody.model = config.openaiDefaultModel;
    }

    const hasMaxTokens = nextBody.max_tokens !== undefined;
    const hasMaxOutputTokens = nextBody.max_output_tokens !== undefined;

    // 2. 歧義防禦：同時出現則報 400
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

    // 3. 正規化 max_tokens -> max_output_tokens
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
    if (!upstreamJson?.usage) return null;
    const u = upstreamJson.usage;
    return {
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
      cachedInputTokens: u.input_tokens_details?.cached_tokens || 0
    };
  },

  createStreamTracker(body: any) {
    let sseBuffer = '';
    let extractedUsage: ProxyUsage | null = null;

    return {
      onChunk(chunk: string) {
        sseBuffer += chunk;
        
        // Responses 串流以 SSE event block 傳送，實作上需容忍 LF / CRLF
        const normalizedBuffer = sseBuffer.replace(/\r\n/g, '\n');
        const blocks = normalizedBuffer.split('\n\n');
        sseBuffer = blocks.pop() || ''; // 剩餘未完整的資料留在 Buffer 中

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

          // 核心修正：以 event: 欄位為主，若缺失則回退使用 JSON 內的 type
          if (dataStr) {
            try {
              const eventData = JSON.parse(dataStr);
              const effectiveEventName = eventName || eventData.type;

              if (effectiveEventName === 'response.completed') {
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
        return extractedUsage;
      }
    };
  },

  estimateUsageFallback(body: any, responseJson?: any) {
    // 依據輸入長度做動態粗估，不硬編碼常數
    const promptLength = JSON.stringify(body.input || body).length;
    const inputEst = Math.max(1, Math.round(promptLength / 4));
    let outputEst = 100; // 串流時的保守保險預估值

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
```

---

### 4.2 Chat Completions Adapter (`chatAdapter`)

將現有 `forwardChatCompletions` 中的行為**一對一搬遷**至適配器，不修改任何核心業務規則，防範回歸風險。

```typescript
const chatAdapter: ProxyAdapter = {
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
    if (!upstreamJson?.usage) return null;
    const u = upstreamJson.usage;
    return {
      inputTokens: u.prompt_tokens || 0,
      outputTokens: u.completion_tokens || 0,
      cachedInputTokens: u.prompt_tokens_details?.cached_tokens || 0
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
        if (promptTokens === 0 && completionTokens === 0) return null;
        return {
          inputTokens: promptTokens,
          outputTokens: completionTokens,
          cachedInputTokens: cachedTokens
        };
      }
    };
  },

  estimateUsageFallback(body: any, responseJson?: any) {
    const promptLength = JSON.stringify(body.messages).length;
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
```

---

## 5. 實作與驗證步驟

### 5.1 階段一：共享架構重構 (Phase 1)
1. 實作 `forwardWithAdapter(req, res, adapter, retryCount)` 骨架，將原 `forwardChatCompletions` 中的共用流程（金鑰輪詢、超時連線控制、錯誤判定重試、SQLite 記錄與 headers 設置）全部彙整於此。
2. 搬遷 `chatAdapter`，並使 `forwardChatCompletions` 呼叫 `forwardWithAdapter(req, res, chatAdapter)`。
3. 執行手動或半自動化測試，確保 Chat Completions 所有行為完全不變。

### 5.2 階段二：引入 Responses 支援 (Phase 2)
1. 實作 `responsesAdapter` 的完整適配層邏輯。
2. 在 `src/index.ts` 註冊新的 `app.post('/v1/responses', ...)` 路由。

### 5.3 階段三：全面測試 (Phase 3)
1. 撰寫 `scripts/manual_test_responses.ts` 測試腳本。
2. 發送模擬請求，並手動讓金鑰返回 `429`，驗證 Failover 功能。
3. 檢查 `proxy.db` 中的 `request_log` 是否精準記錄了 Responses 的 usage（包含快取 token 統計）。
4. 額外驗證 Responses 串流在無 `response.completed` usage、或以非 LF 換行傳送時，proxy 仍能無損直通資料，並以 fallback 估算安全落帳。

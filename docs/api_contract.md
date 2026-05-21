# API Contract - OpenAI Shared Routing Proxy

## 1. Client Authentication

Proxy API requests must include:

```http
Authorization: Bearer <PROXY_API_KEY>
```

Admin endpoints use HTTP basic auth and are not intended for general API clients.

## 2. Public Endpoints

### 2.1 `POST /v1/chat/completions`

Purpose:
- OpenAI-compatible chat completion proxy endpoint

Supported request fields for v1:
- `model`
- `messages`
- `temperature`
- `top_p`
- `max_completion_tokens`
- `stream`
- `tools`
- `tool_choice`
- `parallel_tool_calls`

Behavior:
- Unknown fields may be passed through only if they are known-safe.
- The proxy may supply a default model if one is omitted.
- The proxy should preserve streaming semantics for `stream: true`.
- The proxy should prefer `max_completion_tokens` for Chat Completions requests.
- The proxy may accept legacy `max_tokens` from older clients and normalize it to `max_completion_tokens` when safe.
- If both `max_tokens` and `max_completion_tokens` are provided, the request should be rejected with a clear `400` error to avoid ambiguous intent.

Success response:
- Return upstream-compatible JSON or SSE stream.

Error response:

```json
{
  "error": {
    "message": "Human-readable message",
    "type": "proxy_error",
    "code": "upstream_unavailable"
  }
}
```

### 2.2 `GET /v1/models`

Purpose:
- Return the list of models the proxy is willing to expose to clients

Notes:
- This may be static in v1.
- It does not need to mirror every model available upstream.

### 2.3 `GET /health`

Purpose:
- Lightweight liveness/readiness check

Suggested response:

```json
{
  "ok": true
}
```

### 2.4 `GET /status`

Purpose:
- Render a minimal operator dashboard

Auth:
- HTTP basic auth required

### 2.5 `GET /api/status`

Purpose:
- Return JSON used by the dashboard

Suggested response shape:

```json
{
  "service": {
    "ok": true,
    "uptimeSec": 12345
  },
  "upstreamKeys": [
    {
      "label": "shared-1",
      "hash": "sha256:abc123",
      "healthy": true,
      "cooldownUntil": null,
      "lastError": null,
      "lastSuccessAt": "2026-05-21T12:00:00Z"
    }
  ],
  "usageEstimate": {
    "dateUtc": "2026-05-21",
    "requests": 420,
    "inputTokens": 120000,
    "outputTokens": 340000
  }
}
```

## 3. Header Policy

Headers accepted from client:
- `Authorization`
- `Content-Type`

Headers added internally:
- upstream `Authorization`

Optional headers the proxy may expose back to clients:
- `X-Proxy-Upstream-Model`
- `X-Proxy-Retry-Count`
- `X-Proxy-Upstream-Key-Type` (value is either `free` or `master` to indicate if the call utilized a free-pool or paid-master key)

Do not expose:
- raw upstream API keys
- internal admin credentials

## 4. Error Classification

Suggested internal categories:
- `authentication_error`
- `invalid_request_error`
- `upstream_timeout`
- `upstream_rate_limited`
- `upstream_unavailable`
- `internal_proxy_error`

The proxy should map these to stable JSON so clients do not depend on random internal stack traces.

## 5. Compatibility Goal

v1 should be tested against:
- OpenAI SDK clients using `base_url`
- Codex-style OpenAI-compatible clients
- OpenCode-style OpenAI-compatible clients

The contract target is pragmatic compatibility, not full surface parity with every OpenAI API endpoint.

## 6. Token Limit Parameter Compatibility

For `POST /v1/chat/completions`:
- Prefer `max_completion_tokens`
- Treat `max_tokens` as a legacy compatibility input only

For a future `POST /v1/responses` implementation:
- Use `max_output_tokens`

The proxy should keep these API families separate instead of inventing one generic token-limit field.

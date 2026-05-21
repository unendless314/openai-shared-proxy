# Architecture - OpenAI Shared Routing Proxy

## 1. Overview

`openai-shared-proxy` is a single-process HTTP service that exposes an OpenAI-compatible endpoint to downstream clients and forwards requests to one shared upstream routing domain.

It is designed for zero-cost operation by default with a failsafe fallback:
- one client-facing proxy API key
- one free-tier upstream key pool (`OPENAI_SHARED_KEYS`) with daily token/request tracking
- one optional paid-tier upstream master key (`OPENAI_MASTER_KEY`) as a final line of defense
- one local SQLite database for operational state, health, and daily quota limits
- one embedded status page

## 2. Context Diagram

```text
Codex / OpenCode / Scripts
        |
        |  Authorization: Bearer <PROXY_API_KEY>
        v
+---------------------------------------+
| openai-shared-proxy                   |
|---------------------------------------|
| Auth middleware                       |
| Request validation                    |
| Two-tier Router                       |
|   ├── Tier 1: Free Pool (Data Share)  |
|   └── Tier 2: Paid Master Key (Failsafe)|
| Upstream forwarding                   |
| Health / status API                   |
| Embedded dashboard                    |
+-------------+-------------+-----------+
              |             |
              |             | Authorization: Bearer <OPENAI_MASTER_KEY>
              |             v
              |     [Paid Upstream Tier]
              |
              | Authorization: Bearer <OPENAI_SHARED_KEY>
              v
     [Free Upstream Tier]

Local SQLite stores:
- request metadata
- key cooldown, exhaustion & health
- daily usage estimates
```

## 3. Runtime Components

### 3.1 HTTP Layer

Responsibilities:
- authenticate client requests
- validate incoming payload shape
- expose proxy and admin routes
- map internal failures to stable HTTP responses

Suggested files:
- `src/index.ts`
- `src/middleware/*` if middleware count grows

### 3.2 Router

Responsibilities:
- choose the next eligible shared upstream key from the Free Pool
- check SQLite usage logs to ensure free keys do not exceed daily token/request limits (preventing unwanted billing spillover)
- fall back automatically to the Paid Master Key if all free keys are exhausted/unhealthy
- apply cooldown rules after transient failures
- mark invalid keys unhealthy
- avoid embedding product policy unrelated to cost-optimized routing

The router should not:
- inspect prompt content for privacy
- infer organization ownership
- perform cost optimization across unrelated policy domains

### 3.3 Upstream Client

Responsibilities:
- build upstream request headers
- stream responses through without full buffering
- detect retryable vs non-retryable failures
- capture response metadata for logging and headers

### 3.4 Local State

SQLite is used for:
- recent request log
- key health, cooldown, and exhaustion state
- estimated daily token totals per key

SQLite is not the billing source of truth.

### 3.5 Dashboard

The dashboard is operational only. It should show enough state to debug availability and daily quota status without becoming a separate product.

## 4. Request Flow

```text
1. Client sends POST /v1/chat/completions
2. Proxy authenticates bearer token
3. Proxy validates request body
4. Router evaluates Tier 1 (Free Key Pool):
   - Identifies healthy keys under daily limit
   - Selects next key round-robin
5. If no free keys under limit are available:
   - Evaluates Tier 2 (Paid Master Key Fallback)
   - Checks if OPENAI_MASTER_KEY is configured and healthy
6. Proxy forwards request upstream using selected key
7. If upstream succeeds:
   - stream or return body
   - log request metadata & update SQLite daily usage metrics
   - clear key error state
8. If upstream fails with retryable error (and retry limit not reached):
   - set cooldown on failed key
   - retry with next eligible key (Free or Master fallback depending on state)
9. If no key succeeds:
   - return normalized upstream-style error (429/500/etc.)
```

## 5. Data Handling Rules

- Do not store raw upstream API keys in logs or dashboard output.
- Do not store full prompt/response bodies in v1.
- Only store metadata required for health, debugging, and rough usage visibility.
- Treat local token counts as estimates.
- Automatically prune detailed `request_log` entries older than 30 days to strictly bound SQLite file size, while preserving aggregated `daily_usage_estimate` records permanently for historical reporting and monthly/annual statistics.

## 6. Suggested Initial Source Layout

```text
openai-shared-proxy/
  src/
    index.ts
    config.ts
    db.ts
    router.ts
    openai.ts
    dashboard.ts
    auth.ts
    errors.ts
    types.ts
```

`auth.ts`, `errors.ts`, and `types.ts` are optional but likely worth adding early to keep `index.ts` small.

## 7. Deferred Architecture

Not part of v1:
- background workers
- Redis
- multi-tenant auth
- prompt cache
- private/shared dual path
- admin key rotation UI

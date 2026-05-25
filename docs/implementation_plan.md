# Implementation Plan - OpenAI Shared Routing Proxy

This document outlines the implementation strategy for building `openai-shared-proxy`. It is a lightweight Node.js/TypeScript proxy for 24/7 VPS deployment that provides a single OpenAI-compatible endpoint for shared, non-private traffic. The proxy focuses on stable forwarding, simple upstream failover, conservative usage tracking, and a small built-in status dashboard.

---

## 1. Goal Description

Create a cloud-friendly proxy server for OpenAI-compatible clients such as Codex, OpenCode, VS Code extensions, and custom scripts.

Scope for the current first version:
- All traffic is treated as `shared`.
- The proxy forwards requests to a single shared OpenAI org/project policy domain.
- The proxy may support one or more upstream keys only when they belong to the same intended routing policy.
- The proxy provides a minimal web status page for health, request counts, and estimated usage visibility.
- The proxy supports `POST /v1/chat/completions` and `POST /v1/responses` as the two primary client-facing generation endpoints.

Explicitly out of scope for the current v1:
- Private/shared split routing.
- Cross-org quota pooling or complimentary-token aggregation.
- Automatic content classification.
- Multi-tenant user billing.
- `GET /v1/responses/:response_id`, `DELETE /v1/responses/:response_id`, `POST /v1/responses/:response_id/cancel`.
- Conversations API proxying.

---

## 2. Proposed Changes

The project already exists in the current repository. The implementation focus is on evolving the existing codebase rather than creating a new project tree.

```text
/Users/linchunchiao/Documents/openai-shared-proxy/
  ├── package.json
  ├── tsconfig.json
  ├── .env.example
  ├── docs/
  └── src/
       ├── index.ts      # Express app, auth, API routes, dashboard routes
       ├── config.ts     # Env parsing and upstream configuration
       ├── db.ts         # SQLite schema for request logs and key health
       ├── router.ts     # Upstream key selection and retry policy
       ├── openai.ts     # Shared executor + endpoint adapters
       └── dashboard.ts  # Static HTML dashboard template
```

---

## 3. Component Details & Design

### `package.json`

Core dependencies:
- `express` and `dotenv` for the HTTP server.
- `better-sqlite3` for a small local state store.
- `undici` or native `fetch` for upstream HTTP.
- `typescript`, `tsx`, `@types/node`, and `@types/express` for development.

### `config.ts`

Parses environment variables such as:
- `PORT`
- `PROXY_API_KEY`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD`
- `OPENAI_BASE_URL`
- `OPENAI_SHARED_KEYS`        # Free key pool, comma-separated
- `OPENAI_MASTER_KEY`         # Optional paid master key (fallback)
- `KEY_DAILY_TOKEN_LIMIT`     # Max daily tokens per free key (e.g. 950000)
- `KEY_DAILY_REQ_LIMIT`       # Max daily requests per free key (e.g. 4800)
- `OPENAI_DEFAULT_MODEL`
- `REQUEST_TIMEOUT_MS`

The file validates configuration at startup and fails fast if required parameters are missing. `OPENAI_MASTER_KEY` is validated as optional.

### `db.ts`

Manages local `proxy.db` SQLite database.

Tables:
- `request_log`
  - `id`
  - `created_at`
  - `upstream_key_hash`
  - `model`
  - `status_code`
  - `latency_ms`
  - `estimated_input_tokens`
  - `estimated_output_tokens`
  - `cached_input_tokens`
  - `key_type`                # 'free' | 'master'
- `upstream_key_state`
  - `key_hash`
  - `key_type`                # 'free' | 'master'
  - `cooldown_until`
  - `exhausted_until`         # UTC midnight timestamp when the daily limit resets
  - `last_error`
  - `last_success_at`
  - `is_disabled`
- `daily_usage_estimate`
  - `date_utc`                # 'YYYY-MM-DD'
  - `upstream_key_hash`
  - `requests_count`
  - `tokens_estimated`
  - `input_tokens_estimated`
  - `output_tokens_estimated`
  - `cached_tokens_estimated`

This database tracks key health and daily usage to inform routing decisions. It is for routing optimization and is not the official financial billing source.

**Auto-Pruning Mechanism (TTL)**: 
To prevent database bloating on 24/7 VPS deployments, a 30-day rolling retention policy is enforced for the `request_log` table. Detailed metadata logs older than 30 days are automatically deleted on a rolling basis (run daily or at startup). The `daily_usage_estimate` table is preserved permanently, as its space complexity is extremely low (one row per key per day, ~1000 rows/year per key) and it is required for monthly/annual usage reporting. This ensures the database file size remains strictly bounded (typically <50MB) and performs consistently over years of operation.

### `router.ts`

The router implements a two-tier cost-optimized path:
1. **Tier 1 (Free Key Pool)**:
   - Filter `OPENAI_SHARED_KEYS`.
   - Skip keys currently on cooldown or marked unhealthy.
   - Skip keys where SQLite `daily_usage_estimate` for the current UTC day exceeds `KEY_DAILY_TOKEN_LIMIT` or `KEY_DAILY_REQ_LIMIT`.
   - Pick the next eligible free key using the proxy's deterministic selection order, while preserving failover to the next healthy key on retryable errors.
2. **Tier 2 (Paid Master Key Fallback)**:
   - If no healthy, under-limit free key is available, check if `OPENAI_MASTER_KEY` is configured and healthy.
   - Route request to `OPENAI_MASTER_KEY` to guarantee uninterrupted service.
   - If no paid master key is configured, return an OpenAI-compatible `429` (Quota Exceeded) error.
3. **Failure Handling**:
   - On transient errors (e.g. `429`, `5xx`, timeout), put the failing free key on a short cooldown (e.g. 1 minute) and retry.
   - If a free key returns an authentication error (e.g. `401`), mark it permanently unhealthy in SQLite until manual intervention.
   - If the Paid Master Key fails, propagate the error immediately without infinite looping.

This file isolates cost optimization logic within the router tier and avoids complex business rules or content-based privacy branching.

### `openai.ts`

Handles upstream HTTP behavior:
- Forward `POST /v1/chat/completions`
- Forward `POST /v1/responses`
- Stream SSE responses without buffering the full body
- On stream completion, record final estimated/actual usage in SQLite
- Normalize common upstream errors into OpenAI-compatible JSON responses
- Use a shared transport executor plus per-endpoint adapters to avoid logic drift
- Normalize token-limit parameters by API family:
  - prefer `max_completion_tokens` for Chat Completions
  - map legacy `max_tokens` to `max_completion_tokens` for Chat when safe
  - use `max_output_tokens` for Responses
  - reject ambiguous token-limit combinations with a `400`
- Parse Responses usage using `input_tokens`, `output_tokens`, and `input_tokens_details.cached_tokens`
- Parse Responses streaming usage from semantic completion events such as `response.completed`
- Surface response metadata such as upstream model, key type (`free` or `master`), and retry count in response headers (`X-Proxy-Upstream-Key-Type`, `X-Proxy-Upstream-Model`, `X-Proxy-Retry-Count`)

### `dashboard.ts`

Exports a function returning a single HTML page with lightweight CSS and vanilla JavaScript.

The dashboard should show:
- Server health & uptime
- Upstream key health & tier classification ('free' vs 'master')
- Daily quota consumption for each free key (visual progress bar towards daily limit)
- Recent request counts
- Estimated daily usage by model group
- Last errors

The dashboard should use basic auth or an authenticated session, not query-string secrets.

### `index.ts`

Exposes:
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /v1/models`
- `GET /health`
- `GET /status`
- `GET /api/status`

Auth model:
- Client requests use `Authorization: Bearer <PROXY_API_KEY>`.
- Admin routes use HTTP basic auth backed by `ADMIN_USERNAME` and `ADMIN_PASSWORD`.

---

## 4. Usage and Accounting Notes

The proxy should be conservative about usage reporting:
- Local SQLite counters are estimates for routing and dashboard visibility.
- Official reconciliation should come from OpenAI usage and cost reporting, not only local counters.
- If complimentary-token visibility is ever displayed, label it as estimated unless reconciled from official usage data.

This avoids presenting local ledger data as billing truth.

---

## 5. Verification Plan

We will create `test_proxy.ts` or a small test suite to verify:

1. Valid proxy bearer token is required for API requests.
2. `POST /v1/chat/completions` non-stream requests are forwarded correctly.
3. `POST /v1/chat/completions` stream responses pass through without corruption.
4. `POST /v1/responses` non-stream requests are forwarded correctly.
5. `POST /v1/responses` stream responses pass through without corruption.
6. Responses usage is mapped into SQLite with input, output, and cached token accounting.
7. A `429` or timeout on upstream key 1 causes retry on upstream key 2.
8. Invalid upstream credentials mark that key unhealthy.
9. Admin dashboard requires authentication.
10. `/api/status` returns expected health and estimate fields.

---

## 6. Future Extensions

Possible later phases, intentionally deferred from v1:
- Additional Responses family endpoints beyond `POST /v1/responses`.
- Official usage API reconciliation.
- Per-project profiles for manually selected routing modes.
- Separate private route with strict no-cache behavior.

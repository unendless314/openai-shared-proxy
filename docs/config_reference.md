# Configuration Reference - OpenAI Shared Routing Proxy

## 1. Required Variables

### `PROXY_API_KEY`

- Client-facing bearer token
- Used by Codex, OpenCode, scripts, and other downstream callers

### `ADMIN_USERNAME`

- Username for dashboard basic auth

### `ADMIN_PASSWORD`

- Password for dashboard basic auth

### `OPENAI_SHARED_KEYS`

- Comma-separated upstream API keys representing the Free Key Pool (with Data Sharing enabled)
- Example:

```env
OPENAI_SHARED_KEYS=sk-shared-1,sk-shared-2
```

All keys listed here are assumed to belong to the same shared routing policy.

## 2. Optional Variables

### `OPENAI_MASTER_KEY`

- Optional paid upstream API key serving as a final failsafe fallback when all free pool keys are exhausted or offline.
- If not set, the proxy will reject requests with a 429 once the free keys are exhausted.

### `KEY_DAILY_TOKEN_LIMIT`

- Suggested default: `950000` (safe margin slightly under 1M)
- Maximum tokens permitted per free key per UTC day.

### `KEY_DAILY_REQ_LIMIT`

- Suggested default: `4800` (safe margin under 5K requests)
- Maximum requests permitted per free key per UTC day.

### `PORT`

- Default: `3001`

### `HOST`

- Default: `0.0.0.0`

### `OPENAI_BASE_URL`

- Default: official OpenAI-compatible base URL
- Useful if testing against a compatible gateway

### `OPENAI_DEFAULT_MODEL`

- Optional default when client omits `model`

### `REQUEST_TIMEOUT_MS`

- Suggested default: `90000`

### `KEY_COOLDOWN_MS`

- Suggested default: `60000`

### `MAX_RETRIES`

- Suggested default: `2`

### `SQLITE_PATH`

- Suggested default: `./proxy.db`

## 3. Example `.env`

```env
HOST=0.0.0.0
PORT=3001

PROXY_API_KEY=proxy-please-change-me
ADMIN_USERNAME=admin
ADMIN_PASSWORD=please-change-me

OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_SHARED_KEYS=sk-shared-key-1,sk-shared-key-2
OPENAI_MASTER_KEY=sk-paid-master-failsafe-key
KEY_DAILY_TOKEN_LIMIT=950000
KEY_DAILY_REQ_LIMIT=4800
OPENAI_DEFAULT_MODEL=gpt-4o-mini

REQUEST_TIMEOUT_MS=90000
KEY_COOLDOWN_MS=60000
MAX_RETRIES=2
SQLITE_PATH=./proxy.db
```

## 4. Secret Handling Rules

- Never commit `.env`.
- Do not print full secrets in startup logs.
- When displaying key state, show only labels or hashes (especially on the dashboard).
- If a secret is invalid, log only enough context to identify which configured key failed.

## 5. Configuration Validation

Startup should fail fast when:
- `PROXY_API_KEY` is missing
- admin credentials are missing
- `OPENAI_SHARED_KEYS` is empty
- numeric values (e.g. daily limits, timeouts, port) are malformed

## 6. Deployment Defaults

Recommended v1 defaults:
- single process
- local SQLite file
- reverse proxy terminated with TLS in front of the app
- dashboard restricted to operator use only

# Engineering Notes - OpenAI Shared Routing Proxy

## 1. Non-Goals to Protect

Do not quietly expand v1 into:
- a multi-tenant gateway
- a private/shared classifier
- a cost optimizer across unrelated organizations
- a generic LLM platform
- a dashboard-heavy admin product

If one of these becomes necessary, it should be added by explicit scope change.

## 2. Implementation Guardrails

- Prefer explicit configuration over smart inference.
- Keep `index.ts` thin.
- Treat retry logic as part of the router and upstream client, not ad hoc controller code.
- Keep the dashboard read-only in v1.
- Default to metadata logging, not content logging.

## 3. Engineering Decisions Already Made

- V1 is `shared-only`.
- Admin auth uses basic auth, not query-string token auth.
- SQLite is for local operational state.
- Token and cost displays are estimates unless reconciled against official upstream reporting.
- Caching is deferred.

## 4. Practical Borrowing From Reference Projects

### Borrow from `freellmapi`

- Unified client bearer token pattern
- Constant-time token comparison
- Cooldown-based retry behavior
- Clean separation between routing and provider transport

### Do not borrow directly from `freellmapi`

- Multi-provider abstraction breadth
- Large fallback-chain feature surface
- Analytics scope beyond what v1 needs

### Borrow from `litellm`

- Keep a narrow data-plane route surface
- Treat unauthenticated proxy exposure as a serious security failure

### Do not borrow directly from `litellm`

- Full gateway complexity
- Large admin UI surface
- Cloud deployment stack and platform sprawl

## 5. Suggested First Milestone

Milestone 1 should ship only:
- `/v1/chat/completions`
- `/v1/models`
- `/health`
- `/status`
- `/api/status`

with:
- bearer auth
- basic auth for admin
- streaming pass-through
- retry and daily limit tracking across shared free keys
- automatic Paid Master Key fallback as failsafe protection
- SQLite-backed health and usage tracking state

Anything beyond that should justify itself against added maintenance cost.

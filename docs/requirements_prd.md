# OpenAI Shared Routing Proxy - Product Requirements Document

This document defines a lightweight, cloud-friendly, OpenAI-only proxy that serves one purpose well: provide a single stable OpenAI-compatible endpoint for shared, non-private development traffic.

Version 1 is intentionally narrow. It does not attempt to pool complimentary token programs across organizations, classify prompt sensitivity, or support multi-path privacy routing.

---

## 1. Background & Objectives

### 1.1 Why This Exists

Using OpenAI-compatible tools across terminals, editors, and local agents is easier when they all point to one stable endpoint.

The proxy should solve the following problems:
- Centralize base URL and API key management.
- Reduce client-side complexity for Codex, OpenCode, and scripts.
- Provide simple upstream retry and failover behavior.
- Expose minimal operational visibility without requiring SSH access.

### 1.2 Deployment Goal

The service is designed to run continuously on a small VPS.

Requirements:
- Reliable 24/7 operation.
- Low idle memory footprint.
- No separate dashboard stack.
- Simple restore and migration path.

---

## 2. Product Scope

### 2.1 In Scope for v1

- OpenAI-compatible proxy for `POST /v1/chat/completions`
- `GET /v1/models`
- Shared bearer token for downstream clients
- One shared upstream routing policy with cost-optimization
- Free Key Pool (`OPENAI_SHARED_KEYS` with Data Sharing enabled) with daily token/request cap enforcement
- Paid Master Key (`OPENAI_MASTER_KEY`) as a final fallback line of defense to prevent service interruption
- Status dashboard with health and usage estimates
- SQLite-backed local state

### 2.2 Out of Scope for v1

- Private/shared split routing (all traffic is assumed non-private developer traffic)
- Cross-org or cross-owner quota aggregation
- Automatic prompt sensitivity detection
- User-facing billing or tenant isolation
- Rich web UI for key management
- Prompt/response caching by default

Caching is intentionally excluded from the default scope because it complicates privacy posture, correctness, and invalidation. It can be revisited later.

---

## 3. Functional Requirements

### 3.1 Client Interface

The proxy must expose an OpenAI-compatible interface so existing tools can switch over using only:
- a new `base_url`
- a single proxy API key

Supported first-class endpoint:
- `POST /v1/chat/completions`

Secondary endpoints:
- `GET /v1/models`
- `GET /health`
- `GET /status`
- `GET /api/status`

### 3.2 Authentication

Two auth layers are required:
- Proxy client auth using a single bearer token
- Admin auth for dashboard/status access using HTTP basic auth

The system must not expose admin secrets in query parameters.

### 3.3 Cost-Optimized Upstream Routing

The proxy loads upstream keys into two tiers:
- `OPENAI_SHARED_KEYS` (Array of free keys under the Data Sharing program)
- `OPENAI_MASTER_KEY` (Single paid master key)

The router should:
- Route requests to the next available healthy free key in round-robin/priority order.
- Track daily token and request consumption for each free key in SQLite.
- Voluntarily cool down a free key for the remainder of the UTC day when its usage exceeds the configured safety threshold (e.g. 95% of the daily free limit) to prevent paid spillover on that account.
- If all free keys are temporarily on cooldown, exhausted, or marked unhealthy:
  - Automatically fall back to the `OPENAI_MASTER_KEY` (if configured) to prevent service interruption.
  - If no `OPENAI_MASTER_KEY` is configured, return an OpenAI-compatible quota exhausted error (`429`).
- Retry another key on transient upstream failures.
- Cool down keys that are temporarily failing.
- Stop using keys that are clearly invalid (e.g. 401 Unauthorized) until manual intervention.

The router should not infer privacy level, org intent, or account ownership from request content.

### 3.4 Observability

The dashboard must show:
- service health
- upstream key status (highlighting free vs paid master status, and daily quota usage percentages)
- recent errors
- request counts
- estimated token usage

The dashboard is operational, not financial. Any cost or complimentary-token numbers must be clearly labeled as estimates unless reconciled against official upstream reporting.

---

## 4. Non-Functional Requirements

- **Runtime**: Node.js / TypeScript
- **HTTP server**: Express
- **State store**: SQLite via `better-sqlite3`
- **Idle footprint target**: less than 50 MB RSS on VPS
- **Operational model**: single process, no required background worker for v1

---

## 5. Security Requirements

- Upstream API keys must not be exposed to downstream clients.
- Proxy bearer token comparison should use constant-time comparison.
- Admin routes must use stronger auth than a query token.
- Logs should avoid storing full prompt and response bodies in v1.
- Dashboard should expose key labels or hashes, not raw secrets.

---

## 6. Success Criteria

The v1 proxy is successful if:
- Codex or OpenCode can be pointed at it with only config changes.
- Normal chat-completion requests work in both streaming and non-streaming modes.
- A failing upstream key does not take down the whole service.
- The operator can inspect health and recent failures from a browser.
- The design stays simple enough to maintain as a personal infrastructure service.

---

## 7. Revised Development Checklist

- [ ] Phase 1: Project setup and environment parsing
- [ ] Phase 2: Shared-key router and upstream forwarding
- [ ] Phase 3: Streaming support and retry behavior
- [ ] Phase 4: SQLite-backed health and usage estimates
- [ ] Phase 5: Minimal authenticated dashboard
- [ ] Phase 6: Verification with Codex/OpenCode-compatible client flows

---

## 8. Design Principles

- Prefer one stable shared path over flexible but ambiguous routing.
- Keep policy decisions outside the proxy unless they are explicit and operator-controlled.
- Treat local metrics as operational hints, not billing truth.
- Add privacy routing only when there is a real need and a clear client-side selection mechanism.

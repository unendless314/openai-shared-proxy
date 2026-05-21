# Agents.md - openai-shared-proxy

## Dev Commands
- `npm run dev` - Run with tsx watch (auto-reload on changes)
- `npm run build` - Compile TypeScript to `dist/`
- `npm start` - Run production build (after `npm run build`)

## Required Setup
- Copy `.env.example` to `.env` and fill in credentials
- Required: `PROXY_API_KEY`, `ADMIN_USERNAME`, `ADMIN_PASSWORD`, `OPENAI_SHARED_KEYS`
- Optional: `OPENAI_MASTER_KEY` (failsafe fallback when free keys are exhausted)

## Architecture
- **Entry point**: `src/index.ts` (Express app)
- **Two-tier routing**: Free pool (`OPENAI_SHARED_KEYS`) → Paid master fallback (`OPENAI_MASTER_KEY`)
- **Auth**: Bearer token for client API (`/v1/*`), HTTP Basic for admin (`/status`, `/api/status`)
- **State**: Local SQLite (`*.db`, `*.db-wal`, `*.db-shm` in `.gitignore`)
- **Default port**: 3001

## Data Retention
- `request_log` entries older than 30 days are auto-pruned
- `daily_usage_estimate` records are kept permanently for historical reporting

## No CI/Build Checks
- No `npm run test`, `npm run lint`, or `npm run typecheck` scripts defined
- Build with `npm run build` before running in production
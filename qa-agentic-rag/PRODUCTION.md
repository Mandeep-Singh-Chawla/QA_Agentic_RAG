# Production deployment — qa-agentic-rag

## What “prod mode” enforces

On boot (`QA_ENV=production` or `NODE_ENV=production`), the API **refuses to start** unless:

- `QA_API_TOKEN` is set (Bearer auth on `/query`, `/ingest`, `/sync`)
- `JIRA_WEBHOOK_SECRET` is set (webhooks cannot be open)
- `GOOGLE_API_KEY` is set
- `VECTOR_BACKEND=qdrant`
- `QA_CORS_ORIGINS` is an explicit allowlist (no `*`)
- `QA_ALLOW_INSECURE_WEBHOOK` is not `true`

Also included:

- Input/output guardrails + audit log
- Rate limiting, security headers, request IDs
- `/health` (liveness) + `/readyz` (Qdrant + secrets)
- Graceful shutdown on SIGTERM/SIGINT
- Retries on Atlassian API 429/5xx
- Docker Compose stack (API + Qdrant)

## Quick start (Docker)

1. Copy `.env.example` → `.env` and fill secrets.
2. Set production values:

```bash
QA_ENV=production
NODE_ENV=production
QA_API_TOKEN=$(openssl rand -hex 32)
JIRA_WEBHOOK_SECRET=$(openssl rand -hex 16)
VECTOR_BACKEND=qdrant
QA_CORS_ORIGINS=https://your-frontend.example.com
QA_REQUIRE_AUTH=true
QA_ALLOW_INSECURE_WEBHOOK=false
GOOGLE_API_KEY=...
JIRA_EMAIL=...
JIRA_API_TOKEN=...
```

3. Start:

```bash
docker compose up --build -d
curl -s localhost:8787/readyz | jq
npm run qa:smoke
```

4. Point Jira webhook at your **stable HTTPS** URL (Load Balancer / Cloudflare Tunnel named tunnel / ngrok reserved domain):

`https://<host>/webhooks/jira?secret=<JIRA_WEBHOOK_SECRET>`

Ephemeral `trycloudflare.com` URLs are **not** production.

## TLS / identity

- Terminate TLS at a reverse proxy or cloud load balancer (nginx, Caddy, ALB, Cloudflare).
- Prefer SSO in front of the UI; the API uses a service `QA_API_TOKEN` (rotate regularly).
- Do not expose Qdrant port `6333` publicly.

## Ops checklist

| Item | Command / note |
|------|----------------|
| Liveness | `GET /health` |
| Readiness | `GET /readyz` |
| Smoke | `npm run qa:smoke` |
| Logs | JSON lines on stdout (`QA_LOG_LEVEL=info`) |
| Audit | `qa-agentic-rag/qa-output/audit/guardrails.jsonl` |
| Backups | Volume `qdrant_data` + `qa_docs_data` |

## Still out of scope (org-level)

SSO/RBAC per user, multi-tenant isolation, formal model eval CI, and compliance attestations need your platform standards — this package provides the deployable API baseline those plug into.

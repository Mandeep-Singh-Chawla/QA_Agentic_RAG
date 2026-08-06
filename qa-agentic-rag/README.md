# QA Agentic RAG (app package)

Application code for the QA Agentic RAG agent. Knowledge lives in sibling [`../qa-docs`](../qa-docs/).

Start from the **repo root** (see root [README](../README.md) for the 5-minute quick start).

## Entry points

| Entry | Command (from repo root) |
|-------|--------------------------|
| CLI | `npm run qa:agentic "your question"` |
| HTTP API | `npm run qa:server` |
| Studio | `npm run qa:studio` |
| Production notes | [PRODUCTION.md](./PRODUCTION.md) |

Do **not** run `core/orchestrator.ts` directly.

## Package layout

```text
server.ts           # HTTP API entry
cli.ts              # Terminal entry
langgraphServer.ts  # LangGraph Studio graph entry
core/               # config, tracing, guardrails, orchestrator
rag/                # ingest, retrieval, vector store
agents/             # AI agents (RAG source, Jira TC, coverage, test selection)
connectors/         # Jira, GitHub, Confluence, Xray, defects, …
lib/                # Logger, retry, HTTP security, embed cache
eval/               # Smoke checks
```

## Config

Copy root `.env.example` → `.env`. Minimum for local demo: `GOOGLE_API_KEY`.  
Live Jira/GitHub/change-impact need the matching env vars (no personal defaults are baked into code).

## Vector DB

Default `VECTOR_BACKEND=memory`. For Qdrant:

```env
VECTOR_BACKEND=qdrant
QDRANT_URL=http://127.0.0.1:6333
```

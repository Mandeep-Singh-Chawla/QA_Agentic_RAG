# QA Agentic RAG

Local agentic RAG for QA teams: generate test cases, find coverage gaps, and prioritize testing from Jira, Confluence, GitHub, and Xray knowledge.

## QA quick start (≈5 minutes)

**Requirements:** Node.js 20+ (22 recommended), a [Google AI](https://aistudio.google.com/apikey) API key.

```bash
git clone https://github.com/Mandeep-Singh-Chawla/QA_Agentic_RAG.git
cd QA_Agentic_RAG
cp .env.example .env
# Set at least: GOOGLE_API_KEY=...
npm install
npm run qa:agentic "Generate login lockout test cases"
```

Works out of the box against sample docs in `qa-docs/` (demo knowledge base).  
For your team’s Jira/GitHub, fill the live-API section in `.env` (see below).

| Goal | Command |
|------|---------|
| Ask a QA question (CLI) | `npm run qa:agentic "Explain login acceptance criteria"` |
| HTTP API | `npm run qa:server` then `POST /query` |
| LangGraph Studio | `npm run qa:studio` |
| Docker (API + Qdrant) | fill `.env` → `npm run qa:docker:up` |
| Smoke test (server must be up) | `npm run qa:smoke` |

Production deploy notes: [`qa-agentic-rag/PRODUCTION.md`](./qa-agentic-rag/PRODUCTION.md).

## Layout

```text
qa-docs/            # RAG knowledge base (Jira / GitHub / Confluence / Xray)
qa-agentic-rag/     # App code (server, orchestrator, connectors, agents)
scripts/            # Install helpers (e.g. Qdrant Node patch)
Dockerfile          # Production image
docker-compose.yml  # API + Qdrant
```

Sample content under `qa-docs/` is for demos. Replace or sync with your team sources.

## Live APIs (optional)

| Source | Env vars |
|--------|----------|
| GitHub | `GITHUB_TOKEN`, `GITHUB_USER` (optional `GITHUB_REPO`) |
| Jira / Confluence | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` |
| Change-impact | `DEV_REPO=owner/name`, `AUTOMATION_REPOS=owner/a,owner/b` |
| Xray | `XRAY_CLIENT_ID`, `XRAY_CLIENT_SECRET` |

Create tokens:
1. GitHub PAT → https://github.com/settings/tokens (`public_repo` or `repo`)
2. Atlassian API token → https://id.atlassian.com/manage-profile/security/api-tokens

```bash
curl -X POST http://localhost:8787/sync          # pull live → qa-docs/*/live/
curl -X POST http://localhost:8787/ingest        # sync + embed all
```

## Vector DB

Default: in-memory. For persistence, use Qdrant:

```bash
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant
```

```env
VECTOR_BACKEND=qdrant
QDRANT_URL=http://127.0.0.1:6333
QDRANT_COLLECTION=qa_agentic
```

## What it can do

| Intent | Example |
|--------|---------|
| Generate test cases | `Generate login lockout test cases` |
| Explain requirements | `Explain login acceptance criteria` |
| Coverage gaps | `What is untested for login?` |
| API contracts | `What status codes does login API return?` |
| Change-impact | `Select tests to run for https://github.com/org/app/pull/123` |
| Risk-based coverage | `Optimize test coverage using historic defects and the latest code change` |

## Architecture map

| Enterprise pattern | This repo |
|--------------------|-----------|
| Webhooks / connectors | `qa-docs/<source>/` + `POST /ingest` / `/sync` |
| HTTP API | `qa-agentic-rag/server.ts` |
| Orchestrator | `orchestrator.ts` |
| Source agents | `agents/sourceAgent.ts` |
| Retrieval + rerank | `retrieval.ts` |
| Guardrails | `guardrails.ts` |
| Vector store | memory or Qdrant |

Do **not** run `orchestrator.ts` directly — use `cli.ts`, `server.ts`, or Studio.

## LangSmith (optional)

```env
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=...
LANGCHAIN_PROJECT=qa-agentic-rag
```

## Still “lite”

- No full enterprise Chat UI (Studio + HTTP API)
- Agents run sequentially (friendly to Gemini free-tier limits)
- Jira Cloud webhooks need a public URL (ngrok/tunnel) for local receive
- Org SSO/RBAC is out of scope — see `PRODUCTION.md`

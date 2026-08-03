# QA Agentic RAG (local lite version of the enterprise diagram)

This folder mirrors the attached **Enterprise Agentic RAG** architecture using your existing stack:

| Diagram (Azure / enterprise) | This local version |
|------------------------------|--------------------|
| JIRA / GitHub / Confluence / Xray webhooks | Files under `qa-docs/<source>/` + `POST /ingest` |
| FastAPI webhook listener | Node HTTP server (`server.ts`) |
| Connectors / MCP | Folder-based “connectors” per source |
| Azure OpenAI embeddings | Gemini `gemini-embedding-001` |
| Azure AI Search | `VECTOR_BACKEND=memory` (default) or **Qdrant** (free Docker / Cloud) |
| LangChain orchestrator | `orchestrator.ts` (intent + routing) |
| JIRA/GitHub/Confluence/Xray agents | `agents/sourceAgent.ts` per source |
| Retrieval + rerank | `retrieval.ts` (similarity + Gemini lite rerank) |
| GPT-4o reasoning | Gemini Flash structured synthesis |
| Input/output guardrails | `guardrails.ts` |
| Production deploy | `PRODUCTION.md`, `Dockerfile`, `docker-compose.yml` |

See **[PRODUCTION.md](./PRODUCTION.md)** for prod boot checks, Docker, TLS, and smoke tests.

## Layout

```text
qa-docs/
  confluence/   # PRDs
  jira/         # stories / ACs
  github/       # API notes
  xray/         # existing tests / gaps
qa-agentic-rag/
  server.ts         # Case 1 + Case 2 HTTP API
  cli.ts            # Case 2 from terminal
  ingest.ts         # Case 1 pipeline
  orchestrator.ts   # intent → route → agents → answer
  retrieval.ts      # search + rerank
  guardrails.ts
  agents/
```

## Vector DB (memory vs Qdrant)

Default is in-memory. For a free prod-like store, use **Qdrant**:

```bash
# Option A — local free (Docker)
docker run -d --name qdrant -p 6333:6333 -p 6334:6334 qdrant/qdrant

# Option B — Qdrant Cloud free tier: https://cloud.qdrant.io
```

```env
VECTOR_BACKEND=qdrant
QDRANT_URL=http://127.0.0.1:6333
# QDRANT_API_KEY=...          # cloud only
QDRANT_COLLECTION=qa_agentic
```

Then restart Studio / server and run ingest (or ask a RAG question).  
Pinecone is not wired; Qdrant is the free path in this project.

## How to run (important)

**Do not run `orchestrator.ts` directly.** It is a library module.

```bash
# CLI entrypoint
npx tsx qa-agentic-rag/cli.ts "Generate login lockout test cases"

# Other intents (not only test cases)
npx tsx qa-agentic-rag/cli.ts "Explain login acceptance criteria"
npx tsx qa-agentic-rag/cli.ts "What coverage gaps exist for login lockout?"
npx tsx qa-agentic-rag/cli.ts "What API status codes does login return?"

# HTTP server
npx tsx qa-agentic-rag/server.ts
curl -X POST http://localhost:8787/ingest
curl -X POST http://localhost:8787/query \
  -H 'Content-Type: application/json' \
  -d '{"query":"Find coverage gaps for login"}'
```

## LangSmith

Uses your `.env` keys. Ensure:

```bash
LANGSMITH_TRACING=true
LANGSMITH_API_KEY=lsv2_...   # from https://smith.langchain.com
```

`tracing.ts` maps these to LangChain’s expected vars. Traces appear under project `qa-agentic-rag` (override with `LANGCHAIN_PROJECT`).

If you previously saw `403` on LangSmith, refresh the API key.

## Live APIs (GitHub + Jira + Confluence + Xray)

Wired for your accounts:

| Source | Target | Env |
|--------|--------|-----|
| GitHub | `Mandeep-Singh-Chawla` | `GITHUB_TOKEN`, `GITHUB_USER` |
| Jira | `mandeepsingh1986.atlassian.net` / `SCRUM` | `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT_KEY` |
| Confluence | same Atlassian site | same email + token |
| Xray | optional | `XRAY_CLIENT_ID` + `XRAY_CLIENT_SECRET` |

**Create tokens:**
1. GitHub PAT → https://github.com/settings/tokens (`public_repo` or `repo`)
2. Atlassian API token → https://id.atlassian.com/manage-profile/security/api-tokens  
   Email: `mandeepsingh1986@gmail.com`

Then fill `GITHUB_TOKEN` and `JIRA_API_TOKEN` in `.env`.

```bash
curl -X POST http://localhost:8787/sync          # pull live → qa-docs/*/live/
curl -X POST http://localhost:8787/ingest        # sync + embed all
curl -X POST http://localhost:8787/ingest/jira   # one source
```

### Optimized coverage (historic defects + code change)

Combines **prod/Jira defect history** with **deepeval code changes** to allocate:
- **deep** coverage on high-risk areas  
- **smoke / skip** on low-risk areas  

Seed defects: `qa-docs/jira/defects/prod-defect-history.md` (plus live Jira Bugs when `JIRA_API_TOKEN` is set).

Studio prompts:

```text
Optimize test coverage using historic prod defects and the latest deepeval code change — more tests on high risk, less on low risk
```

```text
Select tests to run for https://github.com/confident-ai/deepeval/pull/1234
```

Tools: `optimize_test_coverage` (full budgeting) and `select_tests_for_dev_change` (lighter PR mapping).

### Jira webhook → auto vector DB update

When a Jira issue is **created / updated / deleted**, Jira can POST to this app; the issue is written under `qa-docs/jira/live/` and the in-memory vector store is reindexed.

```bash
# Terminal 1 — webhook receiver (required for Jira Cloud)
npm run qa:server

# Terminal 2 — expose localhost (Jira Cloud cannot reach 127.0.0.1)
ngrok http 8787
# Webhook URL: https://<ngrok-id>.ngrok-free.app/webhooks/jira?secret=YOUR_SECRET
```

In Jira: **Settings → System → WebHooks → Create**
- URL: your ngrok URL above  
- Events: Issue → created, updated, deleted  
- Set `JIRA_WEBHOOK_SECRET` in `.env` to match `?secret=`

Studio (`npm run qa:studio`) picks up webhook file changes on the **next question** via the stamp file `qa-docs/jira/live/.webhook-updated`.

Simulate locally:

```bash
curl -X POST http://localhost:8787/webhooks/jira \
  -H 'Content-Type: application/json' \
  -d '{"webhookEvent":"jira:issue_created","issue":{"key":"SCRUM-99","fields":{"summary":"Webhook test","status":{"name":"To Do","statusCategory":{"name":"To Do"}},"issuetype":{"name":"Task"},"priority":{"name":"Medium"},"description":"Created via webhook"}}}'
```

## What it can do (intents)

| Intent | Example question |
|--------|------------------|
| `generate_test_cases` | Generate login lockout test cases |
| `explain_requirements` | Explain login acceptance criteria |
| `find_coverage_gaps` | What is untested for login? |
| `api_contract_check` | What status codes does login API return? |
| `general_qa` | Summarize auth docs across sources |

## What is still “lite”

- No Azure AI Search / full Chat UI (Studio + this HTTP server)
- Agents run sequentially (Gemini free-tier limits)
- Xray needs Xray Cloud API keys if Test issue types are not in the project
- Jira Cloud webhooks need a public URL (ngrok/cloudflare tunnel) while developing locally

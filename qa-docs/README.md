# QA docs (RAG source)

Documents are organized by enterprise source (matches the Agentic RAG diagram):

```text
qa-docs/
  confluence/   # PRDs, wiki pages
  jira/         # stories, acceptance criteria
  github/       # API notes, PR comments
  xray/         # existing test packs / gaps
  cache/        # embedding cache (auto-generated)
```

## Supported formats
`.md`, `.markdown`, `.txt`, `.pdf`

## Which agent to use
- **Enterprise-style (recommended):** `qa-agentic-rag/` — orchestrator + source agents + rerank + guardrails + HTTP API
- **Simple classic RAG:** `qaTestCaseAgent.ts` — single retrieve-then-generate script

Delete `qa-docs/cache/*.json` after editing a source file so embeddings refresh.

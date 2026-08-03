# QA docs (RAG source)

Knowledge base ingested by `qa-agentic-rag`. Organized by enterprise source:

```text
qa-docs/
  confluence/   # PRDs, wiki pages
  jira/         # stories, acceptance criteria, defects
  github/       # API notes, repo summaries, change caches
  xray/         # existing test packs / gaps
  cache/        # embedding cache (auto-generated, gitignored)
```

## Supported formats
`.md`, `.markdown`, `.txt`, `.pdf`

## Notes
- Sample files here are **demo data** for trying the agent. Sync live sources with `POST /sync` or replace with your team docs.
- Use the agent via `npm run qa:agentic` / `qa:server` / `qa:studio` from the repo root (see root README).
- Delete `qa-docs/cache/*.json` after editing source files so embeddings refresh.

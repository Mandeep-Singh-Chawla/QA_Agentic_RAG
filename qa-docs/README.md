# QA docs (RAG source)

Knowledge base ingested by `qa-agentic-rag`. Organized by enterprise source:

```text
qa-docs/
  confluence/   # PRDs, wiki pages (seed + synced)
  jira/         # stories, acceptance criteria, defects
    defects/    # committed demo historic defects
    live/       # runtime sync (gitignored) — from Jira API / webhooks
  github/       # see github/README.md — seed notes + live/ sync (gitignored)
                # Team sets DEV_REPO + AUTOMATION_REPOS in .env (not in git)
  xray/         # existing test packs / gaps
  cache/        # embedding cache (gitignored)
```

## Supported formats
`.md`, `.markdown`, `.txt`, `.pdf`

## Notes
- Seed markdown under `confluence/`, `github/` (non-live), `jira/defects/`, and `xray/` is **demo data** for trying the agent.
- `jira/live/` and `github/live/` are **generated at runtime** (`POST /sync`, webhooks, connectors). They are gitignored — run sync locally after clone.
- Use the agent via `npm run qa:agentic` / `qa:server` / `qa:studio` from the repo root (see root README).
- Delete `qa-docs/cache/*.json` after editing source files so embeddings refresh.

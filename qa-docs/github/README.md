# GitHub knowledge (for the QA team)

Do **not** commit personal or company repo lists here. Each engineer/team sets their own repos in `.env` (see root `.env.example`).

## Folder layout

```text
qa-docs/github/
  README.md              # this file
  auth-api-notes.md      # demo seed (generic API notes for RAG)
  live/                  # RUNTIME ONLY — gitignored; created by sync
    INDEX.md
    my-repos.md          # from GITHUB_USER listing
    my-automation-repos.md
    automation-test-catalog.md
    <automation-repo>/   # per-repo catalogs from AUTOMATION_REPOS
    dev-change/          # PR/diff cache for DEV_REPO
```

## What each person / team configures (`.env`)

| Variable | Meaning | Example |
|----------|---------|---------|
| `GITHUB_USER` | GitHub user or org to list repos | `your-org` |
| `GITHUB_TOKEN` | PAT for private repos + higher rate limits | *(secret — never commit)* |
| `GITHUB_REPO` | Optional: sync one repo only | `your-org/payments-api` |
| `DEV_REPO` | **Dev application** under test (code changes / PRs) | `your-org/payments-api` |
| `AUTOMATION_REPOS` | **QA automation** repos (comma-separated) | `your-org/ui-tests,your-org/api-tests` |

After setting `.env`, run:

```bash
curl -X POST http://localhost:8787/sync
# or
curl -X POST http://localhost:8787/ingest
```

That fills `live/` locally. It stays gitignored so the shared repo stays generic.

## Seed vs live

- **Seed** (`auth-api-notes.md`): safe demo content for RAG without live GitHub.
- **Live** (`live/`): your team’s real repos/catalogs/diffs — local only, regenerate anytime.

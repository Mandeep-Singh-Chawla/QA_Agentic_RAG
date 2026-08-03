# Historic defect risk profile

Loaded 8 local historic defects (set JIRA_API_TOKEN to include live Bugs)
Synced: 2026-08-02T18:16:52.912Z

## Area risk scores

- **api**: score=25, defects=5
- **auth**: score=15, defects=3
- **security**: score=10, defects=2
- **login**: score=10, defects=2
- **ui**: score=10, defects=2
- **llm-evaluation**: score=10, defects=2
- **metric**: score=5, defects=1
- **test-data**: score=5, defects=1
- **dataset**: score=5, defects=1
- **guard**: score=5, defects=1
- **mobile**: score=5, defects=1
- **checkout**: score=5, defects=1
- **payment**: score=5, defects=1
- **docs**: score=5, defects=1

## Defects

- **DEF-101** [Critical] (local) — Login lockout bypass under race conditions — areas: auth, security, login
- **DEF-102** [Critical] (local) — Auth API returned 500 instead of 423 when locked — areas: auth, api, login, ui
- **DEF-103** [Critical] (local) — Evaluation metric NaN crashed batch jobs — areas: llm-evaluation, api, metric
- **DEF-104** [Critical] (local) — Prompt dataset truncation dropped golden labels — areas: test-data, api, dataset, llm-evaluation
- **DEF-105** [Critical] (local) — Guardrail false negatives on PII in nested JSON — areas: security, guard, api
- **DEF-106** [Critical] (local) — Mobile session timeout not surfaced in Appium flow — areas: mobile, auth, ui
- **DEF-107** [Critical] (local) — Checkout coupon stacking on retry — areas: checkout, payment, api
- **DEF-108** [Critical] (local) — Docs-only version bump false alarm — areas: docs

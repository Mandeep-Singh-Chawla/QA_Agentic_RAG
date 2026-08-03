# Historic production / escaped defects (seed for risk scoring)

Use this file when live Jira Bugs are unavailable, or as a supplement.
Each defect is tagged with risk areas used by optimize-coverage.

## DEF-101: Login lockout bypass under race conditions
- Type: Bug
- Severity: Critical
- Status: Done
- Areas: auth, security, login
- Summary: Users could retry faster than lockout counter updated; account not locked after 5 failures.
- Prod impact: Account takeover risk

## DEF-102: Auth API returned 500 instead of 423 when locked
- Type: Bug
- Severity: High
- Status: Done
- Areas: auth, api, login
- Summary: Locked accounts saw generic 500; clients could not handle lockout UX.
- Prod impact: Support tickets, unclear client behavior

## DEF-103: Evaluation metric NaN crashed batch jobs
- Type: Bug
- Severity: High
- Status: Done
- Areas: llm-evaluation, api, metric
- Summary: Empty prediction set produced NaN scores and failed nightly eval pipeline.
- Prod impact: CI red, delayed releases

## DEF-104: Prompt dataset truncation dropped golden labels
- Type: Bug
- Severity: Medium
- Status: Done
- Areas: test-data, api, dataset
- Summary: Long prompts truncated without warning; evaluation silently skewed.
- Prod impact: Misleading quality dashboards

## DEF-105: Guardrail false negatives on PII in nested JSON
- Type: Bug
- Severity: Critical
- Status: Done
- Areas: security, guard, api
- Summary: Nested fields skipped by PII detector.
- Prod impact: Compliance incident

## DEF-106: Mobile session timeout not surfaced in Appium flow
- Type: Bug
- Severity: Medium
- Status: Done
- Areas: mobile, auth, ui
- Summary: Expired token showed blank screen.
- Prod impact: App store reviews

## DEF-107: Checkout coupon stacking on retry
- Type: Bug
- Severity: High
- Status: Done
- Areas: checkout, payment, api
- Summary: Network retry applied coupon twice.
- Prod impact: Revenue leakage

## DEF-108: Docs-only version bump false alarm
- Type: Bug
- Severity: Low
- Status: Done
- Areas: docs
- Summary: Citation/metadata change had no runtime impact; full regression wasted cycles.
- Prod impact: Slow feedback (process issue)

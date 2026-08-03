# Xray — Existing login test pack

## Covered
- TEST-LOGIN-001: Valid login redirects to dashboard
- TEST-LOGIN-002: Invalid password shows generic error
- TEST-LOGIN-010: Password field is masked

## Gaps / not automated yet
- Account lockout after 5 failures (LOGIN-241)
- Audit log verification on lockout
- API 423 locked response
- Empty field validation messages

## Regression risk
Changing error copy may break UI assertions in TEST-LOGIN-002.

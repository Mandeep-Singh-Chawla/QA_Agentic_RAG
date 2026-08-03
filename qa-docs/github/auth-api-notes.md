# GitHub / Auth API notes

## Endpoint
`POST /api/v1/auth/login`

## Request
```json
{ "email": "user@example.com", "password": "secret" }
```

## Responses
- `200` — `{ "token": "...", "redirect": "/dashboard" }`
- `401` — `{ "error": "Invalid email or password." }`
- `423` — `{ "error": "Account locked. Try again in 30 minutes." }`
- `422` — field validation errors for empty/invalid email

## Notes from PR #482
- Passwords must never be logged.
- Response time SLO: p95 < 2s.
- Session cookie name: `sid`, HttpOnly + Secure.

# Feature: User Login

## Summary
Registered users authenticate with email and password to access the web app dashboard.

## Actors
- Registered user
- Guest (not logged in)

## Acceptance criteria
1. User can log in with a valid email and password.
2. Invalid credentials show a clear, non-revealing error: "Invalid email or password."
3. Account locks for 30 minutes after 5 consecutive failed attempts.
4. Password field is masked (type=password).
5. On success, a session cookie is created and the user is redirected to `/dashboard`.
6. "Forgot password?" link navigates to `/forgot-password`.
7. Empty email or password shows field-level validation errors.
8. Email must match a basic format (contains `@` and a domain).

## Non-functional
- Login API should respond within 2 seconds under normal load.
- Passwords must never appear in logs or error messages.

## Out of scope
- Social login (Google/Apple)
- MFA / OTP
- Remember-me checkbox (planned for next release)

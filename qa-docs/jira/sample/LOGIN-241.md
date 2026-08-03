# JIRA LOGIN-241 — Account lockout after failed logins

## Type
Story

## Description
As a security-conscious product, we must lock accounts after repeated failed login attempts to reduce brute-force risk.

## Acceptance criteria
- After 5 consecutive failed login attempts, lock the account for 30 minutes.
- While locked, even the correct password must fail with: "Account locked. Try again in 30 minutes."
- Successful login resets the failed-attempt counter.
- Lockout events are written to the audit log with user id + timestamp.

## Linked
- Confluence: User Login feature page
- Xray: TEST-LOGIN-LOCK-*

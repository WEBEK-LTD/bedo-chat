# Phase 14.1 report — stay signed in (D-49)

Built on Phase 14 (branch `phase-14-1-sessions`). Decision: **D-49** in `docs/DECISIONS.md`. The owner asked that
students and admins are not signed out automatically.

## What changed

- **Students.** The session is renewed every time Bedo Chat is opened (as before), and now lasts 400 days from the
  last use instead of 30. In practice a student who uses the site is never signed out. 400 days is the longest any
  browser keeps a cookie.
- **Admins.** No more sign-out after 30 minutes without activity or after 12 hours. The session is renewed whenever
  the dashboard is used (opening it also renews the cookie) and lasts 400 days from the last use.
- **Still ends a session:** Sign out; ending it from Devices; an admin action that ends a student's sessions
  (suspension, ban, 2-Step reset, phone change); a stolen refresh token being replayed; an admin's password change.
- **Unchanged security:** the authenticator code is still required at every admin sign-in; the 10-minute access
  token and refresh-token rotation stay; cookies stay HttpOnly, Secure and SameSite=Strict.
- Rotated-out refresh tokens are kept 30 days for stolen-token detection (an older one is simply not recognised),
  so that table does not grow for a year.

## Checks

- `apps/api/test/admin.integration.test.ts`: an admin away for 200 days (past the old 30-minute and 12-hour limits)
  is still signed in, using the dashboard moves the session on, the cookie is renewed for 400 days, 401 days unused
  ends it, sign-out ends it.
- `apps/api/test/auth.integration.test.ts`: a student's refresh cookie lasts 400 days and the session's expiry is
  400 days ahead.
- Typecheck, lint, unit, integration and all browser tests pass.

## For the owner

No SQL to run and no Netlify setting to change: upload the repository with GitHub Desktop. Admins who are signed
in now keep their current session; their next sign-in already gets the new lifetime.

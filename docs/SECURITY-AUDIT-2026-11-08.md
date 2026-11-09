# Security audit: BUILDINTEL v1.9.0 (2026-11-08)

Scope: all 206 HTTP routes and their auth gates, tenant isolation, sessions and login, uploads, signed links,
webhooks, secrets handling, security headers, dependencies, and production defaults. Method: code review of the
routes and their gates, targeted tests, and the full test suite. This is an internal audit. It is not an
independent penetration test, which the launch gates still require.

## Findings

| # | Severity | Finding | Status | Evidence |
|---|---|---|---|---|
| 1 | High | The client IP came from `X-Forwarded-For` on every request, even with no trusted proxy. Any client could send a fake header and get a fresh bucket for the sign-in, signup, and privacy-request rate limits, so brute force was unlimited. | **Fixed.** The header is used only when `TRUST_PROXY=1`, which `render.yaml` sets. | `src/server.js` (client IP), `test/audit-security.test.js` (spoofed header stays limited; trusted proxy identifies the client) |
| 2 | Medium | Postmark webhook secret compared with `===`, which is not constant-time. | **Fixed.** Constant-time comparison. | `src/server.js` `constantTimeEqual`, webhook test |
| 3 | Medium | The Content-Security-Policy allows `'unsafe-inline'` for scripts, which weakens protection against script injection if any output is ever unescaped. | **Open.** Fixing it means moving the console's inline scripts into files. | `SEC_HEADERS` in `src/server.js` |
| 4 | Low | The webhook secret is passed in the URL query, so it can appear in proxy and access logs. | **Open.** Move to a request header. | `/webhooks/postmark` |
| 5 | Low | Email verification activates an account on a GET request, so a mail scanner that prefetches links can activate a pending account. The token is still required. | **Open.** Confirm with a POST page. | `/verify/:token` |
| 6 | Info | In dry-run mode, the verification link is stored in the messages table so the owner can test signup. Live mode never stores it. The risk equals database access, and backups are encrypted. | **Accepted** while the platform runs in dry-run. A first live change removes this. | `src/server.js` signup, `test/leads.test.js` |

## Verified controls (no change needed)
- **Route gates:** every non-public route requires a session. The `platform` gate is limited to the platform owner. Public routes are health, sign-in, privacy requests (rate limited), signups (rate limited), webhooks (secret), and public catalog data.
- **Tenant isolation:** tenant records are read and written only through functions that enforce the organization. No route writes a caller-supplied organization ID. Credential verification is owner-only and tenant-scoped.
- **Sessions:** tokens are stored as hashes, expire after 12 hours, and can be revoked. Suspending a company ends its members' sessions.
- **Sign-in:** one generic error for unknown email and wrong password, so accounts can't be enumerated. Failures are audited. Staff require an authenticator code.
- **Passwords:** minimum 12 characters, stored as hashes.
- **Uploads:** 40 MB limit, PDF signature check, and signed short-lived links for plan-room files.
- **Secrets:** the server refuses to start with an `APP_SECRET` shorter than 32 characters. Secret values are not logged.
- **Email test route:** sends only to the signed-in staff member and is rate limited.
- **Unsubscribe:** HMAC-signed links, checked in constant time.
- **Backups:** AES-256-GCM encrypted, with a restore test in the suite.
- **Headers:** `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, and HSTS in production.
- **Dependencies:** `npm audit --omit=dev` reports 0 vulnerabilities.

## What this audit did not cover
- No independent penetration test, and no probing of the live service.
- Browser behaviour under hostile input beyond the QA suite.
- Legal and compliance review, which counsel must complete.

## Next steps, in order
1. Remove `'unsafe-inline'` from the script policy (finding 3).
2. Move the webhook secret to a header (finding 4).
3. Make email verification a POST confirmation (finding 5).
4. Commission the independent penetration test before launch.

## Status update: inline styles removed from the content policy
- The `style-src` policy no longer allows `'unsafe-inline'`. Every page, the app, the Super Admin portal and the UI gallery load their styles from stylesheet files (`site.css`, `product.css`, `home.css`, `app.css`, `admin.css`, `gallery.css`, `plain.css`).
- Styles that depend on data (bar widths, status colours) are applied through `element.style` after rendering, which the policy allows.
- Bid documents (proposals and signed records) keep their own styles under a narrow document policy with no scripts, frames or forms.
- Tests (`test/website.test.js`) fail if `'unsafe-inline'` returns to `style-src` or an inline style attribute or `<style>` block is added to the served pages.
- Script policy (`script-src 'self'`) was already strict; no `'unsafe-inline'` for scripts.

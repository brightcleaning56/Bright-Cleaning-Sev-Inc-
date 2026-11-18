# Audit 13-15: Customer portal, security and permissions, infrastructure and recovery

Scope: the clean clone at `C:\Users\Eric Moore\AppData\Local\Temp\bc-work\repo-fresh`, branch `claude/bright-cleaning-rebuild-nt1y6e`, HEAD `644b506`. Code was read in `server.js`, `roles.js`, `portal.js`, `mfa.js`, `totp.js`, `filecheck.js`, `admin-ext.js`, `ops.js`, `backupb2.js`, `backupcrypto.js`, `monitoring.js`, `payments.js`, `sched.js`, `contracts2.js`, `sitemedia.js`, `render.yaml`, `Dockerfile`, `.dockerignore`, `.env.example`, and the portal and admin front-end JavaScript.

Evidence used:
- A local temporary server (Node 22, temp DATA and UPLOAD dirs, no email provider configured, `TRUST_PROXY=1` so rate-limit probes could use separate client IPs). Synthetic customers, staff and role accounts only. The harness is `C:\Users\ERICMO~1\AppData\Local\Temp\claude\ad404082a23ddc2e\363886f5-fd1e-4fd0-905c-6cc346377808\scratchpad\audit-harness.js`, with output in the same folder at `audit-harness2.out`. It ran 123 checks: 119 passed and 4 failed. The 4 failures are findings F-14.3a, F-14.3b and F-14.2a.
- Existing suites, run once each, sequentially, with clean outputs: `tests/run-tests.js` 267 of 267 passed (exit 0). `tests/ui-tests.js` result in the Evidence log below.
- Read-only live GETs: `https://brightclean.net/api/health`, `/health`, and a HEAD on `/` for headers.
- No live writes. No email, SMS or webhook was sent. No secrets were read or printed. Customer data is not in this report.

Note on an earlier run: my first `run-tests` capture was contaminated by other agents running the same suites in this session at the same time (port reuse and a shared login rate-limit window). That capture is not used as evidence. The clean reruns above are.

## Summary

| Classification | Count |
|---|---|
| VERIFIED WORKING | 21 |
| INCOMPLETE OR UNRELIABLE | 8 |
| MUST FIX BEFORE LAUNCH | 5 |
| INSUFFICIENT EVIDENCE | 5 |

The table has 39 rows. Row 9 (portal payment) is mixed: ownership and signature verified, end-to-end Stripe not. It is counted as VERIFIED WORKING.

## Area table

| Area | Item | Classification |
|---|---|---|
| 13 | Account isolation: proposals, contracts, invoices, files, messages, pay, respond, change requests | VERIFIED WORKING |
| 13 | Sign-in link (single use, 30 minutes), session signing, tampering, revocation | VERIFIED WORKING |
| 13 | Session lifetime and logout (8 hours, no logout endpoint, sessionStorage) | INCOMPLETE OR UNRELIABLE |
| 13 | Identity is the email address; shared mailboxes see each other's records | MUST FIX BEFORE LAUNCH |
| 13 | What a customer can change (profile, notify, password, messages, service requests, uploads, decisions) | VERIFIED WORKING |
| 13 | Customer cannot change own account email; cannot reach admin APIs | VERIFIED WORKING |
| 13 | Portal password sign-in: policy, identical errors, rate limits | VERIFIED WORKING |
| 13 | Portal rate-limit state (in memory, resets on restart) | INCOMPLETE OR UNRELIABLE |
| 13 | Portal payment: amount, ownership, Stripe webhook signature | VERIFIED WORKING (ownership and signature); INSUFFICIENT EVIDENCE (end-to-end Stripe test) |
| 14 | Admin authentication, JWT signing, alg=none, foreign-secret tokens, logout and password-change revocation | VERIFIED WORKING |
| 14 | Role-based access on every admin route (central gate plus per-route auth) | VERIFIED WORKING, except the gap below |
| 14 | Role gap: sales and supervisor can edit invoice notes and issue date | MUST FIX BEFORE LAUNCH |
| 14 | Owner and manager two-step sign-in is enforced server-side | VERIFIED WORKING |
| 14 | Two-step sign-in: code replay and challenge reuse; secrets stored in plain text | INCOMPLETE OR UNRELIABLE |
| 14 | Password storage (bcrypt, cost 10 to 12) | VERIFIED WORKING |
| 14 | Login rate limiting (per IP, 8 per 15 minutes) | VERIFIED WORKING |
| 14 | Login rate limiting per account and on shared office IPs; timing difference on unknown emails | INCOMPLETE OR UNRELIABLE |
| 14 | CSRF and origin: bearer tokens only, no cookies | VERIFIED WORKING |
| 14 | Security headers: helmet, HSTS, nosniff, referrer policy, frame ancestors | VERIFIED WORKING |
| 14 | Content-Security-Policy for scripts is report-only in production (live confirmed) with admin token in localStorage | MUST FIX BEFORE LAUNCH |
| 14 | Upload handling: extension whitelist, file signature, executable and PDF-script refusal, random stored names, size and count limits | VERIFIED WORKING (no malware scan, as the module states) |
| 14 | SQL injection surface in dynamic queries | VERIFIED WORKING (by inspection and probes; see limits) |
| 14 | File serving and path traversal (`/api/files`, `/api/portal/files`, `/site-media`, static) | VERIFIED WORKING |
| 14 | Crew PIN and crew login lockout; crew token fallback secret | INCOMPLETE OR UNRELIABLE |
| 14 | Full XSS review of the admin UI (271 `innerHTML` assignments) | INSUFFICIENT EVIDENCE |
| 15 | Local encrypted backup (AES-256-GCM), plaintext fallback, restore with decrypt script and integrity check | VERIFIED WORKING (synthetic data) |
| 15 | Off-site Backblaze B2 copy is live and encrypted | INSUFFICIENT EVIDENCE |
| 15 | Restore drill: evidence is contradictory, and no restore into a separate instance is documented | MUST FIX BEFORE LAUNCH |
| 15 | Backups share the live 5 GB disk; retention and disk headroom | INCOMPLETE OR UNRELIABLE |
| 15 | Monitoring and alerting: no external monitor in repo; alerts depend on email | MUST FIX BEFORE LAUNCH |
| 15 | Health check: `/api/health` (live 200, local 200 and 503 path) | VERIFIED WORKING |
| 15 | Render restart on failed health check (runbook claim) | INSUFFICIENT EVIDENCE |
| 15 | Crash and restart: data survives kill -9; sessions and revocations persist | VERIFIED WORKING |
| 15 | Crash and restart: in-memory limiters reset; scheduler runs in the web process | INCOMPLETE OR UNRELIABLE |
| 15 | Deploy configuration: render.yaml, Dockerfile | INCOMPLETE OR UNRELIABLE |
| 15 | Rollback procedure | INSUFFICIENT EVIDENCE |
| 15 | Secrets management in config (generated JWT, sync-false secrets, git ignore) | VERIFIED WORKING |
| 15 | Custody of `BACKUP_KEY` and off-site variables (not in the blueprint) | INSUFFICIENT EVIDENCE |
| 15 | Production startup guard (refuses to start with a JWT_SECRET under 32 characters) | VERIFIED WORKING |

## Findings

Each finding has an ID, a classification, file and line references, and the evidence. "Harness" means the local temporary-server run described in the scope note.

### Area 13: Customer portal

**F-13.1 VERIFIED WORKING: account isolation.** A customer session returns only that customer's records. Each read is filtered on `lower(email)=session.email` (`portal.js:83-136`). Proposal decisions and change requests use `ownProposal`, which requires id and email (`portal.js:217`). Payment checks invoice ownership (`payments.js:34`). Uploads are checked against the owner (`portal.js:283`, `portal.js:299`). Harness, all passed: A's `/me` had no B names, emails, markers or invoice numbers, and B's had no A data. A's session could not respond to, request changes on, pay, or download B's proposal, invoice or files (404). A's session could not upload against B's proposal (400). A was refused staff-only files. Staff-only documents are stored with `/api/files/` URLs and are never returned by the portal route (`server.js:108`, `portal.js:299`).

**F-13.2 VERIFIED WORKING: sign-in link and session handling.** Links are 24 random bytes, stored only as SHA-256 hashes, valid 30 minutes and single use (`portal.js:58-59`, `:72-74`). Sessions are HMAC-signed with a key derived from `JWT_SECRET` (`portal.js:28`, `:36-42`). Harness: reuse refused, expired link refused, tampered email with old signature refused, empty signature refused, admin JWT refused on portal routes, customer session refused on admin routes. Sign-out-everywhere and password change both invalidate older sessions (`portal.js:209-215`, `:343-348`). Harness: after sign-out-everywhere, the old session got 401 and a second customer's session still worked.

**F-13.3 INCOMPLETE OR UNRELIABLE: session lifetime and no logout.** Portal sessions last 8 hours (`portal.js:75`, `:329`). The client keeps the session in `sessionStorage` (`public/assets/portal.js:388`, `:467`). There is no single-device logout, only sign-out-everywhere. A session copied from a shared computer stays valid until it expires or the owner signs out everywhere. Suggested: add a logout that clears the session server-side, and shorten the lifetime to 1 to 2 hours with silent re-link by email.

**F-13.4 MUST FIX BEFORE LAUNCH: identity is the email address, so records shared by a mailbox are shared by its customers.** Every query matches `lower(email)`. Two different customers who share one address (an accounts-payable inbox, or a property manager used for several sites) see each other's proposals, contracts, invoices, visits and messages (`portal.js:83-136`). The sign-in request also matches leads, so any website submission with a given address makes that mailbox eligible for a link (`portal.js:56`). Verified by code reading, not by a run. Impact is customer-facing data exposure. Suggested: block or warn on a second customer record that reuses an email, and when a portal is used by more than one customer, bind sessions to a customer id rather than the email.

**F-13.5 VERIFIED WORKING: what a customer can change.** Customers can change their name, company, phone and notification choices (`portal.js:193-207`), set or change a password (`portal.js:332-349`), send messages (`portal.js:172-190`), request service (`portal.js:350-373`), upload documents to their own proposals (`portal.js:266-293`), approve or decline a proposal with a typed name (`portal.js:219-247`), and request changes (`portal.js:249-264`). They cannot change their account email (harness: the body's `email` field was ignored and no record changed). Approval runs the same follow-up as the emailed link (`portal.js:242-245`), so the decision cannot be made without a typed name.

**F-13.6 VERIFIED WORKING: portal password sign-in.** Minimum 10 characters, not the email address (`portal.js:336-337`). Unknown email and wrong password return the same message, and a dummy hash is compared so timing is similar (`portal.js:318-328`). Harness: identical bodies for wrong password and unknown email; per-email limit of 8 per 15 minutes returned 429.

**F-13.7 INCOMPLETE OR UNRELIABLE: portal rate limits are in memory.** Sign-in link requests (5 per 10 minutes per IP, `portal.js:47-50`), messages, requests and password attempts (`portal.js:312-325`) are kept in `Map`s. They reset on restart and are per process, which is acceptable only while the service runs one instance. The `hits` map is never pruned (`portal.js:47-48`), so memory grows with the number of IPs. Harness: the sign-in link limit returned 429 as designed.

**F-13.8 VERIFIED WORKING (ownership and signature) / INSUFFICIENT EVIDENCE (Stripe end to end): payment.** The amount is computed on the server from the invoice (`payments.js:37-40`). Ownership is checked before anything else (`payments.js:34`). Stripe webhooks are verified with HMAC and a five-minute tolerance before any change (`payments.js:67-75`). No Stripe test was run, since no test key was configured and a live key must not be used.

### Area 14: Security and permissions

**F-14.1 VERIFIED WORKING: authentication and token handling.** Admin tokens are signed with `JWT_SECRET`, expire after 8 hours, and carry a version (`tv`) and a unique id (`jti`) (`server.js:38`). Every request checks the version and the revocation list (`server.js:61`). Harness, all passed: no token, garbage token, `alg=none`, and token signed with another secret were each refused with 401. Logout revokes the specific token (`admin-ext.js:332-340`, harness: 401 afterwards). The production startup guard exits when `JWT_SECRET` is under 32 characters (`server.js:10`, harness confirmed exit 1).

**F-14.2 VERIFIED WORKING, with one gap: role enforcement on admin routes.** A central gate on `/api/admin` checks the role against deny lists or allow lists before any route runs, and logs every denial (`server.js:85`, `roles.js:21-82`). Per-route auth is still required (`server.js:61`). The existing suite has a passing check that all 39 admin endpoints refuse anonymous requests. The harness checked 26 role-by-route cases. All behaved as designed, except the gap below.

**F-14.2a MUST FIX BEFORE LAUNCH: sales and supervisor can edit invoice notes and issue date.** `PATCH /api/admin/extra/:table/:id` accepts `notes` and `issue_date` for invoices (`admin-ext.js:129-137`). The route is not in `SALES_DENY` or `SUPERVISOR_DENY` (`roles.js:21-35`), and it does no role check itself. Both roles are described as having no invoices (`roles.js:6` and `roles.js:8`). Harness: the sales PATCH and the supervisor PATCH each returned 200, and the stored note changed to the last value written. The `issue_date` lock applies only after sending (`admin-ext.js:131`), so before sending, a sales user can move an invoice's business-day date, which drives revenue reporting. Fix: add `/^\/api\/admin\/extra\/invoices(\/|$)/` to `SALES_DENY` and `SUPERVISOR_DENY`, or add an explicit role check in the route. Then re-run the harness case.

**F-14.3 VERIFIED WORKING: two-step sign-in is enforced server-side for owners and managers.** Without an enabled and confirmed code, owners and managers get 403 on business routes and can reach only the set-up routes (`server.js:36-40`, `:61`). Harness: owner and manager both blocked until MFA was enabled, then allowed. Disabling is refused for these roles (`mfa.js:48-52`).

**F-14.3a INCOMPLETE OR UNRELIABLE: TOTP codes can be replayed.** A code is accepted for three 30-second steps and is not recorded as used (`totp.js` `verify`). Harness: the same valid code was accepted twice with two different challenge tokens (200 both times). Fix: store the last accepted time step per account and refuse any code at or below it.

**F-14.3b INCOMPLETE OR UNRELIABLE: the second-step challenge is reusable for 5 minutes.** Harness: the same `mfa_token` returned 200 on a second use with a valid code (`mfa.js:59-75`, `mfa.js:76`). Fix: give each challenge a random id and mark it used.

**F-14.3c INCOMPLETE OR UNRELIABLE: TOTP secrets are stored in plain text.** `mfa_factors.secret` is a plain column (`mfa.js:10`). A database copy without backup encryption would expose owner and manager second factors. Fix: encrypt the column with a key from the environment, or store it in the encrypted backup key set.

**F-14.4 VERIFIED WORKING: password storage.** Admin passwords are bcrypt with cost 12 for new passwords (`admin-ext.js:275`), portal passwords bcrypt 12 (`portal.js:343`), crew PINs bcrypt 10 (`sched.js:381`). Admin passwords must be 14 or more characters (`admin-ext.js:271`). The owner's password comes from `ADMIN_PASSWORD_HASH`, which must be produced by `scripts/create-admin.js`; its cost was not checked.

**F-14.5 VERIFIED WORKING: login rate limiting per IP.** `/api/admin/login` allows 8 attempts per 15 minutes per IP (`server.js:103`), and `/api/admin/login/mfa` allows 12 (`mfa.js:59`). Harness: 429 reached on repeated wrong passwords. Public `/api/` routes allow 600 per 15 minutes per IP and 5000 for admin bearer traffic (`server.js:14`). Harness: 429 after the ceiling.

**F-14.5a INCOMPLETE OR UNRELIABLE: login limits are per IP only.** There is no per-account lockout, so guessing one account from many addresses is not limited. In an office where everyone shares one public IP, 8 attempts per 15 minutes is shared by all staff, so one person's typos can lock out the others. Unknown emails return before any bcrypt call (`server.js:103`), so response time reveals whether an account exists. Suggested: add an account-level limit and a per-account lockout after repeated failures.

**F-14.6 VERIFIED WORKING: CSRF and origin.** Authentication is a bearer token in the `Authorization` header, and no cookies are set (harness: no `Set-Cookie` on login). A cross-origin write without a token was refused (401). Browsers do not attach the header automatically, so cross-site request forgery is not available. Note that this depends on the header design, and any future cookie-based session would need its own CSRF protection.

**F-14.7 VERIFIED WORKING: security headers.** helmet is set (`server.js:12`), with HSTS, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer` and `X-Frame-Options: SAMEORIGIN` present on the live site (HEAD on `/`) and locally.

**F-14.7a MUST FIX BEFORE LAUNCH: the script Content-Security-Policy is report-only.** `server.js:12` sends `script-src 'self' https://cdn.jsdelivr.net` only as `Content-Security-Policy-Report-Only` unless `CSP_ENFORCE_SCRIPTS=1`. Live confirmation (HEAD on `/`): `content-security-policy-report-only: script-src 'self' https://cdn.jsdelivr.net; report-uri /api/csp-report`, with no enforced script policy. The admin keeps its bearer token in `localStorage` (`public/admin/admin.js:9`, `:276`, `:327`), so any script injection in the admin page can take over an owner session. The site's inline-script test passes (existing suite), so enforcement looks feasible. Fix: set `CSP_ENFORCE_SCRIPTS=1` in the blueprint, after checking the report log at `/api/admin/system-health` for the admin and public pages.

**F-14.8 VERIFIED WORKING: upload handling.** Files are stored under random UUID names with the extension cut to 10 characters (`server.js:42`). Extension must be in the whitelist (`server.js:43`). Content must match the signature (`filecheck.js:9-20`). Programs (MZ, ELF, Mach-O, `#!`) are refused under any name (`filecheck.js:18`). PDFs containing `/JavaScript`, `/JS` or `/Launch` are refused (`filecheck.js:25-27`). Limits: 30 MB and 8 files per request. Harness, all passed: a real PDF accepted, a renamed PE refused, a PDF with JavaScript refused, `.exe` refused, honeypot filled refused. Limit: there is no malware scanner, as the module states. Files are served back only through authenticated or token-checked routes (see F-14.10).

**F-14.9 VERIFIED WORKING, with limits: SQL injection surface.** Dynamic column names come from fixed lists in every `UPDATE` I checked: `server.js:144` (`cfg.fields`), `admin-ext.js:136` (whitelist), `ops.js:141` (fixed list), `pm.js:163` and `subscriptions.js:87` (keys built from explicit assignments), and `issues.js:237`. Table names in `admin-ext.js:115-121` come from a fixed list. Request keys are never used directly as column names. Harness: an injected body key and a non-numeric id produced no effect and no SQL error (after fixing a harness bug). Limit: I reviewed by searching every template-literal query and the `Object.keys(b)` patterns, not every query in every module.

**F-14.10 VERIFIED WORKING: file serving and path traversal.** `/api/files/:name` requires an admin token and uses `path.basename` (`server.js:108`). `/api/portal/files/:name` checks owner and uses `path.basename` (`portal.js:298-303`). `/site-media/:name` serves only names registered in `site_media` (`sitemedia.js:48-50`). Harness, all passed: encoded traversal probes on each route and on static files returned 403 or 404, and no `package.json` content was served.

**F-14.11 INCOMPLETE OR UNRELIABLE: crew login.** The crew PIN is 4 to 8 digits (`sched.js:380`). The lockout is per login name, not per IP: 5 failures lock that name for 15 minutes, in memory (`sched.js:359`, `:368`). Anyone can lock out a crew member by guessing with their phone number (denial of service). At 5 guesses per 15 minutes, a 4-digit PIN can be guessed in days. The crew token signing key falls back to a public string when `JWT_SECRET` is unset (`sched.js:351`). The production guard prevents this (`server.js:10`), so the risk is limited to a misconfigured non-production instance. Suggested: add a per-IP limit and a 6-digit minimum for PINs.

**F-14.11a INCOMPLETE OR UNRELIABLE: long-lived public links.** Proposal, contract and tracking links have no expiry beyond their own rules. Contract links (`contracts2.js:178-210`) and tracking links (`sched.js:577-600`) remain valid until the record changes. Tokens are random (proposal tokens use 24 bytes, `server.js:117`). The owner should accept this knowingly.

**F-14.11b INCOMPLETE OR UNRELIABLE: a revoked admin token can still open draft proposal previews.** `/api/proposal/:token` treats any valid admin JWT as preview and does not check revocation (`server.js:136`). It only bypasses the Draft and Ready gate and skips view counting, so the risk is low.

**F-14.12 INSUFFICIENT EVIDENCE: full XSS review of the admin UI.** `public/admin/admin.js` has 271 `innerHTML` assignments. I sampled the conversation renderer (`admin.js:855-870`), which escapes with `esc` (`admin.js:11`), and the portal renderer (`public/assets/portal.js:23`, every template interpolation wrapped in `esc`). I did not review all 271. Settle it by a targeted review of every assignment that uses customer-entered text (messages, names, addresses, notes), or by enforcing CSP (F-14.7a).

**F-14.13 VERIFIED WORKING: audit logging of denials.** Each denied role request is written to `audit_log` as `permission denied` (`server.js:85`). The clean rerun of `tests/run-tests.js` passed the check "D-08: staff are refused on every owner/manager action (enforced on the server, denial logged)".

### Area 15: Infrastructure and recovery

**F-15.1 VERIFIED WORKING: local backup, encryption and restore mechanism (synthetic data).** A backup is taken with SQLite's online backup API (`ops.js:180`). When `BACKUP_KEY` is set, the copy is encrypted with AES-256-GCM, random 12-byte IV and 16-byte tag (`backupcrypto.js`), and the plaintext is deleted (`ops.js:185-186`). Harness, all passed: plaintext backup is a readable SQLite file when no key is set; with the key set the `.enc` file does not start with the SQLite header; `scripts/decrypt-backup.js` restored it; the restored copy passed `PRAGMA integrity_check` and held the synthetic rows; a wrong key was refused. Local retention is 14 copies (`ops.js:196`).

**F-15.2 INSUFFICIENT EVIDENCE: the live off-site copy to Backblaze B2 is running and encrypted.** Off-site upload only happens when `BACKUP_KEY` and the four `BACKUP_*` variables are set (`backupb2.js:10-17`, `ops.js:191-192`). None of them appear in `render.yaml`, so they are configured by hand in the Render dashboard, and this audit cannot read them. The runbook says they are set (`PRODUCTION_RUNBOOK.md:25`, `:78`). To settle it: confirm the five variables exist on the live service, and confirm a recent `brightclean-*.db.enc` object appears in bucket `brightclean-backups-eric`. Also check the `automation_log` rows with kind `backup-offsite` and status `ok`.

**F-15.3 MUST FIX BEFORE LAUNCH: restore drill evidence is contradictory, and no restore into a separate instance is documented.** `docs/AUDIT_BASELINE.md:27` and `docs/READINESS_2026-11-12.md:49` say a production backup was decrypted on the server on 2026-11-12 and passed `integrity_check`. `docs/PRODUCTION_READINESS_AUDIT_2026-11-18.md:24` says "no restore drill has been run against a real backup" and marks restore as "Incomplete. Must fix before launch". The runbook requires a drill into a separate staging instance at least quarterly, and warns never to test over the live file (`PRODUCTION_RUNBOOK.md:26-29`). Decrypt plus integrity check is not the same as starting the application against restored data. Fix: restore the most recent real backup into a separate Render service or a local copy, start the app against it, log in, and record the result with the date and row counts. Keep the record in the docs.

**F-15.4 INCOMPLETE OR UNRELIABLE: backup placement and disk headroom.** Local backups are on the same 5 GB persistent disk as the live database (`render.yaml:45-50`, `ops.js:166`). A disk failure takes both. The only independent copy is the off-site one (F-15.2). With 14 copies, total disk use grows with database size, and no disk-usage alert exists in the repository. The database size on the live disk was not measured.

**F-15.5 MUST FIX BEFORE LAUNCH: monitoring and alerting depend on email, and no external monitor is defined.** Backup failures and automation errors are emailed to the owner (`ops.js:207-213`, `:193`, `:202`). App errors are recorded and emailed once per distinct error per hour (`monitoring.js`, covered by an existing passing check). If SMTP is not configured or fails, these alerts are silent, and the only other visibility is the admin System health page. `/api/health` is public and checks only SQLite `SELECT 1` (`ops.js:228-237`), so it would not notice a failed backup, a full disk, or a stopped scheduler. DEPLOY.md:45 says live SMTP delivery was not verified. Fix: add an external uptime monitor on `/api/health` and an alert on backup age, with the owner's contact, and verify one alert end to end before launch.

**F-15.6 VERIFIED WORKING: health check.** Live `https://brightclean.net/api/health` returned HTTP 200 in 0.36 s: `{"ok":true,"db":"ok","uptime_s":805,"version":"5.0.0","build":"61fde0e508f6","build_files":143,"errors_1h":0}`. `/health` returned the same. Locally `/api/health` returned 200 with `db: ok`. The code returns 503 when the database check fails (`ops.js:237`), not exercised here. The uptime at check time was about 13 minutes, so the service had restarted recently. The cause was not investigated (possibly a deploy). Note that the endpoint exposes version, build fingerprint and error count to anyone (INCOMPLETE OR UNRELIABLE, low).

**F-15.7 INSUFFICIENT EVIDENCE: Render restarts the service when the health check fails.** `PRODUCTION_RUNBOOK.md:79` says so. `render.yaml:10` sets only `healthCheckPath`. Render's documented use of health checks is deploy gating; whether a running instance is restarted on failure was not verified. Confirm in the Render dashboard, or add an external monitor (F-15.5).

**F-15.8 VERIFIED WORKING: crash and restart behaviour (local).** Killing the process with SIGKILL and restarting it preserved all data (estimate count unchanged). Sessions and revocations survived, since the signing key and the `revoked_tokens` table persist. Harness: a session revoked before the crash stayed refused after restart.

**F-15.8a INCOMPLETE OR UNRELIABLE: in-memory state resets on restart.** Rate-limit counters for portal sign-in and messages, crew lockouts, MFA login counters, and the sign-in ticket store for live updates (`command.js`) are in memory and reset on restart. The scheduler runs in the web process (`ops.js:371-373`, `sched.js:672`), so an outage stops reminders and backups until the next start. Acceptable on one instance. Multi-instance deployment would break these, and `DISABLE_SCHEDULER` exists only for extra instances.

**F-15.9 INCOMPLETE OR UNRELIABLE: deploy configuration.** `render.yaml` sets `autoDeploy: true` with no branch, so every push to the default branch deploys immediately (`render.yaml:11`). The persistent disk prevents zero-downtime deploys, so each deploy is a 1 to 2 minute outage (`PRODUCTION_RUNBOOK.md:83`). The blueprint lacks the `BACKUP_*` variables and `CSP_ENFORCE_SCRIPTS` (F-14.7a, F-15.2). `Dockerfile` has no `HEALTHCHECK`, copies everything not excluded into the image, including `tests`, `docs`, `operator/` and a 938 KB `buildintel.zip`, and is not used by the Render blueprint, which runs the Node runtime. `.dockerignore` correctly excludes `.env`, `data`, `uploads` and `.git`.

**F-15.10 INSUFFICIENT EVIDENCE: rollback.** Rollback is documented as a Render dashboard action to a previous deploy (`PRODUCTION_RUNBOOK.md:92`), and the note that schema changes are additive is consistent with the migrations I read (`ALTER TABLE ... ADD COLUMN` with existence checks). Not exercised on the live service. Confirm by a rollback test on a staging service.

**F-15.11 VERIFIED WORKING: secrets management in config.** `JWT_SECRET` is generated by Render (`render.yaml:19-20`). `SMTP_PASS` and `ADMIN_PASSWORD_HASH` are `sync: false`, so they are entered in the dashboard and not committed (`render.yaml:38`, `:40`). `.env` is git-ignored and `.dockerignore` excludes it. Only `.env.example` is tracked. A grep of tracked files for common live key patterns (Stripe live, AWS access key, Slack, SendGrid, private key blocks) found no hits. The grep was basic.

**F-15.12 INCOMPLETE OR UNRELIABLE: custody of `BACKUP_KEY`.** Losing `BACKUP_KEY` makes every encrypted backup unreadable. The runbook says to keep it elsewhere than the backups (`backupcrypto.js:1-2`), but nothing records where it is stored. Also, rotating `JWT_SECRET` (for example by recreating the blueprint) signs out every admin and portal session. Confirm the key is in the owner's password manager and that it is recorded with the restore procedure.

**F-15.13 VERIFIED WORKING: production startup guard.** Production refuses to start with a `JWT_SECRET` under 32 characters (`server.js:10`). Harness: exit code 1.

## Evidence log

- Existing suite, `tests/run-tests.js`, clean sequential run: 267 of 267 passed, exit 0. Output: `C:\Users\ERICMO~1\AppData\Local\Temp\claude\ad404082a23ddc2e\363886f5-fd1e-4fd0-905c-6cc346377808\scratchpad\run-tests-final.out`.
- Existing suite, `tests/ui-tests.js`, clean sequential run: 93 of 93 passed, exit 0. Output: `...\scratchpad\ui-tests-final.out`.
- Harness, local temp server with synthetic data: 119 passed, 4 failed. The failures are F-14.2a (two cases: sales and supervisor PATCH), F-14.3a (replay) and F-14.3b (challenge reuse). Output: `...\scratchpad\audit-harness2.out`.
- Live read-only checks: `/api/health` and `/health` (200, db ok), headers on `/` (HEAD).
- Earlier contaminated run (not used): `...\scratchpad\run-tests.out`.

## What I could not test, and why

- **Off-site B2 and the live `BACKUP_*` variables.** Only the owner can read the Render service settings and the bucket. Settle by F-15.2.
- **Live SMTP and alert delivery.** Would require sending mail, which is prohibited here. Settle by a test alert sent by the owner (F-15.5).
- **Render restart on health failure and rollback.** Both need dashboard or staging actions. Settle by F-15.7 and F-15.10.
- **Stripe payment end to end.** No test key was configured, and a live key must not be used. Settle with Stripe's test mode in a staging instance.
- **Full XSS review of 271 `innerHTML` assignments.** Not completed in this pass. Settle by F-14.12 or by enforcing CSP (F-14.7a).
- **Full SQL review.** I reviewed dynamic SQL by searching for template literals and key-derived columns, not every statement.
- **Shared-email exposure (F-13.4).** Verified by reading the SQL, not by seeding two customers with one address. Settle by running that seed on the temp server.
- **Browser behaviour of the portal and admin.** The Chrome tools were not used, per the brief. The UI suite covers some of it.
- **Scale and multi-instance behaviour.** Only one instance was run.

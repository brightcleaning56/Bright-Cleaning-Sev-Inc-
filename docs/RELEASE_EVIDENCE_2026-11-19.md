# Release evidence, 2026-11-19

Recorded from the production branch `claude/bright-cleaning-rebuild-nt1y6e`, latest pushed commit `30d8f14`.
Live site: brightclean.net, health build `e7b836047493` (reported by /api/health at 2026-11-19 ~15:00 UTC).

## Automated tests (local copy, run on commit 30d8f14)
- `node tests/run-tests.js`: 300/300 passed
- `node tests/mfa-replay-test.js` (sign-in code and challenge reuse, F-14.3a/b): 6/6 passed
- `node tests/crew-escalation-test.js` (crew message escalation): 11/11 passed
- `node tests/upload-restrict-test.js` (public uploads closed by default): all passed
- `node tests/clamav-test.js` (virus scan against a fake scanner): all passed. This is not a real ClamAV test.

## Live checks (production, read-only or already observed)
- Admin sign-in: cookie session works (owner session confirmed, HTTP 200 on /api/admin/me)
- Script security (CSP): enforced header present, report-only off
- Public bid form with a file: refused with 403, no record created (verified 2026-11-19)
- Crew message to office and office message to crew: working (verified 2026-11-19)
- Client portal message reaches the office list, and office reply is saved and emailed (verified 2026-11-19)
- Crew escalation task: created after 60 minutes, closed by owner (task #13, issue type fixed in a later commit)
- Calls: connected to Twilio (Command Center status)
- Email: outgoing via Postmark (Command Center status). Inbox: Microsoft 365 not connected.

## Open items (not complete)
- Twilio texts: A2P 10DLC campaign is IN REVIEW with use case MARKETING (should be CUSTOMER_CARE). Support ticket #30436964 open; comment asking Twilio to change the use case posted 2026-11-19 09:55. Texts blocked until approved.
- ClamAV malware scanning: not set up. Public and portal uploads stay closed (PUBLIC_UPLOADS not set).
- Microsoft 365 inbox: not connected (needs app registration by owner).
- Payment processor webhooks, refunds, disputes, accounting reconciliation: not tested with real providers.
- Backup restore into a separate environment: not done (needs Backblaze access and a separate database).
- Uptime alerts: not set up (needs owner name for alerts).
- Real-device crew tests (iOS and Android): not done.
- AI triage: off (provider credit balance).
- Price book: 38 of 86 cleaning scopes unpriced (owner decision).
- Cleanup of 2026-11-19 test records and temporary script `cleanup-messaging-test.js` on production: pending owner approval.
- Consent wording: the optional text checkbox is in the forms, but the server does not yet store text consent separately.
- Privacy notice states "we do not sell or share your mobile number or text consent for their marketing." Owner confirmed on 2026-11-19 that this is true.

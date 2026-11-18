# Audit 03 (AI and call center) and 04 (Email center)

Repository: `C:\Users\Eric Moore\AppData\Local\Temp\bc-work\repo-fresh`, branch `claude/bright-cleaning-rebuild-nt1y6e`, HEAD `644b506`.
File references below are relative to that repository root.

## Scope note

- Read the call, AI, SMS and email code paths end to end: `calls2.js`, `callcenter.js`, `ai.js`, `clientmsgs.js`, `followups.js`, `emailcenter.js`, `emailsuppress.js`, `m365.js`, `postmark.js`, the mailer wrapper in `server.js`, and every `sendMail` call site. Read the relevant admin UI in `public/admin/admin.js`.
- Ran the existing suites with the Node 22 binary: `tests/run-tests.js` (267 of 267 pass), `tests/ui-tests.js` (crashed partway, see I-20), and the standalone files `postmark-test`, `ai-test`, `suppress-test`, `suppress-routes-test`, `intro-email-test`, `leadclass-test` and `lead-notify-test`. The standalone files are not run by `npm test`.
- Ran one probe: a temp-data local server with synthetic, correctly signed Twilio webhooks (`DATA_DIR` in a temp folder, no live providers, no production data). Also ran a local fake Postmark endpoint to check what the mailer sends.
- No live site contact, no emails, SMS or calls were sent, and no secret values were read. Nothing in the tracked tree was changed; this report is the only file written.

## Classification by area

| Area | Classification | Main evidence |
|---|---|---|
| Inbound calls: signed webhooks, capture, status | VERIFIED WORKING | V-1, V-2 |
| Voicemail and assigned callback tasks | VERIFIED WORKING (tests) | V-2 |
| Click-to-call and browser phone | VERIFIED WORKING (tests); not live | V-3 |
| Call recording playback | VERIFIED WORKING (tests) | V-5 |
| Live transcript and transcription callbacks | MUST FIX (M-4) | M-4 |
| AI receptionist | VERIFIED WORKING against a fake Claude; live model not exercised | V-6, E-3 |
| AI off state | VERIFIED WORKING | V-7 |
| AI lead triage and call analysis | VERIFIED WORKING (tests, fake Claude); AI sends email by default (M-3) | M-3 |
| Automatic outbound callbacks | MUST FIX (M-2) | M-2 |
| Texts (SMS): sending and proposal follow-up texts | MUST FIX for automatic texts (M-5); send success path not tested | M-5, I-10 |
| Inbound SMS | INSUFFICIENT EVIDENCE | E-2 |
| Email sending through Postmark | MUST FIX for attachments (M-1) | M-1 |
| Email sending through SMTP fallback | VERIFIED WORKING (tests); attachments work here | V-9 |
| Suppression and opt-out for automated email | VERIFIED WORKING | V-8 |
| Suppression for staff-sent and portal email | INCOMPLETE | I-2, I-3 |
| Bounces, delivery events, Postmark webhook | VERIFIED WORKING for token and bounce path; INCOMPLETE for event handling | V-10, I-4 |
| Email Center listing, history, drafts, flags | VERIFIED WORKING (tests); INCOMPLETE on limits and coverage | I-5, I-6 |
| Microsoft 365 connect, token, sync | VERIFIED WORKING (tests); INCOMPLETE on mailbox scope | V-11, I-6, I-7 |
| Microsoft 365 attachments | INCOMPLETE (on demand, not stored); live not verified | I-8, E-4 |
| Provider configuration | INCOMPLETE (not in render.yaml) | I-17, I-18 |
| Admin UI for calls and email | UNRELIABLE (lead-history crash halted UI suite) | I-20, E-7 |

Counts: 5 MUST FIX (M-1 to M-5), 22 INCOMPLETE OR UNRELIABLE (I-1 to I-22; I-20 is the UNRELIABLE UI item), 13 VERIFIED WORKING (V-1 to V-13), 8 INSUFFICIENT EVIDENCE (E-1 to E-8). Some items relate to more than one area; each is listed once below under its primary classification.

## Provider status and configuration

No secret values were read. Variable names only.

| Provider | Connected in code | Needed to work | Notes |
|---|---|---|---|
| Twilio (voice, recording, live transcript, click-to-call, browser phone, SMS) | Yes: `calls2.js`, `clientmsgs.js`, `followups.js`, `sched.js` | `TWILIO_AUTH_TOKEN` (every webhook is refused without it, `calls2.js:60`); `TWILIO_ACCOUNT_SID` or learned from the first signed webhook (`calls2.js:62`); `TWILIO_NUMBER` or the Settings value or learned from a signed inbound call (`calls2.js:35,62`); `TWILIO_SMS_FROM` for texts (`followups.js:38`); `TWILIO_API_KEY` and `TWILIO_API_SECRET` for the browser phone (`calls2.js:227`); ring phones from `TWILIO_FORWARD_TO` or Settings (`calls2.js:57`) | Webhook URLs must match `PUBLIC_BASE_URL` exactly (`calls2.js:13`), or every webhook returns 403. The SMS webhook must be set on the number (`clientmsgs.js:181`) and is not health-checked (E-2). |
| Anthropic (AI receptionist, triage, analysis, reply drafts) | Yes: `ai.js`, `calls2.js` | `ANTHROPIC_API_KEY`; optional `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`, `ai.js:9`), `AI_RECEPTIONIST_MODEL` (default `claude-haiku-5-5`, `calls2.js:370`), `AI_RECEPTIONIST_MODE`, `AI_RECEPTIONIST_TIMEOUT_MS` (9 s), `AI_RECEPTIONIST_MAX_TURNS`, `BUSINESS_TZ` | Receptionist needs Twilio too. Model IDs not verified (E-3). |
| Postmark (email) | Yes: `postmark.js`, `server.js:46-47`, `emailcenter.js:95-110` | `POSTMARK_TOKEN` (switches all mail to Postmark); `FROM_EMAIL` (must be a verified sender); optional `POSTMARK_STREAM` (default `outbound`), `POSTMARK_API_URL`; `POSTMARK_WEBHOOK_TOKEN` and a Postmark webhook pointing at `/api/webhooks/postmark?token=...` for delivery and bounce events | Without the webhook, Email Center never shows "Delivered" and bounces are seen only on send failure. Attachments are dropped (M-1). |
| SMTP (fallback) | Yes: `server.js:49-50` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` (used only when `POSTMARK_TOKEN` is unset) | Attachments are sent through SMTP. |
| Microsoft 365 (Outlook inbox, read only) | Yes: `m365.js` | `MS365_CLIENT_ID`, `MS365_CLIENT_SECRET`; optional `MS365_TENANT_ID` (default `organizations`), `MS365_LOGIN_BASE`, `MS365_GRAPH_BASE`, `MS365_SYNC_MS` (default 3 minutes). Redirect URI `PUBLIC_BASE_URL/api/m365/callback` must be registered in the app registration. Scopes: `offline_access User.Read Mail.Read`. | Token is encrypted with a key derived from `JWT_SECRET` (`m365.js:19`). `JWT_SECRET` of at least 32 characters is enforced in production (`server.js:10`). |

`render.yaml` declares only the SMTP, `JWT_SECRET`, `PUBLIC_BASE_URL` and `NOTIFY_EMAIL` variables (`render.yaml:19-37`). Twilio, Anthropic, Postmark and Microsoft 365 variables must be set by hand on Render. Confirm them there (I-17).

## Findings

### MUST FIX

**M-1. Postmark sends drop invoice PDF attachments (customer-facing money document).**
- `postmark.js:7-10` takes only `{ from, to, subject, text, replyTo }` and posts only `From, To, Subject, TextBody, ReplyTo, MessageStream`. The `attachments` field is discarded.
- `invoices2.js:70-74` sends the invoice with `attachments: [{ filename, content: pdf(inv) }]` and the text "Please find invoice ... attached." The invoice is then marked sent.
- Evidence: a local fake Postmark endpoint received `From, To, Subject, TextBody, MessageStream` and no `Attachments` field (probe script `C:/Users/ERICMO~1/AppData/Local/Temp/claude/ad404082a23ddc2e/363886f5-fd1e-4fd0-905c-6cc346377808/scratchpad/pm-attach-check.js`, run output). The main suite's invoice-with-PDF checks (`tests/run-tests.js` around 2641 and the Workflow G check, PASS) run under SMTP, so they never exercise the Postmark path. `tests/postmark-test.js` covers notifications only.
- Impact: every invoice email sent while `POSTMARK_TOKEN` is set reaches the customer without its PDF, while the app records it as sent.
- Fix direction: map `attachments` to Postmark's `Attachments` (`Name`, `Content` base64, `ContentType`), then add a Postmark-path test that asserts the attachment field.

**M-2. Automatic callbacks never stop for a lead that does not answer.**
- `calls2.js:545-546`: the sweep selects leads with `callback_requested=1` and no stage of done or converted, and a `last_callback_at` older than 24 hours. Nothing caps attempts.
- `calls2.js:556` increments `callback_calls`, but no code reads it as a limit. The only code that clears `callback_requested` is the staff checkbox (`calls2.js:626`).
- Result: a lead that never answers is called again each day, up to the daily limit (default 10, max 50, `calls2.js:530`), indefinitely. The sweep runs every 5 minutes (`calls2.js:565`) when enabled.
- Legal: the automated voice call needs the owner's legal-review sign-off (`calls2.js:539`). The repeat-call pattern is the risk counsel should see (`docs/LEGAL_REVIEW_BRIEF.md` exists; not read in full).
- Fix direction: a maximum attempt count per lead, and clearing `callback_requested` after a connected call or a set number of attempts.

**M-3. The AI emails prospects automatically by default, against the file's own rule.**
- `ai.js:2` says the AI "never sends email". `maybeRequestInfo` (`ai.js:315-330`) sends the AI-written `reply_body` to the lead with `automated: true`. It is on by default: `setting('auto_request_info', true)` (`ai.js:316`).
- The sweep runs every 60 seconds (`ai.js:341-344`) for new bid and inquiry leads with missing items. The model's text is not reviewed by a person. Guards are a `$` regex (`ai.js:319`) and the suppression gate.
- The standalone `ai-test` has a PASS for this behavior ("Missing information: the AI emails the customer its questions automatically, once", output line 2). That confirms it is built, not that it is intended for launch.
- Fix direction: decide with the owner. Either default it off, or hold drafts for review, and add an unsubscribe line and sender identity to automatic mail.

**M-4. Twilio transcription callbacks overwrite the call transcript.**
- `calls2.js:146-149`: the transcription webhook runs `UPDATE calls SET transcript=?` with the voicemail text, replacing whatever is there. Live transcript parts merged by `mergeTranscript` (`calls2.js:43-53`) and the AI receptionist conversation appended by `finalizeAi` (`calls2.js:454-467`) are both lost if the transcription callback arrives after them.
- Probe (temp server, signed requests): a live transcript part "I need a quote for an office cleaning" was saved, then a transcription callback with "Voicemail: call me back about the office" arrived. The stored transcript became only the voicemail text. Result: `Voicemail: call me back about the office`.
- The `finalizeAi` ordering case (AI conversation lost to a later transcription) follows from the same line. It is code evidence only; not probed.
- Fix direction: append the transcription under a labelled heading (as `mergeTranscript` does) instead of replacing.

**M-5. Automatic proposal follow-up texts go out without consent or opt-out checks, and are not logged as texts.**
- `followups.js:61-69`: after a proposal is sent, `scheduleAuto` schedules an automatic follow-up for two days later. The channel is SMS when the proposal has no usable email (`followups.js:64`).
- `followups.js:90` (inside `sendFollowup`, `followups.js:78-92`), called by `runDue` (`followups.js:95-99`), sends the SMS with no check for an opt-out record. The app has no SMS opt-out table. Inbound STOP text is not recorded (`clientmsgs.js:181-196`), so Twilio's own STOP block is the only protection.
- Automatic texts are not written to `sms_messages`, so they do not appear in the text history. Only `proposal_followups` records them (`followups.js:40-52` and the `done` call).
- Legal: unsolicited automated texts to consumers need consent under US rules. Counsel must confirm before launch; the code has no consent record to show.
- Fix direction: an SMS opt-out table, STOP/START handling on inbound text, consent recorded per contact, and each automatic text written to `sms_messages`.

### INCOMPLETE OR UNRELIABLE

**I-1.** Standalone `tests/ai-test.js` fails 2 of 17 checks: the AI takeoff ("AI takeoff reads a PDF drawing set", `ai-test` output line 6) and the AI estimate from a description (line 8). The second returns 409 "The price book has no priced items yet". The takeoff creates a draft with `lines: []`. Probably test data (no priced construction scope items); not confirmed. See E-6.

**I-2.** Staff-sent customer email has no suppression check. `crm.js:203-211` sends through `sendMail` without `automated`, so the gate in `server.js:164` does not apply. The address must be a customer contact, but an address that opted out or bounced is not refused. The admin UI shows a blocked list (`public/admin/admin.js:4112-4120`), but no send-time warning was found in the code read. This is intentional for human email (the note in `emailsuppress.js:8`), but it is not safe for an opted-out customer. Also `ai.js:289-306` (lead reply), which blocks only `$` amounts.

**I-3.** Automated acknowledgements do not carry the `automated` flag, so the opt-out gate does not apply: `portal.js:187` ("We received your message") and `portal.js:370` ("We received your Bright Clean request"). They go to a customer's own address after an opt-out. Low risk, but it contradicts `emailsuppress.js:4`.

**I-4.** Postmark events (`emailcenter.js:95-110`):
- The token is passed in the URL query (`emailcenter.js:98`), so it can appear in access logs. A header or a path secret would be safer.
- Every `Bounce` record suppresses the address permanently (`emailcenter.js:104-107`), including soft or transient bounces (for example a full mailbox). Staff must clear it by hand.
- `SpamComplaint` records are not handled. Postmark's own suppression list stops later sends to such addresses, which then surfaces as a 406 (`server.js:162`), so the effect is partly covered.
- "Delivered" appears only when the webhook is configured (`emailcenter.js:55, 103`).

**I-5.** Email Center lists only the latest 500 sent and 500 inbound rows, with no paging (`emailcenter.js:48-49`). Categories come from subject keywords (`emailcenter.js:35-44`). Customer history beyond 500 emails is not visible here.

**I-6.** Microsoft 365 coverage (`m365.js:39-57`):
- Reads only the signed-in user's inbox root (`me/mailFolders/inbox/messages`, line 51). Mail moved by Outlook rules out of the Inbox, mail in a shared company mailbox that the user cannot read as `me`, and Sent Items are not read.
- Emails sent from Outlook directly never reach the history, and "Needs reply" (`emailcenter.js:54, 62`) stays wrong for them.
- Matching uses only the exact From address (`m365.js:39-45`).

**I-7.** Connect state (`m365.js:24, 75, 80`) is held in memory. A restart or redeploy between clicking Connect and returning from Microsoft gives "link expired". Not a security defect.

**I-8.** Microsoft 365 attachments (`m365.js:104-124`) are read from Outlook on demand and never stored. They fail when Outlook is disconnected, and forwarded-message attachments return 415. The Graph calls were not exercised live (E-4).

**I-9.** The daily callback limit counts `audit_log` rows since server-local midnight (`calls2.js:533-534`). On Render this is UTC, not the business day in `BUSINESS_TZ`. The window check (`calls2.js:540-541`) uses the business clock, so the two disagree.

**I-10.** SMS limits: `sendSms` (`followups.js:40-52`) has no status callback, so "Sent" means Twilio accepted the message, not that it was delivered. Staff texts (`followups.js:160-200`) and automatic texts (M-5) differ in what they log. No test performs a successful text send; the only SMS tests check the refusal when Twilio is not set up.

**I-11.** `save_caller_details` on an already-linked lead overwrites `details` with this turn's text (`calls2.js:382-383`; `details` is in the update set). Earlier notes from the same call can be lost. Appending, as the open-lead branch does at `calls2.js:387`, would avoid it.

**I-12.** Live transcription is started for every inbound call before the dial (`calls2.js:127`). The transcript includes the caller's speech before a voicemail, which is useful, but the caller hears only the recording notice. Confirm that is acceptable under the recording notice wording (`TWILIO_RECORDING_NOTICE`).

**I-13.** Automatic callbacks have no per-day or per-lead audit beyond `audit_log` rows, and the daily cap is read from a setting that can be raised to 50 (`calls2.js:612`). Combined with M-2, a single setting change multiplies the repeat-call exposure.

**I-14.** Outbound automatic callback has a Press-1 gate (`calls2.js:568-582`), and the disclosure precedes it. The connected-call path sends the caller to team phones only; no test checks the case where a team phone answers after the call has ended. Low.

**I-15.** `runOutboundSweep` runs for every eligible lead in one pass with no per-call error backoff beyond skipping a failed lead (`calls2.js:549-561`). A Twilio outage repeats the attempt every 5 minutes. Low.

**I-16.** The AI receptionist sends an owner email for every logged complaint with no rate limit (`calls2.js:403-404`). One caller can call repeatedly and produce repeated emails. Low.

**I-17.** Provider variables are not declared in `render.yaml` (only SMTP, JWT and base URL, `render.yaml:19-37`). A launch checklist must confirm Twilio, Anthropic, Postmark and Microsoft 365 variables are set on the live service. Not read; no secret values read.

**I-18.** `PUBLIC_BASE_URL` defaults to `https://brightclean.net` (`calls2.js:13`, `m365.js:14`). Twilio signatures are computed on that base, so a staging or second deployment without its own `PUBLIC_BASE_URL` rejects every Twilio webhook with 403.

**I-19.** The AI reply guard against prices is a `$` regex (`ai.js:295`). A price written as words ("two hundred dollars") is not caught. The customer-facing prompt forbids prices, so this is a backstop only.

**I-20. UNRELIABLE: admin lead-history panel throws an uncaught error.** `public/admin/admin.js:1189-1211`: `loadLeadHistory` reads `#leadHist` before an `await`, then after the await uses `$('#lhSave')`. When the lead drawer is re-rendered during the request, the box is stale and `$('#lhSave')` is null, giving `TypeError: Cannot set properties of null` at line 1208. The UI suite died there after the Security section, so the remaining UI checks did not run. The race is the most likely cause but was not reproduced directly.

**I-21.** Email attachments are outbound only for invoices. The Email Center cannot attach files, and no send path accepts attachments besides the invoice. Acceptable if not required at launch.

**I-22.** The invoice email template contains a hard-coded personal phone number for the owner (`invoices2.js:73`). Confirm the owner wants it on every customer invoice. The number is not repeated here.

### VERIFIED WORKING

**V-1. Webhook signatures.** `calls2.js:15-21, 59-65` verifies `X-Twilio-Signature` (HMAC-SHA1 of the full URL plus sorted params) with a constant-time compare and refuses unsigned requests with 403. Recording URLs must be on `api.twilio.com` (`calls2.js:141-142`). Probe: a signed status callback returned 200 and a recording URL on a non-Twilio host returned 400. Suite: "forged or unsigned requests 403" PASS (`tests/run-tests.js` 2340/2366).

**V-2. Inbound capture, voicemail, callback tasks.** `calls2.js:67-83, 113-120, 121-137`. Probe: a signed no-answer inbound call created a Missed row. Suite: "signed missed call auto-logged..." and "unanswered dial → Voicemail..." PASS (lines 174-175, 204).

**V-3. Click-to-call and bridge.** `calls2.js:184-226`. Staff phone rings first, then the customer is dialed from the business number with the recording notice. Suite PASS (line 191) for settings, bridge, customer outcomes, unsigned bridge refused. Not run live.

**V-4. Browser phone.** `calls2.js:236-263`. Token is a Twilio access token with identity and app grants; non-browser callers refused. Suite PASS (line 192).

**V-5. Recording playback.** `calls2.js:304-316`. Fetched server-side with account credentials; only `api.twilio.com` hosts (test host allowed only outside production, `calls2.js:308-309`). Suite PASS (line 196).

**V-6. AI receptionist behavior.** `calls2.js:413-472` against a fake Claude. Suite `ai-test.js` 12-17 PASS: answers, saves lead (updated, not duplicated), transfers on request, logs a complaint once for a known customer, ends politely, falls back to the office on outage, handles silence, labels the call, creates one callback task.

**V-7. AI off.** Without `ANTHROPIC_API_KEY` every AI action returns 503 and nothing breaks. Suite "[AI off]" PASS (line 248).

**V-8. Suppression gate for automated mail.** `server.js:164` wraps `sendMail`; `emailsuppress.js:52-70` blocks automated sends to suppressed addresses and job inboxes. Blocked sends are logged. Suites: `suppress-test` 9 of 9, `suppress-routes-test` 5 of 5, `intro-email-test` 11 of 11, `leadclass-test` 10 of 10, `lead-notify-test` 7 of 7 PASS. Automated senders carry the flag: `ops.js:253`, `ai.js:322`, `autobid.js:94`, `leadclass.js:161,228`, `followups.js:88`.

**V-9. SMTP fallback sends attachments.** Nodemailer path (`server.js:49-50`) passes the invoice PDF through; suite Workflow G "sent by email with PDF" PASS under SMTP only.

**V-10. Postmark token and bounce path.** `emailcenter.js:95-99` refuses events without the token; `ai.js:304-305` and `server.js:162-164` turn a Postmark 406 into a 422 with guidance and mark the address undeliverable. Suites: `postmark-test` 3 of 3 PASS; "Postmark 406 inactive → 422" PASS (line 229); "delivery webhook refuses without its token" PASS (line 106).

**V-11. Microsoft 365 connect and sync.** `m365.js:19-22` encrypts the token (AES-256-GCM). `m365.js:75-80` checks a one-time state. `m365.js:55-57` dedupes by Graph id and runs reply tracking. Suite "[Microsoft 365] ... token stored encrypted ... sync copies inbox messages once" PASS (line 228).

**V-12. Production secret enforcement.** `server.js:10` exits in production if `JWT_SECRET` is missing or shorter than 32 characters, so the M-365 key derived from it (`m365.js:19`) is not guessable in production. Verified by reading only.

**V-13. Human reply path.** `ai.js:289-306` sends the lead reply only on an explicit staff click, requires a subject and body, names the sender, and refuses `$` amounts (see I-19). The Email Center sends only to linked customers, with a confirm prompt (`public/admin/admin.js:4268`). Verified by reading; suite email-center PASS (lines 102, 106).

### INSUFFICIENT EVIDENCE

**E-1.** No live provider was exercised (Twilio, Postmark, Microsoft 365, Anthropic). Every provider result above is from a fake endpoint, a probe, or code reading.

**E-2.** Inbound SMS (`clientmsgs.js:181-196`): the signature check is correct in code, but it needs the number's Messaging URL set to `/api/webhooks/twilio/sms` in the Twilio console. The phone health check tests only the voice URL (`calls2.js:501-502`). Confirm on the live number.

**E-3.** Anthropic model IDs: the defaults (`ai.js:9` `claude-sonnet-5-5`, `calls2.js:370` `claude-haiku-5-5`) differ, and the health check only pings the receptionist model (`calls2.js:503-505`). Confirm each ID against the live key before launch.

**E-4.** Microsoft 365 attachment download (`m365.js:104-124`) against real Graph responses.

**E-5.** Which mailbox the company uses. If it is a shared mailbox, `me/` (`m365.js:51`) reads the wrong mailbox. Confirm with the owner.

**E-6.** Two `ai-test` failures (I-1): takeoff and description estimate; cause probably price-book data, not confirmed.

**E-7.** Admin UI for calls and email. The UI suite stopped at I-20, so these pages were not exercised.

**E-8.** Legal basis for automatic calls, texts and AI-written email (M-2, M-3, M-5). Requires counsel, not a code check.

## What could not be tested, and why

- Live Twilio, Postmark, Microsoft 365 and Anthropic calls: not permitted (no live writes, no sends, no calls). Only fake endpoints and synthetic signed webhooks on a local temp server.
- Outbound SMS success path: no test sends a text successfully and no fake Twilio Messages endpoint was built in this audit (I-10).
- Full UI suite: stopped at I-20 with an uncaught error, so the admin calls and email screens were not exercised.
- Standalone `ai-test` takeoff/estimate checks (E-6): outside this assignment's core and not diagnosed.
- Reading the live Render environment or Twilio/Postmark/Entra consoles: not allowed (no secret values, no live access). Items needing those are listed as E-2, E-3, E-5, I-17.

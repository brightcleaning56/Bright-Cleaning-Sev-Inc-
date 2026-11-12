# Bright Cleaning Sev Inc — Production Operations Runbook

## 1. Deployment prerequisites
- Use a supported Node.js LTS release and install dependencies with `npm install`; commit and maintain a package lock file before production, then use `npm ci` for repeatable deployments.
- Set `NODE_ENV=production`, `PORT`, a unique random `JWT_SECRET` of at least 32 characters, `ADMIN_EMAIL`, and a bcrypt `ADMIN_PASSWORD_HASH`.
- Set `PUBLIC_BASE_URL=https://brightclean.net`.
- Use persistent storage for `data/` and `uploads/`. Ephemeral serverless filesystems are not suitable for the SQLite database or local uploads.
- Terminate TLS at the hosting provider or reverse proxy. Force HTTPS and configure HSTS after verifying the domain and certificate.
- Restrict admin access, use individual named admin accounts when multi-user roles are added, and enforce MFA at the identity/hosting layer where available.

## 2. Email setup
Configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `FROM_EMAIL`, and `NOTIFY_EMAIL`. Use a domain-authenticated sender and configure SPF, DKIM and DMARC with the email provider. Send test messages to internal mailboxes before enabling customer reminders.

## 3. Enable automation safely
1. Verify `/health` returns `ok: true`.
2. Verify the Automation & Settings panel reports email configured.
3. Submit a controlled test bid request and verify the acknowledgement and internal notification.
4. Create a test proposal and verify the proposal link in a separate browser.
5. Enable proposal/invoice reminders only after internal test delivery.
6. Enable approved-proposal handoff only after confirming that a customer approval creates a **draft** contract and a **planning** project.
7. Confirm no project is mobilized without manager approval, site walkthrough, scope verification, staffing, safety planning and any required PO/contract.

## 4. Backups and recovery
- Application attempts a daily SQLite backup to `data/backups` and retains 14 local copies.
- Local backups are not enough. Current state: each backup is encrypted (`BACKUP_KEY`) and copied to Backblaze B2 (`BACKUP_BUCKET`, `BACKUP_KEY_ID`, `BACKUP_KEY_SECRET`, `BACKUP_S3_ENDPOINT`). The owner is emailed when a backup or its off-site copy fails. Still to do: off-site copy of `uploads/` and of the `.env` secrets in a managed secret store (never place `.env` in a public web directory).
- A backup is only verified after a restore test: decrypt it with `scripts/decrypt-backup.js` and check the database opens (`PRAGMA integrity_check`).
- Perform a restore drill into a separate staging instance at least quarterly.
- Record RPO/RTO and assign an owner for recovery.
- Never test restore by overwriting the live database.

## 5. Business configuration required
Bright Clean must verify and maintain:
- Service production rates by task, surface, soil level, equipment and site conditions.
- Loaded wage cost by labor class, including payroll burden, benefits and overtime rules.
- Crew sizes, shift hours, travel zones, mobilization costs, supplies, equipment and disposal rates.
- Minimum job charges, overhead allocation, target gross margins and any taxes that apply.
- Current insurance certificates/limits, licenses, safety program, training and vendor qualification documents.
- Contract language, payment terms, cancellation, change-order, warranty/re-clean and dispute processes.
- Actual operational coverage and availability by geographic market.

## 6. Automation boundaries and required integrations
The application can automate web intake, acknowledgement, customer record creation, quote calculations, proposal links, selected email reminders, approval handoff, audit logging and local database backup.

The following require additional integrations and/or human approval:
- Electronic signatures: select and connect a qualified e-sign provider; define signer identity and audit evidence.
- Payments and deposits: connect a payment processor and implement webhook verification, refunds, disputes and reconciliation.
- Accounting: connect the company's accounting platform and map customers, invoices, taxes, payments and chart of accounts.
- SMS/calls: connect a messaging/telephony provider, obtain required consent and implement opt-out and retention policies.
- Workforce: implement employee identities, availability, scheduling, timekeeping, payroll export, certifications and labor-law controls.
- Field quality: mobile site checklists, photo evidence, inspection scoring, deficiency assignment, rework and customer sign-off.
- Customer portal: authenticated customer accounts, access control, project requests, document access, invoice history and notifications.

## 7. Go-live acceptance gates
- All pages and links checked on desktop and mobile.
- Forms tested with valid, invalid, duplicate and malicious input.
- Authentication, authorization, rate limits, file upload validation and access controls reviewed.
- Proposal creation, sending, opening, approval, decline, expiry and follow-up tested end to end.
- Invoice creation, partial payment, overdue reminder, refund/adjustment and reconciliation tested after payment integration.
- Contract and project auto-handoff tested with the setting off and on.
- Database migration, backup, restore and retention verified.
- Monitoring, alerting, incident owner and support contact assigned.
- Legal, privacy, accessibility, insurance, tax and employment requirements reviewed by qualified professionals.

**Operating principle:** automate repeatable administrative steps; keep accountable human approval for safety, pricing exceptions, contractual commitments, staffing and final quality.


## 8. Keep the service running
Run the Node process under a production process manager such as the hosting platform's managed Node service, systemd or PM2. Configure automatic restart on crash, startup on host reboot, health checks against `/health`, log rotation and alerting. A browser tab or a developer's laptop is not a production runtime. Confirm the host's filesystem persists across deploys and that only one scheduler instance is active; if multiple server replicas are required, move reminders/backups to a dedicated single worker or a managed job queue to prevent duplicate sends.

## 9. Bright Clean live setup (Render)
| Item | Value |
|---|---|
| Service | Render web service `brightclean-web` (Starter), Blueprint `brightclean`, region Oregon |
| Code | GitHub `brightcleaning56/Bright-Cleaning-Sev-Inc-`, branch `claude/bright-cleaning-rebuild-nt1y6e`; every commit auto-deploys |
| Node.js | `engines` in package.json: >=20 <25 (tested on Node 22) |
| Domain | brightclean.net and www (DNS at GoDaddy: A @ 216.24.57.1, CNAME www -> brightclean-web.onrender.com) |
| Persistent disk | 5 GB at `/opt/render/project/src/persist` (`DATA_DIR` = .../persist/data, `UPLOAD_DIR` = .../persist/uploads) |
| Database backups | `.../persist/data/backups`, daily, 14 kept, encrypted. Each one is also uploaded to Backblaze B2 (bucket `brightclean-backups-eric`, US East 005). Owner is emailed on failure. |
| Health check | `/api/health` (also `/health`) checks the database; Render restarts the service if it fails |
| Email | Microsoft 365 `smtp.office365.com:587`, user info@brightclean.net. Needs `SMTP_PASS` and Authenticated SMTP enabled for the mailbox. |
| Scheduler | Runs inside the web service every hour (reminders, daily backup). Keep one instance; set `DISABLE_SCHEDULER=1` on any extra instance. |

**Deploy behavior:** services with a disk cannot run two copies at once, so each deploy takes the site offline for about 1–2 minutes. Batch changes and deploy outside business hours when possible.

**Restore from a backup (never over the live file without a fresh backup first):**
1. Admin > Settings > Back up now, then download that file (this is your undo).
2. In Render, open the service Shell.
3. `cp /opt/render/project/src/persist/data/brightclean.db /opt/render/project/src/persist/data/brightclean.before-restore.db`
4. Upload or copy the chosen backup to `/opt/render/project/src/persist/data/brightclean.db`.
5. Render > Manual Deploy > Restart service, then check `/api/health` and the admin.

**Rollback code:** Render > Deploys > pick the previous deploy > Rollback. Database changes in V5 only add columns and tables, so the previous version keeps working on the upgraded database.

## 10. Running the test suites
```
npm ci
npm i --no-save smtp-server jsdom
node tests/run-tests.js     # functional/API/automation/backup suite, writes tests/results.json
# Last runs (Node 22): server 224/224, UI 83/83, portal 78/78, payments 10/10, AI 17/17.
# On Windows, if better-sqlite3 fails to load, use the Node version in package.json engines (Node 22), not a newer one.
node tests/ui-tests.js      # admin and proposal screens, writes tests/ui-results.json
```
Both start their own server on a temporary database and never touch live data.

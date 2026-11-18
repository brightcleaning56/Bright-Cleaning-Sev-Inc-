# Restore runbook: B2 backup into a separate instance

Status: procedure written 2026-11-18. **No restore drill has been passed with this runbook.** The results log at the end is blank until someone runs the drill and fills it in.

## What is and is not evidence

- Decrypting a backup and running `PRAGMA integrity_check` shows the file is a readable SQLite database. It does **not** show that the application starts against the data, that a user can log in, or that the records look right.
- Earlier notes that say "restore drill" (`docs/AUDIT_BASELINE.md`, `docs/READINESS_2026-11-12.md`) describe the decrypt and integrity step only. They do not count as a restore drill. `docs/PRODUCTION_READINESS_AUDIT_2026-11-18.md` still lists restore as not complete.
- A drill is complete only when section 5 is filled in with a real result.

## Rules

1. Never restore over the live database file (`/opt/render/project/src/persist/data/brightclean.db`). Restore into a new, empty folder.
2. The test instance must not send anything to customers, staff or vendors. Leave `SMTP_*`, `BACKUP_*`, Twilio, Postmark, Stripe and AI keys unset, and set `DISABLE_SCHEDULER=1`. Then reminders, automation, backups and the off-site copy do not run.
3. Use a new `JWT_SECRET` for the test instance (at least 32 characters). Admin sessions from production do not carry over, which is expected.
4. Keep `BACKUP_KEY` out of shell history and out of any log you save. Do not paste it into a ticket or document.
5. Use only synthetic actions on the test instance. Do not contact `https://brightclean.net` during the drill.

## 1. Pick the backup

- Off-site: the Backblaze B2 bucket `brightclean-backups-eric`. Objects are named `brightclean-YYYYMMDD-HHMMSS.db.enc`. Choose the newest object that is dated before the incident (or the most recent one for a routine drill).
- Local (if the disk still exists): `data/backups/` on the persistent disk, same naming without `.enc` only when no key was set.
- Record the object name and its size in the results log.

## 2. Set up a clean working folder (local machine or a second Render service)

```
mkdir -p restore-test/data restore-test/uploads
cd restore-test
```

Copy the code at the deployed build (the same commit as production, from git), then install dependencies with `npm ci`. Never use the live `data/` folder.

## 3. Decrypt into the test folder

```
BACKUP_KEY="<the key used on production>" node scripts/decrypt-backup.js /path/to/brightclean-YYYYMMDD-HHMMSS.db.enc ./restore-test/data/brightclean.db
```

A wrong key is refused by the GCM tag check. If the script prints "Could not decrypt", stop and check the key in the password manager. Do not try other keys.

Then confirm the file opens:

```
node -e "const D=require('better-sqlite3');const d=new D('restore-test/data/brightclean.db',{readonly:true});console.log(d.pragma('integrity_check',{simple:true}));d.close()"
```

Expected output: `ok`.

## 4. Start the application against the restored data

```
DATA_DIR=./restore-test/data UPLOAD_DIR=./restore-test/uploads JWT_SECRET="<new 32+ character test secret>" DISABLE_SCHEDULER=1 PORT=3100 NODE_ENV=production node server.js
```

Notes:
- `DATA_DIR` and `UPLOAD_DIR` point the server at the test folders (both are read in `server.js`). Never leave them unset in this drill, or the server uses the default folders in the code directory.
- Uploaded files are not in the database backup. Their absence is expected in this drill (see section 6).
- Production `NODE_ENV` makes the startup guard refuse a short `JWT_SECRET`. That is intended.

Then:

1. `GET http://127.0.0.1:3100/api/health` returns `ok: true` and `db: ok`.
2. Sign in to the admin at `http://127.0.0.1:3100/admin/`. The owner account needs its password and its authenticator code. Use the owner's own authenticator. Do not bypass two-step sign-in.
3. Open Customers, Proposals, Invoices and Quality. Check that the row counts are close to the production counts on the backup date (record both numbers).
4. Open one customer record and one invoice. Check that the fields match the source.
5. Stop the process with Ctrl+C when done.

## 5. Record the result

Fill this in for every drill. Do not write "passed" unless every line below is true.

| Field | Value |
|---|---|
| Date of drill | |
| Person who ran it | |
| Backup object name and size | |
| Decrypt succeeded (yes/no) | |
| `integrity_check` result | |
| App started against restored data (yes/no) | |
| `/api/health` result | |
| Owner sign-in with authenticator (yes/no) | |
| Row counts: customers / estimates / contracts / invoices (restored vs production at backup time) | |
| One record checked field by field (which record) | |
| Problems found | |
| Result: PASS / FAIL | |

Save the completed table in this file under "Results log", with the date. Keep the notes free of secrets.

## 6. Known gaps the drill does not cover

- Uploaded files (`uploads/`) are not in the database backup. Off-site copy of uploads is still to do (see `PRODUCTION_RUNBOOK.md` section 4).
- Environment secrets (`JWT_SECRET`, `BACKUP_KEY`, SMTP) are not in the backup. Losing `BACKUP_KEY` makes every encrypted backup unreadable.
- The drill does not test Render's restart behaviour or the production rollback (see `docs/AUDIT_BASELINE.md`).

## 7. Restoring production (only after a real incident)

Follow `PRODUCTION_RUNBOOK.md`, section 9 ("Restore from a backup"). Take a fresh backup first, keep the current file as `brightclean.before-restore.db`, and check `/api/health` after restart.

## Results log

_No drill has been recorded yet._

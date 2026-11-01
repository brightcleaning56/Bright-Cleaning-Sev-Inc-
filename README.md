# BUILDINTEL

Commercial construction intelligence and bid automation for Bright Clean Inc. and future tenants.
Built with Node.js 20+ and no runtime dependencies.

Start with **[docs/LAUNCH_24_HOURS.md](docs/LAUNCH_24_HOURS.md)**. It explains what can and cannot go
live in 24 hours, the gates, the runbook and the known gaps.

## Quick start

```bash
npm test                         # 45 tests, should all pass
node src/cli.js readiness        # go-live gate report (exit 2 = NO-GO)
BUILDINTEL_ADMIN_KEY=... BUILDINTEL_UNSUBSCRIBE_SECRET=... npm start
```

## Owner console (web app)

Everything can be run from the browser. Open the server's root URL (for example `http://localhost:8080/`)
and sign in with `BUILDINTEL_ADMIN_KEY`. The key is kept in this browser tab only.

- **Dashboard:** readiness gates, tenant list, and a button to run the autopilot cycle now.
- **New tenant:** create an organisation. The tenant's own API key is shown once.
- **Tenant page:** autopilot on/off and auto-approve limit, rate cards (validated on save), contacts
  (add, then verify with a recorded source), opportunities, bids (approve or withdraw), and audit.
- **Approval queue:** every bid waiting for your decision, across all tenants.

The console is plain HTML and JavaScript with a strict Content-Security-Policy (`script-src 'self'`,
no inline scripts or styles). Owner actions on a tenant use the admin key plus `x-org-id`, so no tenant key is
needed in the browser.

## Configuration (environment variables)

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | `8080` |
| `BUILDINTEL_ADMIN_KEY` | Admin API key (24+ chars). Admin routes are disabled without it. | unset |
| `BUILDINTEL_UNSUBSCRIBE_SECRET` | HMAC secret for unsubscribe links (24+ chars) | unset |
| `BUILDINTEL_PUBLIC_URL` | Public base URL used in links | `http://localhost:PORT` |
| `BUILDINTEL_DATA_FILE` | State file path (use a persistent, backed-up location) | `data/state.json` |
| `BUILDINTEL_SEND_MODE` | `dry_run` (default) or `live` (needs a provider adapter; refuses to start otherwise) | `dry_run` |
| `BUILDINTEL_AUTOPILOT` | `on` starts the scheduled autonomous cycle | off |
| `BUILDINTEL_AUTOPILOT_INTERVAL_MIN` | Minutes between cycles | `60` |
| `BUILDINTEL_ALLOW_SAMPLE` | `1` enables synthetic demo permits. Never in production. | off |

## Tenant setup

1. Copy `data/examples/brightclean.org.example.json`, replace every `REPLACE` value.
2. `node src/cli.js create-org <file>`. The API key is shown once. Store it securely.
3. Add rate cards (`PUT /api/me/pricing`), contacts (`POST /api/contacts`, then owner verification),
   and the autopilot policy (`POST /api/me/autopilot`).

## API

Organisation routes take the header `x-org-key: <key>`. Admin routes take `x-admin-key: <key>`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` | none | Liveness |
| GET | `/api/readiness` | admin | Go-live gates |
| POST | `/api/orgs` | admin | Create a tenant (returns its API key once) |
| GET | `/api/me` | org | Tenant profile |
| PUT | `/api/me/profile` | org | Territories, project types, minimum size |
| PUT | `/api/me/pricing` | org | Rate cards (validated on save) |
| POST | `/api/me/autopilot` | org | Enable autopilot and set the auto-approval limit |
| POST | `/api/contacts` | org | Add a contact (starts `unverified`) |
| POST | `/api/contacts/:id/verify` | admin | Owner verifies a contact with a source |
| POST | `/api/estimates` | org | Calculate an estimate (not stored) |
| GET | `/api/opportunities` | org | Matched permits with reasons |
| GET | `/api/bids` | org | Bids for this tenant only |
| POST | `/api/bids/:id/approve` | org | Approve and dispatch (preview in dry-run) |
| POST | `/api/bids/:id/withdraw` | org | Withdraw a bid |
| GET | `/api/audit` | org | Last 100 audit events for this tenant |
| GET | `/api/unsubscribe?email=&token=` | HMAC token | Opt out across the platform |
| POST | `/api/admin/sync` | admin | Sync authorised sources now |
| POST | `/api/admin/autopilot/run` | admin | Run one autopilot cycle now |
| GET | `/api/admin/queue` | admin | Bids waiting for owner approval |
| GET | `/api/admin/jobs` | admin | Recent autopilot runs |

## Compliance guarantees enforced in code

- Scraping, login bypass, CAPTCHA bypass and paywall bypass are refused (`src/ingest/sources.js`).
- A source runs only with reviewed terms and confirmed commercial reuse. Today none is authorised.
- A bid is never marked `sent` without a provider acceptance receipt, and never `delivered` without a delivery receipt.
- Bids cannot be approved without an attached proposal, and cannot skip states.
- Only verified or source-confirmed contacts can receive a bid. The system never invents a GC or an email address.
- Opt-outs are honoured platform-wide immediately. Marketing email needs an unsubscribe link and a postal address.
- Tenant data is scoped by `orgId`. Cross-tenant access returns 404 (tested over HTTP).
- Proposal content is HTML-escaped and carries a no-guarantee-of-award disclaimer.

## Layout

See the file map in `docs/LAUNCH_24_HOURS.md`.

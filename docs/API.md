# Bright Clean API

Base address: `https://brightclean.net`

## 1. Send leads from another source (recommended)

Use this to send leads from a partner website, an ad landing page, Zapier, a CRM or a phone tool.

**Get a key:** sign in to the admin as the owner, go to **Settings → Connect other sources (API keys)**, click **New API key**, give it a name (for example "Partner website"), and copy the key. The key is shown **once**. Only a hash is stored, so if you lose it, revoke it and create a new one.

**Send a lead:**

```
POST https://brightclean.net/api/integrations/leads
Content-Type: application/json
X-API-Key: YOUR_KEY
```

Fields (JSON). Send at least one of `name`, `email` or `phone`.

| Field | Required | Notes |
|---|---|---|
| `name` | one of name/email/phone | Contact name (up to 150 characters) |
| `email` | one of name/email/phone | Must be a valid address |
| `phone` | one of name/email/phone | Up to 60 characters |
| `company` | no | Up to 200 characters |
| `project_name` | no | Also accepted as `project` |
| `service` | no | Service they want |
| `details` | no | Also accepted as `message` or `notes` (up to 5,000 characters) |
| `source` | no | Optional label, for example `spring-campaign`. Shown after the key name. |

**Success:** `201 Created` with `{"ok": true, "id": 123}`. The lead appears in **Leads** with its source recorded, as `API: <key name> · <source>`, and the usual lead notification email is sent.

**Errors:**
- `401` `{"error": "Invalid or revoked API key."}` — the key is missing, wrong or revoked.
- `400` — no name, email or phone, or an invalid email address.

### Examples

curl:

```bash
curl -X POST https://brightclean.net/api/integrations/leads \
  -H "Content-Type: application/json" \
  -H "X-API-Key: YOUR_KEY" \
  -d '{"name":"Jane Doe","email":"jane@example.com","company":"Example Co","details":"Needs weekly janitorial","source":"partner-site"}'
```

JavaScript (browser or Node 18+):

```js
const res = await fetch('https://brightclean.net/api/integrations/leads', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-API-Key': process.env.BRIGHTCLEAN_KEY },
  body: JSON.stringify({ name: 'Jane Doe', email: 'jane@example.com', details: 'Needs weekly janitorial', source: 'partner-site' })
});
console.log(res.status, await res.json());
```

Python:

```python
import os, requests
r = requests.post("https://brightclean.net/api/integrations/leads",
                  headers={"X-API-Key": os.environ["BRIGHTCLEAN_KEY"]},
                  json={"name": "Jane Doe", "email": "jane@example.com", "details": "Needs weekly janitorial", "source": "partner-site"})
print(r.status_code, r.json())
```

**Revoke a key:** Settings → Connect other sources → **Revoke**. It stops working immediately. Its leads stay in the system.

Keep keys out of web pages and public code. Put them in the other system's secret settings.

## 2. Public website endpoints (no key)

These are the forms on the website. They are rate-limited and validated.

- `POST /api/bids` — commercial bid request (multipart form, up to 8 files)
- `POST /api/inquiries` — contact message (form fields: `name`, `email`, `message`)
- `POST /api/quotes` — quote request
- `POST /api/careers` — job application
- `GET /api/site/gallery` — the photos and page video shown on the Projects page
- `GET /api/health` — system health (`ok`, `db`, `build`)

## 3. Admin API (owner and staff logins)

The admin uses `/api/admin/...` (about 230 endpoints: customers, leads, proposals, contracts, invoices, schedule, quality, calls, email and website photos). Each request needs a login token:

```
POST /api/admin/login   {"email": "...", "password": "..."}   → {"token": "..."}
GET  /api/admin/leads   Authorization: Bearer <token>
```

Use a dedicated user for each integration rather than the owner's password. Tokens expire, and signing out everywhere invalidates them. Admin logins are rate-limited to 8 attempts per 15 minutes.

For connecting other systems, prefer section 1 (API keys). Admin API access for scripts is not yet offered with its own key; that is a planned next step.

## 4. Webhooks

- **Incoming:** Twilio sends call events, recordings and transcripts to `/api/webhooks/twilio/...`. Requests are checked with Twilio's signature.
- **Outgoing:** not yet available. The system cannot push events to other systems. Planned: outgoing webhooks for new leads and paid invoices, each with a secret for verification.

# Owner actions (needs you, not the build)

Everything below needs a decision, an account, or a secret that only you can provide. The build keeps going around them.
Work through this list at your pace; each item says exactly what to do and what it unblocks.

| # | Action | Why it matters | Unblocks |
|---|---|---|---|
| 1 | Set `OWNER_EMAIL`, `OWNER_PASSWORD`, `BACKUP_KEY`, `BASE_URL` on the Render service (Environment tab) | Required for the platform owner sign-in and encrypted backups | Owner sign-in works; backups can be restored |
| 2 | Create a Postmark account, verify the sending domain (SPF/DKIM/DMARC), set `POSTMARK_TOKEN`, then `EMAIL_MODE=live` | Confirmation, reminder, award and invitation emails are currently logged but not sent | Real email to users |
| 3 | Create the Stripe account, prices and webhook; set the keys | Subscriptions and payment are not charged yet | Paid plans |
| 4 | Decide: block awards below the insurance minimum, or keep the recorded-reason approach (current) | Policy choice | Stricter award control |
| 5 | Confirm the publisher price and the plan prices shown on the website | Pricing is marked "proposed until confirmed" | Public pricing |
| 6 | Provide photos, video and brand assets for the website | Placeholders are in place | Final website visuals |
| 7 | Provide sales, support and phone contacts | Shown on the website and in the app | Real contact routes |
| 8 | Review each data source's terms and approve it (Minneapolis, Seattle, Austin, WA L&I, SAM) | Coverage claims must stay per source | Public data use |
| 9 | Enter the cleaning rate cards (real costs) and approve | Instant cleaning prices use them | Cleaning prices |
| 10 | Legal review (terms, privacy, DPA) and insurance; name a security contact | Required before launch | Launch |
| 11 | Commission an independent penetration test | Required before launch | Launch |
| 12 | Run `rm /webdbg.py /unit-final.txt` in the project folder | Stray files from an earlier session; removal was blocked by a safety check | Clean repo |
| 13 | Confirm the live site works: `/health`, `/`, `/get-started`, `/app`, `/admin` | Cannot be reached from the build sandbox | Launch confirmation |
| 14 | Plan room storage: decide whether to move documents to Cloudflare R2 (needs an account and bucket) | Documents are on the server disk today | Scale and durability |
| 15 | Create the AI provider key if takeoff AI should run live | Takeoff is manual until then | AI takeoff |
| 16 | Review the Super Admin screens on a real phone | Built and checked at phone width in the sandbox only | Visual sign-off |

The build itself is tracked in the commit history and in `docs/PRODUCTION-READINESS-2026-11-10.md`.

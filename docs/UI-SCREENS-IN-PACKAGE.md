# BUILDINTEL UI Screens Included in Source Package

## What is included
- `public/ui-screens/index.html` — a dedicated screen gallery with live previews of the real website pages.
- `/ui-screens` — route that serves the gallery when the application is running.
- `public/site.html` and `public/pages/*.html` — actual page source for the public website.
- `public/site.css`, `public/pages.css`, `public/home.css`, `public/product.css` — shared visual system and page styling.
- Existing `/app` subscriber/publisher workspace and `/admin` Super Admin portal are preserved.

## Public screens in the gallery
Home, Platform Overview, Project Intelligence, Marketplace, Plan Room, Takeoff & Estimating, Bid Management, Service Contractors, Data & Trust, Solutions, Pricing, About, Contact and FAQ.

## How to view
Run the application using the existing project setup, then open:
- `http://localhost:3000/ui-screens` — all page previews in one gallery.
- `http://localhost:3000/` — homepage.
- `http://localhost:3000/pricing` — pricing page.
- `http://localhost:3000/app` — authenticated workspace entry.
- `http://localhost:3000/admin` — Super Admin entry.

The gallery embeds each real page in a preview frame and provides a direct link to open it at full size. It is not a set of fabricated screenshots.

## Verification
- `node --check src/server.js` — PASS.
- `node --test test/website.test.js` — 9 passed, 0 failed.
- ZIP integrity checked after packaging.

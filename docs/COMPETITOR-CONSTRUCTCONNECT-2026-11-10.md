# ConstructConnect (iSqFt, BidClerk, SmartBid): what they do and what BUILDINTEL must do better

Source page: https://www.constructconnect.com/industry-trusted-preconstruction-software (not readable from the build sandbox; findings below come from the sources listed).

## What ConstructConnect offers
- A family of brands: iSqFt and BidClerk (bid management for GCs), SmartBid (bid management and subcontractor prequalification), CMD, Reed and Construction Journal, and Project Intelligence (project leads).
- Bid management: invite bidders, track subcontractor responses, manage ITBs. Source: https://www.constructconnect.com/products/smartbid ; https://www.trustradius.com/products/constructconnect-bid-management/reviews
- Prequalification: online prequalification forms (including ConsensusDocs 721 and a custom form builder) and a public registry of subcontractors to grow a sub list. Source: https://toolradar.com/compare/constructconnect-vs-smartbid
- Network scale: a competitor claims 100,000+ bidders nationwide. Treat as unverified marketing. Source: https://downtobid.com/blog/is-constructconnect-worth-it

## Pricing (aggregators disagree; confirm with the vendor)
- Project Intelligence reported at $129/month per market (Starter), $199/month per market per seat (Professional), about $10,000/year (Premium). Annual contracts; price grows with markets and seats. Source: https://pricingsaas.com/companies/constructconnect.page2/diffs/2026W41
- iSqFt bid management: $3,600 to $4,500 per year, custom quotes. Source: https://downtobid.com/blog/is-isqft-worth-it ; https://www.capterra.com/p/3498/iSqFt-for-General-Contractors/

## Ratings and complaints
- Ratings: ConstructConnect 4.5/5 from 194 reviews; SmartBid 4.4/5 from 92 reviews. Source: https://toolradar.com/tools/constructconnect/pricing ; https://www.g2.com/products/isqft/pricing
- Complaints: subcontractor data goes stale (companies closed or no longer bidding); subcontractors must create a login to respond; profiles outdated. Sources: https://www.capterra.com/p/184678/SmartBid/reviews/ ; https://downtobid.com/blog/is-constructconnect-worth-it (competitor view)

## What BUILDINTEL already does better
- Permit-level project intelligence with the official record link and a freshness date on every record. Coverage stated per city, not claimed nationally.
- Role-based sign-up (GC/GM, owner, subcontractor, service provider) with invitations matched on trade keys from the first login.
- AI takeoff stays unverified until a person confirms it; unprinted quantities are never invented.
- Plan room access limited to invited bidders with 10-minute links; addenda must be acknowledged before bidding.
- Bid leveling side by side, awards with e-signature and a contract record.
- Pricing shown as flat plans by territory on the website (proposed until confirmed).

## What we must do better (ranked)
1. **Bid without a full account.** Competitors make subcontractors log in. Build an emailed, time-limited bid link: one click, verify email, submit a bid; create the account later if they want to keep it. Largest friction gap.
2. **Keep subcontractor data fresh.** Show "last verified" on every company; ask each invited company to confirm availability and trades before bid day; flag companies with no activity in 12 months.
3. **Prequalification without copying a licensed form.** Build our own prequalification questionnaire (insurance, licences, safety record, references, bonding, capacity) with the answers stored and dated; do not reproduce ConsensusDocs 721 text.
4. **Subcontractor directory from public records.** Grow the list from city permit contractor records (already ingested), show license status where a register is connected, and let companies claim their profile.
5. **Mobile bid submission.** Subs bid from phones on site; the bid form must work well at phone width (partly done).
6. **Pricing clarity.** Competitors price per market and per seat with annual contracts. Our plans should state the territory and user limits in one table, monthly, no annual lock-in in the trial (this is already the trial model); confirm final prices before any charge.

## Status
- Item 1 is built: each invitation email now carries a signed bid link (`/bid/<token>`). The link names one invitation, expires two days after bids are due, and lets the company see that request and send one bid (revisable) without signing in. Addenda must be acknowledged in the app first. Code: `src/bidlink.js`, `public/bid.html`, `public/bid.js`; tests: `test/bidlink.test.js`.
- Still to do: a 'copy bid link' button in the app's invitations list (the API route `/api/invitations/:id/bid-link` already exists), and a short sign-in-free check that the link works on phones.

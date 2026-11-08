# Competitive research: construction bid platforms (2026-11-08)

Question: where can BUILDINTEL be clearly better than the established bid platforms, and easier to use?
Method: web research on vendor pages, comparison sites, and user review sites. Pricing and review figures
conflict across sources, and many sources are competitors. Treat every number as indicative, and get written
quotes before relying on any of them.

## What the market looks like
- **ConstructConnect** (includes iSqFt and BidClerk, which are now part of it): the broadest data set and
  takeoffs, aimed at larger GCs. Pricing is not published. Reviews are split: one source reports 30%
  satisfaction from 10 reviews, mainly for a clunky interface and high cost. Public complaints also focus on
  contract rigidity and cancellation friction.
  Sources: [ConstructConnect vs PlanHub](https://www.constructconnect.com/resources/constructconnect-vs-planhub),
  [SelectHub, ConstructConnect](https://www.selecthub.com/construction-bidding-software/constructconnect/).
- **BuildingConnected** (Autodesk): the largest subcontractor network and strong prequalification. Quote-only
  pricing; a competitor estimates about $3,600 per year. Subcontractors report that they must create an account to
  see plans, get bid invitations that don't fit them, and sometimes bid directly by email instead.
  Sources: [BuildingConnected reviews](https://downtobid.com/blog/building-connected-reviews),
  [BuildingConnected Capterra](https://www.capterra.com/software/156791/buildingconnected).
- **PlanHub**: the best usability reputation (Capterra ease-of-use 4.4). Published subcontractor tiers by service
  radius, reported around $2,000 to $3,300 per year. Complaints: "excessive and ineffective emailing" and weak
  file labelling.
  Sources: [PlanHub Capterra](https://www.capterra.com/p/179042/PlanHub/reviews/),
  [PlanHub vs BuildingConnected](https://constructionbids.ai/resources/planhub-vs-buildingconnected).
- **iSqFt / BidClerk** (ConstructConnect): no published prices. iSqFt's G2 rating is 3.9 of 5 from 19 reviews.
  Sources: [iSqFt on Capterra](https://www.capterra.com/p/3498/iSqFt-for-General-Contractors/),
  [iSqFt on G2](https://www.g2.com/products/isqft/pricing).

## Where we can be clearly better
1. **Published, transparent pricing.** Every major competitor is quote-only or inconsistent. Our plan catalog is
   public at `/api/plans`, with prices marked as proposed until the owner confirms them.
2. **Fewer, relevant invitations.** Matching is by trade and territory, and every match states its reasons.
   Complaints about irrelevant invitations are the most common subcontractor complaint.
3. **Control over email volume.** Competitors' users complain about email overload. Companies now choose
   immediate or daily-digest invitation email, with a daily cap (see below). Invitations still appear in the app
   at once.
4. **Automatic pricing for cleaning contractors.** No listed competitor prices a bid automatically from the
   company's own rate cards and routes only the exceptions to a person. Our autopilot does, and it never sends a
   bid without a verified recipient and a provider receipt.
5. **Honest status.** A bid is "sent" only with a provider receipt. Competitors' notification failures are a
   recurring complaint, so we show delivery state rather than assuming it.

## Where competitors are ahead (honest gaps)
- Data scale: ConstructConnect and BuildingConnected have national bid networks. We have city-level open data
  and only the sources the owner has authorised.
- Takeoff and estimating tools at scale, and their integrations with estimating software.
- Brand, reviews, and a sales team.
- Project Q&A and addenda workflows in bidder-facing screens (planned in the v5 roadmap).

## What this build adds
- Company owners choose their invitation email mode (`immediate` or `daily_digest`) and a daily cap (1 to 20).
  Endpoints: `GET` and `PUT /api/me/notifications`. Owner only, audited, validated.
- Tests: `test/notifications.test.js` covers the batching rules, the cap, and the settings API.

## Next usability work (not yet built)
- A one-click notification setting in the subscriber's own screens (currently API only).
- Invitation screen: show "why you were invited" beside each invitation.
- Plain-language plan comparison on the sign-up page.

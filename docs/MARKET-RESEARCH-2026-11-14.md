# Market research: who BUILDINTEL serves, what they buy, and where we win

Date: 2026-11-14. Method: web search of vendor pages, comparison sites, review sites and two industry surveys (Riffle, Billd), with the limits noted in each section. Most sources are vendor-written; numbers are directional and must be confirmed with vendors before anyone relies on them.

## 1. Bottom line

- **The product is the right shape.** The market is split: large platforms (Procore, Autodesk, BuildingConnected) for the whole project, and bid-distribution tools (ConstructConnect/iSqFt/SmartBid, PlanHub) for finding and inviting bidders. Almost nobody combines a verified publisher, bidder matching, plan access control, leveling, an e-signed award and an invitation-to-contract record in one place for mid-size work. That is our opening.
- **We are not yet competitive on network size.** BuildingConnected reports over a million contractor profiles. We have only the companies that sign up. Without a bidder network, the platform is only as good as the companies a publisher can reach. This is the single largest business risk and it cannot be coded away.
- **Pricing is quote-based across the market.** Published per-user prices are unreliable; most vendors route buyers to sales. Our public pricing should be stated as proposed until we have real quotes.
- **We cover the GC/owner side of bidding well; we do not yet cover the site manager's day.** Daily logs, field reporting, photos and safety are what superintendents and site managers use daily. Those features are not built.

## 2. Who uses the system, and what each one needs

| Role | Daily job | What they buy software for | Where BUILDINTEL is strong | Where we are missing |
|---|---|---|---|---|
| Subcontractor (estimator, owner, PM) | Find work, decide what to bid, estimate, submit | Fewer wasted estimates; know who else was invited; get paid | Invitations matched on trade and area; "why you were invited"; bid without an account; addenda gate; insurance minimum shown before bidding | No certificate upload from the bid itself; no pay-history signal; no estimating tools beyond takeoff |
| General contractor / GM / preconstruction | Post packages, compare bids, award, manage subs | Leveling, bidder coverage, award and contract record, sub compliance | Coverage view, breadth panel and reminders, leveling with scope and revisions, insurance check, e-signed award, countersignature, CSV export | Network size; compliance tracking over time (COI expiry alerts exist, full compliance workflow does not) |
| Owner / developer / owner's rep | Publish projects, control cost, keep records | Project record, documented bidding, auditability | Verified publisher, permanent project record, authority recorded, audit trail, amendments with signatures | Capital-project budget and cost tracking; owner reporting dashboards |
| Project manager / site manager / superintendent | Daily logs, RFIs, schedule, safety, field photos | Field tools on a phone | RFIs and questions within bidding; phone-width layouts checked | Daily logs, photo logs, safety forms, punch lists, field mobile app: **not built** |
| Super Admin (BUILDINTEL staff) | Verify publishers, handle support, monitor | Operational control | Verification with documents and history; audit log; admin dashboard that says what it cannot measure | Support ticketing exists in a basic form; billing reconciliation blocked on Stripe |

## 3. Competitor landscape (2026)

| Product | Strength (per sources) | Weakness (per sources) | Pricing (as reported) |
|---|---|---|---|
| BuildingConnected (Autodesk) | Largest network (reported over 1M profiles); invites, addenda and files in one place; bid leveling called strong | Reviews described as split; subcontractor complaints not separated in sources | Quote-based; third-party figures from $299/mo (one user) to $6,900–$22,200/yr; free profile tier; 30-day money-back guarantee (vendor claim) |
| Procore Bid Management | Fits teams already on Procore; broad project suite | Leveling described as basic or manual; expensive for small teams | Not published; estimates from $550/mo add-on to $500–2,000+/mo suite |
| ConstructConnect (incl. iSqFt, SmartBid) | Bid distribution and takeoff | Limited leveling per one source; Trustpilot very low with few reviews | Estimates from about $15,000/yr; SmartBid from roughly $250–450/mo |
| PlanHub | Free GC tier for posting and basic leveling; plan room; cheapest entry | Leveling basic; sub pricing by service radius, inconsistent across sources | Sub plans by radius: from $1,999/yr to $1,999–3,299/mo (sources conflict) |
| Pursuit | Publishes per-user prices | Estimating-focused | $47 or $79 per user per month (vendor page) |
| Billy / myCOI / CertFocus | Certificate-of-insurance tracking and prequalification | Separate tool from bidding | Custom; entry COI software about $800–2,000/yr; $10–30 per insured per year for full compliance (vendor estimates) |

Sources: [BuildingConnected pricing overview](https://constructionbids.ai/blog/buildingconnected-pricing-2026), [BuildingConnected on Capterra](https://www.capterra.com/p/156791/BuildingConnected/reviews/), [BuildingConnected vs PlanHub on SelectHub](https://www.selecthub.com/construction-bidding-software/buildingconnected-vs-planhub/), [PlanHub pricing on PricingSaaS](https://pricingsaas.com/companies/planhub), [PlanHub on Capterra](https://www.capterra.com/p/179042/PlanHub/), [Procore pricing guide (OneCrew)](https://www.getonecrew.com/post/procore-pricing), [Procore pricing analysis (Projul)](https://projul.com/blog/procore-pricing-analysis-2026/), [Bid management comparison (Struvia)](https://struvia.co/blog/construction-bid-management-software), [Billy vs myCOI](https://billyforinsurance.com/resources/billy-vs-mycoi-2026-which-is-better-for-construction/), [COI software pricing (Vertikal RMS)](https://vertikalrms.com/article/how-much-does-coi-tracking-software-cost-2025-pricing-guide/), [Pursuit / estimator pricing (Vertigraph)](https://www.vertigraph.com/vs/procore-crm-alternative).

Confidence: BuildingConnected's network size and the general shape of each product are consistent across sources. Specific prices and "basic leveling" claims conflict between sources and must be checked with vendors.

## 4. Subcontractor pain (the side we most need to win)

- **Too many invitations, no way to tell which are worth it.** Riffle's 2025 subcontractor survey reported that no team, large or small, feels it has a true handle on its bids. Subs spend estimating time on jobs they should pass on.
- **Bid shopping and thin information.** A 2026 subcontractor guide describes GCs using a sub's price against rivals, and subs bidding on incomplete scope.
- **Slow payment drives bid decisions.** Billd's 2025 national subcontractor report says slow pay is still the top challenge, with an average wait of about 54 days after a pay application.
- **Estimate accuracy.** Riffle's survey of GCs says subs missed their original estimate on 10–25% of bids for more than half of respondents.

What this means for us: a sub-friendly product should show **which packages fit (trade, area, insurance)** before the sub spends time, show **how wide the bidding is** (we added this: the invitation now says how many companies were invited), keep **scope and exclusions** visible and comparable, and avoid making the sub create an account to bid (we have the bid-without-login link). We do not yet give subs a pay-history or GC reputation signal; that needs data we do not have.

Sources: [Riffle subcontractor bid-management guide](https://myworkbids.com/blog/subcontractors-guide-to-bid-management), [Riffle: GCs on subcontractors](https://rifflecm.com/resources/what-general-contractors-really-think-about-subs-new-data-on-accuracy-pricing-tech-and-trust), [Riffle: bids per week](https://rifflecm.com/resources/how-many-bids-per-week-do-subcontractors-submit), [Billd 2025 national subcontractor market report](https://billd.com/resources/2025-market-report/), [Construction Executive: the 5% problem](https://constructionexec.com/article/the-5-problem-what-separates-winning-bidders-from-everyone-else/).

Limit: the subcontractor-specific data above comes from two vendors (Riffle, Billd) with commercial interests. No independent 2025–2026 study isolated sub bidding pain. Treat the percentages as directional.

## 5. Site managers and superintendents (the gap)

- Daily reporting is the most-cited superintendent burden; vendors describe it as eating evenings. Field tools that adopt well have daily reports, progress logs and photos on a phone (DroneDeploy and Fieldwire guidance, both vendor-authored).
- Leading field tools: Raken, Procore, Fieldwire, Buildertrend, HCSS Field, Constructable.
- No independent 2026 adoption survey was found. The AGC and ENR would be the neutral sources to check next.

Implication: we should not try to out-build Procore on field tools. We should **integrate** with one (or export CSV/API), and build only the bid-to-field handoff (award → contract → a project record the field team can open). That is a deliberate scope decision, not a gap we must close before launch.

Sources: [Fieldwire on daily reporting](https://www.fieldwire.com/blog/construction-forms-daily-reports/), [DroneDeploy on manual reports](https://dronedeploy.com/blog/the-hidden-cost-of-manual-construction-reports-and-how-software-closes-the-gap), [Construction report software roundup (Fanruan)](https://fanruan.com/en/blog/best-construction-report-software).

## 6. Insurance and compliance (table stakes for GCs)

- Certificate-of-insurance tracking is a standard GC requirement; the leading tools (Billy, myCOI, CertFocus) are separate products that integrate with Procore and Autodesk. Pricing is per insured (vendor estimates $10–30/yr for full compliance).
- BUILDINTEL already checks general liability and workers comp against each package's minimum, flags expired certificates, and makes a shortfall an explicit award decision with a recorded reason. That is more than most bid platforms do, and it is free of an extra product.
- What is missing: expiry reminders to subcontractors before a certificate lapses across all projects, and holder/additional-insured verification. Both are buildable.

Sources: [Billy: COI tracking for GCs](https://billyforinsurance.com/coi-tracking-software-for-general-contractors/), [Billy vs myCOI](https://billyforinsurance.com/resources/billy-vs-mycoi-2026-which-is-better-for-construction/), [Vertikal RMS: COI pricing](https://vertikalrms.com/article/how-much-does-coi-tracking-software-cost-2025-pricing-guide/).

## 7. Owners, developers and owner's reps

- Owner-side tooling is fewer and budget-focused (Mastt for owner-side financial control). One owner's-rep guide notes that the platform only delivers value when every party uses it. This is an adoption problem as much as a feature problem.
- Our advantage for owners: a permanent project record, a verified publisher with recorded authority, and an audit trail of every change, bid and signature. Owners can prove how a bid was run. Competitors make that harder to show.
- Gap: cost tracking against the budget and owner reporting. Not built.

Sources: [Mastt: owner-side construction budget software](https://www.mastt.com/software/project-management-construction-budget-software), [Construction management software roundup (Kahua)](https://resources.kahua.com/blog/best-construction-management-software).

## 8. Where we win, and why an owner, PM, site manager or GM should choose us

**For a GC or GM (bid and award):** one place to post a package, see exactly who was invited and who answered, compare bids with scope, exclusions and revisions side by side, check insurance against the package minimum before awarding, award with a signed record, and export the comparison to a spreadsheet. Ask: which of these does your current platform do without a manual step?

**For an owner or developer:** a verified publisher, a permanent project record, documented authority, every change and award in an audit trail, and amendments that need the contractor's signature. Ask: can you prove, a year later, how the work was bid and to whom it was awarded?

**For a subcontractor:** invitations that say why you were invited, how many others were invited, what insurance is required before you bid, and whether the package fits your trade and area. You can bid without creating an account. Ask: do you know which of your invitations is worth the estimating time?

**For a site manager or superintendent:** honest answer today: we do not yet replace your daily tools. We hand the awarded scope and contract to the field, and we should integrate with a field platform rather than compete with it.

**For BUILDINTEL's own staff:** every verification decision, document view and privileged action is recorded, and the admin dashboard states plainly which numbers cannot be measured yet.

## 9. What must be true before we launch to the market

1. **A bidder network** large enough that a publisher's invitations reach real companies in target areas. Plan for this with partnerships and supply-side outreach; it is not a software feature.
2. **Confirmed pricing** from real quotes (not the estimates above), and published as "proposed until confirmed" until then.
3. **A decision on the field tools:** integrate (recommended) or build. Integration needs a partner agreement or public API access; check each vendor's terms.
4. **Payments and email live** (Stripe and Postmark) and the legal documents (terms, privacy, DPA) reviewed by counsel.
5. **Customer proof:** two or three pilot GCs running a real bid end to end, with their feedback recorded.

## 10. Open questions for you

- Which field platform do your target GCs already use? That decides integration first.
- Do you want to charge subcontractors at all (PlanHub's model), or only publishers (BuildingConnected's model)?
- What is the first geography? Network effects are local.

## Source list

- [BuildingConnected pricing 2026 (constructionbids.ai)](https://constructionbids.ai/blog/buildingconnected-pricing-2026)
- [BuildingConnected on Capterra](https://www.capterra.com/p/156791/BuildingConnected/reviews/)
- [BuildingConnected alternatives (MeltPlan)](https://www.meltplan.com/blogs/buildingconnected-alternatives-what-gc-precon-teams-are-actually-switching-to-in-2026.md)
- [PlanHub on Capterra](https://www.capterra.com/p/179042/PlanHub/)
- [PlanHub pricing (PricingSaaS)](https://pricingsaas.com/companies/planhub)
- [ConstructConnect vs PlanHub](https://www.constructconnect.com/resources/constructconnect-vs-planhub)
- [Best construction bid software 2026 (BuildVision)](https://www.buildvisionai.com/best-construction-bidding-software)
- [Best construction bid management software (Struvia)](https://struvia.co/blog/construction-bid-management-software)
- [Procore pricing (OneCrew)](https://www.getonecrew.com/post/procore-pricing)
- [Procore pricing analysis 2026 (Projul)](https://projul.com/blog/procore-pricing-analysis-2026/)
- [Pursuit / estimator pricing (Vertigraph)](https://www.vertigraph.com/vs/procore-crm-alternative)
- [Subcontractor bid-management guide (Riffle / MyWorkBids)](https://myworkbids.com/blog/subcontractors-guide-to-bid-management)
- [What GCs think about subs (Riffle)](https://rifflecm.com/resources/what-general-contractors-really-think-about-subs-new-data-on-accuracy-pricing-tech-and-trust)
- [How many bids per week (Riffle)](https://rifflecm.com/resources/how-many-bids-per-week-do-subcontractors-submit)
- [2025 National Subcontractor Market Report (Billd)](https://billd.com/resources/2025-market-report/)
- [Billy vs myCOI 2026](https://billyforinsurance.com/resources/billy-vs-mycoi-2026-which-is-better-for-construction/)
- [COI tracking for GCs (Billy)](https://billyforinsurance.com/coi-tracking-software-for-general-contractors/)
- [COI pricing guide (Vertikal RMS)](https://vertikalrms.com/article/how-much-does-coi-tracking-software-cost-2025-pricing-guide/)
- [Daily reporting (Fieldwire)](https://www.fieldwire.com/blog/construction-forms-daily-reports/)
- [Manual reports cost (DroneDeploy)](https://dronedeploy.com/blog/the-hidden-cost-of-manual-construction-reports-and-how-software-closes-the-gap)
- [Owner-side budget software (Mastt)](https://www.mastt.com/software/project-management-construction-budget-software)
- [Construction management software guide (Kahua)](https://resources.kahua.com/blog/best-construction-management-software)
- [Constructions next chapter (Commerce Bank)](https://www.commercebank.com/business/trends-and-insights/2026/constructions-next-chapter-challenges-demand-and-opportunity)

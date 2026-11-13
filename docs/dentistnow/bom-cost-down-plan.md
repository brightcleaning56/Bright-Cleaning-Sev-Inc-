# Bill of materials cost-down plan

Goal: bring the estimated hardware bill of materials from about $109,300 to $85,000 or less, the viability ceiling in the financial model. Target for the base case is $60,000.

Status: planning. Component prices come from the 40-page image set and are estimates, not quotations. The line items in that set do not add up to its stated total, so every line must be re-quoted before this plan is used.

## 1. Current estimate (from the image set)

| Line | Component | Qty | Estimate (USD) |
|---|---|---|---|
| 1 | Patient chair (motorized) | 1 | 12,000 |
| 2 | Robotic arms (6-axis, precision) | 2–4 | 24,000 |
| 3 | 3D intraoral scanner | 1 | 8,500 |
| 4 | Intraoral cameras (4K) | 4 | 2,800 |
| 5 | Digital X-ray module | 1 | 18,000 |
| 6 | Tool magazine and consumables | 1 | 3,800 |
| 7 | Fluid, suction and filtration | 1 | 5,200 |
| 8 | Sterilization, UV and thermal | 1 | 6,800 |
| 9 | Control and AI computing | 1 | (not clear in source) |
| 10 | Control and AI systems | 1 | (not clear in source) |
| 11 | Enclosure, housing and LEDs | 1 | 7,500 |
| 12 | Software (UI, AI, EHR integration) | 1 | 10,000 |
| | Stated total | | 109,300 |

The lines with values sum to about $106,600, so the source is missing about $2,700, or the values are approximate. Re-quote every line.

## 2. Candidate reductions (for engineering review)

| Action | Estimated saving | Reason | Risk |
|---|---|---|---|
| Move the digital X-ray module out of the version 1 bill of materials (offer it as a clinician-ordered option through a partner) | up to 18,000 | Radiography is clinician-directed and optional in our design, so it does not need to be in every unit | Partner or service model must be agreed; regulatory review of the option |
| Reduce robotic arms from 4 to 2 if the workspace study allows | up to 12,000 (estimate) | Fewer arms, fewer drives and sensors | Needs the reach study in binder sheet 11; may limit access |
| Source the chair from a medical-chair manufacturer and add only the motion module | 2,000–5,000 (estimate) | Avoid full custom chair | Ergonomics and certification of the donor chair |
| Reduce intraoral cameras from 4 to 2 where coverage allows | 800–1,400 | Coverage check in binder sheet 14 | Imaging coverage must still meet the requirement |
| Consolidate the control computing and the AI computing | 1,000–3,000 (estimate) | One industrial computer for both | Safety separation must remain: safety controller stays independent |
| Re-quote software and integration | to be determined | $10,000 is a planning value; an in-house build may be cheaper | Development cost moves into the R&D budget |

## 3. Check against the target

| Step | Running total (estimate) |
|---|---|
| Stated total | 109,300 |
| Remove X-ray from version 1 | 91,300 |
| Arms 4 to 2 (if feasible) | 79,300 |
| Other reductions (chair, cameras, computing) | 73,000 to 77,000 |

On these estimates the $85,000 ceiling is reachable only if the X-ray module is removed from version 1 and at least one of the other reductions is confirmed. Without the X-ray removal, the arm reduction alone would not reach the ceiling.

## 4. Decisions and owners

- **Owner:** Product Director, with the mechanical and robotics leads.
- **Decision 1:** remove the X-ray module from version 1 and offer it as an option.
- **Decision 2:** confirm the arm count from the workspace study.
- **Gate:** no Stage C commitment until a re-quoted bill of materials is at or below $85,000.
- **Financial model:** re-run the unit-cost sheet with the re-quoted figure.

## 5. Notes

- The safety controller stays independent of the computing platform, whatever is consolidated.
- Removing a component changes the regulatory file and the risk analysis. Record each change as a design change.

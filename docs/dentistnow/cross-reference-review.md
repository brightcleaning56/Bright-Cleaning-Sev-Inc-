# Cross-reference review — documents vs. everything provided

Date: 2026-11-13. Scope: the planning brief, the automation and funding decisions, the image sets (the 40-page and 49-month materials, the marketing image), the interface screens, and the research on autonomy and supervision.

Status key: **Aligned** = consistent. **Fixed** = corrected today. **Decision** = conflict that needs your decision. **Do not use** = claim to keep out of public materials.

## 1. Automation level and oversight

| Item | Source | Status | Notes |
|---|---|---|---|
| Version 1 uses professional oversight; greater autonomy later (option C) | Planning brief, automation decision | Aligned | Plan, deck and landing page all state it. |
| AI proposes; it cannot command the instruments | Brief, safety requirements | Aligned | Binder, deck, UI prototype. |
| Stops when uncertain; patient can stop at any time | Brief, safety requirements | Aligned | Eligibility gate, cleaning monitor, FAQ. |
| "Unattended" in the funding plan (regulatory and care-rejection risks) | Our documents | **Fixed** | Reworded to "automated cleaning under clinician oversight". |
| "Unattended" and "autonomous" in the counsel brief (question 12) | Our documents | Aligned | Asks counsel to review that language. |
| "Do not promise a finished autonomous machine" | Plan | Aligned | Describes future work, not version 1. |
| Original goal: a patient gets cleaned "without a dentist or dental assistant" | Your first brief | **Decision** | Conflicts with supervised version 1. Research found no authorized unsupervised dental treatment in the US. Choose: keep supervised v1 and aim at unsupervised later (recommended), or change the goal. |
| "No Dentist Needed", "Fully Automated Teeth Cleaning", "AI-Powered Autonomous … Diagnosis & Cleaning" | Marketing image (sent today) | **Do not use** | Conflicts with the design and with the research. |

## 2. Claims and diagnosis

| Item | Source | Status | Notes |
|---|---|---|---|
| Findings labelled Observed, Suspected, Not assessable; no diagnosis | Brief, UI, binder | Aligned | |
| "Oral Health Score 86/100" and "Safe, Comfortable & Fast (≈15–30 min)" | Your image sets | **Do not use** | Score is unvalidated. Time is unsupported. |
| "Diagnosis" in the product name and image text | Marketing image | **Do not use** | The machine does not diagnose. |

## 3. Costs and financial figures

| Item | Source | Status | Notes |
|---|---|---|---|
| Unit production cost $45K–$85K | Your brief | Aligned | Model base is $60K. |
| BOM total about $109,300 | 40-page image set | **Decision** | Above the $45K–$85K range and the model base. The BOM is an estimate, so either the cost range moves up or the BOM is revised. The model should be re-run if the cost changes. |
| Selling price $95K–$160K; target gross margin 40–55% | Your image and brief | Aligned | Model base 49%. |
| Development budget $3.5M–$9.5M; Stage A $150K–$300K; Stage B $750K–$1.8M | Your brief | Aligned | Stage A breakdown sums to the range. |
| Pilot of 10 units, $1.2M–$2.5M | Image set | Not in our plan | Could be added to the roadmap. |

## 4. Timeline

| Item | Source | Status | Notes |
|---|---|---|---|
| 36–48 month planning schedule | Your brief | Aligned | Plan uses 40–48+ months. |
| 49-month roadmap | Image set | **Decision** | One month longer than our plan. Choose one figure and use it in every document. |

## 5. Regulatory

| Item | Source | Status | Notes |
|---|---|---|---|
| Q-Submission before major spending | Brief | Aligned | |
| 510(k) or De Novo pathway | Image set | Aligned in principle | Final pathway depends on the FDA's view of autonomy. Add autonomy to the Q-Submission questions. |
| FDA cybersecurity guidance 2026 | Image set and brief | Aligned | Counsel brief and plan both mention cybersecurity. |
| No clearance of autonomous robots found | Research today | Aligned | Landing page says not cleared. |

## 6. Interface and screens

| Item | Source | Status | Notes |
|---|---|---|---|
| Patient "Start Cleaning" button | 40-page UI image set | **Decision** | In that set the patient starts the cleaning. Our prototype requires clinician authorization first. Use the prototype rule unless you choose otherwise. |
| Operator dashboard, authorization gate, safety monitor, audit log | Brief and UI | Aligned | |
| Simulated data labelled | Prototype | Aligned | |

## Decisions needed from you

1. Keep the original goal of "no dentist" for later versions only (recommended), or change the goal now?
2. Which unit cost to use: $45K–$85K or the $109,300 BOM. The second needs a re-run of the model.
3. Which timeline to use: 48 or 49 months.
4. Confirm that the patient cannot start cleaning without clinician authorization.

# Risk register — Stage A demonstrator and version 1 concept

Method: each hazard is linked to its cause, harm, initial risk, control, residual risk and the test that verifies the control. Ratings are qualitative (low, medium, high) and must be re-rated with the regulatory specialist under ISO 14971 before any clinical use. Demonstrator work uses dental models and fixtures only.

| ID | Hazard | Cause | Possible harm | Initial | Control | Residual | Verified by |
|---|---|---|---|---|---|---|---|
| R-01 | Unintended arm motion | Software fault, wrong command | Soft-tissue injury, instrument into airway | High | Independent safety controller; motion only inside limits; e-stop removes power | Medium until tested | POS-05, ESTOP-01, ESTOP-06 |
| R-02 | Excess force on soft tissue | Position error, stuck command | Gum or lip injury | High | Force sensing; force limit in hardware path; stop on exceed | Medium | FRC-01, FRC-02, CLN-03 |
| R-03 | Collision with patient or fixture | Head movement, sensor miss | Injury, damage | High | Proximity and force sensing; collision stop; retraction | Medium | FRC-03, SCN-05 |
| R-04 | Patient head moves during run | Patient movement, chair slip | Instrument contact with wrong surface | High | Head-movement monitoring; pause or stop on movement; head support | Medium | SCN-05, ESTOP-03 |
| R-05 | Emergency stop does not work | Relay or wiring fault | Uncontrolled motion | High | Hardware e-stop chain, tested routinely; watchdog | Low after test | ESTOP-01, ESTOP-04 |
| R-06 | Loss of communication during run | Network or computer failure | Motion without supervision | High | Safe state on communication loss; local safety | Low after test | ESTOP-05, SW-05 |
| R-07 | Camera visibility lost | Obstruction, camera fault | Blind motion | High | Stop on visibility loss; no resume without review | Low after test | SCN-05 |
| R-08 | Wrong or unauthorized cleaning | Software gate bypass | Treatment without clearance | High | Clinician authorization gate; logged attempts | Low after test | SW-01, SW-02, SW-03 |
| R-09 | Missed finding (AI false negative) | Poor image, model limit | Delayed care | High | Quality gate marks "not assessable"; clinician review of all findings | Medium | SCN-04, SW-01 |
| R-10 | Over-reliance on AI output | Operator trust | Wrong decision | Medium | Labels Observed, Suspected, Not assessable; clinician confirms | Medium | UI review, training |
| R-11 | Instrument ingested or dropped | Tool detachment | Aspiration | High | Tool-attachment lock sensing; tool identity check | Medium | TL-01 |
| R-12 | Fluid leak or flooding | Seal failure, hose fault | Electrical hazard, contamination | Medium | Leak sensors; stop on leak | Low after test | CLN-04 |
| R-13 | Cross-contamination between patients | Instrument not reprocessed | Infection | High | Clean and used pathways; cycle records; release status | Medium | RPR-01 |
| R-14 | Non-validated sterilization | Cycle failure or unvalidated process | Infection | High | Validated sterilizer interface; no release without cycle record | Medium | Validation study (Stage B) |
| R-15 | Electrical shock | Insulation or grounding fault | Patient or operator injury | High | Medical electrical design, isolation, leakage testing | Low after test | IEC 60601 tests (Stage B) |
| R-16 | Thermal burn from instruments or electronics | Overheat | Burn | Medium | Temperature sensing; thermal limits | Low after test | TMP-01 |
| R-17 | Power loss mid-run | Mains failure | Uncontrolled stop or resume | Medium | UPS; safe state; no automatic resume | Low after test | ESTOP-06, PWR-01 |
| R-18 | Data breach | Weak access control | Patient privacy harm | High | Access control, encryption, audit | Medium | SEC-01 (full testing in Stage B) |
| R-19 | Software update changes behaviour | Unvalidated change | Unexpected operation | High | Change control; re-test on each release | Medium | REG-01 |
| R-20 | Simulated data mistaken for real | Demonstration screens | Wrong decisions | Medium | Simulated labels on each screen | Low | SW-04 |

## Open actions
- All tests in the register are defined in the engineering test plan (section 9 added).
- The regulatory specialist re-rates every entry under ISO 14971 and records the acceptance criteria.
- Review this register at each stage gate.

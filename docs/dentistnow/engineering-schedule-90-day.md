# 90-day engineering schedule — Stage A feasibility demonstrator

Planning schedule. Each week ends with a check; a gate at day 90 decides whether Stage B starts. Owners are roles; names to be added when people are engaged. Dependencies on quotes, advisers and owner decisions are marked.

## Principles
- No gate is skipped to save time.
- The safety controller is built and tested before any motion is commanded.
- No patient, no human subjects. Dental models and instrumented fixtures only.

## Weeks 1–4: define and design
| Week | Work | Owner | Output | Depends on |
|---|---|---|---|---|
| 1 | Freeze the product requirements and intended use draft | Product Director | Requirements v1 | Owner: entity formed (item 1) |
| 1 | Set up version control for CAD, firmware and software | Software lead | Repository and review rules | — |
| 2 | Chair and arm configuration: reach study on dental-model workspace | Mechanical, robotics | Workspace study (binder sheet 11) | Requirements v1 |
| 2 | Safety architecture document: independent controller, e-stop, watchdog | Electrical, safety | Safety architecture v1 | Requirements v1 |
| 3 | Preliminary bill of materials and quotes out | Product Director | Quote request sent | Owner item 10 |
| 3 | Demonstrator design: arm on fixture, camera and scanner mounts | Mechanical | Concept CAD | Workspace study |
| 4 | Clinical workflow and eligibility rules in software (simulated data) | Software, clinical advisor | Workflow v1 | Owner item 14 (advisor) |
| 4 | Gate 1: requirements, safety architecture and workspace approved | Product Director, regulatory specialist | Gate record | Weeks 1–3 |

## Weeks 5–8: prove the technology
| Week | Work | Owner | Output | Depends on |
|---|---|---|---|---|
| 5 | Order demonstrator parts from quotes | Product Director | Purchase orders | Quotes received; owner item 3 (bank account) |
| 5 | Scan test: 3D scanner on dental models; accuracy against reference | Software, AI | Scan accuracy report | Scanner available |
| 6 | Positioning test: arm repeatability on the fixture | Robotics | Repeatability report | Arm delivered |
| 6 | Force measurement: sensor calibration and limit test | Electrical, robotics | Force-limit test report | Sensor installed |
| 7 | Emergency stop test: time from trigger to motion stop and retraction | Electrical, safety | E-stop test report | Safety circuit built |
| 7 | Eligibility rules run on test cases (simulated) | Software, clinical advisor | Rule test log | Workflow v1 |
| 8 | Gate 2: scan accuracy, repeatability, force limit and e-stop meet targets | Product Director, regulatory specialist | Gate record | Weeks 5–7 |

## Weeks 9–12: build and demonstrate
| Week | Work | Owner | Output | Depends on |
|---|---|---|---|---|
| 9 | Integrate scanner, arm and safety controller on the fixture | Integration team | Integrated test rig | Gate 2 passed |
| 9 | Operator dashboard connected to the rig (live data from the rig) | Software | Dashboard on rig | Integration |
| 10 | Controlled movement demonstration on dental models | Robotics | Demonstration log | Integration |
| 10 | Emergency stop demonstration under operator control | Electrical, safety | Demonstration log | Integration |
| 11 | Cleaning concept test on models: polishing head only, no patient | Mechanical, clinical advisor | Cleaning test notes | Cleaning head sourced |
| 11 | Engineering results report draft | Product Director | Report draft | Weeks 9–11 |
| 12 | Gate 3 (Stage A complete): demonstrator results reviewed; decision on Stage B | Product Director, regulatory specialist, advisers | Gate record and Stage B recommendation | Report |

## Risks to watch
- Quotes arrive above the cost ceiling. Trigger: any quote changes the bill of materials by more than 10%. Action: update the cost sheet and the cost-down plan.
- Advisers are not engaged in time. Trigger: no regulatory specialist by week 4. Action: escalate on the owner action list.
- Arm reach does not cover the workspace. Trigger: week 2 study fails. Action: change arm count or mounting, then re-run the cost sheet.

## Outputs at day 90
- Demonstrator with controlled movement, emergency stop and dashboard, shown on dental models.
- Test reports: scan accuracy, repeatability, force limit, e-stop timing.
- Gate records and the Stage B recommendation.

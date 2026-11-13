# Engineering test plan — Stage A demonstrator

Scope: dental models and instrumented fixtures only. No human subjects. Each test has an ID, a requirement, a method, and a pass/fail criterion. A criterion marked "TBD" must be set by the engineering lead and the regulatory specialist before the test runs. Results go into the gate records in the 90-day schedule.

## 1. Positioning and motion

| ID | Requirement | Method | Pass criterion |
|---|---|---|---|
| POS-01 | Arm reaches the workspace defined in binder sheet 11 | Command the arm to 30 target points on the fixture; measure reached position | 100% of targets reached within the workspace; none outside the keep-out zones |
| POS-02 | Positioning accuracy | Repeat POS-01 targets with a calibrated reference; compare measured with commanded | Mean error ≤ TBD mm; maximum error ≤ TBD mm (target from clinical advisor) |
| POS-03 | Positioning repeatability | Return to each target 10 times from random starts | Spread across 10 returns ≤ TBD mm |
| POS-04 | Speed limit in cleaning mode | Command the maximum cleaning-mode speed; log the encoder | Speed never exceeds the software limit by more than 2% |
| POS-05 | Motion stops at travel limits | Drive into each mechanical and software limit | Motion stops before the hard stop; no overshoot beyond TBD mm |

## 2. Force and collision

| ID | Requirement | Method | Pass criterion |
|---|---|---|---|
| FRC-01 | Force sensor calibration | Load the sensor with certified weights at 5 points | Error ≤ TBD % of full scale |
| FRC-02 | Force limit in cleaning mode | Press the instrument tip on a load cell with a rising command | Motion stops at or below the limit (TBD N); no reading above the limit sustained for more than TBD ms |
| FRC-03 | Collision detection | Drive the arm into a fixture obstacle at the cleaning speed | Motion stops within TBD ms and the arm retracts to the safe position |
| FRC-04 | Torque limiter | Stall each joint under load | Joint releases at the rated torque; no damage after 10 stalls |

## 3. Emergency stop and safe state

| ID | Requirement | Method | Pass criterion |
|---|---|---|---|
| ESTOP-01 | Hardware e-stop removes motion power | Press the e-stop during a motion; measure time to power removal | Power removed within TBD ms, with no software in the path |
| ESTOP-02 | Retraction after stop | After ESTOP-01, observe the retraction sequence | Instrument reaches the safe position in TBD s; no motion toward the fixture |
| ESTOP-03 | Patient stop | Trigger the patient stop control during a run | Same as ESTOP-01 and ESTOP-02 |
| ESTOP-04 | Watchdog | Stop the motion controller's heartbeat for TBD ms | Safety controller enters safe state; logs the event |
| ESTOP-05 | Loss of communication | Disconnect the operator computer during a run | Safe state entered; no motion command continues |
| ESTOP-06 | Reset | Attempt a reset without authorization; then with authorization | No motion after an unauthorized reset; motion resumes only after the authorized reset |

## 4. Scanning and vision

| ID | Requirement | Method | Pass criterion |
|---|---|---|---|
| SCN-01 | Scanner calibration | Scan the calibration target; compare with its certificate | Error ≤ TBD mm |
| SCN-02 | Scan accuracy on the reference model | Scan a reference typodont; compare to the reference geometry | Mean deviation ≤ TBD mm |
| SCN-03 | Tooth segmentation | Run segmentation on 20 reference scans | Correct tooth identification in ≥ TBD % of teeth |
| SCN-04 | Quality gate | Scan with deliberate defects (blur, low light, missing coverage) | The system marks each scan "not assessable" and does not produce a finding |
| SCN-05 | Camera visibility loss | Block the camera during a run | Motion stops; the event is logged; the run cannot resume without review |

## 5. Software and records

| ID | Requirement | Method | Pass criterion |
|---|---|---|---|
| SW-01 | Eligibility gate | Run 20 test encounters with stop conditions (swelling, pain, uncertain finding) | Every stop condition halts the path; no cleaning proposal produced |
| SW-02 | Authorization gate | Attempt a cleaning without clinician authorization | Cleaning does not start; the attempt is logged |
| SW-03 | Audit log | Perform 10 actions, including one safety stop | Every action and the stop are recorded with time and actor; the log cannot be edited |
| SW-04 | Simulated data labelling | Review each screen | Simulated values are labelled as simulated |
| SW-05 | Offline safe state | Disconnect the network during a run | Local safety holds; motion stops safely; the run is recorded |

## 6. Cleaning (models only)

| ID | Requirement | Method | Pass criterion |
|---|---|---|---|
| CLN-01 | Polishing on a model | Polish a stained model against a reference | Stain removal to TBD on the reference scale |
| CLN-02 | Plaque removal on a model | Remove simulated plaque from a model with a fixed method | Removal ≥ TBD % of simulated plaque area |
| CLN-03 | Soft-tissue contact | Measure force and contact on a gum-simulant fixture | No contact above the force limit; no contact with the simulated gum margin beyond the limit |
| CLN-04 | Water and suction | Run the irrigation and suction for a full cycle | Flow within TBD mL/min; leak sensor triggers at TBD level |

## 7. Pass, fail and retest rules

- A failed test is recorded with the measured value, the criterion, and the cause (if known).
- A failed safety test (ESTOP, FRC-02, FRC-03, SCN-05, SW-02) blocks Gate 2 until it is fixed and re-run three times.
- No criterion may be changed after a test has started. Changes need a written record and the regulatory specialist's approval.

## 8. Open items for the engineering lead and clinical advisor

- Set every TBD value before week 5 of the schedule.
- Confirm the force limit (FRC-02) against published soft-tissue data before any cleaning test.
- Confirm the eligibility thresholds (SW-01) with the clinical advisor.

# Proposed starting values for TBD test thresholds

Status: PROPOSED. These are starting values for the engineering lead and clinical advisor to confirm or change. None has been validated, and none should be used as an acceptance criterion until confirmed and recorded in the test plan.

| Test | Criterion | Proposed value | Basis to confirm |
|---|---|---|---|
| POS-02 | Mean positioning error | ≤ 0.5 mm | Target for a demonstrator; confirm against the clinical need |
| POS-02 | Maximum positioning error | ≤ 1.0 mm | As above |
| POS-03 | Repeatability spread | ≤ 0.2 mm | Consistent with precision arms of this class; confirm with the vendor |
| POS-05 | Overshoot beyond limit | ≤ 1.0 mm | Mechanical stop design |
| FRC-01 | Force sensor error | ≤ 2% of full scale | Typical for industrial load cells; confirm with the sensor datasheet |
| FRC-02 | Force limit | 1.0 N | Matches the force limit used in the interface prototype and the planning documents |
| FRC-02 | Sustained exceedance before stop | ≤ 200 ms | Engineering choice to avoid nuisance stops; confirm |
| FRC-03 | Stop after collision | ≤ 100 ms | Engineering target; confirm |
| ESTOP-01 | Time to remove motion power | ≤ 100 ms | Engineering target; confirm against the applicable safety standard |
| ESTOP-02 | Retraction to safe position | ≤ 5 s | Engineering target |
| ESTOP-04 | Watchdog timeout | ≤ 100 ms heartbeat loss | Engineering target |
| SCN-02 | Scan deviation on reference model | ≤ 0.1 mm mean | Confirm against the scanner specification |
| SCN-03 | Correct tooth identification | ≥ 95% of teeth | Starting point for segmentation; confirm |
| CLN-02 | Simulated plaque removal | ≥ 90% of area | Starting point; confirm with the clinical advisor |
| CLN-04 | Leak sensor trigger | At the first drop of leak | Engineering target |

Confirm before testing:
1. Engineering lead: positioning, force, e-stop and scan values.
2. Clinical advisor: cleaning and soft-tissue values, and eligibility thresholds.
3. Regulatory specialist: check each value against the applicable safety and dental equipment standards.

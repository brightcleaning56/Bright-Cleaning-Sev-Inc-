# Stage A demonstrator readiness checklist

Use at Gate 2 and Gate 3. Each item needs evidence (a record, report or test ID). An item is not "done" until its evidence is filed. Items marked [safety] block the gate if they fail.

## 1. Documents and governance
- [ ] Product requirements and intended use draft, version-controlled [evidence: requirements v1]
- [ ] Safety architecture document approved by the engineering lead and regulatory specialist [safety] [evidence: safety architecture v1]
- [ ] Risk register reviewed; every entry has a test ID [evidence: risk register revision]
- [ ] Test thresholds confirmed and recorded before testing started [evidence: signed threshold record]
- [ ] Change log for every design change since the last gate [evidence: change log]

## 2. Hardware on the fixture
- [ ] Arm mounted and calibrated; workspace matches binder sheet 11 [evidence: POS-01 report]
- [ ] Force sensor calibrated against certified weights [safety] [evidence: FRC-01 report]
- [ ] Hardware e-stop wired independently of software [safety] [evidence: ESTOP-01 report]
- [ ] Tool lock and identity check working [safety] [evidence: TL-01 report]
- [ ] Scanner calibrated to its certificate [evidence: SCN-01 report]
- [ ] Camera visibility sensor in place [safety] [evidence: SCN-05 report]
- [ ] Temperature sensors installed on drive and electronics [evidence: TMP-01 report]

## 3. Software and records
- [ ] Eligibility gate tested with stop conditions [safety] [evidence: SW-01 log]
- [ ] Authorization gate blocks cleaning without clinician sign-off [safety] [evidence: SW-02 log]
- [ ] Audit log records every action and stop, and cannot be edited [evidence: SW-03 log]
- [ ] Simulated data labelled on every screen [evidence: SW-04 review]
- [ ] Safe state on communication loss [safety] [evidence: SW-05 log]
- [ ] Software version recorded and regression tests run on the release [evidence: REG-01 report]

## 4. Demonstration
- [ ] Controlled movement on dental models, to the proposed thresholds [evidence: demonstration log]
- [ ] Emergency stop demonstrated under operator control, with timing [safety] [evidence: ESTOP-01 timing]
- [ ] Power loss mid-run: safe state, no automatic resume [safety] [evidence: PWR-01 report]
- [ ] Dashboard connected to the live rig [evidence: screenshot with date and rig ID]

## 5. Scope limits checked
- [ ] No human subjects used at any point [evidence: test log]
- [ ] No cleaning performed on a person; models only [evidence: test log]
- [ ] No claim of clinical performance in any document or demo [evidence: document review]

## 6. Gate decision
- [ ] All [safety] items passed (no exceptions) [evidence: gate record]
- [ ] Open items listed with owner and date [evidence: open-items list]
- [ ] Stage B recommendation written [evidence: recommendation]
- [ ] Signed by the Product Director and the regulatory specialist [evidence: signatures]

## Blocking rules
- A failed [safety] item blocks the gate. It is re-tested three times after the fix before the gate can be reconsidered.
- Any change to a safety threshold after testing started needs written approval from the regulatory specialist.

# DentistNow AutoClean Pro 2.0 — Engineering Design Baseline

## 1. Product definition
A fully integrated dental chair platform combining patient intake, oral imaging, 3D intraoral scanning, AI-assisted observations, clinician review, and a professionally supervised robotic cleaning workflow. The first generation is not an autonomous diagnostic or treatment system.

## 2. System boundaries and interfaces
| Subsystem | Inputs | Outputs | Safety boundary |
|---|---|---|---|
| Patient station | Identity, patient controls, chair sensors | Position state, patient stop request | Patient stop independent of cloud |
| Imaging | Camera, scanner, calibration data | Images, 3D mesh, quality metadata | Capture cannot authorize treatment |
| AI clinical service | Approved images, history, measurements | Findings, confidence, evidence, abstentions | No direct robot control |
| Clinical application | AI observations, clinician input | Signed review, eligibility, consent | RBAC and audit required |
| Robotics controller | Validated motion request, encoder/force data | Motion telemetry, tool state | Bounded trajectories only |
| Safety controller | E-stop, patient stop, watchdog, interlocks | Safe torque off / inhibit / safe state | Independent of AI and cloud |
| Fluid system | Water, suction, waste, leak sensors | Flow and fault state | Fault inhibits procedure |
| Infection control | Instrument ID, cycle records | Release/hold status | Unverified instrument cannot be enabled |
| DentistNow cloud | Authorized clinical records and device events | Sync, reports, audit, fleet management | Loss of connectivity must not defeat local safety |

## 3. Physical subsystem design
### Patient chair and frame
- Ergonomic adjustable chair with head support and accessible patient egress.
- Structural frame sized through load cases, fatigue analysis and stability testing.
- Pinch-point guarding, cable routing, cleanable surfaces and service access.
- Chair position sensors and independent limits.
- Patient-accessible stop control; clearly distinguished from clinician controls.

### Imaging gantry
- Adjustable camera and scanner mounts with repeatable calibration references.
- Intraoral camera and 3D scanner are separate modalities with independent quality metadata.
- Provide clinician-directed radiography interface only when indicated; radiography subsystem requires its own qualified equipment and controls.
- Prevent image capture from being interpreted as diagnosis or authorization.

### Robotic instrument carriage
- Design around bounded work envelope, passive mechanical stops, guarded joints and instrument exchange.
- Encoders on relevant axes; force/torque sensing where clinically and technically appropriate.
- Tool identity, attachment-lock sensing and disposable/reusable component compatibility checks.
- Default state: parked, tool retracted, motion inhibited.
- Initial engineering demonstrations use dental typodonts and instrumented fixtures, not people.

### Fluid and suction
- Separate clean-water supply and waste pathways.
- Leak detection, flow/pressure monitoring and serviceable filters.
- Materials and pathways selected for validated cleaning/disinfection and waterline maintenance.
- Fluid faults inhibit procedure and initiate validated safe-state behavior.

### Infection control
- Trace each patient-contact component and reusable instrument by unique identity.
- Separate clean, sterile and contaminated handling zones.
- Track validated cleaning and sterilization cycle evidence, expiry/lifecycle and release status.
- UV exposure is not a substitute for validated cleaning and sterilization.
- Design barriers and removable components for cleaning access.

## 4. Electrical and controls architecture
- Mains entry, protective earth, isolation and power distribution designed by qualified medical electrical engineers.
- Segregate motor power, low-voltage control, imaging/data and patient-connected circuits as required by the selected architecture.
- Embedded real-time motion controller is separate from application servers.
- Independent safety controller monitors E-stop, patient stop, access interlocks, watchdog, collision/force signals and critical subsystem faults.
- Safety controller inhibits motion and transitions to the validated safe state independently of cloud services.
- Define safe torque off, braking, retraction and power-loss behavior through hazard analysis; do not assume retraction is always safer than stopping.
- Use hardware watchdogs, brownout detection, fault-latched states and authorized reset.
- EMC, leakage current, dielectric strength, protective earth, thermal and abnormal-operation tests are required.

## 5. Robotics control architecture
1. AI / workflow layer proposes an action with a signed procedure context.
2. Clinical authorization service checks clinician, patient consent, eligibility and encounter state.
3. Motion planner checks approved workspace, tool profile, limits and validated trajectory.
4. Real-time controller executes bounded motion and reports telemetry.
5. Independent safety controller can inhibit motion at any time.
6. No automatic restart after E-stop or safety fault; require fault diagnosis and authorized reset.

## 6. Software services
- Identity and access management; role-based access control.
- Patient and encounter service.
- Medical history and symptom intake.
- Imaging ingestion and quality service.
- 3D scan storage and tooth-map service.
- AI inference service with model/version traceability and abstention.
- Clinical review and sign-off service.
- Consent and authorization service.
- Device gateway and telemetry service.
- Local safety/motion interface (not cloud-controlled).
- Instrument/reprocessing service.
- Maintenance and calibration service.
- Audit, reporting and analytics.
- Integration adapter for DentistNow records and standards-based clinical exchange.

## 7. Data model baseline
Core tables: organizations, clinics, users, roles, patients, patient_identifiers, encounters, medical_histories, medications, allergies, symptoms, consents, images, image_quality_assessments, scans, teeth, tooth_surfaces, ai_model_versions, ai_observations, clinical_findings, clinical_reviews, procedure_plans, authorizations, devices, device_components, telemetry_events, safety_events, instruments, reprocessing_cycles, instrument_release_records, maintenance_records, calibration_records, audit_events.

Data rules:
- AI observation and clinician-confirmed finding are distinct entities.
- Every image/scan references patient, encounter, acquisition time, device, operator and quality status.
- Every authorization references clinician identity, scope, time, patient consent and encounter.
- Immutable audit events record access, amendment, export, approval and device state changes.
- Tenant isolation and minimum-necessary access are mandatory.

## 8. UX and role model
- Patient UI: welcoming, accessible, plain language, clear progress and consent.
- Operator UI: workflow queue, machine readiness, patient handoff and alerts.
- Clinician UI: source images, AI evidence, confidence, limitations, correction and sign-off.
- Service UI: calibration, maintenance, faults and instrument lifecycle.
- Administrator UI: users, roles, sites, device fleet, configuration and audit.
- Emergency and safety functions are not hidden in navigation and cannot depend on ordinary UI availability.

## 9. Verification plan
| Area | Verification evidence |
|---|---|
| Mechanical | Load, stability, fatigue, pinch-point and cleanability testing |
| Electrical | Protective earth, leakage, dielectric, EMC, thermal and abnormal operation |
| Motion | Workspace bounds, accuracy, repeatability, stopping distance and fault response |
| Safety | E-stop, patient stop, watchdog, sensor faults, network loss, power loss and reset behavior |
| Imaging | Calibration, image quality, coverage, repeatability and artifact testing |
| AI | Representative validation, subgroup performance, false positives/negatives, calibration, abstention and version control |
| Infection control | Validated reprocessing, material compatibility, waterline and traceability evidence |
| Software | Requirements traceability, unit/integration/system tests, cybersecurity and release controls |
| Human factors | Patient comprehension, clinician workload, alarm interpretation and emergency usability |
| Clinical | Protocol-driven evaluation after regulatory and ethics review as applicable |

## 10. Regulatory and quality workstream
Determine device classification and pathway from final intended use and claims. Establish a quality management system and risk management file. Assess applicable FDA QMSR, ISO 13485, ISO 14971, IEC 62304, IEC 60601 family, IEC 80601-2-60, usability engineering, cybersecurity and infection-control requirements with qualified regulatory and engineering specialists. Do not claim clearance or clinical readiness until supported by evidence and authorization.

## 11. CAD package requirements
The future CAD release should include:
- Overall assembly and envelope drawing.
- Chair/frame weldment and structural parts.
- Gantry, scanner mounts and camera adjustment mechanism.
- Robotic carriage, joints, tool interface and guarding.
- Fluid routing and service access.
- Electrical cabinet, harness routing and grounding/bonding plan.
- Clean/contaminated instrument zones.
- Exploded views, BOM, material/finish schedule, tolerances, GD&T, fasteners and service instructions.
- Simulation reports: structural, fatigue, motion envelope, collision, thermal and cable bend radius.
No manufacturing dimensions are assigned in this baseline; those require CAD, load cases, component selection and verification.

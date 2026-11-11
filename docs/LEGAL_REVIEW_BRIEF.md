# Legal review brief: Bright Clean operations system

Prepared for the owner to hand to a qualified attorney. This describes what the system does, what it collects, and what needs a legal decision. It is not legal advice.

## 1. What the system does with customer data
- **Website forms:** bid requests, contact messages and job applications. Stored with name, email, phone, company, project address, scope, files uploaded by the customer, and consent checkboxes.
- **Customer records:** created from forms, estimates and invoices. Holds contact details, project history, proposals, contracts, invoices and payments.
- **Calls:** inbound and outbound calls run through Twilio. Call details (time, number, duration, outcome, notes) are logged. Calls can be recorded and transcribed.
- **Email:** customer emails are sent from info@brightclean.net through Microsoft 365. Replies from the Outlook inbox are shown on the customer's record.
- **AI assistant:** an AI model (Anthropic) summarises leads, drafts replies and can answer calls. Lead text is sent to the AI provider.
- **Backups:** a daily encrypted copy of the database is stored on the server and copied to Backblaze B2 (United States).

## 2. Automatic calls to leads
- The system can place automatic callbacks to leads who asked for one, only when the owner has turned this on and confirmed legal review.
- Calls only go to leads ticked "Call back requested", only inside the business hours set in Settings (currently 11 PM–midnight in the test setup; set the real hours), and under a daily limit.
- The caller hears: "This call may be recorded for quality and training." Pressing 1 connects to the team. If nobody answers, the caller hears a short message and a follow-up task is created.

**Questions for counsel:**
1. Is an automated (non-human) callback to a person who asked for one permitted under the Telephone Consumer Protection Act (TCPA) and Iowa, Texas, Minnesota, North Dakota and Missouri law? Does it need prior express consent, and how should that consent be recorded?
2. Is the recording notice enough for one-party and two-party consent states? What exact wording is required, and must the notice come before any recording starts, including on voicemail?
3. Are the call hours and do-not-call rules correct for each state, and should the system check the national and state do-not-call lists before dialing?
4. How should opt-outs be handled (a "stop calling me" request on a call, an email, or a form)?

## 3. Text messages
- The system does not send text (SMS) messages yet. If this changes, counsel must review consent and opt-out.

## 4. Privacy policy and terms
- The current privacy and terms pages are starter text. They must describe: the data listed in section 1, the AI provider, the call recording, the backup provider, retention periods, and how customers can ask for their data or its deletion.
- Counsel to confirm the terms cover: proposal acceptance by online approval, the electronic-signature method used, payment terms, and cancellation.

## 5. Electronic signatures and acceptance
- Customers can accept a proposal online by typing their name and confirming authority. The system records the time, IP address and browser.
- Counsel to confirm this is valid acceptance under the federal E-SIGN Act and Iowa's UETA, or whether a qualified e-signature provider is needed.

## 6. Employment
- Job applications are collected by the careers form. Counsel to review what may be asked, how long applications are kept, and the notice to applicants.

## 7. Security and incident duties
- Owners and managers must use two-step sign-in. Admin access is audited.
- Counsel to confirm what breach notification duties apply (state data-breach laws) and who the incident contact is.

## 8. Items the owner must confirm before counsel can finish
- Legal name and entity type of the company.
- Business hours and the states where calls will be placed.
- Whether text messaging is planned.
- Retention periods for leads, customer records, call recordings and backups.
- Insurance and license documents referenced in the terms.

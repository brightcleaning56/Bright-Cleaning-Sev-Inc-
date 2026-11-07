DRAFT — NOT IN EFFECT UNTIL REVIEWED BY COUNSEL

EMAIL COMMUNICATIONS POLICY (CAN-SPAM)

Enforced in software (src/outbound.js):
- Every proposal email identifies the sending company and includes its valid postal address. Sending is blocked if either is missing.
- Subject lines state what the message is: "Cleaning proposal — [project] ([permit])".
- Every email carries a working unsubscribe link and RFC 8058 one-click List-Unsubscribe headers.
- Unsubscribes take effect immediately (well within the 10-business-day FTC requirement) and apply across every company on the platform.
- Only contacts with status verified or source_confirmed, backed by an evidence URL, can be emailed.
- Spam complaints automatically suppress the address. Hard bounces mark the contact outdated.
- A bid counts as sent only when the email provider returns a message ID.

Not enabled: SMS, automated calls, AI voice. These require a separate TCPA review before activation.

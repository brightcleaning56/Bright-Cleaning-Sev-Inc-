# Outreach: who we contact, why, and what we say

This explains the first and second notes the system drafts to a lead. **Nothing here sends email.** Drafts go to staff for review. No automatic sending is turned on, and turning it on needs the owner's yes.

## What the company does (as the notes describe it)

Bright Clean (Bright Cleaning Sev Inc.) is a cleaning company in Des Moines, Iowa. It serves:

- **Single-family homes:** move-in, move-out and recurring cleaning, and deep cleans.
- **Multifamily and apartments:** common areas, unit turnovers and move-out cleaning.
- **Commercial buildings:** janitorial and recurring service.
- **Construction cleanup:** rough, final and touch-up cleaning after a build or renovation, for general contractors and developers.

How we work: a walkthrough, then one written proposal with one price, then scheduling, then a quality check against a written checklist before the job is called done.

Source for this description: `docs/BUSINESS_PLAN.md` (divisions A and B, residential and multifamily) and the services in `intake.js`. Owner to confirm the wording before any real outreach.

## The two stages

| Stage | When it is used | What the note does | Who it goes to |
|---|---|---|---|
| **1. Introduction** | No note has been sent to this address yet (`email_log` has no sent row for it). | Says who we are, what we clean, how we work, and how we can help with their project. Asks about the project, or for a short call or walkthrough. | Staff-added contacts, website requests, and anyone else who has not heard from us. |
| **2. Follow-up** | At least one note was already sent to this address. | Refers back to the first note, and asks to be added to their bidder list for future projects and construction cleaning on single-family homes, commercial buildings and multifamily properties. Asks how to register and who to contact. | Same contacts, after the first note. |

If a lead explicitly asks to be on a bidder list, the bidder-list note is used whatever the stage. General contractors with post-construction work get their own wording.

## Where it lives in the code

- `leadclass.js`: `draftFor(lead, segment, intent, stage)` builds both notes. `classify` takes the stage. The classification endpoint (`/api/admin/leads/:id/classification`) works out the stage from `email_log` and returns `stage` and `prior_sends`.
- `ai.js` (`COMPANY`) and `autobid.js` (`askContact`): the descriptions the AI and the automatic "few questions" email use. Both now describe the three divisions, not commercial only.

## Who reaches out, and when (current behaviour)

| Sender | Trigger | Automatic? |
|---|---|---|
| Staff (from a lead or customer page) | A person chooses to send | Human-started; the classifier only drafts |
| AI "few questions" email (`ai.js`, `autobid.js`) | A bid request is missing details | **Yes, when the setting is on.** See the open decision below. |
| Thank-you email after a quote request (`intake.js`) | Someone submits the public form | Yes. It now honours opt-outs and bounces. |

## Open decisions for the owner

1. **Automatic AI emails.** The AI can email a lead on its own when a request is missing details (`ai.js`, `maybeRequestInfo`), and the text is written by the AI. Options: (a) send only a fixed template listing the missing items, or (b) hold each one for approval. Until you choose, the setting should stay off for leads you did not contact yourself.
2. **Wording check.** The sentence "We clean single-family homes, apartment and multifamily properties, and commercial buildings" and the walkthrough-then-one-price description should be checked against how you actually sell, before any note goes out.
3. **Bidder list.** Confirm that you want the follow-up to ask for registration forms and prequalification, as written.
4. **Opt-out wording.** Counsel should approve any footer before outreach to people outside your customer list (email rules).

## Contact check and the introduction email (added)

A lead is ready for its first email only when the system has all of these:

- contact name (first and last)
- company
- email to a person (not a job inbox or a shared company inbox)
- phone
- site or mailing address

`GET /api/admin/leads/:id/contact-check` lists anything missing and says whether the lead is ready. The lead drawer shows the same list.

**Sending is a person's click, not an automatic sweep.** `POST /api/admin/leads/:id/intro-email` sends one introduction, only when:

- the contact check passes,
- the email goes to a person,
- nothing has been sent to that address before (a second contact gets the follow-up note instead),
- the text passes the price guard (no dollar amounts or rates),
- the address is not opted out or bounced (the send goes through the suppression check).

**Pricing is left to a person.** The introduction says what we do and how we work, then says that prices are not sent by email and that one of our people will walk the job and send a written proposal with one price. The system never quotes a price in an introduction.

**Automatic sending is HELD (off until the owner turns it on).** A background sweep checks every 10 minutes for leads from the last 14 days with status New or In Review. For each one that passes the contact check and has never been contacted, it sends the **first** email: the introduction, never a follow-up. At most 10 go out per run. A lead that has been contacted at all (any sent email, or an earlier introduction) is skipped by the sweep, and follow-ups are always written by a person.

The switch is the setting `auto_intro_email` (off by default; the owner turns it on after reviewing the leads it would email). Turn it off in the automation settings API (`PUT /api/admin/ai/settings` with `{"auto_intro_email": false}`). The sweep interval is `INTRO_SWEEP_MS` (default 600000).

The sweep also includes staff-added contacts, as the owner asked. Each introduction still names the company, what we do and how we work, and says prices come from a person.

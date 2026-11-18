# Staging test plan: shared messaging record

Staging: https://brightclean-staging.onrender.com (service `brightclean-staging`, branch `claude/messaging-staging`).
Build at last check: `b153529c1147`. Production stays on `claude/bright-cleaning-rebuild-nt1y6e`.

Use test data only. Do not use real customer emails, real phone numbers, or the live owner password.

## Setup (owner)

1. Sign in to staging as the staging admin.
2. Create one test customer with a test email you control, and one test crew member with a test phone.
3. Send me the test customer email and crew name, plus a staging admin login for testing.

## Test 1: customer message reaches the shared record

- Sign in to the customer portal with the test email.
- Send a message with a subject and body.
- Expected: the message appears in the customer's portal list, and in admin Client messages.

## Test 2: office reply reaches the customer

- In admin, reply to the test customer's message.
- Expected: the reply appears in the customer's portal, attached to the message it answers.

## Test 3: crew message reaches the office

- Sign in to the crew portal as the test crew member and send a message.
- Expected: it appears in the office crew-messages screen, with an unread count.
- Open the thread in admin. Expected: the unread count clears.

## Test 4: office message reaches the crew member

- In admin, send a message to the test crew member.
- Expected: it appears in the crew portal thread, and the crew member's read state updates.

## Test 5: nothing is lost on restart

- Trigger a manual redeploy of staging (Manual Deploy, Deploy latest commit).
- After it is healthy, repeat the checks above by looking at the old messages.
- Expected: every message from Tests 1 to 4 is still there, once each.

## Test 6: no duplicates from retries

- Send the same customer message twice quickly.
- Expected: two messages, one per submission, no more.

## Pass criteria

- Tests 1 to 5 pass with no error in the staging logs.
- Test 6 shows no duplicates beyond the two submissions.

If any test fails, send me the test name and the staging log lines from that time.

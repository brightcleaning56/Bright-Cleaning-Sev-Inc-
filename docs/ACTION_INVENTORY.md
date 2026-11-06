# Admin action inventory (generated)

Pages (views): 20. Navigation entries: 19. Buttons and links: 60, of which 46 are referenced by the admin script and 14 are not found by this check.

Elements not found by this check need a manual or browser test before they count as working (the check looks for ids, data attributes, form submits and inline handlers).

| View | Tag | Label | Id / attribute |
|---|---|---|---|
| leads | button | Bid requests | data-kind |
| leads | button | Contact messages | data-kind |
| leads | button | Job applications | data-kind |
| schedule | button | Calendar | data-sp |
| schedule | button | Dispatch board | data-sp |
| schedule | button | Employees | data-sp |
| schedule | button | Time sheets | data-sp |
| proposals | button | Overview | data-pv |
| proposals | button | Estimates | data-pv |
| proposals | button | Proposals | data-pv |
| proposals | button | Bids (GC) | data-pv |
| proposals | button | Contracts | data-pv |
| settings | button | Change password | — |
| settings | button | Give access | — |

## How to read the unmatched rows

The 14 rows above were checked by hand against the admin script and all are wired:
- Lead type tabs (`leadKinds`), proposal tabs (`propTabs`) and schedule tabs (`schTabs`) use one click handler on their container, reading `data-kind`, `data-pv` or `data-sp`.
- "Change password" (`pwForm`) and "Give access" (`userForm`) are form submit buttons; their forms have submit handlers.

So the static audit finds no button without a handler. Clicking each element in a live browser is still required before the audit counts as complete.

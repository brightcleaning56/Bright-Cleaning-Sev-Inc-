# Quote request list — hardware bill of materials

Purpose: get re-quoted prices for every hardware line so the $85,000 unit-cost ceiling can be tested. Send one package per supplier group. Quotes are not commitments.

Target: total hardware bill of materials of $85,000 or less (base target $60,000). Current estimate: $109,300 (source estimate; line items need re-quoting).

## Request package (send to each supplier group)

Each request should include: part description, quantity, required performance (below), target delivery for a Stage A demonstrator and Stage B prototype, minimum order, unit price at 1, 10 and 50 units, lead time, and whether the part is medical-grade or needs medical certification.

| # | Item | Qty in v1 | Current estimate | Ask suppliers for | Notes |
|---|---|---|---|---|---|
| 1 | Motorized patient chair (motion module, not full custom chair) | 1 | $12,000 | Donor medical-chair option plus motion module price | Ergonomics and certification of donor chair must be confirmed |
| 2 | Robotic arms, 6-axis precision | 2 (reduce from 2–4 if workspace study allows) | $24,000 | Price for 2 and for 4 arms; encoder and torque-sensor options | Keep force sensing and collision protection |
| 3 | 3D intraoral scanner | 1 | $8,500 | OEM scanner price; OEM integration fee | Calibration method required |
| 4 | Intraoral cameras (4K) | 2 (reduce from 4 if coverage allows) | $2,800 | Price for 2 and 4 cameras | Coverage check in binder sheet 14 |
| 5 | Digital X-ray module | 0 in version 1 (option) | $18,000 | Partner-option pricing only | Clinician-ordered option; not in base BOM |
| 6 | Tool magazine and consumables | 1 | $3,800 | Carousel price; tool and cartridge cost per cycle | Lifecycle counters |
| 7 | Fluid, suction and filtration | 1 | $5,200 | Pump, reservoir, filter and sensor pricing | Leak and level sensors |
| 8 | Sterilization, UV and thermal interface | 1 | $6,800 | Interface only, or validated sterilizer price | Sterilizer must be validated; UV alone is not sterilization |
| 9 | Control and AI computing | 1 | Not stated in source | Industrial embedded computer and GPU options | Safety controller must stay independent |
| 10 | Safety controller (hardware e-stop, watchdog) | 1 | Not stated in source | Certified safety PLC or safety module price | Independent of AI and cloud |
| 11 | Enclosure, housing, LEDs | 1 | $7,500 | Fabrication quote, including molding or sheet-metal options | Cleanable surfaces |
| 12 | Software licences and integration (UI, AI, EHR) | — | $10,000 | Licence costs; in-house build estimate | Moves to R&D budget if built in-house |

## Suppliers to approach (by category)

- Medical chairs and motion modules
- Industrial robot arms and cobots with force sensing
- Intraoral 3D scanners (OEM)
- Industrial embedded computing and safety controllers
- Fluid systems (pumps, filters, sensors)
- Sheet-metal and plastics fabrication for enclosures
- Sterilizer manufacturers (for the interface requirement)

## What we need back

- A spreadsheet per supplier with the fields above.
- Written statement of which parts are medical-grade and which need certification.
- Any part that cannot reach the target price, with the reason.

## Next steps

1. Re-enter quoted prices into the financial model's unit-cost sheet.
2. Update the cost-down plan with confirmed numbers.
3. Stage C gate: the bill of materials must be at or below $85,000 before commitment.

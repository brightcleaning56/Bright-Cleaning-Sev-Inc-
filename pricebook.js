// Bright Clean standard price book, taken from the company's own bids and price sheets:
// Terrell State Hospital proposal (per-SF phase rates), the apartment cleaning sheet and the hallway sheet.
// [category, name, unit, unit_price, description, included, frequency]
const SIZES = ['Studio / 1 Bath', '1 Bed / 1 Bath', '2 Bed / 1 Bath', '2 Bed / 2 Bath', '3 Bed / 2 Bath', '3+ Bed / 2+ Bath (starting at)'];
const BASIC = [55, 65, 70, 80, 90, 130], DEEP = [70, 80, 90, 95, 130, 165], MOVE = [55, 65, 75, 80, 90, 100];
const BASIC_INC = 'Kitchen wipe-down, bathroom sanitizing, dusting, vacuuming, mopping, trash removal.';
const DEEP_INC = 'Everything in Basic Clean plus baseboards, inside microwave, window sills, detailed scrubbing and extended time in high-traffic areas.';
const MOVE_INC = 'Inside cabinets and drawers, oven, fridge, wall spot-cleaning, baseboards, all surfaces sanitized, floors scrubbed.';
module.exports = [
  ['construction', 'Clean #1 – Construction clean before GC punch', 'SF', 0.18375, 'Construction clean prior to the general contractor punch (Terrell State Hospital rate).', 'Dust and debris removal, floors, walls, doors, frames, base, millwork, fixtures, restrooms, interior glass, accessible ceilings.', 'Per phase'],
  ['construction', 'Clean #2 – Construction clean before Owner punch', 'SF', 0.13125, 'Construction clean prior to the Owner punch.', 'Re-clean of released areas to inspection-ready condition before the Owner walk.', 'Per phase'],
  ['construction', 'Clean #3 – Final clean after Owner punch', 'SF', 0.1575, 'Final clean after the Owner punch.', 'Final detail clean to turnover standard.', 'Per phase'],
  ['construction', 'Clean #4 – FF&E turnover clean (alternate)', 'SF', 0.0525, 'Final clean after furniture, fixtures and equipment installation. Usually bid as an add alternate.', 'Furniture dusting and wipe-down, removal of installation dust, final touch-up.', 'Per phase'],
  ['specialty', 'Extra work – cleaner hour (authorized)', 'Hour', 32, 'Authorized work outside the agreed scope, per cleaner-hour.', 'Labor for written-authorized extra work.', 'As needed'],
  ['specialty', 'Extra work – supervisor hour (authorized)', 'Hour', 45, 'Authorized work outside the agreed scope, per supervisor-hour.', 'Supervision for written-authorized extra work.', 'As needed'],
  ['specialty', 'Extra work – overtime / holiday cleaner hour', 'Hour', 48, 'Overtime, Sunday and holiday hours at 1.5x the cleaner rate.', 'Labor for authorized extra work outside normal hours.', 'As needed'],
  ...SIZES.map((sz, i) => ['multifamily', `Occupied unit – Basic clean – ${sz}`, 'Unit', BASIC[i], 'Standard apartment cleaning, occupied unit.', BASIC_INC, 'Per visit']),
  ...SIZES.map((sz, i) => ['multifamily', `Occupied unit – Deep clean – ${sz}`, 'Unit', DEEP[i], 'Deep apartment cleaning, occupied unit.', DEEP_INC, 'Per visit']),
  ...SIZES.map((sz, i) => ['multifamily', `Move-in / move-out clean – ${sz}`, 'Unit', MOVE[i], 'Move-in or move-out cleaning for a vacant unit.', MOVE_INC, 'Per turn']),
  ['multifamily', 'Unit add-on – Inside oven', 'Each', 25, 'Add-on to a unit clean.', 'Inside oven cleaning.', 'Per visit'],
  ['multifamily', 'Unit add-on – Inside fridge', 'Each', 25, 'Add-on to a unit clean.', 'Inside refrigerator cleaning.', 'Per visit'],
  ['multifamily', 'Unit add-on – Inside windows', 'Window', 5, 'Add-on to a unit clean, per window.', 'Inside window glass.', 'Per visit'],
  ['multifamily', 'Unit add-on – Balcony / patio', 'Each', 20, 'Add-on to a unit clean.', 'Balcony or patio cleaning.', 'Per visit'],
  ['multifamily', 'Unit add-on – Carpet shampooing', 'Room', 40, 'Add-on to a unit clean, per room.', 'Carpet shampooing.', 'Per visit'],
  ['multifamily', 'Unit add-on – Pet odor treatment', 'Each', 30, 'Add-on to a unit clean.', 'Pet odor treatment.', 'Per visit'],
  ['multifamily', 'Unit add-on – Wall washing', 'Room', 15, 'Add-on to a unit clean, per room.', 'Wall washing.', 'Per visit'],
  ['multifamily', 'Unit add-on – Door cleaning', 'Each', 10, 'Add-on to a unit clean.', 'Door cleaning.', 'Per visit'],
  ['multifamily', 'Hallway – Basic sweep & mop', 'Hallway', 30, 'Per hallway, per building. All hallways are included per visit.', 'Sweep, mop floors, spot-clean walls.', 'Recurring'],
  ['multifamily', 'Hallway – Standard clean', 'Hallway', 45, 'Per hallway, per building.', 'Sweep, mop, dust baseboards, wipe doors and railings.', 'Recurring'],
  ['multifamily', 'Hallway – Deep clean', 'Hallway', 65, 'Per hallway, per building.', 'Standard clean plus scrub scuff marks, vents and trims.', 'Recurring'],
  ['multifamily', 'Hallway – Carpet hallways', 'Hallway', 40, 'Per hallway, per building.', 'Vacuum, edge clean, spot-treat stains.', 'Recurring'],
  ['multifamily', 'Hallway add-on – Trash removal', 'Floor', 15, 'Add-on, per floor.', 'Trash removal.', 'Recurring'],
  ['multifamily', 'Hallway add-on – Deodorizer treatment', 'Hallway', 10, 'Add-on, per hallway.', 'Deodorizer treatment.', 'Recurring'],
  ['multifamily', 'Hallway add-on – Wall spot cleaning (extensive)', 'Hallway', 25, 'Add-on, per hallway.', 'Extensive wall spot cleaning.', 'Recurring'],
  ['multifamily', 'Hallway add-on – Stairwell cleaning', 'Set', 30, 'Add-on, per stairwell set.', 'Stairwell cleaning.', 'Recurring']
];

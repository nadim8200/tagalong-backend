// ---------------------------------------------------------------
// Owner-operators vs company trucks.
//
// Florida Beauty runs two kinds of truck under one DOT authority:
//
//   COMPANY   — FBE owns the truck, employs the driver.
//   OWNER-OP  — someone else owns the truck and runs it under FBE's
//               authority. FBE dispatches it, but does not own it.
//
// WHY THE DISPATCHER MUST KNOW THE DIFFERENCE
//
// 1. THE OWNER IS NOT THE DRIVER. The names below are the people who own
//    the equipment. Who is behind the wheel on any given day is a separate
//    question, answered by Samsara HOS. Never address an owner as though
//    they are driving, and never assume a fault or an HOS problem is theirs
//    personally.
//
// 2. ESCALATION DIFFERS. A low-DEF warning on a company truck is a note to
//    the shop. The same warning on an owner-op truck is a note to a small
//    business owner about their own asset — different tone, different
//    person, and in some cases not our call to make at all.
//
// 3. OWNERS HOLD MULTIPLE TRUCKS. Five owners hold 3+ trucks each. A single
//    person can have five loads in motion, so "notify the owner" can mean
//    five separate conversations, or one consolidated one. Grouping by owner
//    is what makes that manageable.
//
// 4. TWO NUMBERING SCHEMES. Owner-op trucks are numbered differently from
//    company trucks, which is the likeliest explanation for the unitId /
//    display-name mismatches seen in Samsara (4552→409, 3517→3501). Do not
//    "fix" those until Florida Beauty confirms which scheme is current.
//
// SOURCE: owner list supplied by Florida Beauty, July 2026. Cross-referenced
// against the live Samsara fleet — see COVERAGE below.
// ---------------------------------------------------------------

export const CLASS = { COMPANY: 'company', OWNER_OP: 'owner-op' };

// truck number → owner of the equipment (NOT the driver)
export const OWNER_OPERATORS = {
  358: 'Donaldo Zelaya',
  468: 'Roger Cuadra',
  483: 'Engel A. Rivera',
  724: 'Engel A. Rivera',
  731: 'Carlos Sanchez Lopez',
  733: 'Engel A. Rivera',
  734: 'Engel A. Rivera',
  736: 'Yamil Ricardo',
  744: 'Marcell Garrett',
  807: 'Marcell Garrett',
  888: 'Lester Fernandez',
  977: 'John Walton',
  978: 'John Walton',
  979: 'John Walton',
  1074: 'Edith Kennedy',
  1087: 'Aaron Wilkins',
  1910: 'Rayner Victorero',
  1911: 'Yoeldy Tamayo',
  3512: 'Christopher Williams',
  3514: 'John Walton',
  3517: 'John Walton',
  3519: 'Marc Crawford',
  3520: 'Allen Hull',
  3521: 'Veron Watkins',
  4504: 'Engel A. Rivera',
  4515: 'Donaldo Zelaya',
  4533: 'Enrique Baculima',
  4536: 'Lester Fernandez',
  4543: 'Yoeldy Tamayo',
  4546: 'Lester Fernandez',
  4550: 'Donaldo Zelaya',
  4551: 'Enrique Baculima',
  4552: 'Lester Fernandez',
  4553: 'Yasser Mendoza',
  4554: 'Camilo Ramirez',
  8299: 'Virgil Trent',
  9241: 'Lee Wellington',
};

// Terminal association noted on the source list. Useful for routing, but it
// describes the OWNER's base, not necessarily where the truck runs today.
export const OWNER_TERMINAL = {
  'John Walton': 'Memphis',
  'Marcell Garrett': 'Memphis',
  'Edith Kennedy': 'Memphis',
  'Aaron Wilkins': 'Memphis',
  'Christopher Williams': 'Memphis',
  'Marc Crawford': 'Memphis',
  'Allen Hull': 'Memphis',
  'Veron Watkins': 'Memphis',
  'Virgil Trent': 'Memphis',
  'Lee Wellington': 'Memphis',
  'Yasser Mendoza': 'Tampa',
};

// ---------------------------------------------------------------
// NOT YET SUPPLIED — the dispatcher cannot contact an owner without these.
// Left deliberately empty rather than guessed. Ask Florida Beauty.
// ---------------------------------------------------------------
export const OWNER_CONTACT = {
  // 'John Walton': { phone: '', email: '', preferred: 'sms' },
};

// ---------------------------------------------------------------
// COVERAGE — checked against the live Samsara fleet (170 vehicles).
//
// 31 of 37 owner-op trucks appear in Samsara. These SIX do not:
//
//   977, 1087, 3512, 3520, 3521, 4533
//
// That is a real blind spot, not a data-entry gap: those trucks run under
// Florida Beauty's authority with no telematics we can see. If they are
// still active, the dispatcher is blind to them — no position, no HOS, no
// temperature. Worth asking whether they were sold, or whether they run on
// the owner's own ELD.
// ---------------------------------------------------------------
export const OWNER_OPS_MISSING_FROM_TELEMATICS = [977, 1087, 3512, 3520, 3521, 4533];

const key = (truck) => String(truck == null ? '' : truck).trim();

export function ownerOf(truckNumber) {
  return OWNER_OPERATORS[key(truckNumber)] || null;
}

export function classOf(truckNumber) {
  return ownerOf(truckNumber) ? CLASS.OWNER_OP : CLASS.COMPANY;
}

// Everything the dispatcher needs to decide WHO to tell and HOW.
export function ownershipFor(truckNumber) {
  const owner = ownerOf(truckNumber);
  if (!owner) return { class: CLASS.COMPANY, owner: null, contact: null, terminal: null, fleetmateCount: 0 };
  const fleetmates = trucksFor(owner);
  return {
    class: CLASS.OWNER_OP,
    owner,
    contact: OWNER_CONTACT[owner] || null,
    terminal: OWNER_TERMINAL[owner] || null,
    // How many other trucks this owner has running. If it's high, batch the
    // messages instead of sending five separate ones.
    fleetmateCount: fleetmates.length,
    fleetmates,
  };
}

export function trucksFor(owner) {
  return Object.entries(OWNER_OPERATORS)
    .filter(([, o]) => o === owner)
    .map(([t]) => t);
}

// Owners holding several trucks — the ones where consolidating a message
// matters. Sorted busiest first.
export function ownersByFleetSize() {
  const counts = new Map();
  for (const owner of Object.values(OWNER_OPERATORS)) counts.set(owner, (counts.get(owner) || 0) + 1);
  return [...counts.entries()]
    .map(([owner, trucks]) => ({ owner, trucks, terminal: OWNER_TERMINAL[owner] || null }))
    .sort((a, b) => b.trucks - a.trucks);
}

// Decorate a fleet row (from /fleet/vehicles/full) with ownership.
// Matches on the Samsara display name, which the live data shows is the
// truck number for these units.
export function decorate(vehicle) {
  return { ...vehicle, ownership: ownershipFor(vehicle.name) };
}

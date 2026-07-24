// ---------------------------------------------------------------
// Product definitions — one codebase, several apps.
//
// TagAlong (consumer)  : one family, a few cars, "where is my car and is it OK".
// TagAlong Fleet (B2B) : a company, many vehicles and drivers, "who is driving
//                        what, is the fleet running well, and prove it on paper".
//
// Everything that differs between the apps is declared HERE rather than being
// sprinkled through the UI as `IS_TAGALONG ? ... : ...` checks. When a third
// product appears, it should be a new entry in this file and nothing else.
//
// Selected at build time:  REACT_APP_PRODUCT=fleet npm run build
// or at runtime by domain/query for previewing (?fleet).
// ---------------------------------------------------------------

const COMMON = {
  supportPhone: '3055040711',
  supportPhoneDisplay: '(305) 504-0711',
  company: 'Dynamic BPO LLC',
};

export const PRODUCTS = {
  tagalong: {
    ...COMMON,
    key: 'tagalong',
    name: 'TagAlong',
    tagline: 'Know where your car is — always.',
    bundleId: 'com.dynamicsbpo.tagalong',
    // who the app is for, in the app's own words
    audience: 'consumer',
    features: {
      drivers: false,        // assign drivers to vehicles, per-driver scoring
      fleetDashboard: false, // multi-vehicle overview table
      reports: false,        // scheduled reports + CSV/PDF export
      roles: false,          // multiple logins per account, permission levels
      dispatch: false,       // job assignment / AI dispatching
      routeOptimization: false,
      trackAndTrace: false,  // customer-facing shipment tracking links
      shop: true,            // consumer hardware store
      community: true,       // broker community feed
      rentals: true,         // rental agreements
    },
  },

  // TagAlong Pro — the consumer app, re-skinned for a company. Same screens
  // and same tracking core as consumer TagAlong; the only functional change is
  // rentals are off (a company tracking its own vehicles isn't renting them
  // out). Heavier company features live in Fleet, not here.
  pro: {
    ...COMMON,
    key: 'pro',
    name: 'TagAlong Pro',
    tagline: 'Your company vehicles, always in view.',
    bundleId: 'com.dynamicsbpo.tagalongpro',
    audience: 'business',
    features: {
      drivers: false,
      fleetDashboard: false,
      reports: false,
      roles: false,
      dispatch: false,
      routeOptimization: false,
      trackAndTrace: false,
      shop: true,
      community: true,
      rentals: false, // explicitly off for Pro
    },
  },

  fleet: {
    ...COMMON,
    key: 'fleet',
    name: 'TagAlong Fleet',
    tagline: 'Every vehicle, every driver, one screen.',
    bundleId: 'com.dynamicsbpo.tagalongfleet',
    audience: 'business',
    features: {
      drivers: true,
      fleetDashboard: true,
      reports: true,
      roles: true,
      dispatch: true,
      routeOptimization: true,
      trackAndTrace: true,
      shop: false,       // fleet buys hardware on contract, not in-app
      community: false,  // consumer/broker social features don't belong here
      rentals: false,
    },
  },
};

// ---- which product is this build? ----
function detect() {
  const envKey = process.env.REACT_APP_PRODUCT;
  if (envKey && PRODUCTS[envKey]) return envKey;
  if (typeof window !== 'undefined') {
    const host = window.location.hostname || '';
    const qs = window.location.search || '';
    const path = window.location.pathname || '';
    // The /fleet portal is Fleet regardless of which domain it's served from —
    // otherwise the commercial portal shows consumer branding on localhost and
    // on the shared tagalong domain.
    if (/^\/fleet/i.test(path) || /[?&]fleet\b/i.test(qs) || /fleet/i.test(host)) return 'fleet';
    // Pro is the /pro portal (or ?pro / a pro.* domain), same as Fleet's pattern.
    if (/^\/pro/i.test(path) || /[?&]pro\b/i.test(qs) || /(^|\.)pro\./i.test(host)) return 'pro';
    if (/[?&]tagalong\b/i.test(qs) || /tagalong/i.test(host)) return 'tagalong';
  }
  return 'tagalong';
}

export const PRODUCT = PRODUCTS[detect()];
export const IS_FLEET = PRODUCT.key === 'fleet';

// Feature check used throughout the UI:  if (has('drivers')) { ... }
export const has = (feature) => !!PRODUCT.features[feature];

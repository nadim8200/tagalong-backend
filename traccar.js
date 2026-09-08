// ---------------------------------------------------------------
// Traccar API client for Dynamic Dispatch
// One place to talk to the tracking server.
// ---------------------------------------------------------------

import { GOOGLE_MAPS_KEY, API_BASE } from './config';
import { getCustomers } from './customerStore';
import { dtcCodesFromAttrs } from './vehicleAlerts';
import { PRODUCT, IS_FLEET } from './product';

const TRACCAR_URL = 'https://gps.dynamicsbpo.com';

// The Traccar admin token now lives ONLY on the backend server. The browser never
// holds it — every request goes through the authenticated proxy (API_BASE).

// ---- Backend proxy switch --------------------------------------------------
// When API_BASE is set (config.js), the app talks to the TagAlong BACKEND, which
// holds the token and proxies Traccar. Requests carry the login cookie instead
// of the token. When API_BASE is blank, the app talks to Traccar directly with
// the token (local/private mode — unchanged behaviour). All Traccar URLs and
// auth flow through PROXY/BASE so flipping one flag switches the whole app.
const PROXY = !!API_BASE;
const BASE = PROXY ? `${API_BASE}/api/traccar` : `${TRACCAR_URL}/api`;

// In proxy mode the backend returns a session token on login. We store it and
// send it as a header on every request — this works across domains (localhost →
// onrender, tagalong.app → api), where cross-site cookies get blocked.
const JWT_KEY = 'ta-jwt';
export const getJwt = () => { try { return localStorage.getItem(JWT_KEY) || ''; } catch { return ''; } };
export const setJwt = (t) => { try { if (t) localStorage.setItem(JWT_KEY, t); else localStorage.removeItem(JWT_KEY); } catch { /* ignore */ } };

// ---- Auth mode -----------------------------------------------------------
// Admin (Dynamic Dispatch) uses the shared token above and sees every device.
// A logged-in TagAlong customer uses their Traccar SESSION instead: requests
// go with credentials (the session cookie) and NO admin token, so Traccar
// scopes results to just that customer's own devices. login() flips this on.
const SESSION_KEY = 'ta-session'; // '1' once a customer has logged in

// Customer (session) mode only ever applies on the TagAlong consumer site.
// The admin Dynamic Dispatch app ALWAYS uses the shared admin token so it can
// see every device — even if a customer happened to log in on this same browser.
const IS_TAGALONG_HOST = (() => {
  try {
    return /tagalong/i.test(window.location.hostname)
      || /[?&]tagalong\b/i.test(window.location.search)
      || process.env.REACT_APP_PRODUCT === 'tagalong';
  } catch { return false; }
})();
const inSession = () => {
  if (!IS_TAGALONG_HOST) return false; // admin app never uses a customer session
  try { return localStorage.getItem(SESSION_KEY) === '1'; } catch { return false; }
};

// ---- Customer scoping ----------------------------------------------------
// On the TagAlong site, a logged-in customer must ONLY see the devices assigned
// to their account. Devices are linked by attributes (customerId / account).
// The session COOKIE is unreliable cross-origin (localhost → gps.dynamicsbpo),
// so we can't trust getSession() to tell us who's logged in. Instead we capture
// the customer's identity from the login RESPONSE and cache it locally, then
// match it to their CRM record to build the scope. Admin (and the admin app)
// get a null scope → they see everything.
const ME_KEY = 'ta-me'; // cached Traccar user of the logged-in customer
export function getStoredMe() { try { return JSON.parse(localStorage.getItem(ME_KEY)); } catch { return null; } }
function setStoredMe(u) { try { if (u) localStorage.setItem(ME_KEY, JSON.stringify(u)); else localStorage.removeItem(ME_KEY); } catch { /* ignore */ } }

// ---- Face ID login (biometric quick sign-in) ----------------------------
// After a normal password login, we can stash the session so the user can get
// back in with Face ID next time (no password). The stash survives sign-out.
// Normalize the TRACKER's own backup-battery reading across brands. Different
// units report it differently: `batteryLevel` (%), Teltonika AVL io113 (%),
// `battery` (volts), or io67 (millivolts). Returns { pct, volts, wired } where
// wired=true means the unit has no internal cell and runs off the car — in that
// case we show "wired" rather than a fake 0%.
export function batteryFromAttrs(a = {}) {
  const pctRaw = [a.batteryLevel, a.io113, a.batteryPercentage, a.batLevel]
    .find((x) => x != null && !isNaN(Number(x)) && Number(x) > 0);
  let volts = a.battery != null && !isNaN(Number(a.battery)) ? Number(a.battery) : null;
  if ((volts == null || volts === 0) && a.io67 != null && !isNaN(Number(a.io67))) volts = Number(a.io67) / 1000;
  if (volts != null && volts > 20) volts /= 1000; // some decoders send mV in `battery`

  let pct = null;
  if (pctRaw != null) pct = Math.round(Number(pctRaw));
  else if (volts != null && volts >= 3.0) pct = Math.round(Math.min(100, Math.max(0, ((volts - 3.5) / (4.2 - 3.5)) * 100)));

  const wired = pct == null && (volts == null || volts < 3.0);
  return { pct, volts: volts != null && volts > 0 ? volts : null, wired };
}

const FACEID_KEY = 'ta-faceid-login';
export function saveFaceIdSession() {
  try {
    const jwt = getJwt();
    if (!jwt) return;
    const data = { jwt, me: getStoredMe(), session: localStorage.getItem(SESSION_KEY) || '', at: Date.now() };
    localStorage.setItem(FACEID_KEY, JSON.stringify(data));
  } catch { /* ignore */ }
}
export function hasFaceIdSession() { try { return !!localStorage.getItem(FACEID_KEY); } catch { return false; } }
export function clearFaceIdSession() { try { localStorage.removeItem(FACEID_KEY); } catch { /* ignore */ } }
export function faceIdEmail() { try { const d = JSON.parse(localStorage.getItem(FACEID_KEY) || 'null'); return (d && d.me && d.me.email) || ''; } catch { return ''; } }
// Restore the stashed session (called after a successful Face ID prompt).
export function restoreFaceIdSession() {
  try {
    const d = JSON.parse(localStorage.getItem(FACEID_KEY) || 'null');
    if (!d || !d.jwt) return null;
    setJwt(d.jwt);
    if (d.me) setStoredMe(d.me);
    if (d.session) localStorage.setItem(SESSION_KEY, d.session);
    return d.me || {};
  } catch { return null; }
}

// Resolve the current customer scope from the cached identity + CRM records.
// Returns null (see all) for admin, or { cid, account } for a customer. If we
// know a customer is logged in but can't tie them to an account, we return a
// scope that matches NOTHING (safer than leaking the whole fleet).
function currentScope() {
  // The admin dashboard (Dynamic Dispatch) sets the dd-admin flag and must see
  // EVERY device — never scope it, even if there's no customer identity cached.
  try { if (typeof localStorage !== 'undefined' && localStorage.getItem('dd-admin') === '1') return null; } catch { /* ignore */ }
  if (!IS_TAGALONG_HOST || !inSession()) return null;
  const u = getStoredMe();
  // NOTE: an admin USER signing into the customer app is still scoped to THEIR
  // OWN cars — only the admin DASHBOARD (the dd-admin flag above) sees every
  // car. This is what stops a signed-in person from landing on someone else's
  // account and cars. (Previously any admin user saw the whole fleet here.)
  const email = ((u && u.email) || '').toLowerCase();
  const crm = getCustomers().find((c) => (u && c.traccarUserId && String(c.traccarUserId) === String(u.id)) || (email && c.email && c.email.toLowerCase() === email));
  const account = (crm && crm.account) || (u && u.attributes && u.attributes.account) || '';
  const uid = (u && u.id) || ''; // the customer's Traccar user id — most reliable link
  const cid = (crm && crm.id) || (u && u.attributes && u.attributes.customerId) || '';
  if (!cid && !account && !uid) return { cid: '', account: '__none__', uid: '' }; // logged in but unmatched → see nothing
  return { cid, account: account || '__none__', uid };
}

// Exposed for push registration: the { cid, account } that identifies which cars
// belong to the signed-in customer (so the server can target their alerts).
export function getScope() { return currentScope(); }

function inScope(d, s) {
  if (!s) return true; // admin / see-all
  const a = d.attributes || {};
  if (s.uid && a.ownerUserId != null && String(a.ownerUserId) === String(s.uid)) return true; // owner's user id (most reliable)
  if (s.cid && a.customerId === s.cid) return true;
  if (s.account && s.account !== '__none__' && String(a.account) === String(s.account)) return true;
  return false;
}

// Reads/writes to the fleet always use the shared admin token. Devices are
// linked to customers by attributes (customerId / account), not by Traccar
// user-device permissions, so a customer's own session can't "see" their car.
// The app instead fetches with the token and filters to the customer's account
// on the client (see CarPage). The customer session is still used for identity
// (getSession) and self-profile edits (updateUser).
function authOpts(extra = {}) {
  // Every request carries the signed-in user's JWT (+ cookie). The Traccar admin
  // token is added by the backend proxy, never here.
  const t = getJwt();
  return { credentials: 'include', headers: { ...(t ? { Authorization: `Bearer ${t}` } : {}), ...extra } };
}

// Log a customer in with their Traccar email + password. On success their
// session cookie is set and the client scopes to their devices.
export async function login(email, password) {
  if (PROXY) {
    setStoredMe(null);
    try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(ADMIN_KEY); } catch { /* ignore */ }
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'Wrong email or password.' : `Login failed (${res.status}).`);
    const user = await res.json();
    setJwt(user.token);
    try { localStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
    setStoredMe(user);
    return user;
  }
  // Clean switch: drop any prior session cookie + cached identity FIRST, so a
  // previous account (e.g. an admin/other customer) can't bleed into this login.
  try { await fetch(`${TRACCAR_URL}/api/session`, { method: 'DELETE', credentials: 'include' }); } catch { /* ignore */ }
  setStoredMe(null);
  try { localStorage.removeItem(SESSION_KEY); localStorage.removeItem(ADMIN_KEY); } catch { /* ignore */ }

  const body = new URLSearchParams({ email, password });
  const res = await fetch(`${TRACCAR_URL}/api/session`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'Wrong email or password.' : `Login failed (${res.status}).`);
  const user = await res.json();
  // sanity: the account we got back must match the email we logged in with
  if (user && user.email && user.email.toLowerCase() !== String(email).toLowerCase()) {
    try { await fetch(`${TRACCAR_URL}/api/session`, { method: 'DELETE', credentials: 'include' }); } catch { /* ignore */ }
    throw new Error('Login returned a different account — please try again.');
  }
  try { localStorage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
  setStoredMe(user); // cache identity so scoping works without the cross-origin cookie
  return user; // { id, name, email, ... }
}
// Self sign-up. Works when the Traccar server has registration enabled
// (web.registration=true). Creates the customer's user; the admin then links
// their device. Password is set by the customer — never handled by us.
export async function registerUser({ name, email, password, phone }) {
  const res = await fetch(`${API_BASE}/auth/register`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, password, phone }),
  });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Sign-up failed (${res.status}).`); }
  return res.json();
}
// Admin creates a login FOR a customer (phone-initiated track). Uses the admin
// token so it works regardless of the public registration toggle. The account
// is flagged mustSetPassword so the customer is forced to choose a new password
// on first sign-in. Returns { user, tempPassword } so the admin can relay it.
export async function adminCreateUser({ name, email, phone }) {
  const res = await fetch(`${API_BASE}/auth/admin/create-user`, {
    method: 'POST', credentials: 'include', headers: { ...authOpts().headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, email, phone }),
  });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Couldn't create the login (${res.status}).`); }
  return res.json(); // { user, tempPassword }
}

// Request a password-reset email. Works when the server has email (SMTP) set up.
export async function requestPasswordReset(email) {
  const res = await fetch(`${API_BASE}/auth/password-reset`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `Couldn’t send the reset email (${res.status}).`); }
  return true;
}

// ---- Admin (Dynamic Dispatch) gate --------------------------------------
// The admin dashboard is protected by its own login. We verify the email +
// password against the Traccar server and require the account to be an
// administrator. On success we set a LOCAL admin flag only — API calls keep
// using the shared admin token, and we never leave a customer session cookie
// behind (which would scope /devices to one user and break the fleet view).
const ADMIN_KEY = 'dd-admin'; // '1' once an administrator has signed in here
const ADMIN_ME_KEY = 'dd-admin-me'; // the admin's OWN identity (so their app view defaults to their own account)
export function getAdminMe() { try { return JSON.parse(localStorage.getItem(ADMIN_ME_KEY)); } catch { return null; } }
function setAdminMe(user) {
  try {
    if (!user) { localStorage.removeItem(ADMIN_ME_KEY); return; }
    const a = user.attributes || {};
    localStorage.setItem(ADMIN_ME_KEY, JSON.stringify({ id: user.id, email: user.email || '', name: user.name || '', account: a.account || '' }));
  } catch { /* ignore */ }
}
export async function loginAdmin(email, password) {
  if (PROXY) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(res.status === 401 ? 'Wrong email or password.' : `Login failed (${res.status}).`);
    const user = await res.json();
    if (!(user.admin || user.administrator)) { throw new Error('That account is not an administrator.'); }
    setJwt(user.token);
    // Clear any leftover CUSTOMER identity (e.g. a previous "View as customer"
    // or a customer login on this browser) so the TagAlong tab doesn't greet the
    // admin as that customer. An admin isn't a customer.
    setStoredMe(null);
    setAdminMe(user); // remember WHO the admin is, so their app view opens on their own account
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    try { localStorage.setItem(ADMIN_KEY, '1'); } catch { /* ignore */ }
    return user;
  }
  const body = new URLSearchParams({ email, password });
  const res = await fetch(`${TRACCAR_URL}/api/session`, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'Wrong email or password.' : `Login failed (${res.status}).`);
  const user = await res.json();
  // must be an administrator — regular customers can't open the admin app
  if (!user.administrator) {
    try { await fetch(`${TRACCAR_URL}/api/session`, { method: 'DELETE', credentials: 'include' }); } catch { /* ignore */ }
    throw new Error('That account is not an administrator.');
  }
  // we don't rely on the session cookie for admin API calls (the token does
  // that) — drop it so nothing lingers, then set our local admin flag.
  try { await fetch(`${TRACCAR_URL}/api/session`, { method: 'DELETE', credentials: 'include' }); } catch { /* ignore */ }
  // Clear any leftover CUSTOMER identity so the TagAlong tab doesn't greet the
  // admin as a previously logged-in / previewed customer.
  setStoredMe(null);
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  try { localStorage.setItem(ADMIN_KEY, '1'); } catch { /* ignore */ }
  return user;
}
export const isAdmin = () => { try { return localStorage.getItem(ADMIN_KEY) === '1'; } catch { return false; } };
export const logoutAdmin = () => { try { localStorage.removeItem(ADMIN_KEY); setAdminMe(null); } catch { /* ignore */ } if (PROXY) setJwt(''); };

export async function getSession() {
  if (PROXY) { const res = await fetch(`${API_BASE}/auth/me`, authOpts()); if (!res.ok) return null; return res.json(); }
  const res = await fetch(`${TRACCAR_URL}/api/session`, { credentials: 'include' });
  if (!res.ok) return null;
  return res.json();
}
export async function logout() {
  try {
    if (PROXY) await fetch(`${API_BASE}/auth/logout`, { method: 'POST', ...authOpts() });
    else await fetch(`${TRACCAR_URL}/api/session`, { method: 'DELETE', credentials: 'include' });
  } catch { /* ignore */ }
  if (PROXY) setJwt('');
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  setStoredMe(null);
}
export const isLoggedIn = inSession;
// a logged-in customer can update their OWN Traccar user (name + attributes:
// phone, email, photo, lang, billing).
export async function updateUser(user) {
  // The signed-in identity carries backend-session fields (token = our JWT, role,
  // admin) that are NOT part of Traccar's user schema — Traccar rejects the JWT in
  // its short `token` field with a 400. Strip them before saving.
  const { token, role, admin, ...clean } = user;
  const res = await fetch(`${BASE}/users/${clean.id}`, {
    method: 'PUT', ...authOpts({ 'Content-Type': 'application/json' }), body: JSON.stringify(clean),
  });
  if (!res.ok) throw new Error(`Couldn't save profile (${res.status}).`);
  return res.json();
}

// Permanently delete the signed-in customer's own account (App Store Guideline
// 5.1.1(v)). The backend removes the Traccar login + personal data (push tokens,
// alert history) and flags the tracker as "account deleted" on our side. Clears
// the local session on success so the app drops back to the sign-in screen.
export async function deleteAccount() {
  if (!PROXY) throw new Error('Account deletion needs the app backend.');
  const res = await fetch(`${API_BASE}/account`, {
    method: 'DELETE', ...authOpts({ 'Content-Type': 'application/json' }),
  });
  if (!res.ok) {
    const b = await res.json().catch(() => ({}));
    throw new Error(b.error || `Couldn't delete account (${res.status}).`);
  }
  try { setJwt(''); localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  setStoredMe(null);
  return res.json().catch(() => ({ ok: true }));
}

async function api(path) {
  const res = await fetch(`${BASE}${path}`, authOpts());
  if (!res.ok) throw new Error(`Traccar ${path} failed: ${res.status}`);
  return res.json();
}

async function apiSend(path, method, body) {
  const res = await fetch(`${BASE}${path}`, {
    method, ...authOpts({ 'Content-Type': 'application/json' }),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Traccar ${method} ${path} failed: ${res.status}`);
  return res.status === 204 ? null : res.json();
}

export const getUsers = () => api('/users'); // admin only — every Traccar user
// Every device list is scoped to the logged-in customer on the TagAlong site
// (admin gets all). getFleet() calls this, so the map/health/alerts pages all
// inherit the same scoping automatically.
export async function getDevices() {
  const all = await api('/devices');
  const scope = currentScope();
  if (!scope) return all; // admin / see-all
  let list = all.filter((d) => inScope(d, scope));
  // ALSO include cars this person was approved to view as a family member. Those
  // links live on the device (attributes.memberLinks, memberId = `u<userId>`), so
  // a shared/family viewer sees the same cars on the map, health and alerts pages
  // that they see on the TagAlong tab — not just the ones they own.
  // If we got here the person is SCOPED (the admin dashboard returned early
  // above with the full list), so every filter below applies to them — an admin
  // USER in the customer app is treated exactly like a customer, seeing only
  // their own cars.
  const me = getStoredMe();
  if (me) {
    const memberId = `u${me.id}`;
    const seen = new Set(list.map((d) => d.id));
    all.forEach((d) => {
      const links = (d.attributes && d.attributes.memberLinks) || [];
      if (!seen.has(d.id) && links.some((x) => x.memberId === memberId && x.status === 'approved')) {
        list.push(d); seen.add(d.id);
      }
    });
  }
  // Portal routing by the device's `product` tag (set in admin Device Intake):
  // a Pro portal only shows product:'pro' cars; consumer TagAlong shows the
  // consumer/untagged ones. This is what makes picking "TagAlong Pro" on a
  // device move it into the Pro app. Admins are EXEMPT — an admin account sees
  // every car regardless of product, on any portal. Fleet has its own scoping.
  if (!IS_FLEET) {
    const portal = PRODUCT.key; // 'tagalong' | 'pro'
    list = list.filter((d) => {
      const dp = ((d.attributes || {}).product) || 'tagalong';
      if (portal === 'pro') return dp === 'pro';
      return dp === 'tagalong'; // consumer: hide pro/fleet/dispatch-tagged cars
    });
  }
  // Membership gate: a device whose paid membership has lapsed (expiration date
  // reached) or was manually stopped is hidden from the customer — tracking and
  // reporting stop until it's renewed. (The admin DASHBOARD, scope null, returns
  // the full list earlier and never reaches here.)
  list = list.filter((d) => membershipActive(d));
  return list;
}
// Unscoped — every device (used by the broker portal to resolve a car share code).
export const getAllDevices = () => api('/devices');

// Global shared store: the Traccar server object's `attributes` map is readable
// AND writable with the shared admin token, so every broker (on any device, any
// state) reads/writes the same data. Used as the broker-community backend.
export const getServer = () => api('/server');
export const updateServer = (server) => apiSend('/server', 'PUT', server);
export const getPositions = () => api('/positions');
export const createDevice = (device) => apiSend('/devices', 'POST', device);
export const updateDevice = (device) => apiSend(`/devices/${device.id}`, 'PUT', device);
// Admin: permanently remove a device from Traccar. This frees its IMEI so the
// same tracker can be re-added fresh on the Device Intake page.
export const deleteDevice = (id) => apiSend(`/devices/${id}`, 'DELETE');

// ---- Admin: assign a device to a customer account -----------------------
// Devices belong to a customer by attribute (ownerUserId / customerId / account
// — see inScope). Assigning writes all three so the customer's scoped view
// (getDevices) picks it up; unassigning clears them so it disappears from their
// app. Admin-only (uses the shared token).
export async function assignDeviceToCustomer(device, { userId = '', customerId = '', account = '' } = {}) {
  const updated = { ...device, attributes: { ...(device.attributes || {}), ownerUserId: userId || undefined, customerId: customerId || undefined, account: account || undefined } };
  await updateDevice(updated);
  return updated;
}
export async function unassignDevice(device) {
  const a = { ...(device.attributes || {}) };
  delete a.ownerUserId; delete a.customerId; delete a.account;
  const updated = { ...device, attributes: a };
  await updateDevice(updated);
  return updated;
}
// ---- Admin: a device assigned to MULTIPLE accounts (device-first view) ------
// Canonical list lives in attributes.owners = [{ userId, customerId, account, name }].
// We also mirror it onto the fields the customer app already scopes by, so every
// assigned account sees the device: the FIRST owner becomes the primary
// (ownerUserId/customerId/account) and ALL of them get an approved memberLink
// (by:'admin'), which is how a device shows for more than one account at once.
// "TA" is the TagAlong HOUSE / unclaimed pool account that every tracker is
// created under at Device Intake — it is NOT a real customer, so it must never
// show up (or count) as an owner. A device sitting on the TA pool reads as
// UNASSIGNED until a real account is put on it.
const isHouseOwner = (o) => o && !o.userId && !o.customerId && String(o.account || '').toUpperCase() === 'TA';
export function deviceOwners(device) {
  const a = (device && device.attributes) || {};
  if (Array.isArray(a.owners) && a.owners.length) return a.owners.filter((o) => !isHouseOwner(o));
  // back-compat: a device assigned the old single-owner way (but the bare TA
  // house pool doesn't make it "owned")
  if (a.ownerUserId || a.customerId || (a.account && String(a.account).toUpperCase() !== 'TA')) {
    return [{ userId: a.ownerUserId || '', customerId: a.customerId || '', account: a.account || '', name: a.ownerName || '' }];
  }
  return [];
}
export async function setDeviceOwners(device, ownersIn) {
  const base = { ...(device.attributes || {}) };
  // Never persist the house "TA" pool as an owner — assigning a real account
  // should drop that leftover placeholder, not keep it as primary.
  const owners = (ownersIn || []).filter((o) => o && !isHouseOwner(o));
  const keepLinks = (base.memberLinks || []).filter((m) => m && m.by !== 'admin'); // preserve family/broker shares
  const adminLinks = owners.filter((o) => o && o.userId).map((o) => ({ memberId: `u${o.userId}`, name: o.name || '', status: 'approved', by: 'admin', at: Date.now() }));
  const primary = owners[0] || {};
  // Membership: the first time a device is assigned to any account it "goes
  // active" — stamp the activation date (today) and auto-fill an expiration
  // (activation + MEMBERSHIP_DAYS). Both are editable later on the Devices page.
  let membership = base.membership;
  const nowAssigned = (owners || []).some((o) => o && o.userId);
  if (nowAssigned && (!membership || !membership.activatedAt)) {
    const today = ymd(Date.now());
    membership = { ...(membership || {}), activatedAt: today, expiresAt: addDaysYmd(today, MEMBERSHIP_DAYS), suspended: false };
  }
  const attributes = {
    ...base,
    owners,
    ownerUserId: primary.userId || undefined,
    customerId: primary.customerId || undefined,
    // when there's no real owner left, return the device to the house pool ("TA")
    account: owners.length ? (primary.account || undefined) : 'TA',
    memberLinks: [...keepLinks, ...adminLinks],
    ...(membership ? { membership } : {}),
  };
  const updated = { ...device, attributes };
  await updateDevice(updated);
  return updated;
}

// ---- Membership / expiration ------------------------------------------------
// A device's paid membership lives on the device itself (attributes.membership):
//   { activatedAt: 'YYYY-MM-DD', expiresAt: 'YYYY-MM-DD', suspended: bool }
// When it lapses (expiresAt reached) or an admin manually stops it, the customer
// stops seeing it on Live Tracking and in reporting until it's renewed.
export const MEMBERSHIP_DAYS = 365; // default paid period (1 year), auto-filled on activation
const ymd = (d) => { const x = new Date(d); const p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}`; };
const addDaysYmd = (s, days) => { const [y, m, d] = String(s).split('-').map(Number); const dt = new Date(y, m - 1, d); dt.setDate(dt.getDate() + days); return ymd(dt); };

export function deviceMembership(device) {
  const m = ((device && device.attributes) || {}).membership || {};
  return { activatedAt: m.activatedAt || '', expiresAt: m.expiresAt || '', suspended: !!m.suspended };
}

// 'active' | 'expired' | 'suspended' | 'unassigned'
export function membershipStatus(device) {
  if (!deviceOwners(device).length) return 'unassigned';
  const m = deviceMembership(device);
  if (m.suspended) return 'suspended';
  if (m.expiresAt && ymd(Date.now()) >= m.expiresAt) return 'expired'; // stops ON the expiration date
  return 'active';
}
// A device is "live" (should track/report for the customer) unless it's expired
// or manually stopped. Unassigned devices are only ever seen by admins anyway.
export function membershipActive(device) {
  const s = membershipStatus(device);
  return s === 'active' || s === 'unassigned';
}

export async function setDeviceMembership(device, patch) {
  const base = { ...(device.attributes || {}) };
  base.membership = { ...(base.membership || {}), ...patch };
  const updated = { ...device, attributes: base };
  await updateDevice(updated);
  return updated;
}

// True if this device currently belongs to the given customer (by CRM id or login id).
export function deviceBelongsTo(device, { customerId = '', userId = '' } = {}) {
  const a = (device && device.attributes) || {};
  if (userId && a.ownerUserId != null && String(a.ownerUserId) === String(userId)) return true;
  if (customerId && a.customerId != null && String(a.customerId) === String(customerId)) return true;
  return false;
}

// ---- Admin: per-profile app config (what the customer sees) --------------
// Stored on the customer's OWN Traccar user under attributes.appConfig (JSON):
//   { hidden: ['/rentals', ...], plan: 'track' }
// The customer app reads its own attributes (getStoredMe) via appConfigFor().
export function appConfigFor(me) {
  try {
    const raw = me && me.attributes && me.attributes.appConfig;
    if (!raw) return { hidden: [] };
    const cfg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return { hidden: Array.isArray(cfg.hidden) ? cfg.hidden : [], ...cfg };
  } catch { return { hidden: [] }; }
}
export async function adminSaveUserConfig(user, cfg) {
  const clean = { ...user, attributes: { ...(user.attributes || {}), appConfig: JSON.stringify(cfg) } };
  return updateUser(clean);
}

// Remote commands (engine cut / restore) — device must have an output wired
export const sendEngineStop = (deviceId) => apiSend('/commands/send', 'POST', { deviceId, type: 'engineStop' });
export const sendEngineResume = (deviceId) => apiSend('/commands/send', 'POST', { deviceId, type: 'engineResume' });

// ---- Geofences (used for automatic pickup/delivery detection) ----
// no arg → all geofences; pass a deviceId to get only the ones linked to that car
export const getGeofences = (deviceId) => api(deviceId ? `/geofences?deviceId=${deviceId}` : '/geofences');
export const createGeofence = (name, lat, lng, radiusMeters = 300) =>
  apiSend('/geofences', 'POST', { name, area: `CIRCLE (${lat} ${lng}, ${radiusMeters})` });
export const deleteGeofence = (id) => apiSend(`/geofences/${id}`, 'DELETE');
export const linkGeofenceToDevice = (deviceId, geofenceId) =>
  apiSend('/permissions', 'POST', { deviceId, geofenceId });

// geofence enter/exit events for a device over a time window
export async function getGeofenceEvents(deviceId, minutes = 1440) {
  const to = new Date().toISOString();
  const from = new Date(Date.now() - minutes * 60000).toISOString();
  const res = await fetch(`${BASE}/reports/events?deviceId=${deviceId}&type=geofenceEnter&type=geofenceExit&from=${from}&to=${to}`, authOpts({ Accept: 'application/json' }));
  if (!res.ok) throw new Error(`Traccar geofence events failed: ${res.status}`);
  return res.json();
}

// Free reverse/forward geocoding via OpenStreetMap. Returns {lat, lng} or null.
export async function geocode({ address, city, state, zip }) {
  const parts = [address, city, state, zip].filter(Boolean).join(', ');
  const q = parts || zip;
  if (!q) return null;
  // 1) Google Geocoding — handles abbreviations, directionals, ordinals ("nw 87 ct")
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&region=us&key=${GOOGLE_MAPS_KEY}`);
    const d = await r.json();
    if (d.status === 'OK' && d.results && d.results[0]) {
      const loc = d.results[0].geometry.location;
      return { lat: loc.lat, lng: loc.lng, formatted: d.results[0].formatted_address };
    }
  } catch { /* fall through */ }
  // 2) OpenStreetMap / Nominatim fallback (expand abbreviations so "nw 87 ct"
  //    becomes "NW 87th Court", which Nominatim can actually match)
  const suf = { ct: 'Court', dr: 'Drive', ave: 'Avenue', av: 'Avenue', blvd: 'Boulevard', ln: 'Lane', tr: 'Trail', trl: 'Trail', rd: 'Road', st: 'Street', pkwy: 'Parkway', hwy: 'Highway', ter: 'Terrace', terr: 'Terrace', pl: 'Place', cir: 'Circle', ct2: 'Court' };
  const ordinal = (n) => { const v = +n, d = v % 100; return v + (d > 3 && d < 21 ? 'th' : ['th', 'st', 'nd', 'rd'][v % 10] || 'th'); };
  const norm = q.replace(/\b(\d+)\s+(ct|dr|ave|av|blvd|ln|tr|trl|rd|st|pkwy|hwy|ter|terr|pl|cir)\b/gi, (m, n, ab) => `${ordinal(n)} ${suf[ab.toLowerCase()] || ab}`);
  for (const qq of [q, norm].filter((v, i, a) => a.indexOf(v) === i)) {
    try {
      const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&q=${encodeURIComponent(qq)}`);
      const data = await res.json();
      if (data[0]) return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon), formatted: data[0].display_name };
    } catch { /* try next */ }
  }
  return null;
}

// Address autocomplete as the user types. Returns [{ description, lat?, lng? }].
// Tries Google Places Autocomplete (New) — clean US addresses — then falls back
// to OpenStreetMap search (which also carries coordinates so selection is exact).
export async function addressSuggest(text) {
  const q = (text || '').trim();
  if (q.length < 3) return [];
  // 1) Google Places Autocomplete (New) — best UX, but needs the Places API (New)
  //    enabled on the key. If it isn't, this returns nothing and we fall through.
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:autocomplete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': GOOGLE_MAPS_KEY },
      body: JSON.stringify({ input: q, includedRegionCodes: ['us'] }),
    });
    if (r.ok) {
      const d = await r.json();
      const list = (d.suggestions || [])
        .map((s) => s.placePrediction && { description: s.placePrediction.text && s.placePrediction.text.text, placeId: s.placePrediction.placeId })
        .filter((x) => x && x.description);
      if (list.length) return list.slice(0, 5);
    }
  } catch { /* fall through */ }
  // 2) Google Geocoding — the same key/endpoint the app already geocodes with, so
  //    it returns real Google matches (with exact coordinates) as you type.
  try {
    const r = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(q)}&components=country:US&key=${GOOGLE_MAPS_KEY}`);
    const d = await r.json();
    if (d.status === 'OK' && d.results && d.results.length) {
      return d.results.slice(0, 5).map((x) => ({ description: x.formatted_address, lat: x.geometry.location.lat, lng: x.geometry.location.lng }));
    }
  } catch { /* fall through */ }
  // 3) OpenStreetMap / Nominatim — last resort (weakest for US house numbers)
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=json&addressdetails=0&limit=5&countrycodes=us&q=${encodeURIComponent(q)}`);
    const data = await res.json();
    return (data || []).map((x) => ({ description: x.display_name, lat: parseFloat(x.lat), lng: parseFloat(x.lon) }));
  } catch { return []; }
}

// Resolve a Google Places prediction (by placeId) to coordinates.
export async function placeDetails(placeId) {
  if (!placeId) return null;
  try {
    const r = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      headers: { 'X-Goog-Api-Key': GOOGLE_MAPS_KEY, 'X-Goog-FieldMask': 'location,formattedAddress' },
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (d.location) return { lat: d.location.latitude, lng: d.location.longitude, formatted: d.formattedAddress };
  } catch { /* ignore */ }
  return null;
}

// Driving distance + time between two points, via the Routes API (traffic-aware).
// Returns { meters, seconds } or null. Cached briefly so repeated chat questions
// don't burn quota.
const _routeCache = {};
export async function computeRoute(origin, destination) {
  if (!origin || !destination || origin.lat == null || destination.lat == null) return null;
  const key = `${origin.lat.toFixed(4)},${origin.lng.toFixed(4)}>${destination.lat.toFixed(4)},${destination.lng.toFixed(4)}`;
  const hit = _routeCache[key];
  if (hit && Date.now() - hit.at < 60000) return hit.val; // 1-minute cache
  try {
    const r = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': GOOGLE_MAPS_KEY,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
      },
      body: JSON.stringify({
        origin: { location: { latLng: { latitude: origin.lat, longitude: origin.lng } } },
        destination: { location: { latLng: { latitude: destination.lat, longitude: destination.lng } } },
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_AWARE',
      }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    const route = d.routes && d.routes[0];
    if (!route) return null;
    const val = { meters: route.distanceMeters || 0, seconds: route.duration ? parseInt(String(route.duration).replace('s', ''), 10) || 0 : 0 };
    _routeCache[key] = { at: Date.now(), val };
    return val;
  } catch { return null; }
}

async function report(path, deviceId, from, to) {
  const res = await fetch(`${BASE}/reports/${path}?deviceId=${deviceId}&from=${from}&to=${to}`, authOpts({ Accept: 'application/json' }));
  if (!res.ok) throw new Error(`Traccar ${path} failed: ${res.status}`);
  return res.json();
}

export const getRouteReport = (deviceId, from, to) => report('route', deviceId, from, to);
export const getTripsReport = (deviceId, from, to) => report('trips', deviceId, from, to);
export const getStopsReport = (deviceId, from, to) => report('stops', deviceId, from, to);
export const getEventsReport = (deviceId, from, to) => report('events', deviceId, from, to);
// Fetch specific positions by their ids — used to pin an event (harsh brake,
// speeding, etc.) on the alert-detail map.
export const getPositionsByIds = (ids) => (ids && ids.length
  ? api(`/positions?${ids.map((i) => `id=${i}`).join('&')}`).catch(() => [])
  : Promise.resolve([]));

// Daily driving summary for a device (distance, avg/max speed, engine hours, fuel)
export async function getSummaryReport(deviceId, from, to) {
  const res = await fetch(`${BASE}/reports/summary?deviceId=${deviceId}&from=${from}&to=${to}`, authOpts({ Accept: 'application/json' }));
  if (!res.ok) throw new Error(`Traccar summary failed: ${res.status}`);
  const data = await res.json();
  return data[0] || null;
}

// Recent alarm events (harsh braking/acceleration, etc.) from the last few minutes
export async function getRecentAlarmEvents(deviceIds, minutes = 5) {
  if (!deviceIds.length) return [];
  const to = new Date().toISOString();
  const from = new Date(Date.now() - minutes * 60000).toISOString();
  const params = deviceIds.map((id) => `deviceId=${id}`).join('&');
  const res = await fetch(`${BASE}/reports/events?${params}&from=${from}&to=${to}&type=alarm`, authOpts({ Accept: 'application/json' }));
  if (!res.ok) throw new Error(`Traccar events failed: ${res.status}`);
  return res.json();
}

// Reverse-geocode a point to its road name + OSM road class (for "on a highway" checks)
export async function reverseGeocode(lat, lng) {
  try {
    const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&zoom=17&lat=${lat}&lon=${lng}`);
    const d = await r.json();
    const ad = d.address || {};
    return { road: ad.road || ad.motorway || ad.trunk || '', roadClass: d.class || '', roadType: d.type || '', display: d.display_name || '' };
  } catch { return null; }
}

// Recent events of ANY type (geofence enter/exit, etc.) across devices
export async function getRecentEvents(deviceIds, minutes = 15) {
  if (!deviceIds.length) return [];
  const to = new Date().toISOString();
  const from = new Date(Date.now() - minutes * 60000).toISOString();
  const params = deviceIds.map((id) => `deviceId=${id}`).join('&');
  const res = await fetch(`${BASE}/reports/events?${params}&from=${from}&to=${to}`, authOpts({ Accept: 'application/json' }));
  if (!res.ok) throw new Error(`Traccar events failed: ${res.status}`);
  return res.json();
}

// Drivers are stored on the Traccar server, so they survive browsers/devices
export const getDrivers = () => api('/drivers');
export const createDriver = (driver) => apiSend('/drivers', 'POST', driver);
export const updateDriver = (driver) => apiSend(`/drivers/${driver.id}`, 'PUT', driver);

export const knotsToMph = (kn) => Math.round((kn || 0) * 1.15078);

// Friendly names for the Teltonika FMM00A OBD "io" elements
export function obdInfo(attrs = {}) {
  return {
    rpm: attrs.io36,
    fuelLevel: attrs.io48, // %
    coolantTemp: attrs.io32, // °C
    obdSpeedKmh: attrs.io37, // km/h from the ECU
    throttle: attrs.io41, // %
    engineLoad: attrs.io31, // %
    dtcCount: attrs.io30, // number of fault codes
    ecuVoltage: attrs.io51 != null ? +(attrs.io51 / 1000).toFixed(2) : undefined, // V
    ambientTemp: attrs.io53, // °C
    vin: attrs.vin,
    power: attrs.power, // vehicle battery, V
    ignition: attrs.ignition,
    odometerKm: attrs.totalDistance != null ? Math.round(attrs.totalDistance / 1000) : undefined,
  };
}

// "Engine on" — the tracker's ignition flag is AUTHORITATIVE when it reports one
// (configure the device's ignition source to Engine RPM on OBD units so the flag
// is accurate). We do NOT infer "on" from voltage: a resting battery can sit at
// 13.0–13.4 V for a while after shut-off, which used to make a parked car read ON.
//   • ignition flag true  → ON
//   • ignition flag false → OFF (unless it's clearly driving — flaky-flag safety)
//   • no ignition flag    → infer from motion / OBD RPM
export function engineOn(posAttrs = {}, speedKnots = 0) {
  const mph = knotsToMph(speedKnots);
  const rpm = Number(posAttrs.io36) || 0;
  const volts = Number(posAttrs.power) || 0;
  // 1) Engine RPM is the only signal that can't lie — an OBD tracker sees it
  //    only when the engine is actually turning. Idling reads ON here.
  if (rpm > 200) return true;
  // 2) Charging voltage (>13.2V) = the alternator is spinning = engine running,
  //    even at idle with no RPM reported.
  if (volts >= 13.2) return true;
  // 3) Clearly driving = on (covers trackers with no OBD/RPM at all).
  if (mph > 3) return true;
  // 4) The raw ignition flag is DELIBERATELY NOT trusted — on these OBD cars it
  //    reads true at rest battery voltage (~12.8V) while the engine is off, which
  //    showed parked cars as "ON". No RPM, no charging, not moving → off.
  return false;
}

// The one call the map needs: every vehicle with its latest position + OBD data
export async function getFleet() {
  const [devices, positions] = await Promise.all([getDevices(), getPositions()]);
  const posByDevice = {};
  positions.forEach((p) => { posByDevice[p.deviceId] = p; });

  return devices
    .map((d) => {
      const p = posByDevice[d.id];
      const attrs = d.attributes || {};
      // Freshness = when the last real DATA RECORD arrived (not the network
      // keepalive). We use the newest of the position's own timestamps; the
      // device's "last connection" is deliberately excluded, because a tracker
      // can hold the connection open with heartbeats long after the engine is off
      // — trusting it made a parked car read "ON" from a stale record. If no new
      // record in 7 min we treat the engine state as unknown → OFF.
      const times = p ? [p.serverTime, p.deviceTime, p.fixTime] : [];
      const lastSeen = Math.max(0, ...times.map((t) => (t ? new Date(t).getTime() : 0)));
      const isStale = lastSeen ? (Date.now() - lastSeen > 7 * 60 * 1000) : true;
      const ign = p ? (isStale ? false : engineOn(p.attributes, p.speed)) : undefined;
      // A tracker that has gone to sleep keeps re-reporting the LAST speed it
      // saw, so a parked car reads "9 mph" forever. If we haven't heard from it
      // recently, the engine is off, or the tracker itself says it isn't in
      // motion, then the car is stopped — report 0 rather than a ghost speed.
      const movingNow = !!p && !isStale && ign !== false && p.attributes.motion !== false;
      // A tracker with no GPS lock reports 0,0 ("null island"). That's not a real
      // location — but the car must NOT vanish from the app because of it. So we
      // null the coordinates and flag noFix: the car still shows in every list and
      // count, it just doesn't get a map pin until it locks GPS again.
      const hasFix = !!p && p.latitude != null && p.longitude != null
        && !(Math.abs(p.latitude) < 0.001 && Math.abs(p.longitude) < 0.001);
      return {
        id: d.id,
        name: attrs.displayName || d.name, // customer's chosen name (falls back to the reference)
        ref: d.name, // permanent backend reference (account/serial) — never changes
        status: d.status, // online | offline | unknown
        lastUpdate: d.lastUpdate,
        speedWarnMph: Number(attrs.speedWarnMph) || null,
        speedMaxMph: Number(attrs.speedMaxMph) || null,
        rpmAlertRpm: Number(attrs.rpmAlertRpm) || null,
        noFix: !hasFix, // true = no current GPS lock (parked with no signal, etc.)
        latitude: hasFix ? p.latitude : null,
        longitude: hasFix ? p.longitude : null,
        speedMph: movingNow ? knotsToMph(p.speed) : 0,
        fixTime: p ? p.fixTime : null,
        course: p ? p.course : 0, // heading in degrees
        rssi: p ? p.attributes.rssi : undefined, // GSM signal 0-5
        deviceBattery: p ? batteryFromAttrs(p.attributes).volts : undefined, // tracker's internal battery, V
        batteryLevel: p ? batteryFromAttrs(p.attributes).pct : undefined, // % (normalized across trackers)
        batteryWired: p ? batteryFromAttrs(p.attributes).wired : undefined, // true = no internal cell
        sat: p ? p.attributes.sat : undefined, // satellites
        motion: p ? !!p.attributes.motion : false,
        // parked/asleep only if we truly haven't heard from it in >5 min.
        stale: isStale,
        ignition: ign,
        obd: p ? obdInfo(p.attributes) : {},
        dtcCodes: p ? dtcCodesFromAttrs(p.attributes) : [], // actual check-engine codes (e.g. U3017)
        healthAcks: attrs.healthAcks, // server-side "marked resolved" state (synced across profiles)
      };
    });
  // NOTE: we no longer drop no-fix cars here. They come back with latitude/
  // longitude = null and noFix = true, so they still appear in every vehicle
  // list and count; the map simply skips their pin (and never centers on 0,0)
  // until they lock GPS again. Dropping them made a parked car disappear.
}

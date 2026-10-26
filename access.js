// ---------------------------------------------------------------
// Who may do what — enforced on the SERVER, not by hiding screens.
// The Traccar proxy (/api/traccar/*) talks to Traccar with admin credentials, so for every account that
// isn't an admin it only lets through what that kind of account's own app uses: its cars' devices /
// positions / reports, its geofences, its own profile — never other users, sessions, server settings or
// permissions, and an engine stop / resume only on a car that account owns.
// ---------------------------------------------------------------
export const isAdminUser = (u) => !!(u && (u.admin || u.role === 'admin'));

// Express gate: only these roles (admins always pass).
export const allowRoles = (...roles) => (req, res, next) => {
  const u = req.user;
  if (isAdminUser(u) || (u && roles.includes(u.role))) return next();
  return res.status(403).json({ error: 'Your account does not include this service.' });
};

// a Traccar path that tries to escape its folder (./devices, ../users, %2e, double slashes) → refuse. Pure.
export const sneakyPath = (p) => /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\|\/\//i.test(String(p || '')) || /^\//.test(String(p || ''));

// method + Traccar path (+ body) for a non-admin → { ok } | { ok, device: id } (the server then checks the
// account owns that car) | { ok, body } (forward this cleaned body) | { deny }. Pure.
const PROFILE_LOCKED = ['administrator', 'readonly', 'disabled', 'deviceLimit', 'userLimit', 'deviceReadonly', 'limitCommands', 'disableReports', 'expirationTime', 'manager', 'fixedEmail'];
const PROFILE_ATTR_LOCKED = ['account', 'customerId', 'appConfig', 'mustSetPassword', 'role'];
export function proxyRule(user, method, path, body = null) {
  if (isAdminUser(user)) return { ok: true };
  const role = user && user.role;
  const m = String(method || 'GET').toUpperCase();
  const p = String(path || '').replace(/\/+$/, '');
  if (!role || role === 'dispatcher') return { deny: 'not available' };
  if (sneakyPath(p)) return { deny: 'bad path' };
  const [seg, id, more] = p.split('/');
  const read = m === 'GET' || m === 'HEAD';
  if (role === 'fleet') return read && ['devices', 'positions'].includes(seg) ? { ok: true } : { deny: 'fleet accounts only read their vehicles' };
  if (read) {
    if (['devices', 'positions', 'drivers', 'geofences'].includes(seg)) return { ok: true };
    if (seg === 'reports' && ['route', 'trips', 'stops', 'events', 'summary'].includes(id) && !more) return { ok: true };
    if (seg === 'server' && !id) return { ok: true };
    return { deny: 'not available' };
  }
  if (m === 'PUT' && seg === 'devices' && id && !more) return { ok: true };   // car names / alert settings / share requests
  if (m === 'PUT' && seg === 'users' && id && !more) {
    if (role !== 'owner' || String(id) !== String(user.id)) return { deny: 'only your own profile' };
    const b = { ...(body || {}) }; PROFILE_LOCKED.forEach((k) => delete b[k]);
    if (b.attributes && typeof b.attributes === 'object') { b.attributes = { ...b.attributes }; PROFILE_ATTR_LOCKED.forEach((k) => delete b.attributes[k]); }
    return { ok: true, body: b, keepAttrs: PROFILE_ATTR_LOCKED, keepFields: PROFILE_LOCKED };
  }
  if (role === 'owner' || role === 'member') {
    if (m === 'POST' && seg === 'geofences' && !id) return { ok: true };
    if (m === 'DELETE' && seg === 'geofences' && id && !more) return { ok: true };
    if ((m === 'POST' || m === 'DELETE') && seg === 'permissions' && !id) {
      const keys = Object.keys(body || {});
      return keys.length === 2 && keys.includes('deviceId') && keys.includes('geofenceId') ? { ok: true, device: body.deviceId } : { deny: 'only linking a geofence to your car' };
    }
    if (m === 'POST' && seg === 'commands' && id === 'send' && !more) {
      return ['engineStop', 'engineResume'].includes(body && body.type) ? { ok: true, device: body.deviceId } : { deny: 'only engine stop / resume' };
    }
  }
  return { deny: 'not available' };
}

// does this account own / have this car? (device = the Traccar device; ownerSet = ids the owner has). Pure.
export function holdsDevice(user, d, { ownerOwns = () => false, ownerIds = null } = {}) {
  if (isAdminUser(user)) return true;
  if (!d) return false;
  const a = d.attributes || {};
  const approved = (list, key) => Array.isArray(list) && list.some((x) => x && String(x[key]) === String(user.id) && x.status === 'approved');
  if (user.role === 'owner') return ownerOwns(d) || !!(ownerIds && ownerIds.has(d.id));
  if (user.role === 'member') return approved(a.memberLinks, 'memberId');
  if (user.role === 'broker') return approved(a.brokerLinks, 'brokerId');
  if (user.role === 'fleet') return String(a.taFleetId || '') === String(user.id);
  return false;
}

// ---- per-car views (who sees what of a car) ------------------------------------------------------
// A car's protected fields — only an admin (or the server itself) sets these.
export const DEVICE_LOCKED_ATTRS = ['ownerUserId', 'customerId', 'account', 'owners', 'membership', 'product', 'taFleetId', 'shareCode', 'accountDeleted', 'claimed', 'taShop'];
const LINKS = { broker: ['brokerLinks', 'brokerId'], member: ['memberLinks', 'memberId'] };
const linkOf = (d, kind, id) => (((d && d.attributes) || {})[LINKS[kind][0]] || []).find((x) => x && String(x[LINKS[kind][1]]) === String(id)) || null;

// how this account relates to the car: 'owner' | 'shared' (approved family / broker / fleet) | 'pending'
// (asked, not approved yet) | null. trueOwner = the server's owner check (not counting family links). Pure.
export function relation(user, d, { trueOwner = false } = {}) {
  if (!user || !d) return null;
  if (isAdminUser(user)) return 'owner';
  const a = d.attributes || {};
  if (user.role === 'fleet') return String(a.taFleetId || '') === String(user.id) ? 'shared' : null;
  if (user.role === 'owner' && trueOwner) return 'owner';
  const kind = user.role === 'broker' ? 'broker' : 'member';
  const myId = user.role === 'owner' ? `u${user.id}` : user.id;
  const l = linkOf(d, kind, myId);
  if (!l) return null;
  return l.status === 'approved' ? 'shared' : 'pending';
}
// the car as this account may see it: everything for its owner; for family / broker / fleet the car with only
// THEIR own share entry (never the other people's names / emails); a pending request = just id + name. Pure.
export function deviceView(user, d, rel) {
  if (!rel) return null;
  if (rel === 'owner') return d;
  const a = d.attributes || {};
  const kind = user.role === 'broker' ? 'broker' : 'member';
  const myId = user.role === 'owner' ? `u${user.id}` : user.id;
  const own = user.role === 'fleet' ? null : linkOf(d, kind, myId);
  const attrs = { ...a }; delete attrs.brokerLinks; delete attrs.memberLinks; delete attrs.owners; delete attrs.taShop;
  if (own) attrs[LINKS[kind][0]] = [own];
  if (rel === 'pending') return { id: d.id, name: d.name, status: d.status, attributes: { displayName: a.displayName, ...(a.shareCode ? { shareCode: a.shareCode } : {}), [LINKS[kind][0]]: [own] } };
  return { ...d, attributes: attrs };
}
// a car update from a non-admin → the full device to save (built on the CURRENT device), or { deny }. Pure.
//   owner: anything but the protected fields; approving / declining requests; approving a fleet request moves
//   the car into that fleet. family (approved): car settings, not the share list. broker (approved): only
//   the assigned driver. Nobody else.
export function mergeDeviceUpdate(user, cur, body, rel) {
  if (!cur || !body) return { deny: 'not found' };
  const ca = cur.attributes || {}; const ba = (body.attributes && typeof body.attributes === 'object') ? body.attributes : {};
  const base = { id: cur.id, name: cur.name, uniqueId: cur.uniqueId, groupId: cur.groupId || 0, phone: cur.phone || '', model: cur.model || '', contact: cur.contact || '', category: cur.category || null, disabled: !!cur.disabled };
  if (rel === 'owner' || (rel === 'shared' && (user.role === 'member' || user.role === 'owner'))) {
    const attrs = { ...ba };
    DEVICE_LOCKED_ATTRS.forEach((k) => { if (k in ca) attrs[k] = ca[k]; else delete attrs[k]; });
    if (rel !== 'owner') { attrs.brokerLinks = ca.brokerLinks; attrs.memberLinks = ca.memberLinks; }   // family can't approve anyone
    else {
      // a fleet request (kept with the broker requests so the owner sees it in the same place) approved → in that fleet
      const fl = (attrs.brokerLinks || []).find((x) => x && x.kind === 'fleet' && x.status === 'approved');
      const had = (ca.brokerLinks || []).find((x) => x && x.kind === 'fleet');
      if (fl) attrs.taFleetId = String(fl.fleetId);
      else if (had && String(ca.taFleetId || '') === String(had.fleetId)) delete attrs.taFleetId;   // owner removed / declined it
    }
    Object.keys(attrs).forEach((k) => attrs[k] === undefined && delete attrs[k]);
    return { device: { ...base, name: body.name || cur.name, attributes: attrs } };
  }
  if (rel === 'shared' && user.role === 'broker') {
    const attrs = { ...ca };
    ['assignedDriver', 'assignedDriverLicense'].forEach((k) => { if (k in ba) attrs[k] = ba[k]; });
    return { device: { ...base, attributes: attrs } };
  }
  return { deny: 'not your car' };
}
// a share request by code: the entry to add to the car for this account. Pure.
export function shareEntry(user, now = new Date().toISOString()) {
  if (user.role === 'broker') return { list: 'brokerLinks', key: 'brokerId', entry: { brokerId: user.id, brokerName: user.name || user.email, brokerCompany: user.company || '', brokerEmail: user.email || '', at: now, status: 'pending' } };
  if (user.role === 'fleet') return { list: 'brokerLinks', key: 'brokerId', entry: { brokerId: `fleet:${user.id}`, kind: 'fleet', fleetId: String(user.id), brokerName: user.company || user.name || user.email, brokerCompany: user.company || '', brokerEmail: user.email || '', at: now, status: 'pending' } };
  if (user.role === 'member' || user.role === 'owner') return { list: 'memberLinks', key: 'memberId', entry: { memberId: user.role === 'owner' ? `u${user.id}` : user.id, memberName: user.name || user.email, memberEmail: user.email || '', at: now, status: 'pending' } };
  return null;
}

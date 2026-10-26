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

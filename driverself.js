// ---------------------------------------------------------------
// The driver's own profile (Nov 26, Nadim): from the driver app the driver sets their picture, name, phone numbers, email and an
// emergency contact. What they save wins everywhere: their cell becomes the number texts, calls, Jarvis and the chats use (it
// replaces the Samsara number on their loads, truckmate.js), the main number on Driver profiles and for signing in to the app.
// Samsara itself is never written to. Data: taDriverSelf:<site> (driver ID → profile) · taDriverPhoto:<site>:<ID> (the picture).
// What a driver types is data, never instructions.
// ---------------------------------------------------------------
export const SELF_KEY = (site) => `taDriverSelf:${site}`;
export const PHOTO_KEY = (site, code) => `taDriverPhoto:${site}:${String(code || '').trim().toUpperCase().replace(/^0+(?=\d)/, '')}`;
export const LABELS = ['Cell', 'Home', 'Work', 'Other'];
const PHOTO_MAX = 400 * 1024;   // the app shrinks it to 400 px first (~40 KB)
const norm = (x) => String(x == null ? '' : x).trim().toUpperCase().replace(/^0+(?=\d)/, '');   // same as driverauth.js: 0612 = 612
export const last10 = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 11 && d[0] === '1' ? d.slice(1) : d.length === 10 ? d : ''; };

// What the driver sent, cleaned. → { profile, photo } | { error }. Pure.
export function cleanSelf(b = {}) {
  const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) return { error: 'Write your name.' };
  const phones = [];
  for (const x of (Array.isArray(b.phones) ? b.phones : []).slice(0, 4)) {
    const raw = String((x && x.number) || '').trim();
    if (!raw) continue;
    const n = last10(raw);
    if (!n) return { error: `"${raw.slice(0, 20)}" isn't a 10-digit phone number.` };
    if (!phones.some((y) => y.number === n)) phones.push({ number: n, label: LABELS.includes(x && x.label) ? x.label : 'Cell' });
  }
  if (!phones.some((x) => x.label === 'Cell')) return { error: 'Keep at least one cell number: you sign in with it.' };
  phones.sort((a, c) => (a.label === 'Cell' ? 0 : 1) - (c.label === 'Cell' ? 0 : 1));   // the cell first: it's the one we text
  const email = String(b.email || '').trim().toLowerCase().slice(0, 120);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'Check the email address.' };
  const em = (b.emergency && typeof b.emergency === 'object') ? b.emergency : {};
  const emPhoneRaw = String(em.phone || '').trim();
  const emPhone = emPhoneRaw ? last10(emPhoneRaw) : '';
  if (emPhoneRaw && !emPhone) return { error: `"${emPhoneRaw.slice(0, 20)}" isn't a 10-digit phone number.` };
  let photo;   // undefined = leave it, null = remove it, string = the new picture
  if (b.photo === null) photo = null;
  else if (typeof b.photo === 'string' && b.photo) {
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(b.photo)) return { error: 'That picture could not be read.' };
    if (b.photo.length > PHOTO_MAX * 1.37) return { error: 'That picture is too big.' };
    photo = b.photo;
  }
  return { profile: { name, phones, email: email || null, emergency: { name: String(em.name || '').replace(/\s+/g, ' ').trim().slice(0, 80) || null, phone: emPhone || null } }, photo };
}

// The cell the driver set (their first Cell number). Pure.
export const selfCell = (p) => ((p && p.phones) || []).find((x) => x.label === 'Cell') || null;

// On the board: a driver who set their own cell gets texts / calls there — it replaces the Samsara number on their loads. Pure (mutates items).
export function applySelfPhones(items = [], self = {}) {
  const byCode = new Map(Object.entries(self || {}).map(([k, p]) => [norm(k), p]));
  if (!byCode.size) return items;
  for (const it of items) {
    const t = (it && it.trip) || {}; const s = it && it._samsara;
    if (!s) continue;
    [['driver', 'driver1Info'], ['driver2', 'driver2Info']].forEach(([codeKey, infoKey]) => {
      const p = byCode.get(norm(t[codeKey])); const cell = selfCell(p);
      if (!cell || !s[infoKey]) return;
      if (s[infoKey].phone && last10(s[infoKey].phone) !== cell.number) s[infoKey] = { ...s[infoKey], samsaraPhone: s[infoKey].phone };
      s[infoKey] = { ...s[infoKey], phone: cell.number, phoneFrom: 'driver' };
    });
  }
  return items;
}

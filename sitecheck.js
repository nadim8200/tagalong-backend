// ---------------------------------------------------------------
// Which TruckMate site a load belongs in, from its rate con (Nov 20, 2026 — Ronen Koubi: "All Tempest loads must be
// entered in Site 9 (letter F). Site 2 (letter B) is only FBE and FBF loads."). Bills come in like any other bill
// number; when the rate con says Tempest the bill belongs in Site 9 (F), when it says Florida Beauty it belongs in
// Site 2 (B). A bill in the other site is a mistake: the trip card shows it, and the Wrong TruckMate site email
// goes once per trip (Employees → Alert emails → "wrong_site").
// ---------------------------------------------------------------
import { jarvisEmail, facts, notice, section, esc } from './jarvismail.js';

export const SITES = { tempest: { site: 'SITE9', letter: 'F', name: 'Tempest Transportation' }, fb: { site: 'SITE2', letter: 'B', name: 'Florida Beauty (FBE / FBF)' } };
const KEY = (site) => `taSiteWarned:${site}`;
export const RULE_FROM = '2026-11-20T17:21';   // Ronen's email, Nov 20 5:21 PM ET: bills created before it were entered the old way

// Whose rate con is it? Tempest first — a Tempest rate con can still carry a floridabeauty.us email. Pure.
export function carrierOf(rc) {
  if (!rc) return null;
  const t = JSON.stringify(rc).toLowerCase();
  if (/tempest/.test(t) || /\b536134\b/.test(t)) return 'tempest';
  if (/florida\s*beauty/.test(t) || /\b453152\b/.test(t)) return 'fb';
  return null;
}
// A bill's site: TruckMate's site id, else the bill number's letter (B181078 → Site 2). Pure.
export function billSite(b) {
  const id = String((b && b.siteId) || '').toUpperCase().replace(/\s+/g, '');
  if (/^SITE\d+$/.test(id)) return id;
  const letter = String((b && (b.billNumber || b.bill)) || '').trim().charAt(0).toUpperCase();
  return letter === 'F' ? 'SITE9' : letter === 'B' ? 'SITE2' : null;
}
const letterOf = (site) => ({ SITE9: 'F', SITE2: 'B' }[site] || '');

// The load's bills in the wrong site for its rate con → { trip, carrier, want, have, bills } or null. Pure.
export function wrongSite(item) {
  const t = (item && item.trip) || item || {};
  const who = carrierOf(item && item._ratecon);
  if (!who) return null;
  const want = SITES[who];
  const other = who === 'tempest' ? 'SITE2' : 'SITE9';   // only the two sites the rule is about
  // TruckMate's creation time (Eastern, no zone) — a bill with no time isn't flagged
  const newRule = (b) => { const at = String((b && (b.createdTimestamp || b.createdTime || b.billDate)) || '').slice(0, 16); return /^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(at) && at >= RULE_FROM; };
  const bills = ((item && (item.freightBills || item.orders)) || t.freightBills || []).filter((b) => billSite(b) === other && newRule(b));
  if (!bills.length) return null;
  return { trip: String(t.tripNumber || ''), carrier: who, carrierName: want.name, want: { site: want.site, letter: want.letter }, have: { site: other, letter: letterOf(other) },
    bills: bills.map((b) => String(b.billNumber || b.bill || '')).filter(Boolean), truck: t.powerUnit || null, broker: (item._ratecon && item._ratecon.broker) || null,
    loadNumber: (item._ratecon && item._ratecon.loadNumber) || null };
}

// The email to dispatch / billing. Pure.
export function siteEmail(w, { test = false, now = Date.now() } = {}) {
  const fix = `Move ${w.bills.length === 1 ? `bill ${w.bills[0]}` : `bills ${w.bills.join(', ')}`} to Site ${w.want.site.replace('SITE', '')} (letter ${w.want.letter}).`;
  const subject = `${test ? '[TEST] ' : ''}Wrong TruckMate site | Trip ${w.trip} | ${w.carrierName.split(' (')[0]} load in Site ${w.have.site.replace('SITE', '')} (${w.have.letter})`;
  const body = section('THE LOAD', facts([
    ['Trip', w.trip], ['Bill', w.bills.join(', ')], ['Rate con says', w.carrierName], w.broker ? ['Broker', w.broker] : null, w.loadNumber ? ['Broker load #', w.loadNumber] : null,
    w.truck ? ['Truck', w.truck] : null, ['Entered in', `Site ${w.have.site.replace('SITE', '')} (letter ${w.have.letter})`], ['Belongs in', { html: `<b>Site ${esc(w.want.site.replace('SITE', ''))} (letter ${esc(w.want.letter)})</b>` }],
  ])) + notice('The rule (from Ronen, Nov 20)', 'All Tempest loads go in Site 9 (letter F), every OTR freight bill included. Site 2 (letter B) is only FBE and FBF loads. Dispatch and billing both follow it.');
  const html = jarvisEmail({ test, preheader: `Trip ${w.trip}: ${fix}`, eyebrow: 'Wrong TruckMate site', tone: 'amber', title: fix, subtitle: `The rate con says ${w.carrierName}`,
    meta: [`Trip ${w.trip}`, new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })],
    lead: `Trip ${w.trip}'s rate con is for ${w.carrierName}, but ${w.bills.length === 1 ? 'its bill is' : 'its bills are'} in Site ${w.have.site.replace('SITE', '')} (${w.have.letter}). ${fix}`,
    action: { label: 'Open the trip', url: `https://mytagalong.app/truckmate?trip=${encodeURIComponent(w.trip)}` }, body });
  const text = [test ? 'TEST · SAMPLE DATA\n' : null, `WRONG TRUCKMATE SITE — Trip ${w.trip}`, `The rate con says ${w.carrierName}; bill ${w.bills.join(', ')} is in Site ${w.have.site.replace('SITE', '')} (${w.have.letter}).`, fix,
    '', 'Rule (Ronen, Nov 20): all Tempest loads go in Site 9 (F); Site 2 (B) is only FBE and FBF loads.', '', 'Jarvis · AI Dispatcher · Florida Beauty Flora'].filter((x) => x != null).join('\n');
  return { subject, html, text };
}

// Once per trip and bill: the email (Employees → Alert emails → wrong_site). Checked with the board every 10 minutes.
export function initSiteCheck({ db, getBoard, sendMail, emails, site = 'florida-beauty', now = () => Date.now(), env = process.env }) {
  const enabled = !!(db && db.enabled);
  async function check() {
    if (!enabled) return [];
    const trips = ((await getBoard(site)) || {}).trips || [];
    const found = trips.map(wrongSite).filter(Boolean);
    if (!found.length) return [];
    const seen = (await db.get(KEY(site), {})) || {};
    const fresh = found.filter((w) => !seen[`${w.trip}|${w.bills.join(',')}`]);
    if (!fresh.length) return [];
    const to = await emails().catch(() => []);
    const sent = [];
    for (const w of fresh) {
      if (to.length) { try { await sendMail({ to, ...siteEmail(w, { now: now() }) }); } catch (e) { console.warn('[sitecheck] email:', e.message); continue; } } // eslint-disable-line no-await-in-loop
      sent.push(w);
    }
    if (sent.length) await db.update(KEY(site), (cur) => { const a = { ...(cur || {}) }; for (const w of sent) a[`${w.trip}|${w.bills.join(',')}`] = new Date(now()).toISOString(); const k = Object.keys(a); return k.length > 2000 ? Object.fromEntries(k.slice(-1500).map((x) => [x, a[x]])) : a; }, {});
    return sent;
  }
  if (enabled && env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
    setTimeout(() => check().catch((e) => console.warn('[sitecheck]', e.message)), 90000).unref?.();
    setInterval(() => check().catch((e) => console.warn('[sitecheck]', e.message)), 10 * 60000).unref?.();
  }
  return { check };
}

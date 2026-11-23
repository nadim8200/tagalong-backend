// ---------------------------------------------------------------
// A delivery / POD email from our own staff, filed on a load, is a fact: the load is delivered (Nov 22 — trip 627668
// stayed on the board as DEPSHIP with "Reefer OFF" a day after inbound dispatch emailed "Load delivered / Clean bills / POD").
//   - group emails count (dispatch writes to the Inbound group, Jarvis only in the loop); auto-replies / newsletters don't
//   - only Florida Beauty addresses (isInternal) — a broker's or customer's email never closes a load
//   - only the email's own words (quoted history cut off), and never "still at the receiver", "unloading", "send the POD"…
//   - the SUBJECT names this load (Nov 22, Nadim: "POD emails state what load it's from with the subject line"): its bill
//     (B181095), its trip number, or the broker's load number from the rate con. Matching by truck / trailer alone closed the
//     wrong loads (a Penang Nursery POD on trailer 18094 closed trip 627656 before it was picked up)
//   - sent after the load was picked up (never a load that hasn't started)
//   - a multi-stop load with stops still open in TruckMate closes only on whole-load words ("load delivered", "all
//     delivered", "empty"); otherwise it is a hint on the card (the driver is asked, as for other guesses)
// Pure. → { at, by, signer, subject, whole } | null (the newest qualifying email)
// ---------------------------------------------------------------
const HEADER = /^\s*(from|sent|to|cc|bcc|subject|date)\s*:/i;
const QUOTE = /^\s*(from\s*:|-{2,}\s*original message|_{5,}|on .{0,120} wrote:)/i;
export function ownWords(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length && (HEADER.test(lines[i]) || (i > 0 && !lines[i].trim() && HEADER.test(lines[i - 1] || '')))) i++;   // a forwarded / sent header on top
  const out = [];
  for (; i < lines.length; i++) { if (QUOTE.test(lines[i])) break; out.push(lines[i]); }
  return out.join('\n').trim();
}
const DELIVERED = /\b(?:load|freight|trailer|order|shipment)\s+(?:was\s+|has\s+been\s+|is\s+|got\s+)?delivered\b|\ball\s+(?:stops\s+|bills\s+|freight\s+)?delivered\b|^\s*delivered\b|\bclean\s+bills?\b|\bproof\s+of\s+delivery\b|(?:see|attached|below|here(?:'s| is)|find)[^\n]{0,25}\bPOD\b|^\s*POD\b/im;
const NOT_YET = /\b(?:not\s+(?:yet\s+)?delivered|(?:still\s+)?at\s+(?:the\s+)?(?:receiver|consignee|delivery)|being\s+unloaded|unloading|waiting\s+(?:for|on)\s+(?:the\s+)?(?:appointment|door|pod)|will\s+deliver|refused|rejected|(?:send|need|missing|request(?:ing)?|please\s+(?:send|provide))[^\n]{0,20}\bPOD\b)/i;
const WHOLE = /\b(?:load|all|everything|freight)\b[^\n]{0,15}\bdelivered\b|\bempty\b/i;
const BILL = /\bB\d{6}\b/gi;
// "Thanks,\nPriscyla Dominguez 🎅🏻 | Inbound Dispatcher" → "Priscyla Dominguez"
export function signerOf(text) {
  const m = String(text || '').match(/^\s*(?:thanks|thank you|regards|best(?: regards)?)[,!.]?\s*\n+\s*([^\n]+)/im);
  if (!m) return null;
  const name = m[1].split('|')[0].replace(/[^\p{L}\s.'-]/gu, '').replace(/\s+/g, ' ').trim();
  return name && name.split(' ').length <= 4 ? name : null;
}
export function staffDelivery(emails = [], item = {}, isInternal = () => false) {
  const t = (item && item.trip) || item || {};
  const bills = (item && (item.freightBills || item.orders)) || t.freightBills || [];
  const ours = new Set(bills.map((b) => String((b && b.billNumber) || '').trim().toUpperCase()).filter(Boolean));
  const places = new Set(bills.map((b) => b && (b.endZoneDescription || b.endZone)).filter(Boolean));
  const openStops = places.size > 1 && bills.some((b) => b && !b.actualDelivery);
  const list = [...emails].filter((e) => e && (!e.auto || e.auto === 'group')).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const hist = ((item && item._times && item._times.statusHistory) || []).find((x) => /^(ARRSHIP|DEPSHIP)/i.test(String(x.status || '')));
  const pickedMs = hist ? Date.parse(hist.at) : null;
  if (!pickedMs && /^(DISP|ASSGN|ASSIGNED|AVAIL|AVBL|NEW|PLAN|PEND|PRINTED)/i.test(String(t.status || ''))) return null;   // not picked up yet
  const tripN = String(t.tripNumber || '');
  const rc = (item && item._ratecon && (item._ratecon.data || item._ratecon)) || {};
  const brokerNo = String(rc.loadNumber || rc.load_number || '').trim().toUpperCase();
  const namesThis = (subj) => {
    const u = String(subj || '').toUpperCase();
    return [...ours].some((b) => new RegExp(`\\b${b}\\b`).test(u)) || (tripN.length >= 6 && new RegExp(`\\b${tripN}\\b`).test(u))
      || (brokerNo.length >= 4 && u.includes(brokerNo));
  };
  for (const e of list) {
    const addr = String((e.from && e.from.address) || '').toLowerCase();
    if (!addr || !isInternal(addr)) continue;
    if (!namesThis(e.subject)) continue;                                                // the subject doesn't say it's this load
    if (pickedMs && (Date.parse(e.at) || 0) < pickedMs) continue;                        // before this load was picked up
    const named = (String(e.subject || '').match(BILL) || []).map((x) => x.toUpperCase());
    const words = ownWords(e.text);
    const subj = /^\s*POD\b/i.test(String(e.subject || '')) && named.some((x) => ours.has(x));   // "POD FOR B181099"
    if (NOT_YET.test(words) || !(DELIVERED.test(words) || subj)) continue;
    const whole = !openStops || WHOLE.test(words);
    return { at: e.at, by: (e.from && e.from.name) || addr, signer: signerOf(words), subject: String(e.subject || '').slice(0, 160), whole };
  }
  return null;
}
const etDay = (iso) => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
export const staffPodReason = (p) => `delivered — POD emailed by ${p.signer || p.by}${p.signer && p.by && p.signer !== p.by ? ` (from ${p.by}'s email)` : ''}, ${etDay(p.at)} ET (staff email)`;

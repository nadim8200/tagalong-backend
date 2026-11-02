// ---------------------------------------------------------------
// What an employee can start by talking to Jarvis: Ask Jarvis in the console, a text, or a phone call. The same breakdown and stop
// actions as the card and the emails, so it's the same record and the same emails however it starts. The caller decides who counts as
// staff. Only for our own people: nothing here reaches customers or drivers, and nothing calls road service.
// ---------------------------------------------------------------
const key = (x) => String(x || '').trim().toLowerCase().replace(/^#/, '').replace(/^0+(?=\d)/, '');

// Which load they mean, from a trip or truck number. Pure.
export function findLoad(items, { trip = null, truck = null } = {}) {
  const t = (it) => (it && it.trip) || {};
  if (trip) { const hit = items.find((it) => String(t(it).tripNumber) === String(trip).trim()); return hit ? { trip: String(t(hit).tripNumber), item: hit } : { error: `Trip ${trip} is not on the board.` }; }
  if (!truck) return { error: 'Which truck or trip?' };
  const hits = items.filter((it) => key(t(it).powerUnit) === key(truck));
  if (hits.length > 1) return { error: `Truck ${truck} is on ${hits.length} trips. Which trip?` };
  return hits[0] ? { trip: String(t(hits[0]).tripNumber), item: hits[0] } : { error: `Truck ${truck} is not on the board.` };
}

export function initStaffActions({ breakdown, stopReview, getBoard, docs = null, site = 'florida-beauty', now = () => Date.now() }) {
  const load = async (a) => findLoad(((await getBoard(site)) || {}).trips || [], a);
  // only pictures, whatever else came with the message
  const photosFrom = async (uploaded = []) => {
    const ids = uploaded.map((u) => u && u.docId).filter(Boolean).map(String);
    if (!ids.length || !docs) return [];
    const files = await docs.readDocs({ site, ids }).catch(() => []);
    return files.filter((f) => /^image\//i.test(f.mediaType || '')).map((f) => ({ docId: String(f.id), name: (uploaded.find((u) => String(u.docId) === String(f.id)) || {}).name || 'photo.jpg' }));
  };

  // A new breakdown, or an update when that load already has one open, so nobody has to know which it is.
  async function report({ trip, truck, trailer, part, problem, driverSays, by, uploaded = [] }) {
    if (String(problem || '').trim().length < 3) return { ok: false, say: 'What is the breakdown?' };
    const hit = await load({ trip, truck });
    if (hit.error) return { ok: false, say: hit.error };
    const photos = await photosFrom(uploaded);
    if (await breakdown.openFor(hit.trip)) return update({ trip: hit.trip, message: [problem, driverSays ? `Driver says: ${driverSays}` : null].filter(Boolean).join(' '), by, uploaded });
    const r = await breakdown.fromEmail({ trip: hit.trip, reason: problem, driverSays, part: ['truck', 'trailer'].includes(part) ? part : null, trailer: trailer || null, by, emailId: `jarvis:${hit.trip}:${now()}`, photos });
    return r.ok ? { ok: true, trip: hit.trip, subject: r.subject, photos: photos.length, say: `Breakdown email sent for trip ${hit.trip}. Road service has not been called and no customers were told.` } : { ok: false, say: r.error };
  }
  async function update({ trip, truck, message, by, uploaded = [] }) {
    const hit = await load({ trip, truck });
    if (hit.error) return { ok: false, say: hit.error };
    const photos = await photosFrom(uploaded);
    const r = await breakdown.addUpdate({ trip: hit.trip, message, by, photos });
    return r.ok ? { ok: true, trip: hit.trip, updated: true, photos: photos.length, say: `Update email sent on the breakdown for trip ${hit.trip}.` } : { ok: false, say: r.error };
  }
  async function fixed({ trip, truck, repair, provider, notes, by }) {
    const hit = await load({ trip, truck });
    if (hit.error) return { ok: false, say: hit.error };
    const r = await breakdown.fixed(hit.trip, by, { repair: repair || null, provider: provider || null, notes: notes || null });
    return r.ok ? { ok: true, trip: hit.trip, say: `Recorded as fixed on trip ${hit.trip}. Jarvis is waiting to see the truck move.` } : { ok: false, say: r.error };
  }
  // the stop is found by truck, or by trip when that's all they gave
  async function stop({ trip, truck, authorized, reason, by, email = null, source }) {
    const status = authorized ? 'authorized' : 'unauthorized';
    const r = await stopReview.decide({ unit: truck || null, trip: trip || null, status, reason, by, email, source });
    if (r.already) return { ok: true, say: 'That was already recorded.' };
    return r.ok ? { ok: true, say: authorized ? 'Stop authorized. Alerts for it are off and the team has the email.' : 'Marked not authorized. Alerts keep going and the team has the email.' } : { ok: false, say: r.error };
  }
  return { report, update, fixed, stop };
}

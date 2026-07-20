// ---------------------------------------------------------------
// Transflo adapter — where this carrier's documents already live.
//
// Transflo Mobile+ is what drivers use to scan paperwork today, and the office
// workflow is built around documents landing in Transflo. So the POD packet we
// capture must end up there too — otherwise we've built a parallel system and
// given the office two places to look, which is worse than one.
//
// Docs: https://knowledge.transflo.com/integrations/
// Live API explorer: https://svc.transflomobile.com/integration/sdk
//
// ⚠️ VERIFICATION STATUS: endpoints and shapes below are from Transflo's
// published documentation. NOTHING here has been run against a live account —
// we have no Transflo credentials yet. Treat every call as unverified until
// tested, and expect field names to need correcting, the same way the Samsara
// route payload did.
//
// WRITES ARE DISABLED by default for that reason (`allowWrites: false`).
// Pushing a malformed document into the system of record a carrier bills from
// is a much worse failure than not pushing at all.
// ---------------------------------------------------------------

export const name = 'transflo';

const MOBILE_BASE = 'https://svc.transflomobile.com/integration/api';
const SHIPPER_BASE = 'https://svc.transflomobile.com/integration/api/shipper/v1';

function authHeaders(config) {
  if (!config || !config.apiKey) throw new Error('Transflo API key missing.');
  return {
    Authorization: `Bearer ${config.apiKey}`,
    'Content-Type': 'application/json',
  };
}

async function call(config, url, init = {}) {
  const r = await fetch(url, { ...init, headers: { ...authHeaders(config), ...(init.headers || {}) } });
  if (!r.ok) {
    let detail = ''; try { detail = (await r.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`Transflo ${r.status} on ${url} — ${detail}`);
  }
  const ct = r.headers.get('content-type') || '';
  return ct.includes('json') ? r.json() : r.text();
}

export async function testConnection({ config }) {
  try {
    // Validation endpoint is the cheapest way to prove credentials work
    // without touching load data.
    await call(config, `${MOBILE_BASE}/v2/validate/driver`, {
      method: 'POST',
      body: JSON.stringify({ fleetId: config.recipientId, driverId: config.testDriverId || '' }),
    });
    return { ok: true, message: 'Transflo credentials accepted.' };
  } catch (e) { return { ok: false, message: e.message }; }
}

// ---- send a completed POD packet to Transflo ----
//
// Transflo's eBOL upload takes documents per stop. We send the signed BOL, the
// pallet photos, and — importantly — a GENERATED count sheet built from the
// structured counts the driver typed, so Transflo holds a legible document
// rather than a photo of handwriting.
export async function pushPod({ pod, files, config, allowWrites = false }) {
  if (!allowWrites) {
    return {
      ok: false,
      skipped: 'Transflo writes are disabled until tested against a real account. '
        + 'Set allowWrites once credentials are verified.',
    };
  }
  if (!pod || !pod.bill_number) throw new Error('POD needs a bill number to file against.');

  const documents = (files || []).map((f, i) => ({
    pageNumber: i + 1,
    documentType: f.kind === 'bol' ? 'BOL' : f.kind === 'countsheet' ? 'COUNT_SHEET' : 'PHOTO',
    mimeType: f.mime,
    content: f.bytes.toString('base64'),
  }));

  const body = {
    recipientId: config.recipientId,
    loadNumber: pod.load_id || pod.bill_number,
    billOfLading: pod.bill_number,
    stopId: pod.stop_id || undefined,
    capturedAt: pod.captured_at,
    // Structured fields travel alongside the images so downstream systems get
    // the numbers, not just pictures of numbers.
    metadata: {
      expectedPieces: pod.expected_total,
      countedPieces: pod.counted_total,
      osd: pod.osd || 'none',
      osdDelta: pod.osd_delta,
      receiver: pod.receiver_name,
      sealNumber: pod.seal_number,
      temperatureF: pod.temperature_f,
    },
    documents,
  };

  const url = documents.length > 1
    ? `${SHIPPER_BASE}/multiStopEDocumentUpload`
    : `${SHIPPER_BASE}/noLoadEDocumentUpload`;

  const out = await call(config, url, { method: 'POST', body: JSON.stringify(body) });
  return { ok: true, ref: (out && (out.confirmationNumber || out.id)) || null, raw: out };
}

// ---- retrieve documents Transflo already holds ----
// Useful for reconciling: if a driver scanned through Mobile+ instead of our
// app, the document is in Transflo and we should link it rather than chase the
// driver for a duplicate.
export async function fetchBatch({ confirmationNumber, config }) {
  return call(config, `${MOBILE_BASE}/v2/ondemand/batches/${config.recipientId}/${confirmationNumber}`);
}

export async function pendingBatches({ config }) {
  return call(config, `${MOBILE_BASE}/v2/ondemand/request/${config.divisionId}`);
}

// ---- message a driver through the app they already use ----
// This is how call-ahead reminders reach a driver without asking them to
// install anything new: Transflo Mobile+ is already on their phone.
export async function notifyDriver({ driverEmail, message, config, allowWrites = false }) {
  if (!allowWrites) return { ok: false, skipped: 'Transflo writes disabled until verified.' };
  return call(config, `${MOBILE_BASE}/v2/notifications`, {
    method: 'POST',
    body: JSON.stringify({ recipientId: config.recipientId, driver: driverEmail, message }),
  });
}

// ---- what we still need from Florida Beauty / Transflo ----
export const SETUP_QUESTIONS = [
  'Transflo API key + recipientId (fleet id) + divisionId for this carrier.',
  'Is there a sandbox/test fleet? Writes stay disabled until we can test safely.',
  'Do drivers scan through Transflo Mobile+ today — and should our capture '
    + 'REPLACE that, or feed it? (Two capture paths for the same document is '
    + 'how duplicates and missing paperwork happen.)',
  'Which document types does the office expect: BOL, count sheet, pallet photos — '
    + 'and under what Transflo document codes?',
  'Are driver emails in Transflo the same identifiers as in Samsara? If not we '
    + 'need a mapping table before messaging can work.',
];

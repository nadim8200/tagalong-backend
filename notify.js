// ---------------------------------------------------------------
// Outbound customer contact — the call-ahead, placed by the system.
//
// The paperwork says "CALL ISRAEL 413-883-7695 1HR BEFORE ARRIVING". Today that
// depends on a driver remembering while driving. The system knows the truck's
// position and ETA, so it can make the contact itself at the right moment.
//
// EACH CONTACT CHOOSES THEIR CHANNEL. Some receivers want a phone call, some
// want a text, some want both, some want nothing because they have a gate app.
// Forcing one channel on everyone is how a helpful feature becomes a nuisance
// that people ask you to switch off.
//
// ⚠️ COMPLIANCE — READ BEFORE ENABLING
// Automated calls and texts in the US are regulated (TCPA and state
// equivalents). Business-to-business delivery notifications to a contact who
// gave you their number for that purpose are far lower risk than marketing, but
// "lower risk" is not "no risk". Before switching sends on:
//   • record WHO consented, WHEN, and to WHICH channel (consentAt/consentBy
//     below) — that record is the defence if it's ever questioned;
//   • honour opt-out immediately (STOP on SMS, a spoken option on calls);
//   • keep to reasonable hours in the CONTACT's timezone, not ours;
//   • have someone who knows the rules review this before it dials a customer.
// This is a legal question, not a technical one — I'm flagging it, not
// answering it.
//
// SENDS ARE DISABLED BY DEFAULT (`allowSend: false`). Everything renders and
// logs so the behaviour can be reviewed without a single call being placed.
// ---------------------------------------------------------------

export const CHANNELS = ['call', 'sms', 'both', 'none'];

// Reasonable contact hours, in the CONTACT's local timezone. A 4am appointment
// does not justify a 3am phone call to a receiver's mobile.
const DEFAULT_WINDOW = { startHour: 7, endHour: 21 };

export function initNotify(app, { requireAuth, db, pool, env = process.env, ringcentral = null }) {
  const allowSend = env.NOTIFY_ALLOW_SEND === 'true';
  const twilio = {
    sid: env.TWILIO_ACCOUNT_SID,
    token: env.TWILIO_AUTH_TOKEN,
    from: env.TWILIO_FROM_NUMBER,
  };
  const configured = !!(twilio.sid && twilio.token && twilio.from);

  let ready = null;
  async function ensureReady() {
    if (!db || !db.enabled) return false;
    if (ready) return ready;
    ready = (async () => {
      // Contact preferences live per (owner, contact) so the same receiver
      // keeps their choice across every load.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ta_contacts (
          id          text PRIMARY KEY,
          owner_key   text NOT NULL,
          name        text,
          company     text,
          phone       text,
          sms_phone   text,
          email       text,
          channel     text NOT NULL DEFAULT 'sms',
          lead_hours  numeric(4,1) NOT NULL DEFAULT 1,
          timezone    text DEFAULT 'America/New_York',
          quiet_start smallint DEFAULT 7,
          quiet_end   smallint DEFAULT 21,
          samsara_address_id text,
          consent_at  timestamptz,
          consent_by  text,
          opted_out   boolean NOT NULL DEFAULT false,
          notes       text,
          updated_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pool.query('ALTER TABLE ta_contacts ADD COLUMN IF NOT EXISTS samsara_address_id text');
      await pool.query('CREATE INDEX IF NOT EXISTS ta_contacts_owner ON ta_contacts (owner_key)');
      await pool.query('CREATE INDEX IF NOT EXISTS ta_contacts_sam ON ta_contacts (owner_key, samsara_address_id)');
      // Every attempt is logged, sent or not. Without this you cannot answer
      // "did anyone actually tell the customer?" — which is the question that
      // matters when a delivery goes wrong.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS ta_notifications (
          id          bigserial PRIMARY KEY,
          owner_key   text NOT NULL,
          load_id     text,
          stop_id     text,
          contact_id  text,
          channel     text NOT NULL,
          to_value    text,
          body        text NOT NULL,
          status      text NOT NULL,           -- 'sent' | 'dry-run' | 'blocked' | 'failed'
          reason      text,
          provider_ref text,
          at          timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS ta_notif_load ON ta_notifications (owner_key, load_id, at DESC)');
      return true;
    })();
    return ready;
  }

  // ---- can we contact this person, right now, on this channel? ----
  // Returns { ok } or { ok:false, reason } — reasons are surfaced to the
  // dispatcher so a suppressed message is visible, not silently dropped.
  function canContact(contact, { now = Date.now() } = {}) {
    if (!contact) return { ok: false, reason: 'no contact on file' };
    if (contact.opted_out) return { ok: false, reason: 'contact opted out' };
    if (contact.channel === 'none') return { ok: false, reason: 'contact set to no notifications' };

    const tz = contact.timezone || DEFAULT_WINDOW.tz || 'America/New_York';
    const hour = Number(new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false,
    }).format(new Date(now)));
    const start = contact.quiet_start != null ? contact.quiet_start : DEFAULT_WINDOW.startHour;
    const end = contact.quiet_end != null ? contact.quiet_end : DEFAULT_WINDOW.endHour;
    if (hour < start || hour >= end) {
      return { ok: false, reason: `outside contact hours (${hour}:00 in ${tz}, allowed ${start}:00–${end}:00)` };
    }
    return { ok: true };
  }

  const channelsFor = (contact) => {
    if (!contact) return [];
    if (contact.channel === 'both') return ['sms', 'call'];
    if (contact.channel === 'none') return [];
    return [contact.channel || 'sms'];
  };

  // ---- message text ----
  // Deliberately plain. A receiver reading this on a phone wants the time and
  // who it's from, not branding.
  function renderCallAhead({ contact, stop, etaMin, etaAt, tz }) {
    const when = new Date(etaAt).toLocaleTimeString('en-US', {
      timeZone: tz || contact.timezone || 'America/New_York',
      hour: 'numeric', minute: '2-digit',
    });
    const who = contact.name ? `${contact.name}, ` : '';
    return {
      sms: `${who}Florida Beauty delivery arriving in about ${etaMin} minutes, around ${when}`
        + `${stop.bills && stop.bills.length ? ` (bill ${stop.bills.join(', ')})` : ''}. `
        + 'Please have someone available to receive. Reply STOP to opt out.',
      // Voice is read aloud, so it needs to be slower, repeat the key fact, and
      // avoid anything that sounds wrong in text-to-speech.
      voice: `Hello${contact.name ? ` ${contact.name}` : ''}. This is an automated delivery notification `
        + `from Florida Beauty. Your delivery is approximately ${etaMin} minutes away, `
        + `arriving around ${when}. Again, arriving around ${when}. `
        + 'Please have someone available to receive the shipment. Thank you.',
    };
  }

  // ---- provider ----
  // SMS goes out through RingCentral when the company has it connected —
  // texts then arrive from the number the customer already knows, which is the
  // difference between being read and being ignored. Twilio is the fallback.
  async function sendSms({ to, body, owner }) {
    if (ringcentral && owner) {
      try {
        const out = await ringcentral.sendSms(owner, { to, text: body });
        return { ok: true, ref: out.id, via: 'ringcentral', from: out.from };
      } catch (e) {
        // Fall through to Twilio rather than dropping the message, but say so.
        console.warn('[notify] RingCentral SMS failed, trying Twilio:', e.message);
      }
    }
    if (!configured) return { ok: false, reason: 'No SMS provider configured (RingCentral or Twilio).' };
    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilio.sid}/Messages.json`;
    const auth = Buffer.from(`${twilio.sid}:${twilio.token}`).toString('base64');
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: twilio.from, Body: body }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: j.message || `Twilio ${r.status}` };
    return { ok: true, ref: j.sid, via: 'twilio' };
  }

  async function placeCall({ to, say }) {
    if (!configured) return { ok: false, reason: 'Twilio not configured' };
    const url = `https://api.twilio.com/2010-04-01/Accounts/${twilio.sid}/Calls.json`;
    const auth = Buffer.from(`${twilio.sid}:${twilio.token}`).toString('base64');
    // TwiML inline: speak the message twice-over is already in the text.
    const twiml = `<Response><Say voice="alice">${say.replace(/[<&]/g, '')}</Say></Response>`;
    const r = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: twilio.from, Twiml: twiml }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, reason: j.message || `Twilio ${r.status}` };
    return { ok: true, ref: j.sid, via: 'twilio' };
  }

  async function log(entry) {
    try {
      await pool.query(
        `INSERT INTO ta_notifications (owner_key, load_id, stop_id, contact_id, channel, to_value, body, status, reason, provider_ref)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [entry.owner, entry.loadId || null, entry.stopId || null, entry.contactId || null,
          entry.channel, entry.to || null, entry.body, entry.status, entry.reason || null, entry.ref || null]);
    } catch (e) { console.error('[notify] log failed:', e.message); }
  }

  // ---- matching a Samsara stop to a contact ----
  //
  // Samsara gives us WHEN and WHERE (route stops, GPS, ETA). It does NOT give
  // us WHO to call — the real stop payload's `notes` field holds
  // "Deliver Freight / Bill #P044795", while the call-ahead instruction
  // ("CALL ISRAEL 413-883-7695 1HR BEFORE ARRIVING") lives on the printed trip
  // sheet and in TruckMate.
  //
  // Rather than wait on TruckMate access, we keep our own contact directory and
  // match it to Samsara stops. Entered once per customer, reused on every load.
  //
  // Matching order is deliberate: the Samsara address id is exact and stable,
  // so it wins. Name matching is a fallback, and it has to survive the way these
  // names actually appear — "BLOSSOMS AND BLOOMS WHOLESALE INC * (45744)".
  const normName = (s) => String(s || '')
    .toUpperCase()
    .replace(/\([^)]*\)/g, ' ')      // drop the trailing customer code
    .replace(/[*.,]/g, ' ')          // drop punctuation and the * marker
    .replace(/\b(INC|LLC|CORP|CO|THE|WHOLESALE|FLORIST|FLOWERS)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  async function findContactForStop(owner, stop) {
    if (!stop) return null;
    // 1. exact Samsara address id
    if (stop.addressId) {
      const { rows } = await pool.query(
        'SELECT * FROM ta_contacts WHERE owner_key = $1 AND samsara_address_id = $2 LIMIT 1',
        [owner, String(stop.addressId)]);
      if (rows.length) return { ...rows[0], matchedBy: 'samsara-address-id' };
    }
    // 2. normalised name
    const want = normName(stop.name);
    if (!want) return null;
    const { rows } = await pool.query('SELECT * FROM ta_contacts WHERE owner_key = $1', [owner]);
    const hit = rows.find((c) => normName(c.company || c.name) === want);
    return hit ? { ...hit, matchedBy: 'name' } : null;
  }

  // Which stops on this route need a call-ahead, and do we know who to call?
  // Unmatched stops are RETURNED, not hidden — a stop we can't contact is
  // exactly the thing a dispatcher needs to know about.
  app.post('/notify/plan', requireAuth, async (req, res) => {
    if (!db || !db.enabled) return res.status(503).json({ error: 'Needs DATABASE_URL.' });
    const { stops = [], truck = {} } = req.body || {};
    try {
      await ensureReady();
      const owner = String(req.user.company || req.user.id);
      const out = [];
      for (const s of stops) {
        if (s.arrivedAt || s.skippedAt) continue;
        const contact = await findContactForStop(owner, s);
        const item = {
          stop: s.name,
          addressId: s.addressId || null,
          bills: s.bills || [],
          appointmentAt: s.appointmentAt || null,
          contact: contact ? {
            id: contact.id, name: contact.name, channel: contact.channel,
            leadHours: Number(contact.lead_hours), matchedBy: contact.matchedBy,
            optedOut: contact.opted_out,
          } : null,
        };
        if (!contact) {
          item.gap = 'No contact on file — add one so this stop can be called ahead.';
        } else {
          const gate = canContact(contact);
          if (!gate.ok) item.gap = gate.reason;
        }
        out.push(item);
      }
      res.json({
        ok: true,
        stops: out,
        coverage: {
          total: out.length,
          contactable: out.filter((s) => s.contact && !s.gap).length,
          missing: out.filter((s) => !s.contact).length,
        },
      });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  // ---- the endpoint the dispatcher review calls ----
  app.post('/notify/call-ahead', requireAuth, async (req, res) => {
    if (!db || !db.enabled) return res.status(503).json({ error: 'Needs DATABASE_URL.' });
    const { contactId, loadId, stopId, stop = {}, etaMin, etaAt, force } = req.body || {};
    try {
      await ensureReady();
      const owner = String(req.user.company || req.user.id);
      const { rows } = await pool.query('SELECT * FROM ta_contacts WHERE id = $1 AND owner_key = $2', [contactId, owner]);
      const contact = rows[0];

      const gate = canContact(contact);
      const rendered = contact ? renderCallAhead({ contact, stop, etaMin, etaAt, tz: stop.timezone }) : null;

      if (!gate.ok && !force) {
        await log({ owner, loadId, stopId, contactId, channel: contact ? contact.channel : 'unknown',
          body: rendered ? rendered.sms : '', status: 'blocked', reason: gate.reason });
        return res.json({ ok: false, blocked: true, reason: gate.reason, preview: rendered });
      }

      const results = [];
      for (const ch of channelsFor(contact)) {
        const to = ch === 'sms' ? (contact.sms_phone || contact.phone) : contact.phone;
        if (!to) { results.push({ channel: ch, status: 'blocked', reason: 'no number on file' }); continue; }

        if (!allowSend) {
          // Dry run: render and record exactly what WOULD have been sent.
          await log({ owner, loadId, stopId, contactId, channel: ch, to,
            body: ch === 'sms' ? rendered.sms : rendered.voice, status: 'dry-run',
            reason: 'NOTIFY_ALLOW_SEND is not true' });
          results.push({ channel: ch, to, status: 'dry-run', body: ch === 'sms' ? rendered.sms : rendered.voice });
          continue;
        }

        const out = ch === 'sms'
          ? await sendSms({ to, body: rendered.sms, owner })
          : await placeCall({ to, say: rendered.voice });
        await log({ owner, loadId, stopId, contactId, channel: ch, to,
          body: ch === 'sms' ? rendered.sms : rendered.voice,
          status: out.ok ? 'sent' : 'failed',
          reason: out.reason || (out.via ? `via ${out.via}` : null), ref: out.ref });
        results.push({ channel: ch, to, status: out.ok ? 'sent' : 'failed', reason: out.reason, ref: out.ref, via: out.via });
      }

      res.json({ ok: true, dryRun: !allowSend, results, preview: rendered });
    } catch (e) {
      console.error('[notify] call-ahead failed:', e.message);
      res.status(502).json({ error: e.message });
    }
  });

  // ---- contact preferences ----
  app.put('/notify/contact', requireAuth, async (req, res) => {
    if (!db || !db.enabled) return res.status(503).json({ error: 'Needs DATABASE_URL.' });
    const b = req.body || {};
    if (b.channel && !CHANNELS.includes(b.channel)) {
      return res.status(400).json({ error: `channel must be one of: ${CHANNELS.join(', ')}` });
    }
    try {
      await ensureReady();
      const owner = String(req.user.company || req.user.id);
      const id = b.id || `C${Date.now()}${Math.floor(Math.random() * 1000)}`;
      await pool.query(
        `INSERT INTO ta_contacts (id, owner_key, name, company, phone, sms_phone, email, channel,
           lead_hours, timezone, quiet_start, quiet_end, consent_at, consent_by, opted_out, notes,
           samsara_address_id, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,now())
         ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, company=EXCLUDED.company,
           phone=EXCLUDED.phone, sms_phone=EXCLUDED.sms_phone, email=EXCLUDED.email,
           channel=EXCLUDED.channel, lead_hours=EXCLUDED.lead_hours, timezone=EXCLUDED.timezone,
           quiet_start=EXCLUDED.quiet_start, quiet_end=EXCLUDED.quiet_end,
           consent_at=EXCLUDED.consent_at, consent_by=EXCLUDED.consent_by,
           opted_out=EXCLUDED.opted_out, notes=EXCLUDED.notes,
           samsara_address_id=EXCLUDED.samsara_address_id, updated_at=now()`,
        [id, owner, b.name || null, b.company || null, b.phone || null, b.smsPhone || null,
          b.email || null, b.channel || 'sms', b.leadHours || 1, b.timezone || 'America/New_York',
          b.quietStart != null ? b.quietStart : 7, b.quietEnd != null ? b.quietEnd : 21,
          b.consentAt || null, b.consentBy || null, !!b.optedOut, b.notes || null,
          b.samsaraAddressId ? String(b.samsaraAddressId) : null]);
      res.json({ ok: true, id });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  app.get('/notify/log', requireAuth, async (req, res) => {
    if (!db || !db.enabled) return res.status(503).json({ error: 'Needs DATABASE_URL.' });
    try {
      await ensureReady();
      const owner = String(req.user.company || req.user.id);
      const args = [owner]; const where = ['owner_key = $1'];
      if (req.query.loadId) { args.push(req.query.loadId); where.push(`load_id = $${args.length}`); }
      const { rows } = await pool.query(
        `SELECT * FROM ta_notifications WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT 200`, args);
      res.json({ notifications: rows });
    } catch (e) { res.status(502).json({ error: e.message }); }
  });

  console.log(`[notify] contact API ready — sends ${allowSend ? 'ENABLED' : 'DRY-RUN'}, `
    + `SMS via ${ringcentral ? 'RingCentral (Twilio fallback)' : (configured ? 'Twilio' : 'NOTHING configured')}`);
  return { canContact, channelsFor, renderCallAhead, ensureReady };
}

// ---------------------------------------------------------------
// Outlook / Microsoft 365 email (Microsoft Graph, app-only).
//
// Set in Render (never in the code or the chat):
//   MS_TENANT_ID      — the company's Microsoft 365 tenant (directory) ID
//   MS_CLIENT_ID      — the Azure app registration's application (client) ID
//   MS_CLIENT_SECRET  — that app's client secret
//   MAIL_FROM         — the mailbox it sends from, e.g. dispatch-reports@floridabeauty.us
// The app needs the Microsoft Graph *application* permission Mail.Send with
// admin consent; IT can limit it to just MAIL_FROM (application access policy).
// ---------------------------------------------------------------

const GRAPH = 'https://graph.microsoft.com/v1.0';
let cached = { token: null, exp: 0 };

export function mailConfig(env = process.env) {
  const cfg = { tenant: env.MS_TENANT_ID, clientId: env.MS_CLIENT_ID, secret: env.MS_CLIENT_SECRET, from: env.MAIL_FROM };
  const missing = Object.entries({ MS_TENANT_ID: cfg.tenant, MS_CLIENT_ID: cfg.clientId, MS_CLIENT_SECRET: cfg.secret, MAIL_FROM: cfg.from }).filter(([, v]) => !v).map(([k]) => k);
  return { ...cfg, ready: !missing.length, missing };
}

async function token(cfg, fetchFn) {
  if (cached.token && cached.exp > Date.now() + 60000) return cached.token;
  const r = await fetchFn(`https://login.microsoftonline.com/${encodeURIComponent(cfg.tenant)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: cfg.clientId, client_secret: cfg.secret, scope: 'https://graph.microsoft.com/.default' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Outlook sign-in failed (${r.status}): ${j.error_description || j.error || 'unknown'}`);
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

// Any Graph call as the app (used by the Jarvis inbox).
export async function graph(path, { method = 'GET', body = null } = {}, { env = process.env, fetchFn = globalThis.fetch } = {}) {
  const cfg = mailConfig(env);
  if (!cfg.ready) throw new Error(`Outlook is not connected yet (missing ${cfg.missing.join(', ')} in Render).`);
  const t = await token(cfg, fetchFn);
  const r = await fetchFn(`${GRAPH}/users/${encodeURIComponent(cfg.from)}${path}`, { method, headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (r.status === 202 || r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Outlook (${r.status}): ${(j.error && j.error.message) || 'unknown'}`); e.status = r.status; throw e; }
  return j;
}

// sendMail({ to: [..], subject, html, attachments: [{ name, contentType, bytes }] })
// training mode (training.js) rewrites every email unless sent { direct: true }
let guard = null;
export const setMailGuard = (fn) => { guard = fn; };

export async function sendMail(message, { env = process.env, fetchFn = globalThis.fetch, direct = false } = {}) {
  const { to, cc = [], subject, html, text = null, attachments = [] } = guard && !direct ? await guard(message) : message;
  const cfg = mailConfig(env);
  if (!cfg.ready) throw new Error(`Outlook is not connected yet (missing ${cfg.missing.join(', ')} in Render).`);
  const list = (Array.isArray(to) ? to : String(to || '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter((x) => /@/.test(x));
  if (!list.length) throw new Error('No recipients.');
  const ccList = (Array.isArray(cc) ? cc : String(cc || '').split(/[,;\s]+/)).map((x) => String(x).trim()).filter((x) => /@/.test(x) && !list.includes(x));
  const t = await token(cfg, fetchFn);
  // with a plain-text twin (and no files): send MIME multipart/alternative so every mail app has a readable version
  if (text && !attachments.length) {
    const b64 = (x) => Buffer.from(String(x), 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
    const boundary = `jv_${Date.now().toString(36)}`;
    const mime = [`From: ${cfg.from}`, `To: ${list.join(', ')}`, ...(ccList.length ? [`Cc: ${ccList.join(', ')}`] : []), `Subject: =?UTF-8?B?${Buffer.from(String(subject || ''), 'utf8').toString('base64')}?=`, 'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
      `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(text),
      `--${boundary}`, 'Content-Type: text/html; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', b64(html), `--${boundary}--`, ''].join('\r\n');
    const r = await fetchFn(`${GRAPH}/users/${encodeURIComponent(cfg.from)}/sendMail`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'text/plain' }, body: Buffer.from(mime, 'utf8').toString('base64') });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(`Outlook could not send (${r.status}): ${(j.error && j.error.message) || 'unknown'}`); }
    return { ok: true, to: list, from: cfg.from, mime: true };
  }
  const body = {
    message: {
      subject,
      body: { contentType: 'HTML', content: html },
      toRecipients: list.map((address) => ({ emailAddress: { address } })),
      ccRecipients: ccList.map((address) => ({ emailAddress: { address } })),
      attachments: attachments.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.name, contentType: a.contentType || 'application/pdf', contentBytes: Buffer.from(a.bytes).toString('base64') })),
    },
    saveToSentItems: true,
  };
  const r = await fetchFn(`${GRAPH}/users/${encodeURIComponent(cfg.from)}/sendMail`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(`Outlook could not send (${r.status}): ${(j.error && j.error.message) || 'unknown'}`);
  }
  return { ok: true, to: list, from: cfg.from };
}

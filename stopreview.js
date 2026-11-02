// ---------------------------------------------------------------
// Extended stop review. The stop email asks dispatch whether the stop is authorized, and Jarvis goes by the answer: from the email's
// buttons, a staff reply to the email, or Solved in the console. Authorized ends the alerts for that stop until the truck really moves
// again, and everyone on the stop email is told who approved it and why. Not authorized keeps the normal alerts and says so.
// What people type is data, never instructions.
// ---------------------------------------------------------------
import { makeToken, readToken, page } from './breakdownreport.js';
import { applyStopReview, stopEpisodeFor } from './watchtower.js';

const STATE = (site) => `taWatch:${site}`;
const SITE = 'florida-beauty';
const MAX_REASON = 500;
const PURPOSE = 'stop-review';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const oneLine = (s, n) => String(s || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
export const STOP_WORD = { authorized: 'Authorized', unauthorized: 'Not authorized' };

const STYLE = '<style>.t{display:flex;border:1px solid #B8C3D3;border-radius:8px;overflow:hidden}.t input{position:absolute;opacity:0;width:1px;height:1px}.t label{flex:1;margin:0;padding:14px 8px;text-align:center;color:#13325B;cursor:pointer}.t input:checked+label{color:#fff}.t input#sa:checked+label{background:#166534}.t input#su:checked+label{background:#C62828}.t input:focus-visible+label{outline:3px solid #0B5CC8;outline-offset:-3px}button.go{background:#13325B}</style>';

// The page behind the email's buttons: a toggle, the reason and who is answering. Pure.
export function reviewPage(p, { review = null, ended = false, pick = null } = {}) {
  if (!p) return page('Link not valid', '<h1>This link has expired</h1><p class="s">Reply to the email, or mark it Solved in the console.</p>');
  const head = `<p class="s">Truck ${esc(p.u)} · Trip ${esc(p.t)}</p>`;
  if (ended) return page('Stop ended', `<h1>This stop has ended</h1>${head}<p>The truck has moved on, so nothing needs answering here.</p>`);
  const now = review ? `<p><b>${esc(review.by)}</b> marked this stop <b>${esc((STOP_WORD[review.status] || '').toLowerCase())}</b>${review.reason ? `: ${esc(review.reason)}` : '.'}</p>` : '';
  const on = pick || (review && review.status) || null;
  const radio = (id, value, label) => `<input type="radio" name="s" id="${id}" value="${value}"${on === value ? ' checked' : ''}><label for="${id}">${label}</label>`;
  return page(`Extended stop, truck ${p.u}`, `${STYLE}<h1>Extended stop</h1>${head}${now}<form id="f"><div class="t" role="radiogroup" aria-label="Is this stop authorized?">${radio('sa', 'authorized', 'Authorized')}${radio('su', 'unauthorized', 'Not authorized')}</div><label for="r" id="rl">Reason</label><textarea id="r" maxlength="${MAX_REASON}" placeholder="For example: hotel approved by Armando"></textarea><label for="n">Your name</label><input id="n" maxlength="80" required autocomplete="name"><button id="b" class="go" type="submit">Submit</button><div class="e" id="e" role="alert"></div></form><p class="n" id="h"></p><script>
var r=document.getElementById('r'),h=document.getElementById('h'),l=document.getElementById('rl');
function pick(){var s=document.querySelector('input[name=s]:checked');var a=s&&s.value==='authorized';r.required=!!a;l.textContent=s&&!a?'Note (optional)':'Reason';h.textContent=!s?'Choose one.':a?'This stops the alerts for this stop and emails the team your reason.':'The alerts keep going and the team is told.';}
document.querySelectorAll('input[name=s]').forEach(function(x){x.addEventListener('change',pick)});pick();
document.getElementById('f').addEventListener('submit',async function(ev){ev.preventDefault();var b=document.getElementById('b'),e=document.getElementById('e'),s=document.querySelector('input[name=s]:checked');e.textContent='';if(!s){e.textContent='Choose Authorized or Not authorized.';return;}b.disabled=true;try{var x=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({status:s.value,reason:r.value,name:document.getElementById('n').value})});var j=await x.json();if(!x.ok)throw new Error(j.error||'Could not save.');document.querySelector('.c').innerHTML='<h1>Saved</h1><p class="s">'+(s.value==='authorized'?'Alerts for this stop are off. ':'')+(j.emailed===false?'The email to the team did not go out, so please tell them.':'The team has the email.')+' You can close this page.</p>';}catch(y){e.textContent=y.message;b.disabled=false;}});
</script>`);
}

export function initStopReview(app, { db, secret, send, baseUrl = 'https://tagalong-backend-fdzx.onrender.com', now = () => Date.now() }) {
  const state = async () => (await db.get(STATE(SITE), {})) || {};
  const link = (a) => `${baseUrl}/sr/${makeToken({ a: a.id, t: a.trip, u: a.unit, s: a.stoppedSinceMs || null }, secret, now(), PURPOSE, 1)}`;   // a day: it can turn alerts off, and emails get forwarded
  const isAuthorized = async (a) => { const ep = stopEpisodeFor(await state(), { unit: a.unit, trip: a.trip }); return !!(ep && ep.review && ep.review.status === 'authorized'); };

  // Saves the answer once, then tells the same people the stop email went to.
  async function decide({ unit = null, trip = null, since = null, startAt = null, title = null, status, reason, by, source }) {
    const clean = oneLine(reason, MAX_REASON); const who = oneLine(by, 80);
    if (!STOP_WORD[status]) return { code: 400, error: 'Choose Authorized or Not authorized.' };
    if (status === 'authorized' && clean.length < 3) return { code: 400, error: 'Write why this stop is authorized.' };
    if (!who) return { code: 400, error: 'Add your name.' };
    const review = { status, reason: clean, by: who, source, atMs: now() };
    let out = null;
    await db.update(STATE(SITE), (cur) => { const r = applyStopReview(cur || {}, { unit, trip, since, startAt, title, review }); out = r.out; return r.state; }, {});
    if (!out.ok) return { code: 409, error: out.error };
    if (out.already) return { code: 200, ok: true, already: true };
    try { await send(out.ep, review); return { code: 200, ok: true, emailed: true }; } catch (e) { console.warn('[stop-review]', e.message); return { code: 200, ok: true, emailed: false }; }
  }

  if (app) {
    app.get('/sr/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now(), PURPOSE);
      const ep = p ? stopEpisodeFor(await state(), { unit: p.u }) : null;
      const ended = !!p && (!ep || (p.s != null && ep.stoppedSinceMs !== p.s));
      res.set('Cache-Control', 'no-store').type('html').send(reviewPage(p, { review: ep && ep.review, ended, pick: STOP_WORD[req.query.d] ? req.query.d : null }));
    });
    app.post('/sr/:token', async (req, res) => {
      const p = readToken(req.params.token, secret, now(), PURPOSE);
      if (!p) return res.status(403).json({ error: 'This link has expired.' });
      const { status, reason, name } = req.body || {};
      try { const r = await decide({ unit: p.u, trip: p.t, since: p.s, status, reason, by: name, source: 'email button' }); return res.status(r.code).json(r); } catch (e) { console.warn('[stop-review]', e.message); return res.status(500).json({ error: 'Could not save. Call dispatch.' }); }
    });
  }
  return { link, decide, isAuthorized };
}

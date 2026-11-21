import test from 'node:test';
import assert from 'node:assert/strict';
import { helpEmail, initHelpdesk } from '../helpdesk.js';
const request = { source: 'call', from: { name: 'Gussi Goose', phone: '7864028448' }, forStaff: [{name:'Nadim Tellez'}], need: "He's a mala para." };
test('callback email retains message, staff, call link and embedded illustration', () => {
  const m = helpEmail(request);
  assert.match(m.html, /A message for Nadim Tellez/);
  assert.match(m.html, /He&#39;s a mala para\./);
  assert.match(m.html, /href="tel:\+17864028448"/);
  assert.match(m.html, /background:#007aff/);
  assert.match(m.html, /mytagalong.app\/truckmate\?tab=inbox/);
  for (const a of m.attachments) {
    assert.ok(m.html.includes(`cid:${a.cid}`));
    assert.equal(a.bytes.subarray(1,4).toString(), 'PNG');
  }
});
test('no invented call action, assignment or source; HTML input is escaped', () => {
  const m = helpEmail({source:'text', from:{name:'<script>x</script>', email:'someone@example.com'}, need:'<img src=x>\nHelp & call', said:'Exact <words>', urgent:true});
  assert.doesNotMatch(m.html, /href="tel:|Assigned to|a Jarvis phone call|<script>|<img src=x>/);
  assert.match(m.html, /URGENT CALLBACK REQUEST/);
  assert.match(m.html, /a text message/);
  assert.match(m.html, /&lt;img src=x&gt;<br>Help &amp; call/);
  assert.match(m.html, /WHAT THEY SAID/);
  assert.match(m.html, /Exact &lt;words&gt;/);
  assert.match(m.html, /someone@example.com/);
});
test('notification passes the inline image attachments to the mail transport', async () => {
  const store=new Map([['taHelpCfg',{customerService:{emails:['staff@example.com']}}]]);
  const db={enabled:true,get:async(k,f)=>store.get(k)||f,update:async(k,fn,f)=>{const v=fn(store.get(k)||f);store.set(k,v);return v;}};
  const sent=[];
  const service=initHelpdesk({get(){},post(){},put(){}},{db,requireAuth(){},env:{NODE_ENV:'test'},mail:{ready:()=>true,send:async m=>sent.push(m)}});
  await service.raise({...request,ref:'test-callback-design',role:'customer'});
  assert.equal(sent.length,1);
  assert.equal(sent[0].attachments.length,2);
  assert.ok(sent[0].attachments.every(a=>sent[0].html.includes(`cid:${a.cid}`)));
});

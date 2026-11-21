import test from 'node:test';
import assert from 'node:assert/strict';

test('a text is signed once: Jarvis\'s own sign-off is replaced, never doubled; a multi-line text gets it on its own line', async () => {
  const { signText } = await import('../ringcentral.js');
  assert.equal(signText('TEMP UPDATE\nTrailer 7387 | Trip 627491\nJarvis · Florida Beauty Dispatch'), 'TEMP UPDATE\nTrailer 7387 | Trip 627491\nJarvis (AI), Florida Beauty Dispatch');
  assert.equal(signText('Call back Gus (786) 402-8448: about the load — Jarvis'), 'Call back Gus (786) 402-8448: about the load — Jarvis (AI), Florida Beauty Dispatch');
  assert.equal(signText('On my way', 'Nadim Tellez'), 'On my way — Nadim Tellez, Florida Beauty Dispatch');
});

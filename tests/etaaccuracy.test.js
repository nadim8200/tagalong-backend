import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreStop, accuracySummary } from '../etareport.js';

const H = 3600000;
const T = Date.parse('2026-11-21T11:25:00Z');   // the truck arrived in Ludlow 6:25 AM ET

test('a stop scored against the real arrival: each source\'s ETA as it stood 1, 2, 4, 8, 24 h before, and at ARTIS\'s read', () => {
  const h = {
    ours: [{ at: T - 26 * H, etaMs: T + 3 * H }, { at: T - 5 * H, etaMs: T + 20 * 60000 }, { at: T - 90 * 60000, etaMs: T + 5 * 60000 }],
    artis: [{ at: T - 2.3 * H, etaMs: T + 102 * 60000 }],                     // read 4:06 AM: 8:07 AM
  };
  const s = scoreStop(h, T);
  assert.deepEqual(s.ours, { h1: -5, h2: -20, h4: -20, h8: -180, h24: -180, last: -5, atArtisRead: -20 });
  assert.deepEqual(s.artis, { h1: -102, h2: -102, h4: null, h8: null, h24: null, last: -102, readHoursBefore: 2.3 });
  assert.equal(scoreStop({ ours: [{ at: T + H, etaMs: T }] }, T), null);     // nothing given before the arrival
});

test('the summary: average minutes off, within 30 / 60 min, the lean, and who was closer', () => {
  const rows = [
    { ours: { atArtisRead: -20, h1: -5, h2: -20, h4: null, h8: null, h24: null, last: -5 }, artis: { last: -102, h1: -102, h2: null, h4: null, h8: null, h24: null } },
    { ours: { atArtisRead: 40, h1: 10, h2: 40, h4: 60, h8: null, h24: null, last: 10 }, artis: { last: 30, h1: 30, h2: 30, h4: null, h8: null, h24: null } },
  ];
  const s = accuracySummary(rows);
  assert.deepEqual(s.atArtisRead.ours, { n: 2, avgOff: 30, within30: 50, within60: 100, lean: 10 });
  assert.deepEqual(s.atArtisRead.artis, { n: 2, avgOff: 66, within30: 50, within60: 50, lean: -36 });
  assert.deepEqual([s.atArtisRead.both, s.atArtisRead.oursCloser, s.atArtisRead.artisCloser], [2, 1, 1]);
  assert.deepEqual([s.h1.oursCloser, s.h1.artisCloser], [2, 0]);
  assert.equal(s.h4.artis, null);
});

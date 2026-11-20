// House edge checks: exact maths where it exists, Monte-Carlo for the slot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as M from '../src/games/math.js';

const rnd = n => Array.from({ length: n }, () => crypto.randomInt(0, 2 ** 32) / 2 ** 32);

test('slot RTP ≈ 95% (2M spins, ±0.8%)', () => {
  let ret = 0; const N = 2_000_000;
  for (let i = 0; i < N; i++) ret += M.slotSpin(rnd(15)).multiplier;
  const rtp = ret / N;
  assert.ok(Math.abs(rtp - 0.95) < 0.008, `slot RTP ${rtp}`);
});

test('crash: P(point ≥ m) = 0.96/m', () => {
  // exact: point ≥ m  ⇔  floor(96/(1-f))/100 ≥ m  ⇔  f ≥ 1 - 0.96/m (up to the 0.01 grid)
  for (const m of [1.5, 2, 10, 100]) {
    const f = 1 - 0.96 / m + 1e-12;
    assert.ok(M.crashPoint(f) >= m - 0.01);
    assert.ok(M.crashPoint(1 - 0.96 / m - 1e-4) < m);
  }
  assert.equal(M.crashPoint(0), 1);
});

test('dice RTP = 98% for every chance', () => {
  for (const ch of [1, 10, 49.5, 95]) assert.ok(Math.abs((ch / 100) * M.diceMultiplier(ch) - 0.98) < 1e-12);
});

test('mines RTP ≤ 96% for every board and pick count', () => {
  for (let m = 1; m <= 24; m++) for (let k = 1; k <= 25 - m; k++) {
    let p = 1; for (let i = 0; i < k; i++) p *= (25 - m - i) / (25 - i);
    const rtp = p * M.minesMultiplier(m, k);
    assert.ok(rtp <= 0.96 + 1e-9, `m=${m} k=${k} rtp=${rtp}`);
  }
});

test('roulette: every bet returns 36/37', () => {
  for (const key of M.ROULETTE_KEYS) {
    let s = 0; for (let n = 0; n <= 36; n++) s += M.rouletteReturn(key, n);
    assert.ok(Math.abs(s / 37 - 36 / 37) < 1e-12, key);
  }
});

test('payouts never round in the player\'s favour', () => {
  assert.equal(M.payoutOf(10000, 98 / 49.5), 19797);
  assert.equal(M.payoutOf(1, 1.99), 1);
  assert.equal(M.payoutOf(5_000_000_00, 1000), 5_000_000_00 * 1000);
});

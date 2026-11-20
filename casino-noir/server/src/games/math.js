// Pure game math. Inputs are provably-fair floats in [0,1). Multipliers are "total return per 1 unit staked".
// Theoretical RTP: slot 95.0% (Monte-Carlo), roulette 97.3%, crash 96%, mines 96%, dice 98%.

export const RTP = { slot: 0.95, roulette: 36 / 37, crash: 0.96, mines: 0.96, dice: 0.98 };

/* ---------------- Slot: 5×3, 10 fixed lines, ★ wild ---------------- */
export const SLOT = {
  sym: ['J', 'Q', 'K', 'A', 'S', 'H', 'D', '7', 'W'],
  w: [30, 28, 25, 22, 14, 12, 8, 5, 4],
  pay: { J: [10, 30, 80], Q: [12, 32, 100], K: [16, 40, 125], A: [21, 50, 160], S: [30, 100, 300], H: [40, 125, 400], D: [60, 200, 800], 7: [100, 400, 2000], W: [100, 400, 2000] },
  lines: [[1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],[0,0,1,2,2],[2,2,1,0,0],[1,0,0,0,1],[1,2,2,2,1],[1,0,1,2,1]],
};
const SLOT_TOTAL = SLOT.w.reduce((a, b) => a + b);
function slotPick(f) {
  let r = f * SLOT_TOTAL;
  for (let i = 0; i < SLOT.w.length; i++) { r -= SLOT.w[i]; if (r < 0) return SLOT.sym[i]; }
  return SLOT.sym[0];
}
function slotLine(cells) {
  let base = null, n = 0;
  for (const s of cells) { if (s === 'W') { n++; continue; } if (base === null) { base = s; n++; continue; } if (s === base) n++; else break; }
  let wn = 0; for (const s of cells) { if (s === 'W') wn++; else break; }
  const p1 = base && n >= 3 ? SLOT.pay[base][n - 3] : 0, p2 = wn >= 3 ? SLOT.pay.W[wn - 3] : 0;
  return p1 >= p2 ? { pay: p1, n } : { pay: p2, n: wn };
}
/** Returns grid[reel][row], winning lines and total multiplier (sum of line pays / 10 lines). */
export function slotSpin(floats) {
  const grid = [0, 1, 2, 3, 4].map(r => [0, 1, 2].map(i => slotPick(floats[r * 3 + i])));
  let pays = 0; const wins = [];
  SLOT.lines.forEach((L, li) => {
    const w = slotLine(L.map((row, r) => grid[r][row]));
    if (w.pay) { pays += w.pay; wins.push({ line: li, count: w.n, pay: w.pay }); }
  });
  return { grid, wins, multiplier: pays / 10 };
}

/* ---------------- European roulette ---------------- */
export const ROULETTE_ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
export const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
export const ROULETTE_KEYS = new Set(['red','black','even','odd','low','high','d1','d2','d3','c1','c2','c3', ...Array.from({ length: 37 }, (_, i) => 'n' + i)]);
export function rouletteReturn(key, n) {
  if (key[0] === 'n') return +key.slice(1) === n ? 36 : 0;
  if (n === 0) return 0;
  switch (key) {
    case 'red': return REDS.has(n) ? 2 : 0; case 'black': return !REDS.has(n) ? 2 : 0;
    case 'even': return n % 2 === 0 ? 2 : 0; case 'odd': return n % 2 ? 2 : 0;
    case 'low': return n <= 18 ? 2 : 0; case 'high': return n >= 19 ? 2 : 0;
    case 'd1': return n <= 12 ? 3 : 0; case 'd2': return n > 12 && n <= 24 ? 3 : 0; case 'd3': return n > 24 ? 3 : 0;
    case 'c1': return n % 3 === 1 ? 3 : 0; case 'c2': return n % 3 === 2 ? 3 : 0; case 'c3': return n % 3 === 0 ? 3 : 0;
  }
  return 0;
}
export const rouletteNumber = f => Math.floor(f * 37);

/* ---------------- Dice: win if roll < chance; multiplier = 98 / chance ---------------- */
export const diceRoll = f => Math.floor(f * 10000) / 100;          // 0.00 – 99.99
export const diceMultiplier = chance => 98 / chance;
export const validChance = c => Number.isFinite(c) && c >= 1 && c <= 95 && Math.round(c * 2) === c * 2;

/* ---------------- Mines: 5×5, payout = 0.96 / P(k safe picks) ---------------- */
export function minesPositions(floats, count) {
  const idx = [...Array(25).keys()];
  for (let i = 24; i > 0; i--) { const j = Math.floor(floats[24 - i] * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  return idx.slice(0, count).sort((a, b) => a - b);
}
export function minesMultiplier(mines, picks) {
  if (!picks) return 1;
  let p = 1; for (let i = 0; i < picks; i++) p *= (25 - mines - i) / (25 - i);
  return Math.floor((RTP.mines / p) * 100) / 100;
}

/* ---------------- Crash: P(point ≥ m) = 0.96 / m ---------------- */
export const CRASH_K = 0.00012;                                   // m(t) = e^(k·t ms)
export const crashPoint = f => Math.min(1000, Math.max(1, Math.floor(96 / (1 - f)) / 100));
export const crashAt = ms => Math.floor(Math.exp(CRASH_K * ms) * 100) / 100;
export const crashTimeMs = m => Math.log(m) / CRASH_K;

/** floor(stake × multiplier), multiplier truncated to 4 decimals, exact integer math (never rounds in the player's favour). */
export const payoutOf = (stake, mult) => Number((BigInt(stake) * BigInt(Math.floor(mult * 10000 + 1e-7))) / 10000n);

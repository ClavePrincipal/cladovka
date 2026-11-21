// Demo odds feed for test stands (never runs in production, where a real feed or traders manage the line).
// Keeps the line alive: scheduled matches go live at kick-off, live matches tick and drift, finish after
// MATCH_MINUTES and are settled by their true probabilities, and each finished match is replaced by a new one.
import crypto from 'node:crypto';

const MATCH_MINUTES = 105;
const TOP = new Set(['Лига чемпионов УЕФА', 'Англия. Премьер-лига', 'Испания. Ла Лига', 'НХЛ', 'NBA', 'ATP Финал', 'WTA Финал', 'UFC']);
const prematchMargin = league => (TOP.has(league) ? 0.05 : 0.08);
const LIVE_MARGIN = 0.07;
const clockFor = (sport, min) => {
  if (sport === 'football') return Math.min(90, Math.max(1, Math.round(min * 90 / MATCH_MINUTES))) + '′';
  if (sport === 'hockey') return (min < 35 ? 1 : min < 70 ? 2 : 3) + '-й пер.';
  if (sport === 'tennis') return (min < 40 ? 1 : min < 80 ? 2 : 3) + '-й сет';
  if (sport === 'basket') return Math.min(4, 1 + Math.floor(min / 27)) + '-я чет.';
  if (sport === 'esports') return 'Карта ' + Math.min(3, 1 + Math.floor(min / 40));
  return 'Live';
};
const rnd = () => crypto.randomInt(0, 1_000_000) / 1_000_000;
const pick = probs => { const r = rnd(); return r < probs[0] ? 0 : r < probs[0] + probs[1] ? 1 : 2; };

export async function demoFeedTick({ pool, sport }) {
  const now = Date.now();
  // 1. Kick-off.
  const due = (await pool.query(`SELECT * FROM sport_events WHERE status='scheduled' AND starts_at <= now()`)).rows;
  for (const e of due) await sport.update(e.id, { status: 'live', margin: LIVE_MARGIN, clock: clockFor(e.sport, 0), score: [0, 0] });

  // 2. Running matches: clock, small price drift, occasional score change; finish and replace.
  const live = (await pool.query(`SELECT * FROM sport_events WHERE status='live'`)).rows;
  let settled = 0;
  for (const e of live) {
    const min = (now - new Date(e.starts_at).getTime()) / 60000;
    if (min >= MATCH_MINUTES) {
      const result = pick(e.probs);
      await sport.update(e.id, { score: result === 0 ? [e.score[0] + 1, e.score[1]] : result === 2 ? [e.score[0], e.score[1] + 1] : e.score });
      await sport.settle(e.id, { result });
      await sport.create({ sport: e.sport, league: e.league, home: e.home, away: e.away, probs: e.probs.map(Number), margin: prematchMargin(e.league),
        startsAt: new Date(now + (2 + crypto.randomInt(0, 46)) * 3600e3).toISOString() });
      settled++;
      continue;
    }
    const p = e.probs.map(Number), d = (rnd() - 0.5) * 0.03;
    p[0] = Math.min(0.9, Math.max(0.05, p[0] + d));
    const rest = 1 - p[0];
    if (p[1] > 0) { const s = p[1] + p[2]; p[1] = rest * p[1] / s; p[2] = rest * p[2] / s; } else p[2] = rest;
    const score = rnd() < 0.03 ? (rnd() < p[0] ? [e.score[0] + 1, e.score[1]] : [e.score[0], e.score[1] + 1]) : e.score;
    await sport.update(e.id, { probs: p.map(x => Math.round(x * 100000) / 100000), clock: clockFor(e.sport, min), score });
  }
  return { started: due.length, settled };
}

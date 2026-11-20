// Sportsbook: 1X2 markets, singles and accumulators, odds-change protection, settlement and voids.
import { tx } from './db.js';
import { post, balances } from './ledger.js';
import { assertCanPlay } from './rg.js';
import { progress } from './bonus.js';
import { fail } from './errors.js';
import { metrics } from './metrics.js';

export const oddsFrom = (probs, margin) =>
  probs.map(p => (p > 0 ? Math.max(1.01, Math.floor(100 / (p * (1 + margin))) / 100) : 0));

export const ACCA_BOOST = { minLegs: 4, factor: 1.1 };

export function makeSport({ pool, cfg }) {
  const pub = e => ({ id: e.id, sport: e.sport, league: e.league, home: e.home, away: e.away, startsAt: e.starts_at,
    status: e.status, clock: e.live_clock, score: e.score, odds: e.odds, margin: e.margin });

  async function settleBetsFor(c, eventId) {
    const bets = (await c.query(`SELECT b.* FROM sport_bets b WHERE b.status = 'pending'
      AND b.id IN (SELECT bet_id FROM sport_selections WHERE event_id = $1) ORDER BY b.id FOR UPDATE`, [eventId])).rows;
    let settled = 0;
    for (const b of bets) {
      const sels = (await c.query(`SELECT s.*, e.status AS ev_status, e.result AS ev_result FROM sport_selections s
        JOIN sport_events e ON e.id = s.event_id WHERE s.bet_id = $1`, [b.id])).rows;
      for (const s of sels) {
        let res = null;
        if (s.ev_status === 'cancelled') res = 'void';
        else if (s.ev_status === 'finished') res = s.ev_result === s.outcome ? 'won' : 'lost';
        if (res && res !== s.result) { await c.query('UPDATE sport_selections SET result=$3 WHERE bet_id=$1 AND event_id=$2', [b.id, s.event_id, res]); s.result = res; }
      }
      if (sels.some(s => s.result === 'lost')) {
        await c.query(`UPDATE sport_bets SET status='lost', settled_at=now() WHERE id=$1`, [b.id]); settled++; continue;
      }
      if (sels.some(s => !s.result)) continue; // wait for the remaining legs
      const live = sels.filter(s => s.result === 'won');
      let status, payout;
      if (!live.length) { status = 'void'; payout = b.stake; }
      else {
        const odds = live.reduce((a, s) => a * s.odds, 1);
        const boost = b.kind === 'express' && live.length >= ACCA_BOOST.minLegs ? b.boost : 1;
        status = 'won'; payout = Math.min(cfg.MAX_PAYOUT, Math.floor(b.stake * odds * boost));
      }
      await c.query(`UPDATE sport_bets SET status=$2, payout=$3, settled_at=now() WHERE id=$1`, [b.id, status, payout]);
      await post(c, { userId: b.user_id, type: status === 'void' ? 'refund' : 'win', amount: payout, refType: 'sport_bet', refId: b.id,
        key: `sport:settle:${b.id}`, meta: { product: 'sport' } });
      metrics.payout.inc({ product: 'sport' }, payout);
      settled++;
    }
    return settled;
  }

  return {
    list: async () => (await pool.query(`SELECT * FROM sport_events WHERE status IN ('scheduled','live','suspended')
      ORDER BY (status='live') DESC, starts_at LIMIT 500`)).rows.map(pub),

    /**
     * selections: [{ eventId, outcome, odds }] — odds the player saw. If any current price is lower, the bet is
     * rejected with ODDS_CHANGED and the new prices so the client can ask the player to confirm.
     */
    place: (userId, { kind, stake, selections }) => tx(pool, async c => {
      if (!Number.isSafeInteger(stake) || stake < cfg.MIN_BET) fail('BET_TOO_SMALL', `Минимальная ставка ${cfg.MIN_BET / 100}`, 400);
      if (!Array.isArray(selections) || !selections.length || selections.length > 20) fail('VALIDATION', 'От 1 до 20 событий в купоне', 400);
      const ids = selections.map(s => s.eventId);
      if (new Set(ids).size !== ids.length) fail('VALIDATION', 'Одно событие можно добавить в купон только один раз', 400);
      if (kind === 'express' && selections.length < 2) fail('VALIDATION', 'В экспрессе минимум 2 события', 400);
      const user = (await c.query('SELECT id, status FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
      const total = kind === 'express' ? stake : stake * selections.length;
      if (total > cfg.MAX_BET) fail('BET_TOO_LARGE', `Максимальная ставка ${cfg.MAX_BET / 100}`, 400);
      await assertCanPlay(c, user, total);
      const evs = (await c.query(`SELECT * FROM sport_events WHERE id = ANY($1) FOR SHARE`, [ids])).rows;
      const byId = new Map(evs.map(e => [e.id, e]));
      const changed = [];
      for (const s of selections) {
        const e = byId.get(s.eventId);
        if (!e || !['scheduled', 'live'].includes(e.status) || (e.status === 'scheduled' && e.starts_at <= new Date()))
          fail('EVENT_CLOSED', `Приём ставок на событие закрыт`, 409, { eventId: s.eventId });
        if (![0, 1, 2].includes(s.outcome) || !(e.odds[s.outcome] > 1)) fail('VALIDATION', 'Исход недоступен', 400);
        if (e.odds[s.outcome] < s.odds) changed.push({ eventId: e.id, outcome: s.outcome, odds: e.odds[s.outcome] });
      }
      if (changed.length) fail('ODDS_CHANGED', 'Коэффициенты изменились. Проверьте купон.', 409, { changed });

      const legs = selections.map(s => ({ ...s, odds: byId.get(s.eventId).odds[s.outcome] }));
      const groups = kind === 'express' ? [legs] : legs.map(l => [l]);
      const created = [];
      for (const g of groups) {
        const odds = g.reduce((a, l) => a * l.odds, 1);
        const boost = kind === 'express' && g.length >= ACCA_BOOST.minLegs ? ACCA_BOOST.factor : 1;
        if (Math.floor(stake * odds * boost) > cfg.MAX_PAYOUT) fail('PAYOUT_TOO_LARGE', 'Возможный выигрыш больше лимита на ставку', 400);
        const b = (await c.query(`INSERT INTO sport_bets (user_id, kind, stake, odds, boost) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [userId, kind === 'express' ? 'express' : 'single', stake, Math.round(odds * 100) / 100, boost])).rows[0];
        for (const l of g) await c.query('INSERT INTO sport_selections (bet_id, event_id, outcome, odds) VALUES ($1,$2,$3,$4)', [b.id, l.eventId, l.outcome, l.odds]);
        await post(c, { userId, type: 'bet', amount: -stake, refType: 'sport_bet', refId: b.id, key: `sport:bet:${b.id}`, meta: { product: 'sport' } });
        await progress(c, userId, stake);
        metrics.bets.inc({ product: 'sport' }); metrics.stake.inc({ product: 'sport' }, stake);
        created.push(b.id);
      }
      return { betIds: created, balance: (await balances(c, userId)).cash };
    }),

    myBets: async userId => {
      const bets = (await pool.query(`SELECT * FROM sport_bets WHERE user_id=$1 ORDER BY id DESC LIMIT 50`, [userId])).rows;
      if (!bets.length) return [];
      const sels = (await pool.query(`SELECT s.*, e.home, e.away FROM sport_selections s JOIN sport_events e ON e.id=s.event_id
        WHERE s.bet_id = ANY($1)`, [bets.map(b => b.id)])).rows;
      return bets.map(b => ({ id: b.id, kind: b.kind, stake: b.stake, odds: b.odds, boost: b.boost, status: b.status, payout: b.payout,
        createdAt: b.created_at, selections: sels.filter(s => s.bet_id === b.id).map(s => ({ eventId: s.event_id, label: `${s.home} — ${s.away}`, outcome: s.outcome, odds: s.odds, result: s.result })) }));
    },

    /* ---- trader / admin ---- */
    create: async (e) => {
      const odds = oddsFrom(e.probs, e.margin);
      return (await pool.query(`INSERT INTO sport_events (sport, league, home, away, starts_at, probs, margin, odds, feed_ref)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [e.sport, e.league, e.home, e.away, e.startsAt, e.probs, e.margin, odds, e.feedRef ?? null])).rows[0];
    },
    update: (id, patch) => tx(pool, async c => {
      const e = (await c.query('SELECT * FROM sport_events WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!e) fail('NOT_FOUND', 'Событие не найдено', 404);
      if (['finished', 'cancelled'].includes(e.status)) fail('EVENT_CLOSED', 'Событие уже рассчитано', 409);
      const probs = patch.probs ?? e.probs, margin = patch.margin ?? e.margin;
      const r = await c.query(`UPDATE sport_events SET probs=$2, margin=$3, odds=$4, status=$5, live_clock=$6, score=$7, starts_at=$8, updated_at=now()
        WHERE id=$1 RETURNING *`, [id, probs, margin, oddsFrom(probs, margin), patch.status ?? e.status, patch.clock ?? e.live_clock,
        patch.score ?? e.score, patch.startsAt ?? e.starts_at]);
      return r.rows[0];
    }),
    settle: (id, { result, cancel }) => tx(pool, async c => {
      const e = (await c.query('SELECT * FROM sport_events WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!e) fail('NOT_FOUND', 'Событие не найдено', 404);
      if (['finished', 'cancelled'].includes(e.status)) fail('EVENT_CLOSED', 'Событие уже рассчитано', 409);
      if (!cancel && !(e.odds[result] > 1)) fail('VALIDATION', 'Некорректный итог', 400);
      await c.query(`UPDATE sport_events SET status=$2, result=$3, updated_at=now() WHERE id=$1`, [id, cancel ? 'cancelled' : 'finished', cancel ? null : result]);
      return { settledBets: await settleBetsFor(c, id) };
    }),
  };
}

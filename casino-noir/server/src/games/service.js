// Casino game service. Every action runs in one DB transaction: checks → debit → RNG → credit → round record.
import { tx } from '../lib/db.js';
import { post, balances } from '../lib/ledger.js';
import { nextFloats } from '../lib/fair.js';
import { assertCanPlay } from '../lib/rg.js';
import { progressCasino } from '../lib/bonus.js';
import { onBigWin } from '../lib/aml.js';
import { fail } from '../lib/errors.js';
import { metrics } from '../lib/metrics.js';
import * as M from './math.js';

export function makeCasino({ pool, cfg }) {
  function checkStake(bet) {
    if (!Number.isSafeInteger(bet) || bet < cfg.MIN_BET) fail('BET_TOO_SMALL', `Минимальная ставка ${cfg.MIN_BET / 100}`, 400);
    if (bet > cfg.MAX_BET) fail('BET_TOO_LARGE', `Максимальная ставка ${cfg.MAX_BET / 100}`, 400);
  }

  async function lockUser(c, userId) {
    const u = (await c.query('SELECT id, status FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!u) fail('NO_USER', 'Игрок не найден', 404);
    return u;
  }

  async function precheck(c, user, bet) {
    checkStake(bet);
    await assertCanPlay(c, user, bet);
  }

  async function debit(c, user, game, bet, roundId) {
    await post(c, { userId: user.id, type: 'bet', amount: -bet, refType: 'round', refId: roundId, key: `bet:round:${roundId}`, meta: { game } });
    await progressCasino(c, user.id, game, bet);
    metrics.bets.inc({ product: game }); metrics.stake.inc({ product: game }, bet);
  }

  async function credit(c, userId, game, roundId, bet, payout) {
    payout = Math.min(payout, cfg.MAX_PAYOUT);
    if (payout > 0) {
      await post(c, { userId, type: 'win', amount: payout, refType: 'round', refId: roundId, key: `win:round:${roundId}`, meta: { game } });
      metrics.payout.inc({ product: game }, payout);
      await onBigWin(c, userId, game, bet, payout);
    }
    return payout;
  }

  async function settleInstant(c, user, game, bet, n, compute) {
    await precheck(c, user, bet);
    const rng = await nextFloats(c, user.id, n);
    const { payout: raw, result } = compute(rng.floats);
    const r = await c.query(`INSERT INTO game_rounds (user_id, game, bet, status, seed_id, nonce, result, settled_at)
      VALUES ($1,$2,$3,'settled',$4,$5,$6, now()) RETURNING id`, [user.id, game, bet, rng.seedId, rng.nonce, result]);
    const id = r.rows[0].id;
    await debit(c, user, game, bet, id);
    const payout = await credit(c, user.id, game, id, bet, raw);
    await c.query('UPDATE game_rounds SET payout = $1 WHERE id = $2', [payout, id]);
    return { roundId: id, nonce: rng.nonce, bet, payout, result, balance: (await balances(c, user.id)).cash };
  }

  return {
    slot: (userId, bet) => tx(pool, async c => {
      const u = await lockUser(c, userId);
      return settleInstant(c, u, 'slot', bet, 15, f => {
        const s = M.slotSpin(f);
        return { payout: M.payoutOf(bet, s.multiplier), result: s };
      });
    }),

    roulette: (userId, bets) => tx(pool, async c => {
      const entries = Object.entries(bets || {});
      if (!entries.length || entries.length > 50) fail('VALIDATION', 'Поставьте от 1 до 50 фишек', 400);
      for (const [k, v] of entries) {
        if (!M.ROULETTE_KEYS.has(k)) fail('VALIDATION', 'Неизвестная ставка: ' + k, 400);
        if (!Number.isSafeInteger(v) || v <= 0) fail('VALIDATION', 'Некорректная сумма фишки', 400);
      }
      const total = entries.reduce((a, [, v]) => a + v, 0);
      const u = await lockUser(c, userId);
      return settleInstant(c, u, 'roulette', total, 1, f => {
        const n = M.rouletteNumber(f[0]);
        const payout = entries.reduce((a, [k, v]) => a + v * M.rouletteReturn(k, n), 0);
        return { payout, result: { number: n, bets } };
      });
    }),

    dice: (userId, bet, chance) => tx(pool, async c => {
      if (!M.validChance(chance)) fail('VALIDATION', 'Шанс должен быть от 1 до 95 с шагом 0,5', 400);
      const u = await lockUser(c, userId);
      return settleInstant(c, u, 'dice', bet, 1, f => {
        const roll = M.diceRoll(f[0]); const won = roll < chance;
        return { payout: won ? M.payoutOf(bet, M.diceMultiplier(chance)) : 0, result: { roll, chance, won } };
      });
    }),

    /* ---------- Mines (multi-step) ---------- */
    minesStart: (userId, bet, mines) => tx(pool, async c => {
      if (!Number.isInteger(mines) || mines < 1 || mines > 24) fail('VALIDATION', 'Мин должно быть от 1 до 24', 400);
      const u = await lockUser(c, userId);
      const open = await c.query(`SELECT id FROM game_rounds WHERE user_id=$1 AND game='mines' AND status='open'`, [userId]);
      if (open.rowCount) fail('ROUND_OPEN', 'У вас уже есть незавершённая игра в Мины', 409);
      await precheck(c, u, bet);
      const rng = await nextFloats(c, userId, 24);
      const r = await c.query(`INSERT INTO game_rounds (user_id, game, bet, status, seed_id, nonce, state, result)
        VALUES ($1,'mines',$2,'open',$3,$4,$5,$6) RETURNING id`,
        [userId, bet, rng.seedId, rng.nonce, { mines: M.minesPositions(rng.floats, mines) }, { count: mines, picks: [] }]);
      await debit(c, u, 'mines', bet, r.rows[0].id);
      return { roundId: r.rows[0].id, mines, picks: [], multiplier: 1, next: M.minesMultiplier(mines, 1), balance: (await balances(c, userId)).cash };
    }),

    minesReveal: (userId, tile) => tx(pool, async c => {
      if (!Number.isInteger(tile) || tile < 0 || tile > 24) fail('VALIDATION', 'Клетка 0–24', 400);
      const r = (await c.query(`SELECT * FROM game_rounds WHERE user_id=$1 AND game='mines' AND status='open' FOR UPDATE`, [userId])).rows[0];
      if (!r) fail('NO_ROUND', 'Нет активной игры', 409);
      const picks = r.result.picks;
      if (picks.includes(tile)) fail('VALIDATION', 'Клетка уже открыта', 400);
      const count = r.result.count, mines = r.state.mines;
      if (mines.includes(tile)) {
        const result = { count, picks: [...picks, tile], hit: tile, mines };
        await c.query(`UPDATE game_rounds SET status='settled', result=$2, settled_at=now() WHERE id=$1`, [r.id, result]);
        return { roundId: r.id, lost: true, ...result, balance: (await balances(c, userId)).cash };
      }
      const np = [...picks, tile], mult = M.minesMultiplier(count, np.length);
      if (np.length === 25 - count) { // board cleared: auto cash-out
        const payout = await credit(c, userId, 'mines', r.id, r.bet, M.payoutOf(r.bet, mult));
        const result = { count, picks: np, mines, multiplier: mult };
        await c.query(`UPDATE game_rounds SET status='settled', payout=$2, result=$3, settled_at=now() WHERE id=$1`, [r.id, payout, result]);
        return { roundId: r.id, finished: true, payout, ...result, balance: (await balances(c, userId)).cash };
      }
      await c.query(`UPDATE game_rounds SET result=$2 WHERE id=$1`, [r.id, { count, picks: np }]);
      return { roundId: r.id, picks: np, multiplier: mult, next: M.minesMultiplier(count, np.length + 1) };
    }),

    minesCashout: userId => tx(pool, async c => {
      const r = (await c.query(`SELECT * FROM game_rounds WHERE user_id=$1 AND game='mines' AND status='open' FOR UPDATE`, [userId])).rows[0];
      if (!r) fail('NO_ROUND', 'Нет активной игры', 409);
      if (!r.result.picks.length) fail('VALIDATION', 'Откройте хотя бы одну клетку', 400);
      const mult = M.minesMultiplier(r.result.count, r.result.picks.length);
      const payout = await credit(c, userId, 'mines', r.id, r.bet, M.payoutOf(r.bet, mult));
      const result = { ...r.result, mines: r.state.mines, multiplier: mult };
      await c.query(`UPDATE game_rounds SET status='settled', payout=$2, result=$3, settled_at=now() WHERE id=$1`, [r.id, payout, result]);
      return { roundId: r.id, payout, ...result, balance: (await balances(c, userId)).cash };
    }),

    minesState: async userId => {
      const r = (await pool.query(`SELECT id, bet, result FROM game_rounds WHERE user_id=$1 AND game='mines' AND status='open'`, [userId])).rows[0];
      if (!r) return null;
      return { roundId: r.id, bet: r.bet, mines: r.result.count, picks: r.result.picks, multiplier: M.minesMultiplier(r.result.count, r.result.picks.length) };
    },

    /* ---------- Crash (server clock is authoritative) ---------- */
    crashStart: (userId, bet, autoCashout) => tx(pool, async c => {
      if (autoCashout != null && !(autoCashout >= 1.01 && autoCashout <= 1000)) fail('VALIDATION', 'Автовывод от 1.01 до 1000', 400);
      const u = await lockUser(c, userId);
      const open = await c.query(`SELECT id FROM game_rounds WHERE user_id=$1 AND game='crash' AND status='open'`, [userId]);
      if (open.rowCount) fail('ROUND_OPEN', 'Раунд уже идёт', 409);
      await precheck(c, u, bet);
      const rng = await nextFloats(c, userId, 1);
      const point = M.crashPoint(rng.floats[0]);
      const startedAt = Date.now() + 300; // short countdown absorbs network latency on the way out
      const r = await c.query(`INSERT INTO game_rounds (user_id, game, bet, status, seed_id, nonce, state, result)
        VALUES ($1,'crash',$2,'open',$3,$4,$5,$6) RETURNING id`,
        [userId, bet, rng.seedId, rng.nonce, { point, startedAt, auto: autoCashout ?? null }, { auto: autoCashout ?? null }]);
      await debit(c, u, 'crash', bet, r.rows[0].id);
      return { roundId: r.rows[0].id, startsIn: 300, k: M.CRASH_K, balance: (await balances(c, userId)).cash };
    }),

    crashCashout: userId => tx(pool, async c => {
      const r = (await c.query(`SELECT * FROM game_rounds WHERE user_id=$1 AND game='crash' AND status='open' FOR UPDATE`, [userId])).rows[0];
      if (!r) fail('NO_ROUND', 'Нет активного раунда', 409);
      return settleCrash(c, r, Date.now(), true);
    }),

    crashStatus: userId => tx(pool, async c => {
      const r = (await c.query(`SELECT * FROM game_rounds WHERE user_id=$1 AND game='crash' AND status='open' FOR UPDATE`, [userId])).rows[0];
      if (!r) return { open: false };
      const now = Date.now(), { point, startedAt } = r.state;
      if (now - startedAt < M.crashTimeMs(point)) return { open: true, roundId: r.id, bet: r.bet, elapsed: Math.max(0, now - startedAt), auto: r.state.auto };
      return settleCrash(c, r, now, false);
    }),

    sweepCrash: () => tx(pool, async c => {
      const rows = (await c.query(`SELECT * FROM game_rounds WHERE game='crash' AND status='open' FOR UPDATE SKIP LOCKED LIMIT 500`)).rows;
      let n = 0;
      for (const r of rows) if (Date.now() - r.state.startedAt >= M.crashTimeMs(r.state.point)) { await settleCrash(c, r, Date.now(), false); n++; }
      return n;
    }),
  };

  async function settleCrash(c, r, now, manual) {
    const { point, startedAt, auto } = r.state;
    const elapsed = Math.max(0, now - startedAt);
    const current = M.crashAt(elapsed), crashed = elapsed >= M.crashTimeMs(point);
    let at = null;
    if (auto && auto < point && current >= auto) at = auto;              // auto cash-out was reached before the crash
    else if (manual && !crashed) {
      if (current < 1.01) fail('TOO_EARLY', 'Раунд ещё не начался', 409);
      at = current;
    }
    const payout = at ? await credit(c, r.user_id, 'crash', r.id, r.bet, M.payoutOf(r.bet, at)) : 0;
    const result = { point, cashedAt: at, auto };
    await c.query(`UPDATE game_rounds SET status='settled', payout=$2, result=$3, settled_at=now() WHERE id=$1`, [r.id, payout, result]);
    return { open: false, roundId: r.id, point, cashedAt: at, payout, balance: (await balances(c, r.user_id)).cash };
  }
}

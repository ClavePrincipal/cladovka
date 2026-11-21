import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, register, deposit } from './helpers.js';
import { demoFeedTick } from '../src/lib/demo-feed.js';

let app, pool;
before(async () => ({ app, pool } = await setup()));
after(async () => { await app.close(); await pool.end(); });

test('demo feed: kick-off goes live, finished matches settle bets and are replaced', async () => {
  const { svc } = app.ctx;
  const ago = m => new Date(Date.now() - m * 60e3).toISOString();
  const soon = await svc.sport.create({ sport: 'football', league: 'Казахстан. Премьер-лига', home: 'A', away: 'B', startsAt: new Date(Date.now() + 3600e3).toISOString(), probs: [0.5, 0.25, 0.25], margin: 0.08 });
  const c = client(app); await register(c); await deposit(c, 1_000_000);
  assert.equal((await c.post('/api/sport/bets', { kind: 'single', stake: 10_000, selections: [{ eventId: soon.id, outcome: 0, odds: soon.odds[0] }] })).status, 200);
  await pool.query('UPDATE sport_events SET starts_at = $2 WHERE id = $1', [soon.id, ago(10)]); // kick-off passed

  await demoFeedTick({ pool, sport: svc.sport });
  let e = (await pool.query('SELECT * FROM sport_events WHERE id=$1', [soon.id])).rows[0];
  assert.equal(e.status, 'live'); assert.equal(Number(e.margin), 0.07);

  await pool.query('UPDATE sport_events SET starts_at = $2 WHERE id = $1', [soon.id, ago(120)]); // full time
  const r = await demoFeedTick({ pool, sport: svc.sport });
  assert.equal(r.settled, 1);
  e = (await pool.query('SELECT * FROM sport_events WHERE id=$1', [soon.id])).rows[0];
  assert.equal(e.status, 'finished');
  assert.notEqual((await c.get('/api/sport/bets')).body[0].status, 'pending', 'the player sees the result');
  const next = (await pool.query(`SELECT * FROM sport_events WHERE home='A' AND status='scheduled'`)).rows;
  assert.equal(next.length, 1, 'a new match replaces the finished one');
  assert.ok(new Date(next[0].starts_at) > new Date());
});

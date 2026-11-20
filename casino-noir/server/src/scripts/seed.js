// Demo sportsbook line. In production events and prices come from an odds feed (see docs/LAUNCH.md).
import { loadConfig } from '../config.js';
import { createPool } from '../lib/db.js';
import { makeSport } from '../lib/sport.js';
import { migrate } from './migrate.js';

const cfg = loadConfig();
const pool = createPool(cfg);
await migrate(pool);
const sport = makeSport({ pool, cfg });
const h = n => new Date(Date.now() + n * 3600e3).toISOString();
const TOP = 0.05, OTHER = 0.08, LIVE = 0.07;
const E = [
  ['football', 'Казахстан. Премьер-лига', 'Кайрат', 'Астана', [0.42, 0.28, 0.30], LIVE, -1, '63′', [1, 1]],
  ['football', 'Казахстан. Премьер-лига', 'Тобол', 'Ордабасы', [0.47, 0.27, 0.26], OTHER, 3],
  ['football', 'Лига чемпионов УЕФА', 'Реал Мадрид', 'Манчестер Сити', [0.38, 0.26, 0.36], TOP, 6],
  ['football', 'Лига чемпионов УЕФА', 'Бавария', 'Интер', [0.48, 0.25, 0.27], TOP, 30],
  ['football', 'Англия. Премьер-лига', 'Арсенал', 'Ливерпуль', [0.40, 0.27, 0.33], LIVE, -0.5, '27′', [0, 1]],
  ['football', 'Испания. Ла Лига', 'Барселона', 'Атлетико', [0.52, 0.25, 0.23], TOP, 50],
  ['hockey', 'КХЛ', 'Барыс', 'Ак Барс', [0.36, 0.22, 0.42], LIVE, -0.7, '2-й пер.', [1, 2]],
  ['hockey', 'КХЛ', 'СКА', 'ЦСКА', [0.44, 0.21, 0.35], OTHER, 4],
  ['hockey', 'НХЛ', 'Эдмонтон', 'Колорадо', [0.47, 0.20, 0.33], TOP, 12],
  ['tennis', 'ATP Финал', 'К. Алькарас', 'Я. Синнер', [0.48, 0, 0.52], LIVE, -0.8, '1-й сет', [1, 0]],
  ['tennis', 'ATP Финал', 'Н. Джокович', 'А. Зверев', [0.58, 0, 0.42], TOP, 5],
  ['basket', 'NBA', 'Бостон', 'Денвер', [0.55, 0, 0.45], TOP, 14],
  ['basket', 'Единая лига ВТБ', 'Астана', 'Зенит', [0.31, 0, 0.69], LIVE, -0.6, '2-я чет.', [38, 45]],
  ['esports', 'CS2. IEM', 'NAVI', 'Vitality', [0.45, 0, 0.55], LIVE, -0.4, 'Карта 1', [7, 5]],
  ['esports', 'CS2. IEM', 'Spirit', 'FaZe', [0.57, 0, 0.43], OTHER, 2],
  ['mma', 'UFC', 'Ш. Рахмонов', 'Б. Эдвардс', [0.62, 0, 0.38], TOP, 60],
];
const existing = (await pool.query('SELECT count(*)::int AS n FROM sport_events WHERE status IN (\'scheduled\',\'live\')')).rows[0].n;
if (existing) { console.log(`${existing} open events already exist, skipping`); }
else for (const [sp, lg, home, away, probs, margin, hours, clock, score] of E) {
  const e = await sport.create({ sport: sp, league: lg, home, away, startsAt: h(hours), probs, margin });
  if (clock) await sport.update(e.id, { status: 'live', clock, score });
}
console.log('seed done');
await pool.end();

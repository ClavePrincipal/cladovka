"use strict";
/* NOIR front end.
   Two interchangeable backends with the same interface:
   - ApiBackend: the real platform (server/), all money and RNG on the server.
   - DemoBackend: runs entirely in the browser with virtual money (used for previews without a server).
   UI amounts are in major units (₸); the API uses minor units (tiyn). */

/* ================= utilities ================= */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const store = {
  get(k, d) { try { const v = localStorage.getItem('noir.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('noir.' + k, JSON.stringify(v)); } catch (e) {} },
};
const CUR = { KZT: '₸', RUB: '₽', USD: '$', UZS: 'сум' };
const S = {
  accept: store.get('accept', 'higher'),
  mode: 'demo', cfg: null, csrf: null, balance: 0, bonusBalance: 0, pendingWd: 0, bonus: null, user: null, limits: {},
  slip: [], slipMode: 'single', slipTab: 'coupon', stake: 1000, sport: 'all', line: 'all', cfilter: 'all', q: '', events: [], prevOdds: {},
};
const cur = () => CUR[(S.user && S.user.currency) || 'KZT'];
const fmt = (n, d = 0) => Number(n).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d }) + ' ' + cur();
const fmtM = n => fmt(n, n % 1 ? 2 : 0);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4500); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Wraps a backend call: shows the server's message, routes to login / wallet when that is the fix. */
async function run(fn) {
  try { return await fn(); }
  catch (e) {
    toast(e.message || 'Не удалось выполнить действие', 'err');
    if (e.code === 'AUTH') openAuth('login');
    if (e.code === 'INSUFFICIENT_FUNDS') openWallet('deposit');
    if (e.code === 'KYC_REQUIRED') openAccount();
    throw e;
  }
}
const quiet = p => p.catch(() => null);

/* ================= shared game constants (mirror of server/src/games/math.js) ================= */
const SL = {
  sym: ['J', 'Q', 'K', 'A', 'S', 'H', 'D', '7', 'W'], w: [30, 28, 25, 22, 14, 12, 8, 5, 4],
  g: { J: 'J', Q: 'Q', K: 'K', A: 'A', S: '♠', H: '♥', D: '♦', 7: '7', W: '★' },
  pay: { J: [10, 30, 80], Q: [12, 32, 100], K: [16, 40, 125], A: [21, 50, 160], S: [30, 100, 300], H: [40, 125, 400], D: [60, 200, 800], 7: [100, 400, 2000], W: [100, 400, 2000] },
  lines: [[1,1,1,1,1],[0,0,0,0,0],[2,2,2,2,2],[0,1,2,1,0],[2,1,0,1,2],[0,0,1,2,2],[2,2,1,0,0],[1,0,0,0,1],[1,2,2,2,1],[1,0,1,2,1]],
};
SL.tot = SL.w.reduce((a, b) => a + b);
const ORDER = [0,32,15,19,4,21,2,25,17,34,6,27,13,36,11,30,8,23,10,5,24,16,33,1,20,14,31,9,22,18,29,7,28,12,35,3,26];
const REDS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
const colorOf = n => n === 0 ? 'green' : REDS.has(n) ? 'red' : 'black';
const M = {
  slotPick(f) { let r = f * SL.tot; for (let i = 0; i < SL.w.length; i++) { r -= SL.w[i]; if (r < 0) return SL.sym[i]; } return SL.sym[0]; },
  slotLine(c) {
    let base = null, n = 0; for (const s of c) { if (s === 'W') { n++; continue; } if (base === null) { base = s; n++; continue; } if (s === base) n++; else break; }
    let wn = 0; for (const s of c) { if (s === 'W') wn++; else break; }
    const p1 = base && n >= 3 ? SL.pay[base][n - 3] : 0, p2 = wn >= 3 ? SL.pay.W[wn - 3] : 0;
    return p1 >= p2 ? { pay: p1, n } : { pay: p2, n: wn };
  },
  slotSpin(f) {
    const grid = [0,1,2,3,4].map(r => [0,1,2].map(i => M.slotPick(f[r * 3 + i]))); let pays = 0; const wins = [];
    SL.lines.forEach((L, li) => { const w = M.slotLine(L.map((row, r) => grid[r][row])); if (w.pay) { pays += w.pay; wins.push({ line: li, count: w.n, pay: w.pay }); } });
    return { grid, wins, multiplier: pays / 10 };
  },
  rReturn(key, n) {
    if (key[0] === 'n') return +key.slice(1) === n ? 36 : 0; if (n === 0) return 0;
    switch (key) { case 'red': return REDS.has(n) ? 2 : 0; case 'black': return !REDS.has(n) ? 2 : 0; case 'even': return n % 2 === 0 ? 2 : 0; case 'odd': return n % 2 ? 2 : 0;
      case 'low': return n <= 18 ? 2 : 0; case 'high': return n >= 19 ? 2 : 0; case 'd1': return n <= 12 ? 3 : 0; case 'd2': return n > 12 && n <= 24 ? 3 : 0; case 'd3': return n > 24 ? 3 : 0;
      case 'c1': return n % 3 === 1 ? 3 : 0; case 'c2': return n % 3 === 2 ? 3 : 0; case 'c3': return n % 3 === 0 ? 3 : 0; } return 0;
  },
  minesMult(m, k) { if (!k) return 1; let p = 1; for (let i = 0; i < k; i++) p *= (25 - m - i) / (25 - i); return Math.floor(0.96 / p * 100) / 100; },
  crashPoint: f => Math.min(1000, Math.max(1, Math.floor(96 / (1 - f)) / 100)),
  CRASH_K: 0.00012,
  crashAt: ms => Math.floor(Math.exp(0.00012 * ms) * 100) / 100,
  crashTime: m => Math.log(m) / 0.00012,
  minesPositions(f, count) { const idx = [...Array(25).keys()]; for (let i = 24; i > 0; i--) { const j = Math.floor(f[24 - i] * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; } return idx.slice(0, count); },
};
const pay = (bet, mult) => Math.floor(bet * Math.floor(mult * 10000 + 1e-7) / 10000 * 100) / 100;
const OUT = ['П1', 'X', 'П2'];

/* ================= API backend ================= */
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method, credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-requested-with': 'noir', ...(S.csrf ? { 'x-csrf-token': S.csrf } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) { const err = new Error('Нет соединения с сервером. Проверьте интернет и повторите.'); err.code = 'NETWORK'; throw err; }
  let data = null; try { data = await res.json(); } catch (e) {}
  if (!res.ok) { const err = new Error(data?.message || 'Ошибка сервера (' + res.status + ')'); err.code = data?.error; err.data = data; throw err; }
  return data;
}
const toM = x => Math.round(x * 100), fromM = x => x / 100;

const ApiBackend = {
  mode: 'api',
  applyProfile(p) {
    if (!p || !p.user) { S.user = null; S.balance = 0; S.bonusBalance = 0; S.pendingWd = 0; S.bonus = null; S.limits = {}; return; }
    if (p.csrf) S.csrf = p.csrf;
    S.user = p.user; S.balance = fromM(p.balance); S.bonusBalance = fromM(p.bonusBalance); S.pendingWd = fromM(p.pendingWithdrawals);
    S.bonus = p.bonus; S.limits = p.limits;
  },
  async init() { this.applyProfile(await api('GET', '/api/me')); },
  async refresh() { this.applyProfile(await api('GET', '/api/me')); renderAcct(); },
  methods: () => S.cfg.methods.map(m => ({ ...m, min: fromM(m.min), max: fromM(m.max) })),
  async register(f) { const r = await api('POST', '/api/auth/register', f); this.applyProfile(r); return r.credentials; },
  async login(login, password, totp, captcha) { this.applyProfile(await api('POST', '/api/auth/login', { login, password, totp: totp || undefined, captcha: captcha || undefined })); },
  async logout() { await api('POST', '/api/auth/logout', {}); S.csrf = null; this.applyProfile(null); },
  async slot(bet) { const r = await api('POST', '/api/games/slot', { bet: toM(bet) }); S.balance = fromM(r.balance); return { ...r.result, payout: fromM(r.payout), nonce: r.nonce }; },
  async roulette(bets) {
    const b = {}; for (const [k, v] of Object.entries(bets)) b[k] = toM(v);
    const r = await api('POST', '/api/games/roulette', { bets: b }); S.balance = fromM(r.balance); return { number: r.result.number, payout: fromM(r.payout) };
  },
  async dice(bet, chance) { const r = await api('POST', '/api/games/dice', { bet: toM(bet), chance }); S.balance = fromM(r.balance); return { ...r.result, payout: fromM(r.payout) }; },
  async minesState() { const r = (await api('GET', '/api/games/mines')).round; return r && { bet: fromM(r.bet), mines: r.mines, picks: r.picks }; },
  async minesStart(bet, mines) { const r = await api('POST', '/api/games/mines/start', { bet: toM(bet), mines }); S.balance = fromM(r.balance); return r; },
  async minesReveal(tile) { const r = await api('POST', '/api/games/mines/reveal', { tile }); if (r.balance != null) S.balance = fromM(r.balance); return { ...r, payout: fromM(r.payout || 0) }; },
  async minesCashout() { const r = await api('POST', '/api/games/mines/cashout', {}); S.balance = fromM(r.balance); return { ...r, payout: fromM(r.payout) }; },
  async crashStart(bet, auto) { const r = await api('POST', '/api/games/crash/start', { bet: toM(bet), auto }); S.balance = fromM(r.balance); return r; },
  async crashCashout() { const r = await api('POST', '/api/games/crash/cashout', {}); if (r.balance != null) S.balance = fromM(r.balance); return { ...r, payout: fromM(r.payout || 0) }; },
  async crashStatus() { const r = await api('GET', '/api/games/crash'); if (r.balance != null) S.balance = fromM(r.balance); return { ...r, payout: fromM(r.payout || 0), bet: r.bet != null ? fromM(r.bet) : undefined }; },
  async events() { return (await api('GET', '/api/sport/events')).map(e => ({ ...e, live: e.status === 'live' })); },
  async placeBet({ kind, stake, selections, acceptChanges }) {
    const r = await api('POST', '/api/sport/bets', { kind, stake: toM(stake), acceptChanges, selections: selections.map(s => ({ eventId: s.ev, outcome: s.out, odds: s.odds })) });
    S.balance = fromM(r.balance); return r;
  },
  async myBets() { return (await api('GET', '/api/sport/bets')).map(b => ({ ...b, stake: fromM(b.stake), payout: fromM(b.payout), at: b.createdAt, sels: b.selections.map(s => ({ ...s, pick: OUT[s.outcome] })) })); },
  async deposit({ method, provider, amount, withBonus }) {
    const r = await api('POST', '/api/wallet/deposit', { provider, method, amount: toM(amount), withBonus, idempotencyKey: crypto.randomUUID?.() });
    location.href = r.redirectUrl; // hosted checkout of the payment provider
    return { redirected: true };
  },
  async withdraw({ method, provider, instrument, amount, forfeitBonus }) {
    const r = await api('POST', '/api/wallet/withdraw', { provider, method, instrument, amount: toM(amount), forfeitBonus: forfeitBonus || undefined });
    S.balance = fromM(r.balance); return r;
  },
  instruments: () => api('GET', '/api/wallet/instruments'),
  twofaSetup: () => api('POST', '/api/me/2fa/setup', {}),
  async twofaEnable(code) { this.applyProfile(await api('POST', '/api/me/2fa/enable', { code })); },
  async twofaDisable(password, code) { this.applyProfile(await api('POST', '/api/me/2fa/disable', { password, code })); },
  sessions: () => api('GET', '/api/me/sessions'),
  revokeOthers: () => api('POST', '/api/me/sessions/revoke-others', {}),
  async changePassword(current, next) { this.applyProfile(await api('POST', '/api/me/password', { current, next })); },
  async cancelWithdrawal(id) { const r = await api('POST', `/api/wallet/withdraw/${id}/cancel`, {}); S.balance = fromM(r.balance); },
  async history() {
    const r = await api('GET', '/api/wallet/history');
    const NAMES = { deposit: 'Пополнение', withdrawal_hold: 'Вывод (заявка)', withdrawal_release: 'Вывод отменён', withdrawal_paid: 'Вывод выплачен', bet: 'Ставка', win: 'Выигрыш',
      refund: 'Возврат ставки', bonus_grant: 'Бонус начислен', bonus_release: 'Бонус отыгран', bonus_expire: 'Бонус сгорел', cashback: 'Кэшбэк', adjustment: 'Корректировка' };
    const ST = { created: 'Создан', pending: 'Ожидает оплаты', succeeded: 'Зачислен', failed: 'Отклонён', review: 'На проверке', approved: 'Отправлен в банк', rejected: 'Отменён', paid: 'Выплачен' };
    return {
      ledger: r.ledger.filter(l => l.account_kind !== 'withdraw_hold').map(l => ({ n: (NAMES[l.type] || l.type) + (l.meta?.game ? ' · ' + gameName(l.meta.game) : l.meta?.product === 'sport' ? ' · спорт' : '') + (l.account_kind === 'bonus' ? ' (бонусный счёт)' : ''),
        a: fromM(l.amount), at: l.created_at })),
      payments: r.payments.map(p => ({ id: p.id, n: (p.direction === 'deposit' ? 'Пополнение · ' : 'Вывод · ') + (S.cfg.methods.find(m => m.id === p.method)?.name || p.method), a: fromM(p.direction === 'deposit' ? p.amount : -p.amount), at: p.created_at, st: ST[p.status] || p.status, canCancel: p.direction === 'withdrawal' && p.status === 'review' })),
    };
  },
  async setLimits(l) { const r = await api('POST', '/api/me/limits', l); this.applyProfile(r); return r; },
  async fair() { return api('GET', '/api/fair'); },
  async rotate(clientSeed) { return api('POST', '/api/fair/rotate', clientSeed ? { clientSeed } : {}); },
  async kycStart() { return api('POST', '/api/kyc/start', {}); },
};

/* ================= Demo backend (browser only, virtual money) ================= */
const hex = b => [...b].map(x => x.toString(16).padStart(2, '0')).join('');
const randHex = n => { const a = new Uint8Array(n); crypto.getRandomValues(a); return hex(a); };
async function hmacFloats(key, msg, n) {
  const out = [];
  for (let round = 0; out.length < n; round++) {
    let h;
    if (crypto.subtle) {
      const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      h = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(`${msg}:${round}`)));
    } else { h = new Uint8Array(32); crypto.getRandomValues(h); }
    for (let i = 0; i + 4 <= h.length && out.length < n; i += 4) out.push((h[i] * 16777216 + (h[i + 1] << 16) + (h[i + 2] << 8) + h[i + 3]) / 4294967296);
  }
  return out;
}
async function sha256hex(s) { return crypto.subtle ? hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))) : ''; }

const D = {
  balance: store.get('balance', 50000), bonus: store.get('bonus', 0), user: store.get('user', null), bets: store.get('bets', []), tx: store.get('tx', []),
  limits: store.get('limits', {}), seed: null, revealed: [], mines: null, crash: null,
  save() { ['balance', 'bonus', 'user', 'bets', 'tx', 'limits'].forEach(k => store.set(k, this[k])); },
};
function demoErr(code, message) { const e = new Error(message); e.code = code; throw e; }
function demoCanPay(x) {
  if (D.limits.selfExcludedUntil && Date.now() < D.limits.selfExcludedUntil) demoErr('SELF_EXCLUDED', 'Самоисключение активно до ' + new Date(D.limits.selfExcludedUntil).toLocaleString('ru-RU'));
  if (!(x > 0)) demoErr('VALIDATION', 'Введите сумму ставки больше нуля');
  if (x > D.balance + 1e-9) demoErr('INSUFFICIENT_FUNDS', 'Недостаточно средств: на счёте ' + fmt(D.balance) + '. Пополните баланс.');
}
const demoAdd = d => { D.balance = Math.round((D.balance + d) * 100) / 100; D.save(); S.balance = D.balance; };
async function demoFloats(n) { const s = D.seed; s.nonce++; return { nonce: s.nonce, floats: await hmacFloats(s.server, `${s.client}:${s.nonce}`, n) }; }
async function newDemoSeed(client) { const server = randHex(32); D.seed = { server, hash: await sha256hex(server), client: client || randHex(8), nonce: 0 }; }

const DEMO_METHODS = [
  ['card', 'Банковские карты', 'Visa / Mastercard', 2000, 1500000, 'Мгновенно'], ['kaspi', 'Банковские карты', 'Kaspi.kz', 1000, 2000000, 'Мгновенно'],
  ['halyk', 'Банковские карты', 'Halyk Bank', 1000, 1500000, 'Мгновенно'], ['apple', 'Кошельки', 'Apple Pay', 2000, 1000000, 'Мгновенно'],
  ['gpay', 'Кошельки', 'Google Pay', 2000, 1000000, 'Мгновенно'], ['usdt', 'Криптовалюта', 'USDT TRC-20', 5000, 50000000, '1 подтверждение'],
  ['btc', 'Криптовалюта', 'Bitcoin', 10000, 50000000, '2 подтверждения'],
].map(([id, group, name, min, max, eta]) => ({ id, group, name, min, max, eta, provider: 'demo' }));

let DEMO_EVENTS = null;
function demoEvents() {
  if (DEMO_EVENTS) return DEMO_EVENTS;
  const h = n => new Date(Date.now() + n * 3600e3).toISOString();
  const T = 0.05, O = 0.08, L = 0.07; let id = 0;
  const ev = (sport, league, home, away, p, margin, hours, clock, score) => ({ id: ++id, sport, league, home, away, p, margin, startsAt: h(hours), status: clock ? 'live' : 'scheduled', live: !!clock, clock: clock || null, score: score || [0, 0] });
  DEMO_EVENTS = [
    ev('football', 'Казахстан. Премьер-лига', 'Кайрат', 'Астана', [.42, .28, .30], L, -1, '63′', [1, 1]),
    ev('football', 'Казахстан. Премьер-лига', 'Тобол', 'Ордабасы', [.47, .27, .26], O, 3),
    ev('football', 'Лига чемпионов УЕФА', 'Реал Мадрид', 'Манчестер Сити', [.38, .26, .36], T, 6),
    ev('football', 'Лига чемпионов УЕФА', 'Бавария', 'Интер', [.48, .25, .27], T, 30),
    ev('football', 'Англия. Премьер-лига', 'Арсенал', 'Ливерпуль', [.40, .27, .33], L, -.5, '27′', [0, 1]),
    ev('football', 'Испания. Ла Лига', 'Барселона', 'Атлетико', [.52, .25, .23], T, 50),
    ev('hockey', 'КХЛ', 'Барыс', 'Ак Барс', [.36, .22, .42], L, -.7, '2-й пер.', [1, 2]),
    ev('hockey', 'КХЛ', 'СКА', 'ЦСКА', [.44, .21, .35], O, 4),
    ev('hockey', 'НХЛ', 'Эдмонтон', 'Колорадо', [.47, .20, .33], T, 12),
    ev('tennis', 'ATP Финал', 'К. Алькарас', 'Я. Синнер', [.48, 0, .52], L, -.8, '1-й сет', [1, 0]),
    ev('tennis', 'ATP Финал', 'Н. Джокович', 'А. Зверев', [.58, 0, .42], T, 5),
    ev('basket', 'NBA', 'Бостон', 'Денвер', [.55, 0, .45], T, 14),
    ev('basket', 'Единая лига ВТБ', 'Астана', 'Зенит', [.31, 0, .69], L, -.6, '2-я чет.', [38, 45]),
    ev('esports', 'CS2. IEM', 'NAVI', 'Vitality', [.45, 0, .55], L, -.4, 'Карта 1', [7, 5]),
    ev('esports', 'CS2. IEM', 'Spirit', 'FaZe', [.57, 0, .43], O, 2),
    ev('mma', 'UFC', 'Ш. Рахмонов', 'Б. Эдвардс', [.62, 0, .38], T, 60),
  ];
  return DEMO_EVENTS;
}
const demoOdds = e => e.p.map(p => p > 0 ? Math.max(1.01, Math.floor(100 / (p * (1 + e.margin))) / 100) : 0);
function demoDrift() {
  for (const e of demoEvents()) {
    if (!e.live) continue;
    const k = e.p[1] > 0 ? 3 : 2, d = (Math.random() - .5) * .04;
    e.p[0] = Math.min(.9, Math.max(.05, e.p[0] + d)); const rest = 1 - e.p[0];
    if (k === 3) { const s = e.p[1] + e.p[2]; e.p[1] = rest * e.p[1] / s; e.p[2] = rest * e.p[2] / s; } else e.p[2] = rest;
  }
}

const DemoBackend = {
  mode: 'demo',
  async init() { await newDemoSeed(); S.balance = D.balance; S.bonusBalance = D.bonus; S.user = D.user; S.limits = D.limits; },
  async refresh() { S.balance = D.balance; S.bonusBalance = D.bonus; renderAcct(); },
  methods: () => DEMO_METHODS,
  async register(f) {
    const id = String(Math.floor(1e8 + Math.random() * 9e8)), password = randHex(5);
    D.user = { id, name: f.email || f.phone || 'ID ' + id, currency: f.currency, kycStatus: 'none' }; D.save(); S.user = D.user;
    return f.method === 'oneclick' ? { id, password } : null;
  },
  async login() { demoErr('DEMO', 'В демо-режиме вход не нужен: зарегистрируйтесь в один клик.'); },
  async logout() { D.user = null; D.save(); S.user = null; },
  async slot(bet) {
    demoCanPay(bet); demoAdd(-bet); const { nonce, floats } = await demoFloats(15); const r = M.slotSpin(floats);
    const p = pay(bet, r.multiplier); if (p) demoAdd(p); return { ...r, payout: p, nonce };
  },
  async roulette(bets) {
    const total = Object.values(bets).reduce((a, b) => a + b, 0); demoCanPay(total); demoAdd(-total);
    const { floats } = await demoFloats(1); const n = Math.floor(floats[0] * 37);
    let p = 0; for (const [k, v] of Object.entries(bets)) p += v * M.rReturn(k, n); if (p) demoAdd(p); return { number: n, payout: p };
  },
  async dice(bet, chance) {
    demoCanPay(bet); demoAdd(-bet); const { floats } = await demoFloats(1); const roll = Math.floor(floats[0] * 10000) / 100, won = roll < chance;
    const p = won ? pay(bet, 98 / chance) : 0; if (p) demoAdd(p); return { roll, chance, won, payout: p };
  },
  async minesState() { return D.mines && { bet: D.mines.bet, mines: D.mines.count, picks: D.mines.picks }; },
  async minesStart(bet, mines) {
    if (D.mines) demoErr('ROUND_OPEN', 'У вас уже есть незавершённая игра'); demoCanPay(bet); demoAdd(-bet);
    const { floats } = await demoFloats(24); D.mines = { bet, count: mines, mines: M.minesPositions(floats, mines), picks: [] }; return { mines };
  },
  async minesReveal(tile) {
    const g = D.mines; if (!g) demoErr('NO_ROUND', 'Нет активной игры');
    if (g.mines.includes(tile)) { D.mines = null; return { lost: true, mines: g.mines, picks: [...g.picks, tile] }; }
    g.picks.push(tile); const mult = M.minesMult(g.count, g.picks.length);
    if (g.picks.length === 25 - g.count) { D.mines = null; const p = pay(g.bet, mult); demoAdd(p); return { finished: true, payout: p, mines: g.mines, multiplier: mult, picks: g.picks }; }
    return { picks: g.picks, multiplier: mult, next: M.minesMult(g.count, g.picks.length + 1) };
  },
  async minesCashout() {
    const g = D.mines; if (!g || !g.picks.length) demoErr('VALIDATION', 'Откройте хотя бы одну клетку');
    D.mines = null; const mult = M.minesMult(g.count, g.picks.length), p = pay(g.bet, mult); demoAdd(p); return { payout: p, mines: g.mines, multiplier: mult };
  },
  async crashStart(bet, auto) {
    if (D.crash) demoErr('ROUND_OPEN', 'Раунд уже идёт'); demoCanPay(bet); demoAdd(-bet);
    const { floats } = await demoFloats(1); D.crash = { bet, auto, point: M.crashPoint(floats[0]), startedAt: Date.now() + 300 }; return { startsIn: 300, k: M.CRASH_K };
  },
  async crashSettle(manual) {
    const c = D.crash; if (!c) return { open: false };
    const el = Math.max(0, Date.now() - c.startedAt), current = M.crashAt(el), crashed = el >= M.crashTime(c.point);
    let at = null;
    if (c.auto && c.auto < c.point && current >= c.auto) at = c.auto;
    else if (manual && !crashed) { if (current < 1.01) demoErr('TOO_EARLY', 'Раунд ещё не начался'); at = current; }
    else if (!crashed) return { open: true, elapsed: el, bet: c.bet, auto: c.auto };
    D.crash = null; const p = at ? pay(c.bet, at) : 0; if (p) demoAdd(p);
    return { open: false, point: c.point, cashedAt: at, payout: p };
  },
  crashCashout() { return this.crashSettle(true); },
  crashStatus() { return this.crashSettle(false); },
  async events() { return demoEvents().map(e => ({ ...e, odds: demoOdds(e) })); },
  async placeBet({ kind, stake, selections }) {
    const groups = kind === 'express' ? [selections] : selections.map(s => [s]);
    const total = stake * groups.length; demoCanPay(total);
    for (const s of selections) { const e = demoEvents().find(x => x.id === s.ev); const now = demoOdds(e)[s.out]; if (now < s.odds) { const err = new Error('Коэффициенты изменились. Проверьте купон.'); err.code = 'ODDS_CHANGED'; err.data = { changed: [{ eventId: s.ev, outcome: s.out, odds: now }] }; throw err; } }
    demoAdd(-total);
    for (const g of groups) {
      const odds = g.reduce((a, s) => a * s.odds, 1), boost = kind === 'express' && g.length >= 4 ? 1.1 : 1;
      D.bets.push({ id: Date.now() + Math.random(), kind: g.length > 1 ? 'express' : 'single', stake, odds: Math.round(odds * 100) / 100, boost, status: 'pending', payout: 0, at: Date.now(), settleAt: Date.now() + 8000 + Math.random() * 12000,
        sels: g.map(s => ({ eventId: s.ev, outcome: s.out, pick: OUT[s.out], label: s.label, odds: s.odds, result: null })) });
    }
    D.tx.push({ n: 'Ставка на спорт', a: -total, at: Date.now() }); D.save(); return {};
  },
  async myBets() { return D.bets.slice().reverse(); },
  settleDemoBets() {
    let changed = false;
    for (const b of D.bets) {
      if (b.status !== 'pending' || Date.now() < b.settleAt) continue;
      for (const s of b.sels) { const e = demoEvents().find(x => x.id === s.eventId); const p = e ? e.p : [1 / 3, 1 / 3, 1 / 3]; const r = Math.random(); const res = r < p[0] ? 0 : r < p[0] + p[1] ? 1 : 2; s.result = res === s.outcome ? 'won' : 'lost'; }
      const won = b.sels.every(s => s.result === 'won'); b.status = won ? 'won' : 'lost'; b.payout = won ? Math.floor(b.stake * b.odds * b.boost) : 0;
      if (won) { demoAdd(b.payout); D.tx.push({ n: 'Выигрыш ставки', a: b.payout, at: Date.now() }); toast(`Ставка выиграла: +${fmt(b.payout)}`, 'ok'); }
      else toast('Ставка проиграла: ' + b.sels.map(s => s.label).join(', '));
      changed = true;
    }
    if (changed) { D.save(); renderAcct(); if (S.slipTab === 'mine') renderSlip(); }
  },
  async deposit({ method, amount, withBonus }) {
    const m = DEMO_METHODS.find(x => x.id === method);
    if (D.limits.depositDaily) { const d = new Date().toDateString(); const today = D.tx.filter(t => t.t === 'dep' && new Date(t.at).toDateString() === d).reduce((a, t) => a + t.a, 0); if (today + amount > D.limits.depositDaily) demoErr('DEPOSIT_LIMIT', 'Превышен ваш дневной лимит депозита'); }
    await sleep(1200); const first = !D.tx.some(t => t.t === 'dep');
    demoAdd(amount); D.tx.push({ t: 'dep', n: 'Пополнение · ' + m.name, a: amount, at: Date.now(), method, instrument: method + ':••4242' });
    if (withBonus && first) { const bn = Math.min(amount, 300000); D.bonus += bn; S.bonusBalance = D.bonus; D.tx.push({ n: 'Бонус 100% (вейджер ×30)', a: bn, at: Date.now(), st: 'Бонусный счёт' }); toast(`Начислен бонус ${fmt(bn)} на бонусный счёт`, 'ok'); }
    D.save(); toast(`Счёт пополнен на ${fmt(amount)}`, 'ok'); return {};
  },
  async instruments() {
    const seen = new Map(); D.tx.filter(t => t.t === 'dep' && t.instrument).forEach(t => seen.set(t.instrument, { provider: 'demo', method: t.method, instrument: t.instrument }));
    return [...seen.values()];
  },
  async twofaSetup() { demoErr('DEMO', 'Двухфакторная защита доступна в полной версии с сервером'); },
  async sessions() { return [{ id: 1, ip: '—', user_agent: navigator.userAgent, created_at: new Date(), last_seen: new Date(), current: true }]; },
  async revokeOthers() { return { revoked: 0 }; },
  async changePassword() { demoErr('DEMO', 'Смена пароля доступна в полной версии с сервером'); },
  async withdraw({ method, amount, instrument }) {
    if (!D.user) demoErr('AUTH', 'Для вывода зарегистрируйтесь');
    if (!(await this.instruments()).some(i => i.instrument === instrument)) demoErr('INSTRUMENT', 'Вывод возможен только на карту, с которой вы пополняли счёт');
    if (amount > D.balance) demoErr('INSUFFICIENT_FUNDS', 'Сумма больше доступного баланса');
    await sleep(800); const m = DEMO_METHODS.find(x => x.id === method); demoAdd(-amount);
    const t = { n: 'Вывод · ' + m.name, a: -amount, at: Date.now(), st: 'На проверке' }; D.tx.push(t); D.save();
    setTimeout(() => { t.st = 'Выплачен'; D.save(); toast(`Вывод ${fmt(amount)} выплачен`, 'ok'); }, 4000);
    return { status: 'review' };
  },
  async history() { return { ledger: [], payments: D.tx.slice().reverse().slice(0, 50).map(t => ({ ...t, st: t.st || 'Проведено' })) }; },
  async setLimits(l) {
    if ('depositDaily' in l) D.limits.depositDaily = l.depositDaily || null;
    if ('lossDaily' in l) D.limits.lossDaily = l.lossDaily || null;
    if ('realityCheckMin' in l) D.limits.realityCheckMin = l.realityCheckMin || null;
    if (l.selfExcludeDays) D.limits.selfExcludedUntil = Date.now() + l.selfExcludeDays * 864e5;
    D.save(); S.limits = D.limits; return { applied: Object.keys(l), pending: [] };
  },
  async fair() { return { current: { serverHash: D.seed.hash, clientSeed: D.seed.client, nonce: D.seed.nonce }, revealed: D.revealed }; },
  async rotate(clientSeed) {
    if (D.mines || D.crash) demoErr('ROUND_OPEN', 'Завершите открытую игру перед сменой сида');
    const old = D.seed; D.revealed.unshift({ server_seed: old.server, server_hash: old.hash, client_seed: old.client, nonce: old.nonce }); await newDemoSeed(clientSeed);
    return { revealed: { serverSeed: old.server } };
  },
  async kycStart() { if (D.user) { D.user.kycStatus = 'pending'; D.save(); } return { message: 'В демо-режиме верификация не проводится.' }; },
};

let B = DemoBackend;

/* ================= sportsbook UI ================= */
const SPORTS = [['all', 'Все виды'], ['football', 'Футбол'], ['hockey', 'Хоккей'], ['tennis', 'Теннис'], ['basket', 'Баскетбол'], ['esports', 'Киберспорт'], ['mma', 'MMA']];
async function loadEvents() {
  const list = await quiet(B.events()); if (!list) return;
  for (const e of list) {
    const prev = S.prevOdds[e.id]; e.trend = e.odds.map((o, i) => prev && prev[i] && o !== prev[i] ? Math.sign(o - prev[i]) : 0); S.prevOdds[e.id] = e.odds;
  }
  S.events = list;
  for (const s of S.slip) { const e = list.find(x => x.id === s.ev); if (e) s.odds = e.odds[s.out]; }
}
function evRow(e) {
  const inSlip = S.slip.find(x => x.ev === e.id);
  const btns = [0, 1, 2].map(i => {
    const o = e.odds[i]; if (!(o > 1) || e.status === 'suspended') return `<button class="odd na" type="button" tabindex="-1">${'—'}</button>`;
    const cls = ['odd', inSlip && inSlip.out === i ? 'sel' : '', e.trend?.[i] > 0 ? 'up' : e.trend?.[i] < 0 ? 'down' : ''].join(' ');
    return `<button class="${cls}" type="button" data-ev="${e.id}" data-out="${i}" aria-label="${OUT[i]} ${o.toFixed(2)}">${o.toFixed(2)}</button>`;
  }).join('');
  const d = new Date(e.startsAt);
  const when = d.toDateString() === new Date().toDateString() ? 'Сегодня ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const time = e.live ? `<span class="lv"><span class="live-dot"></span>${esc(e.clock || 'Live')}</span>` : esc(when);
  const sc = i => e.live ? `<span class="sc">${e.score[i]}</span>` : '';
  return `<div class="ev"><div class="ev-main"><div class="ev-time">${time}</div><div class="teams"><div><span>${esc(e.home)}</span>${sc(0)}</div><div><span>${esc(e.away)}</span>${sc(1)}</div></div></div>${btns}</div>`;
}
function leagueBlocks(list) {
  const by = {}; list.forEach(e => (by[e.league] = by[e.league] || []).push(e));
  return Object.entries(by).map(([l, es]) => `<div class="league"><div class="league-h"><span>${esc(l)}</span><span>1</span><span>X</span><span>2</span></div>${es.map(evRow).join('')}</div>`).join('');
}
const lineOk = e => S.line === 'all' || (S.line === 'live') === !!e.live;
function renderSport() {
  $('#sports-side').innerHTML = SPORTS.map(([k, n]) => `<button type="button" class="${S.sport === k ? 'on' : ''}" data-sport="${k}">${n}<small>${S.events.filter(e => (k === 'all' || e.sport === k) && lineOk(e)).length}</small></button>`).join('');
  $$('#line-tabs .pill').forEach(b => b.classList.toggle('on', b.dataset.line === S.line));
  const list = S.events.filter(e => (S.sport === 'all' || e.sport === S.sport) && lineOk(e));
  $('#events').innerHTML = list.length ? `<div style="display:flex;flex-direction:column;gap:14px">${leagueBlocks(list)}</div>` : `<div class="league"><div class="empty"><b>Нет событий</b>Выберите другой вид спорта или режим линии.</div></div>`;
  renderHomeLive();
}
function renderHomeLive() {
  const live = S.events.filter(e => e.live).slice(0, 5);
  $('#home-live').innerHTML = live.length ? `<div style="display:flex;flex-direction:column;gap:14px">${leagueBlocks(live)}</div>` : `<div class="league"><div class="empty"><b>Сейчас нет live-матчей</b>Загляните в линию: там все ближайшие события.</div></div>`;
}
function toggleSel(id, out) {
  const e = S.events.find(x => x.id === id); if (!e) return;
  const idx = S.slip.findIndex(x => x.ev === id);
  if (idx >= 0 && S.slip[idx].out === out) S.slip.splice(idx, 1);
  else { const s = { ev: id, out, odds: e.odds[out], label: `${e.home} — ${e.away}`, pick: OUT[out], live: !!e.live }; if (idx >= 0) S.slip[idx] = s; else S.slip.push(s); }
  if (S.slip.length === 2 && idx < 0) S.slipMode = 'express';
  if (S.slip.length < 2) S.slipMode = 'single';
  S.slipTab = 'coupon'; renderSport(); renderSlip();
}
function slipCalc() {
  const n = S.slip.length;
  if (S.slipMode === 'express' && n >= 2) { const raw = S.slip.reduce((a, s) => a * s.odds, 1), boost = n >= 4 ? 1.1 : 1; return { total: S.stake, odds: raw * boost, boost, win: S.stake * raw * boost }; }
  return { total: S.stake * n, odds: null, boost: 1, win: S.slip.reduce((a, s) => a + S.stake * s.odds, 0) };
}
async function renderSlip() {
  const n = S.slip.length; $('#slip-n').textContent = n ? `(${n})` : ''; $('#fab-n').textContent = n;
  $$('.slip-tabs button').forEach(b => b.classList.toggle('on', b.dataset.slip === S.slipTab));
  const body = $('#slip-body');
  if (S.slipTab === 'mine') {
    if (!S.user && B.mode === 'api') { body.innerHTML = `<div class="empty"><b>Войдите</b>Чтобы видеть свои ставки, войдите в аккаунт.</div>`; return; }
    const bets = (await quiet(B.myBets())) || [];
    const ST = { pending: 'В игре', won: 'Выигрыш', lost: 'Проигрыш', void: 'Возврат' };
    body.innerHTML = bets.length ? bets.map(b => `<div class="mybet"><div class="kv"><span class="st ${b.status === 'void' ? 'pending' : b.status}">${ST[b.status]}</span><span>${b.kind === 'express' ? 'Экспресс' : 'Одинар'} · ${new Date(b.at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span></div>${b.sels.map(s => `<div>${esc(s.label)} · <b>${s.pick}</b> <span class="num" style="color:var(--gold-hi)">${(+s.odds).toFixed(2)}</span>${s.result ? ` · ${{ won: 'зашёл', lost: 'не зашёл', void: 'возврат' }[s.result]}` : ''}</div>`).join('')}<div class="kv"><span>Ставка ${fmt(b.stake)} · кф ${(+b.odds).toFixed(2)}</span><b>${b.status === 'won' || b.status === 'void' ? '+' + fmt(b.payout) : b.status === 'lost' ? '0' : fmt(b.stake * b.odds * (b.boost || 1))}</b></div></div>`).join('') : `<div class="empty"><b>Ставок пока нет</b>Здесь появятся ваши ставки на спорт и их результаты.</div>`;
    return;
  }
  if (!n) { body.innerHTML = `<div class="empty"><b>Купон пуст</b>Нажмите на коэффициент в линии, чтобы добавить событие.</div>`; return; }
  const c = slipCalc();
  body.innerHTML = `
    <div class="seg"><button type="button" data-mode="single" class="${S.slipMode === 'single' ? 'on' : ''}">Одинар</button><button type="button" data-mode="express" class="${S.slipMode === 'express' ? 'on' : ''}" ${n < 2 ? 'disabled' : ''}>Экспресс</button></div>
    ${S.slip.map(s => `<div class="sl-item"><span><b>${s.pick}</b> ${s.live ? '<span style="color:var(--live);font-weight:800">LIVE</span>' : ''}</span><button class="x" type="button" data-rm="${s.ev}" aria-label="Убрать">×</button><span class="muted">${esc(s.label)}</span><span class="o">${s.odds.toFixed(2)}</span></div>`).join('')}
    <div class="field"><label for="stake">${S.slipMode === 'express' ? 'Сумма ставки' : 'Сумма на каждое событие'}</label><input class="inp" id="stake" type="number" min="1" step="100" value="${S.stake}" inputmode="decimal"></div>
    <div class="quick">${[500, 1000, 5000, 10000].map(v => `<button type="button" data-stake="${v}">${v.toLocaleString('ru-RU')}</button>`).join('')}</div>
    ${c.boost > 1 ? `<div class="note"><b>Экспресс дня:</b> коэффициент увеличен на 10%.</div>` : S.slipMode === 'express' && n < 4 ? `<div class="note">Добавьте ещё ${4 - n} ${4 - n === 1 ? 'событие' : 'события'}, чтобы получить +10% к коэффициенту.</div>` : ''}
    ${c.odds ? `<div class="kv"><span>Общий коэффициент</span><b>${c.odds.toFixed(2)}</b></div>` : ''}
    <div class="kv"><span>Сумма ставки</span><b>${fmt(c.total)}</b></div>
    <div class="kv big"><span>Возможный выигрыш</span><b>${fmt(c.win)}</b></div>
    <div class="field"><label for="accept">Если коэффициент изменится</label><select class="inp" id="accept" style="font-family:var(--font-ui)">
      ${[['higher', 'Принимать только повышение'], ['none', 'Спрашивать при любом изменении'], ['any', 'Принимать любые изменения']].map(([k, t]) => `<option value="${k}" ${S.accept === k ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
    <button class="btn gold big block" type="button" id="place">Сделать ставку</button>
    <button class="btn ghost block" type="button" id="clear-slip">Очистить купон</button>`;
}
async function placeBet() {
  if (B.mode === 'api' && !S.user) { openAuth('register'); return; }
  const c = slipCalc(), btn = $('#place'); btn.disabled = true;
  if (S.slip.some(s => s.live)) btn.textContent = 'Принимаем live-ставку…';
  try {
    await B.placeBet({ kind: S.slipMode === 'express' && S.slip.length >= 2 ? 'express' : 'single', stake: S.stake, selections: S.slip, acceptChanges: S.accept });
    toast(`Ставка принята: ${fmt(c.total)}`, 'ok');
    S.slip = []; S.slipMode = 'single'; S.slipTab = 'mine'; renderAcct(); renderSport(); renderSlip();
  } catch (e) {
    if (e.code === 'ODDS_CHANGED') {
      for (const ch of e.data.changed) { const s = S.slip.find(x => x.ev === ch.eventId); if (s) s.odds = ch.odds; }
      toast('Коэффициенты изменились. Проверьте купон и подтвердите ставку ещё раз.', 'err'); renderSlip();
    } else { toast(e.message, 'err'); if (e.code === 'INSUFFICIENT_FUNDS') openWallet('deposit'); if (e.code === 'AUTH') openAuth('login'); }
    if ($('#place')) { $('#place').disabled = false; $('#place').textContent = 'Сделать ставку'; }
  }
}

/* ================= casino catalog ================= */
const GAMES = [
  { id: 'obsidian7', n: 'Obsidian Seven', e: 'slot', c: 'slots', pr: 'NOIR Studio', rtp: 95, gl: '7', art: 'linear-gradient(140deg,#2b2112,#060606 70%)', tint: '#2b2112', tag: 'Хит' },
  { id: 'roulette', n: 'Европейская рулетка', e: 'roulette', c: 'table', pr: 'NOIR Studio', rtp: 97.3, gl: '0', art: 'radial-gradient(circle at 70% 30%,#123d2f,#050606 70%)', glc: '#e6dcc6' },
  { id: 'comet', n: 'Комета', e: 'crash', c: 'fast', pr: 'NOIR Originals', rtp: 96, gl: '↗', art: 'radial-gradient(circle at 20% 90%,#3a1d10,#050505 70%)', tag: 'Crash' },
  { id: 'dice', n: 'Dice', e: 'dice', c: 'fast', pr: 'NOIR Originals', rtp: 98, gl: '⚀', art: 'linear-gradient(160deg,#101826,#050505 70%)', glc: '#cfd8ea' },
  { id: 'mines', n: 'Мины', e: 'mines', c: 'fast', pr: 'NOIR Originals', rtp: 96, gl: '◆', art: 'linear-gradient(160deg,#20160f,#050505 70%)', tag: 'new' },
  { id: 'nightexpress', n: 'Ночной экспресс', e: 'slot', c: 'slots', pr: 'NOIR Studio', rtp: 95, gl: '♦', art: 'linear-gradient(140deg,#0f1a2c,#050506 70%)', tint: '#0f1a2c', glc: '#9fc1ff' },
  { id: 'crimson', n: 'Crimson Hearts', e: 'slot', c: 'slots', pr: 'Velvet Games', rtp: 95, gl: '♥', art: 'linear-gradient(140deg,#2c0d12,#050505 70%)', tint: '#2c0d12', glc: '#ff7b84', tag: 'new' },
  { id: 'goldrush', n: 'Золото степи', e: 'slot', c: 'slots', pr: 'Velvet Games', rtp: 95, gl: '★', art: 'linear-gradient(140deg,#30250d,#050505 70%)', tint: '#30250d' },
  { id: 'spades', n: 'Ace of Spades', e: 'slot', c: 'slots', pr: 'Onyx Play', rtp: 95, gl: '♠', art: 'linear-gradient(140deg,#191b20,#040404 70%)', tint: '#191b20', glc: '#e8ebf0' },
  { id: 'vipr', n: 'Рулетка VIP', e: 'roulette', c: 'table', pr: 'Onyx Play', rtp: 97.3, gl: '36', art: 'radial-gradient(circle at 70% 30%,#3a1016,#050505 70%)', glc: '#e6dcc6' },
  { id: 'royal', n: 'Royal Crown', e: 'slot', c: 'slots', pr: 'Onyx Play', rtp: 95, gl: 'K', art: 'linear-gradient(140deg,#231a2d,#050505 70%)', tint: '#231a2d', glc: '#d9c6ff' },
  { id: 'comet2', n: 'Комета Турбо', e: 'crash', c: 'fast', pr: 'NOIR Originals', rtp: 96, gl: '×', art: 'radial-gradient(circle at 80% 80%,#2b2112,#050505 70%)', tag: 'new' },
  { id: 'l-roul', n: 'Live Рулетка', e: 'live', c: 'live', pr: 'Live-студия', rtp: 97.3, gl: '◎', art: 'radial-gradient(circle,#102a20,#050505 70%)', tag: 'live' },
  { id: 'l-bj', n: 'Live Блэкджек', e: 'live', c: 'live', pr: 'Live-студия', rtp: 99.3, gl: '21', art: 'radial-gradient(circle,#0d2118,#050505 70%)', tag: 'live' },
  { id: 'l-bac', n: 'Live Баккара', e: 'live', c: 'live', pr: 'Live-студия', rtp: 98.9, gl: 'B', art: 'radial-gradient(circle,#2a0f14,#050505 70%)', tag: 'live' },
  { id: 'l-poker', n: 'Казино Холдем', e: 'live', c: 'live', pr: 'Live-студия', rtp: 97.8, gl: '♣', art: 'radial-gradient(circle,#15151f,#050505 70%)', tag: 'live' },
];
const gameName = e => ({ slot: 'слоты', roulette: 'рулетка', crash: 'Комета', dice: 'Dice', mines: 'Мины' }[e] || e);
const rtpTxt = r => String(r).replace('.', ',') + '%';
function gcard(g) {
  const tag = g.tag ? `<span class="tag ${g.tag === 'live' ? 'live' : g.tag === 'new' ? 'new' : ''}">${g.tag === 'new' ? 'Новинка' : g.tag === 'live' ? 'Live' : esc(g.tag)}</span>` : '';
  return `<button class="gcard" type="button" data-game="${g.id}" style="--art:${g.art};${g.glc ? '--glc:' + g.glc : ''}"><div class="gart">${tag}<span class="gl">${g.gl}</span></div><div class="ginfo"><b>${esc(g.n)}</b><span><span>${esc(g.pr)}</span><span class="rtp">RTP ${rtpTxt(g.rtp)}</span></span></div></button>`;
}
function renderCasino() {
  $$('#cfilter .pill').forEach(b => b.classList.toggle('on', b.dataset.f === S.cfilter));
  const q = S.q.trim().toLowerCase();
  const list = GAMES.filter(g => (S.cfilter === 'all' || (S.cfilter === 'new' ? g.tag === 'new' : g.c === S.cfilter)) && (!q || (g.n + ' ' + g.pr).toLowerCase().includes(q)));
  $('#casino-games').innerHTML = list.length ? list.map(gcard).join('') : `<div class="empty" style="grid-column:1/-1"><b>Ничего не нашлось</b>Попробуйте другое название или сбросьте фильтр.</div>`;
}
$('#home-games').innerHTML = GAMES.filter(g => g.e !== 'live').slice(0, 6).map(gcard).join('');

/* ================= modal ================= */
let cleanup = null;
function openModal(html, wide = false) {
  if (cleanup) { cleanup(); cleanup = null; }
  const d = $('#dialog'); d.className = 'dialog' + (wide ? ' wide' : ''); d.innerHTML = html; $('#modal').hidden = false; document.body.style.overflow = 'hidden';
  const f = d.querySelector('.close'); f && f.focus({ preventScroll: true });
}
function closeModal() { if (cleanup) { cleanup(); cleanup = null; } $('#modal').hidden = true; $('#dialog').innerHTML = ''; document.body.style.overflow = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('.close')) closeModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#modal').hidden) closeModal(); });
const head = (title, meta = '') => `<div class="d-head"><div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px"><h3>${title}</h3>${meta ? `<div class="meta">${meta}</div>` : ''}</div><button class="close" type="button" aria-label="Закрыть">×</button></div>`;
const maxWin = () => (S.cfg?.maxPayout ?? 100_000_000_00) / 100;
const fairFoot = () => `<div class="d-foot"><span id="fair-foot" class="num"></span><button type="button" data-act="fair">Как проверить исход</button></div>`;
async function updateFairFoot() { const f = $('#fair-foot'); if (!f || !S.user && B.mode === 'api') return; const r = await quiet(B.fair()); if (r && $('#fair-foot')) $('#fair-foot').textContent = `Хэш сида: ${r.current.serverHash.slice(0, 16)}… · клиентский сид: ${r.current.clientSeed} · nonce: ${r.current.nonce}`; }
function stepper(id, val) { return `<div class="stepper"><button type="button" data-step="${id}" data-k="0.5" aria-label="Уменьшить ставку">−</button><input id="${id}" type="number" min="100" step="10" value="${val}" inputmode="decimal"><button type="button" data-step="${id}" data-k="2" aria-label="Увеличить ставку">+</button></div>`; }
document.addEventListener('click', e => { const b = e.target.closest('[data-step]'); if (!b) return; const i = $('#' + b.dataset.step); if (!i || i.disabled) return; i.value = Math.max(100, Math.round(+i.value * +b.dataset.k)); });
const readBet = id => Math.round(+$('#' + id).value * 100) / 100;
function liveBal() { $$('[data-live-bal]').forEach(b => b.textContent = fmt(S.balance)); renderAcct(); }
function pushHist(sel, txt, hi) { const h = $(sel); if (!h) return; const s = document.createElement('span'); s.className = hi ? 'hi' : 'lo'; s.textContent = txt; h.prepend(s); while (h.children.length > 14) h.lastChild.remove(); }
const needLogin = () => { if (B.mode === 'api' && !S.user) { openAuth('register'); return true; } return false; };

function openGame(id) {
  const g = GAMES.find(x => x.id === id); if (!g) return;
  if (g.e === 'live') { openModal(head(esc(g.n), `<span>${esc(g.pr)}</span><span>RTP <b>${rtpTxt(g.rtp)}</b></span>`) + `<div class="d-body"><div class="empty"><b>Live-столы подключаются через провайдера</b>Здесь откроется видеопоток с дилером от лицензированной студии (Evolution, Pragmatic Live, Ezugi) после подписания договора с ней.</div><button class="btn gold block" type="button" data-game="roulette">Открыть Европейскую рулетку</button></div>`); return; }
  if (needLogin()) return;
  const meta = `<span>${esc(g.pr)}</span><span>RTP <b>${rtpTxt(g.rtp)}</b></span><span>Макс. выигрыш за раунд ${fmt(maxWin())}</span><span>Баланс <b class="num" data-live-bal style="color:var(--gold-hi)">${fmt(S.balance)}</b></span>`;
  openModal(head(esc(g.n), meta) + `<div class="d-body" id="gbody"></div>` + fairFoot(), true);
  updateFairFoot();
  ({ slot: mountSlot, roulette: mountRoulette, crash: mountCrash, dice: mountDice, mines: mountMines })[g.e]($('#gbody'), g);
}

/* ---------- slot ---------- */
function mountSlot(el, g) {
  el.innerHTML = `<div class="reels" style="--tint:${g.tint}">${[0, 1, 2, 3, 4].map(r => `<div class="reel">${[0, 1, 2].map(i => `<div class="cell" id="c${r}${i}"></div>`).join('')}</div>`).join('')}</div>
  <div class="result-line" id="sres"><span class="l">10 линий. Выигрыш считается слева направо, ★ заменяет любой символ.</span></div>
  <div class="gctl"><div class="field"><label for="sbet">Ставка за спин</label>${stepper('sbet', 500)}</div><button class="btn gold big" type="button" id="spin" style="flex:1;min-width:160px">Крутить</button></div>
  <div class="hist" id="shist"></div>
  <details class="paytable"><summary>Таблица выплат (× ставка на линию = ставка / 10)</summary><div class="pt">${SL.sym.slice().reverse().map(s => `<div><span class="g s-${s}">${SL.g[s]}</span><span class="n">5× ${SL.pay[s][2]}<br>4× ${SL.pay[s][1]} · 3× ${SL.pay[s][0]}</span></div>`).join('')}</div></details>`;
  const rnd = () => SL.sym[Math.floor(Math.random() * SL.sym.length)];
  const set = (c, s) => { c.className = 'cell s-' + s; c.textContent = SL.g[s]; };
  for (let r = 0; r < 5; r++) for (let i = 0; i < 3; i++) set($('#c' + r + i), M.slotPick(Math.random()));
  let busy = false; const timers = []; cleanup = () => timers.forEach(clearInterval);
  $('#spin').onclick = async () => {
    if (busy) return; const bet = readBet('sbet'); busy = true; $('#spin').disabled = true;
    $$('.cell', el).forEach(c => c.classList.remove('hit')); $('#sres').innerHTML = '&nbsp;';
    const spinning = [0, 1, 2, 3, 4].map(r => { const cells = [0, 1, 2].map(i => $('#c' + r + i)); const t = setInterval(() => cells.forEach(c => { const s = rnd(); c.textContent = SL.g[s]; c.className = 'cell spin s-' + s; }), 70); timers.push(t); return { cells, t }; });
    let res;
    try { res = await run(() => B.slot(bet)); } catch (e) { spinning.forEach(s => { clearInterval(s.t); s.cells.forEach(c => c.classList.remove('spin')); }); busy = false; $('#spin').disabled = false; return; }
    liveBal();
    await Promise.all(spinning.map((s, r) => new Promise(ok => setTimeout(() => { clearInterval(s.t); s.cells.forEach((c, i) => set(c, res.grid[r][i])); ok(); }, 350 + r * 170))));
    for (const w of res.wins) for (let r = 0; r < w.count; r++) $('#c' + r + SL.lines[w.line][r]).classList.add('hit');
    if (res.payout > 0) $('#sres').innerHTML = `<span class="w">Выигрыш ${fmtM(res.payout)} · ×${res.multiplier.toFixed(1)}</span>`;
    else $('#sres').innerHTML = '<span class="l">Без выигрыша</span>';
    pushHist('#shist', res.payout > 0 ? `×${res.multiplier.toFixed(1)}` : '×0', res.payout >= bet);
    liveBal(); updateFairFoot(); busy = false; $('#spin').disabled = false;
  };
}

/* ---------- roulette ---------- */
function mountRoulette(el) {
  const cells = [`<button class="rc green" type="button" data-rb="n0" style="grid-column:1;grid-row:1/4">0</button>`];
  for (let col = 0; col < 12; col++) for (let row = 0; row < 3; row++) { const n = col * 3 + (3 - row); cells.push(`<button class="rc ${colorOf(n)}" type="button" data-rb="n${n}" style="grid-column:${col + 2};grid-row:${row + 1}">${n}</button>`); }
  ['c3', 'c2', 'c1'].forEach((c, i) => cells.push(`<button class="rc out" type="button" data-rb="${c}" style="grid-column:14;grid-row:${i + 1}">2:1</button>`));
  [['d1', '1–12'], ['d2', '13–24'], ['d3', '25–36']].forEach(([k, t], i) => cells.push(`<button class="rc out" type="button" data-rb="${k}" style="grid-column:${2 + i * 4}/span 4;grid-row:4">${t}</button>`));
  [['low', '1–18'], ['even', 'Чёт'], ['red', 'Красное'], ['black', 'Чёрное'], ['odd', 'Нечет'], ['high', '19–36']].forEach(([k, t], i) => cells.push(`<button class="rc out ${k === 'red' ? 'red' : k === 'black' ? 'black' : ''}" type="button" data-rb="${k}" style="grid-column:${2 + i * 2}/span 2;grid-row:5">${t}</button>`));
  el.innerHTML = `<div class="rou"><div class="wheel-box"><span class="ptr"></span><canvas id="wheel" width="520" height="520"></canvas><div class="wheel-res" id="wres">–</div></div>
   <div style="display:flex;flex-direction:column;gap:12px;min-width:0"><div class="table-scroll"><div class="rtable" id="rtable">${cells.join('')}</div></div>
   <div class="chips" id="chips">${[[100, '#b9b4ab'], [500, '#d6b46e'], [1000, '#e3505a'], [5000, '#7fb0ff']].map(([v, c], i) => `<button class="chipbtn ${i === 1 ? 'on' : ''}" type="button" data-chip="${v}" style="--c:${c}"><span>${v >= 1000 ? v / 1000 + 'K' : v}</span></button>`).join('')}
   <span class="muted" style="margin-left:auto">На столе: <b class="num" id="rtotal" style="color:var(--fg)">0</b></span></div>
   <div class="gctl"><button class="btn ghost big" type="button" id="rclear">Очистить</button><button class="btn gold big" type="button" id="rspin" style="flex:1">Крутить</button></div></div></div>
   <div class="result-line" id="rres"><span class="l">Выберите фишку и нажмите на поле. Число ×36, дюжина и колонна ×3, цвет и чёт/нечет ×2.</span></div><div class="hist" id="rhist"></div>`;
  drawWheel($('#wheel'));
  let chip = 500, bets = {}, rot = 0, busy = false;
  const total = () => Object.values(bets).reduce((a, b) => a + b, 0);
  const paint = () => { $$('#rtable .rc').forEach(c => { const k = c.dataset.rb; let b = c.querySelector('.cb'); if (bets[k]) { if (!b) { b = document.createElement('span'); b.className = 'cb'; c.appendChild(b); } b.textContent = bets[k] >= 1000 ? (bets[k] / 1000).toLocaleString('ru-RU') + 'K' : bets[k]; } else b && b.remove(); }); $('#rtotal').textContent = fmt(total()); };
  $('#chips').onclick = e => { const b = e.target.closest('[data-chip]'); if (!b) return; chip = +b.dataset.chip; $$('.chipbtn').forEach(x => x.classList.toggle('on', x === b)); };
  $('#rtable').onclick = e => { const c = e.target.closest('[data-rb]'); if (!c || busy) return; $$('#rtable .win').forEach(x => x.classList.remove('win')); bets[c.dataset.rb] = (bets[c.dataset.rb] || 0) + chip; paint(); };
  $('#rclear').onclick = () => { if (busy) return; bets = {}; paint(); };
  $('#rspin').onclick = async () => {
    if (busy) return; if (!total()) { toast('Сначала поставьте фишку на поле', 'err'); return; }
    busy = true; $('#rspin').disabled = true;
    let r; try { r = await run(() => B.roulette(bets)); } catch (e) { busy = false; $('#rspin').disabled = false; return; }
    liveBal();
    const n = r.number, idx = ORDER.indexOf(n), target = -(idx * 360 / 37), base = rot - ((rot % 360) + 360) % 360;
    rot = base + 360 * 6 + ((target % 360) + 360) % 360;
    $('#wheel').style.transform = `rotate(${rot}deg)`; $('#wres').textContent = '…';
    await sleep(4300);
    const w = $('#wres'); if (!w) return; w.textContent = n; w.style.color = n === 0 ? '#46c08f' : REDS.has(n) ? '#ff6b74' : 'var(--fg)';
    $$('#rtable [data-rb]').forEach(c => { if (M.rReturn(c.dataset.rb, n)) c.classList.add('win'); });
    const cn = { red: 'красное', black: 'чёрное', green: 'зеро' }[colorOf(n)];
    $('#rres').innerHTML = r.payout ? `<span class="w">Выпало ${n} (${cn}). Выигрыш ${fmtM(r.payout)}</span>` : `<span class="l">Выпало ${n} (${cn}). Ставки не сыграли.</span>`;
    pushHist('#rhist', String(n), colorOf(n) === 'red'); liveBal(); updateFairFoot(); busy = false; $('#rspin').disabled = false;
  };
}
function drawWheel(c) {
  const x = c.getContext('2d'), R = c.width / 2, a = 2 * Math.PI / 37; x.translate(R, R);
  x.beginPath(); x.arc(0, 0, R - 2, 0, 2 * Math.PI); x.fillStyle = '#8d7140'; x.fill();
  for (let i = 0; i < 37; i++) {
    const n = ORDER[i], s = -Math.PI / 2 - a / 2 + i * a;
    x.beginPath(); x.moveTo(0, 0); x.arc(0, 0, R - 14, s, s + a); x.closePath(); x.fillStyle = n === 0 ? '#0f4d39' : REDS.has(n) ? '#8f1a24' : '#111114'; x.fill();
    x.strokeStyle = '#d6b46e55'; x.lineWidth = 1.5; x.stroke();
    x.save(); x.rotate(s + a / 2 + Math.PI / 2); x.fillStyle = '#f2ede3'; x.font = '700 22px "JetBrains Mono", monospace'; x.textAlign = 'center'; x.fillText(String(n), 0, -(R - 44)); x.restore();
  }
  x.beginPath(); x.arc(0, 0, R * 0.52, 0, 2 * Math.PI); x.fillStyle = '#070708'; x.fill(); x.strokeStyle = '#d6b46e'; x.lineWidth = 3; x.stroke();
  for (let i = 0; i < 8; i++) { x.save(); x.rotate(i * Math.PI / 4); x.fillStyle = '#d6b46e44'; x.fillRect(-2, -R * 0.5, 4, R * 0.22); x.restore(); }
}

/* ---------- crash ---------- */
function mountCrash(el) {
  el.innerHTML = `<div class="crash-box"><canvas id="cv"></canvas><div class="crash-m" id="cm"><div>1.00×<small>Сделайте ставку, чтобы запустить раунд</small></div></div></div>
  <div class="gctl"><div class="field"><label for="cbet">Ставка</label>${stepper('cbet', 1000)}</div>
  <div class="field" style="max-width:180px"><label for="cauto">Автовывод на ×</label><input class="inp" id="cauto" type="number" min="1.01" step="0.1" value="2.00" style="height:52px"></div>
  <button class="btn gold big" type="button" id="cgo" style="flex:1;min-width:200px">Ставка</button></div>
  <div class="hist" id="chist"></div>`;
  const cv = $('#cv'), ctx = cv.getContext('2d'); let raf = 0, poll = 0, state = 'idle', t0 = 0, bet = 0, cashed = false, endT = 0;
  const size = () => { const r = cv.getBoundingClientRect(); cv.width = r.width * devicePixelRatio; cv.height = r.height * devicePixelRatio; }; size();
  const ro = new ResizeObserver(size); ro.observe(cv);
  cleanup = () => { cancelAnimationFrame(raf); clearInterval(poll); ro.disconnect(); };
  const mAt = t => Math.exp(M.CRASH_K * t);
  function draw(t, crashed) {
    const W = cv.width, H = cv.height, p = 24 * devicePixelRatio; ctx.clearRect(0, 0, W, H);
    const tMax = Math.max(8000, t * 1.15), mMax = Math.max(2, mAt(t) * 1.2);
    ctx.strokeStyle = '#ffffff10'; ctx.lineWidth = 1; ctx.fillStyle = '#5c5a56'; ctx.font = `${11 * devicePixelRatio}px JetBrains Mono, monospace`;
    for (let k = 1; k <= 4; k++) { const mv = 1 + (mMax - 1) * k / 4, y = H - p - (mv - 1) / (mMax - 1) * (H - 2 * p); ctx.beginPath(); ctx.moveTo(p, y); ctx.lineTo(W - p, y); ctx.stroke(); ctx.fillText(mv.toFixed(2) + '×', p + 4, y - 4); }
    const X = s => p + s / tMax * (W - 2 * p), Y = v => H - p - (v - 1) / (mMax - 1) * (H - 2 * p);
    ctx.beginPath(); for (let s = 0; s <= t; s += Math.max(16, t / 200)) ctx.lineTo(X(s), Y(mAt(s))); ctx.lineTo(X(t), Y(mAt(t)));
    ctx.strokeStyle = crashed ? '#e3505a' : '#f0d79c'; ctx.lineWidth = 3 * devicePixelRatio; ctx.stroke();
    ctx.lineTo(X(t), H - p); ctx.lineTo(p, H - p); ctx.closePath(); const gr = ctx.createLinearGradient(0, 0, 0, H); gr.addColorStop(0, crashed ? '#e3505a33' : '#d6b46e33'); gr.addColorStop(1, 'transparent'); ctx.fillStyle = gr; ctx.fill();
    ctx.beginPath(); ctx.arc(X(t), Y(mAt(t)), 6 * devicePixelRatio, 0, 7); ctx.fillStyle = crashed ? '#e3505a' : '#f0d79c'; ctx.fill();
  }
  const btn = $('#cgo'), cm = $('#cm');
  const reset = () => { state = 'idle'; clearInterval(poll); btn.disabled = false; btn.textContent = 'Ставка'; $('#cbet').disabled = false; $('#cauto').disabled = false; };
  function finish(r) {
    if (state === 'done') return; state = 'done'; cancelAnimationFrame(raf);
    const t = Math.log(r.point) / M.CRASH_K; draw(t, true);
    cm.className = 'crash-m boom'; cm.innerHTML = `<div>${r.point.toFixed(2)}×<small>${r.cashedAt ? 'Вы забрали на ×' + r.cashedAt.toFixed(2) : 'Комета улетела'}</small></div>`;
    pushHist('#chist', r.point.toFixed(2) + '×', r.point >= 2);
    if (r.cashedAt && !cashed) toast(`Автовывод: ${fmtM(r.payout)} на ×${r.cashedAt.toFixed(2)}`, 'ok');
    if (!r.cashedAt) toast(`Проигрыш: комета улетела на ×${r.point.toFixed(2)}`);
    liveBal(); updateFairFoot(); reset();
  }
  function frame() {
    const t = Math.max(0, performance.now() - t0), m = mAt(t);
    draw(t, false); cm.className = 'crash-m'; cm.innerHTML = `<div>${(Math.floor(m * 100) / 100).toFixed(2)}×<small>${cashed ? 'Выигрыш зафиксирован' : 'Летим'}</small></div>`;
    if (!cashed) btn.textContent = 'Забрать ' + fmt(bet * m);
    raf = requestAnimationFrame(frame);
  }
  btn.onclick = async () => {
    if (state === 'running') {
      if (cashed) return; btn.disabled = true;
      try { const r = await run(() => B.crashCashout()); if (r.cashedAt) { cashed = true; btn.textContent = `Забрано ×${r.cashedAt.toFixed(2)}`; toast(`Выигрыш ${fmtM(r.payout)} на ×${r.cashedAt.toFixed(2)}`, 'ok'); liveBal(); } if (!r.open) finish(r); }
      catch (e) { if (e.code !== 'TOO_EARLY') btn.disabled = false; else btn.disabled = false; }
      return;
    }
    bet = readBet('cbet'); const auto = +$('#cauto').value >= 1.01 ? Math.round(+$('#cauto').value * 100) / 100 : null;
    btn.disabled = true;
    let r; try { r = await run(() => B.crashStart(bet, auto)); } catch (e) { btn.disabled = false; return; }
    liveBal(); cashed = false; state = 'running'; t0 = performance.now() + (r.startsIn || 0);
    $('#cbet').disabled = true; $('#cauto').disabled = true; btn.disabled = false;
    raf = requestAnimationFrame(frame);
    poll = setInterval(async () => { const s = await quiet(B.crashStatus()); if (s && !s.open && s.point) finish(s); }, 400);
  };
  draw(0, false);
  // Re-opened mid-round: continue the running round (the server keeps the clock), or show how it ended.
  quiet(B.crashStatus()).then(s => {
    if (!s || state !== 'idle') return;
    if (s.open) {
      bet = s.bet; cashed = false; state = 'running'; t0 = performance.now() - s.elapsed;
      $('#cbet').value = s.bet; if (s.auto) $('#cauto').value = s.auto; $('#cbet').disabled = true; $('#cauto').disabled = true;
      raf = requestAnimationFrame(frame);
      poll = setInterval(async () => { const st = await quiet(B.crashStatus()); if (st && !st.open && st.point) finish(st); }, 400);
      toast('Продолжаем ваш раунд');
    } else if (s.point) { state = 'running'; finish(s); }
  });
}

/* ---------- dice ---------- */
function mountDice(el) {
  el.innerHTML = `<div class="dice-num" id="dn">50.00</div><div class="track" id="dtrack" style="--p:49.5%"><span class="mk" id="dmk"></span></div>
  <div class="field"><label for="dch">Шанс выигрыша: <span id="dchv" class="num">49.5</span>% · выигрыш, если выпадет меньше <span id="dthr" class="num">49.50</span></label><input id="dch" type="range" min="1" max="95" step="0.5" value="49.5"></div>
  <div class="trio"><div><small>Множитель</small><b id="dmul">1.9798×</b></div><div><small>Выигрыш</small><b id="dwin">—</b></div><div><small>Шанс</small><b id="dchb">49.5%</b></div></div>
  <div class="gctl"><div class="field"><label for="dbet">Ставка</label>${stepper('dbet', 1000)}</div><button class="btn gold big" type="button" id="droll" style="flex:1;min-width:160px">Бросить</button></div>
  <div class="hist" id="dhist"></div>`;
  const upd = () => { const c = +$('#dch').value, mul = 98 / c; $('#dchv').textContent = c; $('#dthr').textContent = c.toFixed(2); $('#dmul').textContent = mul.toFixed(4) + '×'; $('#dchb').textContent = c + '%'; $('#dtrack').style.setProperty('--p', c + '%'); $('#dwin').textContent = fmt(pay(readBet('dbet'), mul)); };
  $('#dch').oninput = upd; el.addEventListener('input', e => { if (e.target.id === 'dbet') upd(); }); el.addEventListener('click', e => { if (e.target.closest('[data-step]')) setTimeout(upd); }); upd();
  let busy = false;
  $('#droll').onclick = async () => {
    if (busy) return; busy = true; const bet = readBet('dbet'), c = +$('#dch').value;
    let r; try { r = await run(() => B.dice(bet, c)); } catch (e) { busy = false; return; }
    liveBal(); $('#dmk').style.left = r.roll + '%'; const dn = $('#dn'); dn.className = 'dice-num';
    const st = performance.now(); await new Promise(ok => { const step = () => { if (performance.now() - st < 450) { dn.textContent = (Math.random() * 100).toFixed(2); requestAnimationFrame(step); } else ok(); }; step(); });
    dn.textContent = r.roll.toFixed(2); dn.className = 'dice-num ' + (r.won ? 'w' : 'l');
    if (r.won) toast(`Выпало ${r.roll.toFixed(2)}. Выигрыш ${fmtM(r.payout)}`, 'ok');
    pushHist('#dhist', r.roll.toFixed(2), r.won); liveBal(); updateFairFoot(); busy = false;
  };
}

/* ---------- mines ---------- */
function mountMines(el) {
  el.innerHTML = `<div class="mines" id="mgrid">${Array.from({ length: 25 }, (_, i) => `<button class="tile" type="button" data-t="${i}" disabled aria-label="Клетка ${i + 1}"></button>`).join('')}</div>
  <div class="trio"><div><small>Открыто</small><b id="mk">0</b></div><div><small>Множитель</small><b id="mm">1.00×</b></div><div><small>Следующая</small><b id="mn">—</b></div></div>
  <div class="gctl"><div class="field"><label for="mbet">Ставка</label>${stepper('mbet', 1000)}</div>
  <div class="field" style="max-width:150px"><label for="mcount">Мин на поле</label><select class="inp" id="mcount" style="height:52px">${Array.from({ length: 24 }, (_, i) => `<option ${i + 1 === 3 ? 'selected' : ''}>${i + 1}</option>`).join('')}</select></div>
  <button class="btn gold big" type="button" id="mgo" style="flex:1;min-width:180px">Начать игру</button></div>`;
  let picks = 0, bet = 0, Mn = 3, on = false, busy = false;
  const upd = () => { $('#mk').textContent = picks; $('#mm').textContent = M.minesMult(Mn, picks).toFixed(2) + '×'; $('#mn').textContent = picks < 25 - Mn ? M.minesMult(Mn, picks + 1).toFixed(2) + '×' : '—';
    if (on) $('#mgo').textContent = picks ? 'Забрать ' + fmt(pay(bet, M.minesMult(Mn, picks))) : 'Откройте клетку'; $('#mgo').disabled = on && !picks; };
  const tiles = () => $$('#mgrid .tile');
  const reveal = mines => tiles().forEach((t, i) => { t.disabled = true; if (!t.classList.contains('gem') && !t.classList.contains('bomb')) { const m = mines.includes(i); t.classList.add(m ? 'bomb' : 'gem', 'ghost'); t.textContent = m ? '✕' : '◆'; } });
  const end = () => { on = false; $('#mgo').disabled = false; $('#mgo').textContent = 'Новая игра'; $('#mbet').disabled = false; $('#mcount').disabled = false; liveBal(); updateFairFoot(); };
  $('#mcount').onchange = () => { Mn = +$('#mcount').value; upd(); };
  $('#mgo').onclick = async () => {
    if (busy) return; busy = true;
    try {
      if (on) { const r = await run(() => B.minesCashout()); toast(`Выигрыш ${fmtM(r.payout)} · ×${r.multiplier.toFixed(2)}`, 'ok'); reveal(r.mines); end(); return; }
      bet = readBet('mbet'); Mn = +$('#mcount').value;
      await run(() => B.minesStart(bet, Mn)); liveBal();
      picks = 0; on = true; $('#mbet').disabled = true; $('#mcount').disabled = true;
      tiles().forEach(t => { t.disabled = false; t.className = 'tile'; t.textContent = ''; }); upd();
    } catch (e) {} finally { busy = false; }
  };
  // Resume an unfinished round (the server keeps it open until the player cashes out or hits a mine).
  quiet(B.minesState()).then(r => {
    if (!r) return; bet = r.bet; Mn = r.mines; picks = r.picks.length; on = true;
    $('#mbet').value = r.bet; $('#mcount').value = r.mines; $('#mbet').disabled = true; $('#mcount').disabled = true;
    tiles().forEach((t, i) => { t.disabled = r.picks.includes(i); if (r.picks.includes(i)) { t.classList.add('gem'); t.textContent = '◆'; } });
    upd(); toast('Продолжаем незавершённую игру');
  });
  $('#mgrid').onclick = async e => {
    const t = e.target.closest('.tile'); if (!t || !on || t.disabled || busy) return; busy = true; t.disabled = true;
    try {
      const r = await run(() => B.minesReveal(+t.dataset.t));
      if (r.lost) { t.classList.add('bomb'); t.textContent = '✕'; toast('Мина. Ставка проиграна.'); reveal(r.mines); end(); return; }
      t.classList.add('gem'); t.textContent = '◆'; picks++; upd();
      if (r.finished) { toast(`Все клетки открыты! ${fmtM(r.payout)}`, 'ok'); reveal(r.mines); end(); }
    } catch (err) { t.disabled = false; } finally { busy = false; }
  };
  upd();
}

/* ================= wallet ================= */
let wTab = 'deposit', wMethod = 'card', wInst = 0, wInstList = [];
const methodName = i => (B.methods().find(m => m.id === i.method && m.provider === i.provider)?.name || i.method);
function openWallet(tab = 'deposit') { if (needLogin()) return; wTab = tab; renderWallet(); }
async function renderWallet() {
  const methods = B.methods(); let body = '';
  if (!methods.length && wTab !== 'history') { openModal(head('Кошелёк') + `<div class="d-body"><div class="empty"><b>Платёжные способы подключаются</b>Пополнение и вывод появятся после подключения платёжного провайдера. Напишите в поддержку, если вам нужна помощь.</div></div>`); return; }
  const m = methods.find(x => x.id === wMethod) || methods[0]; if (m) wMethod = m.id;
  if (wTab === 'history') {
    const h = await quiet(B.history()) || { ledger: [], payments: [] };
    const pays = h.payments.map(t => `<div class="tx"><span>${esc(t.n)}</span><span class="amt ${t.a > 0 ? 'plus' : 'minus'}">${t.a > 0 ? '+' : ''}${fmtM(t.a)}</span><small>${new Date(t.at).toLocaleString('ru-RU')}</small><small style="text-align:right">${esc(t.st)}${t.canCancel ? ` · <button type="button" data-wcancel="${t.id}" style="color:var(--gold);font-weight:700;font-size:11px">Отменить</button>` : ''}</small></div>`).join('');
    const led = h.ledger.slice(0, 60).map(t => `<div class="tx"><span>${esc(t.n)}</span><span class="amt ${t.a > 0 ? 'plus' : 'minus'}">${t.a > 0 ? '+' : ''}${fmtM(t.a)}</span><small>${new Date(t.at).toLocaleString('ru-RU')}</small><small></small></div>`).join('');
    body = (pays ? `<h4 class="eyebrow" style="margin:0">Платежи</h4>${pays}` : '') + (led ? `<h4 class="eyebrow" style="margin:8px 0 0">Все операции по счёту</h4>${led}` : '') || `<div class="empty"><b>Операций пока нет</b>Здесь будут пополнения, выводы и ставки.</div>`;
  } else if (wTab === 'withdraw') {
    wInstList = (await quiet(B.instruments())) || [];
    const u = S.user || {};
    const kycBlock = B.mode === 'api' && u.kycStatus !== 'verified' ? `<div class="note"><b>Нужна верификация личности.</b> Статус: ${{ none: 'не начата', pending: 'на проверке', rejected: 'отклонена' }[u.kycStatus] || '—'}. <button type="button" data-act="kyc" style="color:var(--gold);font-weight:700">Пройти проверку</button></div>` : '';
    const hold = u.securityHoldUntil && new Date(u.securityHoldUntil) > new Date() ? `<div class="note"><b>Вывод доступен с ${new Date(u.securityHoldUntil).toLocaleString('ru-RU')}.</b> После смены пароля или 2FA мы делаем паузу 24 часа: так никто не сможет вывести деньги, если получил доступ к аккаунту.</div>` : '';
    if (!wInstList.length) body = `${kycBlock}<div class="empty"><b>Сначала пополните счёт</b>Вывести деньги можно только на карту или кошелёк, с которого вы пополняли счёт. Это защищает ваши деньги, если кто-то получит доступ к аккаунту.</div>`;
    else {
      if (wInst >= wInstList.length) wInst = 0;
      const sel = wInstList[wInst], m = methods.find(x => x.id === sel.method && x.provider === sel.provider) || methods[0];
      const autoUpTo = S.cfg?.withdrawals?.autoApproveUpTo;
      body = `${kycBlock}${hold}<div class="mgroup">Куда вывести</div><div class="methods">${wInstList.map((i, k) => `<button type="button" class="method ${k === wInst ? 'on' : ''}" data-inst="${k}"><b>${esc(methodName(i))}</b><small class="num">${esc(i.instrument.split(':').slice(1).join(':') || i.instrument)}</small></button>`).join('')}</div>
      <div class="field"><label for="wamt">Сумма, ${cur()} · от ${m.min.toLocaleString('ru-RU')} до ${m.max.toLocaleString('ru-RU')}</label><input class="inp" id="wamt" type="number" min="${m.min}" value="${Math.max(0, Math.min(10000, Math.floor(S.balance)))}" inputmode="decimal"></div>
      <div class="quick">${[5000, 10000, 25000, 'Всё'].map(v => `<button type="button" data-wq="${v}">${typeof v === 'number' ? v.toLocaleString('ru-RU') : v}</button>`).join('')}</div>
      ${S.bonus || S.bonusBalance ? `<div class="note"><b>У вас есть неотыгранный бонус.</b> При выводе он будет аннулирован. Ваши собственные деньги не пострадают.</div>` : ''}
      <div class="note">Перед выводом нужно сделать ставки на сумму пополнений.${autoUpTo ? ` Выплаты до ${fmt(autoUpTo / 100)} верифицированным игрокам отправляются автоматически, крупные проверяет финансовый отдел.` : ''}</div>
      <div id="wconfirm"></div>
      <button class="btn gold big block" type="button" id="wgo">Вывести</button>`;
    }
  } else {
    let groups = '', last = ''; methods.forEach(x => { if (x.group !== last) { groups += `<div class="mgroup">${esc(x.group)}</div>`; last = x.group; } groups += `<button type="button" class="method ${x.id === wMethod ? 'on' : ''}" data-method="${x.id}"><b>${esc(x.name)}</b><small>${esc(x.eta)}</small></button>`; });
    const firstDep = B.mode === 'api' ? !S.bonus && !S.bonusBalance && S.user?.bonusPref !== 'none' : !D.tx.some(t => t.t === 'dep');
    body = `<div class="methods">${groups}</div>
    <div class="field"><label for="wamt">Сумма, ${cur()} · от ${m.min.toLocaleString('ru-RU')} до ${m.max.toLocaleString('ru-RU')}</label><input class="inp" id="wamt" type="number" min="${m.min}" value="${Math.max(10000, m.min)}" inputmode="decimal"></div>
    <div class="quick">${[5000, 10000, 25000, 50000].map(v => `<button type="button" data-wq="${v}">${v.toLocaleString('ru-RU')}</button>`).join('')}</div>
    <label class="check"><input type="checkbox" id="wbonus" ${firstDep ? 'checked' : 'disabled'}><span>Бонус 100% на первый депозит (до 300 000 ₸, вейджер ×30) ${firstDep ? '' : '(недоступен)'}. <button type="button" data-act="rules" style="color:var(--gold);font-weight:700">Условия</button></span></label>
    <button class="btn gold big block" type="button" id="wgo">Перейти к оплате</button>
    ${B.mode === 'demo' ? `<div class="note"><b>Демо:</b> деньги виртуальные. С сервером этот шаг ведёт на страницу платёжного провайдера.</div>` : S.cfg.sandbox ? `<div class="note"><b>Тестовый шлюз:</b> откроется страница песочницы, деньги не списываются.</div>` : ''}`;
  }
  const meta = `<span>Баланс <b class="num" style="color:var(--gold-hi)">${fmt(S.balance)}</b></span>${S.bonusBalance ? `<span>Бонус <b class="num">${fmt(S.bonusBalance)}</b></span>` : ''}${S.pendingWd ? `<span>На выводе <b class="num">${fmt(S.pendingWd)}</b></span>` : ''}`;
  openModal(head('Кошелёк', meta) + `<div class="d-body"><div class="tabs">${[['deposit', 'Пополнить'], ['withdraw', 'Вывести'], ['history', 'История']].map(([k, n]) => `<button type="button" data-wtab="${k}" class="${wTab === k ? 'on' : ''}">${n}</button>`).join('')}</div>${body}</div>`, true);
}
async function walletGo(forfeitBonus = false) {
  const dep = wTab === 'deposit', inst = dep ? null : wInstList[wInst];
  const m = dep ? B.methods().find(x => x.id === wMethod) : B.methods().find(x => x.id === inst.method && x.provider === inst.provider), a = +$('#wamt').value;
  if (!(a >= m.min && a <= m.max)) { toast(`Сумма для ${m.name}: от ${m.min.toLocaleString('ru-RU')} до ${m.max.toLocaleString('ru-RU')} ${cur()}`, 'err'); return; }
  const b = $('#wgo'); b.disabled = true; b.textContent = dep ? 'Открываем страницу оплаты…' : 'Создаём заявку…';
  try {
    if (dep) { const r = await run(() => B.deposit({ method: m.id, provider: m.provider, amount: a, withBonus: $('#wbonus')?.checked && !$('#wbonus').disabled })); if (r.redirected) return; }
    else {
      let r;
      try { r = await B.withdraw({ method: inst.method, provider: inst.provider, instrument: inst.instrument, amount: a, forfeitBonus }); }
      catch (e) {
        if (e.code === 'BONUS_ACTIVE') {
          const bn = e.data?.bonus; b.disabled = false; b.textContent = 'Вывести'; b.hidden = true;
          $('#wconfirm').innerHTML = `<div class="note" style="border-color:var(--gold-lo)"><b>Бонус будет аннулирован.</b> Бонус ${bn ? fmt(bn.amount / 100) : ''} отыгран на ${bn ? Math.floor(bn.wagered / bn.wager_req * 100) : 0}%. Если вывести деньги сейчас, бонус сгорит. Ваши собственные деньги останутся на счёте.<div class="row-gap" style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn gold" type="button" id="wforfeit">Вывести и отказаться от бонуса</button><button class="btn ghost" type="button" id="wkeep">Продолжить отыгрыш</button></div></div>`;
          return;
        }
        toast(e.message, 'err'); if (e.code === 'KYC_REQUIRED') { closeModal(); openAccount(); } throw e;
      }
      toast(r.status === 'approved' ? `Вывод ${fmt(a)} одобрен автоматически и отправлен` : `Заявка на вывод ${fmt(a)} создана и передана на проверку`, 'ok');
    }
    await B.refresh(); renderWallet();
  } catch (e) { if ($('#wgo')) { b.disabled = false; b.textContent = dep ? 'Перейти к оплате' : 'Вывести'; } }
}

/* ================= auth & profile ================= */
let aTab = 'oneclick';
function openAuth(tab) {
  if (tab === 'login') aTab = 'login'; else if (tab === 'register' && aTab === 'login') aTab = 'oneclick';
  const tabs = [['oneclick', 'В 1 клик'], ['phone', 'Телефон'], ['email', 'E-mail'], ['login', 'Вход']];
  let f;
  const captchaBox = S.cfg?.turnstileSiteKey ? '<div id="captcha"></div>' : '';
  if (aTab === 'login') f = `<div class="field"><label for="alogin">ID, e-mail или телефон</label><input class="inp" id="alogin" autocomplete="username" style="font-family:var(--font-ui)"></div>
    <div class="field"><label for="apass">Пароль</label><input class="inp" id="apass" type="password" autocomplete="current-password"></div>
    <div class="field" id="atotp-wrap" hidden><label for="atotp">Код из приложения 2FA</label><input class="inp" id="atotp" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>
    ${captchaBox}
    <button class="btn gold big block" type="button" id="alog">Войти</button>
    <p class="muted" style="margin:0;font-size:12px">Забыли пароль? Напишите в поддержку: восстановление по SMS и e-mail появится после подключения провайдера рассылок.</p>`;
  else {
    const extra = { oneclick: `<div class="note">Мы создадим аккаунт с ID и паролем. Телефон и e-mail можно добавить позже.</div>`,
      phone: `<div class="field"><label for="aphone">Номер телефона</label><input class="inp" id="aphone" type="tel" placeholder="+7 700 000 00 00" inputmode="tel" autocomplete="tel"></div><div class="field"><label for="apass">Пароль</label><input class="inp" id="apass" type="password" placeholder="Не меньше 10 символов" autocomplete="new-password"></div>`,
      email: `<div class="field"><label for="aemail">E-mail</label><input class="inp" id="aemail" type="email" placeholder="name@example.com" autocomplete="email" style="font-family:var(--font-ui)"></div><div class="field"><label for="apass">Пароль</label><input class="inp" id="apass" type="password" placeholder="Не меньше 10 символов" autocomplete="new-password"></div>` }[aTab];
    f = `${extra}
    <div class="field"><label for="abirth">Дата рождения</label><input class="inp" id="abirth" type="date" max="${new Date(Date.now() - 18 * 365.25 * 864e5).toISOString().slice(0, 10)}"></div>
    <div class="kv"><span>Валюта счёта</span><b>${esc(S.cfg?.currency || 'KZT')} · ${CUR[S.cfg?.currency || 'KZT']}</b></div>
    <div class="field"><label for="abonus">Приветственный бонус</label><select class="inp" id="abonus"><option value="casino">Казино: 100% до 300 000 ₸</option><option value="sport">Спорт: 100% до 300 000 ₸</option><option value="none">Без бонуса</option></select></div>
    <label class="check"><input type="checkbox" id="a18"><span>Мне исполнилось 18 лет, у меня нет другого аккаунта в NOIR, я принимаю <button type="button" data-act="rules" style="color:var(--gold);font-weight:700">правила</button> и политику ответственной игры.</span></label>
    ${captchaBox}
    <button class="btn gold big block" type="button" id="ago">Зарегистрироваться</button>`;
  }
  openModal(head(aTab === 'login' ? 'Вход' : 'Регистрация') + `<div class="d-body"><div class="tabs">${tabs.map(([k, n]) => `<button type="button" data-atab="${k}" class="${aTab === k ? 'on' : ''}">${n}</button>`).join('')}</div>${f}</div>`);
  if (S.cfg?.turnstileSiteKey && window.turnstile && $('#captcha')) window.turnstile.render('#captcha', { sitekey: S.cfg.turnstileSiteKey, theme: 'dark' });
}
const captchaToken = () => $('#captcha [name="cf-turnstile-response"]')?.value || undefined;
async function doRegister() {
  if (!$('#a18').checked) { toast('Подтвердите, что вам есть 18 лет', 'err'); return; }
  const birthDate = $('#abirth').value; if (!birthDate) { toast('Укажите дату рождения', 'err'); return; }
  const f = { method: aTab, birthDate, bonusPref: $('#abonus').value, acceptTerms: true, captcha: captchaToken() };
  if (aTab === 'phone') { f.phone = $('#aphone').value; f.password = $('#apass').value; }
  if (aTab === 'email') { f.email = $('#aemail').value.trim(); f.password = $('#apass').value; }
  if (f.password !== undefined && f.password.length < 10) { toast('Пароль должен быть не короче 10 символов', 'err'); return; }
  $('#ago').disabled = true;
  try {
    const cred = await run(() => B.register(f)); renderAcct();
    if (cred) openModal(head('Аккаунт создан') + `<div class="d-body"><p class="muted" style="margin:0">Сохраните данные для входа: пароль показывается один раз.</p><div class="cred"><span>ID</span>${esc(cred.id)}<span>Пароль</span>${esc(cred.password)}</div><button class="btn gold big block" type="button" data-act="deposit">Пополнить и получить бонус</button></div>`);
    else { closeModal(); toast('Добро пожаловать в NOIR', 'ok'); openWallet('deposit'); }
  } catch (e) { if ($('#ago')) $('#ago').disabled = false; }
}
async function doLogin() {
  $('#alog').disabled = true;
  try { await run(() => B.login($('#alogin').value.trim(), $('#apass').value, $('#atotp')?.value.trim(), captchaToken())); closeModal(); renderAcct(); applyReality(); toast('С возвращением!', 'ok'); }
  catch (e) {
    if (e.code === 'TOTP_REQUIRED' && $('#atotp-wrap')) { $('#atotp-wrap').hidden = false; $('#atotp').focus(); }
    if ($('#alog')) $('#alog').disabled = false;
  }
}
function openAccount() {
  if (!S.user) { openAuth('register'); return; }
  const u = S.user, L = S.limits || {};
  const kyc = { none: 'не пройдена', pending: 'на проверке', verified: 'пройдена', rejected: 'отклонена' }[u.kycStatus] || '—';
  const pend = L.pending ? `<div class="note">Повышение лимитов вступит в силу ${new Date(L.pendingEffectiveAt).toLocaleString('ru-RU')} (24 часа на обдумывание).</div>` : '';
  const excl = L.selfExcludedUntil && new Date(L.selfExcludedUntil) > new Date() ? `<div class="note"><b>Самоисключение активно</b> до ${new Date(L.selfExcludedUntil).toLocaleString('ru-RU')}. Ставки и пополнения недоступны, вывод доступен.</div>` : '';
  openModal(head(esc(u.name), `<span>ID <b class="num" style="color:var(--fg)">${esc(u.id)}</b></span><span>Валюта ${esc(u.currency)}</span><span>Верификация: ${kyc}</span>`) + `<div class="d-body">
    <div class="trio"><div><small>Баланс</small><b>${fmt(S.balance)}</b></div><div><small>Бонус</small><b>${fmt(S.bonusBalance || 0)}</b></div><div><small>На выводе</small><b>${fmt(S.pendingWd || 0)}</b></div></div>
    ${S.bonus ? `<div class="note"><b>Отыгрыш бонуса (${S.bonus.product === 'sport' ? 'спорт' : 'казино'}):</b> ${fmt(S.bonus.wagered / 100)} из ${fmt(S.bonus.wager_req / 100)} до ${new Date(S.bonus.expires_at).toLocaleDateString('ru-RU')}. <button type="button" data-act="rules" style="color:var(--gold);font-weight:700">Что засчитывается</button></div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn gold" type="button" data-act="deposit">Пополнить</button><button class="btn ghost" type="button" data-act="withdraw">Вывести</button><button class="btn ghost" type="button" data-act="history">История</button>${u.kycStatus !== 'verified' ? `<button class="btn ghost" type="button" data-act="kyc">Пройти верификацию</button>` : ''}</div>
    <h3 style="font:500 20px var(--font-display)">Безопасность</h3>
    ${u.securityHoldUntil && new Date(u.securityHoldUntil) > new Date() ? `<div class="note">Вывод временно недоступен до ${new Date(u.securityHoldUntil).toLocaleString('ru-RU')}: защитная пауза после смены пароля или 2FA.</div>` : ''}
    <div class="kv"><span>Вход по коду из приложения (2FA)</span><b style="font-family:var(--font-ui)">${u.totpEnabled ? 'включён' : 'выключен'}</b></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${u.totpEnabled ? '<button class="btn ghost" type="button" id="tfa-off">Отключить 2FA</button>' : '<button class="btn gold" type="button" id="tfa-on">Включить 2FA</button>'}<button class="btn ghost" type="button" id="sess">Активные сеансы</button><button class="btn ghost" type="button" id="pwd">Сменить пароль</button></div>
    <div id="secbox"></div>
    <h3 style="font:500 20px var(--font-display)" id="limits">Ответственная игра</h3>${excl}${pend}
    <div class="field"><label for="ldep">Дневной лимит депозита, ${cur()} (0 = без лимита)</label><input class="inp" id="ldep" type="number" min="0" step="1000" value="${L.depositDaily ? (B.mode === 'api' ? L.depositDaily / 100 : L.depositDaily) : 0}"></div>
    <div class="field"><label for="lloss">Дневной лимит проигрыша, ${cur()} (0 = без лимита)</label><input class="inp" id="lloss" type="number" min="0" step="1000" value="${L.lossDaily ? (B.mode === 'api' ? L.lossDaily / 100 : L.lossDaily) : 0}"></div>
    <div class="field"><label for="lreal">Напоминать о времени в игре каждые, минут (0 = выкл.)</label><input class="inp" id="lreal" type="number" min="0" max="240" step="5" value="${L.realityCheckMin || 0}"></div>
    <div class="field"><label for="lex">Самоисключение</label><select class="inp" id="lex"><option value="0">Не включать</option><option value="1">На 24 часа</option><option value="7">На 7 дней</option><option value="30">На 30 дней</option><option value="180">На 6 месяцев</option></select></div>
    <p class="muted" style="margin:0;font-size:12px">Снижение лимита действует сразу. Повышение или снятие лимита вступает в силу через 24 часа. Самоисключение нельзя отменить досрочно.</p>
    <div id="lconfirm"></div>
    <button class="btn gold block" type="button" id="lsave">Сохранить лимиты</button>
    <button class="btn ghost block" type="button" id="logout">Выйти</button></div>`);
}
async function saveLimits(confirmed = false) {
  const k = B.mode === 'api' ? 100 : 1, v = id => Math.max(0, +$('#' + id).value || 0);
  const ex = +$('#lex').value;
  if (ex && !confirmed) {
    const until = new Date(Date.now() + ex * 864e5).toLocaleString('ru-RU');
    $('#lconfirm').innerHTML = `<div class="note" style="border-color:var(--loss)"><b style="color:var(--loss)">Самоисключение до ${until}.</b> Его нельзя отменить досрочно. Ставки и пополнения будут недоступны, вывод останется. Новый аккаунт на ваше имя тоже будет заблокирован.<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><button class="btn gold" type="button" id="lsave-confirm">Да, включить самоисключение</button><button class="btn ghost" type="button" id="lsave-cancel">Отмена</button></div></div>`;
    return;
  }
  const body = { depositDaily: v('ldep') * k || null, lossDaily: v('lloss') * k || null, realityCheckMin: v('lreal') || null, ...(ex ? { selfExcludeDays: ex } : {}) };
  try {
    const r = await run(() => B.setLimits(body));
    toast(ex ? `Самоисключение включено на ${ex} дн.` : r.pending?.length ? 'Сохранено. Повышение лимита вступит в силу через 24 часа.' : 'Лимиты сохранены', 'ok');
    applyReality(); openAccount();
  } catch (e) {}
}
async function twofaOn() {
  try {
    const r = await run(() => B.twofaSetup());
    $('#secbox').innerHTML = `<div class="note"><b>1.</b> Добавьте ключ в Google Authenticator, 1Password или аналог:<div class="cred" style="margin:8px 0"><span>Ключ</span>${esc(r.secret)}</div><b>2.</b> Введите 6-значный код из приложения:<div style="display:flex;gap:8px;margin-top:8px"><input class="inp" id="tfa-code" inputmode="numeric" maxlength="6" style="max-width:160px"><button class="btn gold" type="button" id="tfa-confirm">Подтвердить</button></div></div>`;
  } catch (e) {}
}
function twofaOff() {
  $('#secbox').innerHTML = `<div class="note">Чтобы отключить 2FA, введите пароль и код. После отключения вывод будет недоступен 24 часа.<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input class="inp" id="tfa-pass" type="password" placeholder="Пароль" style="max-width:200px"><input class="inp" id="tfa-code" inputmode="numeric" maxlength="6" placeholder="Код" style="max-width:120px"><button class="btn ghost" type="button" id="tfa-disable">Отключить</button></div></div>`;
}
async function sessionsBox() {
  const list = await quiet(B.sessions()) || [];
  $('#secbox').innerHTML = `<div class="note">${list.map(s => `<div class="kv" style="padding:4px 0"><span>${esc((s.user_agent || '').replace(/\(.*?\)/g, '').slice(0, 40) || 'Устройство')} · ${esc(s.ip || '')}</span><b style="font-family:var(--font-ui)">${s.current ? 'это устройство' : new Date(s.last_seen).toLocaleString('ru-RU')}</b></div>`).join('')}
    ${list.length > 1 ? '<button class="btn ghost" type="button" id="sess-kill" style="margin-top:8px">Завершить все другие сеансы</button>' : ''}</div>`;
}
function passwordBox() {
  $('#secbox').innerHTML = `<div class="note">После смены пароля все другие сеансы завершатся, а вывод будет недоступен 24 часа.<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><input class="inp" id="pw-cur" type="password" placeholder="Текущий пароль" autocomplete="current-password" style="max-width:200px"><input class="inp" id="pw-new" type="password" placeholder="Новый, от 10 символов" autocomplete="new-password" style="max-width:220px"><button class="btn gold" type="button" id="pw-save">Сменить</button></div></div>`;
}

/** Plain-language terms: what players agree to. Values come from the server configuration where available. */
function openRules() {
  const c = S.cfg || {}, b = c.bonus || { wager: 30, days: 30, max: 300_000_00 }, w = b.casinoWeights || { slot: 1, crash: 0.2, mines: 0.2, roulette: 0.1, dice: 0.1 };
  const pct = x => Math.round(x * 100) + '%';
  const sec = (t, items) => `<h4 class="eyebrow" style="margin:6px 0 0">${t}</h4><ul style="margin:0;padding-left:18px;color:var(--muted);display:flex;flex-direction:column;gap:4px">${items.map(i => `<li>${i}</li>`).join('')}</ul>`;
  openModal(head('Правила и условия') + `<div class="d-body">
    ${sec('Аккаунт', ['Играть можно с 18 лет. Один человек — один аккаунт. Повторные аккаунты блокируются после проверки документов.', 'Для вывода нужна верификация личности. Документы проверяет специализированный провайдер.', 'Вы отвечаете за сохранность пароля. Включите 2FA в профиле, чтобы защитить аккаунт.'])}
    ${sec('Приветственный бонус', [`100% от первого депозита, до ${fmt(b.max / 100)}. Начисляется на бонусный счёт и переходит на основной после отыгрыша ×${b.wager} суммы бонуса за ${b.days} дней.`, `Казино: слоты засчитываются на ${pct(w.slot)}, Crash и Мины на ${pct(w.crash)}, рулетка и Dice на ${pct(w.dice)} от ставки.`, `Спорт: засчитываются рассчитанные экспрессы от ${b.sport?.minLegs ?? 3} событий с коэффициентом каждого от ${(b.sport?.minLegOdds ?? 1.4).toFixed(2).replace('.', ',')}. Возвраты не засчитываются.`, 'Один бонус на человека и на платёжную карту. Вывод до окончания отыгрыша аннулирует бонус (собственные деньги остаются).'])}
    ${sec('Кэшбэк', [`Каждый понедельник возвращаем ${c.cashback?.pct ?? 10}% чистого проигрыша за прошлую неделю, до ${fmt((c.cashback?.max ?? 1_000_000_00) / 100)}. Без вейджера.`, 'Кэшбэк не начисляется за неделю, в которой у вас был активный бонус.'])}
    ${sec('Ставки на спорт', ['Ставка принимается по коэффициенту на момент подтверждения сервером. Поведение при изменении коэффициента выбирается в купоне.', `Live-ставки принимаются с задержкой до ${Math.round((c.liveBetDelayMs ?? 5000) / 1000)} секунд и отклоняются, если за это время рынок закрылся или коэффициент изменился.`, 'Если событие отменено, ставка на него возвращается (в экспрессе коэффициент события считается равным 1).', 'Ставки по явно ошибочным коэффициентам (опечатка в линии) могут быть пересчитаны по рыночному коэффициенту.', 'Оператор может ограничить максимальную ставку для отдельных игроков.'])}
    ${sec('Казино', ['RTP каждой игры указан на её карточке. Все исходы проверяемы (Provably Fair).', `Максимальный выигрыш за один раунд или одну ставку: ${fmt(maxWin())}.`, 'Незавершённые раунды Мин сохраняются, раунд Crash завершается по часам сервера, даже если вы закрыли окно.'])}
    ${sec('Пополнение и вывод', ['Вывод только на карту или кошелёк, с которого вы пополняли счёт.', 'Перед выводом нужно сделать ставки на сумму пополнений (защита от отмывания денег).', 'После смены пароля или 2FA вывод недоступен 24 часа.', 'При отзыве платежа через банк (chargeback) аккаунт блокируется до выяснения обстоятельств.'])}
    ${sec('Ответственная игра', ['Лимиты депозита и проигрыша, напоминания о времени и самоисключение доступны в профиле.', 'Снижение лимита действует сразу, повышение — через 24 часа. Самоисключение нельзя отменить досрочно.'])}
  </div>`);
}

let realityTimer = null; const sessionStart = Date.now();
function applyReality() { clearInterval(realityTimer); const m = S.limits?.realityCheckMin; if (m > 0) realityTimer = setInterval(() => toast(`Вы в игре уже ${Math.round((Date.now() - sessionStart) / 60000)} мин. Баланс: ${fmt(S.balance)}. Сделайте паузу, если нужно.`), m * 60000); }

async function openFair() {
  if (needLogin()) return;
  const f = await quiet(B.fair()); if (!f) return;
  const rev = (f.revealed || []).slice(0, 3).map(r => `<div class="note"><b>Раскрытый серверный сид</b><br><span class="num" style="word-break:break-all;font-size:11px">${esc(r.server_seed)}</span><br>SHA-256: <span class="num" style="word-break:break-all;font-size:11px">${esc(r.server_hash)}</span><br>Клиентский сид: ${esc(r.client_seed)} · ставок: ${r.nonce}</div>`).join('');
  openModal(head('Provably Fair') + `<div class="d-body">
    <p class="muted" style="margin:0">Каждый исход считается как HMAC-SHA256(серверный сид, «клиентский сид:nonce:раунд»). Хэш серверного сида показан до ставки, поэтому исход нельзя подменить. При смене сида старый раскрывается, и вы можете пересчитать все прошлые игры.</p>
    <div class="field"><label>SHA-256 текущего серверного сида</label><div class="inp" style="height:auto;padding:10px 12px;word-break:break-all;font-size:12px">${esc(f.current.serverHash)}</div></div>
    <div class="field"><label for="fclient">Новый клиентский сид (латиница, цифры, - и _)</label><input class="inp" id="fclient" value="${esc(f.current.clientSeed)}" maxlength="64"></div>
    <div class="kv"><span>Ставок на этом сиде (nonce)</span><b>${f.current.nonce}</b></div>
    ${rev}
    <div class="note">Как получить число: возьмите 4 байта HMAC как целое без знака и разделите на 2³². Рулетка: ⌊x·37⌋. Dice: ⌊x·10000⌋/100. Crash: max(1; ⌊96/(1−x)⌋/100).</div>
    <button class="btn gold" type="button" id="frot">Сменить сид и раскрыть текущий</button></div>`);
}

/* ================= header / router ================= */
function renderAcct() {
  $('#acct').innerHTML = `<div class="bal"><small>Баланс</small><b>${fmt(S.balance)}</b></div>
   <button class="btn gold" type="button" data-act="deposit">Пополнить</button>
   ${S.user ? `<button class="avatar" type="button" data-act="account" aria-label="Профиль">${esc(String(S.user.name).replace(/^ID /, '').slice(0, 1).toUpperCase())}</button>`
    : `<button class="btn ghost hide-sm" type="button" data-act="login">Вход</button><button class="btn ghost hide-sm" type="button" data-act="register">Регистрация</button><button class="avatar" type="button" data-act="register" aria-label="Войти">◎</button>`}`;
  $$('[data-live-bal]').forEach(b => b.textContent = fmt(S.balance));
}
const VIEWS = { home: 'home', sport: 'sport', live: 'sport', casino: 'casino', livecasino: 'casino', fast: 'casino', promo: 'promo' };
function route() {
  let v = location.hash.slice(1);
  if (v.startsWith('kyc-')) { const st = v.slice(4); toast({ verified: 'Личность подтверждена, вывод доступен', pending: 'Документы на дополнительной проверке', rejected: 'Верификация не пройдена. Обратитесь в поддержку.' }[st] || 'Статус верификации обновлён', st === 'verified' ? 'ok' : st === 'pending' ? '' : 'err'); B.refresh(); history.replaceState(null, '', '#home'); v = 'home'; }
  if (v.startsWith('deposit-')) { toast(v === 'deposit-succeeded' ? 'Оплата прошла, деньги зачислены' : 'Оплата отклонена', v === 'deposit-succeeded' ? 'ok' : 'err'); B.refresh(); history.replaceState(null, '', '#home'); v = 'home'; }
  if (!VIEWS[v]) v = 'home';
  Object.values(VIEWS).forEach(x => $('#v-' + x).hidden = x !== VIEWS[v]);
  $$('#nav a,#mnav a').forEach(a => a.classList.toggle('on', a.dataset.v === v || (v === 'live' && a.dataset.v === 'sport' && a.closest('#mnav'))));
  if (v === 'sport' || v === 'live') { S.line = v === 'live' ? 'live' : S.line === 'live' ? 'all' : S.line; renderSport(); renderSlip(); }
  if (v === 'casino' || v === 'livecasino' || v === 'fast') {
    S.cfilter = { casino: S.cfilter === 'live' ? 'all' : S.cfilter, livecasino: 'live', fast: 'fast' }[v];
    $('#casino-title').textContent = { casino: 'Казино', livecasino: 'Live-казино', fast: 'Быстрые игры' }[v]; renderCasino();
  }
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', route);

/* ================= events ================= */
document.addEventListener('click', async e => {
  const t = e.target.closest('button,a'); if (!t) return; const d = t.dataset;
  if (d.ev) { toggleSel(+d.ev, +d.out); return; }
  if (d.game) { openGame(d.game); return; }
  if (d.sport) { S.sport = d.sport; renderSport(); return; }
  if (d.line) { S.line = d.line; renderSport(); return; }
  if (d.f) { S.cfilter = d.f; renderCasino(); return; }
  if (d.slip) { S.slipTab = d.slip; renderSlip(); return; }
  if (d.mode) { S.slipMode = d.mode; renderSlip(); return; }
  if (d.rm) { S.slip = S.slip.filter(s => s.ev !== +d.rm); if (S.slip.length < 2) S.slipMode = 'single'; renderSport(); renderSlip(); return; }
  if (d.stake) { S.stake = +d.stake; renderSlip(); return; }
  if (d.go) { location.hash = d.go; return; }
  if (d.wtab) { wTab = d.wtab; renderWallet(); return; }
  if (d.method) { wMethod = d.method; renderWallet(); return; }
  if (d.wq) { $('#wamt').value = d.wq === 'Всё' ? Math.floor(S.balance) : d.wq; return; }
  if (d.wcancel) { try { await run(() => B.cancelWithdrawal(+d.wcancel)); toast('Заявка на вывод отменена, деньги вернулись на счёт', 'ok'); await B.refresh(); renderWallet(); } catch (err) {} return; }
  if (d.atab) { aTab = d.atab; openAuth(); return; }
  if (d.inst) { wInst = +d.inst; renderWallet(); return; }
  switch (t.id) {
    case 'place': placeBet(); return;
    case 'clear-slip': S.slip = []; S.slipMode = 'single'; renderSport(); renderSlip(); return;
    case 'slip-fab': $('#slip').classList.toggle('open'); return;
    case 'wgo': walletGo(); return;
    case 'wforfeit': walletGo(true); return;
    case 'wkeep': $('#wconfirm').innerHTML = ''; if ($('#wgo')) $('#wgo').hidden = false; return;
    case 'lsave-confirm': saveLimits(true); return;
    case 'lsave-cancel': $('#lconfirm').innerHTML = ''; $('#lex').value = '0'; return;
    case 'tfa-on': twofaOn(); return;
    case 'tfa-off': twofaOff(); return;
    case 'tfa-confirm': try { await run(() => B.twofaEnable($('#tfa-code').value.trim())); toast('2FA включена: при входе понадобится код из приложения', 'ok'); openAccount(); } catch (err) {} return;
    case 'tfa-disable': try { await run(() => B.twofaDisable($('#tfa-pass').value, $('#tfa-code').value.trim())); toast('2FA отключена. Вывод будет доступен через 24 часа.', 'ok'); openAccount(); } catch (err) {} return;
    case 'sess': sessionsBox(); return;
    case 'sess-kill': try { const r = await run(() => B.revokeOthers()); toast(`Завершено сеансов: ${r.revoked}`, 'ok'); sessionsBox(); } catch (err) {} return;
    case 'pwd': passwordBox(); return;
    case 'pw-save': { const nx = $('#pw-new').value; if (nx.length < 10) { toast('Новый пароль должен быть не короче 10 символов', 'err'); return; } try { await run(() => B.changePassword($('#pw-cur').value, nx)); toast('Пароль изменён. Другие сеансы завершены.', 'ok'); openAccount(); } catch (err) {} return; }
    case 'ago': doRegister(); return;
    case 'alog': doLogin(); return;
    case 'lsave': saveLimits(); return;
    case 'logout': await quiet(B.logout()); renderAcct(); closeModal(); toast('Вы вышли из аккаунта'); return;
    case 'frot': { const v = $('#fclient').value.trim(); try { await run(() => B.rotate(v)); toast('Сид сменён, предыдущий раскрыт', 'ok'); openFair(); } catch (err) {} return; }
  }
  switch (d.act) {
    case 'deposit': openWallet('deposit'); break; case 'withdraw': openWallet('withdraw'); break; case 'history': openWallet('history'); break;
    case 'register': S.user ? openAccount() : openAuth('register'); break; case 'login': openAuth('login'); break;
    case 'account': openAccount(); break;
    case 'limits': S.user ? openAccount() : (toast('Лимиты доступны после регистрации'), openAuth('register')); break;
    case 'fair': openFair(); break;
    case 'kyc': try { const r = await run(() => B.kycStart()); if (r.url) { location.href = r.url; break; } toast(r.message || (r.status === 'verified' ? 'Верификация уже пройдена' : 'Верификация на проверке'), 'ok'); } catch (err) {} break;
    case 'rules': openRules(); break;
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'stake') { S.stake = Math.max(0, +e.target.value || 0); const c = slipCalc(); const k = $$('#slip-body .kv b'); if (k.length) { k[k.length - 1].textContent = fmt(c.win); k[k.length - 2].textContent = fmt(c.total); } }
  if (e.target.id === 'gsearch') { S.q = e.target.value; renderCasino(); }
  if (e.target.id === 'accept') { S.accept = e.target.value; store.set('accept', S.accept); }
});
document.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.target.id === 'apass' || e.target.id === 'alogin') && $('#alog')) doLogin(); });

/* ================= boot ================= */
async function detectBackend() {
  try {
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch('/api/config', { signal: ctl.signal, credentials: 'same-origin' }); clearTimeout(timer);
    if (!r.ok || !r.headers.get('content-type')?.includes('json')) return null;
    const cfg = await r.json(); return cfg && cfg.currency ? cfg : null;
  } catch (e) { return null; }
}
(async () => {
  renderAcct();
  const cfg = await detectBackend();
  if (cfg) {
    B = ApiBackend; S.cfg = cfg; S.mode = 'api';
    $('#mode-note').innerHTML = cfg.sandbox ? '<b>Тестовый режим.</b> Платежи идут через песочницу, реальные деньги не списываются.' : '<b>18+</b> Играйте ответственно. Установите лимиты в профиле.';
    $('#footer-note').textContent = cfg.licenseText || 'Все исходы проверяемы, RTP и маржа указаны открыто.';
    if (cfg.turnstileSiteKey) { const sc = document.createElement('script'); sc.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'; sc.async = true; document.head.appendChild(sc); }
  }
  await quiet(B.init());
  renderAcct(); await loadEvents(); renderHomeLive(); route(); renderSlip(); applyReality();
  setInterval(async () => { if (B.mode === 'demo') demoDrift(); await loadEvents(); if (!$('#v-sport').hidden || !$('#v-home').hidden) { renderSport(); if (S.slip.length && S.slipTab === 'coupon' && document.activeElement?.id !== 'stake') renderSlip(); } }, B.mode === 'api' ? 5000 : 4000);
  if (B.mode === 'demo') setInterval(() => DemoBackend.settleDemoBets(), 1000);
  else setInterval(() => { if (S.user && document.visibilityState === 'visible') quiet(B.refresh()); }, 30000);
})();

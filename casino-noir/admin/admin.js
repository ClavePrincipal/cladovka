"use strict";
/* NOIR back office: monitoring and operations. All amounts from the API are minor units (tiyn). */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (m, cur = '₸') => (m == null ? '—' : (Number(m) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 }) + ' ' + cur);
const pct = v => (v == null ? '—' : (v * 100).toFixed(2).replace('.', ',') + '%');
const dt = v => (v ? new Date(v).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
function toast(msg, kind = '') { const t = document.createElement('div'); t.className = 'toast ' + kind; t.textContent = msg; $('#toasts').appendChild(t); setTimeout(() => t.remove(), 4500); }

const st = { csrf: null, me: null, view: 'dashboard', days: 7 };
async function api(method, url, body) {
  const r = await fetch('/api/admin' + url, { method, credentials: 'same-origin',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'noir', ...(st.csrf ? { 'x-csrf-token': st.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  let d = null; try { d = await r.json(); } catch (e) {}
  if (r.status === 401 && url !== '/login') { st.me = null; renderLogin(); }
  if (!r.ok) { const e = new Error(d?.message || 'Ошибка ' + r.status); e.code = d?.error; throw e; }
  return d;
}
const safe = async fn => { try { return await fn(); } catch (e) { toast(e.message, 'err'); return null; } };

const ROLE = { admin: 'Администратор', finance: 'Финансы', risk: 'Риск / AML', support: 'Поддержка', trader: 'Трейдер', viewer: 'Наблюдатель' };
const can = (...roles) => roles.includes(st.me?.role);
const NAV = [
  ['dashboard', 'Дашборд'], ['players', 'Игроки'], ['withdrawals', 'Выплаты', ['admin', 'finance']], ['payments', 'Платежи', ['admin', 'finance', 'risk', 'viewer']],
  ['aml', 'AML-алерты', ['admin', 'risk']], ['events', 'Линия'], ['audit', 'Аудит', ['admin']], ['staff', 'Сотрудники', ['admin']],
];
const chip = (s, map) => { const [cls, txt] = map[s] || ['', s]; return `<span class="chip-st ${cls}">${esc(txt)}</span>`; };
const PAY_ST = { expired: ['', 'Не оплачен'], chargeback: ['bad', 'Чарджбэк'], created: ['wait', 'Создан'], pending: ['wait', 'Ожидает'], succeeded: ['ok', 'Зачислен'], failed: ['bad', 'Отклонён'], review: ['wait', 'На проверке'], approved: ['wait', 'Отправлен'], rejected: ['bad', 'Отклонён'], paid: ['ok', 'Выплачен'] };
const USER_ST = { active: ['ok', 'Активен'], blocked: ['bad', 'Заблокирован'], closed: ['bad', 'Закрыт'] };
const KYC_ST = { none: ['', 'Нет'], pending: ['wait', 'На проверке'], verified: ['ok', 'Пройден'], rejected: ['bad', 'Отклонён'] };
const SEV = { high: ['bad', 'Высокий'], medium: ['wait', 'Средний'], low: ['', 'Низкий'] };
const RULES = { shared_instrument: 'Одна карта на нескольких аккаунтах', bonus_instrument_reuse: 'Повторный бонус на ту же карту', chargeback: 'Чарджбэк (отзыв платежа)',
  duplicate_identity: 'Один человек — несколько аккаунтов', self_excluded_duplicate: 'Новый аккаунт при самоисключении', large_deposit: 'Крупный депозит', large_withdrawal: 'Крупный вывод', low_turnover_withdrawal: 'Вывод без оборота', rapid_deposits: 'Частые депозиты', multi_account_ip: 'Мультиаккаунт по IP', big_win: 'Крупный выигрыш' };
const GAME = { slot: 'Слоты', roulette: 'Рулетка', crash: 'Crash', dice: 'Dice', mines: 'Мины' };

/* ---------- login ---------- */
function renderLogin() {
  $('#app').innerHTML = `<div class="login"><form id="lf" autocomplete="on">
    <span class="logo">NOIR<i>back office</i></span>
    <div class="field"><label for="le">E-mail</label><input class="inp" id="le" type="email" autocomplete="username" required style="font-family:var(--font-ui)"></div>
    <div class="field"><label for="lp">Пароль</label><input class="inp" id="lp" type="password" autocomplete="current-password" required></div>
    <div class="field"><label for="lt">Код из приложения 2FA</label><input class="inp" id="lt" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></div>
    <button class="btn gold big block" type="submit">Войти</button>
    <p class="muted" style="margin:0;font-size:12px">Доступ только для сотрудников. Все действия записываются в журнал аудита.</p></form></div>`;
  $('#lf').onsubmit = async e => {
    e.preventDefault();
    const r = await safe(() => api('POST', '/login', { email: $('#le').value, password: $('#lp').value, totp: $('#lt').value }));
    if (r) { st.csrf = r.csrf; st.me = r.staff; shell(); }
  };
}

/* ---------- shell ---------- */
function shell() {
  $('#app').innerHTML = `<div class="bo"><nav class="bo-side"><span class="logo">NOIR<i>office</i></span>
    ${NAV.filter(n => !n[2] || can(...n[2])).map(([k, t]) => `<a href="#${k}" data-v="${k}">${t}<span id="b-${k}"></span></a>`).join('')}
    <div class="who"><b style="color:var(--fg)">${esc(st.me.name)}</b><span>${esc(ROLE[st.me.role])}</span><button class="btn ghost sm" type="button" id="out">Выйти</button></div></nav>
    <main class="bo-main" id="main"></main></div>`;
  $('#out').onclick = async () => { await safe(() => api('POST', '/logout', {})); st.me = null; renderLogin(); };
  route();
}
function route() {
  if (!st.me) return;
  const v = location.hash.slice(1) || 'dashboard'; st.view = VIEWS[v] ? v : 'dashboard';
  $$('.bo-side a').forEach(a => a.classList.toggle('on', a.dataset.v === st.view));
  VIEWS[st.view]();
}
window.addEventListener('hashchange', route);
const main = html => { $('#main').innerHTML = html; };
const table = (cols, rows, rowAttr = () => '') => `<div class="tbl-wrap"><table class="tbl"><thead><tr>${cols.map(c => `<th class="${c.n ? 'n' : ''}">${c.t}</th>`).join('')}</tr></thead>
  <tbody>${rows.length ? rows.map(r => `<tr ${rowAttr(r)}>${cols.map(c => `<td class="${c.n ? 'n' : ''}">${c.f(r)}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${cols.length}" class="muted" style="text-align:center;padding:24px">Нет данных</td></tr>`}</tbody></table></div>`;
function openModal(html) { $('#dialog').innerHTML = html; $('#modal').hidden = false; }
function closeModal() { $('#modal').hidden = true; $('#dialog').innerHTML = ''; }
$('#modal').addEventListener('click', e => { if (e.target.id === 'modal' || e.target.closest('.close')) closeModal(); });
const mhead = t => `<div class="d-head"><h3>${t}</h3><button class="close" type="button" aria-label="Закрыть">×</button></div>`;

/* ---------- dashboard ---------- */
async function dashboard() {
  main(`<div class="bo-head"><h1>Дашборд</h1><div class="pills">${[1, 7, 30, 90].map(d => `<button class="pill ${st.days === d ? 'on' : ''}" type="button" data-days="${d}">${d === 1 ? 'Сутки' : d + ' дн.'}</button>`).join('')}</div></div><div id="dash" class="muted">Загрузка…</div>`);
  $$('[data-days]').forEach(b => b.onclick = () => { st.days = +b.dataset.days; dashboard(); });
  const d = await safe(() => api('GET', '/dashboard?days=' + st.days)); if (!d) return;
  const m = d.money, o = d.ops;
  $('#b-withdrawals') && ($('#b-withdrawals').innerHTML = +o.withdrawals_review ? `<span class="badge gold">${o.withdrawals_review}</span>` : '');
  $('#b-aml') && ($('#b-aml').innerHTML = +o.aml_open ? `<span class="badge">${o.aml_open}</span>` : '');
  const k = (label, val, sub = '', cls = '') => `<div class="kpi ${cls}"><small>${label}</small><b>${val}</b>${sub ? `<span>${sub}</span>` : ''}</div>`;
  $('#dash').outerHTML = `<div style="display:flex;flex-direction:column;gap:20px">
    ${d.ledgerOk ? '' : `<div class="note" style="border-color:var(--loss)"><b style="color:var(--loss)">Расхождение в балансах!</b> ${d.ledgerMismatches.length} счетов не совпадают с журналом операций. Сообщите разработчикам.</div>`}
    <div class="kpis">
      ${k('NGR (чистый доход)', money(m.ngr), 'GGR минус бонусы и кэшбэк', m.ngr >= 0 ? 'good' : 'warn')}
      ${k('GGR казино', money(m.ggr_casino), 'оборот ' + money(m.casino_stake))}
      ${k('GGR спорт', money(m.ggr_sport), 'оборот ' + money(m.sport_stake))}
      ${k('Депозиты', money(m.deposits))}
      ${k('Выплаты', money(m.withdrawals))}
      ${k('Активные игроки', (+m.active_players).toLocaleString('ru-RU'), `новых: ${d.players.new_players} · всего: ${d.players.total_players}`)}
      ${k('Деньги игроков на счетах', money(o.player_liability), 'обязательства оператора')}
      ${k('Выводы на проверке', o.withdrawals_review, money(o.withdrawals_review_sum), +o.withdrawals_review ? 'warn' : '')}
      ${k('AML-алерты', o.aml_open, `высокий риск: ${o.aml_high}`, +o.aml_high ? 'warn' : '')}
      ${k('KYC на проверке', d.players.kyc_pending)}
      ${k('Открытые ставки на спорт', o.sport_open_bets, money(o.sport_open_stake))}
      ${k('Целостность журнала', d.ledgerOk ? 'OK' : 'Ошибка', 'балансы = сумма операций', d.ledgerOk ? 'good' : 'warn')}
    </div>
    <div class="panel"><div class="panel-h"><h2>Игры: фактический и теоретический RTP</h2><span class="muted" style="font-size:12px">На малом обороте фактический RTP сильно колеблется — это нормально</span></div>
      ${table([{ t: 'Игра', f: g => GAME[g.game] || g.game }, { t: 'Раундов', n: 1, f: g => g.rounds.toLocaleString('ru-RU') }, { t: 'Игроков', n: 1, f: g => g.players },
        { t: 'Оборот', n: 1, f: g => money(g.stake) }, { t: 'Выплачено', n: 1, f: g => money(g.payout) }, { t: 'GGR', n: 1, f: g => `<span class="${g.stake - g.payout >= 0 ? 'pos' : 'neg'}">${money(g.stake - g.payout)}</span>` },
        { t: 'RTP факт', n: 1, f: g => pct(g.rtp_actual) }, { t: 'RTP теория', n: 1, f: g => pct(g.rtp_theoretical) }], d.games)}</div>
    <div class="panel"><div class="panel-h"><h2>По дням</h2></div>
      ${table([{ t: 'День', f: r => new Date(r.day).toLocaleDateString('ru-RU') }, { t: 'GGR', n: 1, f: r => `<span class="${r.ggr >= 0 ? 'pos' : 'neg'}">${money(r.ggr)}</span>` }, { t: 'Депозиты', n: 1, f: r => money(r.deposits) }], d.daily.slice().reverse())}</div>
  </div>`;
}

/* ---------- players ---------- */
async function players(q = '') {
  main(`<div class="bo-head"><h1>Игроки</h1><form id="ps" style="display:flex;gap:8px;flex:1;max-width:520px"><input class="inp" id="pq" placeholder="ID игрока, e-mail или телефон (точное совпадение)" value="${esc(q)}" style="font-family:var(--font-ui)"><button class="btn gold" type="submit">Найти</button></form></div><div class="panel" id="pl"><div class="empty">Загрузка…</div></div>`);
  $('#ps').onsubmit = e => { e.preventDefault(); players($('#pq').value.trim()); };
  const rows = await safe(() => api('GET', '/players' + (q ? '?q=' + encodeURIComponent(q) : ''))); if (!rows) return;
  $('#pl').innerHTML = table([{ t: 'ID', f: u => `<span class="num">${u.publicId}</span>` }, { t: 'Контакт', f: u => esc(u.email || u.phone || '—') }, { t: 'Статус', f: u => chip(u.status, USER_ST) },
    { t: 'KYC', f: u => chip(u.kycStatus, KYC_ST) }, { t: 'Страна', f: u => esc(u.country || '—') }, { t: 'Баланс', n: 1, f: u => money(u.balance) }, { t: 'Регистрация', f: u => dt(u.createdAt) }],
    rows, u => `class="click" data-player="${u.id}"`);
}
async function playerCard(id) {
  const d = await safe(() => api('GET', '/players/' + id)); if (!d) return;
  const p = d.player, s = d.stats;
  const tabs = [['ledger', 'Операции'], ['rounds', 'Игры'], ['bets', 'Спорт'], ['payments', 'Платежи'], ['alerts', 'AML'], ['sessions', 'Сессии'], ['bonus', 'Бонусы']];
  openModal(mhead(`Игрок ${p.publicId}`) + `<div class="d-body">
    <div class="grid2"><div class="note" style="display:grid;grid-template-columns:auto 1fr;gap:4px 12px">
      <span>E-mail</span><b>${esc(p.email || '—')}</b><span>Телефон</span><b>${esc(p.phone || '—')}</b><span>Дата рождения</span><b>${esc(p.birthDate || '—')}</b>
      <span>Статус</span><b>${chip(p.status, USER_ST)}</b><span>KYC</span><b>${chip(p.kycStatus, KYC_ST)}</b><span>Страна / IP</span><b>${esc(p.country || '—')} · ${esc(p.lastIp || p.regIp || '—')}</b>
      <span>Регистрация</span><b>${dt(p.createdAt)}</b><span>Последний вход</span><b>${dt(p.lastLoginAt)}</b>
      <span>2FA</span><b>${p.totpEnabled ? 'включена' : 'нет'}</b><span>Лимит ставок на спорт</span><b>${p.stakeFactor >= 1 ? 'обычный' : p.stakeFactor > 0 ? '×' + p.stakeFactor : '<span class="neg">спорт закрыт</span>'}</b>
      ${p.securityHoldUntil && new Date(p.securityHoldUntil) > new Date() ? `<span>Вывод заблокирован до</span><b>${dt(p.securityHoldUntil)}</b>` : ''}</div>
    <div class="kpis" style="grid-template-columns:1fr 1fr">
      <div class="kpi"><small>Баланс</small><b>${money(d.balances.cash)}</b><span>бонус ${money(d.balances.bonus)} · на выводе ${money(d.balances.withdraw_hold)}</span></div>
      <div class="kpi"><small>Доход с игрока</small><b class="${s.stake - s.payout >= 0 ? 'pos' : 'neg'}">${money(s.stake - s.payout)}</b><span>оборот ${money(s.stake)}</span></div>
      <div class="kpi"><small>Депозиты</small><b>${money(s.deposits)}</b></div><div class="kpi"><small>Выводы</small><b>${money(s.withdrawals)}</b></div></div></div>
    <div class="row-actions">
      ${can('admin', 'risk', 'support') ? `${p.status === 'active' ? `<button class="btn ghost sm" data-pstatus="blocked">Заблокировать</button>` : `<button class="btn ghost sm" data-pstatus="active">Разблокировать</button>`}
        ${can('admin', 'risk') ? '<button class="btn ghost sm" data-pkyc="verified">KYC: подтвердить</button>' : ''}<button class="btn ghost sm" data-pkyc="rejected">KYC: отклонить</button>` : ''}
      ${can('admin', 'risk', 'trader') ? `<button class="btn ghost sm" data-pstake>Лимит ставок на спорт</button>` : ''}
      ${can('admin') ? `<button class="btn ghost sm" data-padjust>Корректировка баланса</button>` : ''}
    </div>
    <div class="tabs">${tabs.map(([k, t], i) => `<button type="button" data-ptab="${k}" class="${i ? '' : 'on'}">${t}</button>`).join('')}</div><div id="ptab"></div></div>`);
  const T = {
    ledger: () => table([{ t: 'Время', f: r => dt(r.created_at) }, { t: 'Тип', f: r => esc(r.type) }, { t: 'Счёт', f: r => esc(r.account_kind) }, { t: 'Сумма', n: 1, f: r => `<span class="${r.amount > 0 ? 'pos' : ''}">${money(r.amount)}</span>` }, { t: 'Остаток', n: 1, f: r => money(r.balance_after) }, { t: 'Ссылка', f: r => esc((r.ref_type || '') + (r.ref_id ? ' #' + r.ref_id : '')) }], d.ledger),
    rounds: () => table([{ t: 'Время', f: r => dt(r.created_at) }, { t: 'Игра', f: r => GAME[r.game] || r.game }, { t: 'Ставка', n: 1, f: r => money(r.bet) }, { t: 'Выплата', n: 1, f: r => money(r.payout) }, { t: 'Nonce', n: 1, f: r => r.nonce }, { t: 'Статус', f: r => esc(r.status) }], d.rounds),
    bets: () => table([{ t: 'Время', f: r => dt(r.created_at) }, { t: 'Тип', f: r => r.kind === 'express' ? 'Экспресс' : 'Одинар' }, { t: 'Ставка', n: 1, f: r => money(r.stake) }, { t: 'Кф', n: 1, f: r => (+r.odds).toFixed(2) }, { t: 'Статус', f: r => esc(r.status) }, { t: 'Выплата', n: 1, f: r => money(r.payout) }], d.sportBets),
    payments: () => table([{ t: 'Время', f: r => dt(r.created_at) }, { t: 'Тип', f: r => r.direction === 'deposit' ? 'Депозит' : 'Вывод' }, { t: 'Способ', f: r => esc(r.provider + ' / ' + r.method) }, { t: 'Сумма', n: 1, f: r => money(r.amount) }, { t: 'Статус', f: r => chip(r.status, PAY_ST) }], d.payments),
    alerts: () => table([{ t: 'Время', f: r => dt(r.created_at) }, { t: 'Правило', f: r => esc(RULES[r.rule] || r.rule) }, { t: 'Риск', f: r => chip(r.severity, SEV) }, { t: 'Статус', f: r => esc(r.status) }, { t: 'Детали', f: r => `<pre class="json">${esc(JSON.stringify(r.details))}</pre>` }], d.alerts),
    sessions: () => table([{ t: 'Начало', f: r => dt(r.created_at) }, { t: 'Активность', f: r => dt(r.last_seen) }, { t: 'IP', f: r => esc(r.ip || '—') }, { t: 'Устройство', f: r => esc((r.user_agent || '').slice(0, 60)) }, { t: 'Статус', f: r => r.revoked_at ? 'Завершена' : new Date(r.expires_at) < new Date() ? 'Истекла' : 'Активна' }], d.sessions),
    bonus: () => table([{ t: 'Создан', f: r => dt(r.created_at) }, { t: 'Сумма', n: 1, f: r => money(r.amount) }, { t: 'Отыграно', n: 1, f: r => `${money(r.wagered)} / ${money(r.wager_req)}` }, { t: 'Статус', f: r => esc(r.status) }, { t: 'До', f: r => dt(r.expires_at) }], d.bonuses),
  };
  $('#ptab').innerHTML = T.ledger();
  $$('[data-ptab]').forEach(b => b.onclick = () => { $$('[data-ptab]').forEach(x => x.classList.toggle('on', x === b)); $('#ptab').innerHTML = T[b.dataset.ptab](); });
  $$('[data-pstatus]').forEach(b => b.onclick = () => reasonDialog(b.textContent, async reason => { if (await safe(() => api('POST', `/players/${id}/status`, { status: b.dataset.pstatus, reason }))) { toast('Статус изменён', 'ok'); playerCard(id); } }));
  $$('[data-pkyc]').forEach(b => b.onclick = async () => { if (await safe(() => api('POST', `/players/${id}/kyc`, { status: b.dataset.pkyc }))) { toast('KYC обновлён', 'ok'); playerCard(id); } });
  const sf = $('[data-pstake]'); if (sf) sf.onclick = () => {
    openModal(mhead('Лимит ставок на спорт') + `<form class="d-body" id="sff"><p class="muted" style="margin:0">Для игроков-арбитражников и злоупотребляющих бонусами. 1 — без ограничений, 0,1 — максимальная ставка в 10 раз меньше, 0 — ставки на спорт закрыты.</p>
      <div class="field"><label for="sfv">Коэффициент от 0 до 1</label><input class="inp" id="sfv" type="number" min="0" max="1" step="0.05" value="${Math.min(1, p.stakeFactor)}" required></div>
      <div class="field"><label for="sfr">Причина (в журнал аудита)</label><input class="inp" id="sfr" required minlength="3" style="font-family:var(--font-ui)"></div>
      <button class="btn gold block" type="submit">Сохранить</button></form>`);
    $('#sff').onsubmit = async e => { e.preventDefault(); if (await safe(() => api('POST', `/players/${id}/stake-factor`, { factor: +$('#sfv').value, reason: $('#sfr').value }))) { toast('Лимит обновлён', 'ok'); playerCard(id); } };
  };
  const adj = $('[data-padjust]'); if (adj) adj.onclick = () => {
    openModal(mhead('Корректировка баланса') + `<form class="d-body" id="af">
    <div class="field"><label for="aa">Сумма, ₸ (минус — списание)</label><input class="inp" id="aa" type="number" step="0.01" required></div>
    <div class="field"><label for="ar">Причина (попадёт в журнал аудита)</label><input class="inp" id="ar" required minlength="5" style="font-family:var(--font-ui)"></div>
    <button class="btn gold block" type="submit">Провести</button></form>`);
    $('#af').onsubmit = async e => { e.preventDefault();
      if (await safe(() => api('POST', `/players/${id}/adjust`, { amount: Math.round(+$('#aa').value * 100), reason: $('#ar').value }))) { toast('Корректировка проведена', 'ok'); playerCard(id); } };
  };
}
function reasonDialog(title, done) {
  openModal(mhead(esc(title)) + `<form class="d-body" id="rf"><div class="field"><label for="rr">Причина (обязательно, попадёт в журнал аудита)</label><input class="inp" id="rr" required minlength="3" style="font-family:var(--font-ui)"></div><button class="btn gold block" type="submit">Подтвердить</button></form>`);
  $('#rf').onsubmit = e => { e.preventDefault(); done($('#rr').value); };
}

/* ---------- payments ---------- */
async function withdrawals() {
  main(`<div class="bo-head"><h1>Выплаты на проверке</h1></div><div class="note">Небольшие выплаты чистым верифицированным игрокам уходят автоматически — здесь только те, что требуют решения. Крупные суммы одобряют два разных сотрудника. Вывод возможен только на карту пополнения, это проверяет система. Перед одобрением проверьте AML-алерты игрока.</div><div class="panel" id="wl"><div class="empty">Загрузка…</div></div>`);
  const rows = await safe(() => api('GET', '/payments?direction=withdrawal&status=review')); if (!rows) return;
  $('#wl').innerHTML = table([{ t: 'Создана', f: r => dt(r.created_at) }, { t: 'Игрок', f: r => `<a href="#" data-player="${r.user_id}" class="num" style="color:var(--gold)">${r.public_id}</a>` }, { t: 'KYC', f: r => chip(r.kyc_status, KYC_ST) },
    { t: 'Куда', f: r => `<span class="num">${esc(r.instrument || r.method)}</span>` }, { t: 'Сумма', n: 1, f: r => money(r.amount) },
    { t: 'Одобрения', f: r => r.approvals?.length ? `<span class="chip-st wait">1 из 2</span>` : '' },
    { t: '', f: r => `<div class="row-actions"><button class="btn gold sm" data-wd="${r.id}" data-dec="approve">Одобрить</button><button class="btn ghost sm" data-wd="${r.id}" data-dec="reject">Отклонить</button></div>` }], rows);
}
async function payments() {
  main(`<div class="bo-head"><h1>Платежи</h1><div class="pills"><button class="pill on" data-pd="">Все</button><button class="pill" data-pd="deposit">Депозиты</button><button class="pill" data-pd="withdrawal">Выводы</button></div></div><div class="panel" id="pyl"></div>`);
  const load = async dir => { const rows = await safe(() => api('GET', '/payments' + (dir ? '?direction=' + dir : ''))); if (!rows) return;
    $('#pyl').innerHTML = table([{ t: 'Время', f: r => dt(r.created_at) }, { t: 'Игрок', f: r => `<a href="#" data-player="${r.user_id}" class="num" style="color:var(--gold)">${r.public_id}</a>` }, { t: 'Тип', f: r => r.direction === 'deposit' ? 'Депозит' : 'Вывод' },
      { t: 'Провайдер', f: r => esc(r.provider + ' / ' + r.method) }, { t: 'Референс', f: r => `<span class="num" style="font-size:11px">${esc(r.provider_ref || '—')}</span>` }, { t: 'Сумма', n: 1, f: r => money(r.amount) }, { t: 'Статус', f: r => chip(r.status, PAY_ST) }], rows); };
  $$('[data-pd]').forEach(b => b.onclick = () => { $$('[data-pd]').forEach(x => x.classList.toggle('on', x === b)); load(b.dataset.pd); });
  load('');
}

/* ---------- AML ---------- */
async function aml() {
  main(`<div class="bo-head"><h1>AML-алерты</h1></div><div class="panel" id="al"></div>`);
  const rows = await safe(() => api('GET', '/aml')); if (!rows) return;
  $('#al').innerHTML = table([{ t: 'Время', f: r => dt(r.created_at) }, { t: 'Игрок', f: r => `<a href="#" data-player="${r.user_id}" class="num" style="color:var(--gold)">${r.public_id}</a>` }, { t: 'Правило', f: r => esc(RULES[r.rule] || r.rule) },
    { t: 'Риск', f: r => chip(r.severity, SEV) }, { t: 'Детали', f: r => `<pre class="json">${esc(JSON.stringify(r.details))}</pre>` }, { t: '', f: r => `<button class="btn ghost sm" data-aml="${r.id}">Закрыть</button>` }], rows);
}

/* ---------- sportsbook ---------- */
async function events() {
  const tr = can('admin', 'trader');
  main(`<div class="bo-head"><h1>Линия</h1>${tr ? '<button class="btn gold" type="button" id="evnew">Новое событие</button>' : ''}</div><div class="panel" id="el"></div>`);
  const rows = await safe(() => api('GET', '/events')); if (!rows) return;
  const ST = { scheduled: ['', 'Линия'], live: ['bad', 'LIVE'], suspended: ['wait', 'Приостановлено'], finished: ['ok', 'Завершено'], cancelled: ['', 'Отменено'] };
  $('#el').innerHTML = table([{ t: 'Начало', f: e => dt(e.starts_at) }, { t: 'Событие', f: e => `<b>${esc(e.home)} — ${esc(e.away)}</b><br><span class="muted" style="font-size:12px">${esc(e.league)}</span>` },
    { t: 'Статус', f: e => chip(e.status, ST) }, { t: 'Счёт', f: e => e.status === 'live' ? `${e.score.join(':')} · ${esc(e.live_clock || '')}` : '' },
    { t: '1 / X / 2', n: 1, f: e => e.odds.map(o => o > 1 ? (+o).toFixed(2) : '—').join(' / ') }, { t: 'Маржа', n: 1, f: e => pct(e.margin) },
    { t: 'Открытых ставок', n: 1, f: e => `${e.open_bets} · ${money(e.open_stake)}` },
    { t: '', f: e => tr && !['finished', 'cancelled'].includes(e.status) ? `<button class="btn ghost sm" data-ev="${e.id}">Управлять</button>` : '' }], rows);
  $$('[data-ev]').forEach(b => b.onclick = () => eventDialog(rows.find(e => e.id === +b.dataset.ev)));
  const nb = $('#evnew'); if (nb) nb.onclick = () => eventDialog(null);
}
function eventDialog(e) {
  const p = e ? e.probs : [0.45, 0.27, 0.28];
  openModal(mhead(e ? esc(`${e.home} — ${e.away}`) : 'Новое событие') + `<form class="d-body" id="evf">
    ${e ? '' : `<div class="grid2"><div class="field"><label for="es">Вид спорта</label><select class="inp" id="es">${['football', 'hockey', 'tennis', 'basket', 'esports', 'mma'].map(x => `<option>${x}</option>`).join('')}</select></div>
      <div class="field"><label for="el2">Лига</label><input class="inp" id="el2" required style="font-family:var(--font-ui)"></div>
      <div class="field"><label for="eh">Хозяева</label><input class="inp" id="eh" required style="font-family:var(--font-ui)"></div><div class="field"><label for="ea">Гости</label><input class="inp" id="ea" required style="font-family:var(--font-ui)"></div>
      <div class="field"><label for="et">Начало</label><input class="inp" id="et" type="datetime-local" required></div></div>`}
    <div class="grid2"><div class="field"><label>Вероятности П1 / X / П2 (сумма = 1, X = 0 если ничьей нет)</label><div style="display:flex;gap:6px">${p.map((v, i) => `<input class="inp" id="ep${i}" type="number" step="0.01" min="0" max="1" value="${(+v).toFixed(2)}">`).join('')}</div></div>
    <div class="field"><label for="em">Маржа (0.05 = 5%)</label><input class="inp" id="em" type="number" step="0.005" min="0" max="0.3" value="${e ? e.margin : 0.05}"></div></div>
    ${e ? `<div class="grid2"><div class="field"><label for="est">Статус</label><select class="inp" id="est">${['scheduled', 'live', 'suspended'].map(x => `<option ${x === e.status ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label>Счёт и время матча</label><div style="display:flex;gap:6px"><input class="inp" id="es0" type="number" min="0" value="${e.score[0]}"><input class="inp" id="es1" type="number" min="0" value="${e.score[1]}"><input class="inp" id="eclk" value="${esc(e.live_clock || '')}" placeholder="63′" style="font-family:var(--font-ui)"></div></div></div>` : ''}
    <button class="btn gold block" type="submit">${e ? 'Обновить линию' : 'Создать'}</button>
    ${e ? `<div class="note">Расчёт события необратим. Все ставки на него будут рассчитаны автоматически.</div><div class="row-actions"><button class="btn ghost sm" type="button" data-settle="0">Итог: П1</button>${+e.odds[1] > 1 ? '<button class="btn ghost sm" type="button" data-settle="1">Итог: X</button>' : ''}<button class="btn ghost sm" type="button" data-settle="2">Итог: П2</button><button class="btn ghost sm" type="button" data-settle="cancel">Отменить (возврат)</button></div>` : ''}
  </form>`);
  $('#evf').onsubmit = async ev => {
    ev.preventDefault();
    const probs = [0, 1, 2].map(i => +$('#ep' + i).value), margin = +$('#em').value;
    const r = e ? await safe(() => api('PATCH', '/events/' + e.id, { probs, margin, status: $('#est').value, score: [+$('#es0').value, +$('#es1').value], clock: $('#eclk').value }))
      : await safe(() => api('POST', '/events', { sport: $('#es').value, league: $('#el2').value, home: $('#eh').value, away: $('#ea').value, startsAt: new Date($('#et').value).toISOString(), probs, margin }));
    if (r) { toast('Сохранено', 'ok'); closeModal(); events(); }
  };
  $$('[data-settle]').forEach(b => b.onclick = async () => {
    const v = b.dataset.settle;
    const r = await safe(() => api('POST', `/events/${e.id}/settle`, v === 'cancel' ? { cancel: true } : { result: +v }));
    if (r) { toast(`Событие рассчитано, ставок: ${r.settledBets}`, 'ok'); closeModal(); events(); }
  });
}

/* ---------- audit & staff ---------- */
async function audit() {
  main(`<div class="bo-head"><h1>Журнал аудита</h1><span class="muted">Записи нельзя изменить или удалить</span></div><div class="panel" id="au"></div>`);
  const rows = await safe(() => api('GET', '/audit')); if (!rows) return;
  $('#au').innerHTML = table([{ t: 'Время', f: r => dt(r.created_at) }, { t: 'Кто', f: r => esc(r.actor_type === 'staff' ? r.staff_email || 'staff #' + r.actor_id : r.actor_type + (r.actor_id ? ' #' + r.actor_id : '')) },
    { t: 'Действие', f: r => esc(r.action) }, { t: 'Объект', f: r => esc(r.target_type ? r.target_type + ' #' + r.target_id : '') }, { t: 'IP', f: r => esc(r.ip || '') }, { t: 'Детали', f: r => `<pre class="json">${esc(JSON.stringify(r.details))}</pre>` }], rows);
}
async function staff() {
  main(`<div class="bo-head"><h1>Сотрудники</h1><button class="btn gold" type="button" id="snew">Добавить</button></div><div class="panel" id="sl"></div>`);
  const rows = await safe(() => api('GET', '/staff')); if (!rows) return;
  $('#sl').innerHTML = table([{ t: 'Имя', f: r => esc(r.name) }, { t: 'E-mail', f: r => esc(r.email) }, { t: 'Роль', f: r => esc(ROLE[r.role]) }, { t: 'Статус', f: r => r.active ? chip('active', USER_ST) : chip('blocked', USER_ST) },
    { t: '', f: r => `<button class="btn ghost sm" data-sact="${r.id}" data-on="${r.active ? 0 : 1}">${r.active ? 'Отключить' : 'Включить'}</button>` }], rows);
  $$('[data-sact]').forEach(b => b.onclick = async () => { if (await safe(() => api('POST', `/staff/${b.dataset.sact}/active`, { active: b.dataset.on === '1' }))) staff(); });
  $('#snew').onclick = () => {
    openModal(mhead('Новый сотрудник') + `<form class="d-body" id="sf"><div class="grid2"><div class="field"><label for="sn">Имя</label><input class="inp" id="sn" required style="font-family:var(--font-ui)"></div>
      <div class="field"><label for="se">E-mail</label><input class="inp" id="se" type="email" required style="font-family:var(--font-ui)"></div>
      <div class="field"><label for="sr">Роль</label><select class="inp" id="sr">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
      <div class="field"><label for="sp">Временный пароль (от 12 символов)</label><input class="inp" id="sp" type="text" minlength="12" required></div></div>
      <button class="btn gold block" type="submit">Создать</button></form>`);
    $('#sf').onsubmit = async e => {
      e.preventDefault();
      const r = await safe(() => api('POST', '/staff', { name: $('#sn').value, email: $('#se').value, role: $('#sr').value, password: $('#sp').value })); if (!r) return;
      openModal(mhead('Сотрудник создан') + `<div class="d-body"><p class="muted" style="margin:0">Передайте сотруднику секрет 2FA защищённым каналом. Он показывается один раз. Его нужно добавить в Google Authenticator, 1Password или аналог.</p>
        <div class="cred"><span>Секрет</span>${esc(r.totpSecret)}<span>URI</span><span class="num" style="word-break:break-all;font-size:11px;color:var(--fg)">${esc(r.otpauth)}</span></div></div>`);
      staff();
    };
  };
}

const VIEWS = { dashboard, players: () => players(), withdrawals, payments, aml, events, audit, staff };

document.addEventListener('click', async e => {
  const pl = e.target.closest('[data-player]'); if (pl) { e.preventDefault(); playerCard(pl.dataset.player); return; }
  const wd = e.target.closest('[data-wd]');
  if (wd) { const dec = wd.dataset.dec; reasonDialog(dec === 'approve' ? 'Одобрить вывод' : 'Отклонить вывод', async note => { const r = await safe(() => api('POST', `/withdrawals/${wd.dataset.wd}/${dec}`, { note })); if (r) { toast(r.needsSecondApproval ? 'Одобрение записано. Крупная сумма: нужно одобрение второго сотрудника.' : dec === 'approve' ? 'Выплата отправлена провайдеру' : 'Вывод отклонён, деньги возвращены игроку', 'ok'); closeModal(); withdrawals(); } }); return; }
  const a = e.target.closest('[data-aml]');
  if (a) { reasonDialog('Закрыть алерт', async note => { if (await safe(() => api('POST', `/aml/${a.dataset.aml}/close`, { note }))) { toast('Алерт закрыт', 'ok'); closeModal(); aml(); } }); }
});

(async () => {
  const r = await fetch('/api/admin/me', { credentials: 'same-origin' }).then(x => x.json()).catch(() => null);
  if (r?.staff) { st.csrf = r.csrf; st.me = r.staff; shell(); } else renderLogin();
})();

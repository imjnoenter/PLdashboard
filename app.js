'use strict';

/* ============================================================
   CONFIG — edit these for your deployment
   ============================================================ */
const CONFIG = {
  // Paste your deployed Google Apps Script Web App URL here.
  // Until you do, the app runs in local demo mode (data stays
  // only in this browser) so you can preview the UI.
  APPS_SCRIPT_URL: 'https://script.google.com/macros/s/AKfycby0ErZjPh5qUK180FeiFmUKtCma1U9BmqJy_KsrL0JJXQCh_ZIgMiI6u2cv07UVLRyy/exec',

  // Fallback USD->THB rate, used if the live rate can't be fetched
  USD_TO_THB_DEFAULT: 35,

  // Keyless, CORS-friendly FX endpoint (rates relative to USD)
  FX_API_URL: 'https://open.er-api.com/v6/latest/USD',
};

const DEMO_MODE = !CONFIG.APPS_SCRIPT_URL;

const COLORS = {
  profit: '#4fae84',
  loss: '#e8677d',
  grid: '#e8dcef',
};

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/* ============================================================
   STATE
   ============================================================ */
const state = {
  pin: localStorage.getItem('mulan_pin') || '',
  entries: new Map(),   // 'YYYY-MM-DD' -> number (USD)
  goals: new Map(),     // 'YYYY-MM' -> number (USD)
  currency: localStorage.getItem('mulan_currency') || 'USD',
  fxRate: null,
  fxUpdated: null,
  activeTab: 'week',
  offsets: { week: 0, month: 0, year: 0 },
  calc: { equity: '', pnl: '', pct: '' },
};

/* ============================================================
   DATE UTILITIES
   ============================================================ */
function pad2(n) { return String(n).padStart(2, '0'); }
function isoDate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function isoMonth(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`; }
function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function isWeekday(d) { const day = d.getDay(); return day >= 1 && day <= 5; }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }

function parseISODate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function mondayOf(d) {
  const x = startOfDay(d);
  const day = x.getDay(); // 0=Sun..6=Sat
  const diff = (day === 0) ? -6 : (1 - day);
  x.setDate(x.getDate() + diff);
  return x;
}

function weekdaysOfWeek(monday) {
  return [0, 1, 2, 3, 4].map(i => addDays(monday, i));
}

function weekdaysInMonth(year, monthIndex) {
  const days = [];
  const d = new Date(year, monthIndex, 1);
  while (d.getMonth() === monthIndex) {
    if (isWeekday(d)) days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function formatWeekLabel(monday, friday) {
  const mShort = MONTH_NAMES[monday.getMonth()].slice(0, 3);
  const fShort = MONTH_NAMES[friday.getMonth()].slice(0, 3);
  if (monday.getMonth() === friday.getMonth()) {
    return `${mShort} ${monday.getDate()}–${friday.getDate()}, ${friday.getFullYear()}`;
  }
  if (monday.getFullYear() === friday.getFullYear()) {
    return `${mShort} ${monday.getDate()} – ${fShort} ${friday.getDate()}, ${friday.getFullYear()}`;
  }
  return `${mShort} ${monday.getDate()}, ${monday.getFullYear()} – ${fShort} ${friday.getDate()}, ${friday.getFullYear()}`;
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ============================================================
   GOAL MATH
   ============================================================ */
function dailyGoalRate(date) {
  const goal = state.goals.get(isoMonth(date));
  if (goal == null) return 0;
  const wdays = weekdaysInMonth(date.getFullYear(), date.getMonth()).length;
  return wdays > 0 ? goal / wdays : 0;
}

function computeWeekTotalAndGoal(offset) {
  const today = startOfDay(new Date());
  const monday = addDays(mondayOf(today), offset * 7);
  const days = weekdaysOfWeek(monday);
  let total = 0;
  days.forEach(d => { const v = state.entries.get(isoDate(d)); if (v != null) total += v; });
  const goal = days.reduce((s, d) => s + dailyGoalRate(d), 0);
  return { total, goal, days, monday };
}

function computeMonthTotalAndGoal(offset) {
  const today = startOfDay(new Date());
  const base = addMonths(new Date(today.getFullYear(), today.getMonth(), 1), offset);
  const monthKey = isoMonth(base);
  const days = weekdaysInMonth(base.getFullYear(), base.getMonth());
  let total = 0;
  days.forEach(d => { const v = state.entries.get(isoDate(d)); if (v != null) total += v; });
  const goal = state.goals.get(monthKey) || 0;
  return { total, goal, days, monthKey, base };
}

function computeActivePeriodTotalAndGoal() {
  if (state.activeTab === 'week') return computeWeekTotalAndGoal(state.offsets.week);
  if (state.activeTab === 'month') return computeMonthTotalAndGoal(state.offsets.month);
  return { total: 0, goal: 0 };
}

function computeStats(entries) {
  if (entries.length === 0) {
    return { totalDays: 0, winDays: 0, lossDays: 0, winRate: 0, best: null, worst: null, avg: 0 };
  }
  let winDays = 0, lossDays = 0, sum = 0;
  let best = entries[0], worst = entries[0];
  entries.forEach(e => {
    if (e.pnl > 0) winDays++;
    else if (e.pnl < 0) lossDays++;
    sum += e.pnl;
    if (e.pnl > best.pnl) best = e;
    if (e.pnl < worst.pnl) worst = e;
  });
  return {
    totalDays: entries.length,
    winDays, lossDays,
    winRate: (winDays / entries.length) * 100,
    best, worst,
    avg: sum / entries.length,
  };
}

/* ============================================================
   CURRENCY
   ============================================================ */
function formatMoney(usdValue) {
  const symbol = state.currency === 'THB' ? '฿' : '$';
  const rate = state.currency === 'THB' ? (state.fxRate || CONFIG.USD_TO_THB_DEFAULT) : 1;
  const value = usdValue * rate;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${symbol}${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function setCurrency(code) {
  state.currency = code;
  localStorage.setItem('mulan_currency', code);
  syncCurrencyToggleUI();
  refreshSettingsUI();
  render();
}

function syncCurrencyToggleUI() {
  const toggle = document.getElementById('currency-toggle');
  toggle.classList.toggle('thb', state.currency === 'THB');
  toggle.querySelector('.currency-thumb').textContent = state.currency === 'THB' ? '฿' : '$';
}

async function fetchFxRate(manual) {
  try {
    const res = await fetch(CONFIG.FX_API_URL);
    const json = await res.json();
    const rate = json && json.rates && json.rates.THB;
    if (rate) {
      state.fxRate = rate;
      state.fxUpdated = Date.now();
      localStorage.setItem('mulan_fx_rate', String(rate));
      localStorage.setItem('mulan_fx_updated', String(state.fxUpdated));
      refreshSettingsUI();
      render();
      if (manual) showToast('Exchange rate refreshed 💱');
    }
  } catch (err) {
    if (manual) showToast('Could not fetch live rate — using cached/fallback', true);
  }
}

/* ============================================================
   DATA LAYER — talks to the Apps Script web app, or falls
   back to a local-only demo store when no URL is configured
   ============================================================ */
async function postAction(pin, action, payload) {
  const res = await fetch(CONFIG.APPS_SCRIPT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ pin, action, payload }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json;
}

function createRemoteDataLayer() {
  return {
    async verifyPinAndFetch(pin) {
      // Cache-bust: the URL would otherwise be identical on every load, and
      // browsers (especially mobile Safari) happily serve a stale cached
      // snapshot instead of re-fetching the latest sheet data.
      const url = `${CONFIG.APPS_SCRIPT_URL}?action=getData&pin=${encodeURIComponent(pin)}&_=${Date.now()}`;
      const res = await fetch(url, { cache: 'no-store' });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || 'Invalid PIN');
      return json;
    },
    upsertEntry(pin, date, pnl) { return postAction(pin, 'upsertEntry', { date, pnl }); },
    upsertGoal(pin, month, goal) { return postAction(pin, 'upsertGoal', { month, goal }); },
  };
}

function createLocalDataLayer() {
  const KEY = 'mulan_demo_data';
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || { entries: {}, goals: {} }; }
    catch (e) { return { entries: {}, goals: {} }; }
  }
  function save(data) { localStorage.setItem(KEY, JSON.stringify(data)); }

  return {
    async verifyPinAndFetch(pin) {
      const data = load();
      return {
        ok: true,
        entries: Object.entries(data.entries).map(([date, pnl]) => ({ date, pnl })),
        goals: Object.entries(data.goals).map(([month, goal]) => ({ month, goal })),
      };
    },
    async upsertEntry(pin, date, pnl) {
      const data = load();
      if (pnl == null) delete data.entries[date]; else data.entries[date] = pnl;
      save(data);
      return { ok: true };
    },
    async upsertGoal(pin, month, goal) {
      const data = load();
      if (goal == null) delete data.goals[month]; else data.goals[month] = goal;
      save(data);
      return { ok: true };
    },
  };
}

const dataLayer = DEMO_MODE ? createLocalDataLayer() : createRemoteDataLayer();

/* ============================================================
   PIN GATE / AUTH
   ============================================================ */
function setPinError(msg) {
  document.getElementById('pin-error').textContent = msg;
}

function applyFetchedData(data) {
  state.entries = new Map((data.entries || []).map(e => [e.date, Number(e.pnl)]));
  state.goals = new Map((data.goals || []).map(g => [g.month, Number(g.goal)]));
}

function unlockApp() {
  document.getElementById('pin-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  syncCurrencyToggleUI();
  render();
}

async function submitPin() {
  const pin = document.getElementById('pin-input').value.trim();
  if (!pin) return;
  setPinError('');
  const btn = document.getElementById('pin-submit');
  btn.disabled = true;
  try {
    const data = await dataLayer.verifyPinAndFetch(pin);
    state.pin = pin;
    localStorage.setItem('mulan_pin', pin);
    applyFetchedData(data);
    unlockApp();
  } catch (err) {
    setPinError('Incorrect PIN — please try again 🌷');
  } finally {
    btn.disabled = false;
  }
}

async function boot() {
  syncCurrencyToggleUI();

  const cachedRate = parseFloat(localStorage.getItem('mulan_fx_rate'));
  const cachedUpdated = parseInt(localStorage.getItem('mulan_fx_updated'), 10);
  if (!Number.isNaN(cachedRate)) {
    state.fxRate = cachedRate;
    state.fxUpdated = Number.isNaN(cachedUpdated) ? null : cachedUpdated;
  }

  if (DEMO_MODE) {
    document.getElementById('pin-input').placeholder = 'any PIN works';
    setPinError('🔌 Demo mode: connect your Google Sheet in app.js (CONFIG.APPS_SCRIPT_URL) to sync real data. For now, any PIN unlocks a local-only preview.');
  }

  const savedPin = localStorage.getItem('mulan_pin');
  if (savedPin) {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('hidden');
    try {
      const data = await dataLayer.verifyPinAndFetch(savedPin);
      state.pin = savedPin;
      applyFetchedData(data);
      unlockApp();
    } catch (err) {
      localStorage.removeItem('mulan_pin');
    } finally {
      overlay.classList.add('hidden');
    }
  }

  fetchFxRate(false);
}

/* ============================================================
   HEADER CLOCK
   ============================================================ */
function updateHeaderClock() {
  const now = new Date();
  document.getElementById('clock-time').textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  document.getElementById('clock-date').textContent =
    `${pad2(now.getDate())} ${MONTH_NAMES[now.getMonth()].toUpperCase()} ${now.getFullYear()}`;
}
updateHeaderClock();
setInterval(updateHeaderClock, 15000);

/* ============================================================
   EDITABLE APP TITLE
   ============================================================ */
const appTitleEl = document.getElementById('app-title');
const appTitleTextEl = document.getElementById('app-title-text');
const DEFAULT_APP_TITLE = appTitleTextEl.textContent.trim();
appTitleTextEl.textContent = localStorage.getItem('mulan_app_title') || DEFAULT_APP_TITLE;

function startEditingTitle() {
  appTitleTextEl.contentEditable = 'true';
  appTitleEl.classList.add('editing');
  const range = document.createRange();
  range.selectNodeContents(appTitleTextEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  appTitleTextEl.focus();
}

function stopEditingTitle(save) {
  appTitleTextEl.contentEditable = 'false';
  appTitleEl.classList.remove('editing');
  let next = appTitleTextEl.textContent.replace(/\s+/g, ' ').trim();
  if (!save || !next) next = localStorage.getItem('mulan_app_title') || DEFAULT_APP_TITLE;
  appTitleTextEl.textContent = next;
  if (save && next !== DEFAULT_APP_TITLE) localStorage.setItem('mulan_app_title', next);
  else if (save) localStorage.removeItem('mulan_app_title');
}

appTitleEl.addEventListener('click', () => {
  if (appTitleTextEl.contentEditable !== 'true') startEditingTitle();
});
appTitleTextEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); stopEditingTitle(true); appTitleTextEl.blur(); }
  else if (e.key === 'Escape') { e.preventDefault(); stopEditingTitle(false); appTitleTextEl.blur(); }
});
appTitleTextEl.addEventListener('blur', () => {
  if (appTitleTextEl.contentEditable === 'true') stopEditingTitle(true);
});

/* ============================================================
   SHARED VIEW PIECES
   ============================================================ */
function periodNavHTML(label) {
  return `
    <div class="period-nav">
      <button class="period-nav-btn" data-nav="prev" aria-label="Previous">‹</button>
      <span class="period-label">${label}</span>
      <button class="period-nav-btn" data-nav="next" aria-label="Next">›</button>
    </div>
  `;
}

function summaryCardHTML(total, goal, opts) {
  opts = opts || {};
  const pnlClass = total > 0 ? 'profit' : (total < 0 ? 'loss' : '');
  const pct = goal > 0 ? Math.max(0, Math.min(100, (total / goal) * 100)) : 0;
  const goalEditHTML = opts.goalEdit
    ? `<button class="goal-edit-btn" data-edit-goal="${opts.goalEdit}">✏️ ${goal > 0 ? 'Edit goal' : 'Set goal'}</button>`
    : '';
  return `
    <div class="summary-card">
      <div class="summary-row">
        <div>
          <div class="summary-label">Total P&amp;L</div>
          <div class="summary-value ${pnlClass}">${formatMoney(total)}</div>
        </div>
        <div class="goal-block">
          <div class="summary-label">Goal</div>
          <div class="summary-value" style="font-size:18px;">${goal > 0 ? formatMoney(goal) : '—'}</div>
          ${goalEditHTML}
        </div>
      </div>
      ${goal > 0 ? `
        <div class="progress-bar-track"><div class="progress-bar-fill" style="width:${pct}%"></div></div>
        <div class="progress-caption">${pct.toFixed(0)}% of goal ${total >= goal ? '🎉' : ''}</div>
      ` : ''}
    </div>
  `;
}

function dayCardHTML(date, today, opts) {
  opts = opts || {};
  const iso = isoDate(date);
  const isFuture = date.getTime() > today.getTime();
  const isToday = date.getTime() === today.getTime();
  const val = state.entries.get(iso);
  let pnlClass = 'empty', pnlText = '—';
  if (val != null) {
    pnlClass = val > 0 ? 'profit' : (val < 0 ? 'loss' : 'empty');
    pnlText = formatMoney(val);
  }
  // Month view already shows a Mon–Fri header row, so cards there show
  // just the date number; Week view has no such header, so combine
  // the weekday + date on one compact line.
  const headerHTML = opts.showDayName
    ? `<span class="day-label">${DAY_NAMES[date.getDay()]} ${date.getDate()}</span>`
    : `<span class="day-num-only">${date.getDate()}</span>`;
  return `
    <div class="day-card ${isFuture ? 'future' : ''} ${isToday ? 'today' : ''}"
         data-date="${iso}" ${isFuture ? '' : 'data-editable="1"'}>
      ${headerHTML}
      <span class="day-pnl ${pnlClass}">${pnlText}</span>
    </div>
  `;
}

function emptyStateHTML(emoji, msg) {
  return `<div class="empty-state"><span class="empty-emoji">${emoji}</span>${msg}</div>`;
}

function statsGridHTML(stats) {
  if (stats.totalDays === 0) {
    return emptyStateHTML('🌱', 'No logged days yet — your stats will bloom here once you start journaling!');
  }
  return `
    <div class="stats-grid">
      <div class="stat-card"><div class="stat-label">Win rate</div><div class="stat-value">${stats.winRate.toFixed(0)}%</div></div>
      <div class="stat-card"><div class="stat-label">Logged days</div><div class="stat-value">${stats.totalDays}</div></div>
      <div class="stat-card"><div class="stat-label">Best day</div><div class="stat-value ${stats.best.pnl >= 0 ? 'profit' : 'loss'}">${formatMoney(stats.best.pnl)}</div></div>
      <div class="stat-card"><div class="stat-label">Worst day</div><div class="stat-value ${stats.worst.pnl >= 0 ? 'profit' : 'loss'}">${formatMoney(stats.worst.pnl)}</div></div>
      <div class="stat-card"><div class="stat-label">Avg / day</div><div class="stat-value ${stats.avg >= 0 ? 'profit' : 'loss'}">${formatMoney(stats.avg)}</div></div>
      <div class="stat-card"><div class="stat-label">Win / loss days</div><div class="stat-value">${stats.winDays} / ${stats.lossDays}</div></div>
    </div>
  `;
}

/* ===== Hand-rolled SVG charts ===== */
function renderLineChart(entries) {
  if (entries.length === 0) return emptyStateHTML('🌷', 'Nothing logged yet for this period.');
  const W = 320, H = 140, PAD = 12;
  let cum = 0;
  const points = entries.map(e => { cum += e.pnl; return cum; });
  const min = Math.min(0, ...points);
  const max = Math.max(0, ...points);
  const range = (max - min) || 1;
  const stepX = points.length > 1 ? (W - PAD * 2) / (points.length - 1) : 0;
  const coords = points.map((v, i) => [
    PAD + i * stepX,
    H - PAD - ((v - min) / range) * (H - PAD * 2),
  ]);
  const pathD = coords.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const zeroY = H - PAD - ((0 - min) / range) * (H - PAD * 2);
  const last = points[points.length - 1];
  const lineColor = last >= 0 ? COLORS.profit : COLORS.loss;
  const fillColor = last >= 0 ? 'rgba(79,174,132,0.15)' : 'rgba(232,103,125,0.15)';
  const lastX = coords[coords.length - 1][0].toFixed(1);
  const firstX = coords[0][0].toFixed(1);
  const areaD = `${pathD} L${lastX},${(H - PAD).toFixed(1)} L${firstX},${(H - PAD).toFixed(1)} Z`;
  const marker = coords.length === 1
    ? `<circle cx="${coords[0][0].toFixed(1)}" cy="${coords[0][1].toFixed(1)}" r="4" fill="${lineColor}" />`
    : '';

  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:140px;display:block;">
      <line x1="${PAD}" y1="${zeroY.toFixed(1)}" x2="${W - PAD}" y2="${zeroY.toFixed(1)}" stroke="${COLORS.grid}" stroke-width="1" stroke-dasharray="4 4" />
      <path d="${areaD}" fill="${fillColor}" stroke="none" />
      <path d="${pathD}" fill="none" stroke="${lineColor}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
      ${marker}
    </svg>
  `;
}

function renderBarChart(monthly) {
  const W = 320, H = 140, PAD = 8;
  const gap = 4;
  const barW = (W - PAD * 2) / monthly.length - gap;
  const max = Math.max(1, ...monthly.map(m => Math.abs(m.value)));
  const midY = H / 2;
  const usableHalf = (H / 2) - PAD - 8;

  const bars = monthly.map((m, i) => {
    const x = PAD + i * (barW + gap);
    const h = Math.max(1, (Math.abs(m.value) / max) * usableHalf);
    const y = m.value >= 0 ? midY - h : midY;
    const color = m.value > 0 ? COLORS.profit : (m.value < 0 ? COLORS.loss : COLORS.grid);
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${color}" />
            <text x="${(x + barW / 2).toFixed(1)}" y="${H - 2}" font-size="8" fill="#9b8a9a" text-anchor="middle">${m.label}</text>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${W} ${H}" style="width:100%;height:140px;display:block;">
      <line x1="${PAD}" y1="${midY}" x2="${W - PAD}" y2="${midY}" stroke="${COLORS.grid}" stroke-width="1" />
      ${bars}
    </svg>
  `;
}

/* ============================================================
   VIEWS
   ============================================================ */
function renderWeekView() {
  const today = startOfDay(new Date());
  const { total, goal, days, monday } = computeWeekTotalAndGoal(state.offsets.week);
  const friday = days[4];
  const label = formatWeekLabel(monday, friday);

  return `
    <div class="view">
      ${periodNavHTML(label)}
      ${summaryCardHTML(total, goal)}
      <div class="day-grid">${days.map(d => dayCardHTML(d, today, { showDayName: true })).join('')}</div>
    </div>
  `;
}

function renderMonthView() {
  const today = startOfDay(new Date());
  const { total, goal, days, monthKey, base } = computeMonthTotalAndGoal(state.offsets.month);
  const label = `${MONTH_NAMES[base.getMonth()]} ${base.getFullYear()}`;

  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  const leadPad = firstDay.getDay() - 1;
  const trailPad = 5 - lastDay.getDay();

  let cells = '';
  for (let i = 0; i < leadPad; i++) cells += `<div class="day-card" style="visibility:hidden"></div>`;
  days.forEach(d => { cells += dayCardHTML(d, today, { showDayName: false }); });
  for (let i = 0; i < trailPad; i++) cells += `<div class="day-card" style="visibility:hidden"></div>`;

  const headerCells = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']
    .map(n => `<div class="month-header-cell">${n}</div>`).join('');

  return `
    <div class="view">
      ${periodNavHTML(label)}
      ${summaryCardHTML(total, goal, { goalEdit: monthKey })}
      <div class="day-grid">${headerCells}</div>
      <div class="day-grid">${cells}</div>
    </div>
  `;
}

function renderYearView() {
  const today = startOfDay(new Date());
  const year = today.getFullYear() + state.offsets.year;
  const label = `${year}`;

  const yearEntries = [];
  for (const [dateStr, val] of state.entries) {
    if (dateStr.slice(0, 4) === String(year)) yearEntries.push({ date: dateStr, pnl: val });
  }
  yearEntries.sort((a, b) => a.date.localeCompare(b.date));

  let total = 0;
  yearEntries.forEach(e => { total += e.pnl; });

  let goal = 0;
  for (let m = 1; m <= 12; m++) {
    const key = `${year}-${pad2(m)}`;
    if (state.goals.has(key)) goal += state.goals.get(key);
  }

  const stats = computeStats(yearEntries);

  const monthly = [];
  for (let m = 0; m < 12; m++) {
    const key = `${year}-${pad2(m + 1)}`;
    let sum = 0;
    yearEntries.forEach(e => { if (e.date.slice(0, 7) === key) sum += e.pnl; });
    monthly.push({ label: MONTH_NAMES[m].slice(0, 3), value: sum });
  }

  return `
    <div class="view">
      ${periodNavHTML(label)}
      ${summaryCardHTML(total, goal)}
      ${statsGridHTML(stats)}
      <div class="chart-card">
        <p class="chart-title">Monthly breakdown</p>
        ${renderBarChart(monthly)}
      </div>
      <div class="chart-card">
        <p class="chart-title">Cumulative P&amp;L</p>
        ${renderLineChart(yearEntries)}
      </div>
    </div>
  `;
}

function renderAllTimeView() {
  const allEntries = [...state.entries.entries()]
    .map(([date, pnl]) => ({ date, pnl }))
    .sort((a, b) => a.date.localeCompare(b.date));

  let total = 0;
  allEntries.forEach(e => { total += e.pnl; });

  let goal = 0;
  for (const g of state.goals.values()) goal += g;

  const stats = computeStats(allEntries);

  return `
    <div class="view">
      <div class="period-nav"><span class="period-label">All-Time 🌟</span></div>
      ${summaryCardHTML(total, goal)}
      ${statsGridHTML(stats)}
      <div class="chart-card">
        <p class="chart-title">Lifetime cumulative P&amp;L</p>
        ${renderLineChart(allEntries)}
      </div>
    </div>
  `;
}

function renderCalcView() {
  return `
    <div class="view">
      <div class="period-nav"><span class="period-label">Calculator 🧮</span></div>
      <div class="summary-card calc-card">
        <label class="entry-label" for="calc-equity">Equity</label>
        <div class="entry-input-wrap">
          <span class="entry-symbol">$</span>
          <input id="calc-equity" class="calc-input" type="number" inputmode="decimal" step="0.01" placeholder="e.g. 10000" value="${state.calc.equity}" />
        </div>
        <label class="entry-label" for="calc-pnl">P&amp;L</label>
        <div class="entry-input-wrap">
          <span class="entry-symbol">$</span>
          <input id="calc-pnl" class="calc-input" type="number" inputmode="decimal" step="0.01" placeholder="e.g. 150" value="${state.calc.pnl}" />
        </div>
        <label class="entry-label" for="calc-pct">% P&amp;L</label>
        <div class="entry-input-wrap">
          <input id="calc-pct" class="calc-input" type="number" inputmode="decimal" step="0.01" placeholder="e.g. 1.5" value="${state.calc.pct}" />
          <span class="entry-symbol">%</span>
        </div>
      </div>
    </div>
  `;
}

function handleCalcInput(e) {
  const id = e.target.id;
  if (id !== 'calc-equity' && id !== 'calc-pnl' && id !== 'calc-pct') return;

  const equityEl = document.getElementById('calc-equity');
  const pnlEl = document.getElementById('calc-pnl');
  const pctEl = document.getElementById('calc-pct');
  const equity = parseFloat(equityEl.value);
  const pnl = parseFloat(pnlEl.value);
  const pct = parseFloat(pctEl.value);

  if (id === 'calc-equity') {
    if (!isNaN(equity) && !isNaN(pnl)) pctEl.value = equity ? (pnl / equity * 100).toFixed(2) : '';
    else if (!isNaN(equity) && !isNaN(pct)) pnlEl.value = (equity * pct / 100).toFixed(2);
  } else if (id === 'calc-pnl') {
    if (!isNaN(equity) && !isNaN(pnl)) pctEl.value = equity ? (pnl / equity * 100).toFixed(2) : '';
  } else if (id === 'calc-pct') {
    if (!isNaN(equity) && !isNaN(pct)) pnlEl.value = (equity * pct / 100).toFixed(2);
  }

  state.calc.equity = equityEl.value;
  state.calc.pnl = pnlEl.value;
  state.calc.pct = pctEl.value;
}

function render() {
  const el = document.getElementById('content');
  if (state.activeTab === 'week') el.innerHTML = renderWeekView();
  else if (state.activeTab === 'month') el.innerHTML = renderMonthView();
  else if (state.activeTab === 'year') el.innerHTML = renderYearView();
  else if (state.activeTab === 'calc') el.innerHTML = renderCalcView();
  else el.innerHTML = renderAllTimeView();
}

/* ============================================================
   TOAST
   ============================================================ */
let toastTimer = null;
function showToast(msg, isError) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.toggle('error', !!isError);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

/* ============================================================
   PARTICLE EFFECTS (confetti / sparkle)
   ============================================================ */
const particleCanvas = document.getElementById('particle-canvas');
const pCtx = particleCanvas.getContext('2d');
let particles = [];
let particleAnimating = false;

function resizeParticleCanvas() {
  particleCanvas.width = window.innerWidth;
  particleCanvas.height = window.innerHeight;
}
window.addEventListener('resize', resizeParticleCanvas);
resizeParticleCanvas();

const PARTICLE_COLORS = ['#ffd6e7', '#ff8fb1', '#e3d9fb', '#b9a3f5', '#cdf5e0', '#6fd6a0', '#fff3c4'];

function drawStar(ctx, cx, cy, r) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.beginPath();
  for (let i = 0; i < 5; i++) {
    ctx.lineTo(Math.cos((18 + i * 72) / 180 * Math.PI) * r, -Math.sin((18 + i * 72) / 180 * Math.PI) * r);
    ctx.lineTo(Math.cos((54 + i * 72) / 180 * Math.PI) * r * 0.45, -Math.sin((54 + i * 72) / 180 * Math.PI) * r * 0.45);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function spawnParticles(x, y, count, opts) {
  opts = opts || {};
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (opts.minSpeed || 1) + Math.random() * (opts.speedRange || 4);
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - (opts.lift || 0),
      size: (opts.minSize || 3) + Math.random() * (opts.sizeRange || 4),
      color: PARTICLE_COLORS[Math.floor(Math.random() * PARTICLE_COLORS.length)],
      life: 1,
      decay: opts.decay || 0.018,
      gravity: opts.gravity != null ? opts.gravity : 0.12,
      shape: opts.shape || 'circle',
    });
  }
  if (!particleAnimating) { particleAnimating = true; requestAnimationFrame(tickParticles); }
}

function tickParticles() {
  pCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
  particles.forEach(p => {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += p.gravity;
    p.life -= p.decay;
  });
  particles = particles.filter(p => p.life > 0);
  particles.forEach(p => {
    pCtx.globalAlpha = Math.max(0, p.life);
    pCtx.fillStyle = p.color;
    if (p.shape === 'star') drawStar(pCtx, p.x, p.y, p.size);
    else { pCtx.beginPath(); pCtx.arc(p.x, p.y, p.size, 0, Math.PI * 2); pCtx.fill(); }
  });
  pCtx.globalAlpha = 1;
  if (particles.length > 0) requestAnimationFrame(tickParticles);
  else particleAnimating = false;
}

function burstConfetti(x, y) {
  spawnParticles(x, y, 70, { minSpeed: 2, speedRange: 7, minSize: 4, sizeRange: 5, lift: 5, gravity: 0.18, decay: 0.012 });
}

function sparkle(x, y) {
  spawnParticles(x, y, 14, { minSpeed: 0.5, speedRange: 2, minSize: 2, sizeRange: 3, lift: 2, gravity: 0.04, decay: 0.025, shape: 'star' });
}

function elementCenter(el) {
  if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/* ============================================================
   MODAL (entry / goal — shared)
   ============================================================ */
let modalMode = null; // 'entry' | 'goal'
let modalKey = null;  // date string ('YYYY-MM-DD') or month string ('YYYY-MM')
let entrySign = 1;    // 1 or -1 — only meaningful in 'entry' mode

function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
}
function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
}

function setEntrySign(sign) {
  entrySign = sign;
  const btn = document.getElementById('entry-sign-toggle');
  btn.textContent = sign > 0 ? '+' : '−';
  btn.classList.toggle('positive', sign > 0);
  btn.classList.toggle('negative', sign < 0);
}

function openEntryModal(dateStr) {
  modalMode = 'entry';
  modalKey = dateStr;
  const date = parseISODate(dateStr);
  document.getElementById('entry-modal-title').textContent =
    `${DAY_NAMES_FULL[date.getDay()]}, ${MONTH_NAMES[date.getMonth()].slice(0, 3)} ${date.getDate()}`;
  document.getElementById('entry-field-label').textContent = 'Daily P&L';
  document.getElementById('entry-currency-symbol').textContent = '$';
  document.getElementById('entry-sign-toggle').classList.remove('hidden');
  const existing = state.entries.get(dateStr);
  setEntrySign(existing != null && existing < 0 ? -1 : 1);
  const input = document.getElementById('entry-input');
  input.value = existing != null ? String(Math.abs(existing)) : '';
  document.getElementById('entry-delete').style.display = existing != null ? '' : 'none';
  showModal('entry-modal');
  input.focus();
}

function openGoalModal(monthKey) {
  modalMode = 'goal';
  modalKey = monthKey;
  const [y, m] = monthKey.split('-');
  document.getElementById('entry-modal-title').textContent = `${MONTH_NAMES[parseInt(m, 10) - 1]} ${y} Goal`;
  document.getElementById('entry-field-label').textContent = 'Monthly Goal';
  document.getElementById('entry-currency-symbol').textContent = '$';
  document.getElementById('entry-sign-toggle').classList.add('hidden');
  setEntrySign(1);
  const existing = state.goals.get(monthKey);
  const input = document.getElementById('entry-input');
  input.value = existing != null ? String(existing) : '';
  document.getElementById('entry-delete').style.display = existing != null ? '' : 'none';
  showModal('entry-modal');
  input.focus();
}

async function saveModalValue(value) {
  hideModal('entry-modal');
  if (modalMode === 'entry') await saveEntry(modalKey, value);
  else await saveGoal(modalKey, value);
}

async function saveEntry(dateStr, value) {
  const prevValue = state.entries.has(dateStr) ? state.entries.get(dateStr) : null;
  const { total: prevTotal, goal } = computeActivePeriodTotalAndGoal();

  if (value == null) state.entries.delete(dateStr);
  else state.entries.set(dateStr, value);

  const { total: newTotal } = computeActivePeriodTotalAndGoal();
  render();

  try {
    await dataLayer.upsertEntry(state.pin, dateStr, value);
    showToast(value == null ? 'Entry cleared 🧹' : 'Saved! 🌸');

    if (value != null) {
      const card = document.querySelector(`.day-card[data-date="${dateStr}"]`);
      const { x, y } = elementCenter(card);
      const crossedGoal = goal > 0 && prevTotal < goal && newTotal >= goal;
      if (crossedGoal) {
        burstConfetti(x, y);
      } else if (value > 0) {
        sparkle(x, y);
      } else if (card) {
        card.classList.add('just-saved');
        setTimeout(() => card.classList.remove('just-saved'), 800);
      }
    }
  } catch (err) {
    if (prevValue == null) state.entries.delete(dateStr); else state.entries.set(dateStr, prevValue);
    render();
    showToast('Could not save — please try again 💔', true);
  }
}

async function saveGoal(monthKey, value) {
  const prevValue = state.goals.has(monthKey) ? state.goals.get(monthKey) : null;
  if (value == null) state.goals.delete(monthKey);
  else state.goals.set(monthKey, value);
  render();

  try {
    await dataLayer.upsertGoal(state.pin, monthKey, value);
    showToast(value == null ? 'Goal cleared 🧹' : 'Goal updated! 🎯');
  } catch (err) {
    if (prevValue == null) state.goals.delete(monthKey); else state.goals.set(monthKey, prevValue);
    render();
    showToast('Could not save — please try again 💔', true);
  }
}

/* ============================================================
   SETTINGS PANEL
   ============================================================ */
function refreshSettingsUI() {
  document.querySelectorAll('.chip[data-currency]').forEach(chip => {
    chip.classList.toggle('active', chip.dataset.currency === state.currency);
  });
  const rate = state.fxRate || CONFIG.USD_TO_THB_DEFAULT;
  document.getElementById('fx-rate-label').textContent = `1 USD = ${rate.toFixed(2)} ฿`;
  const updatedLabel = document.getElementById('fx-updated-label');
  updatedLabel.textContent = state.fxUpdated
    ? `Live rate · updated ${formatRelativeTime(state.fxUpdated)}`
    : `Using fallback rate (${CONFIG.USD_TO_THB_DEFAULT})`;
}

/* ============================================================
   EVENT WIRING
   ============================================================ */
document.getElementById('pin-submit').addEventListener('click', submitPin);
document.getElementById('pin-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitPin();
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.activeTab = btn.dataset.tab;
    render();
  });
});

document.getElementById('content').addEventListener('click', (e) => {
  const navBtn = e.target.closest('.period-nav-btn');
  if (navBtn) {
    state.offsets[state.activeTab] += (navBtn.dataset.nav === 'prev' ? -1 : 1);
    render();
    return;
  }
  const goalBtn = e.target.closest('.goal-edit-btn');
  if (goalBtn) { openGoalModal(goalBtn.dataset.editGoal); return; }

  const dayCard = e.target.closest('.day-card[data-editable="1"]');
  if (dayCard) { openEntryModal(dayCard.dataset.date); }
});

document.getElementById('content').addEventListener('input', handleCalcInput);

document.getElementById('entry-close').addEventListener('click', () => hideModal('entry-modal'));
document.getElementById('settings-close').addEventListener('click', () => hideModal('settings-modal'));

const signToggleBtn = document.getElementById('entry-sign-toggle');
// Toggle on pointerdown (not click): preventDefault here stops the button from
// stealing focus from the input (which would dismiss the iOS keyboard), but
// preventDefault on touchstart/mousedown can also suppress the synthetic click
// that would normally follow — so we do the toggle right here instead.
signToggleBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  setEntrySign(-entrySign);
});

document.getElementById('entry-save').addEventListener('click', () => {
  const raw = document.getElementById('entry-input').value.trim();
  let value = null;
  if (raw !== '') {
    const magnitude = parseFloat(raw);
    if (Number.isNaN(magnitude)) { showToast('Please enter a valid number 🌸', true); return; }
    value = (modalMode === 'entry' ? entrySign : 1) * Math.abs(magnitude);
  }
  saveModalValue(value);
});
document.getElementById('entry-delete').addEventListener('click', () => saveModalValue(null));

document.getElementById('settings-btn').addEventListener('click', () => {
  refreshSettingsUI();
  showModal('settings-modal');
});
document.querySelectorAll('.chip[data-currency]').forEach(chip => {
  chip.addEventListener('click', () => setCurrency(chip.dataset.currency));
});
document.getElementById('currency-toggle').addEventListener('click', () => {
  setCurrency(state.currency === 'USD' ? 'THB' : 'USD');
});
document.getElementById('fx-refresh').addEventListener('click', () => fetchFxRate(true));

document.getElementById('change-pin-btn').addEventListener('click', () => {
  document.getElementById('change-pin-form').classList.toggle('hidden');
});
document.getElementById('save-pin-btn').addEventListener('click', async () => {
  const newPin = document.getElementById('new-pin-input').value.trim();
  if (!newPin) return;
  try {
    await dataLayer.verifyPinAndFetch(newPin);
    state.pin = newPin;
    localStorage.setItem('mulan_pin', newPin);
    document.getElementById('new-pin-input').value = '';
    document.getElementById('change-pin-form').classList.add('hidden');
    showToast('PIN updated 🔐');
  } catch (err) {
    showToast("Doesn't match your Code.gs PIN — update it there first", true);
  }
});

/* ============================================================
   BOOT
   ============================================================ */
boot();

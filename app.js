const APP_VERSION = '1.0.0';
const DATA_URL = 'menu-data.json';
const SOURCE_URL = 'https://menus.healthepro.com/organizations/1681';
const CACHE_KEY = 'riverton-menu:last-good:v1';
const CHECK_KEY = 'riverton-menu:last-check:v1';
const MEAL_KEY = 'riverton-menu:meal:v1';

const state = {
  data: null,
  meal: localStorage.getItem(MEAL_KEY) === 'lunch' ? 'lunch' : 'breakfast',
  lastChecked: localStorage.getItem(CHECK_KEY) || null,
  loadError: null,
  fromCache: false,
};

const $ = (id) => document.getElementById(id);
const els = {
  todayDate: $('todayDate'), statusPill: $('statusPill'), todayMeal: $('todayMeal'),
  dayList: $('dayList'), weekRange: $('weekRange'), breakfastTab: $('breakfastTab'), lunchTab: $('lunchTab'),
  infoButton: $('infoButton'), infoDialog: $('infoDialog'), closeInfoButton: $('closeInfoButton'), refreshButton: $('refreshButton'),
  infoStatus: $('infoStatus'), infoPulled: $('infoPulled'), infoChecked: $('infoChecked'), infoNextUpdate: $('infoNextUpdate'),
  infoWeek: $('infoWeek'), infoVersion: $('infoVersion'), infoSource: $('infoSource'), statusBanner: $('statusBanner'), refreshMessage: $('refreshMessage'),
};

const dateOnly = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const parseDate = (s) => {
  if (!s) return null;
  const d = new Date(`${s}T12:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatDate = (d, options) => d ? new Intl.DateTimeFormat('en-US', options).format(d) : '—';
const formatTimestamp = (s) => {
  if (!s) return 'Never';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return 'Unknown';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
};

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(12,0,0,0);
  const day = d.getDay();
  const delta = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + delta);
  return d;
}

function fridayOf(date) {
  const d = mondayOf(date);
  d.setDate(d.getDate() + 4);
  return d;
}

function nextSaturday(date = new Date()) {
  const d = new Date(date);
  d.setHours(6, 15, 0, 0);
  const days = (6 - d.getDay() + 7) % 7;
  if (days === 0 && date > d) d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + days);
  return d;
}

function currentWeekBounds() {
  const now = new Date();
  return { start: mondayOf(now), end: fridayOf(now) };
}

function isDataCurrent(data) {
  if (!data?.weekStart || !data?.weekEnd) return false;
  const { start, end } = currentWeekBounds();
  return data.weekStart === dateOnly(start) && data.weekEnd === dateOnly(end);
}

function getStatus() {
  if (!state.data) return { key: 'error', label: 'No menu', detail: 'No menu data is available yet.' };
  if (isDataCurrent(state.data)) {
    if (state.fromCache && state.loadError) return { key: 'stale', label: 'Cached', detail: 'Showing the last saved menu because the latest check failed.' };
    return { key: 'current', label: 'Current', detail: 'This menu matches the current school week.' };
  }
  return { key: 'stale', label: 'Out of date', detail: 'The saved menu does not match the current school week.' };
}

function mealDays() {
  return Array.isArray(state.data?.[state.meal]) ? state.data[state.meal] : [];
}

function normalizeMeal(day) {
  if (!day) return null;
  const items = Array.isArray(day.items) ? day.items.filter(Boolean) : [];
  const title = day.title || items[0] || 'Menu posted';
  const rest = day.title ? items : items.slice(1);
  return { ...day, title, items: rest };
}

function renderTabs() {
  for (const [meal, el] of [['breakfast', els.breakfastTab], ['lunch', els.lunchTab]]) {
    const active = state.meal === meal;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', String(active));
  }
}

function renderToday() {
  const now = new Date();
  els.todayDate.textContent = formatDate(now, { weekday: 'long', month: 'long', day: 'numeric' });
  const today = mealDays().find(d => d.date === dateOnly(now));
  const meal = normalizeMeal(today);

  if (!state.data) {
    els.todayMeal.innerHTML = `<h3 class="empty-title">Menu not synced yet</h3><p class="empty-copy">Open Information and use Force refresh after the first GitHub menu sync runs.</p>`;
    return;
  }
  if ([0,6].includes(now.getDay())) {
    els.todayMeal.innerHTML = `<div class="meal-kicker">${state.meal}</div><h3 class="empty-title">No school today</h3><p class="empty-copy">The weekly menu is below.</p>`;
    return;
  }
  if (!meal) {
    els.todayMeal.innerHTML = `<div class="meal-kicker">${state.meal}</div><h3 class="empty-title">No menu listed</h3><p class="empty-copy">The district source has no ${state.meal} entry for today.</p>`;
    return;
  }

  els.todayMeal.innerHTML = `
    <div class="meal-kicker">${escapeHtml(state.meal)}</div>
    <h3 class="meal-title">${escapeHtml(meal.title)}</h3>
    <p class="meal-items">${escapeHtml(meal.items.join(' • ') || meal.note || '')}</p>`;
}

function renderWeek() {
  const dataStart = parseDate(state.data?.weekStart);
  const dataEnd = parseDate(state.data?.weekEnd);
  if (dataStart && dataEnd) {
    els.weekRange.textContent = `${formatDate(dataStart, { month: 'short', day: 'numeric' })}–${formatDate(dataEnd, { month: 'short', day: 'numeric' })}`;
  } else {
    const { start, end } = currentWeekBounds();
    els.weekRange.textContent = `${formatDate(start, { month: 'short', day: 'numeric' })}–${formatDate(end, { month: 'short', day: 'numeric' })}`;
  }

  const byDate = new Map(mealDays().map(d => [d.date, normalizeMeal(d)]));
  const start = dataStart || currentWeekBounds().start;
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const key = dateOnly(d);
    const meal = byDate.get(key);
    const isToday = key === dateOnly(new Date());
    rows.push(`
      <article class="day-card${isToday ? ' today' : ''}">
        <div class="day-date">
          <div class="day-name">${formatDate(d, { weekday: 'short' })}</div>
          <div class="day-number">${d.getDate()}</div>
        </div>
        <div class="day-content">
          <h3 class="day-title">${escapeHtml(meal?.title || 'No menu listed')}</h3>
          <p class="day-items">${escapeHtml(meal?.items?.join(' • ') || meal?.note || '')}</p>
        </div>
      </article>`);
  }
  els.dayList.innerHTML = rows.join('');
}

function renderStatus() {
  const status = getStatus();
  els.statusPill.className = `status-pill ${status.key}`;
  els.statusPill.textContent = status.label;
  els.statusBanner.className = `status-banner ${status.key}`;
  els.statusBanner.textContent = status.detail;
  els.infoStatus.textContent = status.label;
  els.infoPulled.textContent = formatTimestamp(state.data?.generatedAt);
  els.infoChecked.textContent = formatTimestamp(state.lastChecked);
  els.infoNextUpdate.textContent = formatDate(nextSaturday(), { weekday: 'short', month: 'short', day: 'numeric' });
  els.infoWeek.textContent = state.data?.weekStart && state.data?.weekEnd ? `${state.data.weekStart} → ${state.data.weekEnd}` : 'Not available';
  els.infoVersion.textContent = `v${APP_VERSION}`;
  els.infoSource.href = state.data?.source?.url || SOURCE_URL;
}

function render() {
  renderTabs();
  renderToday();
  renderWeek();
  renderStatus();
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

async function fetchData({ force = false } = {}) {
  state.loadError = null;
  const checked = new Date().toISOString();
  state.lastChecked = checked;
  localStorage.setItem(CHECK_KEY, checked);
  try {
    const url = force ? `${DATA_URL}?v=${Date.now()}` : DATA_URL;
    const response = await fetch(url, { cache: force ? 'no-store' : 'default' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.breakfast) || !Array.isArray(data.lunch)) throw new Error('Invalid menu data');
    state.data = data;
    state.fromCache = false;
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch (error) {
    state.loadError = error;
    const cached = localStorage.getItem(CACHE_KEY);
    if (cached) {
      try {
        state.data = JSON.parse(cached);
        state.fromCache = true;
      } catch {}
    }
  }
  render();
}

for (const tab of [els.breakfastTab, els.lunchTab]) {
  tab.addEventListener('click', () => {
    state.meal = tab.dataset.meal;
    localStorage.setItem(MEAL_KEY, state.meal);
    render();
  });
}

els.infoButton.addEventListener('click', () => { renderStatus(); els.infoDialog.showModal(); });
els.closeInfoButton.addEventListener('click', () => els.infoDialog.close());
els.infoDialog.addEventListener('click', (event) => {
  if (event.target === els.infoDialog) els.infoDialog.close();
});

els.refreshButton.addEventListener('click', async () => {
  els.refreshButton.disabled = true;
  els.refreshMessage.textContent = 'Checking for the newest menu…';
  await fetchData({ force: true });
  const status = getStatus();
  els.refreshMessage.textContent = state.loadError ? 'Refresh failed. Keeping the last saved menu.' : `Refresh complete — ${status.label}.`;
  els.refreshButton.disabled = false;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

render();
fetchData();

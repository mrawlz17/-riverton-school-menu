const APP_VERSION = '1.1.0';
const DATA_URL = 'menu-data.json';
const SOURCE_URL = 'https://menus.healthepro.com/organizations/1681';
const CACHE_KEY = 'riverton-menu:last-good:v2';
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
  todayDate: $('todayDate'),
  statusPill: $('statusPill'),
  todayMeal: $('todayMeal'),
  dayList: $('dayList'),
  weekRange: $('weekRange'),
  breakfastTab: $('breakfastTab'),
  lunchTab: $('lunchTab'),
  infoButton: $('infoButton'),
  infoDialog: $('infoDialog'),
  closeInfoButton: $('closeInfoButton'),
  refreshButton: $('refreshButton'),
  infoStatus: $('infoStatus'),
  infoPulled: $('infoPulled'),
  infoChecked: $('infoChecked'),
  infoNextUpdate: $('infoNextUpdate'),
  infoWeek: $('infoWeek'),
  infoVersion: $('infoVersion'),
  infoSource: $('infoSource'),
  statusBanner: $('statusBanner'),
  refreshMessage: $('refreshMessage'),
};

const CATEGORY_LABELS = {
  'Breakfast Entree': 'Main Choices',
  'Lunch Entree': 'Entrée Choices',
  'Entree': 'Entrée Choices',
  'Pizzeria': 'Pizza Choices',
  'Alternate Choices': 'Alternate Choices',
  'Vegetables': 'Veggie Options',
  'Fruit': 'Fruit Options',
  'Grains': 'Grain / Bread',
  'Milk': 'Drink Options',
  'Misc.': 'Extras',
  'Desserts': 'Dessert',
  'Condiments': 'Condiments',
};

const WEEK_LABELS = {
  'Breakfast Entree': 'Main',
  'Lunch Entree': 'Entrées',
  'Entree': 'Entrées',
  'Pizzeria': 'Pizza',
  'Alternate Choices': 'Alternates',
  'Vegetables': 'Veggies',
  'Fruit': 'Fruit',
  'Grains': 'Bread',
  'Milk': 'Drinks',
  'Misc.': 'Extras',
  'Desserts': 'Dessert',
  'Condiments': 'Condiments',
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
  return new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(d);
};

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

function fridayOf(date) {
  const d = mondayOf(date);
  d.setDate(d.getDate() + 4);
  return d;
}

function nextSaturday(date = new Date()) {
  const d = new Date(date);
  d.setHours(7, 0, 0, 0);
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
    if (state.fromCache && state.loadError) {
      return { key: 'stale', label: 'Cached', detail: 'Showing the last saved menu because the latest check failed.' };
    }
    return { key: 'current', label: 'Current', detail: 'This menu matches the current school week.' };
  }
  return { key: 'stale', label: 'Out of date', detail: 'The saved menu does not match the current school week.' };
}

function mealDays() {
  return Array.isArray(state.data?.[state.meal]) ? state.data[state.meal] : [];
}

function stripIcon(value = '') {
  return String(value)
    .replace(/^[•·▪◦‣⁃\-–—]+\s*/u, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function mergeWith(items = []) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = stripIcon(items[i]);
    if (!item) continue;

    if (/^with$/i.test(item) && out.length && i + 1 < items.length) {
      const next = stripIcon(items[++i]);
      if (next) out[out.length - 1] = `${out[out.length - 1]} + ${next}`;
      continue;
    }

    if (/^with\s+/i.test(item) && out.length) {
      out[out.length - 1] = `${out[out.length - 1]} + ${item.replace(/^with\s+/i, '')}`;
      continue;
    }

    out.push(item);
  }
  return [...new Set(out)];
}

function legacySections(day) {
  const markers = new Set(Object.keys(CATEGORY_LABELS));
  const source = [day?.title, ...(Array.isArray(day?.items) ? day.items : [])]
    .map(stripIcon)
    .filter(Boolean);

  const sections = [];
  let current = null;

  for (const item of source) {
    if (markers.has(item)) {
      current = { category: item, items: [] };
      sections.push(current);
      continue;
    }

    if (current) current.items.push(item);
  }

  for (const section of sections) section.items = mergeWith(section.items);
  return sections.filter(section => section.items.length);
}

function normalizeMeal(day) {
  if (!day) return null;

  let sections = Array.isArray(day.sections)
    ? day.sections.map(section => ({
        category: section.category,
        items: mergeWith(section.items || [])
      })).filter(section => section.category && section.items.length)
    : legacySections(day);

  const garbage = sections.length === 0 && /Month|Select Language|Dietary Preferences/i.test(`${day.title || ''} ${(day.items || []).join(' ')}`);
  if (garbage) return { ...day, title: 'No menu listed', items: [], sections: [], note: 'No breakfast menu could be read for this day.' };

  const title = stripIcon(day.title) || sections[0]?.items?.[0] || day.note || 'Menu posted';
  return { ...day, title, sections, note: day.note || null };
}

function visibleSections(meal, { compact = false } = {}) {
  if (!meal?.sections?.length) return [];
  return meal.sections.filter(section => {
    if (!section.items?.length) return false;
    if (compact && section.category === 'Condiments') return false;
    return true;
  });
}

function sectionLabel(category, compact = false) {
  return (compact ? WEEK_LABELS[category] : CATEGORY_LABELS[category]) || category;
}

function renderDetailedSections(meal) {
  const sections = visibleSections(meal);
  if (!sections.length) {
    return `<p class="empty-copy">${escapeHtml(meal?.note || 'No menu details are listed.')}</p>`;
  }

  return `<div class="meal-sections">${sections.map(section => `
    <section class="meal-section">
      <div class="meal-section-label">${escapeHtml(sectionLabel(section.category))}</div>
      <ul class="meal-option-list">
        ${section.items.map(item => `<li class="meal-option">${escapeHtml(item)}</li>`).join('')}
      </ul>
    </section>`).join('')}</div>`;
}

function renderCompactSections(meal) {
  const sections = visibleSections(meal, { compact: true });
  if (!sections.length) {
    return `<p class="day-items">${escapeHtml(meal?.note || 'No menu listed')}</p>`;
  }

  return `<div class="week-lines">${sections.map(section => `
    <div class="week-line">
      <span class="week-line-label">${escapeHtml(sectionLabel(section.category, true))}</span>
      <span class="week-line-items">${escapeHtml(section.items.join(' • '))}</span>
    </div>`).join('')}</div>`;
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

  if ([0, 6].includes(now.getDay())) {
    els.todayMeal.innerHTML = `<div class="meal-kicker">${escapeHtml(state.meal)}</div><h3 class="empty-title">No school today</h3><p class="empty-copy">The weekly menu is below.</p>`;
    return;
  }

  if (!meal) {
    els.todayMeal.innerHTML = `<div class="meal-kicker">${escapeHtml(state.meal)}</div><h3 class="empty-title">No menu listed</h3><p class="empty-copy">The district source has no ${escapeHtml(state.meal)} entry for today.</p>`;
    return;
  }

  els.todayMeal.innerHTML = `
    <div class="meal-kicker">${escapeHtml(state.meal)}</div>
    ${renderDetailedSections(meal)}`;
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
          ${meal ? renderCompactSections(meal) : '<p class="day-items">No menu listed</p>'}
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

  const start = parseDate(state.data?.weekStart);
  const end = parseDate(state.data?.weekEnd);
  els.infoWeek.textContent = start && end
    ? `${formatDate(start, { month: 'short', day: 'numeric' })}–${formatDate(end, { month: 'short', day: 'numeric' })}`
    : 'Not available';

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
  return String(value).replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[c]));
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

els.infoButton.addEventListener('click', () => {
  renderStatus();
  els.infoDialog.showModal();
});

els.closeInfoButton.addEventListener('click', () => els.infoDialog.close());

els.infoDialog.addEventListener('click', (event) => {
  if (event.target === els.infoDialog) els.infoDialog.close();
});

els.refreshButton.addEventListener('click', async () => {
  els.refreshButton.disabled = true;
  els.refreshMessage.textContent = 'Checking for the newest menu…';
  await fetchData({ force: true });
  const status = getStatus();
  els.refreshMessage.textContent = state.loadError
    ? 'Refresh failed. Keeping the last saved menu.'
    : `Refresh complete — ${status.label}.`;
  els.refreshButton.disabled = false;
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
}

render();
fetchData();

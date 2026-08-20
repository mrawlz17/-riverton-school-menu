import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const ORG_ID = '1681';
const SITE_ID = '11709';
const SITE_NAME = 'Riverton K-12';
const ORG_URL = `https://menus.healthepro.com/organizations/${ORG_ID}`;
const MENU_API = `https://menus.healthepro.com/api/organizations/${ORG_ID}/sites/${SITE_ID}/menus/`;
const OUT = new URL('../menu-data.json', import.meta.url);
const DEBUG = new URL('../sync-debug.json', import.meta.url);

process.env.TZ = 'America/Chicago';
const now = new Date();

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

const targetDate = new Date(now);
if (now.getDay() === 6) targetDate.setDate(targetDate.getDate() + 2);
if (now.getDay() === 0) targetDate.setDate(targetDate.getDate() + 1);

const weekStartDate = mondayOf(targetDate);
const weekEndDate = new Date(weekStartDate);
weekEndDate.setDate(weekEndDate.getDate() + 4);
const weekStart = isoDate(weekStartDate);
const weekEnd = isoDate(weekEndDate);
const targetMonth = `${weekStart.slice(0, 7)}-01`;

const debug = {
  startedAt: now.toISOString(),
  orgUrl: ORG_URL,
  site: { id: SITE_ID, name: SITE_NAME },
  targetWeek: { start: weekStart, end: weekEnd },
  selectedMenus: {},
  pages: {},
  notes: []
};

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function stripMarkers(value) {
  return clean(value)
    .replace(/^[•·▪◦‣⁃\-–—]+\s*/u, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\uFE0E\uFE0F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFullDate(line) {
  const match = clean(line).match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(20\d{2})$/i);
  if (!match) return null;
  const d = new Date(`${match[2]} ${match[3]}, ${match[4]} 12:00:00`);
  return Number.isNaN(d.getTime()) ? null : isoDate(d);
}

const CATEGORY_MAP = new Map([
  ['breakfast entree', 'Breakfast Entree'],
  ['lunch entree', 'Lunch Entree'],
  ['entree', 'Entree'],
  ['pizzeria', 'Pizzeria'],
  ['alternate choices', 'Alternate Choices'],
  ['vegetables', 'Vegetables'],
  ['vegetable', 'Vegetables'],
  ['fruit', 'Fruit'],
  ['grains', 'Grains'],
  ['grain', 'Grains'],
  ['milk', 'Milk'],
  ['misc.', 'Misc.'],
  ['misc', 'Misc.'],
  ['desserts', 'Desserts'],
  ['dessert', 'Desserts'],
  ['condiments', 'Condiments']
]);

function categoryName(line) {
  return CATEGORY_MAP.get(clean(line).toLowerCase()) || null;
}

function isPageJunk(line) {
  return /^(Month|Week|Build a Meal|Dietary Preferences|Select Language|Print Menu|Reset Print|Skip to Print Options)$/i.test(clean(line)) ||
    /^(Abkhaz|Acehnese|Acholi|Afar|Afrikaans|Albanian|Alur|Amharic|Arabic|Armenian|Assamese|Avar|Awadhi)$/i.test(clean(line));
}

function mergeWith(items) {
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = stripMarkers(items[i]);
    if (!item) continue;

    if (/^with$/i.test(item) && out.length && i + 1 < items.length) {
      const next = stripMarkers(items[++i]);
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

function parseDayBlock(lines, meal) {
  const sections = [];
  let current = null;
  let note = null;

  for (const raw of lines) {
    const line = clean(raw);
    if (!line || isPageJunk(line)) continue;
    if (/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)$/i.test(line)) continue;
    if (/^\d{1,2}$/.test(line)) continue;

    if (/^(No School|School Closed|No Menu)$/i.test(line)) {
      note = line;
      continue;
    }

    const category = categoryName(line);
    if (category) {
      current = { category, items: [] };
      sections.push(current);
      continue;
    }

    if (!current) continue;
    current.items.push(line);
  }

  for (const section of sections) {
    section.items = mergeWith(section.items);
  }

  const cleanSections = sections.filter(section => section.items.length);
  const mainNames = meal === 'breakfast'
    ? ['Breakfast Entree', 'Entree']
    : ['Lunch Entree', 'Entree', 'Pizzeria', 'Alternate Choices'];

  const main = cleanSections.find(section => mainNames.includes(section.category));
  const title = main?.items?.[0] || note || 'Menu posted';
  const items = cleanSections.flatMap(section => [section.category, ...section.items]);

  return { title, items, sections: cleanSections, note };
}

function parseMenuPage(bodyText, meal) {
  const lines = String(bodyText ?? '').split(/\n/).map(clean).filter(Boolean);
  const allAnchors = [];

  // Capture EVERY dated menu block on the page, not only the target week.
  // That way Friday stops at the following Monday instead of consuming
  // the rest of the month/page footer.
  for (let i = 0; i < lines.length; i++) {
    const date = parseFullDate(lines[i]);
    if (date) allAnchors.push({ index: i, date });
  }

  const records = [];
  for (let a = 0; a < allAnchors.length; a++) {
    const anchor = allAnchors[a];
    if (anchor.date < weekStart || anchor.date > weekEnd) continue;

    const start = anchor.index + 1;
    const end = a + 1 < allAnchors.length ? allAnchors[a + 1].index : lines.length;
    const parsed = parseDayBlock(lines.slice(start, end), meal);

    if (parsed.sections.length || parsed.note) {
      records.push({ date: anchor.date, ...parsed });
    }
  }

  const byDate = new Map();
  for (const record of records) {
    const old = byDate.get(record.date);
    const score = record.sections.reduce((n, section) => n + section.items.length, 0);
    const oldScore = old ? old.sections.reduce((n, section) => n + section.items.length, 0) : -1;
    if (!old || score > oldScore) byDate.set(record.date, record);
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function menuScore(menu, meal) {
  const name = clean(menu.public_name || menu.custom_name || menu.name);
  const lower = name.toLowerCase();
  const expectedType = meal === 'breakfast' ? 1 : 2;

  if (Number(menu.meal_type_id) !== expectedType) return -10000;
  if (Array.isArray(menu.published_months) && menu.published_months.length && !menu.published_months.includes(targetMonth)) return -5000;

  let score = 100;

  if (meal === 'breakfast') {
    if (/\bk\s*[-–]\s*12\b/i.test(name)) score += 1000;
    if (/2nd\s+chance/i.test(name)) score -= 1000;
    if (/breakfast/i.test(lower)) score += 100;
  } else {
    if (/\bk\s*[-–]\s*3\b/i.test(name)) score += 1500;
    else if (/\bk\s*[-–]\s*5\b/i.test(name)) score += 900;
    else if (/elementary/i.test(name)) score += 700;
    if (/\b4\s*[-–]\s*5\b|\b6\s*[-–]\s*8\b|\bhs\b|high school/i.test(name)) score -= 900;
    if (/lunch/i.test(lower)) score += 100;
  }

  return score;
}

function chooseMenu(menus, meal) {
  return [...menus]
    .map(menu => ({ menu, score: menuScore(menu, meal) }))
    .sort((a, b) => b.score - a.score)[0]?.menu || null;
}

async function getMenus(page) {
  const response = await page.request.get(MENU_API, { timeout: 15000 });
  if (!response.ok()) throw new Error(`Menu list API returned HTTP ${response.status()}.`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error('Menu list API returned an unexpected response.');
  return body.data;
}

async function scrapeMeal(page, menu, meal) {
  const menuName = clean(menu.public_name || menu.custom_name || menu.name);
  const url = `${ORG_URL}/sites/${SITE_ID}/menus/${menu.id}?date=${weekStart}`;

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);

  const bodyText = await page.locator('body').innerText();
  let records = parseMenuPage(bodyText, meal);

  debug.pages[meal] = {
    menuId: menu.id,
    menuName,
    url: page.url(),
    recordCount: records.length,
    bodyPreview: bodyText.slice(0, 30000)
  };

  if (records.length < 4) {
    const printUrl = `${ORG_URL}/sites/${SITE_ID}/menus/${menu.id}/print-menu?date=${weekStart}`;
    try {
      await page.goto(printUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1800);
      const printText = await page.locator('body').innerText();
      const printed = parseMenuPage(printText, meal);
      const merged = new Map([...records, ...printed].map(record => [record.date, record]));
      records = [...merged.values()].sort((a, b) => a.date.localeCompare(b.date));
      debug.pages[`${meal}Print`] = { url: page.url(), recordCount: printed.length, bodyPreview: printText.slice(0, 30000) };
    } catch (error) {
      debug.notes.push(`${meal} print page failed: ${error.message}`);
    }
  }

  return records;
}

let previous = null;
try {
  previous = JSON.parse(await readFile(OUT, 'utf8'));
} catch {}

const browser = await chromium.launch({ headless: true });
let breakfast = [];
let lunch = [];
let error = null;

try {
  const context = await browser.newContext({ locale: 'en-US', timezoneId: 'America/Chicago' });
  const page = await context.newPage();
  const menus = await getMenus(page);

  const breakfastMenu = chooseMenu(menus, 'breakfast');
  const lunchMenu = chooseMenu(menus, 'lunch');

  if (!breakfastMenu) throw new Error('No published breakfast menu was found for the target month.');
  if (!lunchMenu) throw new Error('No published third-grade lunch menu was found for the target month.');

  debug.selectedMenus.breakfast = {
    id: breakfastMenu.id,
    name: breakfastMenu.public_name || breakfastMenu.custom_name || breakfastMenu.name,
    score: menuScore(breakfastMenu, 'breakfast')
  };
  debug.selectedMenus.lunch = {
    id: lunchMenu.id,
    name: lunchMenu.public_name || lunchMenu.custom_name || lunchMenu.name,
    score: menuScore(lunchMenu, 'lunch')
  };

  breakfast = await scrapeMeal(page, breakfastMenu, 'breakfast');
  lunch = await scrapeMeal(page, lunchMenu, 'lunch');

  await context.close();

  if (!breakfast.length && !lunch.length) {
    throw new Error('The correct Health-e Pro menus loaded, but no school-week entries could be parsed.');
  }
} catch (err) {
  error = err;
  debug.error = err?.stack || String(err);
} finally {
  await browser.close();
}

if (error) {
  await writeFile(DEBUG, JSON.stringify(debug, null, 2) + '\n');

  if (previous && (previous.breakfast?.length || previous.lunch?.length)) {
    previous.sync = {
      status: 'failed',
      message: String(error.message || error),
      attemptedAt: new Date().toISOString()
    };
    await writeFile(OUT, JSON.stringify(previous, null, 2) + '\n');
    console.error('Menu sync failed; preserved previous good menu.');
    process.exit(0);
  }

  throw error;
}

const data = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  weekStart,
  weekEnd,
  source: {
    district: 'Riverton USD 404',
    school: 'Riverton Elementary School',
    sourceSite: SITE_NAME,
    grade: '3rd Grade',
    provider: 'Health-e Pro / My School Menus',
    url: ORG_URL,
    breakfastMenu: debug.selectedMenus.breakfast,
    lunchMenu: debug.selectedMenus.lunch
  },
  breakfast,
  lunch,
  sync: {
    status: 'ok',
    message: `Pulled ${breakfast.length} breakfast day(s) and ${lunch.length} lunch day(s).`
  }
};

await writeFile(OUT, JSON.stringify(data, null, 2) + '\n');
await writeFile(DEBUG, JSON.stringify(debug, null, 2) + '\n');
console.log(data.sync.message);

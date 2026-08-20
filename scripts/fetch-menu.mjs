import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const ORG_URL = 'https://menus.healthepro.com/organizations/1681';
const SCHOOL = 'Riverton Elementary School';
const OUT = new URL('../menu-data.json', import.meta.url);
const DEBUG = new URL('../sync-debug.json', import.meta.url);

process.env.TZ = 'America/Chicago';
const now = new Date();

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function mondayOf(date) {
  const d = new Date(date);
  d.setHours(12, 0, 0, 0);
  const day = d.getDay();
  d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
  return d;
}

// Weekday manual runs use the current school week.
// Saturday/Sunday runs pull the upcoming school week.
const targetDate = new Date(now);

if (now.getDay() === 6) {
  targetDate.setDate(targetDate.getDate() + 2);
}

if (now.getDay() === 0) {
  targetDate.setDate(targetDate.getDate() + 1);
}

const weekStartDate = mondayOf(targetDate);
const weekEndDate = new Date(weekStartDate);
weekEndDate.setDate(weekEndDate.getDate() + 4);

const weekStart = isoDate(weekStartDate);
const weekEnd = isoDate(weekEndDate);

const debug = {
  startedAt: now.toISOString(),
  orgUrl: ORG_URL,
  school: SCHOOL,
  targetWeek: {
    start: weekStart,
    end: weekEnd
  },
  urls: [],
  jsonResponses: [],
  notes: []
};

function clean(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniq(items) {
  return [...new Set(items.filter(Boolean))];
}

async function clickFirst(page, locators) {
  for (const loc of locators) {
    try {
      const count = await loc.count();

      if (count && await loc.first().isVisible()) {
        await loc.first().click({ timeout: 3500 });
        await page.waitForTimeout(700);
        return true;
      }
    } catch {}
  }

  return false;
}

async function chooseSchool(page) {
  const selects = page.locator('select');

  for (let i = 0; i < await selects.count(); i++) {
    const sel = selects.nth(i);

    try {
      const options = await sel.locator('option').allTextContents();

      const idx = options.findIndex(t =>
        /Riverton Elementary/i.test(t)
      );

      if (idx >= 0) {
        await sel.selectOption({ index: idx });
        await page.waitForTimeout(700);
        return true;
      }
    } catch {}
  }

  const inputs = page.locator('input');

  for (let i = 0; i < await inputs.count(); i++) {
    const input = inputs.nth(i);

    try {
      if (!await input.isVisible()) continue;

      const meta =
        `${await input.getAttribute('placeholder') || ''} ` +
        `${await input.getAttribute('aria-label') || ''} ` +
        `${await input.getAttribute('name') || ''}`;

      if (/school|site|location|name/i.test(meta)) {
        await input.fill('Riverton Elementary');
        await page.waitForTimeout(1000);

        const picked = await clickFirst(page, [
          page.getByRole('option', {
            name: /Riverton Elementary/i
          }),
          page.locator('[role="option"]').filter({
            hasText: /Riverton Elementary/i
          }),
          page.getByText(SCHOOL, { exact: true }),
          page.getByText(/Riverton Elementary/i)
        ]);

        if (picked) {
          await page.waitForTimeout(800);
          return true;
        }
      }
    } catch {}
  }

  return clickFirst(page, [
    page.getByText(SCHOOL, { exact: true }),
    page.getByText(/Riverton Elementary/i),
    page.getByRole('button', {
      name: /Riverton Elementary/i
    }),
    page.getByRole('option', {
      name: /Riverton Elementary/i
    })
  ]);
}

async function chooseMeal(page, meal) {
  const re = new RegExp(meal, 'i');

  // First try normal select elements.
  const selects = page.locator('select');

  for (let i = 0; i < await selects.count(); i++) {
    const sel = selects.nth(i);

    try {
      const options = await sel.locator('option').allTextContents();
      const idx = options.findIndex(t => re.test(t));

      if (idx >= 0) {
        await sel.selectOption({ index: idx });
        await page.waitForTimeout(800);
        return true;
      }
    } catch {}
  }

  // Health-e Pro currently uses a searchable Menu input.
  const inputs = page.locator('input');

  for (let i = 0; i < await inputs.count(); i++) {
    const input = inputs.nth(i);

    try {
      if (!await input.isVisible()) continue;

      const meta =
        `${await input.getAttribute('placeholder') || ''} ` +
        `${await input.getAttribute('aria-label') || ''} ` +
        `${await input.getAttribute('name') || ''}`;

      if (/menu|meal/i.test(meta)) {
        await input.fill(meal);
        await page.waitForTimeout(1000);

        const picked = await clickFirst(page, [
          page.getByRole('option', { name: re }),
          page.locator('[role="option"]').filter({
            hasText: re
          }),
          page.getByText(re)
        ]);

        if (picked) {
          await page.waitForTimeout(800);
          return true;
        }
      }
    } catch {}
  }

  // Final fallback.
  return clickFirst(page, [
    page.getByRole('link', { name: re }),
    page.getByRole('button', { name: re }),
    page.getByRole('option', { name: re }),
    page.getByText(re)
  ]);
}

async function maybeSubmit(page) {
  await clickFirst(page, [
    page.getByRole('button', { name: /^go$/i }),
    page.getByRole('button', { name: /view menu/i }),
    page.getByRole('button', { name: /continue/i }),
    page.getByRole('button', { name: /submit/i }),
    page.getByRole('button', { name: /search/i })
  ]);
}

function dateFromText(
  text,
  fallbackYear = now.getFullYear()
) {
  const full = text.match(
    /\b(20\d{2})-(\d{2})-(\d{2})\b/
  );

  if (full) {
    return full[0];
  }

  const slash = text.match(
    /\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/
  );

  if (slash) {
    let y = slash[3]
      ? Number(slash[3])
      : fallbackYear;

    if (y < 100) y += 2000;

    return (
      `${y}-` +
      `${String(slash[1]).padStart(2, '0')}-` +
      `${String(slash[2]).padStart(2, '0')}`
    );
  }

  const named = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(20\d{2}))?/i
  );

  if (named) {
    const d = new Date(
      `${named[1]} ${named[2]}, ${named[3] || fallbackYear} 12:00:00`
    );

    if (!Number.isNaN(d.getTime())) {
      return isoDate(d);
    }
  }

  return null;
}

function trimBoilerplate(lines) {
  const stop =
    /nutrition|allergen|ingredients|calories|carbohydrate|sodium|fat|protein|build a meal|print|translate|menu info|meal price/i;

  return lines
    .filter(x => x && !stop.test(x))
    .slice(0, 12);
}

async function extractFromDom(page) {
  return page.evaluate(() => {
    const candidates = [];

    const dateish =
      /20\d{2}-\d{2}-\d{2}|\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/i;

    const selectors = [
      '[data-date]',
      'time[datetime]',
      '[class*="day"]',
      '[class*="date"]',
      '[class*="calendar"]',
      '[class*="menu"]',
      'article',
      '[role="listitem"]',
      'li'
    ];

    const seen = new Set();

    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        const text =
          (el.innerText || el.textContent || '')
            .replace(/\r/g, '')
            .trim();

        const key = text.replace(/\s+/g, ' ');

        if (
          !text ||
          text.length > 2200 ||
          !dateish.test(text)
        ) {
          continue;
        }

        if (seen.has(key)) continue;

        seen.add(key);

        candidates.push({
          text,
          dataDate: el.getAttribute('data-date'),
          datetime:
            el.getAttribute('datetime') ||
            el.querySelector('time')
              ?.getAttribute('datetime') ||
            null
        });
      }
    }

    return {
      bodyText: document.body.innerText,
      candidates,
      url: location.href,
      title: document.title
    };
  });
}

function recordsFromDom(raw) {
  const records = [];

  for (const c of raw.candidates || []) {
    const date = dateFromText(
      `${c.dataDate || ''} ` +
      `${c.datetime || ''} ` +
      `${c.text}`
    );

    if (
      !date ||
      date < weekStart ||
      date > weekEnd
    ) {
      continue;
    }

    let lines = c.text
      .split(/\n|\s{2,}| • /)
      .map(clean)
      .filter(Boolean);

    lines = lines.filter(
      x =>
        !dateFromText(x) &&
        !/^(mon|tue|wed|thu|fri|sat|sun)(day)?$/i
          .test(x)
    );

    lines = trimBoilerplate(uniq(lines));

    if (!lines.length) continue;

    records.push({
      date,
      title: lines[0],
      items: lines.slice(1)
    });
  }

  const byDate = new Map();

  for (const r of records) {
    if (
      !byDate.has(r.date) ||
      r.items.length > byDate.get(r.date).items.length
    ) {
      byDate.set(r.date, r);
    }
  }

  return [...byDate.values()].sort(
    (a, b) => a.date.localeCompare(b.date)
  );
}

function recursiveStrings(
  value,
  path = '',
  out = []
) {
  if (typeof value === 'string') {
    out.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((v, i) =>
      recursiveStrings(
        v,
        `${path}[${i}]`,
        out
      )
    );
  } else if (
    value &&
    typeof value === 'object'
  ) {
    Object.entries(value).forEach(
      ([k, v]) =>
        recursiveStrings(
          v,
          path ? `${path}.${k}` : k,
          out
        )
    );
  }

  return out;
}

function recordsFromJson(
  jsonPayloads,
  meal
) {
  const recs = [];

  for (const payload of jsonPayloads) {
    const strings = recursiveStrings(payload.body);

    const dated = strings.filter(s =>
      dateFromText(s.value)
    );

    for (const d of dated) {
      const date = dateFromText(d.value);

      if (
        !date ||
        date < weekStart ||
        date > weekEnd
      ) {
        continue;
      }

      const prefix =
        d.path.replace(/\.[^.]+$/, '');

      const nearby = strings
        .filter(s =>
          s.path.startsWith(prefix)
        )
        .map(s => clean(s.value));

      if (
        !nearby.some(x =>
          new RegExp(meal, 'i').test(x)
        ) &&
        nearby.some(x =>
          /breakfast|lunch/i.test(x)
        )
      ) {
        continue;
      }

      const filtered =
        trimBoilerplate(
          uniq(
            nearby.filter(
              x =>
                x.length < 180 &&
                !dateFromText(x) &&
                !/^https?:/i.test(x)
            )
          )
        );

      if (filtered.length) {
        recs.push({
          date,
          title: filtered[0],
          items: filtered.slice(1)
        });
      }
    }
  }

  const byDate = new Map();

  for (const r of recs) {
    if (
      !byDate.has(r.date) ||
      r.items.length > byDate.get(r.date).items.length
    ) {
      byDate.set(r.date, r);
    }
  }

  return [...byDate.values()].sort(
    (a, b) => a.date.localeCompare(b.date)
  );
}

async function scrapeMeal(
  browser,
  meal
) {
  const context =
    await browser.newContext({
      locale: 'en-US',
      timezoneId: 'America/Chicago'
    });

  const page = await context.newPage();
  const jsonPayloads = [];

  page.on(
    'response',
    async response => {
      const type =
        response.headers()['content-type'] || '';

      if (!type.includes('json')) return;

      try {
        const body = await response.json();

        jsonPayloads.push({
          url: response.url(),
          body
        });
      } catch {}
    }
  );

  page.on(
    'framenavigated',
    frame => {
      if (frame === page.mainFrame()) {
        debug.urls.push(frame.url());
      }
    }
  );

  await page.goto(
    ORG_URL,
    {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    }
  );

  await page.waitForTimeout(2500);

  const schoolChosen =
    await chooseSchool(page);

  await maybeSubmit(page);
  await page.waitForTimeout(1200);

  const mealChosen =
    await chooseMeal(page, meal);

  await maybeSubmit(page);
  await page.waitForTimeout(1800);

  try {
    const selected =
      new URL(page.url());

    if (
      /\/menus\/\d+/.test(
        selected.pathname
      )
    ) {
      selected.searchParams.set(
        'calendarView',
        'week'
      );

      selected.searchParams.set(
        'week',
        weekStart
      );

      await page.goto(
        selected.toString(),
        {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        }
      );

      await page.waitForTimeout(2500);
    }
  } catch {}

  debug.notes.push(
    `${meal}: ` +
    `schoolChosen=${schoolChosen}, ` +
    `mealChosen=${mealChosen}, ` +
    `targetWeek=${weekStart}, ` +
    `final=${page.url()}`
  );

  const raw =
    await extractFromDom(page);

  debug[`${meal}Page`] = {
    url: raw.url,
    title: raw.title,
    bodyText:
      raw.bodyText.slice(0, 20000),
    candidates:
      raw.candidates.slice(0, 120)
  };

  debug.jsonResponses.push(
    ...jsonPayloads.map(p => ({
      meal,
      url: p.url
    }))
  );

  let records =
    recordsFromDom(raw);

  if (records.length < 3) {
    const jsonRecords =
      recordsFromJson(
        jsonPayloads,
        meal
      );

    const map = new Map(
      [...records, ...jsonRecords]
        .map(r => [r.date, r])
    );

    records = [...map.values()]
      .sort(
        (a, b) =>
          a.date.localeCompare(b.date)
      );
  }

  await context.close();

  return records;
}

let previous;

try {
  previous = JSON.parse(
    await readFile(
      OUT,
      'utf8'
    )
  );
} catch {
  previous = null;
}

const browser =
  await chromium.launch({
    headless: true
  });

let breakfast = [];
let lunch = [];
let error = null;

try {
  breakfast =
    await scrapeMeal(
      browser,
      'breakfast'
    );

  lunch =
    await scrapeMeal(
      browser,
      'lunch'
    );

  if (
    breakfast.length < 1 &&
    lunch.length < 1
  ) {
    throw new Error(
      'Health-e Pro loaded, but no current-week menu entries could be parsed.'
    );
  }
} catch (e) {
  error = e;

  debug.error =
    e?.stack ||
    String(e);
} finally {
  await browser.close();
}

if (error) {
  await writeFile(
    DEBUG,
    JSON.stringify(
      debug,
      null,
      2
    ) + '\n'
  );

  if (
    previous &&
    (
      previous.breakfast?.length ||
      previous.lunch?.length
    )
  ) {
    previous.sync = {
      status: 'failed',
      message:
        String(
          error.message || error
        ),
      attemptedAt:
        new Date().toISOString()
    };

    await writeFile(
      OUT,
      JSON.stringify(
        previous,
        null,
        2
      ) + '\n'
    );

    console.error(
      'Menu sync failed; preserved previous good menu.'
    );

    process.exit(0);
  }

  throw error;
}

const data = {
  schemaVersion: 1,
  generatedAt:
    new Date().toISOString(),

  weekStart,
  weekEnd,

  source: {
    district:
      'Riverton USD 404',

    school:
      SCHOOL,

    grade:
      '3rd Grade',

    provider:
      'Health-e Pro / My School Menus',

    url:
      ORG_URL
  },

  breakfast,
  lunch,

  sync: {
    status: 'ok',

    message:
      `Pulled ${breakfast.length} breakfast day(s) and ` +
      `${lunch.length} lunch day(s).`
  }
};

await writeFile(
  OUT,
  JSON.stringify(
    data,
    null,
    2
  ) + '\n'
);

await writeFile(
  DEBUG,
  JSON.stringify(
    debug,
    null,
    2
  ) + '\n'
);

console.log(
  data.sync.message
);

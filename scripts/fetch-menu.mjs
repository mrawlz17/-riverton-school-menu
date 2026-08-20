import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const ORG_ID = '1681';
const ORG_URL =
  `https://menus.healthepro.com/organizations/${ORG_ID}`;

const SCHOOL_HINT =
  /Riverton\s+Elementary/i;

const OUT =
  new URL('../menu-data.json', import.meta.url);

const DEBUG =
  new URL('../sync-debug.json', import.meta.url);

process.env.TZ = 'America/Chicago';

const now = new Date();

function isoDate(d) {
  const y = d.getFullYear();

  const m =
    String(d.getMonth() + 1)
      .padStart(2, '0');

  const day =
    String(d.getDate())
      .padStart(2, '0');

  return `${y}-${m}-${day}`;
}

function mondayOf(date) {
  const d = new Date(date);

  d.setHours(
    12,
    0,
    0,
    0
  );

  const day =
    d.getDay();

  d.setDate(
    d.getDate() +
    (
      day === 0
        ? -6
        : 1 - day
    )
  );

  return d;
}

// Manual weekday runs use the current school week.
// Saturday/Sunday runs target the upcoming school week.
const targetDate =
  new Date(now);

if (now.getDay() === 6) {
  targetDate.setDate(
    targetDate.getDate() + 2
  );
}

if (now.getDay() === 0) {
  targetDate.setDate(
    targetDate.getDate() + 1
  );
}

const weekStartDate =
  mondayOf(targetDate);

const weekEndDate =
  new Date(weekStartDate);

weekEndDate.setDate(
  weekEndDate.getDate() + 4
);

const weekStart =
  isoDate(weekStartDate);

const weekEnd =
  isoDate(weekEndDate);

const debug = {
  startedAt:
    now.toISOString(),

  orgUrl:
    ORG_URL,

  targetWeek: {
    start: weekStart,
    end: weekEnd
  },

  captures: [],
  schoolCandidates: [],
  mealAttempts: [],
  notes: []
};

function clean(value) {
  return String(
    value ?? ''
  )
    .replace(/\s+/g, ' ')
    .trim();
}

function uniq(items) {
  return [
    ...new Set(
      items.filter(Boolean)
    )
  ];
}

function safeJsonPreview(
  value,
  max = 30000
) {
  try {
    const text =
      JSON.stringify(value);

    return text.length > max
      ? `${text.slice(
          0,
          max
        )}…[truncated]`
      : text;
  } catch {
    return '[unserializable]';
  }
}

function walk(
  value,
  path = '',
  out = []
) {
  if (Array.isArray(value)) {
    value.forEach(
      (item, i) =>
        walk(
          item,
          `${path}[${i}]`,
          out
        )
    );

    return out;
  }

  if (
    !value ||
    typeof value !== 'object'
  ) {
    return out;
  }

  const entries =
    Object.entries(value);

  const nameEntry =
    entries.find(
      ([key, val]) =>
        /^(name|title|label|description|siteName|menuName)$/i
          .test(key) &&
        typeof val === 'string' &&
        clean(val)
    );

  const idEntry =
    entries.find(
      ([key, val]) =>
        /^(id|value|siteId|menuId|site_id|menu_id)$/i
          .test(key) &&
        (
          typeof val === 'number' ||
          typeof val === 'string'
        ) &&
        clean(val)
    );

  if (nameEntry) {
    out.push({
      path,

      name:
        clean(nameEntry[1]),

      id:
        idEntry
          ? String(idEntry[1])
          : null
    });
  }

  for (
    const [key, val]
    of entries
  ) {
    if (
      val &&
      typeof val === 'object'
    ) {
      walk(
        val,
        path
          ? `${path}.${key}`
          : key,
        out
      );
    }
  }

  return out;
}

function chooseBestEntity(
  entities,
  regex
) {
  const matching =
    entities.filter(
      e =>
        regex.test(e.name)
    );

  if (!matching.length) {
    return null;
  }

  return matching.sort(
    (a, b) => {
      const aExact =
        /^Riverton\s+Elementary(?:\s+School)?$/i
          .test(a.name)
          ? 1
          : 0;

      const bExact =
        /^Riverton\s+Elementary(?:\s+School)?$/i
          .test(b.name)
          ? 1
          : 0;

      return (
        bExact -
        aExact ||
        a.name.length -
        b.name.length
      );
    }
  )[0];
}

function dateFromText(
  text,
  fallbackYear =
    now.getFullYear()
) {
  const full =
    String(text).match(
      /\b(20\d{2})-(\d{2})-(\d{2})\b/
    );

  if (full) {
    return full[0];
  }

  const slash =
    String(text).match(
      /\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/
    );

  if (slash) {
    let year =
      slash[3]
        ? Number(slash[3])
        : fallbackYear;

    if (year < 100) {
      year += 2000;
    }

    return (
      `${year}-` +
      `${String(
        slash[1]
      ).padStart(2, '0')}-` +
      `${String(
        slash[2]
      ).padStart(2, '0')}`
    );
  }

  const named =
    String(text).match(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(20\d{2}))?/i
    );

  if (named) {
    const d =
      new Date(
        `${named[1]} ` +
        `${named[2]}, ` +
        `${named[3] || fallbackYear} ` +
        `12:00:00`
      );

    if (
      !Number.isNaN(
        d.getTime()
      )
    ) {
      return isoDate(d);
    }
  }

  return null;
}

function trimBoilerplate(
  lines
) {
  const stop =
    /nutrition|allergen|ingredients|calories|carbohydrate|sodium|protein|build a meal|print|translate|menu info|meal price|powered by|terms of service|privacy policy/i;

  return lines
    .filter(
      x =>
        x &&
        !stop.test(x)
    )
    .slice(0, 15);
}

function recordsFromCandidates(
  candidates
) {
  const records = [];

  for (
    const candidate
    of candidates || []
  ) {
    const date =
      dateFromText(
        `${candidate.dataDate || ''} ` +
        `${candidate.datetime || ''} ` +
        `${candidate.text || ''}`
      );

    if (
      !date ||
      date < weekStart ||
      date > weekEnd
    ) {
      continue;
    }

    let lines =
      String(
        candidate.text || ''
      )
        .split(
          /\n|\s{2,}| • /
        )
        .map(clean)
        .filter(Boolean);

    lines =
      lines.filter(
        line =>
          !dateFromText(line) &&
          !/^(mon|tue|wed|thu|fri|sat|sun)(day)?$/i
            .test(line) &&
          !/^\d{1,2}$/
            .test(line)
      );

    lines =
      trimBoilerplate(
        uniq(lines)
      );

    if (!lines.length) {
      continue;
    }

    records.push({
      date,

      title:
        lines[0],

      items:
        lines.slice(1)
    });
  }

  const byDate =
    new Map();

  for (
    const record
    of records
  ) {
    const old =
      byDate.get(
        record.date
      );

    if (
      !old ||
      record.items.length >
        old.items.length
    ) {
      byDate.set(
        record.date,
        record
      );
    }
  }

  return [
    ...byDate.values()
  ].sort(
    (a, b) =>
      a.date.localeCompare(
        b.date
      )
  );
}

async function extractPage(
  page
) {
  return page.evaluate(
    () => {
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

      const dateish =
        /20\d{2}-\d{2}-\d{2}|\b\d{1,2}[\/-]\d{1,2}(?:[\/-]\d{2,4})?\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}/i;

      const seen =
        new Set();

      const candidates = [];

      for (
        const selector
        of selectors
      ) {
        for (
          const el
          of document
            .querySelectorAll(
              selector
            )
        ) {
          const text =
            (
              el.innerText ||
              el.textContent ||
              ''
            )
              .replace(
                /\r/g,
                ''
              )
              .trim();

          const key =
            text.replace(
              /\s+/g,
              ' '
            );

          if (
            !text ||
            text.length > 2500 ||
            !dateish.test(text) ||
            seen.has(key)
          ) {
            continue;
          }

          seen.add(key);

          candidates.push({
            text,

            dataDate:
              el.getAttribute(
                'data-date'
              ),

            datetime:
              el.getAttribute(
                'datetime'
              ) ||
              el.querySelector(
                'time'
              )
                ?.getAttribute(
                  'datetime'
                ) ||
              null
          });
        }
      }

      return {
        url:
          location.href,

        title:
          document.title,

        bodyText:
          document.body.innerText,

        candidates
      };
    }
  );
}

async function getCombobox(
  page,
  index
) {
  const roleBoxes =
    page.getByRole(
      'combobox'
    );

  if (
    await roleBoxes.count() >
    index
  ) {
    return roleBoxes.nth(
      index
    );
  }

  const inputs =
    page.locator(
      'input:visible'
    );

  if (
    await inputs.count() >
    index
  ) {
    return inputs.nth(
      index
    );
  }

  return null;
}

async function visibleOptionTexts(
  page
) {
  const out = [];

  try {
    const roleOptions =
      page.getByRole(
        'option'
      );

    for (
      let i = 0;
      i <
      await roleOptions.count();
      i++
    ) {
      const option =
        roleOptions.nth(i);

      if (
        await option.isVisible()
      ) {
        out.push(
          clean(
            await option
              .innerText()
          )
        );
      }
    }
  } catch {}

  try {
    const fallback =
      page.locator(
        '[id*="option"]:visible'
      );

    for (
      let i = 0;
      i <
      await fallback.count();
      i++
    ) {
      const option =
        fallback.nth(i);

      out.push(
        clean(
          await option
            .innerText()
        )
      );
    }
  } catch {}

  return uniq(out);
}

async function chooseAutocomplete(
  page,
  index,
  terms,
  desiredRegex,
  debugKey
) {
  const box =
    await getCombobox(
      page,
      index
    );

  if (!box) {
    debug.notes.push(
      `${debugKey}: ` +
      `no combobox/input found ` +
      `at index ${index}`
    );

    return {
      ok: false,
      selected: null
    };
  }

  for (
    const term
    of uniq(
      terms.map(clean)
    )
  ) {
    if (!term) {
      continue;
    }

    try {
      await box.click({
        timeout: 3000
      });

      await box.fill('');

      await box.type(
        term,
        {
          delay: 35
        }
      );

      await page.waitForTimeout(
        900
      );

      const options =
        await visibleOptionTexts(
          page
        );

      debug.mealAttempts.push({
        key: debugKey,
        term,
        options:
          options.slice(
            0,
            30
          )
      });

      if (
        options.length
      ) {
        const wanted =
          options.find(
            text =>
              desiredRegex
                .test(text)
          ) ||
          options[0];

        const roleMatch =
          page.getByRole(
            'option',
            {
              name: wanted,
              exact: true
            }
          );

        if (
          await roleMatch.count()
        ) {
          await roleMatch
            .first()
            .click({
              timeout: 3000
            });

          await page
            .waitForTimeout(
              700
            );

          return {
            ok: true,
            selected: wanted
          };
        }

        const fallback =
          page.locator(
            '[id*="option"]:visible'
          )
            .filter({
              hasText: wanted
            });

        if (
          await fallback.count()
        ) {
          await fallback
            .first()
            .click({
              timeout: 3000
            });

          await page
            .waitForTimeout(
              700
            );

          return {
            ok: true,
            selected: wanted
          };
        }
      }

      // React Select also supports keyboard selection.
      await box.press(
        'ArrowDown'
      );

      await page
        .waitForTimeout(
          200
        );

      await box.press(
        'Enter'
      );

      await page
        .waitForTimeout(
          700
        );

      const body =
        clean(
          await page
            .locator('body')
            .innerText()
        );

      if (
        !/No results found/i
          .test(body)
      ) {
        return {
          ok: true,
          selected: term
        };
      }
    } catch (error) {
      debug.notes.push(
        `${debugKey}: ` +
        `term "${term}" failed: ` +
        `${error.message}`
      );
    }
  }

  return {
    ok: false,
    selected: null
  };
}

async function clickGo(
  page
) {
  const go =
    page.getByRole(
      'button',
      {
        name: /^go$/i
      }
    );

  if (
    await go.count()
  ) {
    await go
      .first()
      .click({
        timeout: 4000
      });

    return true;
  }

  const button =
    page.locator(
      'button'
    )
      .filter({
        hasText: /^Go$/i
      });

  if (
    await button.count()
  ) {
    await button
      .first()
      .click({
        timeout: 4000
      });

    return true;
  }

  return false;
}

async function probeMenuApis(
  page,
  siteId,
  captures
) {
  if (!siteId) {
    return [];
  }

  const urls = [
    `https://menus.healthepro.com/api/organizations/${ORG_ID}/sites/${siteId}/menus/list`,

    `https://menus.healthepro.com/api/organizations/${ORG_ID}/sites/${siteId}/menus`,

    `https://menus.healthepro.com/api/organizations/${ORG_ID}/menus/list?siteId=${siteId}`,

    `https://menus.healthepro.com/api/organizations/${ORG_ID}/menus?siteId=${siteId}`
  ];

  const found = [];

  for (
    const url
    of urls
  ) {
    try {
      const response =
        await page.request.get(
          url,
          {
            timeout: 10000
          }
        );

      const type =
        response.headers()[
          'content-type'
        ] || '';

      const item = {
        url,
        status:
          response.status(),

        contentType:
          type
      };

      if (
        response.ok() &&
        type.includes(
          'json'
        )
      ) {
        const body =
          await response.json();

        item.preview =
          safeJsonPreview(
            body,
            20000
          );

        captures.push({
          url,
          body
        });

        found.push(
          ...walk(body)
        );
      }

      debug.captures.push(
        item
      );
    } catch (error) {
      debug.captures.push({
        url,
        error:
          error.message
      });
    }
  }

  return found;
}

function pickSchoolFromCaptures(
  captures
) {
  const entities =
    captures.flatMap(
      item =>
        walk(item.body)
    );

  debug.schoolCandidates =
    entities
      .filter(
        e =>
          /riverton|elementary/i
            .test(e.name)
      )
      .slice(0, 50);

  return chooseBestEntity(
    entities,
    SCHOOL_HINT
  );
}

function pickMealFromCaptures(
  captures,
  meal
) {
  const regex =
    new RegExp(
      meal,
      'i'
    );

  const entities =
    captures.flatMap(
      item =>
        walk(item.body)
    );

  return (
    entities.find(
      e =>
        regex.test(e.name)
    ) ||
    null
  );
}

async function scrapeMeal(
  browser,
  meal
) {
  const context =
    await browser
      .newContext({
        locale: 'en-US',
        timezoneId:
          'America/Chicago'
      });

  const page =
    await context
      .newPage();

  const captures = [];

  page.on(
    'response',
    async response => {
      const type =
        response.headers()[
          'content-type'
        ] || '';

      if (
        !type.includes(
          'json'
        )
      ) {
        return;
      }

      try {
        const body =
          await response.json();

        captures.push({
          url:
            response.url(),
          body
        });

        if (
          /sites\/list|menus|menu/i
            .test(
              response.url()
            )
        ) {
          debug.captures.push({
            meal,

            url:
              response.url(),

            status:
              response.status(),

            preview:
              safeJsonPreview(
                body,
                30000
              )
          });
        }
      } catch {}
    }
  );

  await page.goto(
    ORG_URL,
    {
      waitUntil:
        'domcontentloaded',

      timeout:
        60000
    }
  );

  await page
    .waitForTimeout(
      2500
    );

  let school =
    pickSchoolFromCaptures(
      captures
    );

  if (!school) {
    // Allow the initial API call to finish.
    await page
      .waitForTimeout(
        1500
      );

    school =
      pickSchoolFromCaptures(
        captures
      );
  }

  const schoolTerms = [
    school?.name,
    'Riverton Elementary',
    'Riverton'
  ];

  const schoolPick =
    await chooseAutocomplete(
      page,
      0,
      schoolTerms,
      SCHOOL_HINT,
      `${meal}-school`
    );

  debug.notes.push(
    `${meal}: ` +
    `API school=` +
    `${
      school
        ? `${school.name} ` +
          `[${school.id ?? 'no id'}]`
        : 'not found'
    }, ` +
    `UI school=` +
    `${
      schoolPick.ok
        ? schoolPick.selected
        : 'failed'
    }`
  );

  await page
    .waitForTimeout(
      1200
    );

  let menu =
    pickMealFromCaptures(
      captures,
      meal
    );

  const probed =
    await probeMenuApis(
      page,
      school?.id,
      captures
    );

  if (!menu) {
    const regex =
      new RegExp(
        meal,
        'i'
      );

    menu =
      probed.find(
        e =>
          regex.test(e.name)
      ) ||
      pickMealFromCaptures(
        captures,
        meal
      );
  }

  const mealRegex =
    new RegExp(
      meal,
      'i'
    );

  const mealTerms = [
    menu?.name,
    meal
  ];

  const mealPick =
    await chooseAutocomplete(
      page,
      1,
      mealTerms,
      mealRegex,
      `${meal}-menu`
    );

  debug.notes.push(
    `${meal}: ` +
    `API menu=` +
    `${
      menu
        ? `${menu.name} ` +
          `[${menu.id ?? 'no id'}]`
        : 'not found'
    }, ` +
    `UI menu=` +
    `${
      mealPick.ok
        ? mealPick.selected
        : 'failed'
    }`
  );

  // Best case: use the actual IDs and bypass
  // the selector completely.
  if (
    school?.id &&
    menu?.id
  ) {
    const direct =
      `https://menus.healthepro.com/organizations/${ORG_ID}` +
      `/sites/${school.id}` +
      `/menus/${menu.id}` +
      `?date=${weekStart}`;

    debug.notes.push(
      `${meal}: ` +
      `trying direct menu URL ` +
      direct
    );

    await page.goto(
      direct,
      {
        waitUntil:
          'domcontentloaded',

        timeout:
          60000
      }
    );

    await page
      .waitForTimeout(
        2500
      );
  } else {
    const clicked =
      await clickGo(page);

    debug.notes.push(
      `${meal}: ` +
      `Go clicked=${clicked}`
    );

    if (clicked) {
      try {
        await page.waitForURL(
          url =>
            /\/sites\/\d+\/menus\/\d+/
              .test(
                url.pathname
              ),

          {
            timeout:
              10000
          }
        );
      } catch {}

      await page
        .waitForTimeout(
          2000
        );
    }
  }

  // Make sure Health-e Pro is showing
  // the week we actually want.
  try {
    const current =
      new URL(
        page.url()
      );

    if (
      /\/sites\/\d+\/menus\/\d+/
        .test(
          current.pathname
        )
    ) {
      current
        .searchParams
        .set(
          'date',
          weekStart
        );

      await page.goto(
        current.toString(),
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            60000
        }
      );

      await page
        .waitForTimeout(
          2200
        );
    }
  } catch {}

  const raw =
    await extractPage(
      page
    );

  debug[`${meal}Page`] = {
    url:
      raw.url,

    title:
      raw.title,

    bodyText:
      raw.bodyText.slice(
        0,
        25000
      ),

    candidates:
      raw.candidates.slice(
        0,
        150
      )
  };

  let records =
    recordsFromCandidates(
      raw.candidates
    );

  // Also capture Health-e Pro's printable page.
  // This gives us a second parsing path
  // and much better diagnostics if needed.
  if (
    /\/sites\/\d+\/menus\/\d+/
      .test(
        page.url()
      )
  ) {
    try {
      const printUrl =
        page.url()
          .replace(
            /\?.*$/,
            ''
          )
          .replace(
            /\/$/,
            ''
          ) +
        `/print-menu?date=${weekStart}`;

      await page.goto(
        printUrl,
        {
          waitUntil:
            'domcontentloaded',

          timeout:
            60000
        }
      );

      await page
        .waitForTimeout(
          1800
        );

      const printed =
        await extractPage(
          page
        );

      debug[
        `${meal}PrintPage`
      ] = {
        url:
          printed.url,

        title:
          printed.title,

        bodyText:
          printed.bodyText.slice(
            0,
            30000
          ),

        candidates:
          printed.candidates.slice(
            0,
            150
          )
      };

      if (
        records.length < 3
      ) {
        const fromPrint =
          recordsFromCandidates(
            printed.candidates
          );

        const merged =
          new Map(
            [
              ...records,
              ...fromPrint
            ].map(
              r => [
                r.date,
                r
              ]
            )
          );

        records =
          [
            ...merged.values()
          ].sort(
            (a, b) =>
              a.date.localeCompare(
                b.date
              )
          );
      }
    } catch (error) {
      debug.notes.push(
        `${meal}: ` +
        `print page failed: ` +
        `${error.message}`
      );
    }
  }

  await context.close();

  return records;
}

let previous = null;

try {
  previous =
    JSON.parse(
      await readFile(
        OUT,
        'utf8'
      )
    );
} catch {}

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
    !breakfast.length &&
    !lunch.length
  ) {
    throw new Error(
      'Health-e Pro loaded, but no current-week menu entries could be parsed.'
    );
  }
} catch (err) {
  error = err;

  debug.error =
    err?.stack ||
    String(err);
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

  // Never wipe out a previously good menu.
  if (
    previous &&
    (
      previous.breakfast
        ?.length ||
      previous.lunch
        ?.length
    )
  ) {
    previous.sync = {
      status:
        'failed',

      message:
        String(
          error.message ||
          error
        ),

      attemptedAt:
        new Date()
          .toISOString()
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
    new Date()
      .toISOString(),

  weekStart,
  weekEnd,

  source: {
    district:
      'Riverton USD 404',

    school:
      'Riverton Elementary School',

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
    status:
      'ok',

    message:
      `Pulled ${breakfast.length} breakfast day(s) ` +
      `and ${lunch.length} lunch day(s).`
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

import { chromium } from 'playwright';
import { readFile, writeFile } from 'node:fs/promises';

const ORG_ID = '1681';
const SITE_ID = '11709';
const SITE_NAME = 'Riverton K-12';

const ORG_URL =
  `https://menus.healthepro.com/organizations/${ORG_ID}`;

const OUT =
  new URL('../menu-data.json', import.meta.url);

const DEBUG =
  new URL('../sync-debug.json', import.meta.url);

process.env.TZ = 'America/Chicago';

const now = new Date();

function isoDate(d) {
  return (
    `${d.getFullYear()}-` +
    `${String(d.getMonth() + 1).padStart(2, '0')}-` +
    `${String(d.getDate()).padStart(2, '0')}`
  );
}

function mondayOf(date) {
  const d = new Date(date);

  d.setHours(12, 0, 0, 0);

  const day = d.getDay();

  d.setDate(
    d.getDate() +
    (day === 0 ? -6 : 1 - day)
  );

  return d;
}


// --------------------------------------
// TARGET SCHOOL WEEK
// --------------------------------------

const targetDate = new Date(now);

// Saturday and Sunday pull the
// upcoming school week.
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


// --------------------------------------
// DEBUG
// --------------------------------------

const debug = {
  startedAt:
    now.toISOString(),

  orgUrl:
    ORG_URL,

  site: {
    id: SITE_ID,
    name: SITE_NAME
  },

  targetWeek: {
    start: weekStart,
    end: weekEnd
  },

  captures: [],
  notes: []
};


function clean(v) {
  return String(v ?? '')
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


function safePreview(
  value,
  max = 20000
) {
  try {
    const text =
      JSON.stringify(value);

    return text.length > max
      ? `${text.slice(0, max)}…[truncated]`
      : text;
  } catch {
    return '[unserializable]';
  }
}


// --------------------------------------
// DATE PARSING
// --------------------------------------

function dateFromText(
  text,
  fallbackYear =
    now.getFullYear()
) {
  text =
    String(text ?? '');

  const iso =
    text.match(
      /\b(20\d{2})-(\d{2})-(\d{2})\b/
    );

  if (iso) {
    return iso[0];
  }

  const slash =
    text.match(
      /\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/
    );

  if (slash) {
    let y =
      slash[3]
        ? Number(slash[3])
        : fallbackYear;

    if (y < 100) {
      y += 2000;
    }

    return (
      `${y}-` +
      `${String(slash[1]).padStart(2, '0')}-` +
      `${String(slash[2]).padStart(2, '0')}`
    );
  }

  const named =
    text.match(
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(20\d{2}))?/i
    );

  if (named) {
    const d =
      new Date(
        `${named[1]} ${named[2]}, ` +
        `${named[3] || fallbackYear} 12:00:00`
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


// --------------------------------------
// API ENTITY PARSING
// --------------------------------------

function collectEntities(
  value,
  path = '',
  out = []
) {
  if (Array.isArray(value)) {
    value.forEach(
      (v, i) =>
        collectEntities(
          v,
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

  const nameKeys = [
    'name',
    'title',
    'label',
    'human_name',
    'menu_name',
    'menuName'
  ];

  const idKeys = [
    'id',
    'value',
    'menu_id',
    'menuId'
  ];

  let name = null;
  let id = null;

  for (
    const key
    of nameKeys
  ) {
    if (
      typeof value[key] === 'string' &&
      clean(value[key])
    ) {
      name =
        clean(value[key]);

      break;
    }
  }

  for (
    const key
    of idKeys
  ) {
    if (
      value[key] !== undefined &&
      value[key] !== null &&
      clean(value[key])
    ) {
      id =
        String(value[key]);

      break;
    }
  }

  if (name) {
    out.push({
      path,
      name,
      id
    });
  }

  for (
    const [key, val]
    of Object.entries(value)
  ) {
    if (
      val &&
      typeof val === 'object'
    ) {
      collectEntities(
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


// --------------------------------------
// THIRD-GRADE MENU SCORING
// --------------------------------------

function scoreMenu(
  name,
  meal
) {
  const n =
    clean(name)
      .toLowerCase();

  const m =
    meal.toLowerCase();

  if (
    !n.includes(m)
  ) {
    return -1000;
  }

  let score = 100;

  // Prefer elementary-age menus.
  if (
    /elementary|elem\b|k[-– ]?5|k[-– ]?6|pk[-– ]?5|pre[- ]?k|grade[s]?\s*[k0-5]/i
      .test(name)
  ) {
    score += 60;
  }

  // Strong preference if grade 3
  // is explicitly mentioned.
  if (
    /3rd|third|grade\s*3/i
      .test(name)
  ) {
    score += 80;
  }

  // Avoid older-student menus.
  if (
    /middle|high|6[-– ]?8|7[-– ]?12|9[-– ]?12/i
      .test(name)
  ) {
    score -= 80;
  }

  if (n === m) {
    score += 10;
  }

  return score;
}


function pickBestMenu(
  entities,
  meal
) {
  const seen =
    new Map();

  for (
    const entity
    of entities
  ) {
    if (
      !entity.id ||
      scoreMenu(
        entity.name,
        meal
      ) < 0
    ) {
      continue;
    }

    const key =
      `${entity.id}|${entity.name}`;

    if (
      !seen.has(key)
    ) {
      seen.set(
        key,
        entity
      );
    }
  }

  return (
    [...seen.values()]
      .sort(
        (a, b) =>
          scoreMenu(
            b.name,
            meal
          ) -
          scoreMenu(
            a.name,
            meal
          )
      )[0] ||
    null
  );
}


// --------------------------------------
// HEALTH-E PRO DROPDOWNS
// --------------------------------------

async function getCombobox(
  page,
  index
) {
  const boxes =
    page.getByRole(
      'combobox'
    );

  if (
    await boxes.count() >
    index
  ) {
    return boxes.nth(
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


async function visibleOptions(
  page
) {
  const texts = [];

  const roleOptions =
    page.getByRole(
      'option'
    );

  for (
    let i = 0;
    i < await roleOptions.count();
    i++
  ) {
    try {
      const element =
        roleOptions.nth(i);

      if (
        await element.isVisible()
      ) {
        texts.push(
          clean(
            await element
              .innerText()
          )
        );
      }
    } catch {}
  }

  const fallback =
    page.locator(
      '[id*="option"]:visible'
    );

  for (
    let i = 0;
    i < await fallback.count();
    i++
  ) {
    try {
      texts.push(
        clean(
          await fallback
            .nth(i)
            .innerText()
        )
      );
    } catch {}
  }

  // CRITICAL FIX:
  // never treat this as an option.
  return uniq(texts)
    .filter(
      text =>
        text &&
        !/^no results found$/i
          .test(text)
    );
}


async function selectAutocomplete(
  page,
  index,
  searchText,
  chooser
) {
  const box =
    await getCombobox(
      page,
      index
    );

  if (!box) {
    return {
      ok: false,
      selected: null,
      options: []
    };
  }

  try {
    await box.click({
      timeout: 4000
    });

    await box.fill('');

    await box.type(
      searchText,
      {
        delay: 30
      }
    );

    await page.waitForTimeout(
      1000
    );

    const options =
      await visibleOptions(
        page
      );

    const selected =
      chooser(options);

    if (!selected) {
      return {
        ok: false,
        selected: null,
        options
      };
    }

    const exact =
      page.getByRole(
        'option',
        {
          name: selected,
          exact: true
        }
      );

    if (
      await exact.count()
    ) {
      await exact
        .first()
        .click({
          timeout: 4000
        });
    } else {
      const fallback =
        page.locator(
          '[id*="option"]:visible'
        )
          .filter({
            hasText: selected
          });

      if (
        !(await fallback.count())
      ) {
        return {
          ok: false,
          selected: null,
          options
        };
      }

      await fallback
        .first()
        .click({
          timeout: 4000
        });
    }

    await page.waitForTimeout(
      900
    );

    return {
      ok: true,
      selected,
      options
    };

  } catch (error) {
    return {
      ok: false,
      selected: null,
      options: [],
      error: error.message
    };
  }
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

  return false;
}


// --------------------------------------
// FIND REAL MENU API
// --------------------------------------

async function probeMenuApis(
  page,
  captures
) {
  const urls = [
    `https://menus.healthepro.com/api/organizations/${ORG_ID}/sites/${SITE_ID}/menus/list`,

    `https://menus.healthepro.com/api/organizations/${ORG_ID}/sites/${SITE_ID}/menus`,

    `https://menus.healthepro.com/api/organizations/${ORG_ID}/menus/list?siteId=${SITE_ID}`,

    `https://menus.healthepro.com/api/organizations/${ORG_ID}/menus/list?site_id=${SITE_ID}`,

    `https://menus.healthepro.com/api/organizations/${ORG_ID}/menus?siteId=${SITE_ID}`,

    `https://menus.healthepro.com/api/organizations/${ORG_ID}/menus?site_id=${SITE_ID}`
  ];

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
        type.includes('json')
      ) {
        const body =
          await response.json();

        item.preview =
          safePreview(body);

        captures.push({
          url,
          body
        });
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
}


function actualMenuEntities(
  captures
) {
  return captures

    // Do NOT use the generic system
    // Breakfast/Lunch IDs.
    .filter(
      capture =>
        !/\/api\/system(?:\?|$)/i
          .test(capture.url)
    )

    .filter(
      capture =>
        /menu/i
          .test(capture.url)
    )

    .flatMap(
      capture =>
        collectEntities(
          capture.body
        )
    );
}


// --------------------------------------
// MENU PAGE PARSING
// --------------------------------------

function trimLines(
  lines
) {
  const junk =
    /nutrition|allergen|ingredients|calories|carbohydrate|sodium|protein|print menu|powered by|terms of service|privacy policy|accessibility|menu information|meal price|select your|view menu/i;

  return uniq(
    lines.map(clean)
  )
    .filter(Boolean)

    .filter(
      line =>
        !junk.test(line)
    )

    .filter(
      line =>
        !/^breakfast$|^lunch$/i
          .test(line)
    )

    .slice(0, 18);
}


function mergeRecords(
  records
) {
  const map =
    new Map();

  for (
    const record
    of records
  ) {
    const old =
      map.get(
        record.date
      );

    if (
      !old ||
      (
        record.items?.length || 0
      ) >
      (
        old.items?.length || 0
      )
    ) {
      map.set(
        record.date,
        record
      );
    }
  }

  return [
    ...map.values()
  ]
    .sort(
      (a, b) =>
        a.date.localeCompare(
          b.date
        )
    );
}


function recordsFromBodyText(
  bodyText
) {
  const lines =
    String(
      bodyText ?? ''
    )
      .split(/\n/)
      .map(clean)
      .filter(Boolean);

  const records = [];

  for (
    let i = 0;
    i < lines.length;
    i++
  ) {
    const date =
      dateFromText(
        lines[i]
      );

    if (
      !date ||
      date < weekStart ||
      date > weekEnd
    ) {
      continue;
    }

    const block = [];

    for (
      let j = i + 1;
      j < lines.length;
      j++
    ) {
      const nextDate =
        dateFromText(
          lines[j]
        );

      if (nextDate) {
        break;
      }

      block.push(
        lines[j]
      );

      if (
        block.length >= 30
      ) {
        break;
      }
    }

    const cleaned =
      trimLines(block);

    if (
      cleaned.length
    ) {
      records.push({
        date,
        title:
          cleaned[0],
        items:
          cleaned.slice(1)
      });
    }
  }

  return mergeRecords(
    records
  );
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

    const lines =
      trimLines(
        String(
          candidate.text || ''
        )
          .split(
            /\n|\s{2,}| • /
          )
      );

    const filtered =
      lines.filter(
        line =>
          !dateFromText(line) &&
          !/^(mon|tue|wed|thu|fri|sat|sun)(day)?$/i
            .test(line)
      );

    if (
      filtered.length
    ) {
      records.push({
        date,
        title:
          filtered[0],
        items:
          filtered.slice(1)
      });
    }
  }

  return mergeRecords(
    records
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
          const element
          of document
            .querySelectorAll(
              selector
            )
        ) {
          const text =
            (
              element.innerText ||
              element.textContent ||
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
            text.length > 3000 ||
            !dateish.test(text) ||
            seen.has(key)
          ) {
            continue;
          }

          seen.add(key);

          candidates.push({
            text,

            dataDate:
              element.getAttribute(
                'data-date'
              ),

            datetime:
              element.getAttribute(
                'datetime'
              ) ||
              element
                .querySelector(
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


// --------------------------------------
// SCRAPE ONE MEAL
// --------------------------------------

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
          /sites\/list|menu/i
            .test(
              response.url()
            ) &&
          !/api\/system/i
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
              safePreview(body)
          });
        }

      } catch {}
    }
  );


  // Open USD 404 menu selector.
  await page.goto(
    ORG_URL,
    {
      waitUntil:
        'domcontentloaded',
      timeout:
        60000
    }
  );

  await page.waitForTimeout(
    2500
  );


  // ----------------------------------
  // SELECT REAL HEALTH-E PRO SITE
  // ----------------------------------

  const schoolPick =
    await selectAutocomplete(
      page,
      0,
      SITE_NAME,

      options =>
        options.find(
          option =>
            option
              .toLowerCase() ===
            SITE_NAME
              .toLowerCase()
        ) ||

        options.find(
          option =>
            /riverton k-12/i
              .test(option)
        ) ||

        null
    );


  debug.notes.push(
    `${meal}: ` +
    `school options=` +
    `${JSON.stringify(
      schoolPick.options
    )} ` +
    `selected=` +
    `${schoolPick.selected || 'none'}`
  );


  if (
    !schoolPick.ok
  ) {
    throw new Error(
      `Could not select Health-e Pro site ${SITE_NAME}.`
    );
  }


  await page.waitForTimeout(
    1800
  );


  // Ask Health-e Pro directly for
  // available menus as well.
  await probeMenuApis(
    page,
    captures
  );


  const menuEntities =
    actualMenuEntities(
      captures
    );


  let menu =
    pickBestMenu(
      menuEntities,
      meal
    );


  debug.notes.push(
    `${meal}: API menu candidates=` +
    `${JSON.stringify(
      menuEntities.slice(
        0,
        30
      )
    )}`
  );


  let finalUrl = null;


  // ----------------------------------
  // DIRECT MENU ID AVAILABLE
  // ----------------------------------

  if (
    menu?.id
  ) {
    finalUrl =
      `${ORG_URL}` +
      `/sites/${SITE_ID}` +
      `/menus/${menu.id}` +
      `?date=${weekStart}`;


    debug.notes.push(
      `${meal}: ` +
      `direct menu ` +
      `${menu.name} ` +
      `[${menu.id}]`
    );


    await page.goto(
      finalUrl,
      {
        waitUntil:
          'domcontentloaded',
        timeout:
          60000
      }
    );


    await page.waitForTimeout(
      2500
    );

  } else {

    // --------------------------------
    // FALLBACK TO REAL MENU DROPDOWN
    // --------------------------------

    const menuPick =
      await selectAutocomplete(
        page,
        1,
        meal,

        options =>
          options

            .map(
              name => ({
                name,
                score:
                  scoreMenu(
                    name,
                    meal
                  )
              })
            )

            .filter(
              item =>
                item.score >= 0
            )

            .sort(
              (a, b) =>
                b.score -
                a.score
            )[0]
            ?.name ||

          null
      );


    debug.notes.push(
      `${meal}: ` +
      `menu options=` +
      `${JSON.stringify(
        menuPick.options
      )} ` +
      `selected=` +
      `${menuPick.selected || 'none'}`
    );


    if (
      !menuPick.ok
    ) {
      throw new Error(
        `Could not select a ${meal} menu for ${SITE_NAME}.`
      );
    }


    const clicked =
      await clickGo(page);


    debug.notes.push(
      `${meal}: ` +
      `Go clicked=${clicked}`
    );


    if (!clicked) {
      throw new Error(
        'Could not click Health-e Pro Go button.'
      );
    }


    try {
      await page.waitForURL(
        url =>
          /\/sites\/\d+\/menus\/\d+/
            .test(
              url.pathname
            ),
        {
          timeout:
            12000
        }
      );
    } catch {}


    await page.waitForTimeout(
      2500
    );


    finalUrl =
      page.url();
  }


  // Ensure target week is selected.
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


      await page.waitForTimeout(
        2200
      );
    }
  } catch {}


  // ----------------------------------
  // NORMAL MENU PAGE
  // ----------------------------------

  const raw =
    await extractPage(
      page
    );


  debug[
    `${meal}Page`
  ] = {
    url:
      raw.url,

    title:
      raw.title,

    bodyText:
      raw.bodyText.slice(
        0,
        30000
      ),

    candidates:
      raw.candidates.slice(
        0,
        180
      )
  };


  let records =
    mergeRecords([
      ...recordsFromCandidates(
        raw.candidates
      ),

      ...recordsFromBodyText(
        raw.bodyText
      )
    ]);


  // ----------------------------------
  // PRINTABLE MENU PAGE
  // ----------------------------------

  if (
    /\/sites\/\d+\/menus\/\d+/
      .test(
        page.url()
      )
  ) {
    try {
      const base =
        page.url()
          .replace(
            /\?.*$/,
            ''
          )
          .replace(
            /\/$/,
            ''
          );


      const printUrl =
        `${base}` +
        `/print-menu` +
        `?date=${weekStart}`;


      await page.goto(
        printUrl,
        {
          waitUntil:
            'domcontentloaded',
          timeout:
            60000
        }
      );


      await page.waitForTimeout(
        2000
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
            35000
          ),

        candidates:
          printed.candidates.slice(
            0,
            180
          )
      };


      records =
        mergeRecords([
          ...records,

          ...recordsFromCandidates(
            printed.candidates
          ),

          ...recordsFromBodyText(
            printed.bodyText
          )
        ]);

    } catch (error) {
      debug.notes.push(
        `${meal}: ` +
        `print page failed: ` +
        `${error.message}`
      );
    }
  }


  debug.notes.push(
    `${meal}: ` +
    `final=${finalUrl || page.url()} ` +
    `records=${records.length}`
  );


  await context.close();

  return records;
}


// --------------------------------------
// KEEP PREVIOUS GOOD MENU
// --------------------------------------

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


// --------------------------------------
// RUN
// --------------------------------------

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
      'Health-e Pro opened the Riverton K-12 menus, but no current-week entries could be parsed.'
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


// --------------------------------------
// FAILURE HANDLING
// --------------------------------------

if (error) {

  await writeFile(
    DEBUG,
    JSON.stringify(
      debug,
      null,
      2
    ) + '\n'
  );


  // Never overwrite an existing
  // good menu with a failure.
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


// --------------------------------------
// SUCCESS
// --------------------------------------

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

    // User-facing school.
    school:
      'Riverton Elementary School',

    // Actual Health-e Pro site.
    sourceSite:
      SITE_NAME,

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

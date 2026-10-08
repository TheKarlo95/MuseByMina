import { chromium } from 'playwright';

import { openSiteOrExit } from './dist-origin.mjs';

/**
 * MUSE-6 — the acceptance criteria that need a layout engine and an input device.
 *
 * `test/schedule.test.ts` asserts the schedule's content and semantics off the
 * built HTML. Three of the criteria cannot be checked that way at all:
 *
 *   AC1 / AC2  which view a given viewport *shows* is a media query decision
 *   AC4        the empty state only appears once a filter has been clicked
 *   AC6        "operable by keyboard alone" means real Tab and Enter presses
 *
 * Same shape and conventions as `scripts/a11y.mjs`: prints one line per check and
 * exits non-zero on the first failure count above zero, and gets its server from
 * `dist-origin.mjs` — which serves `dist` itself rather than attaching to whatever happens
 * to be listening (MUSE-52).
 *
 *   npm run build
 *   node scripts/schedule-ux.mjs
 */

/** The schedule in both locales, with the copy each one must show. */
const PAGES = [
  { locale: 'hr', route: '/schedule', empty: 'Nema termina za odabrani filter.', one: '1 termin' },
  {
    locale: 'en',
    route: '/en/schedule',
    empty: 'No classes match the selected filter.',
    one: '1 class',
  },
];

/** The breakpoint the ticket names, checked on both sides of it. */
const MOBILE = { width: 390, height: 844 };
const JUST_UNDER = { width: 767, height: 900 };
const BREAKPOINT = { width: 768, height: 900 };
const DESKTOP = { width: 1280, height: 900 };

let failures = 0;

function report(label, ok, detail = '') {
  if (ok) {
    console.log(`✓ ${label}`);
  } else {
    failures += 1;
    console.log(`✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Assert and report in one step; `detail` is only printed on failure. */
function check(label, ok, detail) {
  report(label, Boolean(ok), detail);
}

/**
 * The build these checks are about. An in-process host over `dist` on an ephemeral port
 * unless `ORIGIN` names one, in which case it is proved byte-identical to the local
 * build first; the two lines it logs say which build was measured (MUSE-52).
 */
const site = await openSiteOrExit({ routes: PAGES.map((page) => page.route) });

const browser = await chromium.launch();

async function open(route, { viewport, colorScheme = 'dark' }) {
  const ctx = await browser.newContext({ viewport, colorScheme, deviceScaleFactor: 1 });
  // Keep the homepage language redirect from ever entering the picture.
  await ctx.addInitScript(() => localStorage.setItem('muse-lang', 'hr'));
  const page = await ctx.newPage();

  // Page URLs carry a trailing slash (`trailingSlash: 'always'`, MUSE-9). The
  // unslashed spelling 404s on the dev server, and a 404 body paints no schedule
  // at all — which reads as "every layout check failed" rather than "wrong URL".
  // `site.url` is the one place that slash is added.
  const url = site.url(route);
  const response = await page.goto(url, { waitUntil: 'networkidle' });

  const status = response?.status() ?? 0;
  if (status !== 200) {
    throw new Error(`${url} returned ${status} — the checks below would audit the wrong page`);
  }

  await page.evaluate(() => document.fonts.ready);
  return { ctx, page };
}

/**
 * Is the browser actually rendering this element?
 *
 * `checkVisibility()`, not `getClientRects()`. A collapsed `<details>` hides its
 * content with `content-visibility: hidden`, and a skipped subtree *keeps* the
 * geometry from its last layout — so every row of a closed day still reports a
 * client rect, and a rect-based check silently passes on a schedule that is not
 * on screen at all. `checkVisibility()` answers the question being asked, and
 * covers `display: none` (the two layouts, and anything the filter hides) too.
 *
 * Which of the two layouts the browser is actually painting:
 */
async function visibleViews(page) {
  return page.$$eval('[data-view]', (els) =>
    els.filter((el) => el.checkVisibility()).map((el) => el.getAttribute('data-view')),
  );
}

/** Every class element the browser is painting, as `level|style`. */
async function paintedSlots(page) {
  return page.$$eval('[data-slot]', (els) =>
    els
      .filter((el) => el.checkVisibility())
      .map((el) => `${el.dataset.level}|${el.dataset.style}`),
  );
}

/**
 * A level+style pair the data does not contain, discovered from the page rather
 * than hardcoded — AC4 has to stay reachable when the placeholder data changes
 * (and when Sanity replaces it).
 */
async function emptyFilterPair(page) {
  const offered = await page.evaluate(() => {
    const values = (kind) =>
      [...document.querySelectorAll(`[data-filter="${kind}"]`)]
        .map((el) => el.dataset.value)
        .filter((v) => v !== 'all');
    return {
      levels: values('level'),
      styles: values('style'),
      present: [...document.querySelectorAll('[data-slot]')].map(
        (el) => `${el.dataset.level}|${el.dataset.style}`,
      ),
    };
  });

  const present = new Set(offered.present);
  for (const level of offered.levels) {
    for (const style of offered.styles) {
      if (!present.has(`${level}|${style}`)) return { level, style };
    }
  }
  return undefined;
}

async function selectFilter(page, kind, value) {
  await page.click(`[data-filter="${kind}"][data-value="${value}"]`);
}

// ---------------------------------------------------------------------------
// AC1 / AC2 — one dataset, two layouts, switching at 768px.
// ---------------------------------------------------------------------------
for (const { locale, route } of PAGES) {
  for (const [name, viewport, expected] of [
    ['390px', MOBILE, 'accordion'],
    ['767px', JUST_UNDER, 'accordion'],
    ['768px', BREAKPOINT, 'grid'],
    ['1280px', DESKTOP, 'grid'],
  ]) {
    const { ctx, page } = await open(route, { viewport });
    const views = await visibleViews(page);

    check(
      `AC1/AC2 ${locale} ${name.padEnd(6)} shows the ${expected} and nothing else`,
      views.length === 1 && views[0] === expected,
      `painting [${views.join(', ')}]`,
    );

    if (expected === 'accordion') {
      // Grouped by day, and the first group open so the page is not a wall of
      // closed rows. The rows inside it have to be readable without a click.
      const open = await page.$$eval('details', (els) => els.map((el) => el.open));
      check(
        `AC1 ${locale} ${name.padEnd(6)} opens exactly the first day`,
        open.length > 1 && open[0] === true && open.slice(1).every((o) => o === false),
        `open states [${open.join(', ')}]`,
      );

      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      check(
        `AC1 ${locale} ${name.padEnd(6)} has zero horizontal overflow`,
        overflow === 0,
        `${overflow}px`,
      );
    }

    await ctx.close();
  }

  // AC2's "the same data": the painted set at 1280px must equal the painted set
  // at 390px with every day expanded.
  const mobile = await open(route, { viewport: MOBILE });
  await mobile.page.$$eval('details', (els) => els.forEach((el) => (el.open = true)));
  const mobileSlots = (await paintedSlots(mobile.page)).sort();
  await mobile.ctx.close();

  const desktop = await open(route, { viewport: DESKTOP });
  const desktopSlots = (await paintedSlots(desktop.page)).sort();
  await desktop.ctx.close();

  check(
    `AC2 ${locale} the grid paints the same classes as the expanded accordion`,
    mobileSlots.length > 0 && JSON.stringify(mobileSlots) === JSON.stringify(desktopSlots),
    `${mobileSlots.length} mobile vs ${desktopSlots.length} desktop`,
  );
}

// ---------------------------------------------------------------------------
// AC6 — the accordion is operable by keyboard alone, in either theme.
// ---------------------------------------------------------------------------
for (const { locale, route } of PAGES) {
  for (const colorScheme of ['dark', 'light']) {
    const { ctx, page } = await open(route, { viewport: MOBILE, colorScheme });
    const label = `AC6 ${locale} ${colorScheme.padEnd(5)}`;

    /** Tab until focus lands inside a `<details>` that is still closed. */
    let reached;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el || el.tagName !== 'SUMMARY') return undefined;
        const details = el.closest('details');
        return details && !details.open ? details.dataset.dayGroup : undefined;
      });
    }

    check(`${label} reaches a closed day with Tab alone`, Boolean(reached), 'never focused');
    if (!reached) {
      await ctx.close();
      continue;
    }

    const state = () =>
      page.$eval(`[data-day-group="${reached}"]`, (el) => ({
        open: el.open,
        rowVisible: [...el.querySelectorAll('[data-slot]')].some((slot) =>
          slot.checkVisibility(),
        ),
      }));

    // A visible focus ring is what makes keyboard operation usable rather than
    // merely possible. Design system §11.2 pins it to the accent role token.
    const outline = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement);
      return { width: parseFloat(style.outlineWidth), style: style.outlineStyle };
    });
    check(
      `${label} shows a focus ring on the summary`,
      outline.width >= 2 && outline.style !== 'none',
      `${outline.width}px ${outline.style}`,
    );

    await page.keyboard.press('Enter');
    const opened = await state();
    check(
      `${label} Enter expands the day and reveals its rows`,
      opened.open && opened.rowVisible,
      `open=${opened.open} rowVisible=${opened.rowVisible}`,
    );

    await page.keyboard.press('Enter');
    const closed = await state();
    check(
      `${label} Enter collapses it again`,
      !closed.open && !closed.rowVisible,
      `open=${closed.open} rowVisible=${closed.rowVisible}`,
    );

    // Space is the other key a disclosure must answer to.
    await page.keyboard.press('Space');
    check(`${label} Space expands the day too`, (await state()).open);

    await ctx.close();
  }
}

// ---------------------------------------------------------------------------
// AC4 — a filter that matches nothing, in both layouts.
// ---------------------------------------------------------------------------
for (const { locale, route, empty, one } of PAGES) {
  for (const [name, viewport] of [
    ['390px', MOBILE],
    ['1280px', DESKTOP],
  ]) {
    const { ctx, page } = await open(route, { viewport });
    const label = `AC4 ${locale} ${name.padEnd(6)}`;

    check(
      `${label} the filter bar is there once scripting runs`,
      await page.isVisible('[data-filters]'),
    );
    check(`${label} the empty state is hidden at rest`, !(await page.isVisible('[data-empty]')));

    const pair = await emptyFilterPair(page);
    check(`${label} finds a level+style pair with no classes`, Boolean(pair));
    if (!pair) {
      await ctx.close();
      continue;
    }

    await selectFilter(page, 'level', pair.level);
    await selectFilter(page, 'style', pair.style);

    const shown = (await page.textContent('[data-empty]'))?.trim();
    check(
      `${label} ${pair.level} + ${pair.style} shows the empty state, worded exactly`,
      (await page.isVisible('[data-empty]')) && shown === empty,
      `visible=${await page.isVisible('[data-empty]')} text="${shown}"`,
    );
    check(
      `${label} and paints no classes at all`,
      (await paintedSlots(page)).length === 0,
      `${(await paintedSlots(page)).length} still painted`,
    );

    // Back to a filter that does match: the empty state must go away again.
    await selectFilter(page, 'style', 'all');
    const after = await paintedSlots(page);
    check(
      `${label} clearing the style filter brings the classes back`,
      !(await page.isVisible('[data-empty]')) && after.length > 0,
      `${after.length} painted`,
    );
    check(
      `${label} and keeps only the ${pair.level} level`,
      after.every((slot) => slot.startsWith(`${pair.level}|`)),
      `painted [${[...new Set(after)].join(', ')}]`,
    );

    // The day count is recomputed, which is where the ported Croatian
    // pluralisation has to hold: a filtered day with one class reads `1 termin`,
    // not `1 termina`.
    if (viewport === MOBILE) {
      const counts = await page.$$eval('[data-count]', (els) =>
        els.filter((el) => el.checkVisibility()).map((el) => el.textContent.trim()),
      );
      check(
        `${label} recounts a filtered day as "${one}"`,
        counts.includes(one),
        `counts [${counts.join(', ')}]`,
      );
    }

    await ctx.close();
  }
}

await browser.close();
await site.close();

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nSchedule: responsive shift, keyboard operation and filtering all verified.');

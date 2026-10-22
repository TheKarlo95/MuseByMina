// @ts-nocheck — MUSE-121: 41 errors when `scripts/` was first checked, nearly all missing
// annotations on `page.$$eval` callbacks (`Element` has no `dataset`/`open`) and on the
// helpers. Read for a live defect before suppressing: the `.padEnd` errors are `name`
// destructured from `[string, {width, height}, string][]`, which TypeScript widens to a
// union; `name` is always a string. Annotate and delete this line when the file is next
// touched.
import { describeMeasured, launchChecks, openCheckPage } from './browser-checks.mjs';
import { openSiteOrExit } from './dist-origin.mjs';

/**
 * MUSE-6 — the acceptance criteria that need a layout engine and an input device.
 *
 * `test/schedule.test.ts` asserts the schedule's content and semantics off the
 * built HTML. Three of the criteria cannot be checked that way at all:
 *
 *   AC1 / AC2  which view a given viewport *shows* is a media query decision
 *   AC6        "operable by keyboard alone" means real Tab and Enter presses
 *
 * AC4 was the third, "the empty state only appears once a filter has been clicked", and
 * it is gone with the filter (MUSE-135). Two consequences for this file. The page now
 * ships **no script of its own**, so everything measured below is the browser's own
 * behaviour — a `<details>` and two media queries — and nothing here can be broken by a
 * component's JavaScript failing to run. And the empty state it drove is now a build-time
 * state of the data, which needs no browser: `test/schedule.test.ts` renders the component
 * with an empty timetable instead.
 *
 * Same shape and conventions as `scripts/a11y.mjs`: prints one line per check and
 * exits non-zero on the first failure count above zero, and gets its server from
 * `dist-origin.mjs` — which serves `dist` itself rather than attaching to whatever happens
 * to be listening (MUSE-52).
 *
 *   npm run build
 *   node scripts/schedule-ux.mjs
 */

/** The schedule in both locales. */
const PAGES = [
  { locale: 'hr', route: '/schedule' },
  { locale: 'en', route: '/en/schedule' },
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

const browser = await launchChecks();

/** The page each locale's checks were actually run against, printed once per page. */
const measuredPages = new Set();

/**
 * Open one of the schedule pages, as a visitor of that page's language.
 *
 * `scripts/browser-checks.mjs` pins the locale the route names and asserts the landing
 * URL (MUSE-48). This script carried the third copy of the hand-written language-pin line
 * — there were two when the ticket was filed and three by the time it was picked up,
 * which is the argument for a mechanism rather than a comment in one sentence.
 *
 * Page URLs carry a trailing slash (`trailingSlash: 'always'`, MUSE-9). The unslashed
 * spelling 404s, and a 404 body paints no schedule at all — which reads as "every layout
 * check failed" rather than "wrong URL". `site.url`, inside the door, adds that slash.
 */
async function open(route, { viewport, colorScheme = 'dark' }) {
  const { page, response, measured, close } = await openCheckPage(browser, site, route, {
    context: { viewport, colorScheme, deviceScaleFactor: 1 },
  });

  const status = response?.status() ?? 0;
  if (status !== 200) {
    await close();
    throw new Error(
      `${measured.url} returned ${status} — the checks below would audit the wrong page`,
    );
  }

  // Which page these checks are about, in the output, once (MUSE-48).
  const line = describeMeasured(measured);
  if (!measuredPages.has(line)) {
    measuredPages.add(line);
    console.log(`· measuring ${line}`);
  }

  await page.evaluate(() => document.fonts.ready);
  return { close, page };
}

/**
 * Is the browser actually rendering this element?
 *
 * `checkVisibility()`, not `getClientRects()`. A collapsed `<details>` hides its
 * content with `content-visibility: hidden`, and a skipped subtree *keeps* the
 * geometry from its last layout — so every row of a closed day still reports a
 * client rect, and a rect-based check silently passes on a schedule that is not
 * on screen at all. `checkVisibility()` answers the question being asked, and
 * covers `display: none`, which is how the two layouts take turns.
 *
 * Which of the two layouts the browser is actually painting:
 */
async function visibleViews(page) {
  return page.$$eval('[data-view]', (els) =>
    els.filter((el) => el.checkVisibility()).map((el) => el.getAttribute('data-view')),
  );
}

/** Every class element the browser is painting, as its level. */
async function paintedSlots(page) {
  return page.$$eval('[data-slot]', (els) =>
    els.filter((el) => el.checkVisibility()).map((el) => el.dataset.level),
  );
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
    const { close, page } = await open(route, { viewport });
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

    await close();
  }

  // AC2's "the same data": the painted set at 1280px must equal the painted set
  // at 390px with every day expanded.
  const mobile = await open(route, { viewport: MOBILE });
  await mobile.page.$$eval('details', (els) => els.forEach((el) => (el.open = true)));
  const mobileSlots = (await paintedSlots(mobile.page)).sort();
  await mobile.close();

  const desktop = await open(route, { viewport: DESKTOP });
  const desktopSlots = (await paintedSlots(desktop.page)).sort();
  await desktop.close();

  check(
    `AC2 ${locale} the grid paints the same classes as the expanded accordion`,
    mobileSlots.length > 0 && JSON.stringify(mobileSlots) === JSON.stringify(desktopSlots),
    `${mobileSlots.length} mobile vs ${desktopSlots.length} desktop`,
  );

  // `paintedSlots` compares levels, and after MUSE-36 a level appears once in the
  // timetable — so "the same classes" would also be satisfied by two layouts showing a
  // different *class* of the same level. The count is compared as well as the set.
  check(
    `AC2 ${locale} and the same number of them`,
    mobileSlots.length === desktopSlots.length,
    `${mobileSlots.length} vs ${desktopSlots.length}`,
  );
}

// ---------------------------------------------------------------------------
// AC6 — the accordion is operable by keyboard alone, in either theme.
// ---------------------------------------------------------------------------
for (const { locale, route } of PAGES) {
  for (const colorScheme of ['dark', 'light']) {
    const { close, page } = await open(route, { viewport: MOBILE, colorScheme });
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
      await close();
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

    await close();
  }
}

await browser.close();
await site.close();

if (failures) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log('\nSchedule: responsive shift and keyboard operation both verified.');

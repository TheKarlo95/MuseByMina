import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser } from 'playwright';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchChecks } from '../scripts/browser-checks.mjs';
import {
  assertDocumentIsItself,
  BUDGET,
  budgetedPages,
  checkBudget,
  kindOf,
  measurePage,
  renderBlocking,
  report,
  uncoveredWidthRules,
  VIEWPORTS,
  widthConditionsIn,
  widthConstraints,
} from '../scripts/budget.mjs';
import { auditTargets, pagePath } from '../scripts/dist-origin.mjs';
import {
  APEX_DEPLOY,
  basePath,
  buildSite,
  PAGES_DEPLOY,
  styleBlocks,
  type Build,
} from './helpers/build';
import { assertMeasuredPage } from './helpers/measured';
import { servePages, type Host } from './helpers/serve';

/**
 * **MUSE-63 — the performance budget, asserted against both deploy targets.**
 *
 * The plan this project was built from listed `lighthouse` among the blocking CI checks
 * and it was never built, so **no check in this repository had an opinion about what a
 * page weighs or how many requests it makes.** The one size guard that existed watched
 * `du -sm dist` against the GitHub Pages 1 GB *site* limit: it would not have noticed one
 * page going from 60 KB to 2 MB.
 *
 * The numbers and the measuring live in `scripts/budget.mjs` — one module, so there is one
 * place a number lives and one place it is compared, and so `npm run budget` can print the
 * same table a person can read. This file is the **gate**: it builds both deploy targets,
 * because a base-path prefix is in every href on the page and only one of the two is what
 * CI publishes today (MUSE-8), and holds every page of both to the budget.
 *
 * ## What is deliberately not asserted here, and why
 *
 * **No timing, and no composite score.** LCP, TBT and Lighthouse's 0–100 number move with
 * what else is on the runner, and `npm test` alone runs ten real `astro build`s in
 * parallel workers while neighbouring worktrees do the same. A gate that goes red because
 * the box was busy is a gate people learn to re-run, and this repository has spent nine
 * tickets on that lesson in other costumes. The advisory load figure is collected and
 * printed; "the gate cannot see it" is itself a test below, stated behaviourally rather
 * than as a comment asking nicely.
 *
 * ## Why the font count is measured with the preload tags stripped
 *
 * Because a `<link rel="preload">` **is** a request, so "was this face requested" is true
 * by construction for anything preloaded, whether the page had any use for it.
 * `test/fonts.test.ts` worked that out and the technique is its; this reuses it, and
 * reuses it for the half that suite does not cover — *how many*, with a floor as well as
 * a ceiling. MUSE-35 was a **zero**: all six faces 404ed under `astro dev` for the life of
 * the project, every local visual check was made against Georgia, and MUSE-14's `II:OO`
 * was invisible locally because Georgia has lining figures. A ceiling alone cannot see
 * that, which is why `BUDGET.fonts` has both ends and why both are tested below.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** One build, served, with the pages a budget is about. */
interface Target {
  name: string;
  host: Host;
  /** The deploy base this build is mounted under, trailing slash included. */
  base: string;
  /** Page routes, with the spelling the host serves each at. */
  pages: { route: string; path: string }[];
  /** Everything the host serves that is deliberately not budgeted. */
  skipped: { route: string; path: string }[];
}

let browser: Browser;
let pagesBuild: Build;
let apexBuild: Build;
let targets: Target[];

beforeAll(async () => {
  // Sequential and cheapest-first, as in `test/fonts.test.ts`: one rejection inside a
  // `Promise.all` destructuring leaves every other handle unassigned and `afterAll` closes
  // none of them.
  browser = await launchChecks();

  pagesBuild = buildSite(PAGES_DEPLOY);
  apexBuild = buildSite(APEX_DEPLOY);

  targets = await Promise.all(
    [
      { name: 'the Pages sub-path build', build: pagesBuild },
      { name: 'the apex build', build: apexBuild },
    ].map(async ({ name, build }) => {
      // The audit set, read off the output tree rather than listed (MUSE-55). No
      // `locales`, so the error page appears once — as the HTML file it is — and
      // `budgetedPages` is what drops it.
      const found = budgetedPages(auditTargets(build.outDir, basePath(build)));
      return { name, base: basePath(build), host: await servePages(build), ...found };
    }),
  );
}, 300_000);

afterAll(async () => {
  await Promise.allSettled([
    ...(targets ?? []).map((target) => target.host.close()),
    browser?.close(),
  ]);
});

/**
 * The site handle a check is opened against.
 *
 * `openCheckPage` takes a single `url(route)` method on purpose — a check must not be able
 * to reach past it to an origin and join a URL itself, because joining it by hand is how
 * MUSE-9's trailing slash got lost. The path handed in here comes from `resolveRequest`
 * via `auditTargets`, which is the same place `site.at()` gets one in `scripts/`.
 */
const at = (host: Host, path: string) => ({ url: () => `${host.origin}${path}` });

describe('MUSE-63: every page of both deploy targets is within budget', () => {
  /**
   * AC1 and AC2 together, and the only test here that opens a browser.
   *
   * One `it` rather than one per route, because `describe.each` cannot see the routes: they
   * are read off a build that does not exist at collection time, which is the price of
   * deriving the page list from the output instead of listing it (MUSE-55). Every page is
   * measured before anything is asserted, so a failure is the whole report rather than the
   * first page over.
   */
  it('weighs every page and finds nothing over budget', async () => {
    const problems: string[] = [];
    const measured = [];

    for (const target of targets) {
      expect(target.pages.length, `${target.name}: no pages to budget`).toBeGreaterThan(4);

      for (const page of target.pages) {
        // **Every page at every width** (MUSE-104). The loop is the fix: with one implicit
        // width, anything a page fetches only outside it was free — reproduced with a
        // 777,646-byte raster behind `@media (min-width: 1400px)`, and again behind
        // `@media (max-width: 639px)`, neither of which moved a single column.
        for (const viewport of VIEWPORTS) {
          const measurement = await measurePage(
            browser,
            at(target.host, page.path),
            page.route,
            viewport,
          );
          measured.push({ target: target.name, measurement });
          problems.push(...checkBudget(measurement).map((line) => `${target.name}: ${line}`));
        }
      }

      // The loop above, asserted rather than trusted: a viewport quietly dropped from
      // `VIEWPORTS` leaves this file green and the hole back, because every *remaining*
      // measurement still passes. `measurePage` additionally refuses a page the browser
      // did not lay out at the width it was asked for.
      expect(
        measured.filter((row) => row.target === target.name).length,
        `${target.name}: every page, at every viewport`,
      ).toBe(target.pages.length * VIEWPORTS.length);
    }

    // **A width-conditional rule no measured viewport satisfies** (MUSE-104). Two widths
    // are honest because of this, not because two is enough: the bytes a rule outside them
    // fetches are invisible, so the rule is the failure. It is judged over the whole set of
    // measurements rather than inside `checkBudget`, because it is a claim about the
    // viewport contract and not about one page's weight.
    problems.push(...uncoveredWidthRules(measured.map((row) => row.measurement)));

    // And the collection is not vacuously empty: every page of this site loads the shared
    // `BaseLayout` chunk, which declares width breakpoints. A guard that finds nothing
    // passes.
    for (const row of measured) {
      expect(
        row.measurement.widthRules.length,
        `${row.target}: ${row.measurement.route} collected no @media width conditions`,
      ).toBeGreaterThan(0);
    }

    // The numbers, in the log, every run. MUSE-63's second criterion is that the headroom
    // is written down — and a table regenerated by the gate itself cannot go stale the way
    // a number transcribed into a comment can.
    for (const target of targets) {
      console.log(`\n${target.name}`);
      for (const line of report(
        measured.filter((row) => row.target === target.name).map((row) => row.measurement),
      )) {
        console.log(line);
      }
    }

    expect(problems).toEqual([]);
  }, 600_000);

  /**
   * The budget covers every page the site publishes, and the one exception says so.
   *
   * "Every page" is the claim that rots: a gate over six of eight pages reports success.
   * So the partition is asserted from both sides — the pages budgeted, and what was
   * dropped — and the dropped set may contain nothing but the error page.
   */
  it('budgets every page in the build, and drops only the error page', () => {
    for (const target of targets) {
      const routes = target.pages.map((page) => page.route).sort();
      expect(routes, target.name).toEqual(
        [
          ...new Set(
            pagesBuild
              .htmlFiles()
              .filter((file) => file.endsWith('index.html'))
              .map(
                (file) => `/${file.slice(0, -'index.html'.length)}`.replace(/\/$/, '') || '/',
              ),
          ),
        ].sort(),
      );

      // `404.html` and nothing else. It is the one page that **declares no canonical**,
      // deliberately (MUSE-38), and every request here is checked against the canonical
      // the page declares (MUSE-62) — so it fails that check by construction, and
      // relaxing the check to weigh it would give back the hole that had
      // `test/fonts.test.ts` measuring the error page in CI for months.
      expect(
        target.skipped.map((page) => page.path.replace(target.base, '/')),
        target.name,
      ).toEqual(['/404']);
    }
  });

  /**
   * Every page URL the budget measures is the slashed spelling, not the redirect.
   *
   * MUSE-62's finding: a route spelled without its trailing slash is answered 200 and
   * silently measures the redirect target, and six of eleven font tests stayed green on
   * exactly that. `pagePath` is the one place the slash is added, so the comparison is
   * against it rather than against a regex.
   */
  it('measures the slashed spelling of every page', () => {
    for (const target of targets) {
      for (const page of target.pages) {
        expect(page.path, `${target.name} ${page.route}`).toBe(
          pagePath(target.base, page.route),
        );
      }
    }
  });
});

/**
 * The failure messages, exercised on measurements built by hand.
 *
 * A real page cannot be over budget — it is the whole point of the suite above — so the
 * only way to know what the gate *says* when it fires is to hand `checkBudget` a page that
 * is. The bloat proofs in the ticket are the end-to-end version of these; these are the
 * version that stays.
 */
describe('MUSE-63: a page over budget names itself', () => {
  /**
   * A page comfortably inside every budget, to mutate one field of at a time.
   *
   * Two images, which is every page of this site: the footer lockup and the masthead mark.
   * They are here because `html`, `total` and `requests` carry a per-`<img>` allowance
   * (MUSE-25), so a fixture with no images would be judged against a different number than
   * any real page is — and the allowance is small enough at two that the overruns below
   * still read as the numbers in `BUDGET`.
   */
  const lean = () => ({
    route: '/schedule/',
    measured: { url: 'http://127.0.0.1/MuseByMina/schedule/', locale: 'hr', lang: 'hr-HR' },
    viewport: VIEWPORTS[1],
    widthRules: ['(min-width: 768px)'],
    bytes: { html: 22_000, css: 25_000, font: 215_000, image: 12_956 },
    total: 274_956,
    requests: 8,
    images: 2,
    imageResponses: [
      { url: 'http://h/_astro/muse-lockup-white.abc.webp', bytes: 11_356 },
      { url: 'http://h/_astro/muse-mark-white.def.webp', bytes: 1_600 },
    ],
    renderBlocking: 2,
    blocking: ['stylesheet a.css', 'stylesheet b.css'],
    missing: [],
    fonts: ['a.woff2', 'b.woff2', 'c.woff2', 'd.woff2', 'e.woff2'],
    advisory: { loadMs: 50, firstPaintMs: 30 },
  });

  it('passes the page it was calibrated against', () => {
    expect(checkBudget(lean())).toEqual([]);
  });

  /**
   * **The width is part of „which page"** (MUSE-104).
   *
   * Every route is now measured once per viewport, so a failure saying only `/schedule/`
   * names half of what the reader has to reproduce — and „over at one width and not the
   * other" is the shape of this ticket's whole defect.
   */
  it('names the width the measurement was taken at', () => {
    const page = lean();
    const heavy = { bytes: { ...page.bytes, css: 90 * 1024 } };

    const [wide] = checkBudget({ ...page, ...heavy, viewport: VIEWPORTS[1] });
    const [narrow] = checkBudget({ ...page, ...heavy, viewport: VIEWPORTS[0] });

    expect(wide).toContain(`/schedule/ @${VIEWPORTS[1].width}`);
    expect(narrow).toContain(`/schedule/ @${VIEWPORTS[0].width}`);
    // Still the shape AC1 asks for, in that order: which page, what about it, what we
    // agreed, what it is.
    expect(wide).toContain('css  budget 40.0 KB  actual 90.0 KB');
  });

  /**
   * **A CSS `background-image` is weighed like any other image** (MUSE-104's AC2).
   *
   * It costs no markup, so `imagesIn` does not see it and it buys **no** per-`<img>`
   * allowance — the stricter direction, and the right one: the allowance exists because a
   * responsive ladder is paid in the document, and a background has no ladder. What it may
   * not do is make the bytes vanish, which is exactly what happened while the measurement
   * had no viewport: the response was never made at all.
   */
  it('budgets a background image, which buys no per-image allowance', () => {
    const page = lean();
    const hero = { url: 'http://h/_astro/qa-wide-hero.abc.webp', bytes: 750_623 };

    const [problem, ...rest] = checkBudget({
      ...page,
      // The document is unchanged — a background adds no `<img>` — so `images` stays 2.
      bytes: { ...page.bytes, image: 12_956 + hero.bytes },
      total: page.total + hero.bytes,
      imageResponses: [...page.imageResponses, hero],
      requests: 9,
    });

    expect(rest).toEqual([]);
    expect(problem).toContain('image response');
    expect(problem).toContain('budget 32.0 KB');
    expect(problem).toContain('actual 733.0 KB');
    expect(problem).toContain('qa-wide-hero');
  });

  /**
   * AC1's wording, held literally: the route, the resource type, the budget and the
   * actual. All four, because a failure missing any one of them sends the reader back to
   * re-run the gate with different arguments.
   */
  const overruns: {
    kind: string;
    bytes: Record<string, number>;
    budget: string;
    actual: string;
  }[] = [
    // `html` is the one line with a per-`<img>` allowance here, so the budget it names is
    // 48 KB plus 1,280 bytes for each of the fixture's two images (MUSE-25).
    { kind: 'html', bytes: { html: 60 * 1024 }, budget: '50.5 KB', actual: '60.0 KB' },
    { kind: 'css', bytes: { css: 90 * 1024 }, budget: '40.0 KB', actual: '90.0 KB' },
    { kind: 'font', bytes: { font: 400 * 1024 }, budget: '288.0 KB', actual: '400.0 KB' },
  ];

  it.each(overruns)(
    'names the route, $kind, the budget and the actual',
    ({ kind, bytes, budget, actual }) => {
      const page = lean();
      const [problem, ...rest] = checkBudget({ ...page, bytes: { ...page.bytes, ...bytes } });

      expect(rest).toEqual([]);
      expect(problem).toContain('/schedule/');
      expect(problem).toContain(kind);
      expect(problem).toContain(`budget ${budget}`);
      expect(problem).toContain(`actual ${actual}`);
    },
  );

  it('fails a page over the total even when every kind is inside its own', () => {
    // The reason `total` is tighter than the sum of the per-kind lines: three kinds each
    // at 90% of budget is a 340 KB page nobody agreed to.
    const page = lean();
    const [problem, ...rest] = checkBudget({
      ...page,
      bytes: { html: 44 * 1024, css: 36 * 1024, font: 280 * 1024 },
      imageResponses: [],
      total: 360 * 1024 + 2 * 1280 + 1,
    });

    expect(rest).toEqual([]);
    expect(problem).toContain('total');
    // 360 KB plus the two images' allowance, which is what the gate compared against.
    expect(problem).toContain('budget 362.5 KB');
  });

  /**
   * **MUSE-25: photography is out of the total, and each image is budgeted on its own.**
   *
   * The two halves of the same decision, and each needs its own proof because they fail in
   * opposite directions. A gallery's *sum* is a statement about how many photographs Mina
   * published — editorial, unbounded, and not something a byte ceiling can hold — so it is
   * excluded. What replaces it is a ceiling on one response, which is a statement about
   * something a developer can fix and which fires on every page rather than only on the one
   * with a grid.
   */
  it('does not count photography towards the total', () => {
    // 600 KB of correctly-sized photographs: a thirty-picture gallery. Nothing is over.
    const page = lean();
    const images = Array.from({ length: 30 }, (_, index) => ({
      url: `http://h/photo-${index}.webp`,
      bytes: 20_000,
    }));
    expect(
      checkBudget({
        ...page,
        bytes: { ...page.bytes, image: 600_000 },
        imageResponses: images,
        images: 60,
        requests: 38,
        total: 274_956 - 12_956 + 600_000,
      }),
    ).toEqual([]);
  });

  it('fails one image that is bigger than its box, naming the file', () => {
    const page = lean();
    const [problem, ...rest] = checkBudget({
      ...page,
      bytes: { ...page.bytes, image: 12_956 + 297_000 },
      total: page.total + 297_000,
      imageResponses: [...page.imageResponses, { url: 'http://h/huge.webp', bytes: 297_000 }],
      images: 3,
    });

    expect(rest).toEqual([]);
    expect(problem).toContain('/schedule/');
    expect(problem).toContain('image response');
    expect(problem).toContain('budget 32.0 KB');
    expect(problem).toContain('actual 290.0 KB');
    // The file, because „this page carries 300 KB of photography" does not say which one.
    expect(problem).toContain('huge.webp');
    // And where the widths are decided, because that is the fix.
    expect(problem).toContain('src/lib/gallery.ts');
  });

  it('allows html, total and requests to grow with the images in the document', () => {
    // A twelve-photograph gallery: 26 `<img>`, so 26 × 1,280 bytes of `srcset` allowance on
    // html and on total, and 26 more requests. Measured 42.0 KB of html and 23 requests.
    const page = lean();
    expect(
      checkBudget({
        ...page,
        bytes: { html: 43_008, css: 23_000, font: 248_000, image: 151_000 },
        total: 43_008 + 23_000 + 248_000 + 151_000,
        images: 26,
        requests: 23,
        imageResponses: Array.from({ length: 14 }, (_, index) => ({
          url: `http://h/tile-${index}.webp`,
          bytes: 11_500,
        })),
      }),
    ).toEqual([]);

    // And the allowance is per image, not a blanket raise: a gallery's html on a page with
    // two images is over, because two images buy 2.5 KB and not 32 KB.
    const [problem] = checkBudget({ ...page, bytes: { ...page.bytes, html: 64_600 } });
    expect(problem).toContain('html');
    expect(problem).toContain('budget 50.5 KB');
    expect(problem).toContain('actual 63.1 KB');
  });

  it.each([
    // 14 plus the fixture's two images (MUSE-25), so the first count that is over is 17.
    { what: 'requests', page: { requests: 17 }, says: 'requests  budget 16  actual 17' },
    {
      what: 'render-blocking requests',
      page: { renderBlocking: 5 },
      says: 'render-blocking  budget 4  actual 5',
    },
  ])('fails on too many $what', ({ page, says }) => {
    const [problem, ...rest] = checkBudget({ ...lean(), ...page });
    expect(rest).toEqual([]);
    expect(problem).toContain(says);
  });

  /**
   * **AC4: zero has to fail as loudly as seven.**
   *
   * MUSE-35 was a zero. All six faces 404ed under `astro dev` and every page was silently
   * set in Georgia; a budget with only a ceiling reads that as the leanest page it has
   * ever seen. Seven is the other end — a face declared twice, or a second copy of a file
   * in the output, which is bytes the page never paints with and every URL still 200.
   */
  it.each([
    { faces: 0, says: 'budget at least 1  actual 0' },
    { faces: 7, says: 'budget at most 6  actual 7' },
  ])('fails on $faces font faces', ({ faces, says }) => {
    const fonts = Array.from({ length: faces }, (_, index) => `face-${index}.woff2`);
    const [problem, ...rest] = checkBudget({ ...lean(), fonts });

    expect(rest).toEqual([]);
    expect(problem).toContain('/schedule/');
    expect(problem).toContain('font faces');
    expect(problem).toContain(says);
  });

  it('says what a zero means, because nothing about the page looks wrong', () => {
    // The symptom of MUSE-35 was a site that rendered perfectly in the wrong typeface. A
    // failure saying only "0 is less than 1" would be read as a broken harness.
    const [problem] = checkBudget({ ...lean(), fonts: [] });
    expect(problem).toContain('MUSE-35');
    expect(problem).toContain('Georgia');
  });

  /**
   * A resource kind nobody budgeted is a failure in its own right.
   *
   * This is how `.js` is covered without restating `test/nojs.test.ts`'s claim — that
   * suite owns "no script file is in `dist`", against the output and with an extension
   * allow-list, and two answers to one question is how this repository's worst bugs have
   * started. What the budget adds is the same defect seen from the wire, plus every *other*
   * kind nobody has thought of: a `.wasm`, a `.webm`, a tracking pixel from a third party.
   */
  it('refuses a resource kind that has no budget at all', () => {
    expect(BUDGET.bytes).not.toHaveProperty('js');
    // `image` is also not in `BUDGET.bytes` — it is budgeted per response (MUSE-25) — and
    // it must **not** be reported as unbudgeted, which would be a true sentence about a
    // kind that now has a stricter budget than it used to.
    expect(BUDGET.bytes).not.toHaveProperty('image');
    expect(BUDGET.imageResponse).toBeGreaterThan(0);
    expect(checkBudget(lean()).join(' ')).not.toContain('no budget exists for image');

    const page = lean();
    const [problem, ...rest] = checkBudget({
      ...page,
      bytes: { ...page.bytes, js: 4096 },
    });

    expect(rest).toEqual([]);
    expect(problem).toContain('/schedule/');
    expect(problem).toContain('js');
    expect(problem).toContain('none declared');
    expect(problem).toContain('4.0 KB');
  });

  /**
   * **AC5, stated behaviourally: the gate cannot see a timing.**
   *
   * A comment saying "advisory" is a comment. This hands `checkBudget` the same page with
   * a load time of forty minutes and demands the same answer, so the day somebody adds
   * `if (page.advisory.loadMs > …)` — which will read like an improvement — this is the
   * test that goes red.
   */
  it('is unaffected by the advisory timing, in either direction', () => {
    const page = lean();
    const absurd = { loadMs: 2_400_000, firstPaintMs: 2_400_000 };
    const missing = { loadMs: null, firstPaintMs: null };

    expect(checkBudget({ ...page, advisory: absurd })).toEqual([]);
    expect(checkBudget({ ...page, advisory: missing })).toEqual([]);
    expect(checkBudget({ ...page, advisory: absurd, bytes: { html: 60 * 1024 } })).toEqual(
      checkBudget({ ...page, advisory: missing, bytes: { html: 60 * 1024 } }),
    );
  });
});

/**
 * The classifier and the render-blocking count, which are the two places a budget can go
 * quiet without going wrong: a kind misread as `other` is bytes nothing weighs, and a
 * blocking stylesheet read as non-blocking is a count that never moves.
 */
describe('MUSE-63: what the measurement calls things', () => {
  it.each([
    { url: 'http://h/MuseByMina/schedule/', type: 'document', kind: 'html' },
    { url: 'http://h/MuseByMina/_astro/x.css', type: 'stylesheet', kind: 'css' },
    { url: 'http://h/MuseByMina/_astro/inter.woff2', type: 'font', kind: 'font' },
    { url: 'http://h/MuseByMina/hero.avif', type: 'image', kind: 'image' },
    { url: 'http://h/MuseByMina/hero.svg', type: 'image', kind: 'image' },
    { url: 'http://h/MuseByMina/_astro/page.js', type: 'script', kind: 'js' },
    { url: 'http://h/MuseByMina/404', type: 'document', kind: 'html' },
  ])('calls $url $kind', ({ url, type, kind }) => {
    expect(kindOf(url, type)).toBe(kind);
  });

  it('names an unrecognised resource type rather than pooling it', () => {
    // `other` would be a budget line nobody can act on. The type comes through in the
    // kind, so the failure message says what arrived.
    expect(kindOf('http://h/MuseByMina/track', 'websocket')).toBe('other:websocket');
  });

  it('counts a stylesheet as blocking and a preload as not', () => {
    const html =
      '<link rel="stylesheet" href="/a.css">' +
      '<link rel="preload" href="/b.woff2" as="font">' +
      '<link rel="stylesheet" href="/print.css" media="print">' +
      '<link rel="canonical" href="https://x/">';
    expect(renderBlocking(html).count).toBe(1);
    expect(renderBlocking(html).what).toEqual(['stylesheet /a.css']);
  });

  it('counts a synchronous script as blocking and a deferred one as not', () => {
    // Nothing on this site emits either — `test/nojs.test.ts` owns that — which is exactly
    // why the rule is tested rather than assumed: the day one appears, this is the number
    // that has to move.
    expect(renderBlocking('<script src="/a.js"></script>').count).toBe(1);
    expect(renderBlocking('<script src="/a.js" defer></script>').count).toBe(0);
    expect(renderBlocking('<script type="module" src="/a.js"></script>').count).toBe(0);
    expect(renderBlocking('<script>console.log(1)</script>').count).toBe(0);
  });

  it('prints a headroom row, because that row is the deliverable', () => {
    const lines = report([
      {
        route: '/schedule/',
        measured: { url: 'http://h/', locale: 'hr', lang: 'hr-HR' },
        viewport: VIEWPORTS[1],
        widthRules: ['(min-width: 768px)'],
        bytes: { html: 22_000, css: 25_000, font: 215_000, image: 11_356 },
        total: 273_356,
        requests: 8,
        images: 2,
        imageResponses: [{ url: 'http://h/lockup.webp', bytes: 11_356 }],
        renderBlocking: 2,
        blocking: [],
        missing: [],
        fonts: ['a.woff2'],
        advisory: { loadMs: 50, firstPaintMs: 30 },
      },
    ]);

    expect(lines.join('\n')).toContain('headroom');
    expect(lines.join('\n')).toContain('advisory');
    /**
     * **The headroom shown is the headroom the gate uses** (MUSE-25).
     *
     * `html`, `total` and `requests` carry a per-`<img>` allowance and `image` is budgeted
     * per response, so printing `BUDGET.bytes.html` on its own would show a room the gate
     * does not give — which is the single thing this table must never do, since MUSE-63's
     * second criterion is that the next ticket reads its room off here instead of
     * discovering it by going red.
     */
    const budgetRow = lines.find((line) => line.startsWith('budget'))!;
    // 48 KB + two images' allowance, and the per-response image ceiling said as such.
    expect(budgetRow).toContain('50.5 KB');
    expect(budgetRow).toContain('32.0 KB ea');
    // And the footnote that says why those two cells are not simple sums.
    expect(lines.join('\n')).toContain('editorial decision');
    // The row is one measurement, so the table says which width it was taken at and names
    // the whole set — the decision is in the output a person reads, not only in the source
    // (MUSE-104).
    expect(lines.join('\n')).toContain('once per viewport');
    for (const viewport of VIEWPORTS) {
      expect(lines.join('\n')).toContain(`${viewport.width}×${viewport.height}`);
    }
    expect(lines.some((line) => line.startsWith(`/schedule/ @${VIEWPORTS[1].width}`))).toBe(
      true,
    );
  });
});

/**
 * **MUSE-104 — the widths the measurement is taken at, and the proof that they cover the
 * site.**
 *
 * No `viewport` was set anywhere in `scripts/budget.mjs` or `scripts/browser-checks.mjs`,
 * so every number was measured at Playwright's default 1280 × 720 **by default rather than
 * by decision** — and an image painted only outside that width cost nothing, because the
 * browser never made the request. QA proved it with a 750,623-byte raster behind
 * `@media (min-width: 1400px)`: `npm run budget` reported `image 12.7 KB` on every page,
 * unchanged headroom and „All 22 pages within budget."
 *
 * Two things are asserted here and they are different claims. The **viewports** are a
 * decision, so they are held to the site's own breakpoints rather than to round numbers:
 * the widest measures the top band and the narrowest is below the lowest breakpoint, which
 * is the half the old default could not see at all. The **cover** is what makes two widths
 * honest rather than lucky: a width-conditional rule that no measured viewport satisfies is
 * a failure naming the rule, so the next `min-width` nobody measures is red instead of
 * free. Both instruments, for MUSE-42's reason — the `dist` scan names the *file*, which a
 * browser measurement cannot, and the browser sees what a page really loads, which a scan
 * of the output cannot.
 */
describe('MUSE-104: the budget measures widths it chose', () => {
  /** Every `@media` condition in the build, with the file that declares it. */
  const declaredConditions = (): { where: string; condition: string }[] => {
    const found: { where: string; condition: string }[] = [];

    for (const file of pagesBuild.allFiles().filter((name) => name.endsWith('.css'))) {
      for (const condition of widthConditionsIn(pagesBuild.read(file))) {
        found.push({ where: file, condition });
      }
    }
    // Inline `<style>` too: `src/lib/theme.ts` and the components' scoped blocks can both
    // land in the document, and a scan that reads only the emitted stylesheets would miss
    // a breakpoint declared there.
    for (const file of pagesBuild.htmlFiles()) {
      for (const block of styleBlocks(pagesBuild.read(file))) {
        for (const condition of widthConditionsIn(block))
          found.push({ where: file, condition });
      }
    }

    return found;
  };

  it('declares at least one viewport, each a full measurement condition', () => {
    expect(VIEWPORTS.length).toBeGreaterThan(0);
    for (const viewport of VIEWPORTS) {
      expect(viewport.width, viewport.name).toBeGreaterThan(0);
      expect(viewport.height, viewport.name).toBeGreaterThan(0);
      // MUSE-64's argument, now written down rather than inherited from Playwright: the
      // lockup ships one 320px WebP with no `srcset`, so a 2× entry would budget a file
      // almost nobody fetches.
      expect(viewport.deviceScaleFactor, viewport.name).toBe(1);
    }
    expect(new Set(VIEWPORTS.map((viewport) => viewport.width)).size).toBe(VIEWPORTS.length);
  });

  /**
   * The `dist` half of the cover, which names the file.
   *
   * There is no list of stylesheets here and no list of breakpoints: both are read off the
   * build, so a component that lands tomorrow is covered the day it builds.
   */
  it('measures a width inside every band the built CSS declares', () => {
    const conditions = declaredConditions();
    // A scan that finds nothing passes. This site declares five breakpoints.
    expect(conditions.length).toBeGreaterThan(0);

    const uncovered = conditions.filter(
      ({ condition }) =>
        !VIEWPORTS.some((viewport) => widthConstraints(condition).satisfiedBy(viewport.width)),
    );
    expect(uncovered.map(({ where, condition }) => `${where}: ${condition}`)).toEqual([]);
  });

  /**
   * **The bottom band is measured, which the cover alone does not say.**
   *
   * Every rule on this site is a `min-width`, so two viewports both sitting in the top band
   * would satisfy the check above and leave a phone-only hero free — the same defect read
   * from the other end. So the narrowest viewport has to be below the lowest breakpoint the
   * CSS declares, and the widest at or above the highest.
   */
  it('measures below the lowest breakpoint and at or above the highest', () => {
    const boundaries = declaredConditions().flatMap(({ condition }) =>
      widthConstraints(condition).constraints.map((constraint) => constraint.px),
    );
    expect(boundaries.length).toBeGreaterThan(0);

    const widths = VIEWPORTS.map((viewport) => viewport.width);
    expect(Math.min(...widths)).toBeLessThan(Math.min(...boundaries));
    expect(Math.max(...widths)).toBeGreaterThanOrEqual(Math.max(...boundaries));
  });

  it.each([
    { condition: '(min-width: 768px)', px: [768], readable: true },
    { condition: 'screen and (min-width: 900px)', px: [900], readable: true },
    { condition: '(max-width: 639px)', px: [639], readable: true },
    { condition: '(min-width: 400px) and (max-width: 600px)', px: [400, 600], readable: true },
    { condition: '(width >= 768px)', px: [768], readable: true },
    // No width feature at all: any viewport exercises it, so it is not this check's
    // business — and saying so is what keeps the check from firing on every theme query.
    { condition: '(prefers-color-scheme: dark)', px: [], readable: true },
    { condition: '(hover: none)', px: [], readable: true },
    // Names a width this cannot evaluate. **Unreadable is a failure, not a skip**: a
    // condition silently treated as width-free is the hole this ticket is about, one layer
    // in.
    { condition: '(min-width: 40em)', px: [], readable: false },
    { condition: '(min-device-width: 768px)', px: [], readable: false },
  ])('reads $condition', ({ condition, px, readable }) => {
    const read = widthConstraints(condition);
    expect(read.readable).toBe(readable);
    expect(read.constraints.map((constraint) => constraint.px)).toEqual(px);
  });

  it('pulls the conditions out of raw CSS, nested ones included', () => {
    expect(
      widthConditionsIn(
        '.a{color:red}@media (min-width: 768px){.b{color:blue}}' +
          '@supports (display:grid){@media screen and (max-width:639px){.c{color:green}}}',
      ),
    ).toEqual(['(min-width: 768px)', 'screen and (max-width:639px)']);
  });

  /** A measurement, as thin as the coverage check needs it. */
  const measuredWith = (widthRules: string[]) => ({
    route: '/schedule/',
    viewport: VIEWPORTS[0],
    widthRules,
  });

  it.each([
    {
      what: 'a breakpoint above every measured width',
      rules: ['(min-width: 1400px)'],
      says: '(min-width: 1400px)',
    },
    {
      what: 'a ceiling below every measured width',
      rules: ['(max-width: 320px)'],
      says: '(max-width: 320px)',
    },
    {
      what: 'a band with no measured width in it',
      rules: ['(min-width: 500px) and (max-width: 700px)'],
      says: '(min-width: 500px) and (max-width: 700px)',
    },
    {
      what: 'a width it cannot read',
      rules: ['(min-width: 40em)'],
      says: '(min-width: 40em)',
    },
  ])('fails on $what', ({ rules, says }) => {
    const [problem, ...rest] = uncoveredWidthRules([measuredWith(rules)]);

    expect(rest).toEqual([]);
    expect(problem).toContain('/schedule/');
    expect(problem).toContain(says);
    // Where the decision is made, and what the two choices are.
    expect(problem).toContain('scripts/budget.mjs');
    for (const viewport of VIEWPORTS) expect(problem).toContain(String(viewport.width));
  });

  it('passes a rule some measured width satisfies, and says so once per rule', () => {
    expect(
      uncoveredWidthRules([
        measuredWith([
          '(min-width: 768px)',
          '(max-width: 639px)',
          '(prefers-color-scheme: dark)',
        ]),
      ]),
    ).toEqual([]);

    // The same bad rule on every page of the site is one decision, so it is one line —
    // naming how many pages carry it rather than printing forty-four of them.
    const everywhere = Array.from({ length: 4 }, () => measuredWith(['(min-width: 1400px)']));
    const problems = uncoveredWidthRules(everywhere);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('4');
  });
});

/**
 * **MUSE-104 — a budget key that is not there names itself.**
 *
 * `checkBudget` read `BUDGET.total`, `BUDGET.requests` and `BUDGET.fonts.min` without
 * asking whether they were numbers. Deleting one did not fail the page it was supposed to
 * judge: `actual > undefined` is `false`, so the line simply stopped having an opinion, and
 * `BUDGET.fonts` deleted threw a `TypeError` out of the gate instead. Both are the same
 * defect as MUSE-77's — a guard whose failure sends the reader nowhere.
 *
 * So every ceiling is read through one accessor that reports a problem in the same shape as
 * every other: the route, the width, the kind, and what is missing.
 */
describe('MUSE-104: a missing budget key is a failure, not a silence', () => {
  /** Delete a key for one assertion and put it back, whatever the assertion does. */
  const without = (path: string, run: () => void): void => {
    const keys = path.split('.');
    const last = keys.pop()!;
    const owner = keys.reduce<Record<string, unknown>>(
      (node, key) => node[key] as Record<string, unknown>,
      BUDGET as unknown as Record<string, unknown>,
    );
    const had = owner[last];
    delete owner[last];
    try {
      run();
    } finally {
      owner[last] = had;
    }
  };

  const lean = () => ({
    route: '/schedule/',
    measured: { url: 'http://127.0.0.1/MuseByMina/schedule/', locale: 'hr', lang: 'hr-HR' },
    viewport: VIEWPORTS[1],
    widthRules: ['(min-width: 768px)'],
    bytes: { html: 22_000, css: 25_000, font: 215_000, image: 12_956 },
    total: 274_956,
    requests: 8,
    images: 2,
    imageResponses: [{ url: 'http://h/_astro/muse-lockup-white.abc.webp', bytes: 11_356 }],
    renderBlocking: 2,
    blocking: [],
    missing: [],
    fonts: ['a.woff2', 'b.woff2'],
    advisory: { loadMs: 50, firstPaintMs: 30 },
  });

  it.each([
    { path: 'bytes.css', kind: 'css' },
    { path: 'total', kind: 'total' },
    { path: 'requests', kind: 'requests' },
    { path: 'renderBlocking', kind: 'render-blocking' },
    { path: 'imageResponse', kind: 'image response' },
    { path: 'fonts', kind: 'font faces' },
    { path: 'fonts.min', kind: 'font faces' },
    { path: 'fonts.max', kind: 'font faces' },
    { path: 'perImage', kind: 'perImage' },
  ])('names the route, the width and $kind when BUDGET.$path is gone', ({ path, kind }) => {
    without(path, () => {
      const problems = checkBudget(lean());
      const problem = problems.find((line) => line.includes(kind));

      expect(problem, `nothing named ${kind}; got ${JSON.stringify(problems)}`).toBeDefined();
      expect(problem).toContain(`/schedule/ @${VIEWPORTS[1].width}`);
      // And it says where to fix it, rather than printing `NaN` and carrying on.
      expect(problem).toContain('scripts/budget.mjs');
    });
  });
});

/**
 * **The duplicated "I measured the page I named" check, pinned to the original.**
 *
 * `test/helpers/measured.ts` is MUSE-62's implementation and where the reasoning lives,
 * but it is TypeScript under `test/` and `scripts/budget.mjs` is a `.mjs` script: a `.mjs`
 * file cannot import a `.ts` helper. That is the same wall that put `resolveRequest` in
 * `scripts/` (MUSE-52) and `openCheckPage` there too (MUSE-48), and the repository's answer
 * both times was to move the shared thing into `scripts/` and re-export it. Moving this one
 * means moving a module MUSE-62 landed last week and whose doc comment is three paragraphs
 * about why the canonical and not the body — a worse trade than a second implementation
 * with a test holding it to the first.
 *
 * So: the two are exercised on the same documents and must agree, **including on the error
 * page**, which declares no canonical by design and which both must therefore reject. If
 * they ever disagree, one of them has stopped being able to tell a page from the 404, and
 * which one is a question this test answers rather than asks.
 */
describe('MUSE-63: the budget cannot be fooled about which page it weighed', () => {
  const asked = `${PAGES_DEPLOY.SITE}${PAGES_DEPLOY.BASE}/schedule/`;

  const bothAgree = (where: string, url: string, html: string) => {
    const first = (() => {
      try {
        assertMeasuredPage(url, html);
        return null;
      } catch (problem) {
        return (problem as Error).message;
      }
    })();
    const second = (() => {
      try {
        assertDocumentIsItself('/schedule/', url, html);
        return null;
      } catch (problem) {
        return (problem as Error).message;
      }
    })();

    expect(
      [first === null, second === null],
      `${where}: test/helpers/measured.ts and scripts/budget.mjs disagree\n` +
        `  measured.ts: ${first ?? 'accepted'}\n  budget.mjs:  ${second ?? 'accepted'}`,
    ).toEqual([first === null, first === null]);
    return second;
  };

  it('accepts a real page', () => {
    expect(bothAgree('/schedule/', asked, pagesBuild.read('schedule/index.html'))).toBeNull();
  });

  it('rejects the error page, which declares no canonical by design', () => {
    const problem = bothAgree('404.html', asked, pagesBuild.read('404.html'));
    expect(problem).toContain('canonical');
    expect(problem).toContain('MUSE-38');
  });

  it('rejects a page that says it is a different page', () => {
    const problem = bothAgree(
      '/en/schedule/',
      asked,
      pagesBuild.read('en/schedule/index.html'),
    );
    expect(problem).toContain('/MuseByMina/schedule/');
    expect(problem).toContain('/MuseByMina/en/schedule/');
  });
});

/**
 * **Every number in the budget has a sentence beside it, and the sentence names the
 * number.**
 *
 * MUSE-63's constraint, as a rule rather than as a request: "a number nobody can account
 * for is a number the next person quietly raises." The rule reads **syntax** — the
 * property's own leading JSDoc block, taken from the parser's comment ranges — for the
 * reason `test/helpers/source-guard.ts` writes out at length: a substring scan over source
 * reports prose and misses code.
 *
 * **It was a length check until MUSE-104, which is not the rule CLAUDE.md describes.** The
 * assertion was `comment.trim().length >= ACCOUNTED`, so it never read the number and could
 * not relate the two: raising `bytes.html` from `48 * 1024` to `480 * 1024` left the
 * sentence saying „48 KB is ~1.55× the worst page, 17.1 KB of headroom" and left this file
 * green. The promised outcome did hold — the fixtures above hand-transcribe every current
 * number, and `budget 50.5 KB` is a stronger guard than any prose rule — but crediting a
 * guarantee to the wrong mechanism is how it gets deleted in a tidy-up, and the transcribed
 * fixtures have no completeness check of their own.
 *
 * So the account must **contain the number as the source writes it**: `48 * 1024` is
 * accounted for by a sentence that says 48, `1280` by one that says 1,280. Thousands
 * separators are normalised away and the match is on digit boundaries, so „1,023 bytes per
 * `<img>`" cannot stand in for a 10 and „110 KB" cannot stand in for a 10 either.
 *
 * **And the walk descends to the numbers, not to the first node with a long enough
 * comment.** That was the second finding: `fonts` and `perImage` both carry long blocks, so
 * they were leaves and their children had no accounting requirement at all —
 * `perImage: { html: 1280, total: 1280, requests: 1, css: 1000000 }` raised every page's
 * CSS ceiling by about 1.95 MB with both assertions green and the path reported as
 * `perImage`. A number may still be accounted for by the paragraph *above* it, because
 * `fonts`'s floor and ceiling are one decision and one paragraph; what it may not be is
 * invisible.
 *
 * Two limits, stated rather than discovered. It cannot check that a sentence is **true**.
 * And on a one-digit number it is nearly vacuous — any paragraph mentioning a 1 accounts
 * for `fonts.min: 1` — which is why the proof below mutates every number by a factor of ten
 * rather than by one: what this rule is aimed at is the realistic raise, and the realistic
 * raise is an order of magnitude.
 */
describe('MUSE-63: the budget is accounted for, number by number', () => {
  /** Long enough to be an account rather than a label. `/** Bytes. *\/` is not a reason. */
  const ACCOUNTED = 120;

  /** One number in the source, with everything that may account for it. */
  interface Declared {
    /** `BUDGET.bytes.html`, `VIEWPORTS[0].width`. */
    path: string;
    /** Its own JSDoc and every enclosing one. */
    comments: string[];
    /** The initializer exactly as the source writes it — `48 * 1024`. */
    valueText: string;
    /** What that evaluates to, or `null` when this check cannot read it. */
    value: number | null;
    start: number;
    end: number;
  }

  const file = join(ROOT, 'scripts/budget.mjs');
  const budgetSource = () => readFileSync(file, 'utf8');

  /** The objects whose numbers have to be accounted for. Both are measurement decisions. */
  const DECIDED = ['BUDGET', 'VIEWPORTS'];

  /** Every number under `DECIDED`, found by parsing rather than by matching text. */
  function declaredNumbers(text: string = budgetSource()): Declared[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found: Declared[] = [];

    const leadingComment = (node: ts.Node): string =>
      (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [])
        .map((range) => text.slice(range.pos, range.end))
        .filter((comment) => comment.startsWith('/**'))
        .join('\n');

    /** `48 * 1024` → 49152; anything this cannot read is reported rather than skipped. */
    const valueOf = (expression: string): number | null => {
      const product = /^(\d+(?:\.\d+)?)\s*\*\s*(\d+(?:\.\d+)?)$/.exec(expression.trim());
      if (product !== null) return Number(product[1]) * Number(product[2]);
      return /^\d+(?:\.\d+)?$/.test(expression.trim()) ? Number(expression.trim()) : null;
    };

    const walk = (node: ts.Node, path: string, comments: string[]): void => {
      if (ts.isObjectLiteralExpression(node)) {
        for (const property of node.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          walk(property.initializer, `${path}.${property.name.getText(source)}`, [
            ...comments,
            leadingComment(property),
          ]);
        }
        return;
      }
      if (ts.isArrayLiteralExpression(node)) {
        node.elements.forEach((element, index) =>
          walk(element, `${path}[${index}]`, [...comments, leadingComment(element)]),
        );
        return;
      }
      // A string is a label, not a number — `VIEWPORTS[0].name` is `'phone'`.
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return;

      const valueText = node.getText(source);
      found.push({
        path,
        comments,
        valueText,
        value: valueOf(valueText),
        start: node.getStart(source),
        end: node.getEnd(),
      });
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        DECIDED.includes(node.name.getText(source)) &&
        node.initializer !== undefined
      ) {
        walk(node.initializer, node.name.getText(source), [leadingComment(node.parent.parent)]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    return found;
  }

  const accounts = (comment: string): boolean =>
    comment.replace(/[*/\s]+/g, ' ').trim().length >= ACCOUNTED;

  /**
   * The figures a sentence has to say to account for a number.
   *
   * `48 * 1024` is written about as „48 KB", never as 49,152 — so the factor of 1024 is a
   * unit and the operand is the figure. Anything else is quoted as the source writes it.
   */
  const figuresFor = (valueText: string): string[] => {
    const product = /^(\d+(?:\.\d+)?)\s*\*\s*1024$/.exec(valueText.trim());
    return [product === null ? valueText.trim() : product[1]];
  };

  /** Does any accounting paragraph actually say this figure? */
  const says = (comments: string[], figure: string): boolean => {
    // „1,280 bytes" is the same number as `1280`; the separator is typography.
    const prose = comments.join('\n').replace(/(?<=\d),(?=\d)/g, '');
    return new RegExp(`(?<![\\d.,])${figure.replace(/\./g, '\\.')}(?![\\d.,])`).test(prose);
  };

  /** Every number that is unaccounted for, or whose account does not name it. */
  function accountingProblems(text: string = budgetSource()): string[] {
    const problems: string[] = [];

    for (const entry of declaredNumbers(text)) {
      if (entry.value === null) {
        problems.push(
          `${entry.path}: this check cannot read \`${entry.valueText}\` as a number`,
        );
        continue;
      }
      const accounted = entry.comments.filter((comment) => accounts(comment));
      if (accounted.length === 0) {
        problems.push(`${entry.path}: no JSDoc beside it or above it says where it came from`);
        continue;
      }
      for (const figure of figuresFor(entry.valueText)) {
        if (!says(accounted, figure)) {
          problems.push(
            `${entry.path}: the account beside it never says ${figure} — it is ` +
              `\`${entry.valueText}\` now, and the sentence is about some other number`,
          );
        }
      }
    }

    return problems;
  }

  it('finds every number in the budget and in the viewports', () => {
    // The loops below are loops over this list. A discovery that silently stops matching
    // does not fail them — it makes them pass over nothing, which is the shape of "a check
    // that confirms the wrong thing" this repository has re-filed seven times. Spelled out
    // rather than counted, so a number that arrives has to be acknowledged here as well as
    // explained there — **including one under `fonts` or `perImage`**, which carry long
    // blocks and used to end the walk (MUSE-104).
    expect(
      declaredNumbers()
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([
      'BUDGET.bytes.css',
      'BUDGET.bytes.font',
      'BUDGET.bytes.html',
      'BUDGET.fonts.max',
      'BUDGET.fonts.min',
      // MUSE-25. `bytes.image` was here and is gone: photography is budgeted per response
      // rather than summed per page, and the per-`<img>` allowances are what keep the three
      // content-sensitive lines from being traps that fire on an editor's upload.
      'BUDGET.imageResponse',
      'BUDGET.perImage.html',
      'BUDGET.perImage.requests',
      'BUDGET.perImage.total',
      'BUDGET.renderBlocking',
      'BUDGET.requests',
      'BUDGET.total',
      // MUSE-104. A viewport is a number the measurement depends on, so it is held to the
      // same rule as a ceiling — there is no third place a number may live.
      'VIEWPORTS[0].deviceScaleFactor',
      'VIEWPORTS[0].height',
      'VIEWPORTS[0].width',
      'VIEWPORTS[1].deviceScaleFactor',
      'VIEWPORTS[1].height',
      'VIEWPORTS[1].width',
    ]);
  });

  /**
   * The parse agrees with the object the gate actually uses.
   *
   * Everything above reads the source as text. If the walk and the runtime value ever
   * disagree, the accounting is about a file nobody imports — so each path is resolved
   * against the real `BUDGET` and `VIEWPORTS` and the values compared.
   */
  it('reads the same numbers the gate compares against', () => {
    const live: Record<string, unknown> = { BUDGET, VIEWPORTS };

    for (const entry of declaredNumbers()) {
      const value = entry.path
        .split(/\.|\[|\]/)
        .filter(Boolean)
        .reduce<unknown>(
          (node, key) => (node as Record<string, unknown>)[key],
          live as unknown as Record<string, unknown>,
        );
      expect(value, entry.path).toBe(entry.value);
    }
  });

  it('gives every one of them a sentence that says where it came from', () => {
    expect(accountingProblems()).toEqual([]);
  });

  /**
   * **The proof that the rule has teeth, run over the real numbers.**
   *
   * Every number in the file is raised by a factor of ten with its comment untouched, and
   * every one of them has to be caught by name. This is the mutation MUSE-104 landed on
   * `bytes.html` and three others, as a test rather than as a transcript.
   */
  it('catches every number raised tenfold while its sentence stays the same', () => {
    const text = budgetSource();
    const survived: string[] = [];

    for (const entry of declaredNumbers(text)) {
      expect(entry.value, entry.path).not.toBeNull();
      // The *form* is kept — `48 * 1024` becomes `480 * 1024` — because that is how the
      // raise would really be written, and the figure the sentence has to name is the
      // operand rather than the product.
      const raised = entry.valueText.replace(/\d+(?:\.\d+)?/, (first) =>
        String(Number(first) * 10),
      );
      const problems = accountingProblems(
        text.slice(0, entry.start) + raised + text.slice(entry.end),
      );
      if (!problems.some((problem) => problem.startsWith(`${entry.path}:`))) {
        survived.push(`${entry.path}: ${entry.valueText} → ${raised} went unnoticed`);
      }
    }

    expect(survived).toEqual([]);
  });

  it('keeps the numbers themselves in one place', () => {
    // The gate and `npm run budget` import the same object. Two copies would be two
    // answers to "what did we agree", and the looser one would be the one that stopped
    // noticing.
    const suite = readFileSync(join(ROOT, 'test/budget.test.ts'), 'utf8');
    const script = budgetSource();

    expect(suite).toContain("from '../scripts/budget.mjs'");
    expect(script).toMatch(/^export const BUDGET = \{$/m);
    expect(script).toMatch(/^export const VIEWPORTS = \[$/m);
    // Nothing may declare a second budget object, or a second set of widths, beside them.
    expect(script.match(/^export const BUDGET = /gm)).toHaveLength(1);
    expect(script.match(/^export const VIEWPORTS = /gm)).toHaveLength(1);
  });
});

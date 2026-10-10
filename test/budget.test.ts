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
} from '../scripts/budget.mjs';
import { auditTargets, pagePath } from '../scripts/dist-origin.mjs';
import { APEX_DEPLOY, basePath, buildSite, PAGES_DEPLOY, type Build } from './helpers/build';
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
        const measurement = await measurePage(browser, at(target.host, page.path), page.route);
        measured.push({ target: target.name, measurement });
        problems.push(...checkBudget(measurement).map((line) => `${target.name}: ${line}`));
      }
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
 * **Every number in the budget has a sentence beside it.**
 *
 * MUSE-63's constraint, as a rule rather than as a request: "a number nobody can account
 * for is a number the next person quietly raises." The rule reads **syntax** — the
 * property's own leading JSDoc block, taken from the parser's comment ranges — for the
 * reason `test/helpers/source-guard.ts` writes out at length: a substring scan over source
 * reports prose and misses code.
 *
 * The walk descends until it finds an account, so a group of numbers may be accounted for
 * together (`fonts`'s floor and ceiling are one decision and one paragraph) while a number
 * on its own may not. A node with neither an account nor children is the failure.
 *
 * It cannot check that the sentence is *true*. What it can do is make raising a number
 * without saying anything about it impossible, which is the move this is aimed at — and the
 * exact-list assertion below means a **new** number forces the decision either way.
 */
describe('MUSE-63: the budget is accounted for, number by number', () => {
  /** Long enough to be an account rather than a label. `/** Bytes. *\/` is not a reason. */
  const ACCOUNTED = 120;

  /** Every number in `BUDGET`, or the group that accounts for it, with its comment. */
  function declaredNumbers(): { path: string; comment: string }[] {
    const file = join(ROOT, 'scripts/budget.mjs');
    const text = readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);

    const found: { path: string; comment: string }[] = [];

    const leadingComment = (node: ts.Node): string =>
      (ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [])
        .map((range) => text.slice(range.pos, range.end))
        .filter((comment) => comment.startsWith('/**'))
        .join('\n');

    const accounts = (comment: string): boolean =>
      comment.replace(/[*/\s]+/g, ' ').trim().length >= ACCOUNTED;

    const walk = (object: ts.ObjectLiteralExpression, prefix: string): void => {
      for (const property of object.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const path =
          prefix === ''
            ? property.name.getText(source)
            : `${prefix}.${property.name.getText(source)}`;
        const comment = leadingComment(property);
        if (!accounts(comment) && ts.isObjectLiteralExpression(property.initializer)) {
          walk(property.initializer, path);
          continue;
        }
        found.push({ path, comment });
      }
    };

    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText(source) === 'BUDGET' &&
        node.initializer !== undefined &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        walk(node.initializer, '');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    return found;
  }

  it('finds the budget in the source at all', () => {
    // The loop below is a loop over this list. A discovery that silently stops matching
    // does not fail it — it makes it pass over nothing, which is the shape of "a check
    // that confirms the wrong thing" this repository has re-filed seven times. Spelled out
    // rather than counted, so a number that arrives has to be acknowledged here as well as
    // explained there.
    expect(
      declaredNumbers()
        .map((entry) => entry.path)
        .sort(),
    ).toEqual([
      'bytes.css',
      'bytes.font',
      'bytes.html',
      'fonts',
      // MUSE-25. `bytes.image` was here and is gone: photography is budgeted per response
      // rather than summed per page, and the per-`<img>` allowances are what keep the three
      // content-sensitive lines from being traps that fire on an editor's upload.
      'imageResponse',
      'perImage',
      'renderBlocking',
      'requests',
      'total',
    ]);
  });

  it('gives every one of them a sentence saying where it came from', () => {
    const unaccounted = declaredNumbers()
      .filter((entry) => entry.comment.replace(/[*/\s]+/g, ' ').trim().length < ACCOUNTED)
      .map((entry) => entry.path);

    expect(unaccounted).toEqual([]);
  });

  it('keeps the numbers themselves in one place', () => {
    // The gate and `npm run budget` import the same object. Two copies would be two
    // answers to "what did we agree", and the looser one would be the one that stopped
    // noticing.
    const suite = readFileSync(join(ROOT, 'test/budget.test.ts'), 'utf8');
    const script = readFileSync(join(ROOT, 'scripts/budget.mjs'), 'utf8');

    expect(suite).toContain("from '../scripts/budget.mjs'");
    expect(script).toMatch(/^export const BUDGET = \{$/m);
    // Nothing may declare a second budget object beside it.
    expect(script.match(/^export const BUDGET = /gm)).toHaveLength(1);
  });
});

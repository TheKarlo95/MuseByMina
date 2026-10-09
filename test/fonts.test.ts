import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchChecks, localeOfRoute, openCheckPage } from '../scripts/browser-checks.mjs';
import {
  APEX_DEPLOY,
  basePath,
  buildSite,
  cssUrls,
  fontFaceUrls,
  linkHrefs,
  PAGES_DEPLOY,
  styleBlocks,
} from './helpers/build';
import { assertMeasuredPage, fetchMeasuredPage } from './helpers/measured';
import { astroDev, type DevServer } from './helpers/scratch';
import { servePages, type Host } from './helpers/serve';

/**
 * MUSE-35 — the webfonts must resolve, and the right ones must be preloaded, in every
 * environment this project is looked at in.
 *
 * `src/styles/fonts.css` declared `src: url('/fonts/…woff2')`. Vite rewrites a
 * root-absolute CSS `url()` to include `base` **only when it builds**, so the deployed
 * site was correct and `astro dev` answered all six with 404 and fell back to Georgia.
 *
 * ## Why this suite runs servers instead of reading `dist`
 *
 * Because every other suite reads `dist`, and that is exactly how this shipped. The
 * build was right. Every local visual check was made against a page set in the wrong
 * typeface, and the one that mattered was MUSE-14: class times rendered `II:OO` because
 * Cormorant defaults to old-style figures, and **Georgia has lining figures**, so in dev
 * the bug was invisible. A developer reproducing it locally would have concluded it was
 * already fixed.
 *
 * So every claim here is made over HTTP against a running server, in all three
 * environments the fonts have to work in: `astro dev`, and the built output of both
 * deploy targets. That makes AC4 literal — "a test fails if any `@font-face` URL 404s in
 * the environment under test" — and AC3 exercised rather than inferred, since a
 * root-absolute `url()` is *correct* under `BASE=/` and broken only under a sub-path, so
 * neither target alone can see the class.
 *
 * `test/assets.test.ts` keeps the complementary static claim: every `url()` in the
 * emitted CSS resolves to a file that is actually in the output.
 *
 * ## Why every page read here goes through `fetchMeasuredPage`
 *
 * Because for the life of this suite in CI, the dev third of it measured `404.astro`
 * (MUSE-62). `DevServer.base` was parsed out of the server's printed greeting, the
 * character class excluded whitespace, quotes and backslashes but not `ESC`, and Astro's
 * human-readable banner is colour-coded — so the base came out `/MuseByMina/%1B[31m/`,
 * `astro dev` answered every page with the error page, and **no assertion below could
 * tell**: the error page loads the same stylesheet, declares the same six faces and, at
 * the time, carried the same two preloads. "Which faces did the CSS engine ask for" gave
 * the right answer about the wrong document, in the one suite whose whole reason to exist
 * is seeing what `dist` cannot.
 *
 * It was CI-only, deterministically: Astro 7 switches to JSON log lines when it detects an
 * agent, and in that form the next character is a backslash — which the class did exclude.
 * Every local run by every agent got the right base. To reproduce, unset the agent markers
 * **and** force colour; see CLAUDE.md.
 *
 * So every page this suite reads is read through `fetchMeasuredPage`, and every page it
 * opens in a browser is checked with `assertMeasuredPage` — the canonical the page itself
 * declares, against the path that was asked for. MUSE-48's landing assertion cannot stand
 * in for it: that compares requested with landed, and here the URL was wrong before it was
 * requested and the server answered it directly. Not body text, either — every page
 * contains „Muse by Mina", which is how eight copies of one page pass for eight pages.
 *
 * ## Why there is no `BASE=/` dev server
 *
 * Measured, not assumed: Vite's dev server does not put `base` into asset URLs at all —
 * it serves this project's fonts at `/src/assets/fonts/…` whatever `BASE` is set to. A
 * second dev server under `BASE=/` would exercise the same code path and assert the same
 * strings. The base-path risk lives entirely in the build, where the two built
 * environments below cover it.
 */

/** Every face `src/styles/fonts.css` declares: three families, latin and latin-ext. */
const FACE_COUNT = 6;

/** A page with body text, display headings and the numerals MUSE-14 is about. */
const CONTENT_ROUTE = 'schedule/';

/**
 * One place the site is being served from, however it got there.
 *
 * The dev server and a built-and-served deploy differ in every detail that is not the
 * point — port, base path, whether the filenames are hashed — so the suite talks to all
 * three through this and asserts the same things about each.
 */
interface Environment {
  name: string;
  /** Absolute URL for a route: `url('')` is the homepage, `url('schedule/')` a page. */
  url(route: string): string;
}

/**
 * The environment names, listed here so `describe.each` can label its blocks at
 * collection time — the handles themselves only exist once `beforeAll` has run.
 */
const ENVIRONMENTS = ['astro dev', 'the Pages sub-path build', 'the apex build'];

let browser: Browser;
let dev: DevServer;
let pagesHost: Host;
let apexHost: Host;
let environments: Environment[];
let routes: string[];

beforeAll(async () => {
  // Sequential, not `Promise.all([...])` with destructuring: one rejection there leaves
  // every other handle unassigned and `afterAll` closes none of them, putting the whole
  // weight of not leaking a dev server on the `process.once('exit')` backstop in
  // `scratch.ts`. The browser is the cheapest to start, so it goes first and is always
  // cleanable by the time anything else can fail.
  browser = await launchChecks();
  dev = await astroDev({}, 'fonts');

  const pages = buildSite(PAGES_DEPLOY);
  const apex = buildSite(APEX_DEPLOY);
  pagesHost = await servePages(pages);
  apexHost = await servePages(apex);

  // Base paths are read off the builds rather than spelled out, so moving the deploy
  // target stays a config change in the suite as well as in the site (MUSE-8).
  const served =
    (host: () => Host, base: string) =>
    (route: string): string =>
      `${host().origin}${base}${route}`;

  environments = [
    { name: ENVIRONMENTS[0]!, url: (route) => dev.url(route) },
    { name: ENVIRONMENTS[1]!, url: served(() => pagesHost, basePath(pages)) },
    { name: ENVIRONMENTS[2]!, url: served(() => apexHost, basePath(apex)) },
  ];

  // Read off the build rather than listed, so a page added tomorrow is covered the day
  // it lands — the same reasoning as `assetRefs` deriving its references from markup.
  // `404.html` is dropped: the host serves it in place of an unknown path rather than
  // at a route of its own (MUSE-9), so it has no URL to visit.
  routes = pages
    .htmlFiles()
    .filter((file) => file !== '404.html')
    .map((file) => file.replace(/(^|\/)index\.html$/, '$1'))
    .sort();
}, 240_000);

afterAll(async () => {
  // `allSettled`, so one failed teardown does not strand the others. A leaked dev server
  // holds a Vite watcher on this checkout until the machine is rebooted.
  await Promise.allSettled([
    dev?.stop(),
    pagesHost?.close(),
    apexHost?.close(),
    browser?.close(),
  ]);
});

/**
 * Every stylesheet an environment serves for `route`, fetched the way a browser does.
 *
 * Inline `<style>` blocks and linked stylesheets both: which of the two Astro emits
 * depends on the environment and on a size threshold, and nothing here should care.
 */
async function stylesheetsFor(env: Environment, route: string): Promise<string[]> {
  const pageUrl = env.url(route);
  const { html } = await fetchMeasuredPage(pageUrl, env.name);

  const linked = await Promise.all(
    linkHrefs(html, 'stylesheet').map(async (href) => {
      const res = await fetch(new URL(href, pageUrl));
      expect(res.status, `stylesheet ${href} on ${pageUrl}`).toBe(200);
      return res.text();
    }),
  );

  return [...styleBlocks(html), ...linked];
}

/** Absolute URLs of every `@font-face` source an environment serves for `route`. */
async function declaredFaces(env: Environment, route: string): Promise<string[]> {
  const pageUrl = env.url(route);
  const sheets = await stylesheetsFor(env, route);
  const urls = sheets.flatMap((css) => fontFaceUrls(css));
  return [...new Set(urls)].map((url) => new URL(url, pageUrl).href);
}

/** Absolute URLs of every woff2 the page asks the browser to preload. */
async function preloadedFaces(env: Environment, route: string): Promise<string[]> {
  const pageUrl = env.url(route);
  const { html } = await fetchMeasuredPage(pageUrl, env.name);
  return linkHrefs(html, 'preload')
    .filter((href) => href.endsWith('.woff2'))
    .map((href) => new URL(href, pageUrl).href)
    .sort();
}

/**
 * A face URL as a person reads it: `cormorant-garamond-latin-ext`.
 *
 * The emitted filename carries a content hash, and a failure that printed it would be
 * naming something nobody can look up — the point of a message here is that a reader can
 * go straight to the `@font-face` block and the subset's `unicode-range`. The hash is
 * stripped rather than the stem matched against a list, so a seventh subset arriving
 * tomorrow is named correctly without this function being told about it.
 */
function faceName(url: string): string {
  const file = new URL(url).pathname.split('/').pop() ?? url;
  return file.replace(/(\.[A-Za-z0-9_-]+)?\.woff2$/, '');
}

/**
 * The faces the page fetches **when nothing preloads them for it**.
 *
 * This is the measurement the whole preload claim rests on, and the obvious version of
 * it asserts nothing: a `<link rel="preload">` *is* a request, so "was this face
 * requested?" is true by construction for anything preloaded, whether or not the page
 * had the slightest use for it. Reading the raw request log is circular.
 *
 * Stripping the preload tags out of the document before the browser parses it breaks
 * that circle. What is left is the set the CSS engine asks for on its own — each
 * `@font-face`'s `unicode-range` matched against the text actually on the page. That set
 * is the ground truth a preload has to be a member of.
 *
 * Measured with a real browser rather than by matching `unicode-range` here, for the
 * same reason `test/numerals.test.ts` screenshots glyphs instead of reading
 * `getComputedStyle`: a model of the engine passes whenever the model is wrong.
 */
async function facesNeededWithoutPreloads(env: Environment, route: string): Promise<string[]> {
  const requested = new Set<string>();

  // Opened through `scripts/browser-checks.mjs` (MUSE-48), and this is the suite the
  // ticket came out of. A bare Playwright page reports `en-US`, so asking for `''` opened
  // the Croatian homepage and measured the English one — and worse than that here: the
  // interception below is registered for *the URL asked for*, so on `/` the redirect
  // landed on a page whose preloads were never stripped, and "the faces this page needs
  // without preloads" was silently "the faces this other page needs, preloads included".
  // That is the double-download MUSE-35's QA nearly filed as a preload mismatch, and the
  // reason this file's own comment about the Croatian homepage's diacritics was describing
  // a page no run had ever loaded.
  const { page, close, measured } = await openCheckPage(browser, env, route, {
    waitUntil: 'load',
    prepare: async (opened, url) => {
      await opened.route(url, async (interception) => {
        const response = await interception.fetch();
        const stripped = (await response.text()).replace(
          /<link\b[^>]*\brel="preload"[^>]*>/g,
          '',
        );
        expect(stripped, 'the preloads were not stripped').not.toContain('rel="preload"');
        await interception.fulfill({ response, body: stripped });
      });
      opened.on('request', (req) => {
        if (req.url().endsWith('.woff2')) requested.add(req.url());
      });
    },
  });

  try {
    // The document the browser actually parsed, not the URL it was handed: `page.content()`
    // is the DOM it ended up with, preloads stripped and canonical untouched (MUSE-62).
    assertMeasuredPage(measured.url, await page.content(), env.name);
    await page.evaluate(() => document.fonts.ready);
    return [...requested].sort();
  } finally {
    await close();
  }
}

describe.each(ENVIRONMENTS.map((name, index) => ({ name, index })))(
  'MUSE-35: fonts in $name',
  ({ index }) => {
    const env = (): Environment => environments[index]!;

    /**
     * AC1 and AC4 — every declared face is a file this environment actually serves.
     *
     * Every URL is fetched and every status collected, so a failure reads like the
     * ticket's own reproduction — the list of what 404'd — rather than just the first.
     */
    it('serves every @font-face file it declares', async () => {
      const faces = await declaredFaces(env(), CONTENT_ROUTE);
      expect(faces, `${env().name}: wrong number of faces`).toHaveLength(FACE_COUNT);

      const statuses = await Promise.all(
        faces.map(async (url) => `${(await fetch(url)).status} ${url}`),
      );
      expect(
        statuses.filter((line) => !line.startsWith('200 ')),
        `${env().name}: faces that do not resolve`,
      ).toEqual([]);
    });

    it('reports every face loaded, and none failed, in a real browser', async () => {
      const { page, close, measured } = await openCheckPage(browser, env(), CONTENT_ROUTE, {
        waitUntil: 'load',
      });
      try {
        assertMeasuredPage(measured.url, await page.content(), env().name);
        // `document.fonts` only loads a face the page has text for, so a subset
        // covering characters this page happens not to use stays `unloaded` however
        // healthy it is. Asking for each one explicitly makes "all six" a claim about
        // the files rather than about the copy.
        const report = await page.evaluate(async () => {
          const faces = [...document.fonts];
          await Promise.allSettled(faces.map((face) => face.load()));
          return {
            total: faces.length,
            loaded: faces.filter((f) => f.status === 'loaded').length,
            failed: faces
              .filter((f) => f.status !== 'loaded')
              .map((f) => `${f.family} (${f.status})`),
          };
        });

        expect(report.failed, env().name).toEqual([]);
        expect(report.loaded, env().name).toBe(FACE_COUNT);
        expect(report.total, env().name).toBe(FACE_COUNT);
      } finally {
        await close();
      }
    });

    /**
     * AC2 — **every face the page asks for is preloaded, and nothing else is preloaded
     * that is not a deliberate, bounded over-preload.**
     *
     * Stated behaviourally rather than as "the preload href equals some `@font-face`
     * src", because that weaker form is a subset test against all six declared faces,
     * and it passes when the layout preloads Inter's *latin-ext* subset instead of its
     * latin one. Both are declared faces; only one is a face the page paints with. That
     * mutation was run against the subset version of this test and the suite stayed
     * green.
     *
     * ## The direction that matters, and why it has no exceptions
     *
     * This asserted `preloaded ⊆ needed` and nothing else for its whole life, and said so
     * in its own name: *"preloads only faces each page actually needs"*. The two preloads
     * that existed were both faces every page needs, so it was green — while four of the
     * six faces were preloaded on no page at all, and **every Croatian diacritic lives in
     * one of them**. `font-display: swap` then paints the latin half of a word in
     * Cormorant and the `đ` from the system fallback until the ext subset arrives: a
     * different typeface mid-word, at 96px, in „Dođi na probni sat", for a window
     * measured at 221 ms on a throttled cold load.
     *
     * So **`needed ⊆ preloaded` is absolute here**. No route may be exempt from it, there
     * is no list it consults, and a failure names the page and the face.
     *
     * ## The other direction is a property, not a list
     *
     * `preloaded ⊆ needed` cannot be an equality any more, and that is a decision rather
     * than a gap. `src/lib/fonts.ts` preloads Cormorant's latin-ext on *every* Croatian
     * page, including the three that do not paint a diacritic in the display face today,
     * because the subtractive route list that used to know which three was invalidated by
     * two content pull requests on one day — see that file. Waste is the direction the
     * performance budget counts; a missing face is the direction a visitor reads.
     *
     * What is still refused is everything that is *not* that deliberate over-preload, and
     * it is refused as a property derived from the rule rather than as a route table
     * nobody maintains:
     *
     *   - a `latin` subset that the page does not ask for — impossible by part 1 of the
     *     rule, so if it happens the rule has broken;
     *   - **any** unused preload on an English page — English is additive-only, so an
     *     unused face there means the table gained an entry that measurement does not
     *     support;
     *   - anything that is not one of the six declared faces at all.
     *
     * The permitted case therefore stays exactly as wide as the rule that creates it: a
     * `latin-ext` subset, on a Croatian page. Preload all six on `/en/` and this fails.
     *
     * ## Every route, not a chosen one
     *
     * The set is per page, so "every page" is not thoroughness — a single route could not
     * see the rule. It mattered before this too: on `/schedule/` the Croatian copy pulls
     * both halves of Inter and Jost in, so the needed set is wide enough to contain the
     * wrong subset and the mutation above survives. It is `/en/`, whose copy is plain
     * ASCII, that pins Inter down to its latin subset.
     *
     * `404.html` is not in `routes` — the host serves it in place of an unknown path
     * rather than at a URL of its own, so there is nothing to ask for. It needs no entry
     * anywhere either: it is Croatian, so the rule gives it all six, and it is bilingual
     * by design so it paints all six.
     */
    it('preloads every face each page asks for, and wastes nothing it should not', async () => {
      expect(routes.length, 'no routes to check').toBeGreaterThan(4);

      const problems: string[] = [];
      const sets = new Set<string>();

      for (const route of routes) {
        const preloaded = await preloadedFaces(env(), route);
        if (preloaded.length === 0) {
          problems.push(`${route}: preloads no fonts at all`);
          continue;
        }
        sets.add(preloaded.map(faceName).join(' '));

        const needed = await facesNeededWithoutPreloads(env(), route);
        if (needed.length === 0) {
          problems.push(`${route}: requested no fonts at all with preloads stripped`);
          continue;
        }

        const asks = `it asks for ${needed.map(faceName).sort().join(', ')}`;
        const sends = `it preloads ${preloaded.map(faceName).join(', ')}`;

        // The direction a visitor sees. Absolute.
        for (const url of needed.filter((u) => !preloaded.includes(u))) {
          problems.push(
            `${route}: asks for ${faceName(url)} and does not preload it (${sends})`,
          );
        }

        // The direction the budget counts. Permitted only in the one shape the rule in
        // `src/lib/fonts.ts` creates: a latin-ext subset on a Croatian page.
        const croatian = localeOfRoute(route) !== 'en';
        for (const url of preloaded.filter((u) => !needed.includes(u))) {
          const name = faceName(url);
          if (croatian && name.endsWith('-latin-ext')) continue;
          problems.push(
            `${route}: preloads ${name}, which it never requests and which is not the ` +
              `deliberate Croatian latin-ext over-preload (${asks})`,
          );
        }
      }

      expect(problems, env().name).toEqual([]);

      // The list is per page, and this is the cheapest statement of that. The assertions
      // above already refuse any one fixed list — three faces fails on the Croatian
      // pages, six fails on `/en/` — so this cannot fail on its own today. It is here so
      // that a future change making the set uniform reads as the regression it would be
      // rather than as a simplification.
      expect(
        [...sets].length,
        `${env().name}: every page preloads the same faces`,
      ).toBeGreaterThan(1);
    });
  },
);

/**
 * AC2, from the other side: no stylesheet may hand the server a path it typed itself.
 *
 * The bug was a literal `/fonts/…` in a stylesheet — a path that is only correct once
 * something rewrites it, and only the build does. This is the one check here that still
 * fails if every server happens to answer the wrong path with a 200, so it reads the
 * **source** rather than anything served.
 *
 * Recursive over all of `src/`, and over component `<style>` blocks as well as `.css`
 * files. The first version read `src/styles/*.css` and nothing else, so moving
 * `fonts.css` into a subdirectory — or putting an `@font-face` in a component — left it
 * scanning nothing, finding nothing, and passing. Both guards below exist so that "found
 * no offenders" cannot quietly mean "found no files".
 */
describe('MUSE-35 AC2: no stylesheet hard-codes a deploy-root asset path', () => {
  const SRC = fileURLToPath(new URL('../src', import.meta.url));

  /** Every `.css` and `.astro` file under `src/`, as absolute paths. */
  function sourceFiles(): string[] {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });
    return walk(SRC).filter((f) => /\.(css|astro)$/.test(f));
  }

  /** Every `url()` written anywhere in the source tree's CSS, as readable lines. */
  function sourceUrls(): string[] {
    return sourceFiles().flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      // A `.css` file is CSS throughout; an `.astro` file only inside its `<style>`.
      const blocks = file.endsWith('.css') ? [text] : styleBlocks(text);
      const where = `src/${relative(SRC, file).replace(/\\/g, '/')}`;
      return blocks.flatMap((css) => cssUrls(css).map((url) => `${where}: url(${url})`));
    });
  }

  it('scans a source tree that is actually there', () => {
    expect(sourceFiles().length, 'no stylesheets or components scanned').toBeGreaterThan(15);
    expect(sourceUrls().length, 'no url() seen anywhere under src/').toBeGreaterThan(0);
  });

  it('leaves no root-absolute url() in any stylesheet under src/', () => {
    expect(sourceUrls().filter((line) => /url\(\//.test(line))).toEqual([]);
  });
});

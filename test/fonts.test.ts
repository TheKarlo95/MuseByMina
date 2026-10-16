import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchChecks, localeOfRoute, openCheckPage } from '../scripts/browser-checks.mjs';
import { type Face, FACES, preloadFaces } from '../src/lib/fonts';
import { routeKey } from '../src/lib/i18n';
import { ROUTES } from '../src/lib/pages';
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
 * **The `unicode-range` split, read off the stylesheet that declares it** (MUSE-106).
 *
 * The second measurement below asks a character-range question — "does this page hold a
 * character no `latin` subset can paint" — and the ranges that answer it are in
 * `src/styles/fonts.css`, beside the `src` of each file. They are read from there rather
 * than written here because a transcription of them is a second copy that can go stale
 * silently in the direction that passes: a range typed slightly too wide here reports every
 * diacritic as covered by `latin` and the guard finds nothing for the rest of its life.
 *
 * The *source* rather than the served CSS, because this is the declaration site and it is
 * one file for every environment; what each environment actually serves is already held to
 * it by `declaredFaces` above and by `test/assets.test.ts`.
 */
const FONTS_CSS = fileURLToPath(new URL('../src/styles/fonts.css', import.meta.url));

/** One declared subset: the stem a reader can look up, and the code points it covers. */
interface Subset {
  readonly id: string;
  readonly subset: Face['subset'];
  /** Inclusive `[from, to]` pairs, as `unicode-range` writes them. */
  readonly ranges: readonly (readonly [number, number])[];
}

/**
 * One `unicode-range` value, parsed.
 *
 * An unrecognised token throws rather than being skipped: the wildcard form (`U+00??`)
 * and the open-ended form are both legal CSS this project does not use today, and a
 * parser that quietly dropped one would under-report coverage, which fails in the
 * direction that passes.
 */
function parseRanges(value: string, id: string): (readonly [number, number])[] {
  return value.split(',').map((token) => {
    const text = token.trim();
    const match = /^U\+([0-9A-Fa-f]{1,6})(?:-([0-9A-Fa-f]{1,6}))?$/.exec(text);
    if (match === null) {
      throw new Error(
        `src/styles/fonts.css: the unicode-range token "${text}" on ${id} is not a form ` +
          `test/fonts.test.ts knows how to read — teach parseRanges about it rather than ` +
          `letting the character-range measurement under-report coverage`,
      );
    }
    const from = Number.parseInt(match[1]!, 16);
    return [from, match[2] === undefined ? from : Number.parseInt(match[2], 16)] as const;
  });
}

let subsetCache: Subset[] | undefined;

/** Every `@font-face` in `fonts.css`, paired with the face `src/lib/fonts.ts` names. */
function subsets(): Subset[] {
  if (subsetCache !== undefined) return subsetCache;

  const css = readFileSync(FONTS_CSS, 'utf8');
  const found: Subset[] = [];

  for (const [, block] of css.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    const src = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(block ?? '')?.[1];
    const range = /unicode-range:\s*([^;}]+)/.exec(block ?? '')?.[1];
    if (src === undefined || range === undefined) continue;

    const id = (src.split('/').pop() ?? src).replace(/\.woff2$/, '');
    const face = FACES.find((entry) => entry.id === id);
    if (face === undefined) {
      throw new Error(
        `src/styles/fonts.css declares ${id}, which is not a face src/lib/fonts.ts knows ` +
          `about — the stylesheet and the preload list have drifted apart`,
      );
    }
    found.push({ id, subset: face.subset, ranges: parseRanges(range, id) });
  }

  subsetCache = found;
  return found;
}

/** Can a subset of this half of the split paint `cp` at all? */
function covers(subset: Face['subset'], cp: number): boolean {
  return subsets().some(
    (entry) =>
      entry.subset === subset && entry.ranges.some(([from, to]) => cp >= from && cp <= to),
  );
}

/**
 * The characters in `text` that **no `latin` subset can paint**.
 *
 * Deliberately not "which face paints this" — that is the cascade model this project
 * refuses to build, twice over in `src/lib/fonts.ts`. This is the weaker question that
 * can be answered without one, and it is the question `unicode-range` itself splits on.
 */
function latinExtOnly(text: string): string[] {
  return [...new Set(text)]
    .filter((char) => {
      const cp = char.codePointAt(0);
      return cp !== undefined && !covers('latin', cp) && covers('latin-ext', cp);
    })
    .sort();
}

/** A string the document holds, and roughly where, for a failure to quote. */
interface UnpaintedText {
  readonly text: string;
  readonly where: string;
}

/** What one page, in one environment, answers about its own fonts. */
interface Measurement {
  /** Every woff2 the page asks the browser to preload. */
  readonly preloaded: readonly string[];
  /** Every woff2 the CSS engine asks for once nothing preloads one for it. */
  readonly requested: readonly string[];
  /** Text in the document the engine laid out no box for, so it painted nothing. */
  readonly unpainted: readonly UnpaintedText[];
}

/**
 * The faces the page fetches **when nothing preloads them for it**, and the text it
 * holds that nothing painted.
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
 *
 * ## The second question, asked of the same page (MUSE-106)
 *
 * **What the request measurement cannot see is text the page never paints.** `[hidden]`
 * is `display: none`, so there is no layout, so the engine asks for no face — and a
 * `latin-ext` character reachable only after an interaction is therefore reported as a
 * face the page does not need. `src/lib/fonts.ts` already names that property as an
 * argument against *deriving* the list from rendered text; it is also a hole in the
 * measurement, and the section it was added to says so.
 *
 * So this visit collects a second thing: every string the document holds that **the
 * engine laid out no box for**. Which text that is comes from `Range.getClientRects()` —
 * the engine's own layout answer, asked rather than modelled, for the reason above. The
 * `<head>` is out of scope because it is never painted with a webfont, and `<script>`,
 * `<style>` and `<noscript>` because their text is not text.
 *
 * Both sets come out of one page load on purpose. The heavyweight census has zero
 * headroom (`test/helpers/concurrency.ts`), and a second visit per route per environment
 * would be forty-eight more page loads to ask a question this one is already standing in
 * front of.
 */
async function measurePage(env: Environment, route: string): Promise<Measurement> {
  const requested = new Set<string>();
  const preloaded = await preloadedFaces(env, route);

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

    const unpainted = await page.evaluate(() => {
      /** A short, readable path to an element — three generations is enough to find it. */
      const pathTo = (from: Element): string => {
        const parts: string[] = [];
        for (
          let node: Element | null = from;
          node !== null && node !== document.body && parts.length < 3;
          node = node.parentElement
        ) {
          let part = node.tagName.toLowerCase();
          if (node.id !== '') part += `#${node.id}`;
          else if (node.classList.length > 0) part += `.${node.classList[0]!}`;
          parts.unshift(part);
        }
        return parts.join(' > ');
      };

      const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
      const found: { text: string; where: string }[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);

      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = (node.nodeValue ?? '').trim();
        const parent = node.parentElement;
        // A whitespace-only node has no rects even where it is painted, so it would
        // otherwise be reported as unpainted on every page and say nothing.
        if (text === '' || parent === null || skip.has(parent.tagName)) continue;

        const range = document.createRange();
        range.selectNodeContents(node);
        if (range.getClientRects().length > 0) continue;

        found.push({ text: text.slice(0, 80), where: pathTo(parent) });
      }

      return found;
    });

    return { preloaded, requested: [...requested].sort(), unpainted };
  } finally {
    await close();
  }
}

/**
 * `measurePage`, once per page per environment.
 *
 * Two claims below are made about the same measurement and the measurement costs a page
 * load, so it is taken once. Keyed on the environment as well as the route because the
 * three environments serve different documents — different base path, different
 * filenames — which is the whole reason there are three.
 */
const measurements = new Map<string, Promise<Measurement>>();

function measurePageOnce(env: Environment, route: string): Promise<Measurement> {
  const key = `${env.name}\u0000${route}`;
  let pending = measurements.get(key);
  if (pending === undefined) {
    pending = measurePage(env, route);
    measurements.set(key, pending);
  }
  return pending;
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
     *   - **any** unused preload on a *declared* English page — English is additive-only
     *     there, so an unused face means the table gained an entry that measurement does
     *     not support;
     *   - anything that is not one of the six declared faces at all.
     *
     * The permitted case therefore stays exactly as wide as the rule that creates it: a
     * `latin-ext` subset, on a Croatian page — or on a page whose route came from a
     * document. Preload all six on `/en/` and this fails.
     *
     * **That second half is MUSE-88's amendment, and it is narrower than it looks.** It
     * permits a latin-ext over-preload on `/en/blog/<slug>/` and `/en/events/<slug>/` and
     * on nothing else, because `contentKeyed` reads `ROUTES` — so `/en/events/archive/`,
     * a declared child of a content-keyed parent, is still held to the line above. The
     * cost is 135,908 bytes on an English post or event whose copy turns out to be pure
     * ASCII, and the reason it is paid rather than measured is that **this suite has no
     * such page and must not have one**: the seed holds no posts and no events, because
     * seeding one publishes it (MUSE-24, MUSE-26). The whole argument is in
     * `src/lib/fonts.ts`. Without the amendment this assertion is green today — the
     * routes do not exist in the build — and goes red on Mina's first post, naming a
     * waste the rule creates on purpose.
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
        const { preloaded, requested: needed } = await measurePageOnce(env(), route);
        if (preloaded.length === 0) {
          problems.push(`${route}: preloads no fonts at all`);
          continue;
        }
        sets.add(preloaded.map(faceName).join(' '));

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

        // The direction the budget counts. Permitted only in the two shapes the rule in
        // `src/lib/fonts.ts` creates: a latin-ext subset on a Croatian page, or one on a
        // page whose path came from a document (MUSE-88). `routeKey` because `routes`
        // holds served spellings — `en/blog/x/` — and `ROUTES` holds route keys.
        const croatian = localeOfRoute(route) !== 'en';
        const contentKeyed = !ROUTES.some((entry) => entry.route === routeKey(`/${route}`));
        for (const url of preloaded.filter((u) => !needed.includes(u))) {
          const name = faceName(url);
          if ((croatian || contentKeyed) && name.endsWith('-latin-ext')) continue;
          problems.push(
            `${route}: preloads ${name}, which it never requests and which is neither ` +
              `the deliberate Croatian nor the content-keyed latin-ext over-preload ` +
              `(${asks})`,
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

    /**
     * MUSE-106 — **latin-ext text the page can only paint after an interaction.**
     *
     * The assertion above is a *request* measurement: load the page with the preload tags
     * stripped and record what the CSS engine then asks for. It is the right instrument
     * for the question it answers and it has one blind spot, which is structural rather
     * than a gap in how carefully it is run: **`[hidden]` is `display: none`, so there is
     * no layout, so no face is ever requested.** Text behind a disclosure is therefore
     * measured as text that needs nothing.
     *
     * It is reachable from this repository's own code, not only from the CMS. The header's
     * "More" dropdown renders **every** `MORE_NAV` entry inside `<ul id="more-menu"
     * hidden>`, while the footer takes only `MORE_NAV.slice(0, 4)` — so a fifth entry
     * whose *English* label carries a diacritic exists on an English page in exactly one
     * place, a closed menu. QA planted „Noć bachate" and this whole file stayed green in
     * all three environments; a visitor who opened the menu read the `ć` from the system
     * fallback, which is MUSE-74's defect with nothing in front of it.
     *
     * ## Why this is a character-range question and not a wider measurement
     *
     * Opening the dropdown first is the obvious move and is the wrong rule: it makes the
     * measurement depend on a list of which interactions exist, which is the list
     * `src/lib/fonts.ts` exists not to keep. Preloading the three latin-ext subsets on
     * every English page is the 135.9 KB that file refuses by name.
     *
     * So this asks a different question of the same document: **which characters does it
     * hold that no `latin` subset can paint, in text the engine laid out no box for.**
     * That needs no cascade model, because it does not ask which *face* paints the
     * character — nothing can answer that without being the engine, which is the argument
     * `src/lib/fonts.ts` makes twice. Not being able to attribute it is why the
     * requirement is **all three** latin-ext subsets: a Croatian page and a content-keyed
     * page already satisfy it by construction, and a declared English page is where it
     * bites, which is exactly where `EN_LATIN_EXT` is additive and can be short an entry.
     *
     * **This does not replace the measurement above and neither replaces this.** A
     * preload pointing at a face nothing paints is visible only to the request
     * measurement; text no interaction in this suite ever triggers is visible only here.
     *
     * It also closes half of MUSE-74's remaining hole for free: an English `post` or
     * `event` whose copy carries a diacritic is covered by this check as well as by
     * MUSE-88's default — though no build in this suite has such a page to check, because
     * the seed holds none and must not.
     */
    it('preloads latin-ext for text it can only paint after an interaction', async () => {
      const latinExt = FACES.filter((face) => face.subset === 'latin-ext');
      const problems: string[] = [];
      let scanned = 0;
      let carrying = 0;

      for (const route of routes) {
        const { preloaded, unpainted } = await measurePageOnce(env(), route);
        scanned += unpainted.length;

        const names = new Set(preloaded.map(faceName));
        const absent = latinExt.filter((face) => !names.has(face.id)).map((face) => face.id);

        for (const { text, where } of unpainted) {
          const chars = latinExtOnly(text);
          if (chars.length === 0) continue;
          carrying += 1;
          if (absent.length === 0) continue;

          problems.push(
            `${route}: „${text}" in ${where} carries ${chars.join(' ')}, which only a ` +
              `latin-ext face can paint — and the engine laid out no box for that text, ` +
              `so the request measurement cannot see which face it needs. The page does ` +
              `not preload ${absent.join(', ')}. Either preload all three latin-ext ` +
              `subsets for this route or paint the text (MUSE-106).`,
          );
        }
      }

      expect(problems, env().name).toEqual([]);

      // Neither half of the scan may quietly find nothing. The first number is the
      // mechanism — a `Range` query that stopped returning empty rect lists, or a walk
      // that stopped reaching the hidden subtrees, would report zero and pass. The second
      // is the characters: the header's own „Što je bachata" and „Događaji" sit in the
      // closed Croatian menu on every page, so a run that sees no latin-ext behind a
      // disclosure anywhere is measuring something other than this site.
      expect(scanned, `${env().name}: found no unpainted text anywhere`).toBeGreaterThan(0);
      expect(
        carrying,
        `${env().name}: found no latin-ext character in unpainted text on any page`,
      ).toBeGreaterThan(0);
    });
  },
);

/**
 * MUSE-106 — the character-range split the check above rests on, parsed and exercised.
 *
 * `latinExtOnly` is the whole instrument, and it fails silently in the direction that
 * passes: a range read slightly too wide reports every diacritic as something `latin`
 * covers, the per-page check finds nothing on every page forever, and the two
 * `toBeGreaterThan(0)` guards beside it are the only thing that would notice. These make
 * the split itself a claim, with no server and no browser.
 */
describe('MUSE-106: the latin / latin-ext split, read off fonts.css', () => {
  it('parses every face the stylesheet declares', () => {
    const parsed = subsets();
    expect(parsed.map((entry) => entry.id).sort()).toEqual(
      FACES.map((face) => face.id).sort(),
    );
    expect(parsed.filter((entry) => entry.subset === 'latin-ext')).toHaveLength(3);
    for (const entry of parsed) {
      expect(entry.ranges.length, `${entry.id} has no unicode-range`).toBeGreaterThan(0);
    }
  });

  it('puts every Croatian diacritic outside latin, and nothing else with them', () => {
    // The five letters this project has paid for three times (`src/lib/fonts.ts`).
    // Sorted by code point, which is what `latinExtOnly` does and what a reader of a
    // failure can look up: U+0106 Ć, U+0107 ć, U+010C Č …
    expect(latinExtOnly('čćžšđ ČĆŽŠĐ')).toEqual([
      'Ć',
      'ć',
      'Č',
      'č',
      'Đ',
      'đ',
      'Š',
      'š',
      'Ž',
      'ž',
    ]);

    // Croatian typographic quotes are `latin`, so quoted ASCII must not read as latin-ext
    // — otherwise every „…" string on the site would be a finding.
    expect(latinExtOnly('„Dodi na probni sat.“')).toEqual([]);
    expect(latinExtOnly('Noc bachate — 20 €')).toEqual([]);
  });
});

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

/**
 * MUSE-88 — **the two routes whose key is a document, and the subsets no table can name.**
 *
 * `EN_LATIN_EXT` in `src/lib/fonts.ts` is keyed by *route*, and that premise holds for
 * every page whose existence is declared in this repository: a developer adds the route,
 * the browser arm above measures it under three environments on every pull request, and
 * an omission is red CI before anything deploys. `/en/blog/<slug>/` and
 * `/en/events/<slug>/` break the premise — **their path comes from a `post` or an `event`
 * document**, so there is no key to hold an entry and no finite set of keys to enumerate.
 *
 * ## Why this block is not a browser measurement
 *
 * Because there is no page to measure, and there must not be. `content/seed.ndjson` holds
 * zero events and zero posts, which is a decision rather than an oversight — seeding one
 * would publish it to the live site, which MUSE-24 and MUSE-26 both forbid. So the
 * defect's own page cannot exist in any build this suite performs, and the heavyweight
 * census has zero headroom besides (`test/helpers/concurrency.ts`).
 *
 * What is left is the function. `preloadFaces` is pure, it is the only place the per-page
 * set is decided, and the question MUSE-88 asks of it — "what does an English page get
 * when its route is not one of the declared ones" — is answerable with no server, no
 * build and no browser. The *route shapes* come off `src/pages/` rather than being
 * written down here, so a third dynamic template landing next year is covered the day it
 * lands: `src/pages/` is the one list that cannot lie (MUSE-46).
 *
 * What this cannot see, stated rather than implied: it does not measure which faces such a
 * page actually paints with. Nothing can, until a document exists. That is the whole
 * reason the rule gives those routes all six rather than a measured subset.
 */
describe('MUSE-88: a route keyed on content preloads the subsets no table can name', () => {
  const PAGES = fileURLToPath(new URL('../src/pages', import.meta.url));

  /**
   * A slug to stand in for the parameter — the ticket's own, so the failure reads like
   * the URL QA measured. Slugs are ASCII by construction; the Croatian characters this
   * ticket is about are in the document's *fields*, not in its path.
   */
  const SAMPLE_SLUG = '2026-noc-bachate';

  /** Every route under `src/pages/` whose path carries a `[param]` segment. */
  function contentKeyedRoutes(): string[] {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        return entry.isDirectory() ? walk(full) : [full];
      });

    const shapes = walk(PAGES)
      .map((file) => relative(PAGES, file).replace(/\\/g, '/'))
      .filter((file) => file.endsWith('.astro') && file.includes('['))
      // `routeKey` drops the locale prefix, so the HR and EN templates of one route
      // collapse to the same entry — which is the point: HR and EN share slugs.
      .map((file) => routeKey(`/${file.replace(/\.astro$/, '')}`))
      .map((route) => route.replace(/\[[^\]]+\]/g, SAMPLE_SLUG));

    return [...new Set(shapes)].sort();
  }

  /** The faces, by the name a reader can look up — never the hashed filename. */
  const ids = (faces: readonly { id: string }[]): string[] => faces.map((face) => face.id);

  it('finds the templates it is about, so finding nothing cannot pass', () => {
    const routes = contentKeyedRoutes();
    expect(routes, 'no [param] page template found under src/pages/').not.toEqual([]);
    expect(routes).toContain(`/blog/${SAMPLE_SLUG}`);
    expect(routes).toContain(`/events/${SAMPLE_SLUG}`);
  });

  /**
   * The direction a visitor reads, for the one page shape the browser arm cannot reach.
   *
   * A Croatian proper noun in an English post or event — „Ožegovića", a Zagreb street, a
   * Croatian DJ in a line-up — needs the `latin-ext` half of whichever face paints it,
   * and **which face that is cannot be answered from the document**: attributing a
   * character to a face is the cascade model MUSE-74 rejected with a measurement. So all
   * three, which is the same set a Croatian page gets.
   */
  it('gives an English content-keyed route every face, in both locales', () => {
    const problems: string[] = [];

    for (const route of contentKeyedRoutes()) {
      for (const locale of ['hr', 'en'] as const) {
        const got = ids(preloadFaces(route, locale));
        const missing = ids(FACES).filter((id) => !got.includes(id));
        if (missing.length > 0) {
          problems.push(
            `${locale === 'hr' ? '' : '/en'}${route}/: does not preload ` +
              `${missing.join(', ')} — its copy is a document, so no table can say it ` +
              `will not need them (MUSE-88)`,
          );
        }
      }
    }

    expect(problems).toEqual([]);
  });

  /**
   * The other half of the keying, and the half a prefix match gets wrong.
   *
   * `/events/archive` is a *declared* child of a content-keyed parent (`ROUTES`, and it is
   * what reserves the slug `archive`), so an implementation testing `route.startsWith
   * ('/events/')` would hand it all six and nobody would see it — the declared English
   * routes are exactly the ones the browser arm above measures, and over-preloading one of
   * them is the waste MUSE-74 refuses.
   */
  it('leaves every declared English route to the additive table', () => {
    const everything = ids(FACES);
    const over = ROUTES.map(({ route }) => route).filter(
      (route) => ids(preloadFaces(route, 'en')).length === everything.length,
    );

    expect(
      over,
      'a declared English route preloads the whole declared set: either the ' +
        'content-keyed arm is matching a route `src/pages/` declares, or `EN_LATIN_EXT` ' +
        'gained an entry naming all three roles — which the browser arm above has to show',
    ).toEqual([]);

    // Pinned by name, because these two are what the table says today and the arm above
    // measures: `/en/privacy/` is the one declared English route with an entry (MUSE-72).
    expect(ids(preloadFaces('/pricing', 'en'))).toEqual([
      'cormorant-garamond-latin',
      'jost-300-500-latin',
      'inter-400-600-latin',
    ]);
    expect(ids(preloadFaces('/privacy', 'en'))).toEqual([
      'cormorant-garamond-latin',
      'jost-300-500-latin',
      'inter-400-600-latin',
      'inter-400-600-latin-ext',
    ]);
    expect(ids(preloadFaces('/events/archive', 'en'))).toEqual([
      'cormorant-garamond-latin',
      'jost-300-500-latin',
      'inter-400-600-latin',
    ]);
  });

  it('still gives every Croatian page all six, declared or not', () => {
    for (const route of ['/', '/pricing', '/events/archive', `/blog/${SAMPLE_SLUG}`]) {
      expect(ids(preloadFaces(route, 'hr')), route).toEqual(ids(FACES));
    }
  });
});

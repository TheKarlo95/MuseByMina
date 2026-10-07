import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { cssUrls, fontFaceUrls, linkHrefs, styleBlocks } from './helpers/build';
import { astroDev, type DevServer } from './helpers/scratch';

/**
 * MUSE-35 — the dev server must serve the webfonts the CSS asks for.
 *
 * `src/styles/fonts.css` declared `src: url('/fonts/…woff2')`. Vite rewrites a
 * root-absolute CSS `url()` to include `base` **only when it builds**, so the deployed
 * site was correct and `astro dev` answered all six with 404 and fell back to Georgia.
 *
 * ## Why this suite starts a server instead of reading `dist`
 *
 * Because every other suite reads `dist`, and that is exactly how this shipped. The
 * build was right. Nine months of local visual checks were done against a page set in
 * the wrong typeface, and the one that mattered was MUSE-14: class times rendered
 * `II:OO` because Cormorant defaults to old-style figures, and **Georgia has lining
 * figures**, so in dev the bug was invisible. A developer reproducing it locally would
 * have concluded it was already fixed.
 *
 * So the environment under test here is the dev server, driven the way a developer
 * drives it. The build half of the same rule — every `url()` the output emits resolves
 * to a file that exists, under both deploy targets — is in `test/assets.test.ts`, which
 * already has both builds in hand.
 *
 * ## Why `document.fonts` and not just HTTP
 *
 * The HTTP check is the sharp one: it names the URL and the status. But a 200 is not
 * the claim — the claim is that the face is *in use*, and a `@font-face` can resolve
 * and still not load (wrong format, a corrupt subset, a `unicode-range` that excludes
 * everything on the page). `document.fonts` is where the browser says so, and it is
 * what the ticket's verification step asks for.
 */

let dev: DevServer;
let browser: Browser;

beforeAll(async () => {
  [dev, browser] = await Promise.all([astroDev({}, 'fonts'), chromium.launch()]);
}, 240_000);

afterAll(async () => {
  await Promise.all([dev?.stop(), browser?.close()]);
});

/** A page with body text, display headings and the numerals MUSE-14 is about. */
const PAGE = 'schedule/';

/** Every face `src/styles/fonts.css` declares: three families, latin and latin-ext. */
const FACE_COUNT = 6;

/**
 * Every stylesheet the dev server serves for `route`, fetched the way the browser does.
 *
 * Inline `<style>` blocks and linked stylesheets both, because which one Astro emits
 * differs between dev and a build and this suite should not care which it got.
 */
async function stylesheetsFor(route: string): Promise<string[]> {
  const pageUrl = dev.url(route);
  const html = await (await fetch(pageUrl)).text();

  const linked = await Promise.all(
    linkHrefs(html, 'stylesheet').map(async (href) => {
      const res = await fetch(new URL(href, pageUrl));
      expect(res.status, `stylesheet ${href} on ${route}`).toBe(200);
      return res.text();
    }),
  );

  return [...styleBlocks(html), ...linked];
}

/** Absolute URLs of every `@font-face` source the dev server serves for `route`. */
async function fontUrlsFor(route: string): Promise<string[]> {
  const pageUrl = dev.url(route);
  const sheets = await stylesheetsFor(route);
  const urls = sheets.flatMap((css) => fontFaceUrls(css));
  return [...new Set(urls)].map((url) => new URL(url, pageUrl).href);
}

describe('AC1: under astro dev, every @font-face file is served', () => {
  it(`declares all ${FACE_COUNT} faces`, async () => {
    // Without this the status check below passes by having nothing to check — which is
    // also what a half-applied fix looks like.
    expect(await fontUrlsFor(PAGE)).toHaveLength(FACE_COUNT);
  });

  /**
   * AC4, in the dev environment: a `@font-face` URL that 404s fails the suite.
   *
   * Every URL is fetched and every status reported together, so a failure reads as the
   * ticket's own reproduction — the list of what 404'd — rather than as the first one.
   */
  it('answers every one of them with 200', async () => {
    const urls = await fontUrlsFor(PAGE);
    const statuses = await Promise.all(
      urls.map(async (url) => `${(await fetch(url)).status} ${url}`),
    );
    expect(statuses.filter((line) => !line.startsWith('200 '))).toEqual([]);
  });

  it('reports them loaded, with none failed, in a real browser', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(dev.url(PAGE), { waitUntil: 'load' });

      // `document.fonts` only loads a face the page has text for, so a subset covering
      // characters this page happens not to use stays `unloaded` however healthy it is.
      // Asking for each one explicitly is what makes "all six" a claim about the files
      // rather than about the copy.
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

      expect(report.failed).toEqual([]);
      expect(report.loaded).toBe(FACE_COUNT);
      expect(report.total).toBe(FACE_COUNT);
    } finally {
      await page.close();
    }
  });
});

/**
 * AC2, in the dev environment — one URL per font, shared by the preload and the face.
 *
 * The regression this guards is subtler than the 404 and no existing check could see
 * it: resolve the CSS `url()` through Vite while the `<link rel="preload">` still names
 * the `public/` copy and both are 200, both are correct-looking, and the browser
 * downloads every preloaded face **twice** — the preload matching nothing it later
 * needs. A preload whose URL is not also a `@font-face` src is not a preload.
 */
describe('AC2: the preload and the @font-face name the same URL', () => {
  it('matches every preloaded font to a declared face', async () => {
    const pageUrl = dev.url(PAGE);
    const html = await (await fetch(pageUrl)).text();

    const preloaded = linkHrefs(html, 'preload')
      .filter((href) => href.endsWith('.woff2'))
      .map((href) => new URL(href, pageUrl).href);
    expect(preloaded.length, 'the page preloads no fonts').toBeGreaterThan(0);

    const faces = await fontUrlsFor(PAGE);
    expect(preloaded.filter((url) => !faces.includes(url))).toEqual([]);
  });
});

/**
 * AC2 again, from the other side: no hand-built, environment-specific font path.
 *
 * The bug was a literal `/fonts/…` in a stylesheet — a path that is only correct when
 * something rewrites it, and only the build does. Reading the *source* rather than the
 * served output is deliberate: it is the one check here that still fails if the dev
 * server happens to answer the wrong path with a 200.
 */
describe('AC2: no stylesheet hard-codes a deploy-root asset path', () => {
  it('leaves no root-absolute url() in the source stylesheets', async () => {
    const styles = new URL('../src/styles/', import.meta.url);
    const { readdirSync, readFileSync } = await import('node:fs');

    const offenders = readdirSync(styles)
      .filter((file) => file.endsWith('.css'))
      .flatMap((file) =>
        cssUrls(readFileSync(new URL(file, styles), 'utf8'))
          .filter((url) => url.startsWith('/'))
          .map((url) => `src/styles/${file}: url(${url})`),
      );

    expect(offenders).toEqual([]);
  });
});

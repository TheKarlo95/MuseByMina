import { beforeAll, describe, expect, it } from 'vitest';

import {
  APEX_DEPLOY,
  assetFile,
  assetRefs,
  buildSite,
  cssRefs,
  cssRefUrl,
  fontFaceUrls,
  isOwnAsset,
  linkHrefs,
  PAGES_DEPLOY,
  type Build,
} from './helpers/build';

/**
 * MUSE-8 — a built page must not reference an asset the deploy does not serve.
 *
 * The specific bug was the two font `<link rel="preload">` hrefs: `BASE_URL` had no
 * trailing slash, so string concatenation emitted `/MuseByMinafonts/…` — two 404s per
 * page load and no preload.
 *
 * The class is wider than those two tags: anything that joins the deploy base to an
 * asset path by hand can get it wrong, and every such reference 404s only on the
 * sub-path target. So the references here are read off the **built HTML** and each is
 * resolved to a file on disk the way the host resolves it — not matched against a
 * string pattern, which is what let the original bug ship.
 *
 * Page URLs (`<a href>`, `canonical`, `hreflang`) are still not checked here, now that
 * MUSE-9 has landed. They are a different question and `assetFile` answers the wrong one:
 * `/MuseByMina/en/` resolves to a directory, not a file, so a does-this-file-exist check
 * either rejects every correct page URL or has to be taught the host's redirect rules.
 * `test/urls.test.ts` teaches them to a real server and fetches each URL instead.
 *
 * MUSE-35 widened it again, in the direction it should have gone the first time: these
 * references were read out of the **HTML** only, so a `url()` inside a stylesheet had
 * never been resolved against `dist` by anything. That is the hole the dev server's six
 * 404ing `@font-face` URLs came through, and the last two describes below close it.
 */

/** How many faces `src/styles/fonts.css` declares: three families, latin and latin-ext. */
const FACE_COUNT = 6;

/** How many of them the layout preloads: the display and body subsets used above the fold. */
const PRELOAD_COUNT = 2;

let pages: Build;
let apex: Build;

beforeAll(async () => {
  pages = buildSite(PAGES_DEPLOY);
  apex = buildSite(APEX_DEPLOY);
}, 240_000);

/**
 * The two deploy targets, read lazily so `beforeAll` has run by the time one is used.
 *
 * Both, always. A root-absolute asset path is *correct* under `BASE=/` and broken only
 * under a sub-path, so neither target alone can see the whole class (MUSE-8, MUSE-35).
 */
const TARGETS: [string, () => Build][] = [
  ['Pages sub-path', () => pages],
  ['apex domain', () => apex],
];

/**
 * The path prefix the deploy is served from: `/MuseByMina` on Pages, `` on an apex.
 *
 * Taken off `build.origin` — the URL the harness already derives from `SITE`/`BASE` —
 * rather than re-deriving it from `BASE` here, which would be one more copy of the
 * base-path join this ticket is about.
 */
function basePrefix(build: Build): string {
  return new URL(`${build.origin}/`).pathname.replace(/\/$/, '');
}

/** The woff2 `<link rel="preload">` hrefs a built page declares, in document order. */
function fontPreloads(build: Build, page: string): string[] {
  return linkHrefs(build.read(page), 'preload').filter((href) => href.endsWith('.woff2'));
}

/**
 * Asserts every font preload on every built page is base-joined, and names a real file.
 *
 * The hrefs are no longer compared against a hard-coded path list. They were, and the
 * list was wrong the moment MUSE-35 moved the fonts into the Vite asset graph, where
 * the filename carries a content hash nothing outside the build can predict. A literal
 * expectation would have had to be re-typed to match whatever the build emitted —
 * which is not a test, it is a transcription. The two properties that actually
 * encode MUSE-8 survive the move intact and are checked instead:
 *
 *   - the href sits **under the deploy base path**, slash included. `/MuseByMinafonts/…`
 *     — the original bug, a `BASE_URL` with no trailing slash concatenated by hand —
 *     fails this on the sub-path target and fails the file check on the apex one.
 *   - it resolves to a file that exists, the way the host resolves it.
 *
 * Plus: every page agrees. A layout that emitted the right href on one route and a
 * stale one on another would otherwise pass on the strength of the first page read.
 */
function expectFontPreloads(build: Build): void {
  const prefix = basePrefix(build);

  const htmlFiles = build.htmlFiles();
  expect(htmlFiles.length, 'the build produced no HTML').toBeGreaterThan(0);

  const expected = fontPreloads(build, htmlFiles[0]!);
  expect(expected, `font preloads in ${htmlFiles[0]}`).toHaveLength(PRELOAD_COUNT);

  for (const page of htmlFiles) {
    expect(fontPreloads(build, page), `font preloads in ${page}`).toEqual(expected);
  }

  for (const href of expected) {
    expect(href.startsWith(`${prefix}/`), `${href} is not under ${prefix}/`).toBe(true);

    const file = assetFile(build, href);
    expect(
      file !== undefined && build.isFile(file),
      `${href} does not resolve to a file in the build output`,
    ).toBe(true);
  }
}

describe('MUSE-8 AC1: the Pages sub-path build preloads fonts from under the base path', () => {
  it('emits every href under /MuseByMina/, to a real file, on every page', () => {
    expectFontPreloads(pages);
  });
});

describe('MUSE-8 AC2: the apex build preloads fonts from the site root', () => {
  it('emits every href under /, to a real file, on every page', () => {
    expectFontPreloads(apex);
  });
});

/**
 * MUSE-8 AC3 — under either deploy target, every `rel="preload"` href in the built
 * HTML resolves to a file that exists in the output.
 */
describe('MUSE-8 AC3: every referenced asset exists in the build output', () => {
  /**
   * The references that do not resolve to a file the deploy serves, as readable lines.
   *
   * Collected rather than asserted one at a time so a failure names every broken
   * reference at once — the same shape as the source-tree check in `seo.test.ts`.
   */
  function unresolved(build: Build, keep: (ref: { source: string }) => boolean): string[] {
    const broken: string[] = [];

    for (const page of build.htmlFiles()) {
      for (const ref of assetRefs(build.read(page))) {
        if (!keep(ref)) continue;
        // Another origin or a data: URI is a real reference the suite cannot resolve
        // against dist; skipping it is not a false pass, it is out of this check's reach.
        if (!isOwnAsset(build, ref.url)) continue;

        const file = assetFile(build, ref.url);
        if (file !== undefined && build.isFile(file)) continue;
        broken.push(`${page}: ${ref.source} ${ref.url}`);
      }
    }

    return broken;
  }

  for (const [name, build] of TARGETS) {
    it(`resolves every rel="preload" href to a real file (${name})`, () => {
      expect(unresolved(build(), (ref) => ref.source.includes('rel="preload"'))).toEqual(
        [],
      );
    });

    /**
     * Stylesheets, scripts and images too. Astro writes those hrefs itself, so they are
     * cheap insurance rather than a live suspicion — but they are the same class of bug,
     * and a hand-written `<img src>` or favicon is exactly where it recurs next.
     * Off-origin and data: references are skipped, so this does not fire on, say, an
     * embedded map.
     */
    it(`resolves every other referenced subresource to a real file (${name})`, () => {
      expect(unresolved(build(), (ref) => !ref.source.includes('rel="preload"'))).toEqual(
        [],
      );
    });
  }

  it('finds preloads to check, so the checks above cannot pass vacuously', () => {
    // Deleting the tags would satisfy "every preload resolves" trivially. Two per page.
    const preloads = pages
      .htmlFiles()
      .flatMap((page) => assetRefs(pages.read(page)))
      .filter((ref) => ref.source.includes('rel="preload"'));
    expect(preloads).toHaveLength(PRELOAD_COUNT * pages.htmlFiles().length);
  });
});

/**
 * MUSE-35, build half — a stylesheet may not reference a file the deploy does not serve.
 *
 * AC4 says "a test fails if any `@font-face` URL 404s in the environment under test".
 * The dev environment is `test/fonts.test.ts`, which runs a real `astro dev`. This is
 * the built one, and until now nothing read inside the CSS at all: `assetRefs` parses
 * `<link>`, `<script>` and `<img>` out of the markup and stops there, so six font URLs
 * lived in the output for the life of the project without a single test resolving one.
 *
 * AC3 is why both targets are here rather than just the one CI deploys: a root-absolute
 * `url()` is *correct* under `BASE=/` and broken only under a sub-path, so an apex-only
 * check cannot see this class of bug and a Pages-only check cannot see its mirror image.
 */
describe('MUSE-35 AC4: every url() in the emitted CSS resolves to a file in the output', () => {
  /** The CSS references that nothing in the output serves, as readable lines. */
  function unresolved(build: Build): string[] {
    const broken: string[] = [];

    for (const ref of cssRefs(build)) {
      const absolute = cssRefUrl(ref);
      // An off-origin stylesheet reference is a real one this suite cannot resolve
      // against dist — out of reach, not a pass.
      if (absolute === undefined || !isOwnAsset(build, absolute)) continue;

      const file = assetFile(build, absolute);
      if (file !== undefined && build.isFile(file)) continue;
      broken.push(`${ref.source}: url(${ref.url}) -> ${absolute}`);
    }

    return broken;
  }

  for (const [name, build] of TARGETS) {
    it(`serves every stylesheet subresource it names (${name})`, () => {
      expect(unresolved(build())).toEqual([]);
    });

    it(`emits all ${FACE_COUNT} @font-face sources, so the check above is not vacuous`, () => {
      // The whole check is satisfied trivially by a build with no `url()` in it, which
      // is also what a fix that quietly dropped the fonts would look like.
      const faces = cssRefs(build(), fontFaceUrls);
      expect(new Set(faces.map((ref) => cssRefUrl(ref))).size).toBe(FACE_COUNT);
    });
  }
});

/**
 * MUSE-35 — a preloaded font must at least be a font the stylesheet declares.
 *
 * This catches the trap in fixing the ticket: route the CSS `url()` through Vite and
 * the font is emitted to a content-hashed path under `_astro/`; leave the
 * `<link rel="preload">` pointing at the `public/` copy and **both URLs are 200 and
 * both resolve to a real file**, so every check above stays green. The browser then
 * fetches each preloaded face twice — once for a preload matching nothing it will ever
 * request, once for the face itself. A performance regression wearing the fix's
 * clothes, and only an assertion that the two are the *same URL* sees it.
 *
 * ## What this does NOT prove, and where that lives
 *
 * It is a subset test against all six declared faces, so it passes when the layout
 * preloads Inter's `latin-ext` subset instead of its `latin` one — a declared face, but
 * not one the English pages ever request. Measured: that mutation leaves this check
 * green.
 *
 * The stronger claim — a preloaded face is one the page *would have fetched anyway* —
 * cannot be made from `dist` alone, because it depends on the CSS engine matching
 * `unicode-range` against the text on the page. `test/fonts.test.ts` measures it with a
 * real browser, on every route, in all three environments. This stays because it is
 * nearly free and it is what pins the `public/`-copy trap specifically.
 */
describe('MUSE-35: a preloaded font is one of the faces the stylesheet declares', () => {
  for (const [name, build] of TARGETS) {
    it(`preloads nothing the CSS does not declare (${name})`, () => {
      const target = build();
      const root = `${target.origin}/`;

      const declared = new Set(
        cssRefs(target, fontFaceUrls)
          .map((ref) => cssRefUrl(ref))
          .filter((url): url is string => url !== undefined),
      );

      const orphaned = target.htmlFiles().flatMap((page) =>
        fontPreloads(target, page)
          .map((href) => new URL(href, root).href)
          .filter((url) => !declared.has(url))
          .map((url) => `${page}: preloads ${url}, which no @font-face names`),
      );

      expect(orphaned).toEqual([]);
    });
  }
});

import { beforeAll, describe, expect, it } from 'vitest';

import {
  APEX_DEPLOY,
  assetFile,
  assetRefs,
  buildSite,
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
 */

/**
 * The faces the layout preloads: the display and body subsets used above the fold.
 *
 * Named here, as output-relative paths, because AC1 and AC2 are about these two tags
 * specifically. The general check below derives its references from the markup instead.
 */
const PRELOADED_FONTS = [
  'fonts/cormorant-garamond-latin.woff2',
  'fonts/inter-400-600-latin.woff2',
];

let pages: Build;
let apex: Build;

beforeAll(async () => {
  pages = buildSite(PAGES_DEPLOY);
  apex = buildSite(APEX_DEPLOY);
}, 240_000);

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

/**
 * Asserts every font preload on every built page is the base-joined path, and exists.
 *
 * Both halves matter. The href assertion is the acceptance criterion's literal wording;
 * the file assertion is the one that cannot be satisfied by a plausible-looking string.
 */
function expectFontPreloads(build: Build): void {
  const prefix = basePrefix(build);
  const expected = PRELOADED_FONTS.map((file) => `${prefix}/${file}`);

  const htmlFiles = build.htmlFiles();
  expect(htmlFiles.length, 'the build produced no HTML').toBeGreaterThan(0);

  for (const page of htmlFiles) {
    expect(linkHrefs(build.read(page), 'preload'), `font preloads in ${page}`).toEqual(
      expected,
    );
  }

  for (const file of PRELOADED_FONTS) {
    expect(build.isFile(file), `${file} is missing from the build output`).toBe(true);
  }
}

describe('AC1: the Pages sub-path build preloads fonts from under the base path', () => {
  it('emits both hrefs as /MuseByMina/fonts/… on every page', () => {
    expectFontPreloads(pages);
  });
});

describe('AC2: the apex build preloads fonts from the site root', () => {
  it('emits both hrefs as /fonts/… on every page', () => {
    expectFontPreloads(apex);
  });
});

/**
 * AC3 — under either deploy target, every `rel="preload"` href in the built HTML
 * resolves to a file that exists in the output.
 */
describe('AC3: every referenced asset exists in the build output', () => {
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

  const TARGETS: [string, () => Build][] = [
    ['Pages sub-path', () => pages],
    ['apex domain', () => apex],
  ];

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
    expect(preloads).toHaveLength(2 * pages.htmlFiles().length);
  });
});

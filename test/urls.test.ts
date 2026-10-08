import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  alternates,
  APEX_DEPLOY,
  basePath,
  buildSite,
  canonicalOf,
  declaredAlternates,
  isOwnAsset,
  locs,
  PAGES_DEPLOY,
  pageRefs,
  urlEntries,
  type Build,
} from './helpers/build';
import { resolveRequest, servePages, type Host } from './helpers/serve';

/**
 * MUSE-9 — every URL the site declares must be the URL the host actually serves.
 *
 * The bug: `trailingSlash: 'never'` with the default `build.format: 'directory'`. Astro
 * wrote `dist/en/index.html` but emitted `…/MuseByMina/en` in canonical, hreflang and
 * `llms.txt`, and GitHub Pages 301s that to `…/MuseByMina/en/`. Every page declared a
 * canonical that redirected, including back to itself, so no URL in the set was
 * self-referential and non-redirecting — and Google drops an hreflang cluster whose
 * targets redirect.
 *
 * Two things make these tests able to fail where the old suite could not:
 *
 *  1. `normalise()` is gone from `test/helpers/build.ts`. It stripped the trailing slash
 *     off every URL before every comparison, which is exactly the character in dispute.
 *  2. URLs are **fetched**, not pattern-matched, from a host that redirects the way
 *     GitHub Pages does. `astro preview` answers `/MuseByMina` and `/MuseByMina/` both
 *     with 200 and never redirects, so it cannot see this bug either.
 */
let pages: Build;
let apex: Build;
let pagesHost: Host;
let apexHost: Host;

beforeAll(async () => {
  pages = buildSite(PAGES_DEPLOY);
  apex = buildSite(APEX_DEPLOY);
  pagesHost = await servePages(pages);
  apexHost = await servePages(apex);
}, 240_000);

afterAll(async () => {
  await pagesHost?.close();
  await apexHost?.close();
});

const TARGETS: [string, () => Build, () => Host][] = [
  ['Pages sub-path', () => pages, () => pagesHost],
  ['apex domain', () => apex, () => apexHost],
];

/** Every `<loc>` across the sitemap index and the child sitemaps it names. */
function sitemapLocs(build: Build): string[] {
  return locs(build.read('sitemap-index.xml')).flatMap((child) => {
    const file = child.slice(build.origin.length).replace(/^\//, '');
    return locs(build.read(file));
  });
}

/** Each `<url>` block across the child sitemaps, keyed by its own `<loc>`. */
function sitemapEntries(build: Build): Map<string, string> {
  const merged = new Map<string, string>();
  for (const child of locs(build.read('sitemap-index.xml'))) {
    const file = child.slice(build.origin.length).replace(/^\//, '');
    for (const [loc, block] of urlEntries(build.read(file))) merged.set(loc, block);
  }
  return merged;
}

/** The absolute URL the host serves a given output file at. */
function servedAt(build: Build, file: string): string {
  const path = file === 'index.html' ? '' : file.replace(/\/index\.html$/, '/');
  return `${build.origin}/${path}`;
}

/**
 * The model that stands in for GitHub Pages, pinned to what the live deploy does.
 *
 * Without this, the model is free to become lenient — and a lenient model is how a
 * hand-rolled server quietly turns a regression test back into theatre. Every row was
 * recorded against https://thekarlo95.github.io/MuseByMina with
 * `curl -o /dev/null -w '%{http_code} %{redirect_url}'`.
 */
describe('the host model matches GitHub Pages', () => {
  const RECORDED: [string, number, string | undefined][] = [
    ['/MuseByMina', 301, '/MuseByMina/'],
    ['/MuseByMina/', 200, undefined],
    ['/MuseByMina/404', 200, undefined],
    ['/MuseByMina/404/', 404, undefined],
    ['/MuseByMina/en/404', 404, undefined],
    ['/MuseByMina/robots.txt', 200, undefined],
    ['/MuseByMina/nope', 404, undefined],
    // MUSE-8's bug: same origin, outside the deploy's prefix. Not a 200 however many
    // matching bytes sit in `dist`.
    ['/MuseByMinafonts/inter-400-600-latin.woff2', 404, undefined],
  ];

  it('answers the paths recorded off the live deploy the same way', async () => {
    for (const [path, status, location] of RECORDED) {
      const probe = await pagesHost.get(path);
      expect([path, probe.status, probe.location]).toEqual([path, status, location]);
    }
  });

  it('answers an unknown path with the error page body, not a stub (MUSE-38)', () => {
    // GitHub Pages serves `404.html`'s *body* for every unknown path, with a 404 status.
    // The model used to answer the status and invent the body, which made the one page a
    // lost visitor actually meets unreachable to every browser suite in the repo — so the
    // all-Croatian 404 in MUSE-38 could only be reproduced against the deployed site.
    const base = basePath(pages);
    expect(resolveRequest(pages.outDir, base, `${base}nope`)).toEqual({
      status: 404,
      file: '404.html',
    });
    // `/404/` is a 404 as a *directory* and gets the same body, same as the live host.
    expect(resolveRequest(pages.outDir, base, `${base}404/`)).toEqual({
      status: 404,
      file: '404.html',
    });
    // Outside the deploy's prefix is not the deploy's to answer for (MUSE-8).
    expect(resolveRequest(pages.outDir, base, '/elsewhere/nope')).toEqual({ status: 404 });
  });

  it('serves a directory only at its slashed URL, and redirects the other spelling', () => {
    const base = basePath(pages);
    expect(resolveRequest(pages.outDir, base, `${base}en/`)).toEqual({
      status: 200,
      file: 'en/index.html',
    });
    expect(resolveRequest(pages.outDir, base, `${base}en`)).toEqual({
      status: 301,
      location: `${base}en`.concat('/'),
    });
  });
});

/**
 * AC1 — Given any page, when I fetch its declared canonical URL, then it returns 200
 * with no redirect.
 */
describe('AC1: declared canonicals are non-redirecting', () => {
  for (const [name, build, host] of TARGETS) {
    it(`fetches every canonical with a 200 and no Location (${name})`, async () => {
      const htmlFiles = build().htmlFiles();
      expect(htmlFiles.length, 'the build produced no HTML').toBeGreaterThan(0);

      const bad: string[] = [];
      for (const page of htmlFiles) {
        const canonical = canonicalOf(build().read(page));
        // A page that deliberately declares none (the 404) has nothing to get wrong.
        if (canonical === undefined) continue;
        const probe = await host().getUrl(canonical);
        if (probe.status !== 200 || probe.location !== undefined) {
          bad.push(`${page}: ${canonical} -> ${probe.status} ${probe.location ?? ''}`.trim());
        }
      }
      expect(bad).toEqual([]);
    });

    /**
     * The sharper half of AC1: not merely "200 somewhere" but 200 *at this page*. A
     * canonical that resolves to a different page is a 200 and still wrong, and the
     * original bug was precisely a page naming a URL that was not its own.
     */
    it(`points each page's canonical at that page's own URL (${name})`, () => {
      const mismatched: string[] = [];
      for (const page of build().htmlFiles()) {
        const canonical = canonicalOf(build().read(page));
        if (canonical === undefined) continue;
        const own = servedAt(build(), page);
        if (canonical !== own) mismatched.push(`${page}: declares ${canonical}, served at ${own}`);
      }
      expect(mismatched).toEqual([]);
    });
  }

  it('every indexable page declares a canonical, so the check above is not vacuous', () => {
    // Any locale's error route, so adding `src/pages/en/404.astro` stays satisfiable —
    // the same reasoning as NOT_A_PAGE in seo.test.ts.
    const indexable = pages.htmlFiles().filter((f) => !f.endsWith('404.html'));
    expect(indexable.length).toBeGreaterThan(0);
    for (const page of indexable) {
      expect(canonicalOf(pages.read(page)), `${page} declares no canonical`).toBeDefined();
    }
  });
});

/**
 * AC2 — Given any `<loc>` in the sitemap, when I fetch it, then it returns 200 with no
 * redirect.
 */
describe('AC2: sitemap <loc> URLs are non-redirecting', () => {
  for (const [name, build, host] of TARGETS) {
    it(`fetches every <loc> with a 200 and no Location (${name})`, async () => {
      const all = [...locs(build().read('sitemap-index.xml')), ...sitemapLocs(build())];
      expect(all.length, 'the sitemap lists nothing').toBeGreaterThan(0);

      const bad: string[] = [];
      for (const loc of all) {
        const probe = await host().getUrl(loc);
        if (probe.status !== 200 || probe.location !== undefined) {
          bad.push(`${loc} -> ${probe.status} ${probe.location ?? ''}`.trim());
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

/**
 * AC3 — Given any `hreflang` alternate, then it points at a canonical, non-redirecting
 * URL. Both halves are asserted: the fetch, and that the target is some page's own
 * canonical rather than merely a URL that happens to answer.
 */
describe('AC3: hreflang alternates point at canonical, non-redirecting URLs', () => {
  for (const [name, build, host] of TARGETS) {
    it(`fetches every alternate — in the <head> and in the sitemap — with a 200 (${name})`, async () => {
      const targets = new Map<string, string>();
      for (const page of build().htmlFiles()) {
        for (const [tag, href] of declaredAlternates(build().read(page))) {
          targets.set(href, `${page} hreflang="${tag}"`);
        }
      }
      for (const [loc, block] of sitemapEntries(build())) {
        for (const [tag, href] of alternates(block)) {
          targets.set(href, `sitemap ${loc} hreflang="${tag}"`);
        }
      }
      expect(targets.size, 'nothing declares an alternate').toBeGreaterThan(0);

      const bad: string[] = [];
      for (const [href, source] of targets) {
        const probe = await host().getUrl(href);
        if (probe.status !== 200 || probe.location !== undefined) {
          bad.push(`${source}: ${href} -> ${probe.status} ${probe.location ?? ''}`.trim());
        }
      }
      expect(bad).toEqual([]);
    });

    it(`targets only URLs that are some page's own canonical (${name})`, () => {
      const canonicals = new Set(
        build()
          .htmlFiles()
          .map((page) => canonicalOf(build().read(page)))
          .filter((c): c is string => c !== undefined),
      );

      const bad: string[] = [];
      for (const page of build().htmlFiles()) {
        for (const [tag, href] of declaredAlternates(build().read(page))) {
          if (!canonicals.has(href)) bad.push(`${page} hreflang="${tag}" -> ${href}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

/**
 * AC4 — the suite compares sitemap and page URLs without normalising trailing slashes,
 * and fails if they diverge.
 *
 * `test/seo.test.ts` is where sitemap, `llms.txt` and the `<head>` are compared against
 * each other; what belongs here is the guarantee that none of those comparisons can be
 * satisfied by two different spellings of the same path.
 */
describe('AC4: one spelling per URL, trailing slash included', () => {
  it('has no normalise() left in the test helpers', async () => {
    const helpers = await import('./helpers/build');
    expect(Object.keys(helpers)).not.toContain('normalise');
  });

  for (const [name, build] of TARGETS) {
    it(`lists the same URLs in the sitemap as the pages declare, byte for byte (${name})`, () => {
      const declared = build()
        .htmlFiles()
        .map((page) => canonicalOf(build().read(page)))
        .filter((c): c is string => c !== undefined)
        .sort();
      expect([...sitemapEntries(build()).keys()].sort()).toEqual(declared);
    });

    /**
     * The shape rule, stated once: every navigable URL the site emits addresses a
     * directory. Links to pages that do not exist yet (`/schedule`, `/pricing`) cannot be
     * fetched for a 200, but they can still be held to the spelling that will not redirect
     * the day they do — which is what keeps MUSE-6 and MUSE-7 from reintroducing this.
     */
    it(`emits every page URL in directory shape (${name})`, () => {
      const base = basePath(build());
      const bad: string[] = [];

      for (const page of build().htmlFiles()) {
        for (const ref of pageRefs(build().read(page))) {
          if (!isOwnAsset(build(), ref.url)) continue;
          const path = new URL(ref.url, `${build().origin}/`).pathname;
          // Outside the deploy's prefix is a different bug (MUSE-8) with its own suite.
          if (!path.startsWith(base)) continue;
          if (!path.endsWith('/')) bad.push(`${page}: ${ref.source} ${ref.url}`);
        }
      }
      expect(bad).toEqual([]);
    });
  }

  it('finds page URLs to check, so the shape rule cannot pass vacuously', () => {
    const refs = pages.htmlFiles().flatMap((page) => pageRefs(pages.read(page)));
    expect(refs.filter((r) => r.source === '<link rel="canonical">').length).toBeGreaterThan(0);
    expect(refs.filter((r) => r.source === '<a href>').length).toBeGreaterThan(0);
  });
});

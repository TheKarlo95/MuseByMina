import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { LOCALE_HTML_LANG } from '../src/lib/i18n';
import {
  alternates,
  APEX_DEPLOY,
  buildSite,
  declaredAlternates,
  groupFor,
  linkDescription,
  locs,
  markdownLinkTo,
  metaDescription,
  PAGES_DEPLOY,
  robotsGroups,
  robotsPathMatches,
  urlEntries,
  type Build,
} from './helpers/build';

/**
 * MUSE-5 — sitemap.xml, robots.txt and llms.txt.
 *
 * These assertions come from the ticket's Given/When/Then, not from the
 * implementation. The page list is read off `src/pages/` rather than any registry
 * the implementation happens to introduce, so adding a page without listing it
 * fails these tests.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES_DIR = join(ROOT, 'src/pages');

/**
 * Error routes are deliberately not indexable and are not "pages" for SEO.
 *
 * Keyed by locale-independent route, so `/404` and `/en/404` are both excluded. Hardcoding
 * the literal paths would make adding `src/pages/en/404.astro` unsatisfiable: the page
 * exists, but `@astrojs/sitemap` is right to leave it out.
 */
const NOT_A_PAGE = new Set(['/404']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/** Every routable page under `src/pages`, as a site-relative route. */
function pageRoutes(): string[] {
  return walk(PAGES_DIR)
    .filter((f) => f.endsWith('.astro'))
    .map((f) => '/' + relative(PAGES_DIR, f).replace(/\.astro$/, '').replace(/\\/g, '/'))
    .map((r) => (r.endsWith('/index') ? r.slice(0, -'/index'.length) || '/' : r))
    .filter((r) => !NOT_A_PAGE.has(routeKey(r)))
    .sort();
}

/** `/en` → en, everything else → hr (hr is unprefixed; see astro.config.mjs). */
function localeOf(route: string): 'hr' | 'en' {
  return route === '/en' || route.startsWith('/en/') ? 'en' : 'hr';
}

/** `/en/schedule` → `/schedule`; the locale-independent identity of a page. */
function routeKey(route: string): string {
  return localeOf(route) === 'en' ? route.slice('/en'.length) || '/' : route;
}

function routeIn(routeKeyValue: string, locale: 'hr' | 'en'): string {
  const prefix = locale === 'hr' ? '' : '/en';
  return `${prefix}${routeKeyValue === '/' ? '' : routeKeyValue}`;
}

/**
 * The one URL a crawler should ever see for `route`.
 *
 * Directory shape, with the trailing slash — and *not* normalised, which is the point.
 * The output is `<route>/index.html`, which a static host serves at the slashed URL and
 * 301s to from the unslashed one, so the slash is the difference between a canonical and
 * a redirect (MUSE-9). Spelled out here rather than imported from `src/lib/i18n.ts` so
 * these assertions stay independent of the code they are checking.
 */
function absolute(build: Build, route: string): string {
  return `${build.origin}${route === '/' ? '' : route}/`;
}

/** The HTML actually published for `route`. `build.format: 'directory'`, so `/x/index.html`. */
function builtHtml(build: Build, route: string): string {
  return build.read(route === '/' ? 'index.html' : `${route}/index.html`);
}

/** The path a crawler would request for `route`, including the deploy base. */
function pathOf(build: Build, route: string): string {
  return new URL(absolute(build, route)).pathname || '/';
}

const ROUTES = pageRoutes();

let pages: Build;
let apex: Build;

beforeAll(async () => {
  pages = buildSite(PAGES_DEPLOY);
  apex = buildSite(APEX_DEPLOY);
}, 240_000);

describe('the page list these tests are built from', () => {
  it('finds both locale homepages and excludes 404 in either locale', () => {
    expect(ROUTES).toContain('/');
    expect(ROUTES).toContain('/en');
    expect(ROUTES).not.toContain('/404');
    expect(ROUTES).not.toContain('/en/404');
  });

  it('excludes an error route in any locale, not just the unprefixed one', () => {
    // Guards the exclusion rule itself: `src/pages/en/404.astro` does not exist yet, and
    // adding it must not make the sitemap assertions unsatisfiable.
    for (const notAPage of NOT_A_PAGE) {
      for (const locale of ['hr', 'en'] as const) {
        expect(ROUTES).not.toContain(routeIn(notAPage, locale));
      }
    }
  });
});

/**
 * AC1 — Given the site is built, when I fetch `/sitemap-index.xml`, then it lists
 * every page in both locales with correct `hreflang` alternates.
 */
describe('AC1: /sitemap-index.xml', () => {
  function allUrlEntries(build: Build): Map<string, string> {
    const index = build.read('sitemap-index.xml');
    const children = locs(index);
    expect(children.length).toBeGreaterThan(0);

    const merged = new Map<string, string>();
    for (const child of children) {
      // Child sitemaps are referenced by absolute URL; read them off disk.
      const file = child.slice(build.origin.length).replace(/^\//, '');
      expect(build.has(file)).toBe(true);
      for (const [loc, block] of urlEntries(build.read(file))) merged.set(loc, block);
    }
    return merged;
  }

  it('exists at the site root', () => {
    expect(pages.has('sitemap-index.xml')).toBe(true);
  });

  it('points only at child sitemaps on the configured origin', () => {
    for (const child of locs(pages.read('sitemap-index.xml'))) {
      expect(child.startsWith(`${pages.origin}/`)).toBe(true);
    }
  });

  it('lists every page in both locales, and nothing else', () => {
    const listed = [...allUrlEntries(pages).keys()].sort();
    const expected = ROUTES.map((r) => absolute(pages, r)).sort();
    expect(listed).toEqual(expected);
  });

  it('does not list the 404 page', () => {
    for (const loc of allUrlEntries(pages).keys()) {
      expect(loc).not.toMatch(/404/);
    }
  });

  it('gives every entry an hreflang alternate for each locale', () => {
    const entries = allUrlEntries(pages);

    for (const route of ROUTES) {
      const block = entries.get(absolute(pages, route));
      expect(block, `no <url> entry for ${route}`).toBeDefined();

      const alts = alternates(block!);
      const key = routeKey(route);

      // The language tags are the ones the site already declares for itself, so the
      // sitemap and the pages' own <link rel="alternate"> cannot drift apart.
      for (const locale of ['hr', 'en'] as const) {
        const tag = LOCALE_HTML_LANG[locale];
        expect(alts.get(tag), `${tag} alternate for ${route}`).toBe(
          absolute(pages, routeIn(key, locale)),
        );
      }
    }
  });

  it('uses the same hreflang tags the pages declare in their <head>', () => {
    const entries = allUrlEntries(pages);

    for (const route of ROUTES) {
      const declared = declaredAlternates(builtHtml(pages, route));
      // x-default is in the page's cluster but has no sitemap counterpart to compare to.
      declared.delete('x-default');
      expect(declared.size, `${route} declares no alternates`).toBeGreaterThan(0);

      const alts = alternates(entries.get(absolute(pages, route))!);
      for (const [tag, href] of declared) {
        expect(alts.get(tag), `sitemap is missing ${tag} for ${route}`).toBe(href);
      }
    }
  });

  it('declares the xhtml namespace the alternates live in', () => {
    const child = locs(pages.read('sitemap-index.xml'))[0]!;
    const file = child.slice(pages.origin.length).replace(/^\//, '');
    expect(pages.read(file)).toContain('http://www.w3.org/1999/xhtml');
  });
});

/**
 * AC2 — Given the site is built, when I fetch `/robots.txt`, then it allows
 * crawling and points at the sitemap.
 */
describe('AC2: /robots.txt', () => {
  it('is emitted by the build', () => {
    expect(pages.has('robots.txt')).toBe(true);
  });

  it('has a group that applies to every user-agent', () => {
    expect(groupFor(robotsGroups(pages.read('robots.txt')), '*')).toBeDefined();
  });

  it('lets a crawler fetch the site root', () => {
    const wildcard = groupFor(robotsGroups(pages.read('robots.txt')), '*')!;
    const root = pathOf(pages, '/');

    // The directive is what a crawler obeys, not the line's spelling: `Disallow: /`,
    // `Disallow: /*` and `Disallow: /M` all block the root. A line-grep for the first
    // spelling passes a file that blocks the entire site. An *absent* rule, or a bare
    // `Disallow:`, is the canonical "crawl everything" — neither needs an `Allow:` line.
    const blocking = wildcard.disallow.filter((rule) => robotsPathMatches(rule, root));
    expect(blocking, `Disallow rules blocking ${root}`).toEqual([]);
  });

  it('lets a crawler fetch every page the sitemap advertises', () => {
    const wildcard = groupFor(robotsGroups(pages.read('robots.txt')), '*')!;

    for (const route of ROUTES) {
      const path = pathOf(pages, route);
      const blocking = wildcard.disallow.filter((rule) => robotsPathMatches(rule, path));
      expect(blocking, `Disallow rules blocking ${path}`).toEqual([]);
    }
  });

  it('points at the sitemap index by absolute URL', () => {
    const sitemap = /^Sitemap:\s*(\S+)$/m.exec(pages.read('robots.txt'))?.[1];
    expect(sitemap).toBe(`${pages.origin}/sitemap-index.xml`);
  });
});

/**
 * AC3 — Given the site is built, when I fetch `/llms.txt`, then it lists each page
 * with a one-line description.
 */
describe('AC3: /llms.txt', () => {
  it('is emitted by the build', () => {
    expect(apex.has('llms.txt')).toBe(true);
    expect(pages.has('llms.txt')).toBe(true);
  });

  /**
   * The `- [Name](url): description` lines whose link target is exactly `route`.
   *
   * Matched on the closing paren, not by substring. `absolute(build, '/')` is a prefix of
   * every URL in the file, so a substring test makes the root route match the `/en` line
   * and borrow its description — and makes `/blog` match the `/blog/post` line, so a
   * missing page looks present. One line per route, so this asserts exactly one match.
   */
  function entryFor(build: Build, route: string): string {
    const url = absolute(build, route);
    const matching = build
      .read('llms.txt')
      .split('\n')
      .filter((l) => markdownLinkTo(url).test(l));
    expect(matching, `llms.txt lines linking to exactly ${url}`).toHaveLength(1);
    return matching[0]!;
  }

  it('lists every page exactly once, with a one-line description', () => {
    for (const route of ROUTES) {
      const description = linkDescription(entryFor(pages, route));
      expect(description, `no one-line description for ${route}`).toBeDefined();
      expect(description!.length, `description for ${route} is a stub`).toBeGreaterThan(10);
    }
  });

  /**
   * AC3's real content, and the claim `src/lib/pages.ts` exists to make: the index and the
   * page cannot disagree. `llms.txt` and the `<head>` are two independent renderers of the
   * same registry entry, so comparing them catches a page that stops using the registry —
   * which nothing else here would notice. Same shape as the hreflang cross-check above.
   */
  it('publishes, for each page, the description that page actually serves', () => {
    for (const route of ROUTES) {
      const served = metaDescription(builtHtml(pages, route));
      expect(served, `${route} serves no <meta name="description">`).toBeTruthy();
      expect(linkDescription(entryFor(pages, route)), `llms.txt disagrees with ${route}`)
        .toBe(served);
    }
  });

  it('describes a page in the language of that page', () => {
    // Per locale, not once for the file: an index that publishes Croatian copy under its
    // English heading is half an index. Comparing the descriptions — not the whole lines,
    // which differ by URL whatever the copy says — is what makes this able to fail.
    for (const key of [...new Set(ROUTES.map(routeKey))]) {
      const hr = linkDescription(entryFor(pages, routeIn(key, 'hr')));
      const en = linkDescription(entryFor(pages, routeIn(key, 'en')));
      expect(hr, `hr description for ${key}`).toBeTruthy();
      expect(en, `en description for ${key}`).toBeTruthy();
      expect(en, `${key} reuses one locale's description for both`).not.toBe(hr);
    }
  });

  it('is markdown with a title, as the llms.txt format requires', () => {
    expect(pages.read('llms.txt')).toMatch(/^#\s+\S/m);
  });
});

/**
 * AC4 — Given the deploy target changes (`SITE`/`BASE` env), when the site
 * rebuilds, then all three files use the new origin with no hardcoded host.
 */
describe('AC4: the deploy target is env-driven, not hardcoded', () => {
  const ARTEFACTS = ['robots.txt', 'llms.txt', 'sitemap-index.xml'];

  function sitemapChildren(build: Build): string[] {
    return locs(build.read('sitemap-index.xml')).map((c) =>
      c.slice(build.origin.length).replace(/^\//, ''),
    );
  }

  it('builds the same three artefacts under either target', () => {
    for (const file of ARTEFACTS) {
      expect(pages.has(file), `${file} missing from Pages build`).toBe(true);
      expect(apex.has(file), `${file} missing from apex build`).toBe(true);
    }
  });

  it('writes the Pages origin when SITE/BASE say Pages', () => {
    for (const file of [...ARTEFACTS, ...sitemapChildren(pages)]) {
      expect(pages.read(file), file).toContain(PAGES_DEPLOY.SITE);
    }
  });

  it('writes the new origin — and only the new origin — when SITE/BASE change', () => {
    for (const file of [...ARTEFACTS, ...sitemapChildren(apex)]) {
      const txt = apex.read(file);
      expect(txt, file).toContain(APEX_DEPLOY.SITE);
      expect(txt, `${file} still mentions the old host`).not.toContain(
        'thekarlo95.github.io',
      );
      expect(txt, `${file} still mentions the old base path`).not.toContain('MuseByMina');
    }
  });

  it('keeps the sub-path out of the apex build entirely', () => {
    const apexSitemap = sitemapChildren(apex).map((f) => apex.read(f));
    for (const url of apexSitemap.flatMap(locs)) {
      expect(url.startsWith('https://muse.example')).toBe(true);
    }
  });

  /**
   * The trees this check walks, and what each is expected to contain.
   *
   * `public/` is currently absent: MUSE-35 moved the fonts — the only thing in it —
   * into `src/assets/`, so that Vite resolves them in dev as well as in the build. It
   * stays listed for the day something static comes back.
   *
   * `minimum` is asserted **per root**, not against the total, and that distinction is
   * the whole point. A single `expect(total).toBeGreaterThan(20)` is satisfied by `src/`
   * alone with room to spare — and this very ticket *widened* that slack by moving six
   * files into `src/`. It could not tell "`public/` is absent" from "`public/` has four
   * hundred files in it", and would only fire if both trees vanished at once. Per root,
   * an absent tree is an explicit fact with an expected count beside it rather than an
   * arithmetic coincidence.
   */
  const HOST_SCAN: { dir: string; minimum: number }[] = [
    { dir: 'src', minimum: 25 },
    { dir: 'public', minimum: 0 },
  ];

  it('walks the trees it claims to, or says one is missing', () => {
    for (const { dir, minimum } of HOST_SCAN) {
      const full = join(ROOT, dir);
      const found = existsSync(full) ? walk(full).length : 0;
      expect(found, `${dir}/ has ${found} files, expected at least ${minimum}`)
        .toBeGreaterThanOrEqual(minimum);
    }
  });

  it('has no deploy host written into the source tree', () => {
    const sources = HOST_SCAN.map(({ dir }) => join(ROOT, dir))
      .filter((dir) => existsSync(dir))
      .flatMap(walk);

    const offenders = sources.filter((f) =>
      readFileSync(f).includes('thekarlo95.github.io'),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

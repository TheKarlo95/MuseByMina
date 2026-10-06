import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { LOCALE_HTML_LANG } from '../src/lib/i18n';
import {
  alternates,
  APEX_DEPLOY,
  buildSite,
  locs,
  normalise,
  PAGES_DEPLOY,
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

/** Error routes are deliberately not indexable and are not "pages" for SEO. */
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
    .filter((r) => !NOT_A_PAGE.has(r))
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

function absolute(build: Build, route: string): string {
  return normalise(`${build.origin}${route === '/' ? '' : route}`);
}

const ROUTES = pageRoutes();

let pages: Build;
let apex: Build;

beforeAll(async () => {
  pages = buildSite(PAGES_DEPLOY);
  apex = buildSite(APEX_DEPLOY);
}, 240_000);

describe('the page list these tests are built from', () => {
  it('finds both locale homepages and excludes 404', () => {
    expect(ROUTES).toContain('/');
    expect(ROUTES).toContain('/en');
    expect(ROUTES).not.toContain('/404');
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
      const html = pages.read(route === '/' ? 'index.html' : `${route}/index.html`);
      const declared = new Map<string, string>();
      for (const m of html.matchAll(/<link\b[^>]*rel="alternate"[^>]*>/g)) {
        const hreflang = /hreflang="([^"]+)"/.exec(m[0])?.[1];
        const href = /href="([^"]+)"/.exec(m[0])?.[1];
        if (hreflang && hreflang !== 'x-default' && href) {
          declared.set(hreflang, normalise(href));
        }
      }
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

  it('allows crawling for every user-agent', () => {
    const txt = pages.read('robots.txt');
    expect(txt).toMatch(/^User-agent:\s*\*$/m);
    expect(txt).toMatch(/^Allow:\s*\/$/m);
    // A blanket block would make the rest of the ticket pointless.
    expect(txt).not.toMatch(/^Disallow:\s*\/\s*$/m);
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

  it('lists every page with a non-empty description on the same line', () => {
    const lines = pages.read('llms.txt').split('\n');

    for (const route of ROUTES) {
      const url = absolute(pages, route);
      const matching = lines.filter((l) => l.includes(url) || l.includes(`${url}/`));
      expect(matching.length, `no llms.txt line for ${url}`).toBeGreaterThan(0);

      // llms.txt format: `- [Name](url): one-line description`
      const described = matching.find((l) => /\]\([^)]+\):\s*\S/.test(l));
      expect(described, `no one-line description for ${url}\n${matching.join('\n')}`)
        .toBeDefined();

      const description = /\]\([^)]+\):\s*(.+)$/.exec(described!)?.[1]?.trim() ?? '';
      expect(description.length).toBeGreaterThan(10);
      expect(description).not.toContain('\n');
    }
  });

  it('describes a page in the language of that page', () => {
    const txt = pages.read('llms.txt');
    const hrLine = txt.split('\n').find((l) => l.includes(absolute(pages, '/') + ')'));
    const enLine = txt.split('\n').find((l) => l.includes(absolute(pages, '/en') + ')'));
    expect(hrLine, 'hr homepage line').toBeDefined();
    expect(enLine, 'en homepage line').toBeDefined();
    expect(hrLine).not.toEqual(enLine);
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

  it('has no deploy host written into the source tree', () => {
    const sources = [join(ROOT, 'src'), join(ROOT, 'public')].flatMap(walk);
    const offenders = sources.filter((f) =>
      readFileSync(f).includes('thekarlo95.github.io'),
    );
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { LOCALE_HTML_LANG } from '../src/lib/i18n';
import { resolveRequest } from './helpers/serve';
import {
  alternates,
  APEX_DEPLOY,
  basePath,
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
 * Entries under `src/pages/` that are not a "page" for SEO, keyed by locale-independent
 * route — so `/404` and `/en/404` are both excluded. Hardcoding the literal paths would
 * make adding `src/pages/en/404.astro` unsatisfiable: the page exists, but
 * `@astrojs/sitemap` is right to leave it out.
 *
 * `/events/[slug]` and `/blog/[slug]` are here for a different reason and it is not about
 * indexing (MUSE-24, MUSE-26). They are **templates**, not pages: what each produces is one
 * page per `event` or `post` document, so they are content rather than structure. Every one
 * of those pages *is* indexed — it declares a canonical and appears in the sitemap, which
 * `test/events.test.ts` and `test/blog.test.ts` assert against builds that hold them — but
 * neither template has an entry in `ROUTES`, a `page` document or therefore an `llms.txt`
 * line. That partition is deliberate: `llms.txt` is a short index of the site's sections and
 * says so by linking the sitemap under „Machine-readable", while the sitemap is the surface
 * designed for a page set that grows with the content. Listing a line per event or per post
 * would also make this file's set equality a claim about the dataset rather than about the
 * page registry.
 *
 * Note the one thing a *post's* page does not always have, and which no other page on the
 * site lacks: an `hreflang` pair. A post may be written in one language only, so its
 * cluster can hold one member and is then omitted — `src/lib/blog.ts` argues it, and the
 * assertions in this file that require a cluster are over `ROUTES`, which it is not in.
 */
const NOT_A_PAGE = new Set(['/404', '/events/[slug]', '/blog/[slug]']);

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

  /* ------------------------------------------------------------------ MUSE-46 */

  /**
   * **The other direction, which nothing asserted: `llms.txt` lists nothing extra.**
   *
   * Everything above walks `ROUTES` — the list derived from `src/pages/` — and looks the
   * route up in `llms.txt`. So a route declared in `src/lib/pages.ts` with **no file
   * behind it** published a link and broke nothing: `llms.txt` is generated from the
   * registry, the registry was never compared back, and the page list these tests build
   * from could not see an entry that has no file. MUSE-13 closed exactly this for
   * `nav.ts` and left it open here, and `llms.txt` is published *for machines* —
   * including this project's own QA agents — so a dead link in it is worse than a
   * missing entry, not better.
   *
   * Resolved through the **model of GitHub Pages** (`scripts/dist-origin.mjs`, the same
   * resolver `test/urls.test.ts` and `npm run preview` use) rather than by checking a
   * file exists. A URL in this file is a promise about what the deploy answers, and the
   * difference between a 200 and a 301 is the difference between a page and a redirect
   * (MUSE-9) — which a file-existence check cannot see at all.
   */
  function llmsLinks(build: Build): string[] {
    return [...build.read('llms.txt').matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map(
      (match) => match[1]!,
    );
  }

  /** What the deploy answers for a URL `llms.txt` advertises. */
  function answerFor(build: Build, url: string): { status: number; file?: string } {
    return resolveRequest(build.outDir, basePath(build), new URL(url).pathname);
  }

  it('found links to check, in both deploy targets', () => {
    // The positive control. Every assertion below is satisfiable by a file with no links
    // in it, and this file's subject is a guard that reads as covering both directions
    // while reaching one (MUSE-37, MUSE-42).
    for (const build of [pages, apex]) {
      expect(llmsLinks(build).length, build.deploy.SITE).toBeGreaterThan(ROUTES.length);
    }
  });

  it('links to nothing the deploy does not serve with a 200', () => {
    for (const build of [pages, apex]) {
      const dead = llmsLinks(build)
        .map((url) => ({ url, ...answerFor(build, url) }))
        .filter(({ status }) => status !== 200)
        .map(({ url, status }) => `${url} → ${status}`);

      expect(
        dead,
        `llms.txt advertises ${dead.length} URL(s) the deploy does not answer. This is ` +
          `published for machines, so a dead link here is followed rather than ignored. ` +
          `A route in ROUTES (src/lib/pages.ts) with no file under src/pages/ produces ` +
          `exactly this; so does a hand-built URL missing its trailing slash (MUSE-9).`,
      ).toEqual([]);
    }
  });

  /**
   * And the set equality the ticket asks for, stated over *page* URLs.
   *
   * A page URL on this site ends in a slash and a published file does not —
   * `trailingSlash: 'always'` with `build.format: 'directory'` (CLAUDE.md), which is why
   * `robots.txt` and `sitemap-index.xml` separate themselves out without a list of
   * exemptions to keep current. Deriving the partition from the site's own URL shape
   * rather than from a hardcoded set of filenames is the whole lesson of MUSE-42.
   */
  it('lists exactly the pages the build serves — nothing missing, nothing extra', () => {
    for (const build of [pages, apex]) {
      const listed = llmsLinks(build).filter((url) => url.endsWith('/'));
      const served = ROUTES.map((route) => absolute(build, route));

      const extra = listed.filter((url) => !served.includes(url));
      expect(extra, `llms.txt lists pages src/pages/ does not build (${build.deploy.SITE})`)
        .toEqual([]);

      const absent = served.filter((url) => !listed.includes(url));
      expect(absent, `llms.txt omits pages the build serves (${build.deploy.SITE})`)
        .toEqual([]);

      expect(new Set(listed).size, 'llms.txt lists a page more than once').toBe(listed.length);
    }
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
      // Derived from the target, not spelled again: a literal here is a second copy of
      // the host inside the check against copies of the host (MUSE-42).
      expect(txt, `${file} still mentions the old host`).not.toContain(
        new URL(PAGES_DEPLOY.SITE).host,
      );
      expect(txt, `${file} still mentions the old base path`).not.toContain(
        PAGES_DEPLOY.BASE.replace(/^\/+|\/+$/g, ''),
      );
    }
  });

  it('keeps the sub-path out of the apex build entirely', () => {
    const apexSitemap = sitemapChildren(apex).map((f) => apex.read(f));
    for (const url of apexSitemap.flatMap(locs)) {
      expect(url.startsWith(APEX_DEPLOY.SITE)).toBe(true);
    }
  });

});

/**
 * MUSE-42 — the deploy host appears nowhere in a build made for a different host.
 *
 * `CLAUDE.md`: no file may name the deploy host; it lives in exactly one place,
 * `astro.config.mjs`, as the overridable `SITE`/`BASE` default. That is what makes a
 * domain move (MUSE-29) a config change rather than a search-and-replace.
 *
 * The check used to be a **hardcoded list of two source directories**, `src/` and
 * `public/`, with a file-count floor underneath it. Three things were wrong with that,
 * and the third is the one that mattered:
 *
 *   1. The floor was satisfiable by one of the two trees, so it could not tell
 *      "`public/` is absent" from "`public/` has four hundred unscanned files".
 *   2. MUSE-35 moved six files *into* `src/`, which widened the slack rather than
 *      closing it — the patch made the guard weaker while looking like a fix.
 *   3. It named two directories out of eight. A host in `sanity/`, `scripts/`, `logo/`
 *      or `.github/` was invisible, and `sanity/` now feeds page content — so a host
 *      string in a seed document reached the rendered page with nothing to say so.
 *
 * So the guarantee moved to **the built output**, where the requirement actually lives.
 * The suite already builds under two deploy targets, so the stronger statement is nearly
 * free: build with `SITE` pointing at a second host, and assert the first appears nowhere
 * in what that build emitted. That claim is immune to directory naming, to a new
 * top-level folder, to `publicDir` changing, and to content arriving from Sanity rather
 * than from a file — there is no list of places to keep up to date, because the output is
 * not a place, it is the whole deliverable.
 *
 * The source scan below is kept, demoted, and **no longer carries the guarantee**. It is
 * a fast failure that names the offending *file*, which `dist/en/index.html` cannot; and
 * it covers the one case the output check structurally cannot see — a host spelled
 * conditionally, so that it only renders under the live target.
 */
describe('AC4 (MUSE-42): no build names a host it was not built for', () => {
  /**
   * The needle, derived from the deploy target the suite builds under.
   *
   * Not spelled again as a literal. A second copy of the host inside the check *for*
   * copies of the host is the shape of this whole defect — and it would also make this
   * file report itself, which is how an exemption list starts.
   */
  const DEPLOY_HOST = new URL(PAGES_DEPLOY.SITE).host;
  /** The other half of the deploy target: the sub-path a project Pages site is served from. */
  const DEPLOY_SUBPATH = PAGES_DEPLOY.BASE.replace(/^\/+|\/+$/g, '');
  const OTHER_HOST = new URL(APEX_DEPLOY.SITE).host;

  /** Every file in `build`'s output containing `needle`, as output-relative paths. */
  function outputsNaming(build: Build, needle: string): string[] {
    return build
      .allFiles()
      .filter((file) => readFileSync(join(build.outDir, file)).includes(needle));
  }

  /** The output file a route is published as — `build.format: 'directory'`. */
  function outputPathOf(route: string): string {
    return route === '/' ? 'index.html' : `${route.slice(1)}/index.html`;
  }

  /**
   * What the scan is known to have read.
   *
   * Asserted *by name*, from the page list this file derives off `src/pages/`, rather
   * than as a count. "No offenders" is a true statement about an empty scan, and a floor
   * is a count that a shrinking scan can still clear — both of which this check has
   * already been through once. Nothing here is satisfiable by having scanned less: a
   * page that stops being emitted fails this rather than quietly leaving the sweep.
   */
  it('reads every page and artefact the build emitted', () => {
    const scanned = new Set(apex.allFiles());
    for (const route of ROUTES) {
      expect(scanned.has(outputPathOf(route)), `${route} was not scanned`).toBe(true);
    }
    for (const artefact of ['robots.txt', 'llms.txt', 'sitemap-index.xml']) {
      expect(scanned.has(artefact), `${artefact} was not scanned`).toBe(true);
    }
    // Including the bytes nobody thinks of as text. A host baked into a font or an
    // image is still a host in the deployed artefact, and `allFiles` is the whole tree.
    expect([...scanned].some((f) => f.endsWith('.woff2'))).toBe(true);
  });

  it('finds the host in the build that is supposed to have it', () => {
    // The positive control, and the reason the assertion below can fail. A broken needle,
    // an unreadable output or an empty file list would all make "the host appears nowhere"
    // pass for the wrong reason; none of them survive this.
    expect(outputsNaming(pages, DEPLOY_HOST)).toContain('index.html');
    expect(outputsNaming(pages, DEPLOY_HOST).length).toBeGreaterThan(1);
  });

  it('names the second target, so the rebuilt output is not simply inert', () => {
    expect(outputsNaming(apex, OTHER_HOST)).toContain('index.html');
  });

  /** The acceptance criterion, in one line. */
  it('leaves no trace of the first host anywhere in the second build', () => {
    expect(outputsNaming(apex, DEPLOY_HOST)).toEqual([]);
  });

  it('leaves no trace of the first deploy sub-path either', () => {
    // MUSE-29 moves both halves of the target. A `/MuseByMina/…` asset path surviving
    // into an apex build 404s every reference to it (MUSE-8), so the sub-path has to go
    // the same way the host does.
    expect(outputsNaming(apex, DEPLOY_SUBPATH)).toEqual([]);
  });
});

/**
 * The fast source scan. Secondary — see the note on the block above.
 *
 * It exists for two reasons and claims nothing beyond them: a failure here names the
 * *file*, and a host spelled conditionally would render only under the live target and so
 * never reach the second build. If this and the output check ever disagree, the output
 * check is right.
 *
 * It takes its scan root from **the repository**, and its exclusions from `.gitignore`.
 * There is therefore no list of directories to keep exhaustive — which is the defect it
 * replaces. The exclusions are a list, but they only ever cause the scan to read *more*
 * than it has to: a pattern that stops matching means an extra tree gets swept, which is
 * a loud false positive rather than silent coverage loss. That direction is the point.
 */
describe('MUSE-42: the host is written in one file, and the repo says which', () => {
  const DEPLOY_HOST = new URL(PAGES_DEPLOY.SITE).host;

  /**
   * The paths that may name the host, and the reason each one has to.
   *
   * A prefix ending in `/` covers a tree. Every entry is checked below to still be
   * *live* — to exist and to actually contain the host — so a stale exemption is an
   * error rather than a widening nobody notices.
   */
  const MAY_NAME_THE_HOST: { path: string; why: string }[] = [
    {
      path: 'astro.config.mjs',
      why: 'defines it, as the overridable SITE default. This is the one place.',
    },
    {
      path: '.github/workflows/deploy.yml',
      why:
        'passes the deploy target in. It is where a *different* host is legitimately ' +
        'named, because overriding SITE there is how MUSE-29 actually happens.',
    },
    {
      path: 'test/',
      why:
        'is the only thing that must name two targets at once — it builds under both ' +
        'and asserts the first appears nowhere in the second. Its copy of the live ' +
        'target is pinned to astro.config.mjs by the last test in this block, so it ' +
        'cannot go stale the way a prose copy can.',
    },
  ];

  /** `.gitignore`, as patterns: comments and blanks dropped, slashes trimmed. */
  function notSource(): string[] {
    return readFileSync(join(ROOT, '.gitignore'), 'utf8')
      .split('\n')
      .map((line) => line.replace(/#.*$/, '').trim())
      .map((line) => line.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean);
  }

  function escapeRe(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** Does `rel` — a repo-relative path — match something `.gitignore` disclaims? */
  function isIgnored(rel: string, patterns: string[]): boolean {
    if (rel === '.git' || rel.startsWith('.git/')) return true;
    return patterns.some((pattern) => {
      if (pattern.includes('/')) {
        return rel === pattern || rel.startsWith(`${pattern}/`);
      }
      const glob = new RegExp(`^${pattern.split('*').map(escapeRe).join('[^/]*')}$`);
      return rel.split('/').some((segment) => glob.test(segment));
    });
  }

  /** Every file in the repository that is not disclaimed, as repo-relative paths. */
  function repoSources(): string[] {
    const patterns = notSource();
    const descend = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        const rel = relative(ROOT, full).replace(/\\/g, '/');
        if (isIgnored(rel, patterns)) return [];
        return entry.isDirectory() ? descend(full) : [rel];
      });
    return descend(ROOT).sort();
  }

  function exempt(file: string): boolean {
    return MAY_NAME_THE_HOST.some(
      ({ path }) => file === path || (path.endsWith('/') && file.startsWith(path)),
    );
  }

  it('scans every top-level entry the repository has, naming none of them', () => {
    // The anti-narrowing assertion, and the whole difference from the old check. The
    // scan is derived from what is on disk, so a renamed directory, a new one, or a
    // changed `publicDir` is swept the day it lands with nobody editing this file.
    const patterns = notSource();
    const scanned = new Set(repoSources().map((file) => file.split('/')[0]!));

    for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
      if (isIgnored(entry.name, patterns)) continue;
      // An empty directory contributes no files and is not a hole; git cannot hold one.
      if (entry.isDirectory() && readdirSync(join(ROOT, entry.name)).length === 0) continue;
      expect(scanned.has(entry.name), `${entry.name} is in the repo and was not scanned`)
        .toBe(true);
    }
  });

  it('reaches the trees the two-directory list could not see', () => {
    // Named explicitly because these are the ones the defect was about. `src/` and
    // `public/` were the whole of the old scan; `sanity/` feeds page content, and
    // `logo/`, `scripts/` and `.github/` were never read at all.
    const files = repoSources();
    for (const tree of ['src/', 'sanity/', 'scripts/', 'logo/', '.github/', 'test/']) {
      expect(files.filter((f) => f.startsWith(tree)).length, `${tree} is unscanned`)
        .toBeGreaterThan(0);
    }
    expect(files).toContain('astro.config.mjs');
    expect(files).toContain('package.json');
    // And nothing from a dependency tree or a build, which is what `.gitignore` is for.
    expect(files.filter((f) => f.startsWith('node' + '_modules'))).toEqual([]);
    expect(files.filter((f) => f.startsWith('dist/'))).toEqual([]);
  });

  it('disclaims only what .gitignore disclaims, and no tracked tree', () => {
    const patterns = notSource();
    for (const tree of ['src', 'sanity', 'scripts', 'logo', '.github', 'test', 'public']) {
      expect(isIgnored(tree, patterns), tree).toBe(false);
    }
    // A worktree under `.claude/` is another checkout of this repo, host and all. It is
    // ignored, and `.claude` itself is not — so project config is still swept.
    expect(isIgnored('.claude/worktrees/agent-x/src/pages/index.astro', patterns)).toBe(true);
    expect(isIgnored('.claude/settings.json', patterns)).toBe(false);
  });

  /**
   * **The decision this ticket asked for, written down: `logo/README.md` fails.**
   *
   * A host string there reaches no rendered page, so the output check above cannot see
   * it, and the honest question is whether that is a defect. It is, for three reasons:
   *
   *   1. `CLAUDE.md`'s rule is a claim about the *repository* — "the host lives in
   *      exactly one place" — not about `dist/`. The cost of MUSE-29 is not only a wrong
   *      URL in the output; it is every stale copy a human then has to find, and a stale
   *      copy in prose is believed rather than noticed.
   *   2. Exempting it requires the check to reason about whether a file "reaches the
   *      output", and that reasoning is exactly what this ticket deletes. "`logo/`
   *      reaches nothing" is a fact about today's site, not an invariant — markdown is
   *      one content collection away from shipping, and `sanity/` *already* stopped
   *      being inert, which is how this hole opened.
   *   3. Strictness is cheap here and the escape hatch is one line with a reason beside
   *      it. The files that must name the host are few, and each is listed above with
   *      why — and asserted live, so the list cannot rot into a blanket.
   *
   * Applied, not just asserted: `README.md` named the host in a copy-pasteable `ORIGIN=`
   * command and now spells it `$SITE`, because a rule that exempts its own first
   * counter-example is not a rule.
   */
  it('lets nothing but the config, the deploy workflow and the suite name the host', () => {
    const offenders = repoSources()
      .filter((file) => !exempt(file))
      .filter((file) => readFileSync(join(ROOT, file)).includes(DEPLOY_HOST));
    expect(offenders).toEqual([]);
  });

  it('keeps every exemption live, so the list cannot rot into a blanket', () => {
    const files = repoSources();
    for (const { path, why } of MAY_NAME_THE_HOST) {
      const covered = files.filter(
        (file) => file === path || (path.endsWith('/') && file.startsWith(path)),
      );
      expect(covered.length, `${path} is exempt and matches nothing`).toBeGreaterThan(0);
      const names = covered.some((file) =>
        readFileSync(join(ROOT, file)).includes(DEPLOY_HOST),
      );
      expect(names, `${path} no longer names the host, so the exemption ("${why}") is dead`)
        .toBe(true);
    }
  });

  it('pins the deploy target the suite builds under to the config default', () => {
    // What makes `test/`'s exemption honest rather than convenient: the suite's copy of
    // the live target is the config's, and a drift fails here instead of turning the
    // needle above into a string that matches nothing.
    const config = readFileSync(join(ROOT, 'astro.config.mjs'), 'utf8');
    expect(config).toContain(`?? '${PAGES_DEPLOY.SITE}'`);
    expect(config).toContain(`?? '${PAGES_DEPLOY.BASE}'`);
    // And the two targets have to be genuinely different, or none of this proves anything.
    expect(new URL(APEX_DEPLOY.SITE).host).not.toBe(new URL(PAGES_DEPLOY.SITE).host);
  });
});

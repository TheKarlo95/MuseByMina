import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  basePath,
  buildSite,
  canonicalOf,
  declaredAlternates,
  isOwnAsset,
  PAGES_DEPLOY,
  pageRefs,
  type Build,
  type PageRef,
} from './helpers/build';
import { resolveRequest, servePages, type Host } from './helpers/serve';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../src/lib/i18n';
import { LANG_PARAM, LANG_STORAGE_KEY } from '../src/lib/lang';
import { MORE_NAV, PRIMARY_NAV } from '../src/lib/nav';
import { ROUTES } from '../src/lib/pages';

/**
 * MUSE-13 — no link the site serves may lead to a 404.
 *
 * The bug: `src/lib/nav.ts` declared the finished information architecture — sixteen
 * menu entries — while `src/pages/` had four pages. The header renders that list in both
 * locales, so twelve routes × two locales = 24 dead links on every page of the site, and
 * Pricing and About were the two most likely second clicks. The footer had its own list
 * built from the same file, so the real count was higher than the ticket's.
 *
 * ---------------------------------------------------------------------------
 * Why this file crawls instead of reading `nav.ts`.
 *
 * The obvious test is "for every route in `PRIMARY_NAV`, assert `src/pages/<route>.astro`
 * exists". It would have caught this one bug and nothing else:
 *
 *   - it cannot see the footer, which links routes `nav.ts` does not list and slices the
 *     ones it does;
 *   - it cannot see the language switcher, whose hrefs are computed from the current
 *     pathname and are dead on the 404 page in both directions;
 *   - it cannot see the CTA (`/#trial`), the logo, or any href written inside a
 *     component;
 *   - it agrees with `nav.ts` by construction, so a route list that is wrong in the same
 *     way in two places passes;
 *   - and it would have to model Astro's routing — `src/pages/x.astro` ↔ `/x/` ↔
 *     `dist/x/index.html` — which is the part a file-filter or an exact-match assumption
 *     has already defeated three times in this repo (MUSE-8, MUSE-9, MUSE-17).
 *
 * So the expected set is derived from the build, not maintained by anyone: every
 * same-origin navigable URL in every built page is **fetched** from the GitHub Pages
 * model in `test/helpers/serve.ts` and has to answer 200 with no redirect. A route added
 * to `nav.ts` without a page fails here, and so does a dead link introduced anywhere
 * else by any other means.
 *
 * `astro preview` cannot stand in for that host: it answers both spellings of a
 * directory URL with 200 and never redirects (see `serve.ts`), so a link to a page that
 * exists under a different spelling would look fine to it.
 * ---------------------------------------------------------------------------
 */

let build: Build;
let host: Host;

beforeAll(async () => {
  build = buildSite(PAGES_DEPLOY);
  host = await servePages(build);
}, 240_000);

afterAll(async () => {
  await host?.close();
});

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

function decode(text: string): string {
  return text.replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole);
}

/**
 * The landmark an offset falls inside: `header`, `main`, `footer`, or `page`.
 *
 * Only so a failure says *which list* is broken. The ticket counted the header's links
 * and missed that the footer builds its own set from the same module, so a message that
 * says `footer` rather than `index.html` is the difference between one fix and two.
 */
function regionAt(html: string, offset: number): string {
  for (const name of ['header', 'main', 'footer']) {
    const open = new RegExp(`<${name}\\b[^>]*>`, 'g');
    for (const m of html.matchAll(open)) {
      const start = m.index!;
      const end = html.indexOf(`</${name}>`, start);
      if (end !== -1 && offset > start && offset < end) return name;
    }
  }
  return 'page';
}

/**
 * Every navigable URL a built page emits, each labelled with where it came from.
 *
 * `<a href>` is re-extracted here rather than taken from `pageRefs` only to attach the
 * landmark; the `<link rel>` and `<meta property>` refs come from `pageRefs` unchanged,
 * so a navigable URL added to the `<head>` tomorrow is crawled the day it lands.
 */
function navigableRefs(html: string): PageRef[] {
  const anchors: PageRef[] = [];
  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    const href = /\bhref="([^"]*)"/.exec(m[0])?.[1];
    if (href === undefined) continue;
    anchors.push({ source: `<a href> in <${regionAt(html, m.index!)}>`, url: decode(href) });
  }
  return [...anchors, ...pageRefs(html).filter((ref) => ref.source !== '<a href>')];
}

/** One crawled reference: where it was written, and where it points. */
interface Crawled extends PageRef {
  /** The built page it was found on. */
  page: string;
  /** Path and query, as the host would receive them. */
  request: string;
}

/** Every same-origin navigable reference in the whole build. */
function crawl(filter?: (ref: PageRef) => boolean): Crawled[] {
  const root = new URL(`${build.origin}/`);
  const out: Crawled[] = [];

  for (const page of build.htmlFiles()) {
    const html = build.read(page);
    for (const ref of navigableRefs(html)) {
      if (filter && !filter(ref)) continue;
      // A `mailto:`, another origin or a bare `#fragment` is not this deploy's to serve.
      if (!isOwnAsset(build, ref.url)) continue;
      const resolved = new URL(ref.url.trim(), root);
      out.push({ ...ref, page, request: `${resolved.pathname}${resolved.search}` });
    }
  }

  return out;
}

const isAnchor = (ref: PageRef): boolean => ref.source.startsWith('<a href>');

/**
 * `/MuseByMina/en/schedule/` → `{ locale: 'en', route: '/schedule' }`.
 *
 * A `?query` is dropped, because an *address* is a path and the question every caller asks
 * is which page a reference leads to. `request` carries the query — that is what makes it
 * a request, and `test/urls.test.ts`'s model of the host needs it — so this used to read
 * `/MuseByMina/?lang=hr` as the route `/?lang=hr`, in no locale, and the error page's two
 * exits stopped looking like links to the two homepages the moment MUSE-56 made them name
 * their language. The fragment goes with it for the same reason: `/#trial` is the
 * homepage.
 */
function addressOf(request: string): { locale: Locale; route: string } {
  const base = basePath(build);
  const path = request.split(/[?#]/)[0]!;
  const segments = path.slice(base.length).split('/').filter(Boolean);
  const locale = LOCALES.find((l) => l === segments[0]);
  if (locale) segments.shift();
  return { locale: locale ?? 'hr', route: `/${segments.join('/')}` };
}

/** The built file the host would serve `request` from, or `undefined` if none. */
function servedFile(request: string): string | undefined {
  const served = resolveRequest(build.outDir, basePath(build), new URL(request, 'http://x').pathname);
  return served.status === 200 ? served.file : undefined;
}

/** The error page: the one built page that declares no canonical of its own. */
function errorPages(): string[] {
  return build.htmlFiles().filter((page) => canonicalOf(build.read(page)) === undefined);
}

/**
 * The locale a built file belongs to, read off its path: `en/schedule/index.html` → en.
 *
 * The same rule as `addressOf`, over an output path rather than a request, because a
 * page's locale has to be known for pages that are never the target of a link — which is
 * the whole subject below.
 */
function localeOfPage(page: string): Locale {
  const first = page.split('/')[0];
  return LOCALES.find((locale) => locale === first) ?? DEFAULT_LOCALE;
}

/** One page-to-page link in the built output, both ends as output paths. */
interface PageLink {
  /** The built page the href was written on. */
  from: string;
  /** The built page the host would serve that href from. */
  to: string;
  /** Where on `from` it was written, for the failure message. */
  source: string;
}

/** A build reduced to the question "what links what": pages, and links between them. */
interface LinkGraph {
  /**
   * Every built page a visitor can be sent to — error pages excluded, because GitHub
   * Pages serves `404.html` for unknown paths and for no URL of its own.
   */
  pages: string[];
  links: PageLink[];
}

/** A page nothing can reach, and the references that looked like they reached it. */
interface Orphan {
  page: string;
  locale: Locale;
  /** References to it that prove nothing: its own, its twin's, the error page's. */
  discounted: PageLink[];
}

/**
 * The pages in `graph` that no *other* page of their own locale links to.
 *
 * MUSE-37 — this is the rule the test below used to get wrong, and it is worth being
 * precise about why. The old version collected link *targets* into a `reached` set and
 * subtracted it from the page list. Every page is a link target of itself: the locale
 * switcher always renders an own-locale `<a aria-current="true">` pointing at the current
 * page, and the logo and the nav's `aria-current` entry do the same on the pages they
 * name. So `reached` was the whole build by construction and the assertion could not
 * fail — two unlinked pages were added to a copy of the repo and the suite stayed green.
 *
 * Three references are therefore discounted, and each has to be:
 *
 *   - **Its own.** A page is not evidence of its own reachability. This is the bug.
 *   - **Its twin's in the other locale.** HR and EN share slugs and every page carries a
 *     switcher, so `/en/x/` is always linked from `/x/` whether or not either is in a
 *     menu. Counting that link would make one nav entry publish two reachable pages, and
 *     a visitor reading English would have no way to arrive at the English one.
 *   - **The error page's.** `404.html` is reachable by mistyping, not by navigating; a
 *     page linked only from there is reached by nobody on purpose. It falls out of the
 *     rule rather than being special-cased — only a page in `graph.pages` can make
 *     another page reachable, and the error page is not one.
 *
 * Reachability is inbound-degree, not transitivity from the homepage: a cluster of pages
 * that link each other and nothing else would pass here. That is deliberate — the failure
 * this guards is a page that shipped without a menu entry, and the stronger property has
 * no failure mode to point at yet.
 */
function orphansOf(graph: LinkGraph): Orphan[] {
  const addressable = new Set(graph.pages);
  const inbound = new Map(graph.pages.map((page) => [page, [] as PageLink[]]));
  const discounted = new Map(graph.pages.map((page) => [page, [] as PageLink[]]));

  for (const link of graph.links) {
    if (!addressable.has(link.to)) continue;
    const counts =
      link.from !== link.to &&
      addressable.has(link.from) &&
      localeOfPage(link.from) === localeOfPage(link.to);
    (counts ? inbound : discounted).get(link.to)!.push(link);
  }

  return [...graph.pages]
    .sort()
    .filter((page) => inbound.get(page)!.length === 0)
    .map((page) => ({
      page,
      locale: localeOfPage(page),
      discounted: discounted.get(page)!,
    }));
}

/** The whole build as a link graph: anchors only, resolved through the host's rules. */
function linkGraph(): LinkGraph {
  const errors = new Set(errorPages());
  const links: PageLink[] = [];

  for (const ref of crawl(isAnchor)) {
    const to = servedFile(ref.request);
    // A link that resolves to nothing is AC1's business, not this one's.
    if (to === undefined) continue;
    links.push({ from: ref.page, to, source: ref.source });
  }

  return { pages: build.htmlFiles().filter((page) => !errors.has(page)), links };
}

/** An orphan as a sentence that says which page, which locale, and what to do. */
function describeOrphan(orphan: Orphan): string {
  const self = orphan.discounted.filter((link) => link.from === orphan.page);
  const elsewhere = [
    ...new Set(orphan.discounted.filter((link) => link.from !== orphan.page).map((l) => l.from)),
  ];
  return (
    `${orphan.page} (${orphan.locale} ${routeOfPage(orphan.page)}) is linked from no other ` +
    `${orphan.locale} page — ${self.length} self-reference(s)` +
    (elsewhere.length > 0 ? `, ${elsewhere.length} from ${elsewhere.sort().join(', ')}` : '') +
    '. Add it to src/lib/nav.ts, or link it from a page in the same locale.'
  );
}

/**
 * **A section of the site: a route no other route is the parent of** (MUSE-24).
 *
 * Derived from `ROUTES` by path depth rather than written down, so `/events/archive` is a
 * child the day it is routed and a second one reclassifies itself. `/` is excluded from
 * being anybody's parent — every route is nominally under it, and treating it as one would
 * make the whole site a child of the homepage.
 */
function topLevelRoutes(): string[] {
  const routed = new Set(ROUTES.map(({ route }) => route));
  return ROUTES.map(({ route }) => route).filter((route) => {
    const segments = route.split('/').filter(Boolean);
    if (segments.length < 2) return true;
    return !routed.has(`/${segments.slice(0, -1).join('/')}`);
  });
}

/** The sections, as a set. */
const SECTIONS = new Set(topLevelRoutes());

/**
 * Does the footer's own list contain this page's route?
 *
 * Module scope rather than inside the `aria-current` block, because two blocks turn on the
 * same partition: a page the footer lists is marked and self-links through that mark, and a
 * page it does not list is neither. One definition, so the two cannot drift.
 */
function footerLists(page: string): boolean {
  return SECTIONS.has(routeOfPage(page));
}

/** The routes the footer's own lists link, read off the built markup. */
function footerRoutes(html: string): Set<string> {
  const footer = /<footer\b[^>]*>([\s\S]*?)<\/footer>/.exec(html);
  expect(footer, 'no <footer> in the built page').not.toBeNull();

  const routes = new Set<string>();
  for (const match of footer![1]!.matchAll(/<a\b[^>]*\bhref="([^"]*)"/g)) {
    const href = decode(match[1]!);
    if (!isOwnAsset(build, href)) continue;
    routes.add(addressOf(new URL(href, `${build.origin}/`).pathname).route);
  }
  return routes;
}

/** `en/schedule/index.html` → `/schedule`. For failure messages. */
function routeOfPage(page: string): string {
  const segments = page.replace(/(?:^|\/)index\.html$/, '').split('/').filter(Boolean);
  if (LOCALES.some((locale) => locale === segments[0])) segments.shift();
  return `/${segments.join('/')}`;
}

/**
 * The header's primary nav, as markup — `<script>` blocks removed.
 *
 * The scripts have to go. Header's own module still calls
 * `querySelector('[data-more-btn]')`, harmlessly, whether or not the button is rendered;
 * a check for the button that read the scripts too would see the selector and conclude
 * the disclosure is still there.
 */
function headerNav(html: string): string {
  const nav = /<nav\b[^>]*id="primary-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html);
  expect(nav, 'no <nav id="primary-nav"> in the built header').not.toBeNull();
  return nav![1]!.replace(/<script\b[\s\S]*?<\/script>/g, '');
}

/**
 * The inner HTML of the header's nav list, nested lists included.
 *
 * Found by counting `<ul>` depth rather than by a greedy match to the last `</ul>`: the
 * nav also contains the locale and theme switches, and a list appearing in either of
 * those later would silently extend a greedy match past the one being read.
 */
function navList(html: string): string {
  const nav = headerNav(html);
  const open = /<ul\b[^>]*>/.exec(nav);
  expect(open, 'the primary nav has no list').not.toBeNull();

  let depth = 0;
  for (const m of nav.matchAll(/<(\/?)ul\b[^>]*>/g)) {
    depth += m[1] === '/' ? -1 : 1;
    if (depth === 0) return nav.slice(open!.index! + open![0].length, m.index!);
  }
  throw new Error('the primary nav list is never closed');
}

/**
 * Each **top-level** `<li>` of the header's primary nav: its class list and its href.
 *
 * Nested lists are stripped first. A disclosure's own entries are items of the
 * dropdown, not of the bar, and counting them would make "the bar stays short" pass or
 * fail for the wrong reason the moment `MORE_NAV` refills.
 */
function navItems(html: string): { classes: string[]; href: string | undefined }[] {
  let flat = navList(html);
  for (let prev = ''; flat !== prev; ) {
    prev = flat;
    flat = flat.replace(/<ul\b[^>]*>[\s\S]*?<\/ul>/g, '');
  }
  return [...flat.matchAll(/<li\b([^>]*)>([\s\S]*?)<\/li>/g)].map((m) => ({
    classes: (/\bclass="([^"]*)"/.exec(m[1]!)?.[1] ?? '').split(/\s+/).filter(Boolean),
    href: /<a\b[^>]*\bhref="([^"]*)"/.exec(m[2]!)?.[1],
  }));
}

/**
 * AC1 — Given any page in either locale, when I click any navigation link, then I reach
 * a real page, never a 404.
 *
 * Stated as the crawl the ticket's Verification section asks for: every same-origin
 * navigable URL on every built page, fetched, 200, no `Location`.
 */
describe('AC1: every link the build emits reaches a real page', () => {
  it('fetches every same-origin link on every built page with a 200 and no redirect', async () => {
    const refs = crawl();
    expect(refs.length, 'the crawl found no internal links at all').toBeGreaterThan(0);

    const dead: string[] = [];
    // One probe per distinct request, reported against every place that writes it —
    // otherwise a header link appears once per page and buries everything else.
    const sources = new Map<string, string[]>();
    for (const ref of refs) {
      const where = `${ref.page} ${ref.source}`;
      sources.set(ref.request, [...(sources.get(ref.request) ?? []), where]);
    }

    for (const [request, where] of sources) {
      const probe = await host.get(request);
      if (probe.status === 200 && probe.location === undefined) continue;
      dead.push(
        `${request} -> ${probe.status} ${probe.location ?? ''}`.trim() +
          ` (linked from ${where.length} place(s): ${where.slice(0, 4).join(', ')}${
            where.length > 4 ? ', …' : ''
          })`,
      );
    }

    expect(dead.sort()).toEqual([]);
  });

  it('crawls both locales, so a check that only saw Croatian cannot pass', () => {
    const found = new Set(crawl(isAnchor).map((ref) => addressOf(ref.request).locale));
    expect([...found].sort()).toEqual([...LOCALES].sort());
  });

  /**
   * The failure mode a guard like this dies of: a filter that quietly matches nothing.
   * Every built page must contribute links from *both* lists — the header's and the
   * footer's — because the footer is the half the ticket's own count missed.
   */
  it('finds links in the header and the footer of every built page', () => {
    const anchors = crawl(isAnchor);
    const missing: string[] = [];

    for (const page of build.htmlFiles()) {
      for (const region of ['header', 'footer']) {
        const count = anchors.filter(
          (ref) => ref.page === page && ref.source.includes(`<${region}>`),
        ).length;
        if (count === 0) missing.push(`${page}: no internal links in <${region}>`);
      }
    }

    expect(missing).toEqual([]);
  });
});

/**
 * AC2 — Given the suite, then a test fails if any route in `nav.ts` has no page behind
 * it.
 *
 * AC1 already covers this, by crawling what the header rendered. This describe block
 * exists so the *message* names the nav rather than an output path: the route list is
 * where the mistake gets made, and "`/pricing` is in the header nav and 404s" is a more
 * actionable failure than "`/MuseByMina/pricing/` -> 404".
 */
describe('AC2: every route the nav renders has a page behind it', () => {
  it('serves a page for every route in the header nav, in both locales', async () => {
    const dead: string[] = [];

    for (const ref of crawl((r) => r.source.includes('<header>') && isAnchor(r))) {
      const probe = await host.get(ref.request);
      if (probe.status === 200 && probe.location === undefined) continue;
      const { locale, route } = addressOf(ref.request);
      dead.push(
        `${route} (${locale}) is in the header nav but ${ref.request} -> ${probe.status}` +
          ` — either build the page or take the route out of src/lib/nav.ts`,
      );
    }

    expect([...new Set(dead)].sort()).toEqual([]);
  });

  it('renders every declared nav route into the markup, so none is checked in absentia', () => {
    // The other half of AC2: a route could be missing from the rendered nav rather than
    // missing a page, and the crawl above would be satisfied by a list it never saw.
    const declared = [...PRIMARY_NAV, ...MORE_NAV].map((item) => item.route).sort();

    for (const page of build.htmlFiles()) {
      const html = build.read(page);
      const rendered = navigableRefs(html)
        .filter((ref) => ref.source.includes('<header>'))
        .filter((ref) => isOwnAsset(build, ref.url))
        .map((ref) => addressOf(new URL(ref.url, `${build.origin}/`).pathname).route);
      for (const route of declared) {
        expect(rendered, `${page} does not render the nav route ${route}`).toContain(route);
      }
    }
  });
});

/**
 * AC3 — Given a future route added to `nav.ts` without a page, then CI fails rather
 * than shipping a dead link.
 *
 * What makes that true is that the set above is read off the build. These tests pin the
 * two properties the guard would lose its teeth without, because both have been lost
 * before in this repo: the host must distinguish a redirect from a hit, and the crawl
 * must look at every page in the output rather than a list of the ones we remembered.
 */
describe('AC3: the guard keeps its teeth as the pages land one at a time', () => {
  it('treats a URL that only 301s as dead, not as reachable', async () => {
    // `/MuseByMina/schedule` without its slash is a real page under the wrong spelling.
    // If the probe followed redirects, or accepted any 2xx/3xx, the guard would pass for
    // a nav full of redirecting links — which is MUSE-9 all over again.
    const base = basePath(build);
    const probe = await host.get(`${base}schedule`);
    expect([probe.status, probe.location]).toEqual([301, `${base}schedule/`]);
  });

  it('crawls every HTML file the build produced, including the error page', () => {
    const crawled = new Set(crawl().map((ref) => ref.page));
    expect([...crawled].sort()).toEqual(build.htmlFiles());
    expect(errorPages().length, 'no error page in the output').toBeGreaterThan(0);
    for (const page of errorPages()) expect(crawled).toContain(page);
  });

});

/**
 * MUSE-37 — the opposite mistake to the ticket's, and the one about to matter.
 *
 * AC2 catches a route in `nav.ts` with no page behind it. This catches a page in the
 * build with nothing pointing at it: shipped, served, and in no menu. No route list can
 * detect that, because the route is not in the list — it has to come off the build.
 *
 * The test that used to live here could not fail; `orphansOf` above explains why and
 * what replaced it. The two tests after the real-build assertion are what stop it
 * decaying back: one injects an orphan into the real graph and requires the guard to name
 * it, the other requires the self-references the rule discounts to actually be there, so
 * the discount cannot become a no-op that nobody notices.
 */
describe('AC4: a page nothing links to is an orphan, whatever it links to itself', () => {
  const hr = 'x/index.html';
  const en = 'en/x/index.html';
  const link = (from: string, to: string): PageLink => ({ from, to, source: '<a href>' });

  it('names a page that only links to itself', () => {
    const orphans = orphansOf({ pages: [hr], links: [link(hr, hr), link(hr, hr)] });
    expect(orphans.map((o) => o.page)).toEqual([hr]);
    expect(orphans[0]!.discounted.length).toBe(2);
  });

  it('accepts a page another page of the same locale links to', () => {
    const home = 'index.html';
    expect(
      orphansOf({
        pages: [home, hr],
        links: [link(home, home), link(home, hr), link(hr, hr), link(hr, home)],
      }),
    ).toEqual([]);
  });

  it('counts each locale on its own, so a twin is not a referrer', () => {
    // The language switcher links `/x/` ↔ `/en/x/` on every page that exists. If that
    // counted, one HR menu entry would publish a reachable English page nobody can get
    // to from English — so both halves are orphans here, and the test says both.
    const orphans = orphansOf({
      pages: [hr, en],
      links: [link(hr, hr), link(hr, en), link(en, en), link(en, hr)],
    });
    expect(orphans.map((o) => o.page)).toEqual([en, hr]);
  });

  it('does not let a link on the error page rescue a page', () => {
    // `404.html` is not in `pages` — it is served for no URL of its own. A page reachable
    // only from it is reachable by mistyping, which is not navigation.
    const orphans = orphansOf({ pages: [hr], links: [link('404.html', hr), link(hr, hr)] });
    expect(orphans.map((o) => o.page)).toEqual([hr]);
  });

  it('leaves no built page reachable only from itself', () => {
    const orphans = orphansOf(linkGraph()).map(describeOrphan);
    expect(orphans).toEqual([]);
  });

  it('names an orphan added to the real build, so the guard is not a tautology again', () => {
    // The whole graph the real build produces, plus one page carrying exactly the
    // self-reference every page carries. If this passes, the rule is back to counting a
    // page as its own referrer and the assertion above means nothing.
    const real = linkGraph();
    const injected = 'unlinked/index.html';
    const found = orphansOf({
      pages: [...real.pages, injected],
      links: [...real.links, link(injected, injected)],
    });
    // Stated as the *difference* the injection makes, so this still means "the guard
    // reacts" on a build that has orphans of its own rather than piling on the failure
    // above.
    const baseline = orphansOf(real).map((orphan) => orphan.page);
    const added = found.filter((orphan) => !baseline.includes(orphan.page));
    expect(added.map((orphan) => orphan.page)).toEqual([injected]);
    expect(describeOrphan(added[0]!)).toContain('1 self-reference(s)');
  });

  it('still finds the self-references it discounts, so the discount stays exercised', () => {
    /**
     * The discount exists so that a page's own link to itself does not count as inbound,
     * and it is dead code the day nothing self-links — at which point the next author
     * deletes it in good faith. This is the test that argues with them.
     *
     * **It used to say „every addressable page self-links", and MUSE-24 is where that
     * stopped being true.** A page self-links through the footer's `aria-current` entry,
     * the nav's, or the logo — all three are lists of *sections*, and `/events/archive/` is
     * the first page the site serves that is not one: it is reached from `/events/` and is
     * deliberately in no menu (`src/lib/nav.ts`). So the claim is split in two, and both
     * halves are here rather than one weaker one:
     *
     *   - the discount is exercised, by most of the build rather than by one page;
     *   - and the pages that do *not* self-link are exactly the pages the footer does not
     *     list, which is the same partition the `aria-current` block below turns on. A
     *     listed page that stopped self-linking is still a failure, named.
     */
    const { pages, links } = linkGraph();
    const selfLinks = (page: string): boolean =>
      links.some((ref) => ref.from === page && ref.to === page);

    const selfless = pages.filter((page) => !selfLinks(page));
    const linked = pages.filter(selfLinks);

    expect(linked.length, 'no page self-links — the rule discounts nothing').toBeGreaterThan(
      pages.length / 2,
    );
    expect(
      selfless.sort(),
      'a page in the footer’s list stopped linking to itself, or an unlisted page started',
    ).toEqual(pages.filter((page) => !footerLists(page)).sort());
  });
});

/**
 * The desktop/mobile split survives the trim.
 *
 * `mobileOnly` exists so the desktop bar stays short while the mobile panel is a full
 * index. At three routes the distinction nearly stops paying for itself, and the
 * temptation is to delete it — but the twelve pages are coming back, so it stays and is
 * held to rendering sensibly at this length instead.
 */
describe('one DOM list, two information architectures', () => {
  it('puts every primary route in the mobile panel', () => {
    for (const page of build.htmlFiles()) {
      const hrefs = navItems(build.read(page))
        .map((item) => item.href)
        .filter((href): href is string => href !== undefined);
      const routes = hrefs.map((href) => addressOf(new URL(href, `${build.origin}/`).pathname).route);
      expect(routes, `${page}'s panel is not the full primary list`).toEqual(
        expect.arrayContaining(PRIMARY_NAV.map((item) => item.route)),
      );
    }
  });

  it('keeps the mechanism live rather than leaving it dead code', () => {
    // At least one entry still hides on desktop. If nothing did, `mobileOnly` and its
    // CSS rule would be unexercised and the next author would delete them in good faith.
    const hidden = navItems(build.read('index.html')).filter((item) =>
      item.classes.includes('mobileOnly'),
    );
    expect(hidden.length, 'nothing is mobileOnly — the split is unexercised').toBeGreaterThan(0);
  });

  it('leaves the desktop bar neither empty nor long', () => {
    const items = navItems(build.read('index.html'));
    const onDesktop = items.filter((item) => !item.classes.includes('mobileOnly'));
    expect(onDesktop.length, 'the desktop bar renders no links at all').toBeGreaterThan(0);
    // "The desktop bar stays at four items" is the design intent in `nav.ts`; the
    // disclosure is the fifth slot.
    expect(onDesktop.length).toBeLessThanOrEqual(5);
  });
});

/**
 * The "More" disclosure, which the trim emptied.
 *
 * Written as a conditional on `MORE_NAV` rather than as "there is no More button", so it
 * keeps asserting the right thing when the content pages put entries back.
 */
describe('the "More" disclosure appears only when it has something to disclose', () => {
  for (const page of ['index.html', 'en/index.html']) {
    it(`renders no empty disclosure (${page})`, () => {
      const nav = headerNav(build.read(page));

      if (MORE_NAV.length === 0) {
        expect(
          nav.includes('data-more-btn'),
          'an empty "More" button is worse than no button',
        ).toBe(false);
        expect(nav.includes('id="more-menu"'), 'an empty "More" list is rendered').toBe(false);
        expect(
          /\b(?:Više|More)\b/.test(navList(build.read(page))),
          'the menu is gone but its label is still in the nav',
        ).toBe(false);
      } else {
        expect(nav.includes('data-more-btn'), 'no "More" button for a non-empty list').toBe(
          true,
        );
        expect(/<button[^>]*\baria-expanded="false"[^>]*data-more-btn/.test(nav)).toBe(true);
        const menu = /<ul\b[^>]*id="more-menu"[^>]*>([\s\S]*?)<\/ul>/.exec(nav);
        expect(menu, 'the disclosure controls no list').not.toBeNull();
        expect([...menu![1]!.matchAll(/<a\b/g)].length).toBe(MORE_NAV.length);
      }
    });
  }
});

/**
 * The error page's own chrome.
 *
 * GitHub Pages serves one root `404.html` for every unknown path, so this page has no
 * URL of its own: `/404/`, `/en/404` and `/en/404/` are all 404s (pinned in
 * `test/urls.test.ts`'s host model). The language switcher computes its hrefs from the
 * current route, which made it two dead links on the one page a visitor reaches
 * *because* a link was dead — so the header omits it where the page is not addressable.
 *
 * Asserted through the links rather than through the switcher's markup: what matters is
 * that nothing here is a dead end, not which component was dropped.
 */
describe('the error page is a way out, not a second dead end', () => {
  it('offers at least one internal link, and every one of them resolves', async () => {
    for (const page of errorPages()) {
      const anchors = crawl((ref) => isAnchor(ref)).filter((ref) => ref.page === page);
      expect(anchors.length, `${page} offers no way back into the site`).toBeGreaterThan(0);

      const dead: string[] = [];
      for (const ref of anchors) {
        const probe = await host.get(ref.request);
        if (probe.status !== 200 || probe.location !== undefined) {
          dead.push(`${page} ${ref.source}: ${ref.request} -> ${probe.status}`);
        }
      }
      expect([...new Set(dead)].sort()).toEqual([]);
    }
  });

  it('links the homepage from the error page', () => {
    for (const page of errorPages()) {
      const routes = crawl(isAnchor)
        .filter((ref) => ref.page === page)
        .map((ref) => addressOf(ref.request).route);
      expect(routes, `${page} does not link the homepage`).toContain('/');
    }
  });
});

/**
 * MUSE-38 — "may search engines index this" and "may this page route by language" are
 * two questions, and for one release they had one answer.
 *
 * MUSE-13 wrote `const localeRouting = indexable;` in `BaseLayout.astro` and `404.astro`
 * passes `indexable={false}`, so the error page shipped neither the locale switcher (right
 * — there is no `/en/404/` to point at) nor `langInitScript` (wrong). MUSE-33 then made
 * `?lang=` the strongest routing signal and documented it as acting on *every* page, which
 * it could not do here because the script that reads it was absent. An `en-US` visitor
 * following a stale link got an all-Croatian page, no switcher, and a `?lang=en` that was
 * discarded rather than persisted — so the preference did not even reach wherever they
 * went next.
 *
 * The split is `indexable` (a crawler question) and `localeTwin` (is there an addressable
 * page for this route in each locale). The error page is the witness that they are now
 * independent: unindexed, and language-aware anyway. The source guard below is what stops
 * the alias coming back, because an alias is the one shape of this bug that reads as
 * tidying up.
 */
describe('indexability and language handling are separate questions (MUSE-38)', () => {
  const LAYOUT = fileURLToPath(new URL('../src/layouts/BaseLayout.astro', import.meta.url));

  /** The inline `<script>` blocks of a built page. */
  function inlineScripts(html: string): string[] {
    return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
  }

  /** Does this page carry the locale-routing script at all? */
  function routesByLanguage(html: string): boolean {
    return inlineScripts(html).some(
      (body) => body.includes(LANG_STORAGE_KEY) && body.includes(`"${LANG_PARAM}"`),
    );
  }

  /** `<meta name="robots">`'s content, or `undefined`. */
  function metaRobots(html: string): string | undefined {
    return /<meta\s+name="robots"\s+content="([^"]*)"/.exec(html)?.[1];
  }

  it('ships the language script on the error page, which is not indexable', () => {
    // The bug, stated as the two halves that have to hold at once. Either one alone was
    // already true before the fix.
    for (const page of errorPages()) {
      const html = build.read(page);
      expect(metaRobots(html), `${page} is not noindex`).toMatch(/\bnoindex\b/);
      expect(
        routesByLanguage(html),
        `${page} ships no locale-routing script, so ?lang= is discarded there`,
      ).toBe(true);
    }
  });

  it('ships it on every other page too, so the error page is not a special case', () => {
    for (const page of build.htmlFiles()) {
      expect(routesByLanguage(build.read(page)), `${page} ships no locale-routing script`).toBe(
        true,
      );
    }
  });

  it('keeps the error page unindexed: no canonical, no hreflang, no og:url', () => {
    for (const page of errorPages()) {
      const html = build.read(page);
      expect(canonicalOf(html), `${page} declares a canonical`).toBeUndefined();
      expect([...declaredAlternates(html).keys()], `${page} declares hreflang`).toEqual([]);
      expect(html, `${page} declares an og:url`).not.toMatch(/property="og:url"/);
      expect(html, `${page} emits a structured-data block`).not.toMatch(
        /type="application\/ld\+json"/,
      );
    }
  });

  it('is the only page that is not indexable, and every indexable one says nothing', () => {
    // The other direction: `noindex` must not have spread to a page that has a URL.
    const unindexed = build
      .htmlFiles()
      .filter((page) => metaRobots(build.read(page)) !== undefined);
    expect(unindexed).toEqual(errorPages());
  });

  it('derives neither flag from the other in the layout', () => {
    // `const localeRouting = indexable;` is the regression, and it reads as a tidy-up
    // rather than as a decision — which is why it is pinned against the source instead of
    // only against today's output. Two props, neither assigned from the other.
    //
    // Comments are stripped first, because the layout quotes the offending line in the
    // note explaining it: a guard that cannot tell code from the documentation of the bug
    // it guards against would make writing that note impossible.
    const layout = readFileSync(LAYOUT, 'utf8');
    expect(layout).toContain('indexable');
    // `localeTwin` became `localeTwins`, a set of locales, when a post could be published
    // in one language (MUSE-26). The needle allows either spelling on purpose: the rule is
    // about the *alias*, and renaming the prop must not be a way to stop the rule applying.
    expect(layout).toMatch(/\blocaleTwins?\b/);

    const code = layout
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'the comment stripper ate the frontmatter').toContain('Astro.props');
    expect(
      /\b(?:const|let|var)\s+\w+\s*=\s*(?:indexable|localeTwins?)\s*[;,]/.test(code),
      'one locale/indexing flag is aliased from the other again',
    ).toBe(false);
  });
});

/**
 * The error page reads, and lets you leave, in either language.
 *
 * There is one `404.html` for the whole site — GitHub Pages serves it for every unknown
 * path — so it has no locale twin and cannot have a switcher: `/en/404/` is itself a 404,
 * and a switcher pointing at it was the dead link MUSE-13 removed. The body is therefore
 * bilingual: both languages are in the markup, each marked with its own `lang`, each with
 * its own exit. That holds with JavaScript off, with `localStorage` blocked, and on the
 * first paint — none of which is true of selecting one language client-side.
 *
 * Asserted through the markup's `lang` attributes and the links' destinations rather than
 * against the copy, so a reworded page still has to offer both languages a way out.
 */
describe('the error page is bilingual, and both exits are real (MUSE-38)', () => {
  /** The `lang` values declared *inside* `<main>` on a built page. */
  function langsInMain(html: string): string[] {
    const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html);
    expect(main, 'no <main> in the built page').not.toBeNull();
    return [...new Set([...main![1]!.matchAll(/\blang="([^"]*)"/g)].map((m) => m[1]!))].sort();
  }

  /** The outer element carrying `lang="<locale>"`, innerHTML only. */
  function blockWithLang(html: string, locale: string): string | undefined {
    const open = new RegExp(`<(\\w+)\\b[^>]*\\blang="${locale}"[^>]*>`).exec(html);
    if (open === null) return undefined;
    const tag = open[1]!;
    const rest = html.slice(open.index + open[0].length);
    let depth = 1;
    for (const m of rest.matchAll(new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g'))) {
      depth += m[1] === '/' ? -1 : 1;
      if (depth === 0) return rest.slice(0, m.index);
    }
    return rest;
  }

  it('marks a block in every locale the site has', () => {
    for (const page of errorPages()) {
      expect(langsInMain(build.read(page)), `${page} is not bilingual`).toEqual(
        [...LOCALES].sort(),
      );
    }
  });

  it('offers a heading and an exit inside each locale block', () => {
    for (const page of errorPages()) {
      const html = build.read(page);
      for (const locale of LOCALES) {
        const block = blockWithLang(html, locale);
        expect(block, `${page} has no block for ${locale}`).not.toBeUndefined();
        expect(/<h1\b/.test(block!), `${page}'s ${locale} block has no heading`).toBe(true);
        expect(/<a\b[^>]*href=/.test(block!), `${page}'s ${locale} block has no exit`).toBe(
          true,
        );
      }
    }
  });

  it('links both locale homepages, and nothing that looks like a localised 404', () => {
    for (const page of errorPages()) {
      const reached = crawl(isAnchor)
        .filter((ref) => ref.page === page)
        .map((ref) => addressOf(ref.request));

      for (const locale of LOCALES) {
        expect(
          reached.some((at) => at.locale === locale && at.route === '/'),
          `${page} offers no way out in ${locale}`,
        ).toBe(true);
      }

      // MUSE-13's dead link, which must not come back in either direction. AC1 above
      // already fetches every href; this names the specific URL that cannot exist, so a
      // failure says why rather than just reporting a 404.
      expect(
        reached.filter((at) => at.route === '/404').map((at) => at.locale),
        `${page} links a localised 404, which the host cannot serve`,
      ).toEqual([]);
    }
  });

  it('ships no URL for a page the host cannot serve, not even inside the script', () => {
    // `langInitScript` is handed a URL per locale, and on a page with no twin it must be
    // handed none: a localised error URL baked into an inline script is a navigation
    // waiting for somebody to re-enable `go()` on this page.
    //
    // Matched on the path fragment rather than on the full deploy-base spelling, because
    // the first version of this assertion looked for `/MuseByMina/en/404/` and so missed
    // the string sitting in a *comment* inside the inline script — which does ship, and
    // which a reader greppping the built page would read as the dead link being back.
    for (const locale of LOCALES) {
      for (const page of errorPages()) {
        expect(build.read(page), `${page} names ${locale}/404`).not.toContain(
          `${locale}/404`,
        );
      }
    }
  });
});

/**
 * MUSE-38's second finding — the footer is the only chrome that can say where you are on
 * `/privacy/`, and it said nothing.
 *
 * `/privacy/` and `/en/privacy/` are deliberately out of the nav (`src/lib/nav.ts`): the
 * privacy notice is the footnote the trial form links to, not a destination. So the
 * footer is the only list that contains it — and the footer carried no `aria-current` at
 * all, which left the one page the primary nav cannot mark marked by nothing.
 *
 * The rule is MUSE-39's, as that ticket's own suite states it: whatever carries
 * `aria-current` must either not be a link, or be a link to exactly where we already are.
 * A footer entry pointing at the current page satisfies the second clause, so it stays an
 * `<a>` — unlike the locale switcher's own-locale entry, whose href carried a `?lang=`
 * the current address did not have. `page` rather than `true`, the same as the nav.
 */
describe('the footer says where you are (MUSE-38)', () => {
  interface Marked {
    tag: string;
    href: string | undefined;
    value: string;
  }

  /** Everything inside `<footer>` carrying `aria-current`. */
  function markedInFooter(html: string): Marked[] {
    const footer = /<footer\b[^>]*>([\s\S]*?)<\/footer>/.exec(html);
    expect(footer, 'no <footer> in the built page').not.toBeNull();
    return [...footer![1]!.matchAll(/<(\w+)\b([^>]*\baria-current="([^"]*)"[^>]*)>/g)].map(
      (m) => ({
        tag: m[1]!,
        href: /\bhref="([^"]*)"/.exec(m[2]!)?.[1],
        value: m[3]!,
      }),
    );
  }

  /** The URL path the host serves a built page at. */
  function ownPath(page: string): string {
    return `${basePath(build)}${page.replace(/(^|\/)index\.html$/, '$1')}`;
  }

  /** Every built page that has a URL of its own — the error page is not one. */
  function addressable(): string[] {
    const errors = new Set(errorPages());
    return build.htmlFiles().filter((page) => !errors.has(page));
  }

  /**
   * **Which pages the footer can say „you are here" about, and which it must not** (MUSE-24).
   *
   * The footer is an index of the site's *sections*, and `aria-current` is a claim about
   * one link: MUSE-39's rule is that whatever carries it must either not be a link or be a
   * link to exactly where we already are. So a page the footer lists gets exactly one mark
   * and a page it does not list gets none — marking the „Događaji" entry on
   * `/events/archive/` would be a marked link to somewhere else, which is the lie this whole
   * block exists to prevent.
   *
   * It was „every addressable page" until `/events/archive/` and `/events/<slug>/` arrived,
   * and the partition is derived rather than listed: the footer's routes come off the built
   * markup, and `topLevelRoutes()` below holds them to `ROUTES` so the footer cannot quietly
   * stop listing a section.
   */
  it('lists every section of the site, so the partition below is not a loophole', () => {
    /**
     * The half that keeps the exclusion honest. „A page the footer does not list is not
     * marked" is satisfied by a footer that lists nothing, so what the footer lists is
     * pinned against `ROUTES` — every route that is not a child of another route, which is
     * what a section is. `/events/archive` is a child of `/events` and is therefore not one;
     * `/privacy` is footer-only and is (MUSE-7).
     */
    const listed = [...footerRoutes(build.read('index.html'))].sort();
    expect(listed, 'the footer and ROUTES disagree about the site’s sections').toEqual(
      topLevelRoutes().sort(),
    );
    // And every page of a listed section really is in the build, in both locales.
    expect(listed.length).toBeGreaterThan(4);
  });

  it('marks exactly one footer entry on every page the footer lists', () => {
    const listed = addressable().filter(footerLists);
    expect(listed.length, 'no listed page to check').toBeGreaterThan(4);

    for (const page of listed) {
      const marked = markedInFooter(build.read(page));
      expect(marked.length, `${page}'s footer marks ${marked.length} entries, not 1`).toBe(1);
      expect(marked[0]!.value, `${page} uses aria-current="${marked[0]!.value}"`).toBe('page');
    }
  });

  it('marks nothing on a page below a section, because the entry points elsewhere', () => {
    /**
     * `/events/archive/` is the first page the site serves whose route the footer does not
     * list, and the honest answer there is silence: the „Događaji" entry points at
     * `/events/`, so marking it would announce „you are here" about another page. MUSE-39's
     * rule, applied in the direction that is easy to get wrong by being helpful.
     *
     * The set is asserted non-empty, so this does not become a test about nothing — and it
     * is derived, so `/events/<slug>/` joins it the day an event is published.
     */
    const unlisted = addressable().filter((page) => !footerLists(page));
    expect(unlisted.length, 'no page below a section — this test has no subject').toBeGreaterThan(
      0,
    );

    for (const page of unlisted) {
      expect(markedInFooter(build.read(page)), `${page} marks a footer entry`).toEqual([]);
    }
  });

  it('marks the entry that points at the page it is on', () => {
    // The thing `aria-current` asserts, and the only way to get it wrong quietly: a
    // marked link to somewhere else reads as "you are here" about another page.
    for (const page of addressable().filter(footerLists)) {
      const marked = markedInFooter(build.read(page))[0]!;
      if (marked.href === undefined) continue;
      expect(marked.href, `${page}'s footer marks a link to somewhere else`).toBe(
        ownPath(page),
      );
    }
  });

  it('marks the privacy notice on the one page the nav cannot reach', () => {
    // The ticket's finding, named. `/privacy/` is in no menu by design, so if the footer
    // does not mark it nothing does.
    const privacy = addressable().filter((page) => /(?:^|\/)privacy\/index\.html$/.test(page));
    expect(privacy.length, 'the build has no privacy page in either locale').toBe(
      LOCALES.length,
    );
    for (const page of privacy) {
      expect(markedInFooter(build.read(page))[0]!.href).toBe(ownPath(page));
    }
  });

  it('marks nothing in the footer of a page the footer does not list', () => {
    // The error page's route is in no list, so there is nothing to mark — and marking
    // something anyway would be the same lie in the other direction.
    for (const page of errorPages()) {
      expect(markedInFooter(build.read(page))).toEqual([]);
    }
  });
});

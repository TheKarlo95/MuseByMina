import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateDocument } from '@sanity/validation';
import { createSchema } from 'sanity';
import { beforeAll, describe, expect, it } from 'vitest';

import { schemaTypes } from '../sanity/schemaTypes';
import { ROUTE_VALUES } from '../sanity/schemaTypes/enums';
import {
  INERT_ROUTE_WARNING,
  ROUTES,
  inertRouteDocuments,
  inertRouteWarning,
} from '../src/lib/pages';
import { PREVIEW_ROUTES, previewPatterns } from '../src/lib/preview';
import { FIXTURE_ENV } from '../src/lib/sanity/fixture';
import { PAGES_DEPLOY, buildSite, type Build } from './helpers/build';
import { seedDocs, type SeedDoc } from './helpers/seed';
import { fixtureOf } from './helpers/structural-content';

/**
 * **MUSE-46 — the route list, the pages the build serves, and the `page` documents.**
 *
 * Three things have to agree about which pages this site has, and the disagreements are
 * not symmetrical:
 *
 *   | disagreement                              | before | now |
 *   | ----------------------------------------- | ------ | --- |
 *   | route in `ROUTES`, no `page` document     | build fails naming the route | unchanged |
 *   | route in `ROUTES`, no file in `src/pages/`| silent; `llms.txt` publishes a 404 | this suite, naming the route |
 *   | file in `src/pages/`, no route            | caught indirectly by `seo.test.ts` | this suite, naming the page |
 *   | `page` document for an unserved route     | silent and inert | Studio refuses it; build warns naming it |
 *
 * Everything here is anchored on `src/pages/`, which is the only one of the three that
 * cannot lie about what exists: `ROUTES` is a hand-written list and a `page` document is
 * a row in a database, but a file either compiles into a page or it does not. The same
 * reason `test/seo.test.ts` has always read its page list off the filesystem.
 *
 * The strength of each report is argued at `inertRouteWarning` in `src/lib/pages.ts`.
 * The short version: the Studio refuses the route while Mina is typing, because that is
 * the only instrument that reaches the person who can fix it; the build *warns* rather
 * than fails, because an inert document publishes nothing wrongly and a failed build
 * would let a stale CMS row stop every unrelated pull request and MUSE-21's scheduled
 * rebuild.
 */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PAGES_DIR = join(ROOT, 'src/pages');

/**
 * Routes that are built and deliberately not indexed, keyed without a locale prefix.
 *
 * The same exclusion `test/seo.test.ts` makes, for the same reason and spelled the same
 * way: `/404` is a page the build emits and `@astrojs/sitemap` is right to leave out, so
 * it is not a hole in `ROUTES` either.
 */
const NOT_A_ROUTE = new Set(['/404']);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

/**
 * Every route the build serves, locale prefix stripped, duplicates collapsed.
 *
 * `src/pages/schedule.astro` and `src/pages/en/schedule.astro` are one *route* — HR and
 * EN share slugs (CLAUDE.md), and `ROUTES` has one entry per route rather than per page.
 */
function routesUnderSrcPages(): string[] {
  const keys = walk(PAGES_DIR)
    .filter((file) => file.endsWith('.astro'))
    .map((file) => '/' + relative(PAGES_DIR, file).replace(/\.astro$/, '').replace(/\\/g, '/'))
    .map((route) => (route.endsWith('/index') ? route.slice(0, -'/index'.length) || '/' : route))
    .map((route) => (route === '/en' || route.startsWith('/en/') ? route.slice(3) || '/' : route))
    .filter((route) => !NOT_A_ROUTE.has(route));

  return [...new Set(keys)].sort();
}

/** Both locale files a route needs, as repo-relative paths — `/` → `index.astro`. */
function pageFilesFor(route: string): string[] {
  const slug = route === '/' ? 'index' : route.replace(/^\//, '');
  return [`src/pages/${slug}.astro`, `src/pages/en/${slug}.astro`];
}

function exists(repoRelative: string): boolean {
  try {
    return statSync(join(ROOT, repoRelative)).isFile();
  } catch {
    return false;
  }
}

/* ------------------------------------------------- ROUTES against the filesystem */

describe('`ROUTES` and `src/pages/` describe the same site', () => {
  it('found pages to check at all', () => {
    // The positive control. "No disagreements" is true of an empty walk, and this file's
    // whole subject is a guard that reads as covering more than it reaches (MUSE-37,
    // MUSE-42). Four routes today; the floor is deliberately not four, because adding
    // the twelve service pages of MUSE-22–MUSE-28 must not edit this line.
    expect(routesUnderSrcPages().length).toBeGreaterThan(1);
    expect(routesUnderSrcPages()).toContain('/');
  });

  /**
   * **The acceptance criterion: a route in `ROUTES` with no page file fails, naming it.**
   *
   * This is where MUSE-13's defect still lived. `nav.ts` got its dead-link guard; the
   * page registry did not, and `llms.txt` is generated from the registry — so an entry
   * added here while its page was still a branch published a link, for machines, to a
   * URL that 404s. `test/seo.test.ts` compares `llms.txt` against the built pages and so
   * fails too; it fails against `dist`, which is the stronger statement and the slower
   * one. This fails off the filesystem in milliseconds and names the file to create.
   */
  it('gives every route in ROUTES a page file in both locales', () => {
    const missing = ROUTES.flatMap(({ route }) =>
      pageFilesFor(route)
        .filter((file) => !exists(file))
        .map((file) => `${route} → ${file}`),
    );

    expect(
      missing,
      `ROUTES (src/lib/pages.ts) declares ${missing.length} route/locale pair(s) with no ` +
        `file behind them. A declared route with nothing to serve publishes a dead link in ` +
        `llms.txt and a dead entry in the nav — the same defect as MUSE-13's 24 dead ` +
        `navigation links, one list further along.`,
    ).toEqual([]);
  });

  it('declares every page the build serves as a route', () => {
    const declared = new Set(ROUTES.map(({ route }) => route));
    const undeclared = routesUnderSrcPages().filter((route) => !declared.has(route));

    expect(
      undeclared,
      `${undeclared.length} page(s) under src/pages/ are not in ROUTES. The page builds ` +
        `and is reachable, and it gets no <title> from Sanity, no llms.txt line and no ` +
        `place in the nav — add it to ROUTES and create its \`page\` document in the Studio. ` +
        `If it is deliberately unindexed, it belongs in NOT_A_ROUTE here and in ` +
        `test/seo.test.ts, with a reason.`,
    ).toEqual([]);
  });

  /**
   * A preview route is neither a ghost nor a missing page (MUSE-23).
   *
   * `MUSE_PREVIEW_ROUTES=aboutus npm run build` injects `/aboutus-preview` so a component
   * whose content does not exist yet can still be asserted on against `dist`. Its entry
   * point lives under `test/`, which is **not** the tree the walk above reads, and its URL
   * carries a `-preview` suffix that no `ROUTES` entry has — so it cannot read as a page
   * that forgot its route, and `/aboutus` cannot read as a route that forgot its page.
   * Both halves are asserted, because the first is what the two tests above depend on and
   * the second is what makes the warning below able to fire for `/aboutus` at all.
   */
  it('counts a preview route as neither a page nor a route', () => {
    const declared = new Set(ROUTES.map(({ route }) => route));
    const served = new Set(routesUnderSrcPages());

    for (const [name, entry] of Object.entries(PREVIEW_ROUTES)) {
      expect(entry.startsWith('./test/'), `${name} is injected from ${entry}`).toBe(true);
      expect(served.has(`/${name}`), `${name} has a real page now — delete its preview`)
        .toBe(false);
      expect(declared.has(`/${name}`), `${name} is routed now — delete its preview`)
        .toBe(false);
      for (const pattern of previewPatterns(name)) {
        expect(declared.has(pattern.replace(/^\/en/, '') || '/')).toBe(false);
      }
    }
  });
});

/* ------------------------------------------- an inert `page` document, as a function */

/** A `page` document in the shape the read path hands over, for the pure checks. */
function doc(id: string, route: string, nameHr = 'Neka stranica'): {
  id: string;
  route: string;
  name: { hr: string };
} {
  return { id, route, name: { hr: nameHr } };
}

describe('an inert `page` document is recognised', () => {
  it('says nothing about documents for routes the site serves', () => {
    const served = ROUTES.map(({ route }, i) => doc(`page-${i}`, route));

    expect(inertRouteDocuments(served)).toEqual([]);
    expect(inertRouteWarning(served)).toBeUndefined();
  });

  it('finds a document whose route is not served, and names it', () => {
    const documents = [...ROUTES.map(({ route }, i) => doc(`page-${i}`, route)),
      doc('page-aboutus', '/aboutus', 'O nama')];

    expect(inertRouteDocuments(documents).map((d) => d.id)).toEqual(['page-aboutus']);

    const warning = inertRouteWarning(documents);
    expect(warning).toContain(INERT_ROUTE_WARNING);
    expect(warning).toContain('page-aboutus');
    expect(warning).toContain('/aboutus');
    // The remedy, both ways round, and the list to compare against. A warning that only
    // states the problem is one the reader has to go and research.
    expect(warning).toContain('src/pages/');
    expect(warning).toContain('ROUTES');
    for (const { route } of ROUTES) expect(warning).toContain(route);
  });

  it('is case- and shape-sensitive rather than fuzzy about a route', () => {
    // `/Schedule`, `/schedule/` and `schedule` are all routes this site does not serve.
    // A check that normalised them would call a typo'd document valid and leave the page
    // it was meant to describe with no document at all — which *is* a build failure, so
    // the two reports would then contradict each other.
    for (const route of ['/Schedule', '/schedule/', 'schedule', '/schedule?x=1']) {
      expect(inertRouteDocuments([doc('page-typo', route)]), route).toHaveLength(1);
    }
  });
});

/* ------------------------------------------- an inert `page` document, in a real build */

const GHOST = {
  _id: 'page-ghost-aboutus',
  _type: 'page',
  route: '/aboutus',
  name: { _type: 'localeString', hr: 'O nama', en: 'About us' },
  title: { _type: 'localeString', hr: 'O nama — Muse by Mina', en: 'About us — Muse by Mina' },
  description: {
    _type: 'localeString',
    hr: 'Opis stranice koja ne postoji, upisan u Studiju.',
    en: 'A description of a page that does not exist, written in the Studio.',
  },
} satisfies SeedDoc;

let clean: Build;
let ghosted: Build;

beforeAll(() => {
  clean = buildSite(PAGES_DEPLOY);
  // The ticket's own reproduction: the committed seed plus one document describing
  // `/aboutus`, which MUSE-23 built and deliberately did not route.
  ghosted = buildSite(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf([...seedDocs(), GHOST], 'routes'),
  });
}, 240_000);

describe('a `page` document for a route the site does not serve', () => {
  it('makes the build say so, naming the document and the route', () => {
    expect(ghosted.log).toContain(INERT_ROUTE_WARNING);
    expect(ghosted.log).toContain(GHOST._id);
    expect(ghosted.log).toContain(GHOST.route);
    expect(ghosted.log).toContain(GHOST.name.hr);
  });

  it('says nothing of the kind on a build whose documents all describe real routes', () => {
    // The false-positive half, and the one that makes the assertion above mean something:
    // a warning that fires on every build is a warning nobody reads twice. The current
    // site is the case that must stay quiet.
    expect(clean.log).not.toContain(INERT_ROUTE_WARNING);
    expect(clean.log).not.toContain('MUSE-46');
  });

  /**
   * And it is a **warning**: the build succeeds and publishes exactly the same site.
   *
   * The reason this is asserted rather than left implicit is that it is the half of the
   * judgement that can be undone by accident. Someone tightening `inertRouteWarning`
   * into a `throw` would be handing every stale document in the Studio the power to stop
   * every pull request, every deploy and the scheduled rebuild — a one-word change with
   * an availability consequence, and nothing but this test between them.
   */
  it('still builds the same site, byte for byte, warning or not', () => {
    expect(ghosted.htmlFiles()).toEqual(clean.htmlFiles());
    for (const file of clean.htmlFiles()) {
      expect(ghosted.read(file), file).toBe(clean.read(file));
    }
    expect(ghosted.read('llms.txt')).toBe(clean.read('llms.txt'));
    expect(ghosted.read('sitemap-index.xml')).toBe(clean.read('sitemap-index.xml'));
  });

  it('keeps the document out of llms.txt and the sitemap entirely', () => {
    // Stated separately from the equality above, because that one would also pass if both
    // builds published the ghost. This is the "inert" claim itself, and it is the premise
    // the whole severity decision rests on.
    for (const file of ['llms.txt', 'sitemap-index.xml']) {
      expect(ghosted.read(file), file).not.toContain(GHOST.route);
      expect(ghosted.read(file), file).not.toContain(GHOST.description.hr);
    }
  });
});

/* ------------------------------------------------------ the Studio refuses the route */

/**
 * `page.route`, run through Sanity's **real** validator (MUSE-46).
 *
 * `test/sanity.test.ts` notes that `validation` is a function and so cannot be inspected
 * without calling it, and inspects `options.list` instead. That is the gap this ticket was
 * filed into: `options.list` is the dropdown, and the ticket's premise was that nothing
 * validated the stored value. Running the validator is what settles it — and it settled it
 * the other way, which no amount of reading the schema would have. Sanity infers a
 * `valid()` rule from a `list`, so a pasted route was already refused; what was missing
 * was the declaration, a message that says what is wrong, and anything at all asserting
 * either. A hand-rolled `Rule` stub would prove we wrote `.valid(...)` and nothing about
 * whether Sanity enforces it, which is the question.
 *
 * `@sanity/validation` is a declared devDependency for this, pinned to the exact version
 * `sanity` itself pins — the same reason `styled-components` is declared: it is installed
 * regardless, and a check that depends on a transitive package without saying so is a
 * check that breaks on an unrelated upgrade. `sanity`'s own re-export is the *workspace*
 * variant and needs a configured Studio, which is not a thing a test should construct.
 */
const schema = createSchema({ name: 'muse', types: schemaTypes as never });

function pageDocument(route: unknown): Record<string, unknown> {
  return {
    _id: 'page-under-test',
    _type: 'page',
    _createdAt: '2026-01-01T00:00:00Z',
    _updatedAt: '2026-01-01T00:00:00Z',
    _rev: 'rev',
    route,
    name: { _type: 'localeString', hr: 'Naziv', en: 'Name' },
    title: { _type: 'localeString', hr: 'Naslov', en: 'Title' },
    description: { _type: 'localeString', hr: 'Opis stranice.', en: 'Page description.' },
  };
}

async function routeErrors(route: unknown): Promise<string[]> {
  const { markers } = await validateDocument({
    document: pageDocument(route) as never,
    schema: schema as never,
  });
  return markers
    .filter((marker) => marker.level === 'error' && marker.path.join('.') === 'route')
    .map((marker) => `${marker.code}: ${marker.message}`);
}

describe('the Studio refuses a route the site does not serve', () => {
  it('offers exactly the routes the site serves', () => {
    expect([...ROUTE_VALUES]).toEqual(ROUTES.map(({ route }) => route));
  });

  it('accepts every route in ROUTES', async () => {
    // The positive control. Without it, "a route outside the list is refused" is also
    // satisfied by a rule that refuses everything — which would be a Studio in which no
    // `page` document can be published at all.
    for (const { route } of ROUTES) {
      expect(await routeErrors(route), route).toEqual([]);
    }
  });

  it('refuses a route the site does not serve, however it got there', async () => {
    // `/aboutus` is the ticket's case — a page that is built and not routed. The others
    // are what a paste produces: a full URL, a trailing slash, a locale prefix.
    //
    // `/pricing` was in this list and MUSE-59 routed it, so it moved to the positive
    // control above — which is the list this one is derived against, and the reason that
    // control exists. A route graduating from "refused" to "accepted" is what shipping a
    // page looks like from here; the remaining four can never graduate, because three of
    // them are spellings no `ROUTES` entry may have and `/aboutus` is MUSE-23's
    // deliberately unrouted component.
    for (const route of [
      '/aboutus',
      'https://example.test/schedule',
      '/schedule/',
      '/en/schedule',
    ]) {
      const errors = await routeErrors(route);
      expect(errors.length, `${route} was accepted`).toBeGreaterThan(0);
      expect(errors.join(' '), route).toContain('value.not-allowed');
    }
  });

  it('tells Mina what is actually wrong, not that the field is empty', async () => {
    // The part that was genuinely missing, and the reason the declared rule earns its
    // place beside the inferred one: the inferred rule reports under the *required*
    // rule's message — „Odaberi stranicu.", written for an absent value — for a value
    // that is present and wrong, which sends the reader to look at a field they have
    // already filled in. Asserted over the whole marker set rather than the first one,
    // because Sanity reports the inferred rule and the declared rule both and the order
    // between them is its business, not ours.
    const wrong = (await routeErrors('/aboutus')).join(' | ');
    expect(wrong).toContain('nije među stranicama');
    expect(wrong).toContain('ne prikazuje se nigdje');

    const empty = (await routeErrors(undefined)).join(' | ');
    expect(empty).toContain('value.required');
    expect(empty).toContain('Odaberi stranicu.');
  });
});

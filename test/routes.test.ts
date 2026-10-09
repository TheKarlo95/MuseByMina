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
 * Entries under `src/pages/` that are not a route of their own, keyed without a locale
 * prefix.
 *
 * Two different reasons, and keeping them apart matters because only one of them is about
 * indexing. The same two exclusions `test/seo.test.ts` makes, spelled the same way.
 *
 *   - **`/404`** is a page the build emits and `@astrojs/sitemap` is right to leave out,
 *     so it is not a hole in `ROUTES` either.
 *   - **`/events/[slug]` and `/blog/[slug]`** are not pages at all — they are **templates**
 *     (MUSE-24, MUSE-26). The pages each produces are one per `event` or `post` document,
 *     so which pages exist is content rather than structure: `ROUTES` could not list them,
 *     the Studio's route dropdown could not offer them, and there is no `page` document per
 *     event or per post (the `<title>` is derived — see `src/pages/events/[slug].astro` and
 *     `src/pages/blog/[slug].astro`). Their *indexes* — and `/events/archive` — are ordinary
 *     routes and are in `ROUTES`; these are the only entries under `src/pages/` whose route
 *     key carries a parameter, and the assertion below pins that they are.
 */
const NOT_A_ROUTE = new Set(['/404', '/events/[slug]', '/blog/[slug]']);

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
/** The same walk as `routesUnderSrcPages`, before `NOT_A_ROUTE` is applied. */
function routesUnderSrcPagesRaw(): string[] {
  const keys = walk(PAGES_DIR)
    .filter((file) => file.endsWith('.astro'))
    .map((file) => '/' + relative(PAGES_DIR, file).replace(/\.astro$/, '').replace(/\\/g, '/'))
    .map((route) => (route.endsWith('/index') ? route.slice(0, -'/index'.length) || '/' : route))
    .map((route) => (route === '/en' || route.startsWith('/en/') ? route.slice(3) || '/' : route));

  return [...new Set(keys)].sort();
}

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

  /**
   * A dynamic template is excluded because it is a template, and that is checked rather
   * than asserted in a comment (MUSE-24, MUSE-26).
   *
   * The exclusion is the one that could rot into a blanket: `/404` is a fixed filename and
   * a `[slug]` entry is a *shape*, so the thing to pin is that every excluded entry which
   * is not `/404` really does carry a parameter, and that the parameterised entries on disk
   * are exactly the ones excluded. A new `[id].astro` added without an entry here fails
   * `declares every page the build serves as a route` below; one added *with* an entry but
   * no file fails this.
   */
  it('excludes a dynamic template, and only where the filename really is one', () => {
    const parameterised = routesUnderSrcPagesRaw().filter((route) => /\[[^\]]+\]/.test(route));
    expect(parameterised, 'no dynamic template on disk to exclude').not.toEqual([]);
    expect(parameterised).toContain('/events/[slug]');
    expect(parameterised).toContain('/blog/[slug]');

    const excludedTemplates = [...NOT_A_ROUTE].filter((route) => /\[[^\]]+\]/.test(route));
    expect(excludedTemplates.sort()).toEqual(parameterised.sort());

    // And each template's own index is a real route, so excluding the template does not
    // quietly excuse the pages around it.
    const declared = ROUTES.map(({ route }) => route);
    expect(declared).toContain('/events');
    expect(declared).toContain('/events/archive');
    expect(declared).toContain('/blog');
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
   * A preview route is neither a ghost nor a missing page (MUSE-23), and an entry whose
   * page has shipped is neither (MUSE-60).
   *
   * `MUSE_PREVIEW_ROUTES=aboutus npm run build` used to inject `/aboutus-preview` so a
   * component whose content did not exist yet could still be asserted on against `dist`.
   * Its entry point lived under `test/`, which is **not** the tree the walk above reads,
   * and its URL carried a `-preview` suffix that no `ROUTES` entry has — so it could not
   * read as a page that forgot its route, and `/aboutus` could not read as a route that
   * forgot its page.
   *
   * The registry is **empty** now: MUSE-60 routed `/aboutus` and deleted the entry, which
   * is what `src/lib/preview.ts` says has to happen. So the loop below has nothing to
   * iterate, and the assertion that carries the weight is the one after it — a name in the
   * registry must *not* be a page or a route, which is the check that would have caught the
   * entry outliving its ticket. The first two are kept for the next page ticket whose
   * content is not ready; `test/aboutus.test.ts` is where the retirement itself is asserted
   * and where the non-vacuous half of the preview guard now lives.
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

  it('serves no -preview URL, with the registry empty and the variable unset', () => {
    // Read off the build rather than off the registry, which is the claim that survives
    // the registry being empty: `/aboutus-preview` was a real URL in a real output tree
    // for the length of MUSE-23, and it is gone.
    expect(clean.htmlFiles().filter((file) => file.includes('-preview'))).toEqual([]);
    expect(Object.keys(PREVIEW_ROUTES)).toEqual([]);
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
    // `/etiquette` is one of MUSE-13's twelve: a route the finished information
    // architecture names and this site does not serve. It replaced `/gallery` here when
    // MUSE-25 routed that page, which had replaced `/aboutus` when MUSE-60 routed that one
    // — an inert-document fixture has to name a route `ROUTES` really does not have, or
    // the test asserts the opposite of what it says. Every page ticket moves this fixture
    // along by one; the thing to keep is that it is never a route in `ROUTES`.
    const documents = [...ROUTES.map(({ route }, i) => doc(`page-${i}`, route)),
      doc('page-etiquette', '/etiquette', 'Etiketa')];

    expect(inertRouteDocuments(documents).map((d) => d.id)).toEqual(['page-etiquette']);

    const warning = inertRouteWarning(documents);
    expect(warning).toContain(INERT_ROUTE_WARNING);
    expect(warning).toContain('page-etiquette');
    expect(warning).toContain('/etiquette');
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
  _id: 'page-ghost-etiquette',
  _type: 'page',
  route: '/etiquette',
  name: { _type: 'localeString', hr: 'Etiketa', en: 'Etiquette' },
  title: { _type: 'localeString', hr: 'Etiketa — Muse by Mina', en: 'Etiquette — Muse by Mina' },
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
  // The ticket's own reproduction: the committed seed plus one document describing a
  // route this site does not serve. `/aboutus` until MUSE-60, `/gallery` until MUSE-25;
  // `/etiquette` is one of MUSE-13's twelve and has no component, let alone a page.
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
    // `/etiquette` is MUSE-13's case — a route the finished information architecture names
    // and this site does not serve. The others are what a paste produces: a full URL, a
    // trailing slash, a locale prefix.
    //
    // `/pricing` was in this list and MUSE-59 routed it; `/aboutus` was in it and MUSE-60
    // routed it; `/gallery` was in it and MUSE-25 routed it. All three moved to the
    // positive control above — which is the list this one is derived against, and the
    // reason that control exists. A route graduating from "refused" to "accepted" is what
    // shipping a page looks like from here, and this list is now down to one real route
    // plus three spellings no `ROUTES` entry may have.
    for (const route of [
      '/etiquette',
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
    const wrong = (await routeErrors('/etiquette')).join(' | ');
    expect(wrong).toContain('nije među stranicama');
    expect(wrong).toContain('ne prikazuje se nigdje');

    const empty = (await routeErrors(undefined)).join(' | ');
    expect(empty).toContain('value.required');
    expect(empty).toContain('Odaberi stranicu.');
  });
});

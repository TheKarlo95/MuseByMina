import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LOCALES, localeUrl, type Locale } from '../src/lib/i18n';
import { INERT_ROUTE_WARNING, ROUTES } from '../src/lib/pages';
import { getSiteSettings } from '../src/lib/sanity';
import { inDevServer } from '../src/lib/sanity/dev';
import { FIXTURE_ENV } from '../src/lib/sanity/fixture';
import { buildFailure, buildSite, PAGES_DEPLOY, type Build } from './helpers/build';
import { fetchMeasuredPage } from './helpers/measured';
import { astroDev, claimOutDir, type DevServer } from './helpers/scratch';
import { seedDocs, type SeedDoc } from './helpers/seed';

/**
 * MUSE-47 — the dev server's content, and whether it can be had without a network.
 *
 * Two defects, both invisible in `dist` and therefore invisible to every other suite
 * here, and they come from the same sentence being true of one environment and read as
 * true of the module: *"each reader is memoised for the life of the build."*
 *
 * ## What was actually observed, before anything was changed
 *
 * The ticket reasoned the first one from the code and asked for it to be demonstrated
 * first. It reproduces, and it is **worse than partially stale — it is partially fresh**.
 * Three reloads of `/schedule/` against the live dataset, with `runQuery` instrumented to
 * print each query:
 *
 *     PAGES_QUERY          1 ×      ← memoised: frozen for the session
 *     SITE_SETTINGS_QUERY  1 ×      ← memoised: frozen for the session
 *     SCHEDULE_QUERY       3 ×      ← not memoised: current on every reload
 *
 * So the timetable followed the Studio and the page's `<title>`, the footer address, the
 * `mailto:` and the JSON-LD did not. Content that updates in part is not read as a cache;
 * it is read as "my change didn't save". And pointed at a fixture instead it was worse
 * still — `fixture.ts` parses the NDJSON once per process too, so **nothing** moved,
 * including the readers that do re-query.
 *
 * ## What this suite holds
 *
 * The fix is that the two caches are per-*build*, and `src/lib/sanity/dev.ts` is the one
 * gate. That gate decides whether content may be re-read, which makes it adjacent to the
 * four barriers MUSE-20 built to stop a deploy ever reading a fixture — so the claims
 * below come in pairs, one for each environment, and the pairing is the point:
 *
 *   - a dev server re-reads (an edit under a running server appears) **and** a build
 *     memoises (one query per reader, the promise shared by identity);
 *   - a dev server says which regime it is in **and** so does a build, in its log, where
 *     the question is actually asked;
 *   - a dev server names the offline command when the API cannot be reached **and** a
 *     build does not, because the remedy in a deploy log is to wait for Sanity;
 *   - the gate cannot be flipped from the environment — `NODE_ENV=development` does not
 *     buy a build the dev regime, which is the whole reason it is `import.meta.hot` and
 *     not a variable.
 *
 * ## Why it drives a real `astro dev`
 *
 * For the reason `test/fonts.test.ts` does (MUSE-35): a suite that can only see `dist`
 * cannot see a dev-only bug, and this is a pair of dev-only bugs. `astroDev` in
 * `test/helpers/scratch.ts` is the only thing in `test/` that may start one — it passes
 * `--ignore-lock` so the server stays in the foreground where it can be killed, and
 * strips `VITEST` from the child environment, without which Astro's dev-server plugin
 * returns early and every route answers `Cannot GET`.
 *
 * ## Why the in-process assertions are the *build* regime
 *
 * `import.meta.hot` is `undefined` under `vitest run` — measured, and asserted below — so
 * a reader called directly from a test memoises exactly as it does in a build. That is
 * the regime the existing suite already assumes: `test/projections.test.ts` relies on
 * `getSiteSettings` answering a second fixture from the first one's dataset and says so.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A project id that cannot answer, so the live arm of `runQuery` is really taken. */
const UNREACHABLE = { SANITY_PROJECT_ID: 'muse47nosuchproject', SANITY_DATASET: 'nosuchdataset' };

/**
 * Where the suite's own content comes from, as `vitest.config.ts` set it.
 *
 * Read off the environment rather than spelled out: that file is the single place the
 * seed is named, and naming it again here would be a second copy to keep in step on the
 * day the file moves.
 */
const SUITE_FIXTURE = process.env[FIXTURE_ENV];

/** Every page the site serves, both locales. */
const PAGES = LOCALES.flatMap((locale) => ROUTES.map(({ route }) => ({ route, locale })));

/**
 * The URL a route lives at on a running dev server.
 *
 * Two facts, from the two places that own them, and **nothing in this file recomputes
 * either**. `localeUrl` decides the locale prefix and the trailing slash (MUSE-9);
 * `DevServer.url` decides the base, which it now takes from `astro.config.mjs` rather
 * than from the server's greeting — MUSE-47's CI failure was the greeting being parsed
 * for it.
 *
 * The join works because **`import.meta.env.BASE_URL` is `/` inside a vitest run**, so
 * `localeUrl` here answers a base-*relative* path: `/en/schedule/`, not
 * `/MuseByMina/en/schedule/`. That is worth knowing before writing anything that joins
 * these two together — the first version of this file assumed the opposite, sliced a base
 * off `localeUrl`'s answer, and only worked because the slice was a no-op.
 */
function pageUrl(server: DevServer, route: string, locale: Locale): string {
  return server.url(localeUrl(route, locale));
}

/** Two documents for routes the site does not serve, one after the other. */
const GHOST_A = 'page-devcontent-ghost-a';
const GHOST_B = 'page-devcontent-ghost-b';

/** One edit per surface the reproduction measured, so a partial fix cannot pass. */
const EDITED_TITLE = 'IZMIJENJEN NASLOV';
const EDITED_TEACHER = 'MinaIZMIJENJENA';
const EDITED_EMAIL = 'izmijenjeno@example.invalid';

function edited(docs: SeedDoc[]): SeedDoc[] {
  return docs.map((doc) => {
    // A `page` document's title: behind `pagesByRoute`, which memoises.
    if (doc._id === 'page-schedule') {
      return { ...doc, title: { _type: 'localeString', hr: EDITED_TITLE, en: EDITED_TITLE } };
    }
    // An instructor's name: behind `getSchedule`, which does not — so this one was
    // already current against the live dataset and stale only behind the fixture's own
    // per-process parse. Both halves have to move or only half the bug is fixed.
    if (doc._id === 'instructor-mina') return { ...doc, name: EDITED_TEACHER };
    // The singleton: behind `getSiteSettings`, the reader `Footer.astro` calls on every
    // page and the one the ticket's "the CMS is broken" reading comes from.
    if (doc._id === 'siteSettings') return { ...doc, email: EDITED_EMAIL };
    return doc;
  });
}

function ndjson(docs: SeedDoc[]): string {
  return docs.map((doc) => JSON.stringify(doc)).join('\n') + '\n';
}

/** A fixture file this suite owns and is free to rewrite while a server reads it. */
let mutable: string;

let offline: DevServer;
let unreachable: DevServer;
let before: string;
let after: string;
let buildLog: string;
let devEnvBuild: Build;
let inertDev: DevServer;
let inertReloads: number;

beforeAll(async () => {
  // `claimOutDir` mints the directory, so nothing names a build path and nothing is
  // deleted (MUSE-17, MUSE-34). The file is written twice at the same path on purpose:
  // "a Studio edit" is, to this read path, the rows coming back different.
  mutable = join(claimOutDir('devcontent'), 'content.ndjson');
  writeFileSync(mutable, ndjson(seedDocs()));

  // Sequential rather than `Promise.all`, so a failure cannot leave a dev server with no
  // handle for `afterAll` to stop — the reasoning in `test/fonts.test.ts`'s `beforeAll`.
  //
  // **Pointed at a project that does not exist, and that is the offline assertion.** A
  // fixture-backed server that could still reach Sanity would prove nothing about
  // developing on a train; this one has nowhere to fall back to, so every page it serves
  // was rendered from a file in the repository.
  offline = await astroDev({ ...UNREACHABLE, [FIXTURE_ENV]: mutable }, 'devcontent-offline');

  before = await text(offline, '/schedule', 'hr');
  writeFileSync(mutable, ndjson(edited(seedDocs())));
  after = await text(offline, '/schedule', 'hr');

  // The live arm, with nothing to answer it: what `npm run dev` does on a train today.
  //
  // `pagesRender: false` because this is the one dev server in the repository whose pages
  // are *expected* not to render — the 500 below is its assertion — so `astroDev`'s own
  // probe, which proves a handed-out URL names a real page (MUSE-62), has nothing to prove
  // here and would fail the suite that wants the failure.
  unreachable = await astroDev({ ...UNREACHABLE, [FIXTURE_ENV]: '' }, 'devcontent-live', {
    pagesRender: false,
  });
  const failed = await fetch(pageUrl(unreachable, '/schedule', 'hr'));
  expect(failed.status).toBe(500);

  // A build that takes the same live arm and fails on it. Its log is the only place the
  // build-side half of the announce line and the *absence* of the dev-only hint can be
  // read, because `astroBuild` keeps a successful build's stdout nowhere.
  buildLog = buildFailure(PAGES_DEPLOY, { ...UNREACHABLE, [FIXTURE_ENV]: '' });

  // And one real, succeeding build with `NODE_ENV=development`, to ask whether the
  // environment can buy a *deploy* the dev regime. It reads the seed, so no network is
  // involved: the question is about the gate, not about the API. A build that succeeds
  // rather than one contrived to fail, because the thing under test is what a deploy
  // prints, and `Build.log` (MUSE-46) is how that is now readable.
  devEnvBuild = buildSite(PAGES_DEPLOY, { NODE_ENV: 'development' });

  /**
   * A dev server whose dataset holds a `page` document for a route the site does not
   * serve — MUSE-46's warning, under MUSE-47's per-request reader.
   *
   * Reloaded several times on purpose, and then the inert document is **swapped for a
   * different one** and reloaded again. `inertRouteWarning` is called from inside
   * `pagesByRoute`, which used to run once per process, so "warn when it happens" and
   * "warn once" were one sentence; they are two now. Both halves of what replaced them
   * have to be exercised, or the weaker version passes: de-duplicating on "have I ever
   * warned" rather than on the message satisfies the repeat count and goes silent about
   * the second document, which is the failure that matters.
   */
  const ghostOf = (id: string, route: string): SeedDoc => ({
    ...seedDocs().find((doc) => doc._id === 'page-schedule')!,
    _id: id,
    route,
  });
  const inertFixture = join(claimOutDir('devcontent-inert'), 'content.ndjson');
  writeFileSync(inertFixture, ndjson([...seedDocs(), ghostOf(GHOST_A, '/nosuchroute')]));
  inertDev = await astroDev(
    { ...UNREACHABLE, [FIXTURE_ENV]: inertFixture },
    'devcontent-inert',
  );
  inertReloads = 3;
  for (let i = 0; i < inertReloads; i += 1) await text(inertDev, '/schedule', 'hr');

  writeFileSync(inertFixture, ndjson([...seedDocs(), ghostOf(GHOST_B, '/alsonosuchroute')]));
  for (let i = 0; i < inertReloads; i += 1) await text(inertDev, '/schedule', 'hr');
}, 300_000);

afterAll(async () => {
  // A leaked `astro dev` holds a Vite watcher on this checkout until the machine reboots.
  await Promise.allSettled([offline?.stop(), unreachable?.stop(), inertDev?.stop()]);
});

/** How many times `needle` appears in `haystack`. */
function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Fetch one page from a dev server, and prove it is the page that was asked for.
 *
 * The status check is the obvious half. The canonical check is the half MUSE-48 is about,
 * and this file needed it: `renders every page from the committed seed` asserts that each
 * of eight URLs contains „Muse by Mina", which **every** page of this site contains — so a
 * URL builder that quietly answered with the homepage eight times would have gone green.
 * One assertion per fetch, derived from the page's own markup rather than from the URL the
 * helper was asked for, is the only thing that can tell those two apart.
 *
 * `<link rel="canonical">` is the right needle because it comes from `localeUrl` and
 * `Astro.site` inside the page itself (MUSE-9), so it names where the page believes it
 * lives, independently of how it was reached.
 *
 * The comparison itself is **not written here any more**: `fetchMeasuredPage`
 * (`test/helpers/measured.ts`) owns it, because `test/fonts.test.ts` needed the same claim
 * and a second copy is a second place it can be weakened (MUSE-62). It compares against
 * the path that was *requested* rather than against `localeUrl`'s answer, which is the
 * comparison that means something — the page saying which page it is — and is why the
 * test process's own base being `/` does not matter.
 */
async function text(server: DevServer, route: string, locale: Locale): Promise<string> {
  const requested = pageUrl(server, route, locale);
  const { html } = await fetchMeasuredPage(
    requested,
    `astro dev\n--- astro dev output ---\n${server.output()}`,
  );
  return html;
}

/* ------------------------------------------------- 1. a dev server re-reads content */

describe('a content edit shows up in a running dev server', () => {
  it('serves the content the file held when the page was asked for, not at startup', () => {
    // The reproduction, as a test. Before the fix all three of these were the seed's
    // values in `after` as well — the fixture's per-process parse froze even the reader
    // that re-queries, which is why the assertion covers all three surfaces rather than
    // the one the ticket names.
    expect(before).toContain('Raspored — Muse by Mina');
    expect(before).not.toContain(EDITED_TITLE);

    expect(after, `/schedule/ after the fixture was edited:\n${offline.output()}`).toContain(
      EDITED_TITLE,
    );
    expect(after).toContain(EDITED_TEACHER);
    expect(after).toContain(EDITED_EMAIL);
  });

  it('says in its log that it re-reads, where the question is asked', () => {
    // The ticket's second acceptance branch — "or the dev server tells me plainly" — kept
    // even though the first one is now satisfied. „Is what I am looking at current" is
    // asked at the terminal, and before MUSE-47 the output answered neither way.
    expect(unreachable.output()).toContain('[content] dev server');
    expect(unreachable.output()).toMatch(/re-read on each request/);
  });
});

/* ------------------------------------------ 2. a build still memoises, and says live */

describe('a build still issues one query per reader', () => {
  it('runs in the build regime in-process, which is what the rest of the suite assumes', () => {
    // Stated rather than assumed: every assertion in this block, and every memoisation
    // `test/projections.test.ts` relies on, is only the build regime because this is
    // false under `vitest run`.
    expect(inDevServer()).toBe(false);
  });

  it('hands every caller the same promise rather than the same value', () => {
    /**
     * This is what "one query per reader" *is*, and the cheapest honest way to assert it:
     * one promise means one call to the reader behind it means one HTTP request, however
     * many components await it. Measured against a real build for confirmation — four
     * pages reading the singleton issued `SITE_SETTINGS_QUERY` once — but that needs the
     * client instrumented, and an instrument that only exists for a test is a thing that
     * can be true while the product is wrong.
     *
     * `getSiteSettings` is deliberately not `async` for this: an `async` wrapper
     * allocates a fresh promise per call and makes the memoisation unobservable from
     * outside, which is the state that let MUSE-47's cause sit unasserted.
     */
    expect(getSiteSettings()).toBe(getSiteSettings());
  });

  it('answers a second fixture from the first one’s dataset, as the build wants', async () => {
    /**
     * The behavioural half, and the one that fails if `perBuild` is reduced to a
     * pass-through: the promise identity above would survive a cache keyed on something
     * that changes, and this would not.
     *
     * It is also exactly the behaviour `test/projections.test.ts` documents and depends
     * on, asserted here rather than left as a comment there. The fixture is restored
     * afterwards; it is this file's own run that would notice otherwise.
     */
    const seeded = await getSiteSettings();
    const previous = process.env[FIXTURE_ENV];
    process.env[FIXTURE_ENV] = mutable; // Edited: `email` is `EDITED_EMAIL`.
    try {
      expect((await getSiteSettings()).email).toBe(seeded.email);
      expect(seeded.email).not.toBe(EDITED_EMAIL);
    } finally {
      process.env[FIXTURE_ENV] = previous;
    }
  });

  it('says in its log that it memoised, whichever source it read', () => {
    expect(buildLog).toContain('[content] build');
    expect(buildLog).toMatch(/queried once and memoised/);
    expect(devEnvBuild.log).toMatch(/queried once and memoised/);
  });

  it('cannot be talked into the dev regime by the environment', () => {
    /**
     * The teeth under `src/lib/sanity/dev.ts`'s choice. `NODE_ENV`, `process.argv` and
     * `npm_lifecycle_event` all distinguish `astro dev` from `astro build` as reliably as
     * `import.meta.hot` does, and all three are settable by whoever starts the build —
     * which is disqualifying for a gate that decides whether content may come from a file
     * in the repository. `import.meta.hot` is a property of how the module is being
     * served, and no workflow, script or shell can produce it.
     */
    expect(devEnvBuild.log).toContain('[content] build');
    expect(devEnvBuild.log).not.toContain('[content] dev server');
  });
});

/* ------------------------------------------------------- 3. offline, and how you learn */

describe('the site can be developed with no network', () => {
  it('renders every page from the committed seed with nothing to fetch', async () => {
    // AC2. The server's project id does not exist, so a page that renders was rendered
    // from a file. Every route the site serves, both locales — read off `ROUTES` so a
    // page added tomorrow is covered the day it lands.
    expect(PAGES.length).toBe(ROUTES.length * LOCALES.length);
    for (const { route, locale } of PAGES) {
      // `text` is what makes this an assertion about eight *different* pages rather than
      // about eight URLs — it checks each one's canonical against the route asked for.
      const html = await text(offline, route, locale);
      expect(html, `${locale} ${route}`).toContain('Muse by Mina');
    }
  });

  it('builds its URLs under the base the server is serving, with one slash', () => {
    /**
     * The plumbing MUSE-47's CI failure went through, pinned. `DevServer.base` used to be
     * `new URL(greeting).pathname`, and the greeting is written for a human: the
     * character after the URL is a colour reset, which a class excluding whitespace,
     * quotes and backslashes happily ate. The base came out `/MuseByMina/%1B[31m/`, every
     * page 404ed, and the dev server's own 404 line re-coloured the terminal as it printed
     * the path — so the symptom read as `//schedule/`.
     *
     * Two properties, either of which the old helper could violate: the path is exactly
     * the base plus the route, and it contains no doubled separator however it was joined.
     */
    const url = new URL(pageUrl(offline, '/schedule', 'hr'));
    expect(url.pathname).toBe(`${offline.base}schedule/`);
    expect(url.pathname).not.toContain('//');
    expect(offline.base.endsWith('/')).toBe(true);
  });

  it('announces the fixture as loudly as a build does', () => {
    // AC4. Capitals, the path, and — unlike a build — the fact that a Studio edit can
    // never appear here, which is the one thing a dev session needs told and a build
    // does not.
    expect(offline.output()).toContain('[content] FIXTURE');
    expect(offline.output()).toContain(mutable);
    expect(offline.output()).toMatch(/a Studio edit will never appear/);
  });

  it('tells a dev server that cannot reach Sanity how to carry on', () => {
    /**
     * The whole of MUSE-47's answer to "`npm run dev` now requires network", and it is a
     * sentence rather than a mechanism: no fallback, no second variable, no
     * `dev:offline` script. A build that quietly substituted the seed for an unreachable
     * dataset is the deploy MUSE-20's barriers exist to prevent, and a dev session that
     * did it would be MUSE-35's shape again — dev and the build disagreeing about
     * something invisible, now on a second axis.
     *
     * Asserted against the server's own output, not the response body: Astro's dev server
     * answers a render failure with an 88-byte 500 and delivers the message over the HMR
     * socket to the error overlay. The terminal is where the text exists on the way there,
     * and it is also where a person running `npm run dev` is looking.
     */
    const log = unreachable.output();
    expect(log).toContain('No network?');
    expect(log).toContain(`${FIXTURE_ENV}=`);
    expect(log).toContain('npm run dev');
  });

  it('names a seed that is really there, and the one the suite reads', () => {
    /**
     * The hint hardcodes a path — it has to, since the variable is unset at the moment it
     * is printed — and a hardcoded path is a thing that rots silently. `vitest.config.ts`
     * names the same file for the whole run, so the two are compared rather than both
     * trusted: move the seed and this fails here instead of in somebody's terminal six
     * months later.
     */
    expect(SUITE_FIXTURE, `${FIXTURE_ENV} should be set for the test run`).toBeTruthy();
    const quoted = /`MUSE_CONTENT_FIXTURE=(\S+) npm run dev`/.exec(unreachable.output());
    expect(quoted, `no offline command in:\n${unreachable.output()}`).not.toBeNull();
    expect(quoted![1]).toBe(SUITE_FIXTURE);
    expect(existsSync(quoted![1]!)).toBe(true);
  });

  it('keeps the advice out of a deploy log', () => {
    /**
     * The same failure, in a build, must not suggest reading a fixture: the remedy for a
     * deploy is to wait for Sanity, `deploy.yml` already greps this error and retries for
     * exactly that reason, and a log that proposes the seed is a log that will eventually
     * be followed. `TRANSIENT_BUILD_FAILURE` is asserted against this same output by
     * `test/content.test.ts`; what is asserted here is only the absence of the hint.
     */
    expect(buildLog).toContain('Sanity did not answer a query');
    expect(buildLog).not.toContain('No network?');
    expect(buildLog).not.toContain('npm run dev');
  });
});

/* ------------------------- 3b. a per-request reader and a once-per-build warning (MUSE-46) */

describe('MUSE-46’s inert-route warning survives a per-request reader', () => {
  it('still says it at all', () => {
    // The direction that matters most: a reader that re-runs must not have turned the
    // warning off, and a de-duplication keyed on the wrong thing is exactly how it would.
    const log = inertDev.output();
    expect(log, `no inert-route warning in:\n${log}`).toContain(INERT_ROUTE_WARNING);
    expect(log).toContain(GHOST_A);
    expect(log).toContain('/nosuchroute');
  });

  it('says it once across several reloads, not once per reload', () => {
    /**
     * `pagesByRoute` now runs per request under a dev server, so without the `inertWarned`
     * comparison in `src/lib/sanity/index.ts` this count equals the number of reloads —
     * an unchanged complaint repeated into the one stream MUSE-47 just put the `[content]`
     * regime line into.
     */
    expect(inertReloads).toBeGreaterThan(1);
    expect(occurrences(inertDev.output(), GHOST_A)).toBe(1);
  });

  it('says it again when it is a different document, which is why it is keyed on the message', () => {
    /**
     * The half that the obvious de-duplication fails, and the reason the comparison is
     * against the *text* rather than against "have I warned yet". A flag would satisfy the
     * repeat count above and then go silent about the second document — and "once per
     * process" is MUSE-47's own defect in miniature: a log still reporting a condition
     * that stopped holding the moment you edited the Studio and reloaded.
     *
     * Both documents were inert at different points in one dev session. Each is named
     * exactly once.
     */
    const log = inertDev.output();
    expect(occurrences(log, GHOST_B), `${GHOST_B} in:\n${log}`).toBe(1);
    expect(occurrences(log, GHOST_A)).toBe(1);
    expect(occurrences(log, INERT_ROUTE_WARNING)).toBe(2);
  });

  it('is unchanged in a build, which is where the suite asserts it', () => {
    // `test/routes.test.ts` reads this warning off a real build's log. A build runs the
    // reader once, so the first look is the only look and MUSE-46's output is untouched by
    // any of MUSE-47 — stated here too, because this is the file that changed the reader.
    expect(devEnvBuild.log).not.toContain(INERT_ROUTE_WARNING);
    expect(devEnvBuild.log).toContain('[content] FIXTURE');
  });
});

/* --------------------------------------------- 4. the dev path is not the deploy path */

describe('the dev affordance has not become a way in', () => {
  it('leaves `npm run dev` reading the live dataset', () => {
    /**
     * `test/content.test.ts` forbids the *text* `MUSE_CONTENT_FIXTURE=` in any
     * `package.json` script, which is the absolute rule and stays absolute. This says the
     * same thing through the parsed manifest instead — a different instrument on the same
     * claim, and the one that still holds if a script ever reaches the variable by some
     * route a regex over the raw file does not see. Nothing that runs the dev server, or
     * anything else, may choose a content source.
     */
    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };

    expect(manifest.scripts.dev).toBe('astro dev');
    for (const [name, command] of Object.entries(manifest.scripts)) {
      expect(command, `the \`${name}\` script`).not.toContain(FIXTURE_ENV);
    }
  });
});

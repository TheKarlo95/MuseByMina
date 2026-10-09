import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildFailure,
  buildSite,
  linkDescription,
  markdownLinkTo,
  metaDescription,
  PAGES_DEPLOY,
  type Build,
} from './helpers/build';
import { claimOutDir } from './helpers/scratch';
// MUSE-71's rule, shared with `test/offerclaims.test.ts`, which applies it to the sources.
import { claimsIn, report as offenceReport } from './helpers/offer-claims';
// The read path's own report of what it is configured to read. Imported from the index,
// which is the only module anything outside `src/lib/sanity/` may import.
import { source } from '../src/lib/sanity';
import { ROUTES } from '../src/lib/pages';
// What `.github/workflows/deploy.yml` greps a failed scheduled build for before retrying.
import { TRANSIENT_BUILD_FAILURE } from '../src/lib/rebuild';

/**
 * MUSE-20 — the site's words come out of Sanity, and the suite never asks the network.
 *
 * These assertions are the ticket's Given/When/Then. Three of them are the ones that
 * would be easiest to fake, so they are written so they cannot be:
 *
 *   - **"every page renders what it rendered before"** is checked against a *frozen copy
 *     of the strings `main` published* (`PUBLISHED_BEFORE_THE_MIGRATION` below), not
 *     against the seed the build read. Comparing the build to its own input asserts
 *     nothing about the migration: it passes with `"COMPLETELY WRONG TITLE"` in the seed,
 *     which is exactly what a reviewer demonstrated.
 *   - **"the content comes from the CMS"** is a *second real build* against a mutated
 *     fixture. A build with the strings still compiled in satisfies a comparison against
 *     the seed and fails this.
 *   - **"a missing field or document fails the build naming it"** reads real build
 *     output, not a decoder called in isolation — the decoder existing says nothing about
 *     whether the build calls it.
 *
 * Locale paths and output filenames are spelled out here rather than imported from
 * `src/lib/i18n.ts`, for the reason `test/seo.test.ts` gives: these assertions should stay
 * independent of the code they are checking.
 *
 * ---------------------------------------------------------------------------------
 * **Where the content comes from while this suite runs.**
 *
 * `npm test` runs real `astro build`s in parallel workers. HTTP round-trips in each of
 * them would make the suite's result depend on whether anybody is mid-edit in the Studio,
 * which is not a property a test suite may have.
 *
 * So the builds read `content/seed.ndjson` — **the same file `npm run sanity:seed`
 * imports into the dataset** — selected by `MUSE_CONTENT_FIXTURE` in `vitest.config.ts`.
 * One file is both the migration artefact and the fixture, so there is no second copy of
 * the content to drift: changing what gets imported changes what these tests read.
 *
 * Exactly one build here is allowed to touch the network, and it is the one that proves
 * the live path still exists — see "the live read path is not dead code" below.
 * ---------------------------------------------------------------------------------
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEED = 'content/seed.ndjson';
const FIXTURE_ENV = 'MUSE_CONTENT_FIXTURE';

const LOCALES = ['hr', 'en'] as const;
type Locale = (typeof LOCALES)[number];
type Bilingual = Record<Locale, string>;

/**
 * **The words `main` published, frozen.**
 *
 * This is the only thing in the repository that still knows what the site said before the
 * migration — the PR deleted them from `src/lib/pages.ts`, which is the point of the
 * ticket — so it is what makes "renders byte-identically to the current deploy" an
 * assertion rather than a command somebody once ran. Read off `src/lib/pages.ts`,
 * `src/lib/nav.ts` and `Footer.astro` at `d99d7f0`, the commit this branch is based on.
 *
 * It is a *second copy of the content*, deliberately, and the only one: it is the
 * migration's receipt. It is not maintenance — it is allowed to stop matching the day
 * Mina rewords something, and the right response then is to delete the entry with a
 * sentence saying who changed it and why, not to quietly update it to match. That is a
 * conversation in a diff, which is more than `diff -r` ever gave us.
 */
const PUBLISHED_BEFORE_THE_MIGRATION = {
  pages: {
    '/': {
      name: { hr: 'Početna', en: 'Home' },
      title: {
        hr: 'Muse by Mina — Plesni studio, Zagreb',
        en: 'Muse by Mina — Dance studio, Zagreb',
      },
      description: {
        hr: 'Plesni studio u Zagrebu. Bachata za odrasle — bez partnera, bez iskustva. Dođi na besplatni probni sat.',
        en: 'A dance studio in Zagreb. Bachata for adults — no partner, no experience needed. Come to a free trial class.',
      },
    },
    '/schedule': {
      name: { hr: 'Raspored', en: 'Schedule' },
      title: { hr: 'Raspored — Muse by Mina', en: 'Schedule — Muse by Mina' },
      description: {
        hr: 'Tjedni raspored bachata satova u Zagrebu — dan, vrijeme, razina i instruktor za tradicionalnu, modernu i sensual bachatu.',
        en: 'The weekly bachata class schedule in Zagreb — day, time, level and instructor for traditional, moderna and sensual bachata.',
      },
    },
    '/contact': {
      name: { hr: 'Kontakt', en: 'Contact' },
      title: {
        hr: 'Prijava za probni sat — Muse by Mina',
        en: 'Trial class sign-up — Muse by Mina',
      },
      description: {
        hr: 'Prijavi se na besplatni probni sat bachate u Zagrebu. Ispuni obrazac ili nam piši — javljamo se u roku od jednog radnog dana.',
        en: 'Sign up for a free bachata trial class in Zagreb. Fill in the form or write to us — we answer within one working day.',
      },
    },
    '/privacy': {
      name: { hr: 'Izjava o privatnosti', en: 'Privacy notice' },
      title: {
        hr: 'Izjava o privatnosti — Muse by Mina',
        en: 'Privacy notice — Muse by Mina',
      },
      description: {
        hr: 'Što obrazac za probni sat prikuplja, zašto, kome se prenosi, koliko dugo ga čuvamo i koja su tvoja prava prema GDPR-u.',
        en: 'What the trial-class form collects, why, who it is passed to, how long we keep it and what your rights are under the GDPR.',
      },
    },
  } as Record<string, { name: Bilingual; title: Bilingual; description: Bilingual }>,
  studio: {
    /** `STUDIO.name`. */
    name: 'Muse by Mina',
    /** `Footer.astro`'s blurb, which is what `siteSettings.tagline` is for. */
    tagline: {
      hr: 'Plesni studio u Zagrebu. Bachata za odrasle — bez partnera, bez iskustva.',
      en: 'A dance studio in Zagreb. Bachata for adults — no partner, no experience needed.',
    },
    /** `SITE_SUMMARY`. */
    summary: {
      hr: 'Plesni studio u Zagrebu (Ilica 209) — bachata za odrasle, bez partnera i bez iskustva.',
      en: 'A dance studio in Zagreb, Croatia (Ilica 209) — bachata for adults, no partner and no experience needed.',
    },
    /** `STUDIO.street` and `STUDIO.city`, which `siteSettings.address` now carries. */
    street: 'Ilica 209',
    city: 'Zagreb',
    email: 'dancestudio.muse@gmail.com',
    social: {
      instagram: 'https://www.instagram.com/dancestudio.muse',
      facebook: 'https://www.facebook.com/profile.php?id=61592250952126',
      linktree: 'https://linktr.ee/dancestudio.muse',
    },
  },
};

const PUBLISHED_ADDRESS = `${PUBLISHED_BEFORE_THE_MIGRATION.studio.street}, ${PUBLISHED_BEFORE_THE_MIGRATION.studio.city}`;

type CopyField = 'name' | 'title' | 'description';

/**
 * **Copy that has legitimately changed since the migration — the sentence, in a diff.**
 *
 * `PUBLISHED_BEFORE_THE_MIGRATION` is a receipt, not maintenance: it is *allowed* to stop
 * matching, and CLAUDE.md's rule is that the response is a note saying who changed it and
 * why, never a quiet edit to make the test pass again. This is where that note goes.
 *
 * An entry does not switch the assertion off. The comparison moves to the seed's current
 * value for that one field, and `the superseded copy really is gone` below asserts the
 * frozen string appears nowhere in the built output — so a superseded entry still fails
 * if the old words are somehow still being published, and a *spurious* entry fails too,
 * because the old and new values would be identical.
 */
const SUPERSEDED: { route: string; field: CopyField; ticket: string; because: string }[] = [
  {
    route: '/schedule',
    field: 'description',
    ticket: 'MUSE-36',
    because:
      'The frozen description described the invented schedule: „…dan, vrijeme, razina i ' +
      'instruktor za tradicionalnu, modernu i sensual bachatu." The three styles were ' +
      'invented in the foundation commit and the studio does not teach by them, and the ' +
      'four real classes are each taught by two people, so the singular „instruktor" was ' +
      'wrong as well. Replaced with what the timetable actually is: Mondays and ' +
      'Thursdays, 90 minutes, four levels.',
  },
  {
    route: '/',
    field: 'description',
    ticket: 'MUSE-71',
    because:
      'The frozen description ended „Dođi na besplatni probni sat." / "Come to a free ' +
      'trial class." The studio offers no free class: its own 2026/2027 enrolment form ' +
      'lists 55 € regular, 40 € student and 20 € drop-in and no trial rate, and nothing ' +
      'it publishes anywhere mentions one — the claim came from the same foundation ' +
      "commit as MUSE-36's invented schedule. One word is gone and nothing replaced it; " +
      'the sentence is now the brief\'s own „Dođi na probni sat.", which makes no price ' +
      'claim. Removing an unsupported commercial promise needed no decision from the ' +
      'studio — adding one would.',
  },
  {
    route: '/contact',
    field: 'description',
    ticket: 'MUSE-71',
    because:
      'The same claim in the same ticket, here as „besplatni probni sat" / "a free ' +
      'bachata trial class" in the `<meta name="description">` of `/contact` and in its ' +
      'two `llms.txt` lines. One word removed from each locale; the form, the reply ' +
      'promise and everything else the sentence says are unchanged.',
  },
];

function supersededEntry(route: string, field: CopyField) {
  return SUPERSEDED.find((entry) => entry.route === route && entry.field === field);
}

/**
 * **Pages the site did not have before the migration — the receipt has nothing to say
 * about them.**
 *
 * `PUBLISHED_BEFORE_THE_MIGRATION` is a record of what `main` published at `d99d7f0`, so a
 * page added since is not a drift from it; there is no frozen string to compare to, and
 * inventing one would be writing the receipt after the fact. For these routes the
 * comparison moves to the seed, which is the only honest source — which means the *words*
 * of a new page are asserted by the suite that ships it, not here.
 *
 * It is a list and not a derived set on purpose. „This route is new" is a claim somebody
 * has to make in a diff, with a ticket beside it; derived from the absence of a frozen
 * entry it would also swallow a frozen entry somebody deleted, which is the one thing this
 * file exists to prevent. Both halves are asserted below: every route in `ROUTES` is
 * either frozen or listed here, and a route listed here must really have no frozen entry.
 */
const ADDED_AFTER_THE_MIGRATION: { route: string; ticket: string; because: string }[] = [
  {
    route: '/pricing',
    ticket: 'MUSE-59',
    because:
      'The pricing page. MUSE-22 built the component and deliberately did not route it — ' +
      'no prices had been agreed and `getPricingTiers()` fails the build when the dataset ' +
      'holds no tier — so `/pricing` arrived with the two periods the studio confirmed, ' +
      'after this receipt was written. Its copy is asserted in `test/pricing.test.ts`.',
  },
  {
    route: '/whatisbachata',
    ticket: 'MUSE-65',
    because:
      'The one trust page of MUSE-27 whose content is general knowledge rather than ' +
      'studio fact — what bachata is, where it comes from, how it is counted. The site ' +
      "never had it: the nav entry was one of MUSE-13's dead links, and it arrived with " +
      'its `prosePage` document long after this receipt was written. Its words are ' +
      'asserted in `test/whatisbachata.test.ts`, including that every sentence is either ' +
      'about the dance or read off the timetable.',
  },
  {
    route: '/aboutus',
    ticket: 'MUSE-60',
    because:
      'The about page. MUSE-23 built the component and deliberately did not route it — ' +
      'the dataset held no `studioStory` and `getStudioStory()` fails the build naming ' +
      'the missing document — so `/aboutus` arrived after this receipt was written. Its ' +
      "story is **placeholder prose seeded in the dataset**, awaiting Mina's words; its " +
      'copy is asserted in `test/aboutus.test.ts`.',
  },
];

function addedEntry(route: string) {
  return ADDED_AFTER_THE_MIGRATION.find((entry) => entry.route === route);
}

/** The `page` document in the committed seed for one route. */
function seededPage(route: string): SeedDoc {
  const found = seedDocs().find((doc) => doc._type === 'page' && doc.route === route);
  if (!found) throw new Error(`The seed has no \`page\` document for ${route}.`);
  return found;
}

/**
 * What a route should publish for one field: the frozen words, or — where they have been
 * superseded — whatever the CMS now holds.
 */
function expectedCopy(route: string, field: CopyField, locale: Locale): string {
  if (addedEntry(route) || supersededEntry(route, field)) {
    return (seededPage(route)[field] as Bilingual)[locale];
  }
  return PUBLISHED_BEFORE_THE_MIGRATION.pages[route]![field][locale];
}

interface SeedDoc {
  _id: string;
  _type: string;
  [field: string]: unknown;
}

function seedDocs(): SeedDoc[] {
  return readFileSync(join(ROOT, SEED), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as SeedDoc);
}

function seededSettings(): SeedDoc {
  const found = seedDocs().find((doc) => doc._type === 'siteSettings');
  if (!found) throw new Error('The seed has no `siteSettings` document.');
  return found;
}

/** Write a one-off fixture into a directory nothing else can name, and return its path. */
function fixtureOf(docs: unknown[]): string {
  const path = join(claimOutDir('content-fixture'), 'content.ndjson');
  writeFileSync(path, docs.map((doc) => JSON.stringify(doc)).join('\n') + '\n');
  return path;
}

/** The seed with one document changed — the "Mina edited it in the Studio" case. */
function seedWith(id: string, change: (doc: SeedDoc) => SeedDoc): unknown[] {
  return seedDocs().map((doc) => (doc._id === id ? change(structuredClone(doc)) : doc));
}

/** The seed with one document dropped — the "she has not written it yet" case. */
function seedWithout(id: string): unknown[] {
  return seedDocs().filter((doc) => doc._id !== id);
}

function titleOf(html: string): string | undefined {
  return /<title>([^<]*)<\/title>/.exec(html)?.[1];
}

/** `/schedule` + `en` → `/en/schedule`; the locale-prefixed route (hr is unprefixed). */
function routeIn(route: string, locale: Locale): string {
  return `${locale === 'hr' ? '' : '/en'}${route === '/' ? '' : route}`;
}

/** The HTML published for a route in a locale. `build.format: 'directory'`. */
function pageFile(route: string, locale: Locale): string {
  const path = routeIn(route, locale).replace(/^\//, '');
  return path === '' ? 'index.html' : `${path}/index.html`;
}

/** The `- [Name](url): description` line of `llms.txt` for one route in one locale. */
function llmsLine(build: Build, route: string, locale: Locale): string {
  const url = `${build.origin}${routeIn(route, locale)}/`;
  const matching = build
    .read('llms.txt')
    .split('\n')
    .filter((line) => markdownLinkTo(url).test(line));
  expect(matching, `llms.txt lines linking to exactly ${url}`).toHaveLength(1);
  return matching[0]!;
}

/** Every built page, both locales. */
function everyPage(build: Build): { route: string; locale: Locale; html: string }[] {
  return ROUTES.flatMap(({ route }) =>
    LOCALES.map((locale) => ({ route, locale, html: build.read(pageFile(route, locale)) })),
  );
}

let build: Build;
/** The same site, rebuilt after a page *and* the singleton were edited in the "Studio". */
let edited: Build;
/** The same site, rebuilt with a draft sitting alongside a published document. */
let withDraft: Build;

/** The ways content can fail, each read off a real build's output. */
let missingField: string;
let missingDocument: string;
let duplicateDocument: string;
let malformedAddress: string;
let emptyDataset: string;
let unreadableFixture: string;
let unreachableApi: string;

const EDITED_ROUTE = '/schedule';
const EDITED_TITLE_HR = 'Tjedni plan — Muse by Mina';
const EDITED_TITLE_EN = 'Weekly plan — Muse by Mina';
const EDITED_DESC_HR = 'Promijenjeni opis rasporeda, napisan u Studiju.';
const EDITED_DESC_EN = 'An edited schedule description, written in the Studio.';
const EDITED_ADDRESS = 'Nova ulica 7, Split';

beforeAll(() => {
  build = buildSite(PAGES_DEPLOY);

  /**
   * One build carrying three independent edits, because each is a separate claim about
   * the same mechanism and a build costs seconds: a `page` document's title *and*
   * description reworded, the singleton's address changed, and `phone`/`openingHours`
   * filled in — which is the half of AC5 the committed seed cannot show, since it has
   * neither.
   */
  edited = buildSite(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf([
      ...seedWith('page-schedule', (doc) => ({
        ...doc,
        title: { _type: 'localeString', hr: EDITED_TITLE_HR, en: EDITED_TITLE_EN },
        description: { _type: 'localeString', hr: EDITED_DESC_HR, en: EDITED_DESC_EN },
      })).filter((doc) => (doc as SeedDoc)._id !== 'siteSettings'),
      {
        ...seededSettings(),
        address: EDITED_ADDRESS,
        phone: '+385 1 234 5678',
        openingHours: { _type: 'localeText', hr: 'Pon–pet 17–21', en: 'Mon–Fri 5–9pm' },
      },
    ]),
  });

  withDraft = buildSite(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf([
      ...seedDocs(),
      {
        ...seedDocs().find((doc) => doc._id === 'page-home')!,
        _id: 'drafts.page-home',
        title: { _type: 'localeString', hr: 'NEOBJAVLJENO', en: 'UNPUBLISHED' },
      },
    ]),
  });

  missingField = buildFailure(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf(
      seedWith('page-contact', (doc) => {
        delete (doc.title as { en?: string }).en;
        return doc;
      }),
    ),
  });

  missingDocument = buildFailure(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf(seedWithout('page-privacy')),
  });

  duplicateDocument = buildFailure(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf([
      ...seedDocs(),
      { ...seedDocs().find((doc) => doc._id === 'page-schedule')!, _id: 'page-schedule-2' },
    ]),
  });

  malformedAddress = buildFailure(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf([
      ...seedDocs().filter((doc) => doc._id !== 'siteSettings'),
      { ...seededSettings(), address: 'Ilica 209' },
    ]),
  });

  emptyDataset = buildFailure(PAGES_DEPLOY, { [FIXTURE_ENV]: fixtureOf([]) });

  unreadableFixture = buildFailure(PAGES_DEPLOY, {
    [FIXTURE_ENV]: join(claimOutDir('content-fixture'), 'does-not-exist.ndjson'),
  });

  /**
   * **The one build in this repository that is allowed to use the network.**
   *
   * Everything else here reads the committed seed, and that left the live path — the
   * `try`/`catch` in `client.ts`, `SanityUnavailableError`, and the client configuration
   * around them — executed by no test at all: a reviewer made the live branch unreachable
   * and the suite stayed green. So one build points at a project that does not exist and
   * asserts the failure is the infrastructure one, naming where it looked.
   *
   * `MUSE_CONTENT_FIXTURE` is cleared explicitly rather than omitted, because
   * `astroBuild` passes the whole environment to the child and `vitest.config.ts` sets it
   * for every build. An empty value reads as unset (`fixturePath`), which is what makes
   * this expressible at all.
   *
   * It cannot flake into a pass: a project id that does not exist cannot answer, and with
   * no network at all the `fetch` fails, which is the same error. The only risk is
   * latency, which is why it is one build and not ten.
   */
  unreachableApi = buildFailure(PAGES_DEPLOY, {
    [FIXTURE_ENV]: '',
    SANITY_PROJECT_ID: 'muse20nosuchproject',
    SANITY_DATASET: 'nosuchdataset',
  });
}, 300_000);

/* ------------------------------------------------------------------ the artefact */

describe('the migration is a committed artefact, not a Studio session', () => {
  it('authors the documents as NDJSON under `sanity/`', () => {
    const docs = seedDocs();
    expect(docs.length).toBeGreaterThan(0);
    for (const doc of docs) {
      expect(typeof doc._id, JSON.stringify(doc)).toBe('string');
      expect(typeof doc._type, doc._id).toBe('string');
    }
  });

  it('holds the singleton, the four page documents and the real timetable', () => {
    /**
     * MUSE-20's scope line was "the singleton and the four `page` documents, and nothing
     * else", and the schedule was excluded on purpose: `src/data/schedule.ts` was invented
     * placeholder content naming two instructors who do not exist, and importing it would
     * have moved fiction out of a file that admitted it was fiction and into a Studio
     * where it reads as authoritative.
     *
     * MUSE-36 is the ticket that got the real timetable from Mina, so the seed now also
     * carries it — **not** migrated from that file, which is deleted: four `class`
     * documents, four `scheduleSlot` documents, and the two instructors who really teach
     * them. The counts are spelled out rather than loosened to "at least", because this
     * is the one assertion that would notice the invented thirteen coming back.
     *
     * MUSE-59 added the fifth `page` document and the **two** `pricingTier` documents —
     * two, because the studio confirmed two periods and no others. A third one appearing
     * here is a price nobody agreed to, which is MUSE-36 on the one field where it is also
     * a commercial claim; `test/pricing.test.ts` holds the amounts themselves.
     *
     * MUSE-65 added the seventh `page` document and the **one** `prosePage` document:
     * `/whatisbachata` is the only page whose body is prose from the CMS today, and the
     * type was designed for MUSE-27's other three. A second `prosePage` appearing here
     * before one of those ships is a page nobody routed.
     *
     * MUSE-60 added the sixth `page` document and the `studioStory` singleton. The
     * instructor count staying at **two** is the load-bearing half of that one: the page
     * it routes is the roster, and a third instructor appearing here is a person who does
     * not teach here — MUSE-36 exactly. `test/aboutus.test.ts` holds the names, and holds
     * that neither of the two has a bio nobody wrote.
     */
    const byType = new Map<string, number>();
    for (const doc of seedDocs()) byType.set(doc._type, (byType.get(doc._type) ?? 0) + 1);
    expect([...byType.entries()].sort()).toEqual([
      ['class', 4],
      ['instructor', 2],
      ['page', 7],
      ['pricingTier', 2],
      ['prosePage', 1],
      ['scheduleSlot', 4],
      ['siteSettings', 1],
      ['studioStory', 1],
    ]);
  });

  it('is re-runnable against a fresh dataset from an npm script', () => {
    // A hand-typed Studio session cannot be reviewed and cannot be redone.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts['sanity:seed'], 'no `sanity:seed` script').toBeTruthy();
    expect(pkg.scripts['sanity:seed']).toContain(SEED);
  });

  it('describes every route the site serves, exactly once', () => {
    const routes = seedDocs()
      .filter((doc) => doc._type === 'page')
      .map((doc) => doc.route);
    expect(routes.sort()).toEqual(ROUTES.map((entry) => entry.route).sort());
  });

  /**
   * **"No copy of it is left under `src/`" moved to `test/contentdrift.test.ts` (MUSE-50).**
   *
   * The assertion that used to be here was this one, and it was **green while the bug it
   * exists for was live**. Two reasons, and both are the reason it is not here any more:
   *
   *   1. Its forbidden list was **assembled by hand**, field by field. `title`,
   *      `description`, `tagline`, `summary`, `address`, `email` and the profile URLs were
   *      named; `class.slug` and `scheduleSlot.start` arrived with MUSE-36 and nothing
   *      added them, because nothing asked.
   *   2. It matched the whole `address` — „Ilica 209, Zagreb". The straggler on
   *      `/schedule` was the **street half** inside a composed eyebrow, and a needle that
   *      is a superstring of the copy cannot find it. The migration splits that field with
   *      `addressLines` for the footer, so the renderable value and the stored value are
   *      not the same string.
   *
   * So it is a registry now: every string field in the seed is classified covered or
   * exempt, the completeness of that classification is itself asserted, the needles include
   * what `addressLines` derives, and the failure names `file:line`. The reasoning for each
   * field — including the `name`/`studioLabel` overlap this comment used to carry — lives
   * beside the registry.
   */
});

/* ------------------------------------------------- the suite does not use the network */

describe('the suite reads the seed; the deploy reads the live dataset', () => {
  it('points every test build at the committed seed', () => {
    // One file, so the fixture and the migration cannot diverge.
    const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');
    expect(config).toContain(FIXTURE_ENV);
    expect(config).toContain(SEED);
  });

  it('never lets a deploy build read a fixture', () => {
    /**
     * The test-only shortcut must not become how production gets its content. There is
     * no default path and no fallback: unset, the build fetches live; set to a file that
     * is not there, the build fails loudly (asserted further down). So the only way a
     * deploy could read a fixture is by setting the variable in a workflow or in a build
     * script, which is what this forbids.
     *
     * Every workflow, read off the directory rather than from a list of the three that
     * exist today: MUSE-21 adds a rebuild trigger, and a hand-written list would be blind
     * to it on the day it lands. Same reasoning as `scripts/check-sanity.mjs`, which
     * learned it twice.
     *
     * Matched as an **assignment** rather than as a mention — `deploy.yml` carries a
     * comment saying it must never set this, which is exactly the kind of note that
     * should be allowed to name the thing it is about. The optional quote matters: a
     * quoted YAML key puts it between the name and the colon (`"FOO": bar`), and the
     * first version of this regex did not match that.
     */
    const assignment = new RegExp(`${FIXTURE_ENV}['"]?\\s*[:=]`);
    const workflows = readdirSync(join(ROOT, '.github/workflows')).map((file) =>
      join('.github/workflows', file),
    );
    expect(workflows.length).toBeGreaterThan(2);

    for (const file of [...workflows, 'package.json']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(assignment);
    }

    // And the one place that does set it, sets it to the seed.
    expect(readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8')).toMatch(assignment);
  });

  it('says in the build log which source it read, in capitals', () => {
    // A fixture build is then visible in any log it produces, rather than being a silent
    // difference between two green builds.
    expect(emptyDataset).toContain('FIXTURE');
    expect(emptyDataset).toContain('content.ndjson');
  });

  it('reads the live project when nothing says otherwise', () => {
    // The banner from the one build that was given no fixture. It names where it looked,
    // which is what makes a build pointed at the wrong dataset diagnosable.
    expect(unreachableApi).toContain('[content] live');
    expect(unreachableApi).toContain('muse20nosuchproject');
  });
});

/* ------------------------------------- AC1: the pages still say what they said */

describe('AC1: every page renders the words `main` published', () => {
  it('serves the frozen title and description, in both locales', () => {
    /**
     * Against `PUBLISHED_BEFORE_THE_MIGRATION`, **not** against the seed. Comparing the
     * output to the seed the build just read asserts that the renderer works, which the
     * AC2 tests below already establish by changing the input; it says nothing at all
     * about whether the words survived the move.
     */
    for (const { route, locale, html } of everyPage(build)) {
      expect(titleOf(html), `<title> of ${route} (${locale})`).toBe(
        expectedCopy(route, 'title', locale),
      );
      expect(metaDescription(html), `description of ${route} (${locale})`).toBe(
        expectedCopy(route, 'description', locale),
      );
    }
  });

  it('publishes those same strings in `llms.txt`, under the frozen link text', () => {
    for (const { route } of ROUTES) {
      for (const locale of LOCALES) {
        const line = llmsLine(build, route, locale);
        expect(linkDescription(line), `${route} (${locale})`).toBe(
          expectedCopy(route, 'description', locale),
        );
        expect(line, `${route} (${locale}) link text`).toContain(
          `[${expectedCopy(route, 'name', locale)}]`,
        );
      }
    }
  });

  /**
   * The anti-narrowing half of `ADDED_AFTER_THE_MIGRATION`: a route is frozen or it is
   * declared new, and nothing is quietly neither.
   *
   * Without this, a page added to `ROUTES` with no frozen entry would make `expectedCopy`
   * read the seed for it — comparing the build to its own input, which is the exact
   * failure the header of this file says a reviewer demonstrated.
   */
  it('accounts for every route: frozen before the migration, or declared as added since', () => {
    const unaccounted = ROUTES.map(({ route }) => route).filter(
      (route) =>
        PUBLISHED_BEFORE_THE_MIGRATION.pages[route] === undefined && !addedEntry(route),
    );
    expect(
      unaccounted,
      'these routes have no frozen copy and are not listed in ' +
        'ADDED_AFTER_THE_MIGRATION, so their words are being compared against the seed ' +
        'the build just read, which asserts nothing',
    ).toEqual([]);

    for (const entry of ADDED_AFTER_THE_MIGRATION) {
      expect(entry.ticket, entry.route).not.toBe('');
      expect(entry.because.length, `${entry.route} needs a reason`).toBeGreaterThan(40);
      // A route cannot be both: the frozen entry is the stronger claim, and an "added"
      // entry beside one would switch it off.
      expect(
        PUBLISHED_BEFORE_THE_MIGRATION.pages[entry.route],
        `${entry.route} is listed as added after the migration and is also frozen`,
      ).toBeUndefined();
      expect(
        ROUTES.map(({ route }) => route),
        `${entry.route} is not a route`,
      ).toContain(entry.route);
    }
  });

  /**
   * The other half of a `SUPERSEDED` entry: the old words are *gone*, and the entry is
   * not a stale note about a change that never happened.
   */
  /**
   * The anti-narrowing half of `ADDED_AFTER_THE_MIGRATION`: a route is frozen or it is
   * declared new, and nothing is quietly neither.
   *
   * Without this, a page added to `ROUTES` with no frozen entry would make `expectedCopy`
   * read the seed for it — comparing the build to its own input, which is the exact
   * failure the header of this file says a reviewer demonstrated.
   */
  it('accounts for every route: frozen before the migration, or declared as added since', () => {
    const unaccounted = ROUTES.map(({ route }) => route).filter(
      (route) =>
        PUBLISHED_BEFORE_THE_MIGRATION.pages[route] === undefined && !addedEntry(route),
    );
    expect(
      unaccounted,
      'these routes have no frozen copy and are not listed in ' +
        'ADDED_AFTER_THE_MIGRATION, so their words are being compared against the seed ' +
        'the build just read, which asserts nothing',
    ).toEqual([]);

    for (const entry of ADDED_AFTER_THE_MIGRATION) {
      expect(entry.ticket, entry.route).not.toBe('');
      expect(entry.because.length, `${entry.route} needs a reason`).toBeGreaterThan(40);
      // A route cannot be both: the frozen entry is the stronger claim, and an "added"
      // entry beside one would switch it off.
      expect(
        PUBLISHED_BEFORE_THE_MIGRATION.pages[entry.route],
        `${entry.route} is listed as added after the migration and is also frozen`,
      ).toBeUndefined();
      expect(
        ROUTES.map(({ route }) => route),
        `${entry.route} is not a route`,
      ).toContain(entry.route);
    }
  });

  it('publishes none of the superseded copy, and claims no change that is not one', () => {
    expect(
      SUPERSEDED.every((entry) => entry.ticket !== '' && entry.because.length > 40),
      'a superseded entry has to say which ticket changed it and why',
    ).toBe(true);

    for (const entry of SUPERSEDED) {
      const frozen = PUBLISHED_BEFORE_THE_MIGRATION.pages[entry.route]![entry.field];
      for (const locale of LOCALES) {
        // Spurious entry: if the words did not actually change, the comparison above was
        // switched off for nothing.
        expect(
          expectedCopy(entry.route, entry.field, locale),
          `${entry.route} ${entry.field} (${locale}) is listed as superseded but is unchanged`,
        ).not.toBe(frozen[locale]);

        // And the superseded words reach no visitor.
        for (const file of build.allFiles().filter((f) => /\.(html|txt|xml)$/.test(f))) {
          expect(
            build.read(file).includes(frozen[locale]),
            `${file} still publishes the superseded ${entry.route} ${entry.field}`,
          ).toBe(false);
        }
      }
    }
  });

  /**
   * **MUSE-71 — the output half of the retired offer claim.**
   *
   * The rule lives in `test/helpers/offer-claims.ts` and `test/offerclaims.test.ts` applies
   * it to `src/`, `sanity/` and the seed, where it can name a `file:line`. This is the
   * other level, and it is here rather than in that file because `npm test`'s heavyweight
   * budget has zero headroom (`test/helpers/concurrency.ts`) and this suite already has a
   * build: a guard needing an eleventh `astro build` would be spending somebody else's.
   *
   * It is not a duplicate of the source scan. A claim **composed** at render time — two
   * innocent fragments joined by a template literal, or a word that arrives from the live
   * dataset rather than from the seed — appears in no source file and in every page. That
   * is MUSE-50 exactly: its fifth address surface was a literal buried inside a longer
   * composed label, and the guard that missed it was looking for whole values in source.
   *
   * The two `SUPERSEDED` entries above already prove the two descriptions are gone, string
   * for string. This is the claim as a *class*, over every byte a visitor can read.
   */
  it('publishes no claim of a class at no cost, in either locale (MUSE-71)', () => {
    const offences = build
      .allFiles()
      .filter((file) => /\.(html|txt|xml)$/.test(file))
      .flatMap((file) => claimsIn(build.read(file), file));
    expect(offenceReport(offences)).toEqual([]);
  });

  it('keeps the studio details identical — name, summary, address, email, Instagram', () => {
    const { name, summary, email, social } = PUBLISHED_BEFORE_THE_MIGRATION.studio;
    const llms = build.read('llms.txt');

    expect(llms).toContain(`# ${name}`);
    expect(llms).toContain(`> ${summary.hr} / ${summary.en}`);
    expect(llms).toContain(`- Studio: ${name}, ${PUBLISHED_ADDRESS}`);
    expect(llms).toContain(`- Email: ${email}`);
    expect(llms).toContain(`- Instagram: ${social.instagram}`);
  });

  it('keeps the footer identical on every page — tagline, address, email, socials', () => {
    const { tagline, street, city, email, social } = PUBLISHED_BEFORE_THE_MIGRATION.studio;
    for (const { route, locale, html } of everyPage(build)) {
      const where = `${route} (${locale})`;
      expect(html, `tagline on ${where}`).toContain(tagline[locale]);
      expect(html, `street on ${where}`).toContain(street);
      expect(html, `city on ${where}`).toContain(city);
      expect(html, `email on ${where}`).toContain(email);
      for (const [platform, url] of Object.entries(social)) {
        expect(html, `${platform} link on ${where}`).toContain(url);
      }
    }
  });

  it('shows the address on every surface that used to show it', () => {
    /**
     * The field would otherwise be write-only, which is worse than not having it: it
     * looks like it works. Before MUSE-20 the address was rendered from code on four
     * surfaces; `siteSettings.address` now feeds all four, and the AC2 test below proves
     * it by changing the value.
     */
    for (const locale of LOCALES) {
      // The footer's two-line `<address>`, on every page.
      expect(build.read(pageFile('/privacy', locale))).toContain(
        PUBLISHED_ADDRESS.split(', ')[0]!,
      );
      // The homepage and /contact render it whole, in a heading.
      expect(build.read(pageFile('/', locale))).toContain(PUBLISHED_ADDRESS);
      expect(build.read(pageFile('/contact', locale))).toContain(PUBLISHED_ADDRESS);
      // The privacy notice names the controller and where it is.
      expect(build.read(pageFile('/privacy', locale))).toContain(
        `${PUBLISHED_BEFORE_THE_MIGRATION.studio.name}, ${PUBLISHED_ADDRESS}`,
      );
    }
  });
});

/* ------------------------------- AC2: an edit in the Studio moves every rendering */

describe('AC2: editing a document changes every place it is rendered', () => {
  it('changes the `<title>` and the `<meta name="description">` the page serves', () => {
    for (const [locale, title, description] of [
      ['hr', EDITED_TITLE_HR, EDITED_DESC_HR],
      ['en', EDITED_TITLE_EN, EDITED_DESC_EN],
    ] as const) {
      const html = edited.read(pageFile(EDITED_ROUTE, locale));
      expect(titleOf(html)).toBe(title);
      expect(metaDescription(html)).toBe(description);
    }
  });

  it('changes the `llms.txt` line in the same build', () => {
    // They are the same string — the claim `src/lib/pages.ts` used to make in code, and
    // that the `page` document now makes in the CMS.
    for (const [locale, description] of [
      ['hr', EDITED_DESC_HR],
      ['en', EDITED_DESC_EN],
    ] as const) {
      expect(linkDescription(llmsLine(edited, EDITED_ROUTE, locale))).toBe(description);
    }
  });

  it('changes the address everywhere it is shown, on every page', () => {
    const [street, city] = EDITED_ADDRESS.split(', ') as [string, string];
    for (const { route, locale, html } of everyPage(edited)) {
      // The footer is on every page: street and city, as two lines.
      expect(html, `edited street on ${route} (${locale})`).toContain(street);
      expect(html, `edited city on ${route} (${locale})`).toContain(city);
    }
    for (const locale of LOCALES) {
      expect(edited.read(pageFile('/', locale))).toContain(EDITED_ADDRESS);
      expect(edited.read(pageFile('/contact', locale))).toContain(EDITED_ADDRESS);
      expect(edited.read(pageFile('/privacy', locale))).toContain(EDITED_ADDRESS);
    }
  });

  it('leaves no copy of the pre-edit words anywhere in the output', () => {
    /**
     * The assertion that makes this suite worth running. A build with the strings still
     * compiled into the registry renders the old title *as well*, and every comparison
     * above would still pass.
     */
    const stale = [
      ...LOCALES.flatMap((locale) => [
        expectedCopy(EDITED_ROUTE, 'title', locale),
        expectedCopy(EDITED_ROUTE, 'description', locale),
      ]),
      PUBLISHED_ADDRESS,
    ];
    for (const file of edited.allFiles().filter((f) => /\.(html|txt|xml)$/.test(f))) {
      const body = edited.read(file);
      for (const value of stale) {
        expect(body.includes(value), `${file} still carries ${JSON.stringify(value)}`).toBe(
          false,
        );
      }
    }
  });

  it('changes nothing else about the page', () => {
    // A migration, not a redesign: substituting the edited strings back into the edited
    // build reproduces the seeded build exactly.
    for (const locale of LOCALES) {
      let after = edited.read(pageFile(EDITED_ROUTE, locale));
      for (const [next, before] of [
        [
          locale === 'hr' ? EDITED_TITLE_HR : EDITED_TITLE_EN,
          expectedCopy(EDITED_ROUTE, 'title', locale),
        ],
        [
          locale === 'hr' ? EDITED_DESC_HR : EDITED_DESC_EN,
          expectedCopy(EDITED_ROUTE, 'description', locale),
        ],
        [EDITED_ADDRESS.split(', ')[0]!, PUBLISHED_BEFORE_THE_MIGRATION.studio.street],
        [EDITED_ADDRESS.split(', ')[1]!, PUBLISHED_BEFORE_THE_MIGRATION.studio.city],
      ] as const) {
        after = after.split(next).join(before);
      }
      expect(after).toBe(build.read(pageFile(EDITED_ROUTE, locale)));
    }
  });
});

/* --------------------------------------------------------- AC5: optional fields */

describe('AC5: `siteSettings` is accepted with or without a phone', () => {
  it('builds from a document that has neither a phone nor opening hours', () => {
    // The committed seed has neither, because no real value exists for either and
    // inventing one is how the fabricated schedule (MUSE-36) reached production.
    expect(build.htmlFiles().length).toBeGreaterThan(0);
    expect(seededSettings().phone).toBeUndefined();
  });

  it('builds just as happily from a document that has both', () => {
    /**
     * The half the seed cannot demonstrate, and the one the AC actually asks for: the
     * requirement is that the Studio *accepts* a document without them, not that nobody
     * may ever fill them in. The first version of this test asserted the seed had no
     * phone, which forbids content the requirement permits and would have gone red the
     * day a real number arrived.
     *
     * `requiredFieldsOf('siteSettings')` in `test/sanity.test.ts` is the other half: it
     * asserts the Studio itself does not demand them.
     */
    expect(edited.htmlFiles()).toEqual(build.htmlFiles());
  });
});

/* ---------------------------------------------- drafts are not published content */

describe('an unpublished draft is not content', () => {
  it('renders exactly as if the draft were not there', () => {
    /**
     * The fixture's counterpart to `perspective: 'published'` in `client.ts`. A seed
     * refreshed with `sanity dataset export` carries drafts, so without this the fixture
     * sees documents the deploy is right to ignore: green suite, different deploy, and
     * the difference invisible in the seed's own diff.
     */
    for (const file of build.allFiles().filter((f) => /\.(html|txt|xml)$/.test(f))) {
      expect(withDraft.read(file), file).toBe(build.read(file));
    }
  });

  it('keeps the live path asking for published content only', () => {
    /**
     * `perspective: 'published'` is a live-API flag, so no offline build can exercise it:
     * deleting it would leave this suite green while the deploy started publishing
     * drafts. The draft test above is the behavioural half; this is the pin on the flag.
     *
     * It asserts the **value the client is built from**, not the text of the module. The
     * first version of this test grepped `client.ts` for `perspective: 'published'` and
     * was satisfied by a *comment* twenty lines above that happens to quote the flag — so
     * deleting the real line left it green, which a mutation run caught. `createClient`
     * now takes one configuration object and `sanitySource()` returns that same object.
     */
    expect(source().perspective).toBe('published');
    // And the dataset identity, which is what a build pointed at the wrong project would
    // get wrong — reported in the build banner for the same reason.
    expect(source().projectId).toBeTruthy();
    expect(source().dataset).toBeTruthy();
  });
});

/* ------------------------- AC3 & AC4: the failures, told apart by their messages */

describe('AC3: a required field left empty fails the build, naming the document', () => {
  it('names the document id, so Mina can find it in the Studio', () => {
    expect(missingField).toContain('page-contact');
  });

  it('names the document type and the field path, not "a required field"', () => {
    expect(missingField).toContain('`page`');
    expect(missingField).toContain('title.en');
  });

  it('says it stopped rather than publishing a page with a hole in it', () => {
    expect(missingField).toContain('SanityContentError');
  });
});

describe('AC3: a missing or duplicated `page` document fails the build, naming the route', () => {
  it('names the route nothing describes, and where to add it', () => {
    /**
     * This is the most likely content failure there is — one document not written yet —
     * and until a reviewer tried it, it produced the *wrong* message: `requireDocuments`
     * counted first and reported "the dataset holds 3 `page` document(s); this page needs
     * at least 4 … this is an empty dataset", which names no route, claims emptiness with
     * three of four present, and suggests a remedy that does not exist for `page`. The
     * per-route message was unreachable in exactly the case it was written for.
     */
    expect(missingDocument).toContain('/privacy');
    expect(missingDocument).toContain('SanityContentError');
    expect(missingDocument).toContain('Naslovi i opisi stranica');
    // And it must not reach for the count check's wording, which was the bug.
    expect(missingDocument).not.toContain('needs at least');
    expect(missingDocument).not.toContain('an empty dataset');
  });

  it('lists what it did find, so a wrong route is visible too', () => {
    expect(missingDocument).toContain('page-home');
    expect(missingDocument).toContain('Routes the site serves');
  });

  it('names the route two documents describe, rather than picking one', () => {
    // Which title the page gets would otherwise depend on query order.
    expect(duplicateDocument).toContain('/schedule');
    expect(duplicateDocument).toContain('More than one');
    expect(duplicateDocument).toContain('SanityContentError');
  });
});

describe('AC3: an address the footer cannot render fails the build', () => {
  it('names the document, the value and the shape it needs', () => {
    // The one content rule MUSE-20 adds: the footer renders street and city as two lines,
    // so the single `address` field has to carry exactly one comma. The Studio refuses it
    // too (`ADDRESS_PATTERN`), so this is the second line of defence, not the first.
    expect(malformedAddress).toContain('siteSettings');
    expect(malformedAddress).toContain('Ilica 209');
    expect(malformedAddress).toContain('SanityContentError');
  });
});

describe('AC4: empty, unreadable and unreachable stay three different answers', () => {
  it('reports an empty dataset as content that was never created', () => {
    expect(emptyDataset).toContain('siteSettings');
    expect(emptyDataset).toContain('never been created');
    expect(emptyDataset).toContain('SanityContentError');
  });

  it('reports a fixture it cannot read as the read path failing', () => {
    expect(unreadableFixture).toContain('SanityUnavailableError');
    expect(unreadableFixture).toContain(FIXTURE_ENV);
    expect(unreadableFixture).not.toContain('never been created');
  });

  it('reports an unreachable API as infrastructure, naming project and dataset', () => {
    // The live path, exercised for real — see the note in `beforeAll`.
    expect(unreachableApi).toContain('SanityUnavailableError');
    expect(unreachableApi).toContain('muse20nosuchproject');
    expect(unreachableApi).toContain('nosuchdataset');
    expect(unreachableApi).toContain('read path failing');
  });

  it('says it in the words the scheduled rebuild retries on (MUSE-21)', () => {
    /**
     * Since MUSE-21 the deploy also runs four times a day unattended, and a failed run
     * opens an issue assigned to a person. A minute of Sanity trouble at 01:20 would
     * otherwise do that about a site that is perfectly fine, so the build retries — and
     * **only** for an unreachable API, because a missing document or a GROQ typo will not
     * pass on the third attempt.
     *
     * The workflow tells the two apart by grepping the failed build's output for
     * `TRANSIENT_BUILD_FAILURE`, which makes a shell script in YAML depend on the wording
     * of an error thrown in `src/lib/sanity/client.ts`. Reword that message and the retry
     * silently stops happening: green until the first outage, then a false alarm, and an
     * alert that cries wolf is an alert nobody reads.
     *
     * This is the half of that contract that cannot be faked — the output of a real build
     * against a project that does not exist, which is the closest thing to a Sanity
     * outage this suite can produce. `test/rebuild.test.ts` asserts the workflow greps for
     * the same constant.
     */
    expect(
      unreachableApi,
      'A Sanity outage no longer says what `deploy.yml` retries on, so the scheduled ' +
        'rebuild will treat the next one as a real failure and page someone.',
    ).toContain(TRANSIENT_BUILD_FAILURE);
  });

  it('tells content faults and infrastructure faults apart by their type', () => {
    /**
     * This used to be `new Set([...]).size === 3`, which could never fail: every
     * `buildFailure` message opens with a freshly minted `mkdtemp` output directory, so
     * three identical failures still produced three distinct strings. The distinction
     * that matters is which *error class* each one is, so that is what is asserted.
     */
    const contentFaults = [missingField, missingDocument, duplicateDocument, emptyDataset];
    const infrastructureFaults = [unreadableFixture, unreachableApi];

    for (const message of contentFaults) {
      expect(message).toContain('SanityContentError');
      expect(message).not.toContain('SanityUnavailableError');
    }
    for (const message of infrastructureFaults) {
      expect(message).toContain('SanityUnavailableError');
      expect(message).not.toContain('SanityContentError');
    }
    // "Never created" belongs to the empty dataset alone; it is the sentence that stops a
    // reader diagnosing an outage as missing content.
    expect(emptyDataset).toContain('never been created');
    for (const message of [missingField, missingDocument, ...infrastructureFaults]) {
      expect(message).not.toContain('never been created');
    }
  });
});

import { readFileSync } from 'node:fs';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLASS_DANGLING_INSTRUCTOR,
  DELETED_CLASS_ID,
  DELETED_INSTRUCTOR_ID,
  DRAFTS,
  CLASS_ONE,
  CLASS_TWO,
  EVENT_ENDING_NOW,
  EVENT_FUTURE,
  EVENT_STARTING_NOW,
  FULL,
  FULL_COUNTS,
  GALLERY_ONE,
  GALLERY_TWO,
  INSTRUCTOR_A,
  INSTRUCTOR_B,
  INSTRUCTOR_C,
  NOW,
  POST_DANGLING_AUTHOR,
  POST_EARLIER,
  POST_FUTURE,
  POST_NOW,
  PAGE_DOCS,
  PROSE_PAGE_DOC,
  ROUTE_FOR_PROSE,
  SITE_SETTINGS_DOC,
  SLOT_DANGLING_CLASS,
  SLOT_DANGLING_OVERRIDE,
  SLOT_PARTIAL_DANGLING_OVERRIDE,
  SLOT_WITH_DANGLING_TEACHER,
  STUDIO_STORY_DOC,
  expectedImage,
  fixtureOf,
} from './helpers/structural-content';
import { ROUTES } from '../src/lib/pages';
import {
  SanityContentError,
  SanityUnavailableError,
  getClasses,
  getEvents,
  getFaqs,
  getGallery,
  getInstructors,
  getPage,
  getPageMeta,
  getPosts,
  getPricingTiers,
  getProsePage,
  getSchedule,
  getSiteSettings,
  getStudioStory,
  countDocuments,
} from '../src/lib/sanity';
// The literal query text, imported rather than retyped — see the note below on why a
// copy here would defeat the whole suite. `FIXTURE_ENV` and `runFixtureQuery` come from
// the read path's own module for the same reason.
import { EVENTS_QUERY, PAGES_QUERY, POSTS_QUERY } from '../src/lib/sanity/queries';
// The whole module as well, so the parameter cross-check below covers every query there
// is rather than the ones somebody remembered to list.
import * as QUERIES from '../src/lib/sanity/queries';
import { FIXTURE_ENV, runFixtureQuery } from '../src/lib/sanity/fixture';
// MUSE-51: `runQuery` is the branch point between the two read paths, and the parameter
// guard sits in front of it, so the live arm is reachable here without a network call.
// `requireDocuments` and `decodeEvent` are what `getEvents` wraps — imported so a
// `getEvents` call with the parameter dropped can be written out, which `getEvents`
// itself will not do.
import { runQuery } from '../src/lib/sanity/client';
import { decodeEvent, requireDocuments } from '../src/lib/sanity/decode';
import { queryParameters } from '../src/lib/sanity/params';

/**
 * MUSE-44 — the nine GROQ queries nothing ever ran.
 *
 * `src/lib/sanity/queries.ts` holds eleven queries. Before this file, exactly two of
 * them — `SITE_SETTINGS_QUERY` and `PAGES_QUERY` — were executed by anything, so no
 * projection in the other nine had ever been checked against a row. `class->nam`
 * type-checked, built, exited 0 and would have shipped a schedule of blanks.
 *
 * **Three layers look like they cover this and none of them does**, and each one is a
 * trap worth not re-creating:
 *
 *   - `scripts/sanity-read-check.mjs` runs all eleven against the live dataset. The
 *     dataset holds no classes, instructors, events or images, so all nine report
 *     `EMPTY` — which is the correct answer from an empty dataset and indistinguishable
 *     from a wrong projection. It proves each query parses and is answered. Nothing more.
 *   - `test/sanity.test.ts` decodes hand-written rows that are already in the
 *     **post-projection** shape. The projection never runs there, so the test and the
 *     query cannot disagree.
 *   - `sanity typegen` derives result types from the query *text*, so a typo yields a
 *     *consistent* wrong type and `astro check` stays green.
 *
 * So this file runs the real query text against real pre-projection documents, through
 * Sanity's own GROQ engine, and asserts the decoded result field by field.
 *
 * ---------------------------------------------------------------------------------
 * **Why it goes through the readers rather than evaluating GROQ directly.**
 *
 * Every assertion below calls `getSchedule()`, `getClasses()`, … from
 * `src/lib/sanity/index.ts`, with `MUSE_CONTENT_FIXTURE` pointed at a fixture. That is
 * the build's own read path — query text, `groq-js` evaluation, `requireDocuments`,
 * decoder — so a green run says the thing the ticket asks for: *the reader a page calls
 * returns the right fields*. Evaluating the query constants directly would prove the
 * constants are fine while leaving open the possibility that no reader uses them, which
 * is the exact defect being closed.
 *
 * **Nothing here retypes a query.** `test/sanity.test.ts` already fails if a GROQ string
 * appears anywhere under `src/` outside `src/lib/sanity/`, and a copy in a *test* would
 * be worse than one in a component: the suite would agree with its own transcription and
 * go green against a `queries.ts` that says something else. The one place this file
 * touches query text at all is `PAGES_QUERY`, imported by name, because
 * `getPageMeta()` deliberately re-sorts its result into the registry's order and the
 * query's own `order(route asc)` is not observable through it.
 *
 * **The fixtures are not the seed.** `test/helpers/structural-content.ts`, and the long
 * note at the top of it explains why they must not be folded into
 * `content/seed.ndjson`: that file is imported into the live dataset by
 * `npm run sanity:seed`, and MUSE-36 is what happens when invented content reaches it.
 * ---------------------------------------------------------------------------------
 */

/** Datasets, written once. Each is a directory `claimOutDir` minted, so nothing collides. */
let full: string;
let danglingClass: string;
let danglingTeacher: string;
let danglingAuthor: string;
let noAuthor: string;
let danglingOverride: string;
let partialDanglingOverride: string;
let empty: string;

beforeAll(() => {
  full = fixtureOf(FULL, 'projections-full');
  danglingClass = fixtureOf([SLOT_DANGLING_CLASS], 'projections-dangling-class');
  danglingTeacher = fixtureOf(
    [SLOT_WITH_DANGLING_TEACHER, CLASS_DANGLING_INSTRUCTOR],
    'projections-dangling-teacher',
  );

  /**
   * MUSE-49's four datasets. Each holds the *minimum* that makes its case reachable and
   * every other field filled in, so a failure cannot be a side effect of some other
   * absence — and each dangling dataset has a live counterpart it could wrongly resolve to.
   */
  danglingAuthor = fixtureOf([POST_DANGLING_AUTHOR], 'projections-dangling-author');
  // The control for it: the same query, the same decoder, a post with no `author` at all.
  // Separate datasets because one unusable row fails the whole read, so the two cases
  // cannot be asserted against one fixture — and they are the two that must never be
  // conflated in either direction.
  noAuthor = fixtureOf([POST_NOW], 'projections-no-author');
  // `CLASS_TWO` and its two live teachers are in both, so `coalesce`'s second branch is
  // real: a fallback would publish „Instructor B i Instructor A" rather than a blank.
  danglingOverride = fixtureOf(
    [SLOT_DANGLING_OVERRIDE, CLASS_TWO, INSTRUCTOR_A, INSTRUCTOR_B],
    'projections-dangling-override',
  );
  partialDanglingOverride = fixtureOf(
    [SLOT_PARTIAL_DANGLING_OVERRIDE, CLASS_TWO, INSTRUCTOR_A, INSTRUCTOR_B, INSTRUCTOR_C],
    'projections-partial-dangling-override',
  );

  /**
   * MUSE-51's control: a dataset with nothing in it at all.
   *
   * A reachable, parseable, genuinely empty dataset is the case the parameter guard must
   * **not** touch. "No upcoming events" is a real state of this studio and `minimum: 0` is
   * how a page says so, so the two assertions it anchors are that the call still returns
   * `[]` with the parameter supplied, and that `minimum: 1` still produces the existing
   * empty-dataset `SanityContentError`, word for word.
   */
  empty = fixtureOf([], 'projections-empty');
});

/**
 * Run a reader against one fixture.
 *
 * `vitest.config.ts` points the whole run at `content/seed.ndjson`, which holds
 * the singleton and the four page documents and nothing else — so every reader below
 * would answer "the dataset holds 0 of these" without this. The variable is read by
 * `fixturePath()` on each call, so swapping it per test needs no module reloading; it is
 * restored afterwards so a failure cannot leak a fixture into the next test.
 *
 * Two readers — `getSiteSettings` and the one behind `getPageMeta`/`getPage` — memoise
 * their promise for the life of the process, because `Footer.astro` reads the singleton
 * on nine pages. Every call to either one below therefore passes the **same** fixture,
 * and must go on doing so: a second fixture would be silently ignored. The readers that
 * take a `now` are not memoised, which is what lets the `$now` cases move the boundary.
 */
async function from<T>(fixture: string, read: () => Promise<T>): Promise<T> {
  const previous = process.env[FIXTURE_ENV];
  process.env[FIXTURE_ENV] = fixture;
  try {
    return await read();
  } finally {
    process.env[FIXTURE_ENV] = previous;
  }
}

/**
 * Run a reader with **no** fixture, i.e. down the live arm of `runQuery`.
 *
 * Used by exactly one block below — the MUSE-51 parameter guard — and it is the only
 * thing in this file that can take that arm, because the guard it asserts is the only
 * thing on it that returns before a request is made. Nothing here reaches the network
 * while the guard exists; a run that *does* reach it is the guard having been deleted,
 * which is the failure the block is watching for.
 */
async function withoutFixture<T>(read: () => Promise<T>): Promise<T> {
  const previous = process.env[FIXTURE_ENV];
  delete process.env[FIXTURE_ENV];
  try {
    return await read();
  } finally {
    if (previous === undefined) delete process.env[FIXTURE_ENV];
    else process.env[FIXTURE_ENV] = previous;
  }
}

/* --------------------------------------------------------------- SCHEDULE_QUERY */

describe('SCHEDULE_QUERY: a slot describes itself through the class it points at', () => {
  it('projects every dereferenced field, per slot', async () => {
    /**
     * AC1. The two visible slots point at *different* classes, which is what makes this
     * a test of the dereference rather than of a constant: `SLOT_TWO` must carry
     * `class-two`'s name, level and duration, and `SLOT_ONE` must carry `class-one`'s.
     * A projection that lost `->` would give both the same row, or none.
     */
    const schedule = await from(full, () => getSchedule());

    expect(schedule).toEqual([
      {
        id: 'slot-two',
        classId: 'class-two',
        name: { hr: 'Sat B', en: 'Class B' },
        day: 'thu',
        start: '18:30',
        durationMin: 90,
        level: 'advanced',
        instructors: ['Instructor C'],
      },
      {
        id: 'slot-one',
        classId: 'class-one',
        name: { hr: 'Sat A', en: 'Class A' },
        day: 'tue',
        start: '20:00',
        durationMin: 60,
        level: 'beginner',
        instructors: ['Instructor A'],
      },
    ]);
  });

  it('resolves the instructors `coalesce` down both branches', async () => {
    /**
     * AC2, and the reason the fixture holds three instructors rather than two.
     *
     * `coalesce(instructors[]->name, class->instructors[]->name)`:
     *
     *   `slot-one` has no override    → `[Instructor A]`, class-one's regular teacher
     *   `slot-two` overrides with C   → `[Instructor C]`, who teaches no class at all
     *
     * With two instructors the override could resolve to the same name as the fallback
     * by coincidence and a broken `coalesce` would still look right. `Instructor C` is
     * reachable *only* through the slot's own reference, and `Instructor B` — one of
     * class-two's regular teachers — is the answer a `coalesce` with its arguments the
     * wrong way round would give for `slot-two`.
     *
     * The **length** is asserted too (MUSE-36). `class-two` is taught by two people and
     * the override by one, so an override that merged instead of replacing would answer
     * three names, and one that was ignored would answer two.
     */
    const byId = new Map(
      (await from(full, () => getSchedule())).map((entry) => [entry.id, entry.instructors]),
    );

    expect(byId.get('slot-one'), 'no override: falls back to the class').toEqual([
      'Instructor A',
    ]);
    expect(byId.get('slot-two'), 'override: the slot wins, and replaces').toEqual([
      'Instructor C',
    ]);
    expect([...byId.values()].flat()).not.toContain('Instructor B');
  });

  it('drops a slot that is switched off', async () => {
    // `active == true`. `slot-hidden` starts at 07:00, so a broken filter would also be
    // visible as a change in order — it would sort first.
    const ids = (await from(full, () => getSchedule())).map((entry) => entry.id);
    expect(ids).not.toContain('slot-hidden');
    expect(ids).toEqual(['slot-two', 'slot-one']);
  });
});

/* ---------------------------------------------------------------- CLASSES_QUERY */

describe('CLASSES_QUERY: the class, its teachers and its photograph', () => {
  it('projects every field, including the dereferenced instructor names', async () => {
    const classes = await from(full, () => getClasses());

    expect(classes).toEqual([
      {
        id: 'class-two',
        slug: 'class-two',
        name: { hr: 'Sat B', en: 'Class B' },
        level: 'advanced',
        description: { hr: 'HR class two.', en: 'EN class two.' },
        durationMin: 90,
        // B **then** A, which is the authored order and not alphabetical (MUSE-36): a
        // projection that sorted the list, or returned only its first member, is visible
        // here rather than on the page.
        instructors: ['Instructor B', 'Instructor A'],
        image: expectedImage(CLASS_TWO, 'image'),
      },
      {
        id: 'class-one',
        slug: 'class-one',
        name: { hr: 'Sat A', en: 'Class A' },
        level: 'beginner',
        description: { hr: 'HR class one.', en: 'EN class one.' },
        durationMin: 60,
        instructors: ['Instructor A'],
        image: expectedImage(CLASS_ONE, 'image'),
      },
    ]);
  });

  it('sorts by `coalesce(order, 999)` before the name', async () => {
    /**
     * `class-two` carries `order: 0` and a `name.hr` of "Sat B"; `class-one` has no
     * `order` and sorts first alphabetically. So the manual order and the alphabetical
     * fallback disagree, and only the `coalesce` produces two-then-one.
     */
    const slugs = (await from(full, () => getClasses())).map((entry) => entry.slug);
    expect(slugs).toEqual(['class-two', 'class-one']);
  });
});

/* ------------------------------------------------------------ INSTRUCTORS_QUERY */

describe('INSTRUCTORS_QUERY: name, slug, role, bio, portrait, Instagram', () => {
  it('projects every field', async () => {
    const instructors = await from(full, () => getInstructors());

    expect(instructors).toEqual([
      {
        id: 'instructor-b',
        name: 'Instructor B',
        slug: 'instructor-b',
        role: { hr: 'HR role B', en: 'EN role B' },
        bio: { hr: 'HR bio B.', en: 'EN bio B.' },
        portrait: expectedImage(INSTRUCTOR_B, 'portrait'),
        instagram: undefined,
      },
      {
        id: 'instructor-a',
        name: 'Instructor A',
        slug: 'instructor-a',
        role: { hr: 'HR role A', en: 'EN role A' },
        bio: { hr: 'HR bio A.', en: 'EN bio A.' },
        portrait: expectedImage(INSTRUCTOR_A, 'portrait'),
        instagram: 'https://example.invalid/instagram/instructor-a',
      },
      {
        id: 'instructor-c',
        name: 'Instructor C',
        slug: 'instructor-c',
        role: { hr: 'HR role C', en: 'EN role C' },
        // No bio and no photograph, which is the state every real instructor is in
        // (MUSE-36, MUSE-23).
        bio: undefined,
        portrait: undefined,
        instagram: undefined,
      },
    ]);
  });

  /**
   * **An instructor with no bio is a card, not a build failure** (MUSE-36).
   *
   * The companion to the portrait case below, and the one that arrived with the first two
   * real `instructor` documents: Mina and Antonio exist and teach a real timetable, and
   * nobody has written a paragraph about either of them. A `required()` bio could only
   * have been satisfied by writing one on their behalf.
   *
   * Asserted with a row on each side, which is the whole reason C goes without: with
   * every row carrying a bio, `bio` and a typo of it both project a value everywhere and
   * this query could not tell them apart.
   */
  it('accepts an instructor with no bio, and still projects the ones that have one', async () => {
    const instructors = await from(full, () => getInstructors());

    expect(instructors.filter((entry) => entry.bio === undefined).map((e) => e.id)).toEqual(
      ['instructor-c'],
    );
    expect(instructors.find((entry) => entry.id === 'instructor-a')?.bio).toEqual({
      hr: 'HR bio A.',
      en: 'EN bio A.',
    });
  });

  it('sorts by `coalesce(order, 999)` before the name', async () => {
    // B alone carries `order: 0`, so manual order is B, A, C and alphabetical is A, B, C.
    const names = (await from(full, () => getInstructors())).map((entry) => entry.name);
    expect(names).toEqual(['Instructor B', 'Instructor A', 'Instructor C']);
  });

  /**
   * **An instructor with no portrait is a page, not a build failure** (MUSE-23).
   *
   * Spelled out as its own case because the default the rest of this schema takes is the
   * opposite one: `class.image` is `required()`, and a missing image there stops the
   * build. No photography of this studio exists, so a required portrait could only be
   * satisfied by uploading something that is not one — the same argument that made
   * `siteSettings.phone` optional in MUSE-20, and the same failure mode (MUSE-36) behind
   * it. The placeholder frame is what pays for that, and `test/aboutus.test.ts` is what
   * checks it reserves the right box.
   */
  it('accepts an instructor with no photograph at all', async () => {
    const instructors = await from(full, () => getInstructors());
    const withoutPortrait = instructors.filter((entry) => entry.portrait === undefined);

    expect(withoutPortrait.map((entry) => entry.id)).toEqual(['instructor-c']);
    // And the ones that do have a portrait still carry the hotspot and crop, so "optional"
    // did not quietly become "dropped".
    expect(instructors.find((entry) => entry.id === 'instructor-a')?.portrait).toEqual(
      expectedImage(INSTRUCTOR_A, 'portrait'),
    );
  });

  /**
   * The Instagram URL is content, not markup.
   *
   * The ticket's own words: "put the URL in Sanity, not the component". `instagram` is
   * optional, so only `INSTRUCTOR_A` carries one — which is what makes this assertion
   * able to fail. With no row holding the field, `instagram` and a typo of it both
   * project `undefined` and the suite agrees with either.
   */
  it('projects the Instagram URL only for the instructor that has one', async () => {
    const byId = new Map(
      (await from(full, () => getInstructors())).map((entry) => [entry.id, entry.instagram]),
    );

    expect(byId.get('instructor-a')).toBe('https://example.invalid/instagram/instructor-a');
    expect(byId.get('instructor-b')).toBeUndefined();
    expect(byId.get('instructor-c')).toBeUndefined();
  });
});

/* ------------------------------------------------------------ STUDIO_STORY_QUERY */

describe('STUDIO_STORY_QUERY: the dated origin story', () => {
  it('projects the heading, the founding date and every paragraph', async () => {
    const story = await from(full, () => getStudioStory());

    expect(story).toEqual({
      id: 'studioStory',
      heading: { hr: 'HR story heading', en: 'EN story heading' },
      foundedOn: '2026-08-13',
      story: [
        { hr: 'HR story one.', en: 'EN story one.' },
        { hr: 'HR story two.', en: 'EN story two.' },
      ],
    });
  });

  it('keeps the paragraphs in the order Mina wrote them', async () => {
    // An array projection that lost its order is a story told backwards, which no decoder
    // can detect — both paragraphs are present and both are well-formed.
    const story = await from(full, () => getStudioStory());
    expect(story.story.map((paragraph) => paragraph.hr)).toEqual([
      'HR story one.',
      'HR story two.',
    ]);
  });

  it('reports a dataset with no story as never created, not as a broken query', async () => {
    // `/aboutus` is routed as of MUSE-60, so this is no longer a message nobody would
    // read: it is what every pull request and every deploy gets if the `studioStory`
    // document is deleted from the dataset. The build is right to stop — the alternative
    // is publishing a heading above nothing — and the error has to name the document so
    // the reader knows which of the three cases ("unreachable", "empty", "malformed") it
    // was.
    const empty = fixtureOf([SITE_SETTINGS_DOC], 'projections-no-story');
    const run = from(empty, () => getStudioStory());

    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/`studioStory`/);
  });

  /**
   * **`foundedOn` is optional as of MUSE-60, and optional is not unchecked.**
   *
   * No founding date for this studio is recorded anywhere, and the placeholder story
   * MUSE-60 seeded is held to asserting nothing checkable — so a required date could only
   * have been satisfied by inventing one. That makes a story *without* the field the
   * ordinary case, and it is the case `FULL` cannot exercise, because `STUDIO_STORY_DOC`
   * carries a date on purpose (the §10 date forms are an acceptance criterion of their
   * own).
   *
   * Two rows, both needed. Absent has to decode to `undefined` rather than failing, and a
   * value that is present but not a calendar date has to fail **naming the field** — a
   * date the CDN answers `"not a date"` for would otherwise reach `formatDate` and publish
   * „Od Invalid Date".
   */
  it('accepts a story with no founding date, and names a malformed one', async () => {
    const undated = fixtureOf(
      [
        SITE_SETTINGS_DOC,
        Object.fromEntries(
          Object.entries(STUDIO_STORY_DOC).filter(([field]) => field !== 'foundedOn'),
        ) as typeof STUDIO_STORY_DOC,
      ],
      'projections-undated-story',
    );
    const story = await from(undated, () => getStudioStory());
    expect(story.foundedOn).toBeUndefined();
    // And the rest of the document still arrived, so "optional" did not become "dropped".
    expect(story.heading).toEqual({ hr: 'HR story heading', en: 'EN story heading' });
    expect(story.story).toHaveLength(2);

    const malformed = fixtureOf(
      [SITE_SETTINGS_DOC, { ...STUDIO_STORY_DOC, foundedOn: '13.08.2026.' }],
      'projections-malformed-date',
    );
    const run = from(malformed, () => getStudioStory());
    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/foundedOn/);
  });
});

/* ------------------------------------------------------------ PROSE_PAGES_QUERY */

describe('PROSE_PAGES_QUERY: the body of a page that is only prose', () => {
  it('projects the heading, the lede and both levels of the section array', async () => {
    const prose = await from(full, () => getProsePage(ROUTE_FOR_PROSE));

    expect(prose).toEqual({
      id: PROSE_PAGE_DOC._id,
      route: ROUTE_FOR_PROSE,
      heading: { hr: 'HR prose heading', en: 'EN prose heading' },
      lede: { hr: 'HR prose lede.', en: 'EN prose lede.' },
      sections: [
        {
          heading: { hr: 'HR prose section one', en: 'EN prose section one' },
          body: [
            { hr: 'HR prose one one.', en: 'EN prose one one.' },
            { hr: 'HR prose one two.', en: 'EN prose one two.' },
          ],
        },
        {
          heading: { hr: 'HR prose section two', en: 'EN prose section two' },
          body: [{ hr: 'HR prose two one.', en: 'EN prose two one.' }],
        },
      ],
    });
  });

  it('keeps both arrays in the order they were written', async () => {
    // A two-level array that lost its order is an explanation given backwards, and no
    // decoder can detect it: every member is present and every one is well-formed.
    const prose = await from(full, () => getProsePage(ROUTE_FOR_PROSE));
    expect(prose.sections.map((section) => section.heading.hr)).toEqual([
      'HR prose section one',
      'HR prose section two',
    ]);
    expect(prose.sections[0]!.body.map((paragraph) => paragraph.hr)).toEqual([
      'HR prose one one.',
      'HR prose one two.',
    ]);
  });

  it('names the route rather than reporting an empty dataset when there is none', async () => {
    /**
     * `minimum: 0`, for `pagesByRoute`'s reason: `requireDocuments` can only count, and
     * with three documents present and the one this page wants absent a count check says
     * „the dataset holds 3 … this is an empty dataset", naming neither the route nor the
     * document. The per-route message is the one written for the failure that happens.
     */
    const run = from(empty, () => getProsePage(ROUTE_FOR_PROSE));
    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(ROUTE_FOR_PROSE);
  });

  it('names the route and both documents when two describe it', async () => {
    // Which heading the page got would otherwise depend on query order.
    const twice = fixtureOf(
      [PROSE_PAGE_DOC, { ...PROSE_PAGE_DOC, _id: `${PROSE_PAGE_DOC._id}-copy` }],
      'projections-two-prose',
    );
    const run = from(twice, () => getProsePage(ROUTE_FOR_PROSE));
    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(`${PROSE_PAGE_DOC._id}-copy`);
  });

  it('names the section and the paragraph index when one is malformed', async () => {
    // „a paragraph is not an object with `hr` and `en`" is useless to Mina when there are
    // a dozen of them, which is why the error carries both indices.
    const broken = fixtureOf(
      [
        {
          ...PROSE_PAGE_DOC,
          sections: [
            {
              _key: 's1',
              _type: 'prosePageSection',
              heading: { _type: 'localeString', hr: 'HR', en: 'EN' },
              body: [
                { _key: 's1p1', _type: 'localeText', hr: 'HR one.', en: 'EN one.' },
                { _key: 's1p2', _type: 'localeText', hr: 'HR two.' },
              ],
            },
          ],
        },
      ],
      'projections-broken-prose',
    );
    const run = from(broken, () => getProsePage(ROUTE_FOR_PROSE));
    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/sections\[0\]\.body\[1\]/);
  });
});

/* ---------------------------------------------------------------- PRICING_QUERY */

describe('PRICING_QUERY: the tiers, their features and the featured flag', () => {
  it('projects every field, including the bilingual feature list', async () => {
    const tiers = await from(full, () => getPricingTiers());

    expect(tiers).toEqual([
      {
        id: 'tier-two',
        name: { hr: 'HR tier two', en: 'EN tier two' },
        priceEur: 20,
        period: 'month',
        features: [{ hr: 'HR feature two A', en: 'EN feature two A' }],
        featured: true,
      },
      {
        id: 'tier-one',
        name: { hr: 'HR tier one', en: 'EN tier one' },
        priceEur: 10,
        period: 'class',
        features: [
          { hr: 'HR feature one A', en: 'EN feature one A' },
          { hr: 'HR feature one B', en: 'EN feature one B' },
        ],
        featured: false,
      },
    ]);
  });

  it('projects `featured: true`, which has a silent `false` fallback', async () => {
    /**
     * The weakest field in the query, and so the one worth naming. `flag()` in
     * `decode.ts` takes a fallback, so a dropped `featured` decodes to `false` with no
     * error — a cosmetically fine pricing table with no highlighted tier. Asserting the
     * `true` is the only thing that notices.
     */
    const featured = (await from(full, () => getPricingTiers())).filter((t) => t.featured);
    expect(featured.map((t) => t.id)).toEqual(['tier-two']);
  });

  it('sorts by `coalesce(order, 999)` before the price', async () => {
    // `tier-two` is the dearer tier and carries `order: 0`, so manual order and
    // `priceEur asc` disagree.
    const ids = (await from(full, () => getPricingTiers())).map((entry) => entry.id);
    expect(ids).toEqual(['tier-two', 'tier-one']);
  });
});

/* ----------------------------------------------------------------- EVENTS_QUERY */

describe('EVENTS_QUERY: upcoming events, past ones dropped', () => {
  it('projects every field, optional ones included', async () => {
    const events = await from(full, () => getEvents({ now: NOW }));
    const future = events.find((event) => event.id === 'event-future');

    expect(future).toEqual({
      id: 'event-future',
      slug: 'event-future',
      title: { hr: 'HR event future', en: 'EN event future' },
      eventType: 'party',
      startsAt: EVENT_FUTURE.startsAt,
      endsAt: EVENT_FUTURE.endsAt,
      venue: 'Fixture Venue',
      description: { hr: 'HR event future.', en: 'EN event future.' },
      lineup: ['Guest A', 'Guest B'],
      ticketUrl: 'https://example.invalid/tickets',
      image: expectedImage(EVENT_FUTURE, 'image'),
    });
  });

  it('projects `lineup`, which decodes to an empty list when it is absent', async () => {
    /**
     * `decodeEvent` answers a missing `lineup` with `[]` rather than failing, because an
     * event with no announced guests is a real event. So `lineu` instead of `lineup`
     * publishes every card with its guest list silently gone, and only an assertion on
     * a populated list sees it.
     */
    const events = await from(full, () => getEvents({ now: NOW }));
    expect(events.find((e) => e.id === 'event-future')?.lineup).toEqual(['Guest A', 'Guest B']);
    expect(events.find((e) => e.id === 'event-starting-now')?.lineup).toEqual([]);
  });

  it('leaves `endsAt` and `ticketUrl` absent when the document omits them', async () => {
    const events = await from(full, () => getEvents({ now: NOW }));
    const starting = events.find((event) => event.id === 'event-starting-now');

    expect(starting?.startsAt).toBe(EVENT_STARTING_NOW.startsAt);
    expect(starting?.endsAt).toBeUndefined();
    expect(starting?.ticketUrl).toBeUndefined();
  });

  it('orders soonest first', async () => {
    const ids = (await from(full, () => getEvents({ now: NOW }))).map((event) => event.id);
    expect(ids).toEqual(['event-ending-now', 'event-starting-now', 'event-future']);
  });
});

/* ---------------------------------------------------------------- GALLERY_QUERY */

describe('GALLERY_QUERY: the photograph, its caption and its date', () => {
  it('projects every field', async () => {
    const gallery = await from(full, () => getGallery());

    expect(gallery).toEqual([
      {
        id: 'gallery-two',
        caption: { hr: 'HR gallery two', en: 'EN gallery two' },
        takenAt: '2025-01-01',
        image: expectedImage(GALLERY_TWO, 'image'),
      },
      {
        id: 'gallery-one',
        caption: { hr: 'HR gallery one', en: 'EN gallery one' },
        takenAt: '2026-01-01',
        image: expectedImage(GALLERY_ONE, 'image'),
      },
    ]);
  });

  it('sorts by `coalesce(order, 999)` before the date taken', async () => {
    // `gallery-two` is the older photograph and carries `order: 0`, so manual order and
    // `takenAt desc` disagree.
    const ids = (await from(full, () => getGallery())).map((entry) => entry.id);
    expect(ids).toEqual(['gallery-two', 'gallery-one']);
  });
});

/* ------------------------------------------------------------------ POSTS_QUERY */

describe('POSTS_QUERY: published posts, newest first', () => {
  it('projects every field, including the dereferenced author', async () => {
    const posts = await from(full, () => getPosts({ now: NOW }));
    const earlier = posts.find((post) => post.id === 'post-earlier');

    expect(earlier?.slug).toBe('post-earlier');
    expect(earlier?.title).toEqual({ hr: 'HR post earlier', en: 'EN post earlier' });
    expect(earlier?.publishedAt).toBe(POST_EARLIER.publishedAt);
    expect(earlier?.excerpt).toEqual({ hr: 'HR post earlier.', en: 'EN post earlier.' });
    expect(earlier?.coverImage).toEqual(expectedImage(POST_EARLIER, 'coverImage'));
    expect(earlier?.body.hr).toHaveLength(1);
    expect(earlier?.body.en).toHaveLength(1);
  });

  it('projects `author` and `authorRef`, the pair a typo cannot hide behind', async () => {
    /**
     * `author` is optional, which is what makes it the weakest projection in the file: a
     * misspelled `author->nam` answers `undefined`, `optionalText` accepts it, and every
     * post publishes unsigned with nothing in the build, the types or the read check
     * objecting. `post-earlier` carries an author and `post-now` does not, so both answers
     * are pinned here and neither can be the default.
     *
     * `authorRef` is the second half (MUSE-49), and it closes the typo on *both* sides:
     * misspell the dereference and the `_ref` is still there, which the decoder reads as a
     * deleted instructor and fails on; misspell the `_ref` and `author` resolves while the
     * pair disagrees. The dangling case itself is in the MUSE-49 block below.
     */
    const posts = await from(full, () => getPosts({ now: NOW }));
    expect(posts.find((post) => post.id === 'post-earlier')?.author).toBe('Instructor A');
    expect(posts.find((post) => post.id === 'post-now')?.author).toBeUndefined();
  });

  it('orders newest first and drops a post dated in the future', async () => {
    const ids = (await from(full, () => getPosts({ now: NOW }))).map((post) => post.id);
    expect(ids).toEqual(['post-now', 'post-earlier']);
  });
});

/* ------------------------------------------------------------------- FAQS_QUERY */

describe('FAQS_QUERY: question and answer', () => {
  it('projects every field', async () => {
    const faqs = await from(full, () => getFaqs());

    expect(faqs).toEqual([
      {
        id: 'faq-two',
        question: { hr: 'Pitanje B?', en: 'Question B?' },
        answer: { hr: 'HR answer two.', en: 'EN answer two.' },
      },
      {
        id: 'faq-one',
        question: { hr: 'Pitanje A?', en: 'Question A?' },
        answer: { hr: 'HR answer one.', en: 'EN answer one.' },
      },
    ]);
  });

  it('sorts by `coalesce(order, 999)` before the question', async () => {
    const ids = (await from(full, () => getFaqs())).map((faq) => faq.id);
    expect(ids).toEqual(['faq-two', 'faq-one']);
  });
});

/* --------------------------------------------------------- SITE_SETTINGS_QUERY */

describe('SITE_SETTINGS_QUERY: the singleton, including the fields the seed leaves empty', () => {
  it('projects every field', async () => {
    /**
     * `phone`, `openingHours` and `shareImage` are optional and **absent from
     * `content/seed.ndjson`** — nothing renders them and no real value exists,
     * and inventing one is how MUSE-36 happened. So the builds in `test/content.test.ts`
     * cannot tell `shareImage{…}` from `shareImag{…}`: both answer `undefined`. This
     * fixture fills all three, which makes it the only place those three projections are
     * ever exercised.
     */
    const settings = await from(full, () => getSiteSettings());

    expect(settings).toEqual({
      id: 'siteSettings',
      studioName: 'Studio Fixture',
      tagline: { hr: 'HR tagline', en: 'EN tagline' },
      summary: { hr: 'HR summary.', en: 'EN summary.' },
      address: 'Fixture Street 1, Fixture City',
      email: 'fixture@example.invalid',
      phone: '+00 0 000 0000',
      openingHours: { hr: 'HR opening hours', en: 'EN opening hours' },
      // All three the footer links to. `linktree` is the one `socialUrl` would otherwise
      // fail the build over — see the note on it in the fixture.
      social: [
        { platform: 'instagram', url: 'https://example.invalid/instagram' },
        { platform: 'facebook', url: 'https://example.invalid/facebook' },
        { platform: 'linktree', url: 'https://example.invalid/linktree' },
      ],
      shareImage: expectedImage(SITE_SETTINGS_DOC, 'shareImage'),
    });
  });
});

/* ------------------------------------------------------------------ PAGES_QUERY */

describe('PAGES_QUERY: one document per route the site serves', () => {
  it('projects route, name, title and description', async () => {
    const pages = await from(full, () => getPageMeta());

    expect(pages).toEqual(
      ROUTES.map(({ route }, index) => ({
        id: `page-fixture-${index}`,
        route,
        name: { hr: `HR name ${index}`, en: `EN name ${index}` },
        title: { hr: `HR title ${index}`, en: `EN title ${index}` },
        description: { hr: `HR description ${index}`, en: `EN description ${index}` },
      })),
    );
  });

  it('answers for one route at a time', async () => {
    const page = await from(full, () => getPage(ROUTES[0]!.route));
    expect(page.route).toBe(ROUTES[0]!.route);
    expect(page.title).toEqual({ hr: 'HR title 0', en: 'EN title 0' });
  });

  it('sorts by route, which the reader then re-sorts away', async () => {
    /**
     * The one assertion in this file that reads raw rows. `getPageMeta()` deliberately
     * returns the registry's order — home first, because that is the order a reader
     * should meet the pages in `llms.txt` — so the query's own `order(route asc)` is
     * invisible through it. The sort is still worth pinning: it is what makes two builds
     * of one commit produce byte-identical output when two `page` documents collide.
     */
    const rows = await runFixtureQuery<{ route: string }[]>(PAGES_QUERY, {}, full);
    const routes = rows.map((row) => row.route);
    expect(routes).toEqual([...routes].sort());
    expect(routes).toHaveLength(PAGE_DOCS.length);
  });
});

/* -------------------------------------------------------- DOCUMENT_COUNTS_QUERY */

describe('DOCUMENT_COUNTS_QUERY: the liveness probe counts every type', () => {
  it('answers with one count per document type, and the counts are right', async () => {
    /**
     * The query whose whole job is to tell "the dataset is empty" apart from "the query
     * is broken" — which it cannot do if one of its own keys is misspelled, because a
     * misspelled key names a type that genuinely has no documents and answers `0`.
     * Against a dataset with a known census, a wrong key is a wrong number.
     */
    expect(await from(full, () => countDocuments())).toEqual(FULL_COUNTS);
  });
});

/* ------------------------------------------------------------------ the images */

describe('every image projection carries the asset, both alt locales, the hotspot and the crop', () => {
  /**
   * AC4, and the one failure in this file that is not an error of any kind.
   *
   * The design system crops one upload to 16:9, 4:5, 3:4 and 1:1 (§9 rule 4) and renders
   * every one with `object-fit: cover`. Without a hotspot Sanity centre-crops, so a 1:1
   * crop of a wide frame of two dancers' hands cuts the hands out — the page builds, the
   * image loads, and the picture is wrong. Nothing anywhere else in the suite would
   * notice, which is exactly why a dropped `hotspot` is the projection defect most likely
   * to survive.
   *
   * Every image in the fixture has its own sixteen numbers, so a projection returning the
   * wrong image's crop cannot coincide with the expected one either.
   */
  const cases: { label: string; read: (fixture: string) => Promise<unknown>; expected: unknown }[] =
    [
      {
        label: 'siteSettings.shareImage',
        read: (f) => from(f, () => getSiteSettings()).then((s) => s.shareImage),
        expected: expectedImage(SITE_SETTINGS_DOC, 'shareImage'),
      },
      {
        label: 'class.image',
        read: (f) =>
          from(f, () => getClasses()).then((c) => c.find((x) => x.id === 'class-one')?.image),
        expected: expectedImage(CLASS_ONE, 'image'),
      },
      {
        label: 'instructor.portrait',
        read: (f) =>
          from(f, () => getInstructors()).then(
            (i) => i.find((x) => x.id === 'instructor-a')?.portrait,
          ),
        expected: expectedImage(INSTRUCTOR_A, 'portrait'),
      },
      {
        label: 'event.image',
        read: (f) =>
          from(f, () => getEvents({ now: NOW })).then(
            (e) => e.find((x) => x.id === 'event-future')?.image,
          ),
        expected: expectedImage(EVENT_FUTURE, 'image'),
      },
      {
        label: 'galleryImage.image',
        read: (f) =>
          from(f, () => getGallery()).then((g) => g.find((x) => x.id === 'gallery-one')?.image),
        expected: expectedImage(GALLERY_ONE, 'image'),
      },
      {
        label: 'post.coverImage',
        read: (f) =>
          from(f, () => getPosts({ now: NOW })).then(
            (p) => p.find((x) => x.id === 'post-earlier')?.coverImage,
          ),
        expected: expectedImage(POST_EARLIER, 'coverImage'),
      },
    ];

  for (const { label, read, expected } of cases) {
    it(`${label} arrives whole`, async () => {
      const image = (await read(full)) as {
        assetId: string;
        alt: { hr: string; en: string };
        hotspot: unknown;
        crop: unknown;
      };

      expect(image, label).toEqual(expected);
      // Spelled out as well as compared, because `toEqual` on an absent object would
      // read as one failure and these are four different bugs.
      expect(image.assetId, `${label} assetId`).toMatch(/^image-fixture/);
      expect(image.alt.hr, `${label} alt.hr`).toMatch(/^HR alt /);
      expect(image.alt.en, `${label} alt.en`).toMatch(/^EN alt /);
      expect(image.hotspot, `${label} hotspot`).toBeDefined();
      expect(image.crop, `${label} crop`).toBeDefined();
    });
  }
});

/* ------------------------------------------------------- a dangling reference */

describe('a dangling reference fails naming the document, not as a blank', () => {
  /**
   * AC3. This is the defect CLAUDE.md's whole premise is about, in its sharpest form:
   * **GROQ answers a dereference of a deleted document with `null` and HTTP 200.** Delete
   * a class that a slot still points at and `class->name` is `null`, `class->level` is
   * `null`, `class->_id` is `null` — and a template that maps over the rows renders a
   * schedule row with no name, no level and no teacher. The build exits 0.
   *
   * So the assertion is on the *error*, and on three properties of it: it is a
   * `SanityContentError` and not a transport failure, it names the slot's `_id` so Mina
   * can find it in the Studio, and it names the field path.
   */
  it('fails on a slot whose class has been deleted', async () => {
    const run = from(danglingClass, () => getSchedule());

    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/slot-dangling-class/);
    await expect(run).rejects.toThrow(/classId/);
  });

  it('calls it content, not an unreachable API', async () => {
    // The three outcomes `decode.ts` keeps apart. A dangling reference is an answered
    // query with broken content; reporting it as unavailable would send whoever reads the
    // log looking at the dataset name.
    const error = await from(danglingClass, () => getSchedule()).catch((cause) => cause);
    expect(error).toBeInstanceOf(SanityContentError);
    expect(error).not.toBeInstanceOf(SanityUnavailableError);
  });

  it('fails when the class survives but one of its teachers has been deleted', async () => {
    /**
     * The subtler one, and the array made it subtler still (MUSE-36).
     *
     * The slot is fine, the class is fine, every other projected field arrives, and
     * `instructors` is **not empty** — `instructors[]->name` over a deleted reference and
     * a live one answers `[null, 'Instructor A']`. So `coalesce` returns a list, a
     * `length` check passes, and a page joining the names would publish „ i Instructor
     * A": a real teacher standing next to a blank, on the most-visited page on the site.
     *
     * The error therefore has to name the **index**, not just the field, or it sends
     * whoever reads the log looking at a list that appears to be fine.
     */
    const run = from(danglingTeacher, () => getSchedule());

    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/slot-dangling-teacher/);
    await expect(run).rejects.toThrow(/instructors\[0\]/);
  });

  it('names the deleted class, not just the field that came back empty', async () => {
    /**
     * MUSE-49's "the error must name the missing target", applied to the **required**
     * reference MUSE-44 already covered. The test above asserts the slot and the field;
     * this asserts the third thing, which the projection could not supply before:
     * *which* document is gone.
     *
     * Before the `_ref` was projected alongside the dereference, the message could only
     * say `classId` "should be a non-empty string, got null (the field is absent, or was
     * never filled in)" — three different causes, one sentence, and the one it names is
     * the wrong one. `class-that-was-deleted` is the id Mina needs in order to tell
     * "somebody deleted the class" from "the projection is misspelled".
     */
    const run = from(danglingClass, () => getSchedule());
    await expect(run).rejects.toThrow(new RegExp(DELETED_CLASS_ID));
  });
});

/* ------------------------------------------- a dangling *optional* reference (MUSE-49) */

describe('a dangling optional reference is a failure, not a blank', () => {
  /**
   * MUSE-49. The sibling of the block above, and the harder half.
   *
   * A **required** reference that dangles is caught because the decoder demands a value
   * and `null` is not one. An **optional** reference that dangles arrives as exactly the
   * same `undefined` as a field nobody filled in — and an optional field is *allowed* to
   * be empty, so the decoder accepted it and the page published a hole.
   *
   * The information needed to tell the two apart exists in the dataset but not in the
   * answer: the projection returned the dereferenced *value* and discarded whether there
   * was a `_ref` at all. So each query now projects the reference beside the value, and
   * the decoder applies the one rule that separates them:
   *
   *   `_ref` present, value `null`   →  the target has been deleted. Fail.
   *   both absent                    →  an empty optional field. Fine.
   *
   * **Every assertion here is on the message naming the deleted `_id`.** That is
   * deliberate and it is what makes this suite watch the fix rather than the shape: for
   * the two array cases the decoder *already* threw before MUSE-49 — it refused `null`
   * where a name belongs — so `rejects.toThrow()` alone stays green with the fix deleted.
   * What was missing was the diagnosis, and the diagnosis is the only thing that tells
   * Mina which document to open.
   */

  it('fails on a post whose author has been deleted, rather than publishing it unsigned', async () => {
    /**
     * AC1, and the case that was completely silent. `author` is optional, so
     * `author->name` answering `null` for a deleted instructor was indistinguishable from
     * a post the studio signs itself — `optionalText` returned `undefined` and the build
     * exited 0 with the byline gone.
     */
    const run = from(danglingAuthor, () => getPosts({ now: NOW }));

    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/post-dangling-author/);
    await expect(run).rejects.toThrow(/author/);
    await expect(run).rejects.toThrow(new RegExp(DELETED_INSTRUCTOR_ID));
  });

  it('calls that content, not an unreachable API', async () => {
    // The three outcomes `decode.ts` keeps apart. A deleted reference is an answered query
    // with broken content; reporting it as unavailable would send whoever reads the log
    // looking at the dataset name and the network.
    const error = await from(danglingAuthor, () => getPosts({ now: NOW })).catch((e) => e);
    expect(error).toBeInstanceOf(SanityContentError);
    expect(error).not.toBeInstanceOf(SanityUnavailableError);
  });

  it('still publishes a post that simply has no author', async () => {
    /**
     * AC2 — **the case that must keep working**, and the reason the fix cannot be "fail
     * whenever the byline is empty". Most posts will be signed by the studio rather than
     * by a person; `post.author`'s own Studio description says so ("Ostavi prazno i objava
     * je potpisana studijem"). Conflating the two in *this* direction would make an
     * ordinary editorial choice a build failure.
     *
     * `POST_NOW` carries no `author` key at all, so both the value and the `_ref` are
     * absent — the "empty optional field" half of the rule.
     */
    const posts = await from(noAuthor, () => getPosts({ now: NOW }));

    expect(posts).toHaveLength(1);
    expect(posts[0]?.id).toBe('post-now');
    expect(posts[0]?.author).toBeUndefined();
  });

  it("fails on a slot's dangling override instead of falling back to the class", async () => {
    /**
     * AC3, and the one where the old behaviour was worse than a blank.
     *
     * `SLOT_DANGLING_OVERRIDE` points at `CLASS_TWO`, which is taught by `Instructor B`
     * and `Instructor A` — both live, both in this dataset. So `coalesce` has a real
     * second branch, and if the dangling override is ever treated as absent the row
     * publishes two real names, neither of whom teaches this slot, on the most-visited
     * page on the site. A wrong instructor name is a claim about a named person; it is
     * strictly worse than no name, because nobody will notice it.
     *
     * The last assertion is the one that pins "no fallback": the message must not contain
     * the fallback teacher's name. An implementation that resolved the override to the
     * class's list and *then* failed for some other reason would satisfy every other line
     * here.
     */
    const run = from(danglingOverride, () => getSchedule());

    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/slot-dangling-override/);
    await expect(run).rejects.toThrow(/instructors\[0\]/);
    await expect(run).rejects.toThrow(new RegExp(DELETED_INSTRUCTOR_ID));
    await expect(run).rejects.not.toThrow(/Instructor B/);
  });

  it("still resolves a slot with no override to the class's regular teachers", async () => {
    /**
     * AC4 — the other case that must keep working, and the `coalesce`'s whole purpose.
     * An absent override is the normal state of almost every slot: Mina fills it in only
     * when somebody stands in. `SLOT_ONE` has no `instructors` key, so the field and its
     * `_ref`s are both absent and the second branch is taken, exactly as designed.
     *
     * Asserted against `full`, where `SLOT_TWO` overrides *successfully* in the same read
     * — so this cannot pass by the override path being broken in general.
     */
    const byId = new Map(
      (await from(full, () => getSchedule())).map((entry) => [entry.id, entry.instructors]),
    );

    expect(byId.get('slot-one'), 'no override: the class’s teacher').toEqual(['Instructor A']);
    expect(byId.get('slot-two'), 'a live override: the slot’s teacher').toEqual([
      'Instructor C',
    ]);
  });

  it('does not silently drop one dangling member of an instructors array', async () => {
    /**
     * AC5 — the failure mode the ticket could not name, because `instructors` was a single
     * reference when it was written (MUSE-36 made it an array).
     *
     * The override lists two people and one has been deleted, so the field is neither
     * absent nor empty nor wholly broken: `instructors[]->name` answers
     * `[null, 'Instructor C']`. **The list is still non-empty and every name in it is
     * real.** A projection or decoder that compacted it would publish „Instructor C"
     * alone — a true statement that is not the whole truth, indistinguishable on the page
     * from a slot that was only ever taught by one person, and with nothing blank to
     * notice.
     *
     * So: it must fail, it must name index 0 rather than the field as a whole, and it must
     * name the deleted instructor. The surviving teacher being decodable is what makes the
     * drop possible in the first place, which is why the assertion is not merely "throws".
     */
    const run = from(partialDanglingOverride, () => getSchedule());

    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/slot-partial-dangling-override/);
    await expect(run).rejects.toThrow(/instructors\[0\]/);
    await expect(run).rejects.toThrow(new RegExp(DELETED_INSTRUCTOR_ID));
  });

  it('names the deleted teacher of a class, not an empty name field', async () => {
    /**
     * The same array case one level down, on `CLASSES_QUERY` — which has no `coalesce` and
     * no override, so it isolates the array handling from the fallback.
     *
     * `CLASS_DANGLING_INSTRUCTOR` keeps `Instructor A` and loses the other one. Before the
     * `_ref`s were projected, the message said `instructors[0]` "should be a non-empty
     * string, got null (the field is absent, or was never filled in)" — which describes an
     * instructor document whose `name` is blank. That document does not exist; the
     * reference does, and it points at nothing. Two different Studio fixes, one sentence.
     */
    const run = from(danglingTeacher, () => getClasses());

    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/class-dangling-instructor/);
    await expect(run).rejects.toThrow(/instructors\[0\]/);
    await expect(run).rejects.toThrow(new RegExp(DELETED_INSTRUCTOR_ID));
  });

  it('resolves a live optional reference, so the rule is not "always fail"', async () => {
    /**
     * The control the four failures need. Everything above asserts that a dangling
     * reference stops the build; a decoder that simply refused every `author` would pass
     * all of it. `POST_EARLIER`'s author is `instructor-a`, who is in the dataset, and the
     * byline must come out as the instructor's name.
     */
    const posts = await from(full, () => getPosts({ now: NOW }));
    expect(posts.find((post) => post.id === 'post-earlier')?.author).toBe('Instructor A');
    expect(posts.find((post) => post.id === 'post-now')?.author).toBeUndefined();
  });
});

/* ------------------------------------------------------------- the $now boundary */

describe('$now is a boundary, asserted rather than assumed', () => {
  /**
   * AC5. "A past event is dropped and a future one is kept" is satisfied by `>` as
   * happily as by `>=`, so the fixture puts a row *exactly* on the boundary and the
   * assertions move `$now` across it by one millisecond.
   *
   * `$now` is a parameter rather than GROQ's `now()` so a build is reproducible — and
   * that is also what makes this testable at all. Every datetime in the fixture is
   * written by `Date#toISOString`, the same spelling `getEvents` gives `$now`, because
   * GROQ compares two strings by code point: `…T12:00:00Z` and `…T12:00:00.000Z` are one
   * instant and two different strings.
   */
  const MS = 1;

  it('keeps an event that ends exactly at `$now`, and drops it a millisecond later', async () => {
    const atNow = await from(full, () => getEvents({ now: NOW }));
    const justAfter = await from(full, () =>
      getEvents({ now: new Date(NOW.getTime() + MS), minimum: 0 }),
    );

    expect(atNow.map((e) => e.id)).toContain('event-ending-now');
    expect(justAfter.map((e) => e.id)).not.toContain('event-ending-now');
  });

  it('keeps an event that starts exactly at `$now`, and drops it a millisecond later', async () => {
    const atNow = await from(full, () => getEvents({ now: NOW }));
    const justAfter = await from(full, () =>
      getEvents({ now: new Date(NOW.getTime() + MS), minimum: 0 }),
    );

    expect(atNow.map((e) => e.id)).toContain('event-starting-now');
    expect(justAfter.map((e) => e.id)).toEqual(['event-future']);
  });

  it('drops a finished event and one that started without an announced end', async () => {
    // The two halves of `(!defined(endsAt) && startsAt >= $now) || endsAt >= $now`,
    // each with a subject on the far side of the boundary.
    const ids = (await from(full, () => getEvents({ now: NOW }))).map((event) => event.id);
    expect(ids).not.toContain('event-ended');
    expect(ids).not.toContain('event-past');
  });

  it('keeps a post published exactly at `$now`, and drops it a millisecond earlier', async () => {
    const atNow = await from(full, () => getPosts({ now: NOW }));
    const justBefore = await from(full, () =>
      getPosts({ now: new Date(NOW.getTime() - MS), minimum: 0 }),
    );

    expect(atNow.map((p) => p.id)).toEqual(['post-now', 'post-earlier']);
    expect(justBefore.map((p) => p.id)).toEqual(['post-earlier']);
  });

  it('publishes a post dated in the future once `$now` reaches it', async () => {
    // The scheduled-post case the schema's field description promises, from the other
    // side: the row is in the dataset the whole time and the filter is what hides it.
    const ids = (
      await from(full, () => getPosts({ now: new Date(POST_FUTURE.publishedAt as string) }))
    ).map((post) => post.id);

    expect(ids).toEqual(['post-future', 'post-now', 'post-earlier']);
  });

  it('pins the fixture instants either side of the boundary', async () => {
    // So a later edit to the fixture cannot quietly move a boundary row off the boundary
    // and leave the assertions above passing for the wrong reason.
    expect(EVENT_STARTING_NOW.startsAt).toBe(NOW.toISOString());
    expect(EVENT_ENDING_NOW.endsAt).toBe(NOW.toISOString());
    expect(POST_NOW.publishedAt).toBe(NOW.toISOString());
    expect(new Date(POST_FUTURE.publishedAt as string).getTime()).toBeGreaterThan(NOW.getTime());
  });
});

/* ------------------------------------------- a missing query parameter (MUSE-51) */

describe('a query run without a parameter it references', () => {
  /**
   * MUSE-51. The second confirmed `groq-js`-vs-live divergence, after drafts.
   *
   * `EVENTS_QUERY` and `POSTS_QUERY` reference `$now`. Omit it and the two read paths used
   * to disagree about whether anything was wrong:
   *
   *     live API   HTTP 400 `queryParseError`, "param $now referenced, but not provided"
   *     `groq-js`  `[]`
   *
   * So one mistake surfaced as two error classes — `SanityUnavailableError` live,
   * `SanityContentError: … this is an empty dataset, not a broken query` offline — and the
   * offline message asserted the one thing that is false.
   *
   * **And the count check was the only thing that noticed.** That is the part these tests
   * are really about. `requireDocuments` defaults `minimum` to 1, which is why "0 events"
   * went red at all; `getEvents({ minimum: 0 })` is a documented call for a studio with no
   * upcoming events, and with it the whole failure was silent — a blank `/events`
   * published offline while the deploy failed with a transport error.
   *
   * The count check cannot be the instrument, because it is wrong in both directions: it
   * fires on a legitimate empty result and says nothing about a broken query. So the guard
   * is in `src/lib/sanity/params.ts`, it runs before the query does, and `runQuery` calls
   * it **in front of the branch** — which is what lets the last test here assert the two
   * paths produce the same message rather than two wordings that happen to agree.
   *
   * MUSE-44's verification ritual — misspell `$now` in each of the two queries and confirm
   * the suite goes red — passed before this and passed for the wrong reason: via the count.
   * It now goes red naming the parameter, and it goes red with `minimum: 0` too.
   */

  /**
   * `getEvents`, with the parameter dropped.
   *
   * Written out rather than called, because `getEvents` defaults `now` and cannot be made
   * to omit it — which is also why nothing in production is broken today. Every other
   * element is the reader's own: `runQuery` with `EVENTS_QUERY`, then `requireDocuments`
   * with the caller's `minimum` and the real decoder. So this is the mistake MUSE-24 would
   * make the first time `/events` is built, in the shape it would make it.
   */
  async function eventsWithoutNow(fixture: string, minimum: number): Promise<unknown> {
    return from(fixture, async () => {
      const rows = await runQuery<unknown>(EVENTS_QUERY);
      return requireDocuments(rows, 'event', decodeEvent, minimum);
    });
  }

  it('fails naming the parameter, not the document count', async () => {
    const error = await eventsWithoutNow(full, 1).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(SanityUnavailableError);
    expect(error).not.toBeInstanceOf(SanityContentError);

    const message = (error as Error).message;
    expect(message, 'names the parameter').toContain('$now');
    expect(message, 'names the query').toContain('_type == "event"');
    // The two sentences the old failure produced, neither of which was true.
    expect(message, 'does not blame the dataset').not.toMatch(/empty dataset/);
    expect(message, 'does not report a document count').not.toMatch(/document\(s\)/);
  });

  it('still fails with `minimum: 0`, where the count check says nothing at all', async () => {
    /**
     * The acceptance criterion this ticket turns on, and the reason the fix is not a
     * better message on the count check. `minimum: 0` is `getEvents`'s documented way of
     * saying "no upcoming events is a real state"; with the parameter dropped, zero rows
     * is then exactly what the reader was told to expect.
     */
    const error = await eventsWithoutNow(full, 0).catch((cause: unknown) => cause);

    expect(error, 'a missing parameter with minimum: 0 published an empty page').toBeInstanceOf(
      SanityUnavailableError,
    );
    expect((error as Error).message).toContain('$now');
  });

  it('fails the same way for `POSTS_QUERY`, the other query that takes `$now`', async () => {
    const run = runFixtureQuery(POSTS_QUERY, {}, full);
    await expect(run).rejects.toThrow(SanityUnavailableError);
    await expect(run).rejects.toThrow(/\$now/);
  });

  it('treats a parameter supplied as `undefined` as not supplied', async () => {
    // `@sanity/client` serialises parameters with `JSON.stringify`, which has no spelling
    // for `undefined`, so `{now: undefined}` reaches the API as the same absence. Reporting
    // the two differently would be a distinction only this code can see.
    const run = runFixtureQuery(EVENTS_QUERY, { now: undefined }, full);
    await expect(run).rejects.toThrow(SanityUnavailableError);
    await expect(run).rejects.toThrow(/\$now/);
  });

  it('leaves a genuinely empty dataset saying what it said before', async () => {
    /**
     * The control, and the thing this ticket must not break: with the parameter supplied,
     * an empty dataset is content, not a broken query. Both halves of that are asserted —
     * `minimum: 0` returns `[]` and builds clean, `minimum: 1` produces the existing
     * `SanityContentError` with its existing sentence.
     */
    const none = await from(empty, () => getEvents({ now: NOW, minimum: 0 }));
    expect(none).toEqual([]);

    const error = await from(empty, () => getEvents({ now: NOW })).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(SanityContentError);
    expect((error as Error).message).toContain('this is an empty dataset, not a broken query');
    expect((error as Error).message).toContain('The dataset holds 0 `event` document(s)');
  });

  it('fails identically on both read paths, which is the whole point', async () => {
    /**
     * The acceptance criterion in its sharpest form: *the same* error, not two errors that
     * mean the same thing. `runQuery` checks the parameters before it chooses a source, so
     * the two arms cannot drift apart — and a guard moved into either arm alone fails this
     * assertion rather than passing on the strength of the wording being similar.
     *
     * The live arm makes no request: the guard returns before `sanityClient()` is reached.
     * If this test ever hangs or reports a transport failure, that is the guard being gone.
     */
    const offline = (await from(full, () => runQuery(EVENTS_QUERY)).catch(
      (cause: unknown) => cause,
    )) as Error;
    const live = (await withoutFixture(() => runQuery(EVENTS_QUERY)).catch(
      (cause: unknown) => cause,
    )) as Error;

    expect(offline).toBeInstanceOf(SanityUnavailableError);
    expect(live).toBeInstanceOf(SanityUnavailableError);
    expect(live.name).toBe(offline.name);
    expect(live.message).toBe(offline.message);
    expect(live.message).toContain('$now');
  });

  it('names every missing parameter, and only the missing ones', async () => {
    // No query in `queries.ts` takes two parameters today, so the shape of the message a
    // second one needs is asserted here rather than discovered by whoever adds it. The
    // parameter that *was* supplied must not appear in the demand — a message that asks
    // for something already given sends the reader to the wrong call site.
    const error = (await runFixtureQuery(
      '*[_type == $type && startsAt >= $now && venue == $venue]',
      { type: 'event' },
      empty,
    ).catch((cause: unknown) => cause)) as Error;

    expect(error).toBeInstanceOf(SanityUnavailableError);
    expect(error.message, 'demands both missing parameters').toContain('`$now` and `$venue`');
    expect(error.message, 'and accounts for all three').toContain(
      'Referenced: `$now`, `$type` and `$venue`',
    );
    expect(error.message, 'and for the one that was supplied').toContain('Supplied:   `$type`');
  });
});

/* ------------------------------------- the scanner against the real parser (MUSE-51) */

describe('the parameter scanner agrees with `groq-js`, query by query', () => {
  /**
   * MUSE-51's one soft spot, pinned.
   *
   * `queryParameters` scans the query text rather than parsing it, because the guard has to
   * run on the **live** path too and `groq-js` is a devDependency imported dynamically —
   * deliberately, so nothing a deploy depends on needs it installed
   * (`src/lib/sanity/fixture.ts`, reason 4). A second implementation for the second path
   * would be two things able to disagree about the question they exist to settle.
   *
   * So there is one scanner, and this is what makes it trustworthy: for every query in
   * `queries.ts`, the names it finds are compared against the `Parameter` nodes in the real
   * parse tree. A query whose parameters the scanner cannot see — a shape nobody has
   * written yet, a reference inside something the scan skips — is a red test here rather
   * than a guard that silently stops guarding.
   */
  async function parsedParameters(query: string): Promise<string[]> {
    const { parse } = await import('groq-js');
    const names = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const member of node) walk(member);
        return;
      }
      if (typeof node !== 'object' || node === null) return;
      const record = node as Record<string, unknown>;
      if (record.type === 'Parameter' && typeof record.name === 'string') names.add(record.name);
      for (const value of Object.values(record)) walk(value);
    };
    walk(parse(query));
    return [...names].sort();
  }

  /** Every exported query constant, by name, read off the module rather than listed. */
  const all: [string, string][] = Object.entries(QUERIES).flatMap(([name, value]) =>
    typeof value === 'string' ? [[name, value] satisfies [string, string]] : [],
  );

  it('reads every query in `queries.ts`, so this is not a sample', () => {
    /**
     * The count is read off the module's own source rather than written down, so a query
     * added tomorrow joins the cross-check by existing. A literal here would be the thing
     * this whole file exists to stop: MUSE-44's census said eleven and the file holds
     * twelve, because MUSE-49 added one — and a number in a test is exactly as current as
     * the last person who remembered to change it.
     */
    const source = readFileSync(
      new URL('../src/lib/sanity/queries.ts', import.meta.url),
      'utf8',
    );
    const declared = [...source.matchAll(/^export const (\w+) = define/gm)].map((m) => m[1]);

    expect(declared.length).toBeGreaterThan(1);
    expect(all.map(([name]) => name).sort()).toEqual([...declared].sort());
    expect(declared).toContain('EVENTS_QUERY');
    expect(declared).toContain('POSTS_QUERY');
  });

  for (const [name, query] of all) {
    it(`finds the same parameters in ${name} as the parser does`, async () => {
      expect(queryParameters(query)).toEqual(await parsedParameters(query));
    });
  }

  it('finds `$now` in the two queries that take it, and nothing in the other nine', () => {
    const withParameters = all.filter(([, query]) => queryParameters(query).length > 0);
    expect(withParameters.map(([name]) => name).sort()).toEqual([
      'EVENTS_QUERY',
      'POSTS_QUERY',
    ]);
    expect(queryParameters(EVENTS_QUERY)).toEqual(['now']);
    expect(queryParameters(POSTS_QUERY)).toEqual(['now']);
  });

  it('ignores a `$` that is text rather than a reference', async () => {
    // The false-positive direction, which is the one that would break a working build: a
    // scanner that counted these would demand a parameter no caller can supply. Checked
    // against the parser too, so "text" is the parser's opinion and not this test's.
    const cases = [
      '*[_type == "page" && title == "$now"]',
      "*[_type == \"page\" && title == '$now']",
      '*[_type == "page"]{ "a$b": title }',
      '// $now is a parameter in the other queries\n*[_type == "page"]{ _id }',
      '*[_type == "page"]{ "quoted\\"$now": _id }',
    ];

    for (const query of cases) {
      expect(queryParameters(query), query).toEqual([]);
      expect(await parsedParameters(query), query).toEqual([]);
    }
  });
});

/* ---------------------------------------------------------------------- drafts */

describe('an unpublished draft is invisible to every query, not just the two', () => {
  /**
   * `src/lib/sanity/fixture.ts` drops `drafts.`-prefixed documents — the fixture's half of
   * `perspective: 'published'` in `client.ts`, and the half an offline build can actually
   * exercise. MUSE-20 proves the mechanism, through a draft `page` and a whole-build
   * output comparison.
   *
   * This is the other nine. A `page` is one of the two queries that were already
   * executed; the nine that were not are where a leaked draft would go unnoticed, and they
   * are the ones where it costs something — a draft `scheduleSlot` is a class on the
   * public timetable that nobody published, and a draft `pricingTier` is the unfinished
   * price `client.ts` names as the reason the flag exists.
   *
   * The drafts live in the same fixture as everything else, so every assertion above is
   * already running against a dataset that contains them: a filter that stopped working is
   * a wrong first row in `getSchedule()`, `getInstructors()` and `getPricingTiers()`, and
   * a wrong census from `countDocuments()`. These tests say so out loud, because an
   * implicit guarantee is one the next reader has to reconstruct.
   */
  it('holds drafts in the fixture, so the assertions above are not vacuous', () => {
    expect(DRAFTS.length).toBeGreaterThan(0);
    for (const draft of DRAFTS) expect(draft._id).toMatch(/^drafts\./);
    expect(FULL.filter((doc) => doc._id.startsWith('drafts.'))).toHaveLength(DRAFTS.length);
  });

  it('hides a draft twin of a published slot rather than showing it twice', async () => {
    // `drafts.slot-one` is Mina's unfinished edit of `slot-one`: another day, the other
    // class, and 06:00, so a leak is both a duplicate and a wrong first row.
    const schedule = await from(full, () => getSchedule());
    expect(schedule.map((entry) => entry.id)).toEqual(['slot-two', 'slot-one']);
    expect(schedule.map((entry) => entry.start)).not.toContain('06:00');
  });

  it('hides a draft-only pricing tier — the unfinished price the flag exists for', async () => {
    const tiers = await from(full, () => getPricingTiers());
    expect(tiers.map((tier) => tier.id)).toEqual(['tier-two', 'tier-one']);
    expect(tiers.map((tier) => tier.priceEur)).not.toContain(1);
  });

  it('hides a draft-only instructor', async () => {
    const instructors = await from(full, () => getInstructors());
    expect(instructors.map((entry) => entry.name)).toEqual([
      'Instructor B',
      'Instructor A',
      'Instructor C',
    ]);
  });

  it('leaves drafts out of the census `count()` reports', async () => {
    /**
     * `DOCUMENT_COUNTS_QUERY` exists to tell "the dataset is empty" apart from "the query
     * is broken", so it has to count what the *build* can read. A probe that counted
     * drafts would report three pricing tiers to a build that can render two — a liveness
     * check that lies in the one direction that matters.
     */
    const counts = await from(full, () => countDocuments());
    expect(counts).toEqual(FULL_COUNTS);
    expect(counts.instructor, 'three published instructors, not four').toBe(3);
    expect(counts.pricingTier, 'two published tiers, not three').toBe(2);
    expect(counts.scheduleSlot, 'three published slots, not four').toBe(3);
  });
});

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CLASS_DANGLING_INSTRUCTOR,
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
  NOW,
  POST_EARLIER,
  POST_FUTURE,
  POST_NOW,
  PAGE_DOCS,
  SITE_SETTINGS_DOC,
  SLOT_DANGLING_CLASS,
  SLOT_WITH_DANGLING_TEACHER,
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
  getSchedule,
  getSiteSettings,
  getStudioStory,
  countDocuments,
} from '../src/lib/sanity';
// The literal query text, imported rather than retyped — see the note below on why a
// copy here would defeat the whole suite. `FIXTURE_ENV` and `runFixtureQuery` come from
// the read path's own module for the same reason.
import { PAGES_QUERY } from '../src/lib/sanity/queries';
import { FIXTURE_ENV, runFixtureQuery } from '../src/lib/sanity/fixture';

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
 * `sanity/seed/content.ndjson`: that file is imported into the live dataset by
 * `npm run sanity:seed`, and MUSE-36 is what happens when invented content reaches it.
 * ---------------------------------------------------------------------------------
 */

/** Datasets, written once. Each is a directory `claimOutDir` minted, so nothing collides. */
let full: string;
let danglingClass: string;
let danglingTeacher: string;

beforeAll(() => {
  full = fixtureOf(FULL, 'projections-full');
  danglingClass = fixtureOf([SLOT_DANGLING_CLASS], 'projections-dangling-class');
  danglingTeacher = fixtureOf(
    [SLOT_WITH_DANGLING_TEACHER, CLASS_DANGLING_INSTRUCTOR],
    'projections-dangling-teacher',
  );
});

/**
 * Run a reader against one fixture.
 *
 * `vitest.config.ts` points the whole run at `sanity/seed/content.ndjson`, which holds
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
    // The state the live dataset is in today, and the state `main` must keep building in:
    // `/aboutus` is deliberately not routed until the document exists (MUSE-23), so
    // nothing calls this reader yet. When the follow-up routes the page, this is the
    // message that has to name the document.
    const empty = fixtureOf([SITE_SETTINGS_DOC], 'projections-no-story');
    const run = from(empty, () => getStudioStory());

    await expect(run).rejects.toThrow(SanityContentError);
    await expect(run).rejects.toThrow(/`studioStory`/);
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

  it('projects `author`, which is optional and so fails silently', async () => {
    /**
     * `author->nam` returns `undefined`, `optionalText` accepts it, and every post is
     * published unsigned. Nothing in the build, the types or the read check objects.
     * `post-earlier` carries an author and `post-now` does not, so both answers are
     * pinned and neither can be the default.
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
     * `sanity/seed/content.ndjson`** — nothing renders them and no real value exists,
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

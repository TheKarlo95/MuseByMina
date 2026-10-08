import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ROUTES } from '../../src/lib/pages';
import { claimOutDir } from './scratch';

/**
 * **Structural content for `test/projections.test.ts`. Test-only, and deliberately not
 * `sanity/seed/content.ndjson`.**
 *
 * MUSE-44 needs a dataset that holds one of everything — a class, three instructors, a
 * slot with an instructor override and one without, images with hotspots and crops, a
 * past event and a future one — because nine of the eleven queries in
 * `src/lib/sanity/queries.ts` have never been executed against a row at all, and an
 * empty dataset answers all of them with `[]`. "Empty" and "the projection is wrong" are
 * the same symptom there.
 *
 * Two rules govern what is in here, and both have a ticket behind them.
 *
 * **1. It is not the seed, and it must never be merged into the seed.**
 * `sanity/seed/content.ndjson` is the live migration artefact — `npm run sanity:seed`
 * imports it into the production dataset, and `scripts/check-sanity.mjs` fingerprints it.
 * Adding rows here to *there* would seed invented classes and invented instructors into
 * the real dataset. So this file is a second, separate thing, and that is correct: the
 * seed is content the studio publishes, this is input to a query test. MUSE-20's
 * one-file argument ("the fixture and the migration cannot diverge") is about the
 * *site's own content*, where a second copy drifts. Nothing here is ever rendered, so
 * there is nothing for it to drift from.
 *
 * **2. Every value is structural, never plausible.** `Instructor A`, `Sat A`,
 * `example.invalid`. MUSE-36 exists because invented-but-plausible placeholder content —
 * a schedule naming two instructors who do not exist — escaped `src/data/schedule.ts`
 * and is live on the site today. A fixture that reads like a real timetable is one
 * copy-paste away from being the next one. If any string in here ever appears in
 * `dist`, that is a bug, and it should be obvious at a glance that it is.
 *
 * The documents are written in **pre-projection** shape: references as
 * `{_type: 'reference', _ref}`, slugs as `{_type: 'slug', current}`, bilingual values as
 * `{_type: 'localeString', hr, en}`, images as a Sanity image object with `asset`, `alt`,
 * `hotspot` and `crop`. That is the half `test/sanity.test.ts` cannot reach: it decodes
 * hand-written rows that are already projected, so the projection never runs and the
 * test and the query cannot disagree.
 */

/** A document as Sanity's export writes it: `_id`, `_type`, and raw fields. */
export interface FixtureDoc {
  _id: string;
  _type: string;
  [field: string]: unknown;
}

/** Write documents as NDJSON into a directory nothing else can name, and return its path. */
export function fixtureOf(docs: readonly FixtureDoc[], hint = 'projections'): string {
  const path = join(claimOutDir(hint), 'content.ndjson');
  writeFileSync(path, docs.map((doc) => JSON.stringify(doc)).join('\n') + '\n');
  return path;
}

/* ------------------------------------------------------------------- primitives */

function localeString(tag: string): { _type: string; hr: string; en: string } {
  return { _type: 'localeString', hr: `HR ${tag}`, en: `EN ${tag}` };
}

function localeText(tag: string): { _type: string; hr: string; en: string } {
  return { _type: 'localeText', hr: `HR ${tag}.`, en: `EN ${tag}.` };
}

function slug(current: string): { _type: string; current: string } {
  return { _type: 'slug', current };
}

function reference(id: string): { _type: string; _ref: string } {
  return { _type: 'reference', _ref: id };
}

function richText(tag: string): { _type: string; hr: unknown[]; en: unknown[] } {
  const block = (text: string): unknown => ({
    _type: 'block',
    _key: `b-${tag}`,
    style: 'normal',
    children: [{ _type: 'span', _key: `s-${tag}`, text }],
  });
  return { _type: 'localeRichText', hr: [block(`HR ${tag}.`)], en: [block(`EN ${tag}.`)] };
}

/**
 * An image with a **distinct** hotspot and crop per slot.
 *
 * Distinct on purpose. The design system crops one upload to 16:9, 4:5, 3:4 and 1:1
 * (§9 rule 4), so a projection that drops `hotspot` or `crop` produces a silently
 * centre-cropped image rather than an error — nothing fails, the picture is just wrong.
 * Giving every image its own numbers means a projection that returns the wrong object,
 * or no object, cannot coincide with the expected one.
 *
 * The numbers are two-decimal fractions so they compare exactly, and the asset id is
 * shaped like a real one (`image-<id>-<w>x<h>-<ext>`) without being one.
 */
export interface FixtureImage {
  _type: string;
  asset: { _type: string; _ref: string };
  alt: { _type: string; hr: string; en: string };
  hotspot: { _type: string; x: number; y: number; width: number; height: number };
  crop: { _type: string; top: number; bottom: number; left: number; right: number };
}

function imageOf(
  tag: string,
  hotspot: readonly [number, number, number, number],
  crop: readonly [number, number, number, number],
): FixtureImage {
  return {
    _type: 'image',
    asset: { _type: 'reference', _ref: `image-fixture${tag}-1600x900-jpg` },
    alt: { _type: 'localeString', hr: `HR alt ${tag}`, en: `EN alt ${tag}` },
    hotspot: {
      _type: 'sanity.imageHotspot',
      x: hotspot[0],
      y: hotspot[1],
      width: hotspot[2],
      height: hotspot[3],
    },
    crop: {
      _type: 'sanity.imageCrop',
      top: crop[0],
      bottom: crop[1],
      left: crop[2],
      right: crop[3],
    },
  };
}

/**
 * The decoded form of one fixture document's image field — what `ImageRef` must come
 * back as.
 *
 * Derived from the fixture rather than retyped because there are sixteen numbers per
 * image and a typo in an expectation is a test that passes for the wrong reason. The
 * fixture is the query's *input*, so comparing the output to it is the assertion, not a
 * tautology: a projection that drops `hotspot` answers `undefined` while the input still
 * holds the object.
 */
export function expectedImage(
  doc: FixtureDoc,
  field: string,
): {
  assetId: string;
  alt: { hr: string; en: string };
  hotspot: { x: number; y: number; width: number; height: number };
  crop: { top: number; bottom: number; left: number; right: number };
} {
  const img = doc[field] as FixtureImage | undefined;
  if (img === undefined) {
    throw new Error(`Fixture ${doc._id} has no \`${field}\` image to expect.`);
  }
  return {
    assetId: img.asset._ref,
    alt: { hr: img.alt.hr, en: img.alt.en },
    hotspot: {
      x: img.hotspot.x,
      y: img.hotspot.y,
      width: img.hotspot.width,
      height: img.hotspot.height,
    },
    crop: {
      top: img.crop.top,
      bottom: img.crop.bottom,
      left: img.crop.left,
      right: img.crop.right,
    },
  };
}

/* ----------------------------------------------------------------------- the clock */

/**
 * The instant `$now` is pinned to. Fixed, so the `$now` boundaries are boundaries and
 * not a race against the wall clock.
 *
 * Every datetime in here is produced by `Date#toISOString`, which is also how
 * `getEvents` and `getPosts` serialise `$now`. That matters: GROQ compares two strings
 * by code point, so `2026-06-01T12:00:00Z` and `2026-06-01T12:00:00.000Z` are the same
 * instant and *not* the same string. One spelling throughout makes "exactly `$now`" a
 * real equality rather than a lexicographic accident.
 */
export const NOW = new Date('2026-06-01T12:00:00.000Z');

const HOUR = 3_600_000;

/** An ISO instant offset from {@link NOW}, in the same spelling `$now` arrives in. */
export function at(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

/* -------------------------------------------------------------------- the documents */

/**
 * The singleton, including the three fields the real seed deliberately leaves empty.
 *
 * `phone`, `openingHours` and `shareImage` are optional in the schema and absent from
 * `sanity/seed/content.ndjson` — nothing on the site renders them and no real value
 * exists, and inventing one is how MUSE-36 happened. That makes this fixture the only
 * place their projections are ever exercised: a build against the seed cannot tell
 * `shareImage{...}` from `shareImag{...}`, because both answer `undefined`.
 */
export const SITE_SETTINGS_DOC: FixtureDoc = {
  _id: 'siteSettings',
  _type: 'siteSettings',
  studioName: 'Studio Fixture',
  tagline: localeString('tagline'),
  summary: localeText('summary'),
  address: 'Fixture Street 1, Fixture City',
  email: 'fixture@example.invalid',
  phone: '+00 0 000 0000',
  openingHours: localeString('opening hours'),
  social: [
    {
      _key: 'instagram',
      _type: 'socialLink',
      platform: 'instagram',
      url: 'https://example.invalid/instagram',
    },
    {
      _key: 'facebook',
      _type: 'socialLink',
      platform: 'facebook',
      url: 'https://example.invalid/facebook',
    },
    /**
     * `linktree` is here because the **footer links to it**, and the footer renders on
     * every page (MUSE-23).
     *
     * `socialUrl` fails the build naming the platform when `siteSettings` has no entry for
     * one the site links to — correctly, since a link with no href looks fine and goes
     * nowhere. Before this entry existed, `FULL` could drive the readers but could not
     * drive an `astro build`, which is what `test/aboutus.test.ts` needs in order to
     * assert on a page rather than on a return value. The three platforms here are the
     * three the real `siteSettings` carries.
     */
    {
      _key: 'linktree',
      _type: 'socialLink',
      platform: 'linktree',
      url: 'https://example.invalid/linktree',
    },
  ],
  shareImage: imageOf('Share', [0.11, 0.12, 0.13, 0.14], [0.15, 0.16, 0.17, 0.18]),
};

/**
 * One `page` document per route the site serves, so `getPageMeta()` is satisfiable.
 *
 * Built from `ROUTES` rather than listed, for the reason `sanity/schemaTypes/enums.ts`
 * gives: which routes exist is the registry's decision, and a fixture that hardcoded
 * four of them would start failing for the wrong reason the day a fifth page lands.
 */
export const PAGE_DOCS: FixtureDoc[] = ROUTES.map(({ route }, index) => ({
  _id: `page-fixture-${index}`,
  _type: 'page',
  route,
  name: localeString(`name ${index}`),
  title: localeString(`title ${index}`),
  description: localeString(`description ${index}`),
}));

/**
 * The studio's origin story — the other half of `/aboutus` (MUSE-23).
 *
 * A singleton, like `siteSettings`, so the query is `[0]` on a filter pinned to a fixed
 * `_id` and "there is no story yet" is a `null` rather than an empty array.
 *
 * Two paragraphs, not one. `story` is an array of bilingual paragraphs, and a projection
 * that returned only the first member — or flattened the array — would look right with a
 * single paragraph in the fixture.
 *
 * `foundedOn` is the dated part of the ticket's "dated origin story". It is an ISO date
 * because the *format* is the page's decision per locale (design system §10: HR
 * `13. kolovoza 2026.`, EN `13 August 2026`), the same reason an image carries a hotspot
 * rather than a URL.
 */
export const STUDIO_STORY_DOC: FixtureDoc = {
  _id: 'studioStory',
  _type: 'studioStory',
  heading: localeString('story heading'),
  foundedOn: '2026-08-13',
  story: [
    { _key: 'p1', _type: 'localeText', hr: 'HR story one.', en: 'EN story one.' },
    { _key: 'p2', _type: 'localeText', hr: 'HR story two.', en: 'EN story two.' },
  ],
};

/**
 * Three instructors, because the `coalesce` fallback needs three to be unambiguous.
 *
 * `INSTRUCTOR_A` regularly teaches `CLASS_ONE`, `INSTRUCTOR_B` and `INSTRUCTOR_A` together
 * teach `CLASS_TWO`, and `INSTRUCTOR_C` teaches no class — they exist only as the
 * slot-level override on `SLOT_TWO`. With two instructors the override and the fallback
 * can resolve to the same name by coincidence; with three, every branch of
 * `coalesce(instructors[]->name, class->instructors[]->name)` has its own answer.
 *
 * `order` is set on B alone. The query sorts by `coalesce(order, 999) asc, name asc`, so
 * the expected order is B, A, C — which is *not* alphabetical. A `coalesce` that stopped
 * working would sort A, B, C, and the assertion would see it.
 */
export const INSTRUCTOR_A: FixtureDoc = {
  _id: 'instructor-a',
  _type: 'instructor',
  name: 'Instructor A',
  slug: slug('instructor-a'),
  role: localeString('role A'),
  bio: localeText('bio A'),
  portrait: imageOf('PortraitA', [0.21, 0.22, 0.23, 0.24], [0.25, 0.26, 0.27, 0.28]),
  // The only instructor with an Instagram URL (MUSE-23). Optional in the schema, so it is
  // the one row that can tell `instagram` from `instagra` — the other two answer
  // `undefined` either way.
  instagram: 'https://example.invalid/instagram/instructor-a',
};

export const INSTRUCTOR_B: FixtureDoc = {
  _id: 'instructor-b',
  _type: 'instructor',
  name: 'Instructor B',
  slug: slug('instructor-b'),
  role: localeString('role B'),
  bio: localeText('bio B'),
  portrait: imageOf('PortraitB', [0.31, 0.32, 0.33, 0.34], [0.35, 0.36, 0.37, 0.38]),
  order: 0,
};

/**
 * **The instructor with no photograph and no bio**, which is every instructor today
 * (MUSE-23 for the portrait, MUSE-36 for the bio).
 *
 * `portrait` became optional in MUSE-23 for the reason `phone` did in MUSE-20: no
 * photography of this studio exists, so a `required()` portrait could only be satisfied by
 * uploading something that is not a portrait of the person. The page therefore has to have
 * a placeholder frame, and a placeholder frame nothing ever renders is a placeholder frame
 * nobody has checked — so one of the three fixture instructors goes without.
 *
 * `bio` followed in MUSE-36, when Mina and Antonio became the first two real `instructor`
 * documents and nobody had written a paragraph about either of them. The same argument
 * applies to the fixture: with all three rows carrying a bio, `bio` and a typo of it both
 * project a value on every row and `INSTRUCTORS_QUERY` could not tell them apart.
 *
 * C rather than a fourth document: `FULL_COUNTS` and the `coalesce(order, 999)` ordering
 * assertions are about three instructors, and a fourth would make them fail for a reason
 * that has nothing to do with portraits. C also teaches no class, so dropping its fields
 * cannot reach `CLASSES_QUERY`.
 */
export const INSTRUCTOR_C: FixtureDoc = {
  _id: 'instructor-c',
  _type: 'instructor',
  name: 'Instructor C',
  slug: slug('instructor-c'),
  role: localeString('role C'),
};

/**
 * Two classes, differing in every projected field.
 *
 * `order` is on CLASS_TWO alone and its `name.hr` sorts *after* CLASS_ONE's, so
 * `coalesce(order, 999) asc, name.hr asc` puts TWO first and plain `name.hr asc` would
 * put ONE first. The expected order therefore distinguishes the two.
 *
 * **One teaches alone and one is taught by two people** (MUSE-36). `instructors` is an
 * array, and an array projection has two things a single reference did not: a length and
 * an order. `CLASS_TWO` lists B **before** A, which is not alphabetical — so a projection
 * that sorted, de-duplicated or flattened the list is visible, and so is one that returns
 * only the first member.
 */
export const CLASS_ONE: FixtureDoc = {
  _id: 'class-one',
  _type: 'class',
  name: { _type: 'localeString', hr: 'Sat A', en: 'Class A' },
  slug: slug('class-one'),
  level: 'beginner',
  description: localeText('class one'),
  durationMin: 60,
  instructors: [reference('instructor-a')],
  image: imageOf('ClassOne', [0.51, 0.52, 0.53, 0.54], [0.05, 0.06, 0.07, 0.08]),
};

export const CLASS_TWO: FixtureDoc = {
  _id: 'class-two',
  _type: 'class',
  name: { _type: 'localeString', hr: 'Sat B', en: 'Class B' },
  slug: slug('class-two'),
  level: 'advanced',
  description: localeText('class two'),
  durationMin: 90,
  instructors: [reference('instructor-b'), reference('instructor-a')],
  image: imageOf('ClassTwo', [0.61, 0.62, 0.63, 0.64], [0.01, 0.02, 0.03, 0.04]),
  order: 0,
};

/**
 * Three slots: one that takes its teacher from the class, one that overrides it, and one
 * that is switched off.
 *
 * `SLOT_TWO` starts earlier than `SLOT_ONE`, so `order(start asc)` has something to do,
 * and it points at the *other* class — which is what proves the dereference is per-slot
 * rather than per-query. `SLOT_HIDDEN` is the `active == true` filter's only subject.
 */
export const SLOT_ONE: FixtureDoc = {
  _id: 'slot-one',
  _type: 'scheduleSlot',
  class: reference('class-one'),
  day: 'tue',
  start: '20:00',
  active: true,
};

/**
 * The override, and it **replaces** the class's two teachers with one (MUSE-36).
 *
 * `CLASS_TWO` is taught by B and A; this slot is taught by C alone. That is the case the
 * field exists for — one person standing in — and it is the shape a merging
 * implementation could not produce: a projection that concatenated the two lists would
 * answer three names, and one that took the class's list regardless would answer two.
 */
export const SLOT_TWO: FixtureDoc = {
  _id: 'slot-two',
  _type: 'scheduleSlot',
  class: reference('class-two'),
  day: 'thu',
  start: '18:30',
  instructors: [reference('instructor-c')],
  active: true,
};

export const SLOT_HIDDEN: FixtureDoc = {
  _id: 'slot-hidden',
  _type: 'scheduleSlot',
  class: reference('class-one'),
  day: 'wed',
  start: '07:00',
  active: false,
};

/** `order` on the dearer tier, so `coalesce(order, 999)` and `priceEur asc` disagree. */
export const TIER_ONE: FixtureDoc = {
  _id: 'tier-one',
  _type: 'pricingTier',
  name: localeString('tier one'),
  priceEur: 10,
  period: 'class',
  features: [localeString('feature one A'), localeString('feature one B')],
  featured: false,
};

export const TIER_TWO: FixtureDoc = {
  _id: 'tier-two',
  _type: 'pricingTier',
  name: localeString('tier two'),
  priceEur: 20,
  period: 'month',
  features: [localeString('feature two A')],
  featured: true,
  order: 0,
};

/**
 * Five events, four of which exist to pin the `$now` filter's edges.
 *
 * The filter is `(!defined(endsAt) && startsAt >= $now) || endsAt >= $now`, so both
 * halves need a subject on each side of the boundary:
 *
 *   `EVENT_PAST`        started an hour ago, no end       → dropped (first half, false)
 *   `EVENT_ENDED`       ended an hour ago                 → dropped (second half, false)
 *   `EVENT_ENDING_NOW`  ends exactly at `$now`            → kept  (second half, equal)
 *   `EVENT_STARTING_NOW`starts exactly at `$now`, no end  → kept  (first half, equal)
 *   `EVENT_FUTURE`      starts in two hours               → kept
 *
 * The two "exactly at `$now`" rows are the boundary. A test that only showed a past
 * event dropped and a future one kept would pass just as happily against `>` as against
 * `>=`, which is the off-by-one this schema actually invites.
 */
export const EVENT_PAST: FixtureDoc = {
  _id: 'event-past',
  _type: 'event',
  title: localeString('event past'),
  slug: slug('event-past'),
  eventType: 'party',
  startsAt: at(-HOUR),
  venue: 'Fixture Venue',
  description: localeText('event past'),
  image: imageOf('EventPast', [0.71, 0.72, 0.73, 0.74], [0.11, 0.12, 0.13, 0.14]),
};

export const EVENT_ENDED: FixtureDoc = {
  _id: 'event-ended',
  _type: 'event',
  title: localeString('event ended'),
  slug: slug('event-ended'),
  eventType: 'social',
  startsAt: at(-3 * HOUR),
  endsAt: at(-HOUR),
  venue: 'Fixture Venue',
  description: localeText('event ended'),
  image: imageOf('EventEnded', [0.72, 0.73, 0.74, 0.75], [0.12, 0.13, 0.14, 0.15]),
};

export const EVENT_ENDING_NOW: FixtureDoc = {
  _id: 'event-ending-now',
  _type: 'event',
  title: localeString('event ending now'),
  slug: slug('event-ending-now'),
  eventType: 'workshop',
  startsAt: at(-3 * HOUR),
  endsAt: at(0),
  venue: 'Fixture Venue',
  description: localeText('event ending now'),
  image: imageOf('EventEndingNow', [0.73, 0.74, 0.75, 0.76], [0.13, 0.14, 0.15, 0.16]),
};

export const EVENT_STARTING_NOW: FixtureDoc = {
  _id: 'event-starting-now',
  _type: 'event',
  title: localeString('event starting now'),
  slug: slug('event-starting-now'),
  eventType: 'bootcamp',
  startsAt: at(0),
  venue: 'Fixture Venue',
  description: localeText('event starting now'),
  image: imageOf('EventStartingNow', [0.74, 0.75, 0.76, 0.77], [0.14, 0.15, 0.16, 0.17]),
};

/** The one event carrying every optional field, so dropping one is visible. */
export const EVENT_FUTURE: FixtureDoc = {
  _id: 'event-future',
  _type: 'event',
  title: localeString('event future'),
  slug: slug('event-future'),
  eventType: 'party',
  startsAt: at(2 * HOUR),
  endsAt: at(4 * HOUR),
  venue: 'Fixture Venue',
  description: localeText('event future'),
  lineup: ['Guest A', 'Guest B'],
  ticketUrl: 'https://example.invalid/tickets',
  image: imageOf('EventFuture', [0.75, 0.76, 0.77, 0.78], [0.15, 0.16, 0.17, 0.18]),
};

/** `order` on the older photograph, so `coalesce(order, 999)` and `takenAt desc` disagree. */
export const GALLERY_ONE: FixtureDoc = {
  _id: 'gallery-one',
  _type: 'galleryImage',
  caption: localeString('gallery one'),
  takenAt: '2026-01-01',
  image: imageOf('GalleryOne', [0.81, 0.82, 0.83, 0.84], [0.21, 0.22, 0.23, 0.24]),
};

export const GALLERY_TWO: FixtureDoc = {
  _id: 'gallery-two',
  _type: 'galleryImage',
  caption: localeString('gallery two'),
  takenAt: '2025-01-01',
  image: imageOf('GalleryTwo', [0.82, 0.83, 0.84, 0.85], [0.22, 0.23, 0.24, 0.25]),
  order: 0,
};

/**
 * Three posts, pinning `publishedAt <= $now` on both sides and the `author->` deref.
 *
 * `POST_NOW` is published at exactly `$now` and must be kept; `POST_FUTURE` is an hour
 * later and must be dropped. `POST_EARLIER` is the only one with an `author`, which is
 * the projection's weakest point: `author` is optional, so `author->nam` returns
 * `undefined` and the decoder accepts it — a byline silently gone.
 */
export const POST_EARLIER: FixtureDoc = {
  _id: 'post-earlier',
  _type: 'post',
  title: localeString('post earlier'),
  slug: slug('post-earlier'),
  publishedAt: at(-48 * HOUR),
  excerpt: localeText('post earlier'),
  author: reference('instructor-a'),
  coverImage: imageOf('PostEarlier', [0.91, 0.92, 0.93, 0.94], [0.31, 0.32, 0.33, 0.34]),
  body: richText('post earlier'),
};

export const POST_NOW: FixtureDoc = {
  _id: 'post-now',
  _type: 'post',
  title: localeString('post now'),
  slug: slug('post-now'),
  publishedAt: at(0),
  excerpt: localeText('post now'),
  coverImage: imageOf('PostNow', [0.92, 0.93, 0.94, 0.95], [0.32, 0.33, 0.34, 0.35]),
  body: richText('post now'),
};

export const POST_FUTURE: FixtureDoc = {
  _id: 'post-future',
  _type: 'post',
  title: localeString('post future'),
  slug: slug('post-future'),
  publishedAt: at(HOUR),
  excerpt: localeText('post future'),
  coverImage: imageOf('PostFuture', [0.93, 0.94, 0.95, 0.96], [0.33, 0.34, 0.35, 0.36]),
  body: richText('post future'),
};

/** `order` on the question that sorts second, so the two sort clauses disagree. */
export const FAQ_ONE: FixtureDoc = {
  _id: 'faq-one',
  _type: 'faq',
  question: { _type: 'localeString', hr: 'Pitanje A?', en: 'Question A?' },
  answer: localeText('answer one'),
};

export const FAQ_TWO: FixtureDoc = {
  _id: 'faq-two',
  _type: 'faq',
  question: { _type: 'localeString', hr: 'Pitanje B?', en: 'Question B?' },
  answer: localeText('answer two'),
  order: 0,
};

/* ---------------------------------------------------------------------- drafts */

/**
 * **Unpublished drafts, which every query must behave as if it cannot see.**
 *
 * `src/lib/sanity/fixture.ts` drops `drafts.`-prefixed documents, the fixture's half of
 * `perspective: 'published'` in `client.ts`. MUSE-20's own suite proves that mechanism
 * works, through a draft `page` and a whole-build output comparison — but a `page` is one
 * of the *two* queries that were already executed. The nine that were not are exactly
 * where a leaked draft would go unnoticed, and they are the ones where it costs something:
 * a draft `scheduleSlot` is a class on the public timetable that nobody published, and a
 * draft `pricingTier` is the unfinished price `client.ts` names as the reason the flag
 * exists at all.
 *
 * So these sit in {@link FULL}, not in a dataset of their own. Every assertion in
 * `test/projections.test.ts` then runs against a dataset that contains drafts, and a
 * filter that stopped working is an extra row, a wrong order or a wrong count in whichever
 * query it reached — named, in a diff, rather than needing a test that thought to look.
 *
 * Both shapes a draft comes in are here, because they fail in opposite directions:
 *
 *   - **A draft twin of a published document** (`drafts.slot-one`). A leak is a
 *     *duplicate* — the same slot twice, once with Mina's unfinished edit. It starts at
 *     06:00 and points at the other class, so a leak is also a wrong first row.
 *   - **A draft with no published twin** (`drafts.tier-draft`,
 *     `drafts.instructor-draft`). A leak is a document the deploy is right to ignore
 *     appearing on the page. Both carry `order: -1`, so a leak sorts first.
 */
export const DRAFT_SLOT_TWIN: FixtureDoc = {
  _id: 'drafts.slot-one',
  _type: 'scheduleSlot',
  class: reference('class-two'),
  day: 'mon',
  start: '06:00',
  active: true,
};

export const DRAFT_TIER: FixtureDoc = {
  _id: 'drafts.tier-draft',
  _type: 'pricingTier',
  name: localeString('tier draft'),
  priceEur: 1,
  period: 'class',
  features: [localeString('feature draft')],
  featured: false,
  order: -1,
};

export const DRAFT_INSTRUCTOR: FixtureDoc = {
  _id: 'drafts.instructor-draft',
  _type: 'instructor',
  name: 'Instructor Draft',
  slug: slug('instructor-draft'),
  role: localeString('role draft'),
  bio: localeText('bio draft'),
  portrait: imageOf('PortraitDraft', [0.51, 0.52, 0.53, 0.54], [0.55, 0.56, 0.57, 0.58]),
  order: -1,
};

/** The three drafts, as one list — so a test can say how many are being ignored. */
export const DRAFTS: FixtureDoc[] = [DRAFT_SLOT_TWIN, DRAFT_TIER, DRAFT_INSTRUCTOR];

/* ------------------------------------------------------------------- the datasets */

/** One of everything. The dataset nearly every assertion in MUSE-44 reads. */
export const FULL: FixtureDoc[] = [
  SITE_SETTINGS_DOC,
  ...PAGE_DOCS,
  STUDIO_STORY_DOC,
  INSTRUCTOR_A,
  INSTRUCTOR_B,
  INSTRUCTOR_C,
  CLASS_ONE,
  CLASS_TWO,
  SLOT_ONE,
  SLOT_TWO,
  SLOT_HIDDEN,
  TIER_ONE,
  TIER_TWO,
  EVENT_PAST,
  EVENT_ENDED,
  EVENT_ENDING_NOW,
  EVENT_STARTING_NOW,
  EVENT_FUTURE,
  GALLERY_ONE,
  GALLERY_TWO,
  POST_EARLIER,
  POST_NOW,
  POST_FUTURE,
  FAQ_ONE,
  FAQ_TWO,
  // Drafts, which every query must behave as if it cannot see. In here rather than in a
  // dataset of their own, so every assertion in the suite runs with drafts present — see
  // the note above `DRAFT_SLOT_TWIN`.
  ...DRAFTS,
];

/**
 * How many documents of each type {@link FULL} holds. `DOCUMENT_COUNTS_QUERY`'s answer.
 *
 * **Drafts are not counted**, so `instructor` is 3 and `pricingTier` is 2 even though the
 * file holds a draft of each. That is the point: `count()` runs over the same filtered
 * dataset every other query sees, so a liveness probe that counted drafts would report a
 * dataset the build cannot read.
 */
export const FULL_COUNTS: Record<string, number> = {
  siteSettings: 1,
  studioStory: 1,
  page: PAGE_DOCS.length,
  class: 2,
  scheduleSlot: 3,
  instructor: 3,
  pricingTier: 2,
  event: 5,
  galleryImage: 2,
  post: 3,
  faq: 2,
};

/**
 * A slot whose `class` reference points at a document that is not in the dataset.
 *
 * The single most important row in this file. GROQ answers `class->_id` with `null` and
 * HTTP 200 — not an error — so without a decoder this publishes a schedule row with no
 * name, no level and no teacher, and the build exits 0.
 */
export const SLOT_DANGLING_CLASS: FixtureDoc = {
  _id: 'slot-dangling-class',
  _type: 'scheduleSlot',
  class: reference('class-that-was-deleted'),
  day: 'fri',
  start: '19:00',
  active: true,
};

/**
 * A class one of whose teachers has been deleted.
 *
 * The array makes this worse than it was, which is why it is modelled as a *partial*
 * loss (MUSE-36): `instructors[]->name` over `[deleted, A]` answers `[null, 'Instructor
 * A']`, so the list is still non-empty and a page that joined it would publish „ i
 * Instructor A" — a real teacher next to a blank. `textList` in
 * `src/lib/sanity/decode.ts` names the index instead.
 */
export const CLASS_DANGLING_INSTRUCTOR: FixtureDoc = {
  _id: 'class-dangling-instructor',
  _type: 'class',
  name: { _type: 'localeString', hr: 'Sat C', en: 'Class C' },
  slug: slug('class-dangling-instructor'),
  level: 'improver',
  description: localeText('class three'),
  durationMin: 75,
  instructors: [reference('instructor-that-was-deleted'), reference('instructor-a')],
  image: imageOf('ClassThree', [0.65, 0.66, 0.67, 0.68], [0.09, 0.1, 0.11, 0.12]),
};

export const SLOT_WITH_DANGLING_TEACHER: FixtureDoc = {
  _id: 'slot-dangling-teacher',
  _type: 'scheduleSlot',
  class: reference('class-dangling-instructor'),
  day: 'sat',
  start: '11:00',
  active: true,
};

/* -------------------------------------------------------------- pricing (MUSE-22) */

/**
 * **Tiers for `test/pricing.test.ts`, which renders the real component against them.**
 *
 * `TIER_ONE` and `TIER_TWO` above are shaped for `test/projections.test.ts` — they prove
 * the GROQ projection and the `coalesce` ordering, and their names come out of
 * `localeString()` as `HR tier one`. These are shaped for the other question: *is the
 * number on the card the number in the CMS?* So every value here is one a human can
 * check by eye in a failure message, every one is different from every other, and the
 * HR and EN halves differ — a card that rendered the wrong locale, the wrong tier or the
 * wrong field says so rather than coincidentally matching.
 *
 * **Nothing here may read as a price Mina might charge.** MUSE-36 is live right now
 * because invented-but-plausible placeholder content escaped a fixture, and a *price* is
 * worse than a timetable: somebody budgets around it, and it is a commercial claim. So
 * the amounts are `42`, `7` and `1234` — arithmetic, not a price list — and the packages
 * are `Tier A`, `Tier B`, `Tier C`. If any of these strings ever appears in `dist`, that
 * is the bug, and it should be obvious at a glance that it is.
 *
 * The three amounts also cover the three shapes `formatPrice` has to get right: two
 * digits, one digit, and four digits with a thousands separator that differs by language.
 */
function tierDoc(
  tag: string,
  priceEur: number,
  period: string,
  featured: boolean,
  order: number,
  features: readonly string[],
): FixtureDoc {
  return {
    _id: `pricing-tier-${tag.toLowerCase()}`,
    _type: 'pricingTier',
    name: { _type: 'localeString', hr: `Tier ${tag} HR`, en: `Tier ${tag} EN` },
    priceEur,
    period,
    features: features.map((feature) => ({
      _type: 'localeString',
      hr: `${feature} HR`,
      en: `${feature} EN`,
    })),
    featured,
    order,
  };
}

/** The featured one, when there is one. Two features, so the list is a list. */
export const PRICING_TIER_A: FixtureDoc = tierDoc('A', 42, 'class', true, 0, [
  'Feature A1',
  'Feature A2',
]);

export const PRICING_TIER_B: FixtureDoc = tierDoc('B', 7, 'month', false, 1, [
  'Feature B1',
]);

/** Four digits, so the thousands separator is exercised: `1.234 €` vs `€1,234`. */
export const PRICING_TIER_C: FixtureDoc = tierDoc('C', 1234, 'package', false, 2, [
  'Feature C1',
]);

/**
 * Each dataset carries the singleton (the form reads the studio inbox from it) and the
 * draft tier from {@link DRAFTS}, so every assertion about the rendered page also runs
 * against a dataset holding a tier nobody published — the unfinished price
 * `src/lib/sanity/client.ts` names as the reason `perspective: 'published'` exists.
 * `DRAFT_TIER` carries `order: -1`, so a leak is the *first* card on the page.
 */
const withFixtures = (...tiers: FixtureDoc[]): FixtureDoc[] => [
  SITE_SETTINGS_DOC,
  DRAFT_TIER,
  ...tiers,
];

/** One tier ticked as featured: the state the acceptance criterion describes. */
export const PRICING_ONE_FEATURED: FixtureDoc[] = withFixtures(
  PRICING_TIER_A,
  PRICING_TIER_B,
  PRICING_TIER_C,
);

/** Two ticked. Nothing in the schema stops this; the page has to decide. */
export const PRICING_TWO_FEATURED: FixtureDoc[] = withFixtures(
  PRICING_TIER_A,
  { ...PRICING_TIER_B, featured: true },
  PRICING_TIER_C,
);

/** None ticked. A price list with nothing singled out is still a price list. */
export const PRICING_NONE_FEATURED: FixtureDoc[] = withFixtures(
  { ...PRICING_TIER_A, featured: false },
  PRICING_TIER_B,
  PRICING_TIER_C,
);

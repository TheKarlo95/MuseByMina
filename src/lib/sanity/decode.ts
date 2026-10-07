import type { Locale } from '../i18n';
import { LEVELS, STYLES, WEEKDAYS, type ClassEntry } from '../schedule';

/**
 * Turning a GROQ answer into something a page may render — or failing loudly.
 *
 * The failure mode this module exists to prevent is specific, and it is the one MUSE-19
 * calls out: **a silent empty result**. GROQ does not error on a field that does not
 * exist. Rename `question` to `prompt` in the schema and
 *
 *     *[_type == "faq"]{ question }
 *
 * keeps returning HTTP 200, with `question: null` on every row. A template that maps
 * over the rows then renders an accordion of empty `<summary>` elements, the build
 * exits 0, and the page ships. Nothing in Astro, GROQ or TypeScript objects, because
 * every one of them was told the truth: the query ran, the array was not empty, the
 * field was simply null.
 *
 * So every document is decoded through here before a page sees it, and a decode
 * failure:
 *
 *   - names the document — its `_id`, which is what Mina needs to find it in the
 *     Studio, and its type;
 *   - names the field path — `bio.en`, not "a required field";
 *   - says what was expected and what arrived.
 *
 * And three outcomes are kept apart, because collapsing them is how this gets missed:
 *
 *   `SanityUnavailableError`  the API did not answer. Infrastructure.
 *   `SanityContentError`      it answered, and the content is wrong or absent. Mina's.
 *   an empty-but-valid result the caller explicitly said was acceptable.
 *
 * Nothing here imports `@sanity/client`, so it is all directly testable —
 * `test/sanity.test.ts` decodes hand-written documents, including broken ones, with no
 * network and no build.
 */

/** The API could not be reached, or did not answer with a result. Not a content fault. */
export class SanityUnavailableError extends Error {
  override readonly name = 'SanityUnavailableError';
}

/** The API answered and the content is missing or malformed. Names the document. */
export class SanityContentError extends Error {
  override readonly name = 'SanityContentError';
}

/** Where a value came from, so an error can point at it. */
interface Where {
  /** Document type, e.g. `instructor`. */
  type: string;
  /** Document `_id`, or `'(no _id)'` when even that is missing. */
  id: string;
  /** Field path within the document, e.g. `bio.en`. */
  path: string;
}

function fail(where: Where, expected: string, got: unknown): never {
  throw new SanityContentError(
    `Sanity document "${where.id}" (type \`${where.type}\`) is unusable: ` +
      `field \`${where.path}\` should be ${expected}, got ${render(got)}. ` +
      `Open it in the Studio and fix it — the build stops here rather than publishing ` +
      `a page with a hole in it.`,
  );
}

/** A value, short enough for one line of a build log. */
function render(value: unknown): string {
  if (value === undefined) return 'nothing (the field is absent, or GROQ returned null)';
  if (value === null) return 'null (the field is absent, or was never filled in)';
  const json = JSON.stringify(value);
  return json.length > 120 ? `${json.slice(0, 117)}…` : json;
}

function at(where: Where, segment: string): Where {
  return { ...where, path: where.path ? `${where.path}.${segment}` : segment };
}

/** Field lookup that treats a missing key and an explicit `null` the same way. */
function read(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key] ?? undefined;
}

/* ------------------------------------------------------------------ primitives */

export function text(doc: unknown, path: string, where: Where): string {
  const value = read(doc, path);
  if (typeof value !== 'string' || value.trim() === '') {
    fail(at(where, path), 'a non-empty string', value);
  }
  return value;
}

export function optionalText(doc: unknown, path: string, where: Where): string | undefined {
  const value = read(doc, path);
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    fail(at(where, path), 'a non-empty string, or nothing at all', value);
  }
  return value;
}

export function integer(doc: unknown, path: string, where: Where): number {
  const value = read(doc, path);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(at(where, path), 'a number', value);
  }
  return value;
}

export function flag(doc: unknown, path: string, where: Where, fallback: boolean): boolean {
  const value = read(doc, path);
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(at(where, path), 'true or false', value);
  return value;
}

/** One of a closed set — the structure half of the content/structure split. */
export function oneOf<T extends string>(
  doc: unknown,
  path: string,
  where: Where,
  allowed: readonly T[],
): T {
  const value = read(doc, path);
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(at(where, path), `one of ${allowed.map((v) => `\`${v}\``).join(', ')}`, value);
  }
  return value as T;
}

/**
 * A bilingual value, as `Record<Locale, string>`.
 *
 * The payoff of the two-named-fields decision (see `sanity/schemaTypes/objects/locale.ts`):
 * a half-translated string is a *missing field*, which this can name — `title.en` — and
 * not an absent array member, which it could only report as "the array is short".
 */
export function localised(doc: unknown, path: string, where: Where): Record<Locale, string> {
  const value = read(doc, path);
  if (typeof value !== 'object' || value === null) {
    fail(at(where, path), 'an object with `hr` and `en`', value);
  }
  return {
    hr: text(value, 'hr', at(where, path)),
    en: text(value, 'en', at(where, path)),
  };
}

export function optionalLocalised(
  doc: unknown,
  path: string,
  where: Where,
): Record<Locale, string> | undefined {
  return read(doc, path) === undefined ? undefined : localised(doc, path, where);
}

/* --------------------------------------------------------------------- images */

/**
 * An image as a page needs it: which asset, what it shows, and where the hotspot is.
 *
 * No URL. The ratio is the page's decision — the design system crops the same upload to
 * 16:9, 4:5, 3:4 and 1:1 (§9 rule 4) — so resolving a URL here would mean resolving it
 * for one ratio and losing the rest.
 */
export interface ImageRef {
  /** Sanity asset id, e.g. `image-abc123-1600x900-jpg`. */
  assetId: string;
  alt: Record<Locale, string>;
  /** Present once Mina has moved it. Absent means "crop from the centre". */
  hotspot?: { x: number; y: number; width: number; height: number };
  crop?: { top: number; bottom: number; left: number; right: number };
}

function hotspotOf(doc: unknown, where: Where): ImageRef['hotspot'] {
  const value = read(doc, 'hotspot');
  if (value === undefined) return undefined;
  const spot = at(where, 'hotspot');
  return {
    x: integer(value, 'x', spot),
    y: integer(value, 'y', spot),
    width: integer(value, 'width', spot),
    height: integer(value, 'height', spot),
  };
}

function cropOf(doc: unknown, where: Where): ImageRef['crop'] {
  const value = read(doc, 'crop');
  if (value === undefined) return undefined;
  const crop = at(where, 'crop');
  return {
    top: integer(value, 'top', crop),
    bottom: integer(value, 'bottom', crop),
    left: integer(value, 'left', crop),
    right: integer(value, 'right', crop),
  };
}

export function image(doc: unknown, path: string, where: Where): ImageRef {
  const value = read(doc, path);
  if (typeof value !== 'object' || value === null) {
    fail(at(where, path), 'an uploaded image', value);
  }
  const here = at(where, path);
  return {
    assetId: text(value, 'assetId', here),
    alt: localised(value, 'alt', here),
    hotspot: hotspotOf(value, here),
    crop: cropOf(value, here),
  };
}

export function optionalImage(doc: unknown, path: string, where: Where): ImageRef | undefined {
  return read(doc, path) === undefined ? undefined : image(doc, path, where);
}

/* ------------------------------------------------------------- document frames */

/**
 * The `_id`/`_type` frame every decoder starts from.
 *
 * A document without an `_id` is not a document; that is a sign the projection lost it,
 * which is a query bug rather than a content bug, so it says so.
 */
export function frame(doc: unknown, type: string): Where {
  const id = read(doc, '_id');
  if (typeof id !== 'string' || id === '') {
    throw new SanityContentError(
      `A \`${type}\` result has no \`_id\`. Every query in \`src/lib/sanity/queries.ts\` ` +
        `projects \`_id\` precisely so an error can name the document — so this is a ` +
        `query that lost it, not a document that lacks one. Got: ${render(doc)}`,
    );
  }
  return { type, id, path: '' };
}

/**
 * Assert that a query answered with a list, and distinguish "nothing" from "broken".
 *
 * `minimum` is the caller's statement about the page it is building. A page that renders
 * a grid of instructors is a broken page with zero instructors, so it passes `1` and
 * gets a build failure naming the type. A page that renders "no upcoming events" is a
 * correct page with zero events, so it passes `0` and gets an empty array.
 *
 * The empty-set message is deliberately explicit that the query *ran*. The dataset is
 * empty until MUSE-20, so the same symptom — nothing on the page — will be true for a
 * while for entirely legitimate reasons, and whoever reads this log in three weeks needs
 * to be told which of the two it is rather than guessing.
 */
export function requireDocuments<T>(
  rows: unknown,
  type: string,
  decode: (row: unknown) => T,
  minimum = 1,
): T[] {
  if (!Array.isArray(rows)) {
    throw new SanityUnavailableError(
      `The query for \`${type}\` did not return a list (got ${render(rows)}). ` +
        `A GROQ projection over a filter always returns an array, so this is a transport ` +
        `or configuration problem, not missing content.`,
    );
  }

  if (rows.length < minimum) {
    throw new SanityContentError(
      `The dataset holds ${rows.length} \`${type}\` document(s); this page needs at ` +
        `least ${minimum}. The query ran and the API answered — this is an empty ` +
        `dataset, not a broken query. Add the document(s) in the Studio, or give the ` +
        `page a path for having none.`,
    );
  }

  return rows.map(decode);
}

/** The singleton case: exactly one document, at a known `_id`. */
export function requireDocument<T>(row: unknown, type: string, decode: (row: unknown) => T): T {
  if (row === null || row === undefined) {
    throw new SanityContentError(
      `There is no \`${type}\` document in the dataset. The query ran and the API ` +
        `answered with nothing, which for a singleton means it has never been created. ` +
        `Open the Studio and fill it in.`,
    );
  }
  return decode(row);
}

/* ----------------------------------------------------------------- the entities */

export interface SiteSettings {
  id: string;
  studioName: string;
  tagline: Record<Locale, string>;
  summary: Record<Locale, string>;
  address: string;
  email: string;
  phone: string;
  openingHours: Record<Locale, string>;
  social: { platform: string; url: string }[];
  shareImage?: ImageRef;
}

export function decodeSiteSettings(row: unknown): SiteSettings {
  const where = frame(row, 'siteSettings');
  const social = read(row, 'social');
  return {
    id: where.id,
    studioName: text(row, 'studioName', where),
    tagline: localised(row, 'tagline', where),
    summary: localised(row, 'summary', where),
    address: text(row, 'address', where),
    email: text(row, 'email', where),
    phone: text(row, 'phone', where),
    openingHours: localised(row, 'openingHours', where),
    social: (Array.isArray(social) ? social : []).map((entry, index) => {
      const here = at(where, `social[${index}]`);
      return { platform: text(entry, 'platform', here), url: text(entry, 'url', here) };
    }),
    shareImage: optionalImage(row, 'shareImage', where),
  };
}

/** Mirrors `PageMeta` in `src/lib/pages.ts`, so MUSE-20 is an assignment. */
export interface PageMetaDoc {
  id: string;
  route: string;
  name: Record<Locale, string>;
  title: Record<Locale, string>;
  description: Record<Locale, string>;
}

export function decodePage(row: unknown): PageMetaDoc {
  const where = frame(row, 'page');
  return {
    id: where.id,
    route: text(row, 'route', where),
    name: localised(row, 'name', where),
    title: localised(row, 'title', where),
    description: localised(row, 'description', where),
  };
}

/**
 * A schedule row, decoded straight into the existing `ClassEntry`.
 *
 * `satisfies ClassEntry` is not decoration: it is the compile-time half of the promise
 * that MUSE-20 is a prop change. `Schedule.astro` already takes `ClassEntry[]`, so if
 * this ever stops producing one, the type error arrives before the page does.
 */
export interface ScheduleEntry extends ClassEntry {
  id: string;
  classId: string;
  name: Record<Locale, string>;
}

export function decodeScheduleEntry(row: unknown): ScheduleEntry {
  const where = frame(row, 'scheduleSlot');
  const start = text(row, 'start', where);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(start)) {
    fail(at(where, 'start'), 'a 24-hour time like `19:00`', start);
  }
  return {
    id: where.id,
    classId: text(row, 'classId', where),
    name: localised(row, 'name', where),
    day: oneOf(row, 'day', where, WEEKDAYS),
    start,
    durationMin: integer(row, 'durationMin', where),
    style: oneOf(row, 'style', where, STYLES),
    level: oneOf(row, 'level', where, LEVELS),
    instructor: text(row, 'instructor', where),
  };
}

export interface DanceClass {
  id: string;
  slug: string;
  name: Record<Locale, string>;
  style: (typeof STYLES)[number];
  level: (typeof LEVELS)[number];
  description: Record<Locale, string>;
  durationMin: number;
  instructor: string;
  image: ImageRef;
}

export function decodeClass(row: unknown): DanceClass {
  const where = frame(row, 'class');
  return {
    id: where.id,
    slug: text(row, 'slug', where),
    name: localised(row, 'name', where),
    style: oneOf(row, 'style', where, STYLES),
    level: oneOf(row, 'level', where, LEVELS),
    description: localised(row, 'description', where),
    durationMin: integer(row, 'durationMin', where),
    instructor: text(row, 'instructor', where),
    image: image(row, 'image', where),
  };
}

export interface Instructor {
  id: string;
  name: string;
  slug: string;
  role: Record<Locale, string>;
  bio: Record<Locale, string>;
  portrait: ImageRef;
}

export function decodeInstructor(row: unknown): Instructor {
  const where = frame(row, 'instructor');
  return {
    id: where.id,
    name: text(row, 'name', where),
    slug: text(row, 'slug', where),
    role: localised(row, 'role', where),
    bio: localised(row, 'bio', where),
    portrait: image(row, 'portrait', where),
  };
}

export interface PricingTier {
  id: string;
  name: Record<Locale, string>;
  priceEur: number;
  period: string;
  features: Record<Locale, string>[];
  featured: boolean;
}

export function decodePricingTier(row: unknown): PricingTier {
  const where = frame(row, 'pricingTier');
  const features = read(row, 'features');
  if (!Array.isArray(features) || features.length === 0) {
    fail(at(where, 'features'), 'a list with at least one entry', features);
  }
  return {
    id: where.id,
    name: localised(row, 'name', where),
    priceEur: integer(row, 'priceEur', where),
    period: text(row, 'period', where),
    features: features.map((_, index) => localisedAt(features, index, where)),
    featured: flag(row, 'featured', where, false),
  };
}

/** One entry of a `localeString` array, named by index so an error points at the row. */
function localisedAt(
  list: readonly unknown[],
  index: number,
  where: Where,
): Record<Locale, string> {
  const here = at(where, `features[${index}]`);
  const entry = list[index];
  if (typeof entry !== 'object' || entry === null) {
    fail(here, 'an object with `hr` and `en`', entry);
  }
  return { hr: text(entry, 'hr', here), en: text(entry, 'en', here) };
}

export interface StudioEvent {
  id: string;
  slug: string;
  title: Record<Locale, string>;
  eventType: string;
  startsAt: string;
  endsAt?: string;
  venue: string;
  description: Record<Locale, string>;
  lineup: string[];
  ticketUrl?: string;
  image: ImageRef;
}

export function decodeEvent(row: unknown): StudioEvent {
  const where = frame(row, 'event');
  const lineup = read(row, 'lineup');
  return {
    id: where.id,
    slug: text(row, 'slug', where),
    title: localised(row, 'title', where),
    eventType: text(row, 'eventType', where),
    startsAt: text(row, 'startsAt', where),
    endsAt: optionalText(row, 'endsAt', where),
    venue: text(row, 'venue', where),
    description: localised(row, 'description', where),
    lineup: Array.isArray(lineup)
      ? lineup.map((_, index) => text(lineup, String(index), at(where, 'lineup')))
      : [],
    ticketUrl: optionalText(row, 'ticketUrl', where),
    image: image(row, 'image', where),
  };
}

export interface GalleryImage {
  id: string;
  caption?: Record<Locale, string>;
  takenAt?: string;
  image: ImageRef;
}

export function decodeGalleryImage(row: unknown): GalleryImage {
  const where = frame(row, 'galleryImage');
  return {
    id: where.id,
    caption: optionalLocalised(row, 'caption', where),
    takenAt: optionalText(row, 'takenAt', where),
    image: image(row, 'image', where),
  };
}

export interface Post {
  id: string;
  slug: string;
  title: Record<Locale, string>;
  publishedAt: string;
  excerpt: Record<Locale, string>;
  author?: string;
  coverImage: ImageRef;
  /** Portable Text, per locale. Rendered by whatever MUSE-20 picks; opaque here. */
  body: Record<Locale, unknown[]>;
}

export function decodePost(row: unknown): Post {
  const where = frame(row, 'post');
  const body = read(row, 'body');
  const hr = read(body, 'hr');
  const en = read(body, 'en');
  for (const [locale, blocks] of [
    ['hr', hr],
    ['en', en],
  ] as const) {
    if (!Array.isArray(blocks) || blocks.length === 0) {
      fail(at(where, `body.${locale}`), 'at least one paragraph of text', blocks);
    }
  }
  return {
    id: where.id,
    slug: text(row, 'slug', where),
    title: localised(row, 'title', where),
    publishedAt: text(row, 'publishedAt', where),
    excerpt: localised(row, 'excerpt', where),
    author: optionalText(row, 'author', where),
    coverImage: image(row, 'coverImage', where),
    body: { hr: hr as unknown[], en: en as unknown[] },
  };
}

export interface Faq {
  id: string;
  question: Record<Locale, string>;
  answer: Record<Locale, string>;
}

export function decodeFaq(row: unknown): Faq {
  const where = frame(row, 'faq');
  return {
    id: where.id,
    question: localised(row, 'question', where),
    answer: localised(row, 'answer', where),
  };
}

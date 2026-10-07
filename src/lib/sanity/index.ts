import { runQuery, sanitySource, type SanitySource } from './client';
import {
  decodeClass,
  decodeEvent,
  decodeFaq,
  decodeGalleryImage,
  decodeInstructor,
  decodePage,
  decodePost,
  decodePricingTier,
  decodeScheduleEntry,
  decodeSiteSettings,
  requireDocument,
  requireDocuments,
} from './decode';
import {
  CLASSES_QUERY,
  DOCUMENT_COUNTS_QUERY,
  EVENTS_QUERY,
  FAQS_QUERY,
  GALLERY_QUERY,
  INSTRUCTORS_QUERY,
  PAGES_QUERY,
  POSTS_QUERY,
  PRICING_QUERY,
  SCHEDULE_QUERY,
  SITE_SETTINGS_QUERY,
} from './queries';

/**
 * **The typed read path. The only module a page may import.**
 *
 * One entry point per thing a page needs, each one: run the query → prove the API
 * answered → decode every document or fail naming it. A caller gets either a fully
 * validated value or an exception; there is no third state and nothing to remember.
 *
 * The `minimum` argument on the list readers is the interesting part. It is where a page
 * says what "empty" means *for that page*, which is the only place that can be decided:
 *
 *     await getInstructors()        // an instructors page with nobody on it is broken
 *     await getEvents({ minimum: 0 })  // "no events announced yet" is a real state
 *
 * The default is `1`, so forgetting to think about it fails the build rather than
 * shipping a blank section. The dataset is empty until MUSE-20, which is exactly why
 * that default is the strict one.
 *
 * `test/sanity.test.ts` fails if any other file under `src/` imports `@sanity/client` or
 * contains a GROQ query, so "no ad-hoc GROQ in components" is a test, not a convention.
 */

export type {
  DanceClass,
  Faq,
  GalleryImage,
  ImageRef,
  Instructor,
  PageMetaDoc,
  Post,
  PricingTier,
  ScheduleEntry,
  SiteSettings,
  StudioEvent,
} from './decode';
export { SanityContentError, SanityUnavailableError } from './decode';
export type { SanitySource } from './client';

/** Which project and dataset this build is reading from. For build logs. */
export function source(): SanitySource {
  return sanitySource();
}

export interface ListOptions {
  /** Fewest documents this page can render. Below it, the build fails naming the type. */
  minimum?: number;
}

export async function getSiteSettings() {
  const row = await runQuery<unknown>(SITE_SETTINGS_QUERY);
  return requireDocument(row, 'siteSettings', decodeSiteSettings);
}

export async function getPageMeta({ minimum = 1 }: ListOptions = {}) {
  const rows = await runQuery<unknown>(PAGES_QUERY);
  return requireDocuments(rows, 'page', decodePage, minimum);
}

/**
 * The weekly schedule, as `ClassEntry[]` plus ids.
 *
 * Drops straight into `Schedule.astro`, which already takes its rows as a prop and only
 * defaults to `src/data/schedule.ts` — so MUSE-20 is the one-line change that file's
 * header comment predicts, and the grid, the filters, the Croatian session counts and
 * both layouts move with nothing.
 */
export async function getSchedule({ minimum = 1 }: ListOptions = {}) {
  const rows = await runQuery<unknown>(SCHEDULE_QUERY);
  return requireDocuments(rows, 'scheduleSlot', decodeScheduleEntry, minimum);
}

export async function getClasses({ minimum = 1 }: ListOptions = {}) {
  const rows = await runQuery<unknown>(CLASSES_QUERY);
  return requireDocuments(rows, 'class', decodeClass, minimum);
}

export async function getInstructors({ minimum = 1 }: ListOptions = {}) {
  const rows = await runQuery<unknown>(INSTRUCTORS_QUERY);
  return requireDocuments(rows, 'instructor', decodeInstructor, minimum);
}

export async function getPricingTiers({ minimum = 1 }: ListOptions = {}) {
  const rows = await runQuery<unknown>(PRICING_QUERY);
  return requireDocuments(rows, 'pricingTier', decodePricingTier, minimum);
}

/** Upcoming events. `now` is a parameter so two builds of one commit agree. */
export async function getEvents({
  minimum = 1,
  now = new Date(),
}: ListOptions & { now?: Date } = {}) {
  const rows = await runQuery<unknown>(EVENTS_QUERY, { now: now.toISOString() });
  return requireDocuments(rows, 'event', decodeEvent, minimum);
}

export async function getGallery({ minimum = 1 }: ListOptions = {}) {
  const rows = await runQuery<unknown>(GALLERY_QUERY);
  return requireDocuments(rows, 'galleryImage', decodeGalleryImage, minimum);
}

export async function getPosts({
  minimum = 1,
  now = new Date(),
}: ListOptions & { now?: Date } = {}) {
  const rows = await runQuery<unknown>(POSTS_QUERY, { now: now.toISOString() });
  return requireDocuments(rows, 'post', decodePost, minimum);
}

export async function getFaqs({ minimum = 1 }: ListOptions = {}) {
  const rows = await runQuery<unknown>(FAQS_QUERY);
  return requireDocuments(rows, 'faq', decodeFaq, minimum);
}

/**
 * How many documents of each type the dataset holds.
 *
 * Not used to render anything. It is the answer to "did the query break, or is the
 * dataset empty?" — a reachable, parseable dataset answers with a row of zeros, and an
 * unreachable one throws `SanityUnavailableError`. Worth logging once per build while
 * the dataset is still being filled.
 */
export async function countDocuments(): Promise<Record<string, number>> {
  const counts = await runQuery<unknown>(DOCUMENT_COUNTS_QUERY);
  if (typeof counts !== 'object' || counts === null) {
    throw new Error(`Expected a map of document counts, got ${JSON.stringify(counts)}.`);
  }
  return counts as Record<string, number>;
}

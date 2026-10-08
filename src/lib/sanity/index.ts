import { ROUTES, inertRouteWarning } from '../pages';
import { runQuery, sanitySource, type SanitySource } from './client';
import {
  SanityContentError,
  type PageMetaDoc,
  type SiteSettings,
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
  decodeStudioStory,
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
  STUDIO_STORY_QUERY,
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
 * shipping a blank section. Most of the dataset is still empty — MUSE-20 filled in the
 * singleton and the page documents, and nothing else — which is exactly why that default
 * is the strict one.
 *
 * `test/sanity.test.ts` fails if any other file under `src/` imports `@sanity/client` or
 * contains a GROQ query, so "no ad-hoc GROQ in components" is a test, not a convention.
 *
 * ---
 *
 * **"The only module a page may import" is now a test, not a sentence.**
 *
 * MUSE-19 wrote down the hole and left it open because there was nothing to protect yet:
 * `import { runQuery } from '../lib/sanity/client'` plus `import { FAQS_QUERY } from
 * '../lib/sanity/queries'` is two ordinary imports of two sibling modules, it yields raw
 * rows with no decoding at all, and nothing about those two lines is unusual enough for
 * the GROQ or `@sanity/client` guards to see.
 *
 * MUSE-20 is where pages arrived, so the check it specified is now in
 * `test/sanity.test.ts`: for every file under `src/` that is not itself under
 * `src/lib/sanity/`, an import specifier ending in `lib/sanity` is allowed and one
 * containing `lib/sanity/` fails, naming the file and the specifier. The modules in here
 * go on importing each other freely — the rule is about crossing the directory boundary.
 *
 * ---
 *
 * **Each reader is memoised for the life of the build.**
 *
 * `Footer.astro` reads the singleton, and it renders on nine pages; `TrialForm.astro`
 * reads it too, on two of them. Without memoisation that is a dozen identical HTTP
 * requests per build for one document that cannot change while the build runs. The cache
 * is a promise rather than a value, so concurrent renders share one request, and it lives
 * for the process — a build is one process, and the next build starts a new one.
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
  StudioStory,
} from './decode';
export { SanityContentError, SanityUnavailableError, addressLines, socialUrl } from './decode';
export type { SanitySource } from './client';
/**
 * Resolving an image ref to a URL, at the point of use.
 *
 * Here rather than in `./decode.ts` for the reason that module states: a decoded image
 * carries the asset and the hotspot, never a URL, because the ratio is the page's
 * decision. `./images.ts` has the long note on why the ratio crop is CSS's job and the
 * CDN is only asked for a width.
 */
export { imageFocus, imageSrc } from './images';
export type { ImageFocus, ImageSrcOptions } from './images';

/** Which project and dataset this build is reading from. For build logs. */
export function source(): SanitySource {
  return sanitySource();
}

export interface ListOptions {
  /** Fewest documents this page can render. Below it, the build fails naming the type. */
  minimum?: number;
}

let settings: Promise<SiteSettings> | undefined;

/** The site-wide singleton: studio name, tagline, summary, address, email, socials. */
export async function getSiteSettings(): Promise<SiteSettings> {
  settings ??= (async () => {
    const row = await runQuery<unknown>(SITE_SETTINGS_QUERY);
    return requireDocument(row, 'siteSettings', decodeSiteSettings);
  })();
  return settings;
}

let pages: Promise<Map<string, PageMetaDoc>> | undefined;

/**
 * Every `page` document, keyed by route, with the routes the site serves guaranteed.
 *
 * The guarantee is the part worth having. `requireDocuments` can say "there are fewer
 * than one of these"; it cannot say "the one for `/privacy` is missing", and a build that
 * is missing exactly one document renders exactly one page with an empty `<title>` and an
 * absent `<meta name="description">` — and `test/seo.test.ts` is the only thing that
 * would have noticed, after the fact. So the shortfall is named here, per route, before
 * any page renders.
 *
 * A duplicate is just as bad in the other direction: two documents for `/schedule` means
 * the page's title depends on which one GROQ returns first, which is not a thing anybody
 * can debug from the output. The Studio's fixed route list makes both unlikely and
 * neither impossible — a document outlives the route it was written for.
 *
 * **`minimum` is 0 on purpose, and that is load-bearing.** It used to be `ROUTES.length`,
 * which looks stricter and was strictly worse: `requireDocuments` counts, so with three of
 * four documents present it threw first and said "the dataset holds 3 `page` document(s);
 * this page needs at least 4 … this is an empty dataset", naming neither the route nor the
 * document and offering a remedy — "give the page a path for having none" — that does not
 * exist for `page`. The per-route message below, the one written for exactly this failure,
 * could then only fire when the count happened to come out right, which is the one case
 * that is *not* the common one. The count check is the wrong instrument here because this
 * reader knows precisely which documents it wants, so it does the reporting itself.
 */
async function pagesByRoute(): Promise<Map<string, PageMetaDoc>> {
  pages ??= (async () => {
    const rows = await runQuery<unknown>(PAGES_QUERY);
    const documents = requireDocuments(rows, 'page', decodePage, 0);

    // MUSE-46, and before the checks below rather than after: a document for a route the
    // site does not serve is inert, so it is a warning and not a failure — but it has to
    // be *said* even on a build that is about to fail for a different reason. The whole
    // decision, and why this strength and not another, is at `inertRouteWarning`.
    const inert = inertRouteWarning(documents);
    if (inert !== undefined) console.warn(inert);

    const byRoute = new Map<string, PageMetaDoc>();
    const duplicated: string[] = [];
    for (const document of documents) {
      if (byRoute.has(document.route)) duplicated.push(document.route);
      byRoute.set(document.route, document);
    }

    const missing = ROUTES.filter(({ route }) => !byRoute.has(route)).map((r) => r.route);
    if (missing.length > 0 || duplicated.length > 0) {
      throw new SanityContentError(
        [
          `The \`page\` documents do not match the routes the site serves.`,
          missing.length > 0
            ? `  No \`page\` document describes: ${missing.join(', ')}. Add one in the ` +
              `Studio under „Naslovi i opisi stranica” and pick that route — without it ` +
              `the page would publish with an empty <title> and no description. The query ` +
              `ran and the API answered, so this is a document that is not there, not a ` +
              `broken read path.`
            : '',
          duplicated.length > 0
            ? `  More than one \`page\` document describes: ${duplicated.join(', ')}. ` +
              `Which title the page gets would depend on query order; open „Naslovi i ` +
              `opisi stranica” and delete the spare.`
            : '',
          `  Routes the site serves: ${ROUTES.map((r) => r.route).join(', ')}.`,
          `  Documents found: ${
            documents.length === 0
              ? 'none at all'
              : documents.map((d) => `${d.route} (${d.id})`).join(', ')
          }.`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    return byRoute;
  })();
  return pages;
}

/**
 * The `page` documents, in the order `src/lib/pages.ts` lists the routes.
 *
 * Not in `PAGES_QUERY`'s `order(route asc)`: `llms.txt` lists the pages in the order a
 * reader should meet them — home first — which is the registry's order and not
 * alphabetical. The query sorts for determinism; the site decides presentation.
 */
export async function getPageMeta(): Promise<PageMetaDoc[]> {
  const byRoute = await pagesByRoute();
  return ROUTES.map(({ route }) => byRoute.get(route)!);
}

/** The `page` document for one route. Fails naming the route if there is none. */
export async function getPage(route: string): Promise<PageMetaDoc> {
  const byRoute = await pagesByRoute();
  const document = byRoute.get(route);
  if (!document) {
    throw new SanityContentError(
      `No \`page\` document describes the route "${route}", and a page asked for it. ` +
        `Either it is missing from the Studio, or the route is not in \`ROUTES\` in ` +
        `\`src/lib/pages.ts\` — which is what the Studio builds its route list from.`,
    );
  }
  return document;
}

/**
 * The weekly schedule, as `ClassEntry[]` plus ids.
 *
 * Drops straight into `Schedule.astro` and `Home.astro`, which both take their rows as a
 * prop — the one-line change `src/data/schedule.ts`'s header comment predicted, collected
 * by MUSE-36: the grid, the filter, the Croatian session counts, the homepage doors and
 * both layouts moved with nothing. That file is deleted and neither component has a
 * default any more, so there is no fiction left for a build to fall back to.
 *
 * `minimum` is the strict default, which for this reader is the point: a `/schedule` with
 * no rows is a page whose entire job is unperformed, so it fails the build naming the
 * type rather than publishing an empty table. The summer-pause case is `active: false` on
 * a slot, which hides a class and leaves the others — not an empty dataset.
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

/**
 * The studio's origin story. The singleton behind the other half of `/aboutus` (MUSE-23).
 *
 * **Not memoised**, unlike `getSiteSettings` and `pagesByRoute`. Those two are read by the
 * footer on every page and by `llms.txt`, so without a cache a build makes a dozen
 * identical requests for one document. This one is read by `AboutUs.astro` and nothing
 * else — twice per build, once per locale — so a cache would save one request and cost the
 * thing a cache costs: `test/projections.test.ts` swaps the fixture per test, and a
 * memoised reader silently answers the second test from the first test's dataset.
 */
export async function getStudioStory() {
  const row = await runQuery<unknown>(STUDIO_STORY_QUERY);
  return requireDocument(row, 'studioStory', decodeStudioStory);
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

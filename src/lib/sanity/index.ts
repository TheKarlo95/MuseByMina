import { ROUTES, inertRouteWarning } from '../pages';
import { runQuery, sanitySource, type SanitySource } from './client';
import { inDevServer } from './dev';
import {
  SanityContentError,
  type PageMetaDoc,
  type ProsePage,
  type SiteSettings,
  decodeClass,
  decodeEvent,
  decodeFaq,
  decodeGalleryImage,
  decodeInstructor,
  decodePage,
  decodePost,
  decodePricingTier,
  decodeProsePage,
  decodeScheduleEntry,
  decodeSiteSettings,
  decodeStudioStory,
  requireDocument,
  requireDocuments,
} from './decode';
import {
  ALL_EVENTS_QUERY,
  CLASSES_QUERY,
  DOCUMENT_COUNTS_QUERY,
  EVENTS_QUERY,
  FAQS_QUERY,
  GALLERY_QUERY,
  INSTRUCTORS_QUERY,
  PAGES_QUERY,
  PAST_EVENTS_QUERY,
  POSTS_QUERY,
  PRICING_QUERY,
  PROSE_PAGES_QUERY,
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
 * **Each reader is memoised for the life of the build — and *only* of a build (MUSE-47).**
 *
 * `Footer.astro` reads the singleton, and it renders on nine pages; `TrialForm.astro`
 * reads it too, on two of them. Without memoisation that is a dozen identical HTTP
 * requests per build for one document that cannot change while the build runs. The cache
 * is a promise rather than a value, so concurrent renders share one request, and it lives
 * for the process — a build is one process, and the next build starts a new one.
 *
 * Every clause of that paragraph is a statement about `astro build`, and MUSE-47 is what
 * happens when it is read as a statement about the module. **A dev server is also one
 * process, and it lives for days.** „The document cannot change while the build runs"
 * becomes „the document cannot change while you work", which is false, and the symptom is
 * the worst available shape: measured on this repo before the fix, three reloads of
 * `/schedule/` against the live dataset issued `PAGES_QUERY` **once**,
 * `SITE_SETTINGS_QUERY` **once** and `SCHEDULE_QUERY` **three times** — so the schedule
 * refreshed and the page's `<title>`, the footer and the JSON-LD did not. Content that
 * partly updates does not read as a cache; it reads as „my change didn't save".
 *
 * So the cache is per-*build*, and `perBuild` below is the only place that is decided.
 * `inDevServer()` (`./dev.ts`) is the gate, and it is deliberately not readable from the
 * environment — a deploy cannot turn the memoisation off by setting anything.
 *
 * One consequence to know about, dev-only and documented rather than fixed: with the
 * cache off, `Footer.astro` and `src/lib/structured-data.ts` each issue their own
 * `SITE_SETTINGS_QUERY` within one render, so a publish landing in the millisecond
 * between them would make the visible address and the JSON-LD disagree for one reload.
 * In a build they are one query and cannot. „The block and the visible page agree" is
 * asserted field by field against `dist` (`test/structured-data.test.ts`), which is a
 * build, so the claim the suite makes stays exactly as true as it was.
 */

export type {
  DanceClass,
  Faq,
  GalleryImage,
  ImageRef,
  Instructor,
  PageMetaDoc,
  Post,
  PostTranslation,
  PricingTier,
  ProsePage,
  ProseSection,
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
export { imageFocus, imageSize, imageSrc } from './images';
export type { ImageFocus, ImageSrcOptions } from './images';

/** Which project and dataset this build is reading from. For build logs. */
export function source(): SanitySource {
  return sanitySource();
}

/**
 * Which host the content was fetched from, and what the log says about it (MUSE-81).
 *
 * Re-exported here for the reason everything else is: `test/sanity.test.ts` fails on an
 * import specifier reaching inside `src/lib/sanity/`, so the index is where a test asks
 * the read path about itself.
 */
export { contentEndpoint, endpointNote } from './client';
export type { ContentEndpoint } from './client';

export interface ListOptions {
  /** Fewest documents this page can render. Below it, the build fails naming the type. */
  minimum?: number;
}

/**
 * Read once per build, and once per *call* under a dev server (MUSE-47).
 *
 * The promise is the cached thing, not the value, so concurrent renders inside one build
 * share a single request rather than racing to start their own. Returned by identity:
 * `getSiteSettings() === getSiteSettings()` is true in a build, which is the exact
 * statement „one query per reader" makes, and is how `test/devcontent.test.ts` asserts it
 * without instrumenting the client.
 *
 * Under a dev server there is no cache at all — not a shorter-lived one. A clock would
 * need a number nobody can justify, and the thing a cache would buy here is a few
 * milliseconds on a page nobody but us is loading.
 */
function perBuild<T>(read: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | undefined;
  return () => {
    if (inDevServer()) return read();
    cached ??= read();
    return cached;
  };
}

/**
 * The last inert-route warning printed, or `undefined` when the last look found none.
 *
 * MUSE-46 prints its warning from inside `pagesByRoute`, which until MUSE-47 ran once per
 * process — so "warn when a document is inert" and "warn once" were the same statement and
 * neither needed writing down. `perBuild` above has now separated them: under a dev server
 * the reader runs per request, and an unchanged complaint repeated on every reload is noise
 * in the one stream MUSE-47 just put the `[content]` regime line into.
 *
 * **Keyed on the message, not on a count**, and that is the whole of the choice. "Print it
 * once per process" would reintroduce MUSE-47's own defect in miniature: fix the document,
 * reload, and the log would go on showing a condition that no longer holds — or, having
 * already printed, would never say anything about the state you actually have. Keyed on
 * the text, a *changed* problem is always reported, an unchanged one is reported once, and
 * a fixed one stops being reported, which is the only honest set of three. No clock.
 *
 * In a build this is dead weight by construction — the reader runs once, so the first
 * look is the only look and the output is byte-identical to MUSE-46's. `test/routes.test.ts`
 * asserts that warning against a real build's log and is untouched by any of this.
 */
let inertWarned: string | undefined;

const siteSettings = perBuild(async () => {
  const row = await runQuery<unknown>(SITE_SETTINGS_QUERY);
  return requireDocument(row, 'siteSettings', decodeSiteSettings);
});

/**
 * The site-wide singleton: studio name, tagline, summary, address, email, socials.
 *
 * Not `async`: it hands back the memoised promise itself, so two callers in one build
 * hold the same object. An `async` wrapper would allocate a fresh promise per call and
 * make „the same memoised promise" unobservable, which is the only cheap way to assert
 * the memoisation is still there.
 */
export function getSiteSettings(): Promise<SiteSettings> {
  return siteSettings();
}

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
const pagesByRoute = perBuild(async (): Promise<Map<string, PageMetaDoc>> => {
  const rows = await runQuery<unknown>(PAGES_QUERY);
  const documents = requireDocuments(rows, 'page', decodePage, 0);

  // MUSE-46, and before the checks below rather than after: a document for a route the
  // site does not serve is inert, so it is a warning and not a failure — but it has to
  // be *said* even on a build that is about to fail for a different reason. The whole
  // decision, and why this strength and not another, is at `inertRouteWarning`.
  //
  // The `inertWarned` comparison is MUSE-47's half and nothing to do with severity: this
  // reader used to run once per process, so "warn when it happens" and "warn once" were
  // the same sentence. Under a dev server it now runs per request — see `inertWarned`.
  const inert = inertRouteWarning(documents);
  if (inert !== undefined && inert !== inertWarned) console.warn(inert);
  inertWarned = inert;

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
});

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
 * The prose of one page that is only prose (MUSE-65).
 *
 * **Not memoised**, for the reason `getStudioStory` is not: `/whatisbachata` is the only
 * caller, twice per build, once per locale — so a cache would save one request and cost
 * the thing a cache costs, which is that `test/projections.test.ts` swaps the fixture per
 * test and a memoised reader answers the second test from the first test's dataset.
 *
 * `minimum` is 0 on purpose and it is the same decision `pagesByRoute` documents, not a
 * relaxation. `requireDocuments` can only count, and counting is the wrong instrument
 * here: with the document for *this* route missing and three others present it would say
 * "the dataset holds 3 … this page needs at least 4 … this is an empty dataset", which
 * names neither the route nor the document and offers a remedy that does not exist. So
 * the shortfall is reported below, by route, which is the message written for the failure
 * that actually happens — a prose page routed before its document was seeded.
 *
 * A duplicate is the other half and just as bad: two documents for one route means the
 * page's heading depends on which row GROQ answered first, which is not debuggable from
 * the output. The Studio's fixed route list makes both unlikely and neither impossible.
 */
export async function getProsePage(route: string): Promise<ProsePage> {
  const rows = await runQuery<unknown>(PROSE_PAGES_QUERY);
  const documents = requireDocuments(rows, 'prosePage', decodeProsePage, 0);

  const here = documents.filter((document) => document.route === route);
  if (here.length === 1) return here[0]!;

  throw new SanityContentError(
    [
      here.length === 0
        ? `No \`prosePage\` document describes: ${route}. Add one in the Studio under ` +
          `„Tekst stranica” and pick that route — without it the page would publish a ` +
          `heading above nothing. The query ran and the API answered, so this is a ` +
          `document that is not there, not a broken read path.`
        : `More than one \`prosePage\` document describes: ${route} ` +
          `(${here.map((document) => document.id).join(', ')}). Which heading the page ` +
          `gets would depend on query order; open „Tekst stranica” and delete the spare.`,
      `  Documents found: ${
        documents.length === 0
          ? 'none at all'
          : documents.map((document) => `${document.route} (${document.id})`).join(', ')
      }.`,
    ].join('\n'),
  );
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

/**
 * Past events, most recent first — `/events/archive/` (MUSE-24).
 *
 * The exact complement of `getEvents`, and the two must be handed the **same** `now`: the
 * pages are two renderings of one partition, and two `new Date()` calls are two instants.
 * `minimum: 0` is the honest default for both, because „nothing has happened yet" and
 * „nothing is coming" are both real states of a studio with no events in the dataset — and
 * `src/components/Events.astro` and `EventsArchive.astro` each say so in words rather than
 * rendering an empty list.
 *
 * Not memoised, for `getStudioStory`'s reason: one caller, once per locale, and
 * `test/projections.test.ts` swaps the fixture per test.
 */
export async function getPastEvents({
  minimum = 0,
  now = new Date(),
}: ListOptions & { now?: Date } = {}) {
  const rows = await runQuery<unknown>(PAST_EVENTS_QUERY, { now: now.toISOString() });
  return requireDocuments(rows, 'event', decodeEvent, minimum);
}

/**
 * **A read performed inside `getStaticPaths`, with its error class kept in the log**
 * (MUSE-24).
 *
 * `./decode.ts` keeps three outcomes apart on purpose — unreachable, empty, malformed — and
 * what makes that reach a human is the error's **class name** in the build output. Astro
 * prints a *page render* failure as `SanityUnavailableError: …`, and a **`getStaticPaths`
 * rejection as the message, the location and the stack with no name at all** (measured on
 * Astro 7.3.6, `callGetStaticPaths` in `core/render/route-cache.js`).
 *
 * That matters more than it looks, because `getStaticPaths` runs **before any page
 * renders**: the moment a dynamic route exists, it is the first read of the build, so it is
 * the one that fails during a Sanity outage — and the log for the single most likely
 * infrastructure failure on this project would have stopped saying which of the three it
 * was. `TRANSIENT_BUILD_FAILURE` survives either way, so MUSE-21's retry was never at
 * risk; the diagnosis was.
 *
 * So the name is folded into the message here, in one place, for any future dynamic route
 * rather than for `/events/<slug>/` alone. `cause` is kept, so nothing is lost for a reader
 * who wants the original. `test/content.test.ts` is the guard and needed no new build: its
 * unreachable-API build now fails *through* this function, and still has to name the class.
 */
export async function readStaticPaths<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof Error) throw new Error(`${cause.name}: ${cause.message}`, { cause });
    throw cause;
  }
}

/**
 * **Every event, on no clock at all — which detail pages the build emits** (MUSE-24).
 *
 * `getStaticPaths` is the only caller. It is deliberately not "upcoming plus past": an
 * event's URL is permanent, so the set of URLs a build emits may not depend on the instant
 * the build started, and deriving it from the two filtered readers would make that
 * permanence contingent on their partition holding rather than on anything structural.
 *
 * `minimum: 0` because a studio with no events is not a broken build — it is the state this
 * page shipped in.
 */
export async function getAllEvents({ minimum = 0 }: ListOptions = {}) {
  const rows = await runQuery<unknown>(ALL_EVENTS_QUERY);
  return requireDocuments(rows, 'event', decodeEvent, minimum);
}

export async function getGallery({ minimum = 1 }: ListOptions = {}) {
  const rows = await runQuery<unknown>(GALLERY_QUERY);
  return requireDocuments(rows, 'galleryImage', decodeGalleryImage, minimum);
}

/**
 * **Published posts, newest first — `/blog/` and every `/blog/<slug>/`** (MUSE-26).
 *
 * One reader for both, which is deliberate and is where this departs from `/events`:
 * `POSTS_QUERY` is the only query over `post`, so the index and `getStaticPaths` cannot
 * disagree about which posts exist. `src/lib/sanity/queries.ts` has the argument for why
 * there is no clockless twin here — the short version is that a post must not have a URL
 * before its `publishedAt`, which is the whole of what the Studio field promises.
 *
 * `now` is a parameter so two builds of one commit at one instant agree (MUSE-20), and so
 * that a page can hand the same instant to everything it renders.
 *
 * **Not memoised**, for `getStudioStory`'s reason: `test/projections.test.ts` swaps the
 * fixture per test, and a memoised reader silently answers the second test from the
 * first's dataset. The cost is one query per locale per build.
 */
export async function getPosts({
  minimum = 1,
  now = new Date(),
}: ListOptions & { now?: Date } = {}) {
  const rows = await runQuery<unknown>(POSTS_QUERY, { now: now.toISOString() });
  return requireDocuments(rows, 'post', decodePost, minimum);
}

/**
 * **A read performed inside `getStaticPaths`, with its error class kept in the log**
 * (MUSE-26).
 *
 * `./decode.ts` keeps three outcomes apart on purpose — unreachable, empty, malformed —
 * and what makes that reach a human is the error's **class name** in the build output.
 * Astro prints a *page render* failure as `SanityUnavailableError: …`, and a
 * `getStaticPaths` rejection as the message, the location and the stack with **no name at
 * all** (measured on Astro 7.3.6, `callGetStaticPaths` in `core/render/route-cache.js`).
 *
 * That matters more than it looks, because `getStaticPaths` runs **before any page
 * renders**: the moment a dynamic route exists it is the first read of the build, so it is
 * the one that fails during a Sanity outage — and the log for the single most likely
 * infrastructure failure on this project would have stopped saying which of the three it
 * was. `TRANSIENT_BUILD_FAILURE` survives either way, so MUSE-21's retry was never at
 * risk; the diagnosis was.
 *
 * So the name is folded into the message here, in one place, for any future dynamic route
 * rather than for `/blog/<slug>/` alone. `cause` is kept, so nothing is lost for a reader
 * who wants the original.
 */
export async function readStaticPaths<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (cause) {
    if (cause instanceof Error) throw new Error(`${cause.name}: ${cause.message}`, { cause });
    throw cause;
  }
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

import { isIsoInstant } from '../dates';
import type { Locale } from '../i18n';
import { LEVELS, WEEKDAYS, type ClassEntry } from '../schedule';

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

/* ---------------------------------------------------------------- references */

/**
 * **A reference that points at nothing — MUSE-49's whole subject.**
 *
 * Sanity does not enforce referential integrity on delete. Remove an instructor and every
 * `_ref` naming her survives, now pointing at a document that is not there; GROQ
 * dereferences it to `null` and answers HTTP 200. So this is not a transport fault and not
 * a malformed field — it is content that *was* right and is now a dangling pointer, and
 * there is no correct way to render it. A blank byline and the class's regular teachers are
 * both wrong, and the second one is wrong in the dangerous direction: a real name that is
 * not this slot's teacher is a claim about a named person which nobody will notice.
 *
 * Hence the build stops, and hence what the message has to carry. Three things, because
 * each one answers a question Mina would otherwise have to guess at:
 *
 *   - **the document** — its `_id` and type, which is how it is found in the Studio;
 *   - **the field path** — `instructors[0]`, so a list with one bad member is not reported
 *     as a list that is broken;
 *   - **the target** — the `_ref` itself. Without it the message is indistinguishable from
 *     "this instructor's name is blank", which is a different document and a different fix.
 *
 * `optional` only changes the advice, never the outcome: where the field may legitimately
 * be empty, *clearing* it is a valid fix and the message says so, which turns a build
 * failure into a ten-second Studio edit rather than an emergency.
 */
function failDangling(where: Where, ref: string, optional: boolean): never {
  throw new SanityContentError(
    `Sanity document "${where.id}" (type \`${where.type}\`) is unusable: field ` +
      `\`${where.path}\` dereferences a reference that points at nothing. The reference ` +
      `names \`${ref}\`, and there is no such document in the dataset — so it has been ` +
      `deleted, or was never published. Sanity does not clear a reference when its target ` +
      `goes, and GROQ answers a broken one with \`null\` rather than an error, which is ` +
      `why this is a build failure and not a blank on the page. ` +
      (optional
        ? `This field is optional, so **clearing it** in the Studio is a valid fix, as is ` +
          `pointing it at a document that exists. Leaving it is the one thing that is not: ` +
          `the page would publish as though the field had never been filled in.`
        : `Point it at a document that exists, or delete this document.`),
  );
}

/**
 * The pair has come apart: one half of a `value`/`_ref` projection resolved and the other
 * did not. That cannot happen in GROQ, so it is a query bug, and it says so.
 *
 * It exists because a projection with nothing watching it is a projection that can be
 * deleted for free. Drop `"authorRef": author._ref` from `./queries.ts` and every rule
 * above silently reverts to the old behaviour — a dangling author becomes an unsigned post
 * again — with no test failing unless something checks that the `_ref` is still arriving.
 * This is that check, on every row, at build time.
 */
function failUnpairedReference(where: Where, refPath: string, got: unknown): never {
  throw new SanityContentError(
    `Sanity document "${where.id}" (type \`${where.type}\`) cannot be read: field ` +
      `\`${where.path}\` resolved, but the \`${refPath}\` projection beside it did not ` +
      `(got ${render(got)}). GROQ cannot dereference a reference it does not have, so the ` +
      `two cannot disagree about real content — this is a bug in ` +
      `\`src/lib/sanity/queries.ts\`, not something to fix in the Studio. Every ` +
      `dereference there is projected next to its \`_ref\` so that a deleted target can be ` +
      `told apart from an empty optional field (MUSE-49); restore the missing half.`,
  );
}

/** The `_ref` a reference projection carried, or `undefined` if there was none. */
function refOf(doc: unknown, refPath: string): string | undefined {
  const ref = read(doc, refPath);
  return typeof ref === 'string' && ref.trim() !== '' ? ref : undefined;
}

/**
 * A **required** dereferenced value, which a dangling target now names.
 *
 * `scheduleSlot.class` is the one of these. A required reference already failed the build —
 * `null` is not a non-empty string — so what changes here is only the diagnosis, and the
 * diagnosis was the problem: `classId` "should be a non-empty string, got nothing (the
 * field is absent, or GROQ returned null)" lists three causes and names the least likely
 * one, while the `_ref` sitting in the answer says exactly which class was deleted.
 */
export function referencedText(
  doc: unknown,
  path: string,
  refPath: string,
  where: Where,
): string {
  const value = read(doc, path);
  const ref = refOf(doc, refPath);
  if (value === undefined && ref !== undefined) failDangling(at(where, path), ref, false);
  const resolved = text(doc, path, where);
  if (ref === undefined) failUnpairedReference(at(where, path), refPath, read(doc, refPath));
  return resolved;
}

/**
 * An **optional** dereferenced value: the case `optionalText` could not express.
 *
 * `post.author` is the one of these, and the reason MUSE-49 exists. `optionalText` sees
 * `undefined` whether the reference was never set or its target has been deleted, and both
 * are legitimate for an optional field — that is precisely why it is optional, and why no
 * amount of care in the decoder could have separated them. The `_ref` is the evidence that
 * was missing from the answer, and with it the rule is a single line of code:
 *
 *     a `_ref` with no value  →  deleted. Fail, naming it.
 *     no `_ref` at all        →  empty. Fine.
 *
 * The two must not be conflated **in either direction**. Failing on an absent author would
 * make "signed by the studio" — the Studio field's own documented default — a build
 * failure.
 */
export function optionalReferencedText(
  doc: unknown,
  path: string,
  refPath: string,
  where: Where,
): string | undefined {
  const value = read(doc, path);
  const ref = refOf(doc, refPath);
  if (value === undefined) {
    if (ref !== undefined) failDangling(at(where, path), ref, true);
    return undefined;
  }
  if (ref === undefined) failUnpairedReference(at(where, path), refPath, read(doc, refPath));
  return optionalText(doc, path, where);
}

/**
 * A non-empty list of names dereferenced from a list of references.
 *
 * The failure it exists to name is specific to MUSE-36's instructor array. GROQ projects
 * `instructors[]->name` as `null` when the field is absent, as `[]` when the array is
 * empty, and as `[null]` when a member points at a document that has been deleted — three
 * different shapes that a template rendering `instructors.join(' i ')` turns into the same
 * thing: a class with nobody teaching it. Each of them fails here, naming the document and
 * the index.
 *
 * **The `_ref`s are read positionally alongside the names** (MUSE-49), which gives the
 * index-level message the one fact it was missing: `instructors[0]` "should be a non-empty
 * string, got null" describes an instructor whose *name* field is blank, and sends whoever
 * reads it to a document that is fine. The reference is what is broken.
 *
 * The length comparison is the part worth not deleting. A dangling member keeps its
 * position in both `groq-js` and the API — `[null, 'Mina']`, not `['Mina']` — and that is
 * verified rather than assumed, because a **compacted** list is the one failure in this
 * whole area with nothing blank to notice: it publishes „Mina" for a class Mina and Antonio
 * teach together, which is true, incomplete, and indistinguishable from a class she teaches
 * alone. If an engine ever starts compacting, the two lengths stop matching and that is a
 * named build failure instead of a quietly shorter list.
 */
export function referencedTextList(
  doc: unknown,
  path: string,
  refPath: string,
  where: Where,
): string[] {
  const value = read(doc, path);
  if (!Array.isArray(value) || value.length === 0) {
    fail(at(where, path), 'a list with at least one entry', value);
  }

  const refs = read(doc, refPath);
  if (!Array.isArray(refs) || refs.length !== value.length) {
    failUnpairedReference(at(where, path), refPath, refs);
  }

  return value.map((entry, index) => {
    if (typeof entry === 'string' && entry.trim() !== '') return entry;
    const here = at(where, `${path}[${index}]`);
    const ref = refs[index];
    if (typeof ref === 'string' && ref.trim() !== '') {
      // The list itself is required, but a *member* of it is something Mina can remove, so
      // the advice is the optional one: drop the person who is gone, or point the entry at
      // somebody who exists.
      failDangling(here, ref, true);
    }
    fail(here, 'a non-empty string', entry);
  });
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

/**
 * A `datetime` field, held to the one spelling the site compares and formats (MUSE-26).
 *
 * `text()` alone was not enough once `/events` and `/blog` started rendering one
 * (MUSE-24, MUSE-26). Two different silent failures sit behind a loose datetime, and
 * neither is a missing field:
 *
 *   - **`Intl` renders an unparseable date as the literal words "Invalid Date"** — on an
 *     event card that is a date chip reading „Invalid Date" at 40px, on a post it is the
 *     byline. `src/lib/dates.ts` refuses it too, but by then the value is already in a
 *     page's frontmatter; the decoder's job is that nothing malformed reaches a component
 *     at all, and this is the field path the error should name.
 *   - **„upcoming" and „published yet" are both decided by comparing strings.**
 *     `EVENTS_QUERY`, `PAST_EVENTS_QUERY` and `POSTS_QUERY` compare against `$now` in
 *     GROQ, where both sides are strings, and `$now` is always `Date#toISOString`'s `…Z`
 *     spelling. A value carrying a local offset (`…+02:00`) is the same instant and a
 *     different string, so it sorts into the wrong half — an event in the archive while
 *     it is still to come, a post hidden for two hours after it was due. That cannot be
 *     caught downstream, because the comparison has already happened by the time a page
 *     sees the row.
 *
 * `isIsoInstant` is the same predicate `src/lib/dates.ts` formats through, imported rather
 * than restated: two spellings of „what counts as a datetime here" is the shape of defect
 * this directory exists to prevent.
 */
function instantAt(doc: unknown, path: string, where: Where, required: boolean): string | undefined {
  const value = required ? text(doc, path, where) : optionalText(doc, path, where);
  if (value === undefined) return undefined;
  if (!isIsoInstant(value)) {
    fail(
      at(where, path),
      'a UTC ISO instant like `2026-08-13T19:00:00.000Z` — the spelling Sanity stores a ' +
        '`datetime` in, and the only one a string comparison against `$now` can be ' +
        'trusted with',
      value,
    );
  }
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
 * The empty-set message is deliberately explicit that the query *ran*. Most of the
 * dataset is still empty — MUSE-20 migrated the singleton and the four page documents and
 * nothing else — so the same symptom, nothing on the page, is true for entirely
 * legitimate reasons, and whoever reads this log needs to be told which of the two it is
 * rather than guessing.
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
  /**
   * Optional as of MUSE-20, and the reason is a rule worth generalising: nothing on the
   * site renders a phone number and no real one exists, so `required()` could only be
   * satisfied by inventing one — which is exactly how the invented schedule (MUSE-36)
   * reached production. Whichever page first displays it can require it then.
   */
  phone?: string;
  /** Optional for the same reason as `phone`. The class schedule is a separate thing. */
  openingHours?: Record<Locale, string>;
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
    phone: optionalText(row, 'phone', where),
    openingHours: optionalLocalised(row, 'openingHours', where),
    social: (Array.isArray(social) ? social : []).map((entry, index) => {
      const here = at(where, `social[${index}]`);
      return { platform: text(entry, 'platform', here), url: text(entry, 'url', here) };
    }),
    shareImage: optionalImage(row, 'shareImage', where),
  };
}

/**
 * The address as the two lines an `<address>` element needs: street, then city.
 *
 * `siteSettings.address` is one field because an address is one thing Mina types, and
 * the footer renders it as two lines with the country translated underneath (design
 * system §7.1). Something has to bridge those, and the choice is between a second and
 * third CMS field — more fields to fill in, and three ways to disagree with each other —
 * or splitting the one field here.
 *
 * Splitting won, with the comma as the contract: it is how the address is written
 * anyway, the Studio field says so, and a value that does not have exactly one comma
 * fails the build naming the document instead of rendering half an address. The
 * alternative failure — a silent `undefined` city — is the thing this whole module
 * exists to prevent.
 *
 * `MUSE-20` rendered this on four surfaces (the footer, `/`, `/contact` and the privacy
 * notice's controller line) precisely so the field is not write-only: a CMS field that
 * changes nothing a visitor sees is worse than no field, because it looks like it works.
 */
export function addressLines(settings: SiteSettings): { street: string; city: string } {
  const parts = settings.address.split(',').map((part) => part.trim());
  if (parts.length !== 2 || parts.some((part) => part === '')) {
    throw new SanityContentError(
      `Sanity document "${settings.id}" (type \`siteSettings\`) has \`address\` = ` +
        `${JSON.stringify(settings.address)}, which the footer cannot render as two ` +
        `lines. It needs the street, one comma, then the city — „Ulica 1, Grad". The ` +
        `country is not part of it; the site translates that itself.`,
    );
  }
  return { street: parts[0]!, city: parts[1]! };
}

/**
 * The URL of one social profile, or a build failure naming the document.
 *
 * The footer and `/contact` each link to a named network — the link text is markup, the
 * address is content — so they ask for one by platform rather than rendering whatever
 * order the array happens to be in. A platform that is not in `siteSettings` is a link
 * with no href, which is worse than a build that stops: it looks fine and goes nowhere.
 */
export function socialUrl(settings: SiteSettings, platform: string): string {
  const found = settings.social.find((entry) => entry.platform === platform);
  if (!found) {
    throw new SanityContentError(
      `Sanity document "${settings.id}" (type \`siteSettings\`) has no \`${platform}\` ` +
        `entry under \`social\`, and the site links to one. Add it in the Studio under ` +
        `„Društvene mreže”. Present: ` +
        `${settings.social.map((entry) => entry.platform).join(', ') || '(none)'}.`,
    );
  }
  return found.url;
}

/**
 * One route's words. The counterpart of `ROUTES` in `src/lib/pages.ts`, which keeps the
 * other half — which routes exist — in code (MUSE-20).
 */
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
 * One section of a prose page: a subheading and the paragraphs under it.
 *
 * `heading` becomes an `<h2>` and `body` becomes the `<p>`s below it, which is why the
 * paragraphs are an array of their own rather than one string with blank lines in it —
 * see the long note on the type in `sanity/schemaTypes/documents/prose.ts`.
 */
export interface ProseSection {
  heading: Record<Locale, string>;
  /** Paragraphs, in the order they were written. At least one. */
  body: Record<Locale, string>[];
}

/**
 * The prose of a page that is only prose (MUSE-65) — `/whatisbachata` today, and the
 * shape MUSE-27's other three trust pages are built for.
 *
 * Keyed by `route`, like `PageMetaDoc`, and for the same reason: which pages exist stays
 * in `ROUTES`, and the CMS owns a page's words and never its existence.
 *
 * Every field is required, and there is no optional one to argue about: a prose page with
 * no heading, no lede or no sections is a page with nothing on it, which is the one case
 * `decode.ts` exists to refuse. The error names the section and the paragraph **by
 * index** — `sections[1].body[2]` — because „a paragraph is not an object with `hr` and
 * `en`" is useless to Mina when there are a dozen of them (the same reason
 * `referencedTextList` names the index).
 */
export interface ProsePage {
  id: string;
  route: string;
  heading: Record<Locale, string>;
  lede: Record<Locale, string>;
  sections: ProseSection[];
}

export function decodeProsePage(row: unknown): ProsePage {
  const where = frame(row, 'prosePage');
  const sections = read(row, 'sections');
  if (!Array.isArray(sections) || sections.length === 0) {
    fail(at(where, 'sections'), 'at least one section', sections);
  }

  return {
    id: where.id,
    route: text(row, 'route', where),
    heading: localised(row, 'heading', where),
    lede: localised(row, 'lede', where),
    sections: sections.map((section, index) => {
      const here = at(where, `sections[${index}]`);
      if (typeof section !== 'object' || section === null) {
        fail(here, 'a section with a heading and paragraphs', section);
      }
      const body = read(section, 'body');
      if (!Array.isArray(body) || body.length === 0) {
        fail(at(here, 'body'), 'at least one paragraph', body);
      }
      return {
        heading: localised(section, 'heading', here),
        body: body.map((_, position) => localisedMember(body, position, here, 'body')),
      };
    }),
  };
}

/**
 * A schedule row, decoded straight into the existing `ClassEntry`.
 *
 * The `ClassEntry` extension is not decoration: `Schedule.astro` and `Home.astro` both
 * take `ClassEntry[]`, so if this ever stops producing one, the type error arrives before
 * the page does. It was the compile-time half of the promise that moving the schedule
 * into the CMS (MUSE-36) would be a prop change; it is now what holds the two pages to
 * one shape.
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
    classId: referencedText(row, 'classId', 'classRef', where),
    name: localised(row, 'name', where),
    day: oneOf(row, 'day', where, WEEKDAYS),
    start,
    durationMin: integer(row, 'durationMin', where),
    level: oneOf(row, 'level', where, LEVELS),
    instructors: referencedTextList(row, 'instructors', 'instructorRefs', where),
  };
}

export interface DanceClass {
  id: string;
  slug: string;
  name: Record<Locale, string>;
  level: (typeof LEVELS)[number];
  /** Optional as of MUSE-36 — nothing renders it, so nothing may demand it. */
  description?: Record<Locale, string>;
  durationMin: number;
  instructors: string[];
  /** Optional as of MUSE-36, for the reason `Instructor.portrait` is. */
  image?: ImageRef;
}

export function decodeClass(row: unknown): DanceClass {
  const where = frame(row, 'class');
  return {
    id: where.id,
    slug: text(row, 'slug', where),
    name: localised(row, 'name', where),
    level: oneOf(row, 'level', where, LEVELS),
    description: optionalLocalised(row, 'description', where),
    durationMin: integer(row, 'durationMin', where),
    instructors: referencedTextList(row, 'instructors', 'instructorRefs', where),
    image: optionalImage(row, 'image', where),
  };
}

export interface Instructor {
  id: string;
  name: string;
  slug: string;
  role: Record<Locale, string>;
  /**
   * Optional as of MUSE-36, for the reason `portrait` is.
   *
   * No bios exist. Mina and Antonio are two real people with a real timetable, and a
   * `required()` bio could only be satisfied by writing a paragraph about how long one of
   * them has danced — inventing a claim about a named person to get past a validator,
   * which is the move this whole ticket exists to undo.
   */
  bio?: Record<Locale, string>;
  /**
   * Optional as of MUSE-23, for the reason `phone` is: no photography of this studio
   * exists, so a required portrait could only be satisfied by uploading something that is
   * not one — and inventing content to satisfy a validator is how MUSE-36 happened.
   *
   * `/aboutus` renders a placeholder frame at the same 3:4 box instead, so the layout does
   * not move when a photograph finally lands. Note that **optional is not unchecked**: a
   * portrait that is present still has to carry an asset id and both alt locales, which is
   * what keeps the MUSE-49 shape — an image object whose asset reference has gone — a named
   * build failure rather than an empty frame.
   */
  portrait?: ImageRef;
  /**
   * The instructor's own Instagram profile, if they have a public one.
   *
   * Optional, and the page renders a plain name when it is absent: a name linking nowhere
   * is worse than a name. The URL is content and lives in Sanity rather than in the
   * component — MUSE-23's words — because it is the sort of thing that changes without a
   * deploy and differs per person.
   */
  instagram?: string;
}

export function decodeInstructor(row: unknown): Instructor {
  const where = frame(row, 'instructor');
  return {
    id: where.id,
    name: text(row, 'name', where),
    slug: text(row, 'slug', where),
    role: localised(row, 'role', where),
    bio: optionalLocalised(row, 'bio', where),
    portrait: optionalImage(row, 'portrait', where),
    instagram: optionalText(row, 'instagram', where),
  };
}

/**
 * The studio's origin story: a heading, the paragraphs, and the date it started if
 * anybody has said one.
 *
 * `foundedOn` stays an ISO date string. Rendering it is `formatDate` in
 * `src/lib/dates.ts`, because the two locales want two different forms of the same date
 * (§10) and a decoder that picked one would make the other page wrong.
 */
export interface StudioStory {
  id: string;
  heading: Record<Locale, string>;
  /**
   * ISO calendar date, `YYYY-MM-DD`. Formatted per locale by the page.
   *
   * **Optional as of MUSE-60**, for the reason `instructor.bio` is optional: no founding
   * date for this studio is recorded anywhere, and the placeholder story MUSE-60 seeded
   * is held to asserting nothing checkable. A required date could only have been
   * satisfied by inventing one — MUSE-36's mistake, on a field a reader would believe.
   *
   * **Optional is not unchecked.** A date that *is* there still has to be a calendar
   * date, so a half-typed value is a named build failure rather than a page reading
   * „Od Invalid Date".
   */
  foundedOn?: string;
  /** Paragraphs, in the order Mina wrote them. At least one. */
  story: Record<Locale, string>[];
}

export function decodeStudioStory(row: unknown): StudioStory {
  const where = frame(row, 'studioStory');
  const foundedOn = optionalText(row, 'foundedOn', where);
  if (foundedOn !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(foundedOn)) {
    fail(at(where, 'foundedOn'), 'a calendar date like `2026-08-13`', foundedOn);
  }

  const story = read(row, 'story');
  if (!Array.isArray(story) || story.length === 0) {
    fail(at(where, 'story'), 'at least one paragraph', story);
  }

  return {
    id: where.id,
    heading: localised(row, 'heading', where),
    foundedOn,
    story: story.map((_, index) => localisedMember(story, index, where, 'story')),
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
    features: features.map((_, index) => localisedMember(features, index, where, 'features')),
    featured: flag(row, 'featured', where, false),
  };
}

/**
 * One entry of a bilingual array, named by index so an error points at the row.
 *
 * `field` is passed in rather than baked in: there are two of these arrays now —
 * `pricingTier.features` and `studioStory.story` — and an error reading `features[2].en`
 * for a paragraph of the origin story would send Mina to the wrong document.
 */
function localisedMember(
  list: readonly unknown[],
  index: number,
  where: Where,
  field: string,
): Record<Locale, string> {
  const here = at(where, `${field}[${index}]`);
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
  /** A UTC ISO instant. Formatted in the studio's zone by `src/lib/dates.ts`. */
  startsAt: string;
  /** Optional, because „kraj nije objavljen" is a real state the Studio field offers. */
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
    startsAt: instantAt(row, 'startsAt', where, true)!,
    endsAt: instantAt(row, 'endsAt', where, false),
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

/**
 * One post in one language — the three fields that are written per locale (MUSE-26).
 *
 * `body` stays `unknown[]` here on purpose, and that is a division of labour rather than
 * laziness: this module's job is that **every block is an object carrying a `_type`**, so
 * a projection that lost the array or a row holding a bare string fails naming the
 * document and the index. Which `_type`s are *allowed* is the renderer's question, and
 * `src/lib/portable-text.ts` answers it by failing on anything it has no rule for —
 * naming the unmapped construct, the block and the document. Two checks, two different
 * facts, each where the fact is known.
 */
export interface PostTranslation {
  title: string;
  excerpt: string;
  /** Portable Text. Rendered by `src/lib/portable-text.ts`, which owns the block map. */
  body: unknown[];
}

export interface Post {
  id: string;
  slug: string;
  publishedAt: string;
  /**
   * The instructor who wrote it, if a person did.
   *
   * Optional, and it stays optional: the Studio field reads „Ostavi prazno i objava je
   * potpisana studijem", so a post with no author is signed by the studio and renders
   * with the studio's own name as the byline. **`undefined` here therefore means exactly
   * one thing** — nobody was named. It used to mean two, the second being "the instructor
   * who wrote it has been deleted", which published the post unsigned and said nothing
   * (MUSE-49). That case is now a build failure naming the post, the field and the
   * deleted instructor; see `optionalReferencedText`.
   */
  author?: string;
  /**
   * Optional since MUSE-26, which is the `instructor.portrait` decision: no photography
   * of this studio exists, so a required cover could only be satisfied with a stock
   * photograph.
   */
  coverImage?: ImageRef;
  /**
   * The languages this post is written in, and the text of each.
   *
   * A locale that is absent here is a locale the post **is not published in**: it is not
   * on that index, it has no page at that URL, and the other locale's page declares no
   * `hreflang` alternate pointing at it. One fact, read in four places. See
   * `sanity/schemaTypes/objects/locale.ts` for why the grouping is per locale, and
   * `src/lib/blog.ts` for what each of those four places does with it.
   */
  text: Partial<Record<Locale, PostTranslation>>;
}

/**
 * One translation, or `undefined` for a language the post is not written in.
 *
 * The three fields are `required()` *inside* `postTranslation`, so Sanity already refuses
 * a half-filled one in the Studio. This is the build-side half of the same rule, and it
 * is not redundant: `npm run sanity:seed` imports NDJSON straight into the dataset
 * without going through a single Studio validator, which is how a document that no editor
 * could have created gets in.
 */
function postTranslation(
  row: unknown,
  locale: Locale,
  where: Where,
): PostTranslation | undefined {
  const value = read(row, locale);
  if (value === undefined) return undefined;
  if (typeof value !== 'object') {
    fail(at(where, locale), 'the text of the post in this language, or nothing at all', value);
  }

  const here = at(where, locale);
  const blocks = read(value, 'body');
  if (!Array.isArray(blocks) || blocks.length === 0) {
    fail(at(here, 'body'), 'at least one paragraph of text', blocks);
  }
  blocks.forEach((block, index) => {
    if (typeof block !== 'object' || block === null || typeof read(block, '_type') !== 'string') {
      fail(
        at(here, `body[${index}]`),
        'a Portable Text block — an object with a `_type`. Which types are allowed is ' +
          '`src/lib/portable-text.ts`, which fails naming any it has no rule for',
        block,
      );
    }
  });

  return {
    title: text(value, 'title', here),
    excerpt: text(value, 'excerpt', here),
    body: blocks as unknown[],
  };
}

export function decodePost(row: unknown): Post {
  const where = frame(row, 'post');
  const text_ = {
    hr: postTranslation(row, 'hr', where),
    en: postTranslation(row, 'en', where),
  };

  /**
   * **The one rule the Studio cannot state, so the build does** (MUSE-26).
   *
   * `required()` has no "one of these two" form and `Rule.custom` is skipped unless the
   * validation run is handed a client (`sanity/schemaTypes/enums.ts`), so a post with
   * neither language filled in is publishable in the Studio. It renders nowhere — no
   * index lists it, no URL resolves to it — which makes it precisely the silent nothing
   * this module exists to refuse, so it stops the build naming the document rather than
   * being a row that quietly does not exist.
   */
  if (text_.hr === undefined && text_.en === undefined) {
    fail(
      where,
      'the text of the post in at least one language — fill in `hr`, `en`, or both. A ' +
        'post with neither is published nowhere: it is on no index, has no URL of its ' +
        'own and is in no sitemap',
      { hr: read(row, 'hr'), en: read(row, 'en') },
    );
  }

  return {
    id: where.id,
    slug: text(row, 'slug', where),
    publishedAt: instantAt(row, 'publishedAt', where, true)!,
    author: optionalReferencedText(row, 'author', 'authorRef', where),
    coverImage: optionalImage(row, 'coverImage', where),
    text: text_,
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

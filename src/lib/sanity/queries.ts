import { defineQuery } from 'groq';

/**
 * **Every GROQ query in this repository.**
 *
 * One module, for the reason MUSE-19 states as an acceptance criterion: GROQ scattered
 * through components is GROQ nobody can grep, and a field rename then has to be chased
 * through the markup. `test/sanity.test.ts` fails if a query string appears in any other
 * file under `src/`, so this is enforced rather than agreed.
 *
 * Three conventions here are deliberate and worth keeping:
 *
 *   - **Bilingual values are always projected as `{ hr, en }`.** Never bare. A bare
 *     `title` would hand the page `{_type: 'localeString', hr, en}` and let a template
 *     render the wrapper by accident; naming both locales also means `sanity typegen`
 *     produces `{hr: string; en: string}`, which is assignable to the
 *     `Record<Locale, string>` the rest of the site already speaks.
 *
 *   - **No composition, no fragments.** The queries repeat themselves. That is on
 *     purpose: `sanity typegen` resolves a query by reading the literal, and a clever
 *     fragment scheme is the kind of thing that silently stops resolving on a minor
 *     version bump, taking the generated types with it. Repetition a reader can check
 *     beats a DRY abstraction a code generator has to agree with.
 *
 *   - **`_id` is always projected.** It is what the error messages name when a document
 *     is malformed, and "`instructor` is missing a bio" is useless to Mina without it.
 *
 * Images carry the asset id plus `hotspot`/`crop` rather than a resolved URL, because
 * the crop is the point: one upload serves 16:9, 4:5, 3:4 and 1:1 (design system §9),
 * and the ratio is the page's decision, not the query's.
 *
 * ---
 *
 * **Every dereference is projected beside its `_ref` (MUSE-49).** `author->name` sits next
 * to `"authorRef": author._ref`; `instructors[]->name` next to `instructors[]._ref`. It
 * looks redundant and it is the whole fix.
 *
 * Sanity does not enforce referential integrity on delete: remove an instructor and the
 * `_ref` on every document pointing at her stays, now naming nothing. GROQ dereferences it
 * to `null` and answers HTTP 200. For a **required** field the decoder catches that, because
 * `null` is not a value and it demands one. For an **optional** field it cannot: `null` and
 * "nobody filled this in" arrive as the same `undefined`, and an optional field is allowed
 * to be empty — so `post.author` published unsigned and said nothing.
 *
 * The `_ref` is the missing bit of evidence, and it yields one rule the decoder can apply
 * without guessing:
 *
 *     a `_ref` present with a `null` value  →  the target has been deleted
 *     both absent                           →  an empty optional field
 *
 * Two consequences worth knowing before editing any projection below:
 *
 *   - **The pair must stay a pair.** `src/lib/sanity/decode.ts` fails the build if a value
 *     resolves while its `_ref` does not, and vice versa, because either half alone is a
 *     projection that has stopped saying which case it is. Deleting a `*Ref` line is
 *     therefore a loud failure on every row rather than a quietly worse error message.
 *   - **For an array, the two are read positionally**, so they are traversals of the same
 *     source array and `groq-js` and the API both keep a dangling member's position
 *     (`[null, 'Mina']`, not `['Mina']`). The decoder compares the two lengths rather than
 *     trusting that, because a compacted list is the one failure here with nothing blank to
 *     notice: it publishes a true statement that is not the whole truth.
 */

export const SITE_SETTINGS_QUERY = defineQuery(`
  *[_type == "siteSettings" && _id == "siteSettings"][0]{
    _id,
    studioName,
    tagline{ hr, en },
    summary{ hr, en },
    address,
    email,
    phone,
    openingHours{ hr, en },
    social[]{ platform, url },
    shareImage{ "assetId": asset._ref, alt{ hr, en }, hotspot, crop }
  }
`);

export const PAGES_QUERY = defineQuery(`
  *[_type == "page"] | order(route asc){
    _id,
    route,
    name{ hr, en },
    title{ hr, en },
    description{ hr, en }
  }
`);

/**
 * The body of every page that is only prose (MUSE-65).
 *
 * One query for all of them rather than one per route, and that is the half worth keeping:
 * `getProsePage(route)` indexes the result by route, so **two documents describing one
 * route is an error it can name** rather than a page whose heading depends on which row
 * GROQ answered first — the same reasoning as `PAGES_QUERY` and `pagesByRoute`.
 *
 * `sections` is a two-level array and both levels are projected member by member, for the
 * reason every bilingual value is projected as `{hr, en}`: a bare `sections[]` would hand
 * the page the `prosePageSection` wrapper, and a bare `body[]` the `localeText` one. The
 * **order of both** is what the page renders — an explanation given backwards is still an
 * explanation made of well-formed paragraphs, so no decoder can catch it and
 * `test/whatisbachata.test.ts` asserts the positions against the dataset instead.
 *
 * No dereference in here, so no `_ref` beside one (MUSE-49). If a future trust page gives
 * a section a reference — an instructor, a class — the pair rule applies to it.
 */
export const PROSE_PAGES_QUERY = defineQuery(`
  *[_type == "prosePage"] | order(route asc){
    _id,
    route,
    heading{ hr, en },
    lede{ hr, en },
    "sections": sections[]{
      heading{ hr, en },
      "body": body[]{ hr, en }
    }
  }
`);

/**
 * The weekly schedule, flattened into the shape `src/lib/schedule.ts` already renders.
 *
 * A slot carries the day and the time; everything else is dereferenced off the class it
 * points at, so the Monday and Thursday rows of one class cannot describe it differently.
 *
 * `instructors` falls back from the slot's override to the class's regular teachers — one
 * `coalesce` here rather than a conditional in two layouts. It is an **array** on both
 * sides since MUSE-36: Mina and Antonio teach every group class together, so a single
 * reference published half of each row. `instructors[]->name` on an absent field is
 * `null`, which is what makes the `coalesce` work; on an array that is present it is the
 * names in the order they were listed, and the order is what the page renders.
 *
 * **`classRef` and `instructorRefs` are the MUSE-49 half**, and the `coalesce` is the
 * reason this query needed it most. A slot's override pointing at a deleted instructor used
 * to be worse than a blank: `coalesce` fell through to the class's regular teachers, so
 * `/schedule` published **a real name that was the wrong name** — a claim about a named
 * person, on the most-visited page on the site, that looks entirely correct.
 *
 * MUSE-36 incidentally closed the fallback itself, which is worth knowing because the
 * array is now load-bearing for a reason beyond two teachers: `instructors[]->name` over a
 * deleted reference answers `[null]`, a *non-null* array, so `coalesce` keeps the override
 * and the decoder refuses it. Revert the field to a single reference and the silent
 * fallback comes straight back, since `instructor->name` really is `null`. That is what
 * `AssertScheduleInstructorsAreAList` in `./shape.ts` is guarding, and it is a compile-time
 * guard rather than a comment for exactly this reason.
 *
 * `instructorRefs` repeats the `coalesce` rather than sharing it. Both spellings select on
 * the same thing — whether the slot's `instructors` attribute exists at all, since a
 * present array makes both halves non-null — so the two always take the same branch, and
 * the decoder's length check turns that from an argument into something checked.
 */
export const SCHEDULE_QUERY = defineQuery(`
  *[_type == "scheduleSlot" && active == true] | order(start asc){
    _id,
    day,
    start,
    "classId": class->_id,
    "classRef": class._ref,
    "name": class->name{ hr, en },
    "level": class->level,
    "durationMin": class->durationMin,
    "instructors": coalesce(instructors[]->name, class->instructors[]->name),
    "instructorRefs": coalesce(instructors[]._ref, class->instructors[]._ref)
  }
`);

/**
 * The classes themselves, independently of when they run.
 *
 * `description` and `image` are both **optional** as of MUSE-36 and project `undefined`
 * for a class that has neither — which is every class today: the homepage style cards
 * were the only thing that rendered either, and they went with `class.style`. See the
 * note on the fields in `sanity/schemaTypes/documents/studio.ts` for why neither can be
 * required while no photography and no class copy exist.
 */
export const CLASSES_QUERY = defineQuery(`
  *[_type == "class"] | order(coalesce(order, 999) asc, name.hr asc){
    _id,
    "slug": slug.current,
    name{ hr, en },
    level,
    description{ hr, en },
    durationMin,
    "instructors": instructors[]->name,
    "instructorRefs": instructors[]._ref,
    image{ "assetId": asset._ref, alt{ hr, en }, hotspot, crop }
  }
`);

/**
 * The people who teach. `/aboutus` is the only page that renders them (MUSE-23).
 *
 * `bio`, `portrait` and `instagram` are all **optional** in the schema, so each projects
 * `undefined` for a document that lacks it — which is every real instructor today: no
 * photography of this studio exists and nobody has written a bio. The page renders a
 * placeholder frame for the portrait, the name alone where there is no Instagram, and the
 * name and role alone where there is no paragraph; see the notes on `instructor` in
 * `sanity/schemaTypes/documents/studio.ts` for why none of the three can be required.
 *
 * That makes them the three fields in this query a typo could hide: an absent optional
 * field and a misspelled projection of it are the same `undefined`.
 * `test/projections.test.ts` covers it by giving exactly one fixture instructor an
 * Instagram URL and exactly one no portrait at all, so there is always a row that can
 * disagree.
 */
export const INSTRUCTORS_QUERY = defineQuery(`
  *[_type == "instructor"] | order(coalesce(order, 999) asc, name asc){
    _id,
    name,
    "slug": slug.current,
    role{ hr, en },
    bio{ hr, en },
    portrait{ "assetId": asset._ref, alt{ hr, en }, hotspot, crop },
    instagram
  }
`);

/**
 * The studio's origin story — the other half of `/aboutus`.
 *
 * A singleton pinned to a fixed `_id`, like `SITE_SETTINGS_QUERY`, so "no story yet" is a
 * `null` that `requireDocument` reports as *never created* rather than an empty list that
 * could mean either. `story` is an array of bilingual paragraphs and is projected as
 * `{hr, en}` per member for the same reason every other bilingual value is: a bare
 * `story[]` would hand the page the `localeText` wrapper.
 *
 * `foundedOn` carries the raw ISO date. The locale-specific rendering (§10: HR
 * `13. kolovoza 2026.`, EN `13 August 2026`) is `formatDate` in `src/lib/dates.ts` —
 * formatting is the page's decision, the same way an image's ratio is.
 */
export const STUDIO_STORY_QUERY = defineQuery(`
  *[_type == "studioStory" && _id == "studioStory"][0]{
    _id,
    heading{ hr, en },
    foundedOn,
    "story": story[]{ hr, en }
  }
`);

export const PRICING_QUERY = defineQuery(`
  *[_type == "pricingTier"] | order(coalesce(order, 999) asc, priceEur asc){
    _id,
    name{ hr, en },
    priceEur,
    period,
    "features": features[]{ hr, en },
    featured
  }
`);

/**
 * Events, soonest first, past ones dropped.
 *
 * `$now` is passed in rather than using GROQ's `now()` so the build is reproducible:
 * two builds of the same commit at the same `$now` produce byte-identical pages, which
 * is what makes `test/seo.test.ts`-style output comparison meaningful.
 */
export const EVENTS_QUERY = defineQuery(`
  *[_type == "event" && (!defined(endsAt) && startsAt >= $now || endsAt >= $now)] | order(startsAt asc){
    _id,
    "slug": slug.current,
    title{ hr, en },
    eventType,
    startsAt,
    endsAt,
    venue,
    description{ hr, en },
    lineup,
    ticketUrl,
    image{ "assetId": asset._ref, alt{ hr, en }, hotspot, crop }
  }
`);

export const GALLERY_QUERY = defineQuery(`
  *[_type == "galleryImage"] | order(coalesce(order, 999) asc, takenAt desc){
    _id,
    caption{ hr, en },
    takenAt,
    image{ "assetId": asset._ref, alt{ hr, en }, hotspot, crop }
  }
`);

/**
 * Posts, newest first, future-dated ones dropped.
 *
 * **`author` is the field MUSE-49 is named after**, and the only one on the site that was
 * entirely silent. It is optional on purpose — the Studio field says "Ostavi prazno i
 * objava je potpisana studijem", so a post signed by the studio rather than by a person is
 * an ordinary editorial choice and must keep building. That is exactly what made a deleted
 * author invisible: `author->name` answered `null`, the decoder read it as the empty
 * optional it is allowed to be, and the post published **unsigned** with nothing said.
 *
 * `authorRef` is what separates the two. A `_ref` with no value is a deleted instructor;
 * no `_ref` at all is a post the studio signs. See the note at the top of this file.
 */
export const POSTS_QUERY = defineQuery(`
  *[_type == "post" && publishedAt <= $now] | order(publishedAt desc){
    _id,
    "slug": slug.current,
    title{ hr, en },
    publishedAt,
    excerpt{ hr, en },
    "author": author->name,
    "authorRef": author._ref,
    coverImage{ "assetId": asset._ref, alt{ hr, en }, hotspot, crop },
    body{ hr, en }
  }
`);

export const FAQS_QUERY = defineQuery(`
  *[_type == "faq"] | order(coalesce(order, 999) asc, question.hr asc){
    _id,
    question{ hr, en },
    answer{ hr, en }
  }
`);

/**
 * A liveness probe: how many documents of each type the dataset holds.
 *
 * Exists so that "nothing came back" can be told apart from "the query is broken"
 * without guessing — see `countDocuments` in `./client.ts` and
 * `scripts/sanity-read-check.mjs`. A dataset that is legitimately empty answers this
 * with zeros; a dataset that cannot be reached, or a GROQ error, does not answer at all.
 */
export const DOCUMENT_COUNTS_QUERY = defineQuery(`
  {
    "siteSettings": count(*[_type == "siteSettings"]),
    "studioStory": count(*[_type == "studioStory"]),
    "page": count(*[_type == "page"]),
    "prosePage": count(*[_type == "prosePage"]),
    "class": count(*[_type == "class"]),
    "scheduleSlot": count(*[_type == "scheduleSlot"]),
    "instructor": count(*[_type == "instructor"]),
    "pricingTier": count(*[_type == "pricingTier"]),
    "event": count(*[_type == "event"]),
    "galleryImage": count(*[_type == "galleryImage"]),
    "post": count(*[_type == "post"]),
    "faq": count(*[_type == "faq"])
  }
`);

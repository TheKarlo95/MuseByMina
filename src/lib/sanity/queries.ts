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
 * The weekly schedule, flattened into the shape `src/lib/schedule.ts` already renders.
 *
 * A slot carries the day and the time; everything else is dereferenced off the class it
 * points at, so the Tuesday and Thursday rows of one class cannot describe it
 * differently. `instructor` falls back from the slot's override to the class's regular
 * teacher — one `coalesce` here rather than a conditional in two layouts.
 */
export const SCHEDULE_QUERY = defineQuery(`
  *[_type == "scheduleSlot" && active == true] | order(start asc){
    _id,
    day,
    start,
    "classId": class->_id,
    "name": class->name{ hr, en },
    "style": class->style,
    "level": class->level,
    "durationMin": class->durationMin,
    "instructor": coalesce(instructor->name, class->instructor->name)
  }
`);

export const CLASSES_QUERY = defineQuery(`
  *[_type == "class"] | order(coalesce(order, 999) asc, name.hr asc){
    _id,
    "slug": slug.current,
    name{ hr, en },
    style,
    level,
    description{ hr, en },
    durationMin,
    "instructor": instructor->name,
    image{ "assetId": asset._ref, alt{ hr, en }, hotspot, crop }
  }
`);

export const INSTRUCTORS_QUERY = defineQuery(`
  *[_type == "instructor"] | order(coalesce(order, 999) asc, name asc){
    _id,
    name,
    "slug": slug.current,
    role{ hr, en },
    bio{ hr, en },
    portrait{ "assetId": asset._ref, alt{ hr, en }, hotspot, crop }
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

export const POSTS_QUERY = defineQuery(`
  *[_type == "post" && publishedAt <= $now] | order(publishedAt desc){
    _id,
    "slug": slug.current,
    title{ hr, en },
    publishedAt,
    excerpt{ hr, en },
    "author": author->name,
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
    "page": count(*[_type == "page"]),
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

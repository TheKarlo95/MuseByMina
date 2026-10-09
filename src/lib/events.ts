import { localeUrl, type Locale } from './i18n';
import { ROUTES } from './pages';

/**
 * **`/events` — the parties and workshops, their detail pages, and the archive** (MUSE-24).
 *
 * This file holds the three decisions the ticket asked to be made once and written down,
 * plus the interface chrome the three components share. None of it is content: every
 * string here describes the *page* or the *site's own state*, never the studio — the event
 * itself, its venue, its time and its description are all `event` documents in Sanity.
 *
 * ---------------------------------------------------------------------------------
 * ## 1. The slug shape, which is permanent
 *
 * `/events/<slug>/`, where `<slug>` is the document's own stored slug. Not derived from the
 * date at build time, and that is the decision: a derived URL moves when Mina corrects a
 * typo in `startsAt`, and an archive URL that moves is an archive URL that 404s for
 * everyone who ever linked it. A stored slug is written once and then is a fact.
 *
 * The collision the ticket names is a **repeat annual event**: the Studio sources a slug
 * from `title.hr`, so „Noć bachate" in 2026 and again in 2027 produce the same string, and
 * Sanity's own uniqueness check then refuses the second one with a message about a slug
 * rather than about the year — leaving Mina to invent `noc-bachate-2`, forever. So the
 * Studio's slug source is a **function that prefixes the year from `startsAt`**
 * (`sanity/schemaTypes/documents/offering.ts`), giving `2026-noc-bachate`. Two editions
 * then differ without anybody thinking about it, the year reads as an edition rather than
 * as a disambiguator, and the slug is still only ever generated once and stored.
 *
 * Month and day are deliberately not in it. An annual party that moves from August to
 * September is the same edition; a slug carrying the day would make its URL look wrong the
 * moment the date is corrected, which is the thing a stored slug exists to avoid.
 *
 * ## 2. The reserved slugs, which are derived rather than listed
 *
 * `/events/archive/` is a static page and `/events/<slug>/` is a dynamic one. Astro gives a
 * static segment priority, so an event slugged `archive` would build a page that **nothing
 * can reach** — the archive is served at that URL instead, and no error is raised anywhere.
 * {@link reservedEventSlugs} reads the slugs off `ROUTES` rather than naming them, so a
 * second static child of `/events` reserves itself the day it is routed, and
 * {@link assertEventSlugs} fails the build naming the event, the slug and the route it
 * collides with.
 *
 * The guard is at build time and **not** in the Studio, which is a judgement rather than an
 * omission: the only instrument Sanity offers for „this string, specifically, is not
 * allowed" on a slug is `Rule.custom`, and `sanity/schemaTypes/enums.ts` records that a
 * custom rule is skipped entirely unless the validation run is given a client — so it would
 * be a guard that is real in the Studio and unobservable in a test, which is the shape this
 * repository refuses. The build failure is observable, names all three things, and cannot
 * be reached without somebody retyping an auto-generated slug.
 *
 * ## 3. When an event becomes a past event
 *
 * At **build time**, and nowhere else. `getEvents` and `getPastEvents` are handed the same
 * `$now` and their GROQ filters are exact complements, so every event is on exactly one of
 * the two pages; `getAllEvents` takes no clock at all, which is what makes the detail page
 * for an event exist whatever the build's instant is.
 *
 * The site is static, so nothing moves until something builds. What builds is a push and
 * MUSE-21's scheduled rebuild, `20 1,7,13,19` UTC — four runs, evenly spaced, so the
 * largest gap between them is `MAX_WAIT_HOURS` in `src/lib/rebuild.ts`. **That is the
 * staleness window**, and the worst case is an event that finished just after a run showing
 * as upcoming for very nearly that long.
 *
 * That is accepted, for three reasons:
 *
 *   - **The alternative is a second answer to the same question.** Re-filtering in the
 *     browser would mean a card whose position depends on JavaScript, on one of the two
 *     pages where a crawler is the most important reader — and the built output contains
 *     zero `.js` files by design (`test/nojs.test.ts`).
 *   - **It is wrong in the harmless direction.** Nobody is sent to an event that has not
 *     happened; a reader sees last night's party in the upcoming list with last night's
 *     date printed on it, which is self-correcting information rather than a false claim.
 *     The detail page of a past event says so in words — {@link EVENT_COPY}'s `passed` —
 *     and that line is computed from the same `$now`, so the two surfaces cannot disagree.
 *   - **No URL depends on it.** `getAllEvents` is clockless, so `/events/<slug>/` resolves
 *     identically in every build regardless of which list the event is on.
 *
 * Nothing on the page is stamped with a build time. A „last updated" line would be a
 * different value in two builds of one commit, which is the criterion `test/origin.test.ts`
 * fingerprints two independent builds to protect.
 * ---------------------------------------------------------------------------------
 */

/** The index. */
export const EVENTS_ROUTE = '/events';

/** The permanent record. A child of {@link EVENTS_ROUTE}, which is why it is reserved. */
export const EVENTS_ARCHIVE_ROUTE = '/events/archive';

/**
 * **The event kinds, and the word each one is shown as.**
 *
 * Here rather than in `sanity/schemaTypes/enums.ts` — which is where they were until this
 * ticket — because the page now renders them, and that file's own opening rule is that an
 * option list is derived from the constant that owns it. `EVENT_TYPE_OPTIONS` there is
 * `EVENT_TYPE_NAME` mapped, so the label Mina picks in the Studio and the label a visitor
 * reads are one string. A second copy of four words is how MUSE-76 happened.
 *
 * The four names are **identical in both locales**, and that is the same exception
 * `LEVEL_NAME` takes for the levels: these are proper nouns of the social-dance scene
 * rather than prose, a Croatian dancer says „party" and „workshop", and translating
 * „bootcamp" would invent a word nobody uses. It is still a `Record<Locale, …>`, so
 * reversing the decision is a data edit and not a refactor.
 */
export const EVENT_TYPES = ['party', 'workshop', 'bootcamp', 'social'] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_TYPE_NAME: Record<Locale, Record<EventType, string>> = {
  hr: { party: 'Party', workshop: 'Workshop', bootcamp: 'Bootcamp', social: 'Social' },
  en: { party: 'Party', workshop: 'Workshop', bootcamp: 'Bootcamp', social: 'Social' },
};

/** The word for one event kind, or the raw value if the schema has grown one we cannot name. */
export function eventTypeName(eventType: string, locale: Locale): string {
  return EVENT_TYPE_NAME[locale][eventType as EventType] ?? eventType;
}

/** The URL of one event's detail page, in `locale`. The only place that path is built. */
export function eventUrl(slug: string, locale: Locale): string {
  return localeUrl(`${EVENTS_ROUTE}/${slug}`, locale);
}

/**
 * The slugs an event may not have, because a static page already answers that URL.
 *
 * Derived from `ROUTES`: every route that is a direct child of `/events` contributes its
 * last segment. `/events/archive` is the only one today and the list must never be written
 * out, for the reason `test/seo.test.ts` reads its page list off `src/pages/` — a
 * hand-maintained copy of „which pages exist" is the thing that goes stale.
 */
export function reservedEventSlugs(): string[] {
  const prefix = `${EVENTS_ROUTE}/`;
  return ROUTES.map(({ route }) => route)
    .filter((route) => route.startsWith(prefix))
    .map((route) => route.slice(prefix.length))
    .filter((slug) => slug !== '' && !slug.includes('/'));
}

/** The least an event has to be for its URL to be decidable. */
interface Sluggable {
  id: string;
  slug: string;
}

/**
 * Fail the build if any event's slug cannot be a URL of its own.
 *
 * Two failures, both silent without this. A **reserved** slug builds a page Astro then
 * shadows with the static route, so the event is published and unreachable. A
 * **duplicated** slug means two events claiming one URL, and which one wins is Astro's
 * business rather than a decision anybody made — so the other event is equally
 * unreachable, and the one that wins may be the stale edition of a repeat.
 *
 * Called from `getStaticPaths` in both locale templates, which is the one place that
 * already has every event in front of it.
 */
export function assertEventSlugs(events: readonly Sluggable[]): void {
  const reserved = reservedEventSlugs();

  const clashes = events
    .filter((event) => reserved.includes(event.slug))
    .map(
      (event) =>
        `  \`${event.id}\` is slugged "${event.slug}", which is the URL of ` +
        `${EVENTS_ROUTE}/${event.slug} — a page this site already serves.`,
    );

  const seen = new Map<string, string[]>();
  for (const event of events) {
    seen.set(event.slug, [...(seen.get(event.slug) ?? []), event.id]);
  }
  const duplicates = [...seen]
    .filter(([, ids]) => ids.length > 1)
    .map(
      ([slug, ids]) => `  "${slug}" is the slug of ${ids.length} events: ${ids.join(', ')}.`,
    );

  if (clashes.length === 0 && duplicates.length === 0) return;

  throw new Error(
    [
      `An \`event\` document cannot be published at the URL its slug asks for.`,
      ...clashes,
      ...duplicates,
      `  Reserved, because a static page answers each of these: ` +
        `${reserved.map((slug) => `"${slug}"`).join(', ')}.`,
      `  Astro gives a static route priority over a dynamic one, so the page would be ` +
        `built and then shadowed — published, and reachable by nobody. Change the slug ` +
        `in the Studio; it is the event's permanent address, so change it before the ` +
        `event is announced rather than after.`,
    ].join('\n'),
  );
}

/**
 * **Interface chrome, and the empty state — which is the state this page ships in.**
 *
 * There are no `event` documents in the dataset and nobody has given us any, so every
 * sentence here has to be true of a page with nothing on it. Three rules it is written
 * against, each one a thing the ticket asked for:
 *
 *   - **It says plainly that there is nothing.** Not „ništa za sada", not „provjeri
 *     kasnije" — those are promises about events nobody has announced, which is MUSE-36's
 *     mistake in a smaller font.
 *   - **It does not hint at past events.** The empty block offers `/schedule` and
 *     `/contact` and says nothing about the archive; the archive link is a navigational
 *     affordance in its own section, and the archive page is honest about being empty too.
 *   - **It is not an empty grid.** The list is not rendered at all when there is nothing in
 *     it, so there is no row of placeholder cards and no bare heading over nothing.
 *
 * The words are **code, not CMS**, and that is the one judgement worth defending here. A
 * `localeString` for „there are no events" would be a field whose correct value depends on
 * what else is in the dataset — Mina cannot know when it renders, so she cannot keep it
 * true, and a stale one would read as a claim rather than as a state. It sits with
 * `FORM_COPY` and `LEVEL_PREREQUISITE` for the same reason
 * (`sanity/schemaTypes/enums.ts` lists them): interface chrome that describes the site's own
 * behaviour stays in code. Everything a *reader* would call content — a title, a venue, a
 * description, a date — is a field.
 *
 * Croatian first, because Croatian sets the layout (§10).
 */
export const EVENT_COPY: Record<
  Locale,
  {
    /** `/events` */
    eyebrow: string;
    heading: string;
    lede: string;
    upcoming: string;
    emptyHeading: string;
    emptyBody: string;
    toSchedule: string;
    toContact: string;
    archive: string;
    /** `/events/archive` */
    archiveEyebrow: string;
    archiveHeading: string;
    archiveLede: string;
    archiveEmptyHeading: string;
    archiveEmptyBody: string;
    toEvents: string;
    /** `/events/<slug>` */
    when: string;
    where: string;
    lineup: string;
    tickets: string;
    ask: string;
    passed: string;
    /** Shared */
    more: string;
  }
> = {
  hr: {
    eyebrow: 'Izvan tjednog rasporeda',
    heading: 'Događaji',
    lede:
      'Partyji, workshopovi i sociali — svaki s datumom, vremenom i lokacijom na ' +
      'vlastitoj stranici.',
    upcoming: 'Što je sljedeće',
    emptyHeading: 'Nema objavljenih događaja.',
    emptyBody: 'Redovni satovi idu po tjednom rasporedu.',
    toSchedule: 'Raspored',
    toContact: 'Kontakt',
    archive: 'Arhiva',
    archiveEyebrow: 'Arhiva',
    archiveHeading: 'Prošli događaji',
    archiveLede: 'Što je bilo. Svaki događaj ostaje na svojoj adresi.',
    archiveEmptyHeading: 'Arhiva je prazna.',
    archiveEmptyBody: 'Događaj se seli ovamo nakon što prođe, i zadržava svoju adresu.',
    toEvents: 'Svi događaji',
    when: 'Kada',
    where: 'Gdje',
    lineup: 'Gosti',
    tickets: 'Prijava i ulaznice',
    ask: 'Pitaj nas za detalje',
    passed: 'Ovaj je događaj prošao.',
    more: 'Detalji',
  },
  en: {
    eyebrow: 'Outside the weekly schedule',
    heading: 'Events',
    lede:
      'Parties, workshops and socials — each with its date, time and venue on a page of ' +
      'its own.',
    upcoming: 'What is next',
    emptyHeading: 'No events are published.',
    emptyBody: 'Regular classes run to the weekly schedule.',
    toSchedule: 'Schedule',
    toContact: 'Contact',
    archive: 'Archive',
    archiveEyebrow: 'Archive',
    archiveHeading: 'Past events',
    archiveLede: 'What has been. Every event keeps its address.',
    archiveEmptyHeading: 'The archive is empty.',
    archiveEmptyBody: 'An event moves here once it has passed, and keeps its address.',
    toEvents: 'All events',
    when: 'When',
    where: 'Where',
    lineup: 'Line-up',
    tickets: 'Sign-up and tickets',
    ask: 'Ask us for details',
    passed: 'This event has passed.',
    more: 'Details',
  },
};

/* ------------------------------------------------------------- the clock, in TS */

/** The least an event has to be for „has it happened" to be answerable. */
interface Dated {
  startsAt: string;
  endsAt?: string;
}

/**
 * **Has this event finished, by the same rule the archive's GROQ filter uses?**
 *
 * The page needs this for one sentence — a detail page for a past event says so, rather
 * than reading as an invitation to a party that happened last month — and the sentence has
 * to agree with which list the event is on. So the predicate is written once, here, as
 * exactly the condition `PAST_EVENTS_QUERY` selects on:
 *
 *     defined(endsAt) ? endsAt < $now : startsAt < $now
 *
 * String comparison rather than `Date` arithmetic, deliberately, because that is what GROQ
 * does: both sides are ISO strings there, and `$now` is always `Date#toISOString`'s
 * spelling. Comparing instants here and strings there would be two rules that agree until
 * they do not — and the one case where they diverge is the one `isIsoInstant` in
 * `src/lib/dates.ts` refuses, which is why the decoder refuses it too.
 *
 * `test/projections.test.ts` runs this against the same fixture it runs the two queries
 * against and requires the three to agree row for row, so „the words on the page" and
 * „which page it is on" cannot come apart.
 */
export function hasPassed(event: Dated, now: Date): boolean {
  return (event.endsAt ?? event.startsAt) < now.toISOString();
}

/* ------------------------------------------------------------------ page metadata */

/**
 * What a detail page puts in `<title>` and `<meta name="description">`.
 *
 * **Derived rather than a `page` document**, which is the one place `/events/<slug>/`
 * departs from the convention in `src/lib/pages.ts`. A `page` document exists per *route*,
 * and the routes the Studio may describe are `ROUTES` — a document per event would be a
 * second document Mina has to remember to write, keyed on a route that is not in the list,
 * saying again what the `event` document already says. So the event is the source and the
 * shape is code: the title is the event's own title beside the studio's name, in the
 * separator the seeded titles already use, and the description is the event's own
 * description cut to something a search result can show.
 *
 * `studioName` is passed in rather than read here, so it is the same `siteSettings` value
 * the footer and the JSON-LD block render — one read, no second copy (MUSE-50).
 */
export function eventMetaTitle(title: string, studioName: string): string {
  return `${title} — ${studioName}`;
}

/** Roughly what Google will show, cut at a word rather than mid-syllable. */
const META_DESCRIPTION_LIMIT = 160;

export function eventMetaDescription(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();
  if (flat.length <= META_DESCRIPTION_LIMIT) return flat;

  const cut = flat.slice(0, META_DESCRIPTION_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:—-]$/, '')}…`;
}

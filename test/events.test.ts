import { readFileSync } from 'node:fs';

import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import EventCard from '../src/components/EventCard.astro';
import EventPage from '../src/components/EventPage.astro';
import Events from '../src/components/Events.astro';
import EventsArchive from '../src/components/EventsArchive.astro';
import {
  formatInstantDate,
  formatInstantTime,
  instantChip,
  isIsoInstant,
  STUDIO_TIME_ZONE,
} from '../src/lib/dates';
import {
  EVENTS_ARCHIVE_ROUTE,
  EVENTS_ROUTE,
  EVENT_COPY,
  EVENT_TYPES,
  EVENT_TYPE_NAME,
  assertEventSlugs,
  eventMetaDescription,
  eventMetaTitle,
  eventTypeName,
  eventUrl,
  hasPassed,
  reservedEventSlugs,
} from '../src/lib/events';
import { LOCALES, localeUrl, type Locale } from '../src/lib/i18n';
import { MORE_NAV, PRIMARY_NAV } from '../src/lib/nav';
import { ROUTES } from '../src/lib/pages';
import { MAX_WAIT_HOURS } from '../src/lib/rebuild';
import { decodeEvent, type StudioEvent } from '../src/lib/sanity/decode';
import { FIXTURE_ENV } from '../src/lib/sanity/fixture';
import { EVENT_TYPE_OPTIONS } from '../sanity/schemaTypes/enums';
import { event as eventSchema } from '../sanity/schemaTypes/documents/offering';
import { PAGES_DEPLOY, basePath, buildSite, canonicalOf, type Build } from './helpers/build';
import { seedDocs } from './helpers/seed';
import { servePages, type Host } from './helpers/serve';
import {
  EVENTS_RENDERED,
  EVENTS_REWRITTEN,
  EVENT_RENDER_LATER,
  EVENT_RENDER_PAST,
  EVENT_RENDER_SOON,
  EVENT_RESERVED_SLUG,
  fixtureOf,
  type FixtureDoc,
} from './helpers/structural-content';

/**
 * **MUSE-24 — `/events`, the detail pages, and the archive.**
 *
 * The ticket named two hard problems and this file is where both are held to an answer.
 *
 * **1. The upcoming/past split is computed at build time on a static site.** So an event
 * does not move to the archive until something builds, and what builds is a push plus
 * MUSE-21's scheduled rebuild — four evenly spaced runs, so the window an event can sit on
 * the wrong list for is `MAX_WAIT_HOURS`. That number is *derived* and `src/lib/events.ts`
 * cites it by name rather than writing it out, which is asserted below for MUSE-21's own
 * reason: a sentence naming a duration goes stale the day the cron changes, and a sentence
 * naming a clock time was already wrong for half the year.
 *
 * What is *not* allowed to depend on the clock is which pages exist. `getAllEvents` takes no
 * `$now`, so `/events/<slug>/` resolves in every build whatever instant it ran at — which
 * is the acceptance criterion „its URL keeps working", made structural rather than tested
 * into place. `test/projections.test.ts` carries the partition itself, over a pinned `$now`
 * with rows on both sides of the boundary; what is here is the half only a real build can
 * show: a past-dated event is on the archive, is not on the index, and its URL answers 200
 * through the model of GitHub Pages.
 *
 * **2. Slugs are permanent.** `/events/<slug>/` is the document's stored slug, year-prefixed
 * by the Studio's slug source so a repeat annual edition does not collide with itself, and
 * `archive` is refused because the static route would shadow it. The derivation, not the
 * list, is what is asserted: a second static child of `/events` has to reserve itself.
 *
 * ---------------------------------------------------------------------------------
 * **One build, and why the rest is the container API.**
 *
 * MUSE-68's heavyweight budget has no headroom, so this file performs exactly one
 * `astro build` and takes everything it can from Astro's container API, which compiles and
 * runs the real component against real props and costs nothing. The division is not
 * arbitrary: the container runs no asset pipeline and no router, so it cannot see CSS,
 * cannot see a URL and cannot see `getStaticPaths`. Those three are precisely what the one
 * build is spent on. Everything else — the words, the dates, the branches, the empty state
 * — is markup, and markup is what the container returns.
 *
 * `npm run ds` reads the components' style blocks for the token rules, `npm run a11y`
 * audits both new routes in both themes off the committed seed, and `test/numerals.test.ts`
 * sweeps every route in `ROUTES` for a component that redeclares `font-variant-numeric` —
 * so the date chip's figures are measured in a browser without this file opening one.
 * ---------------------------------------------------------------------------------
 */

/**
 * The Studio's own slug-suggestion function, pulled off the real schema definition.
 *
 * Read off the definition rather than out of the file, because a `source` that stopped
 * being a function would still look right in a diff — and `defineField`'s types do not
 * narrow per field, so the cast goes through `unknown` and the shape is then *checked*
 * rather than asserted.
 */
function slugSource(): (doc: Record<string, unknown>) => string {
  const field = eventSchema.fields.find((candidate) => candidate.name === 'slug');
  expect(field, 'the event schema has no slug field').toBeDefined();
  const source = (field as unknown as { options?: { source?: unknown } }).options?.source;
  expect(typeof source, '`slug.options.source` is not a function').toBe('function');
  return source as (doc: Record<string, unknown>) => string;
}

/* ------------------------------------------------------------------ the slug shape */

describe('the slug is permanent, and `archive` is not one (AC3)', () => {
  it('reserves the last segment of every static child of /events', () => {
    // Derived from `ROUTES`, never listed: a second static page under `/events` reserves
    // itself the day it is routed. `archive` is the only one today, and the assertion is
    // written as the derivation rather than as `['archive']` so that stays true.
    const children = ROUTES.map(({ route }) => route).filter((route) =>
      route.startsWith(`${EVENTS_ROUTE}/`),
    );
    expect(children).not.toEqual([]);
    expect(reservedEventSlugs()).toEqual(
      children.map((route) => route.slice(`${EVENTS_ROUTE}/`.length)),
    );
    expect(reservedEventSlugs()).toContain('archive');
  });

  it('fails the build naming the event, the slug and the page it would be shadowed by', () => {
    const boom = (): void =>
      assertEventSlugs([{ id: EVENT_RESERVED_SLUG._id, slug: 'archive' }]);

    expect(boom).toThrow(EVENT_RESERVED_SLUG._id);
    expect(boom).toThrow('"archive"');
    expect(boom).toThrow(EVENTS_ARCHIVE_ROUTE);
    // And it says what to do about it, because the fix is a Studio edit and the reason it
    // has to happen before the event is announced is the whole slug decision.
    expect(boom).toThrow(/permanent address/);
  });

  it('fails on two events claiming one URL, naming both', () => {
    const boom = (): void =>
      assertEventSlugs([
        { id: 'event-a', slug: '2026-noc-bachate' },
        { id: 'event-b', slug: '2026-noc-bachate' },
      ]);

    expect(boom).toThrow('event-a');
    expect(boom).toThrow('event-b');
    expect(boom).toThrow('2026-noc-bachate');
  });

  it('says nothing about slugs that are fine', () => {
    // The false-positive half. A guard that refused every slug would satisfy the three
    // assertions above and stop the site building the first time Mina announced anything.
    expect(() =>
      assertEventSlugs([
        { id: 'event-a', slug: '2026-noc-bachate' },
        { id: 'event-b', slug: '2027-noc-bachate' },
      ]),
    ).not.toThrow();
    expect(() => assertEventSlugs([])).not.toThrow();
  });

  it('builds one URL per locale, slashed, from the one place that builds it', () => {
    for (const locale of LOCALES) {
      expect(eventUrl('2026-noc-bachate', locale)).toBe(
        localeUrl(`${EVENTS_ROUTE}/2026-noc-bachate`, locale),
      );
      expect(eventUrl('2026-noc-bachate', locale).endsWith('/')).toBe(true);
    }
    expect(eventUrl('x', 'en')).toContain('/en/');
    expect(eventUrl('x', 'hr')).not.toContain('/en/');
  });

  /**
   * **The Studio's own slug source, called.**
   *
   * The collision this exists for is a repeat annual event: `source: 'title.hr'` produces
   * the same string twice and Sanity then refuses the second one, so Mina is left inventing
   * `noc-bachate-2` as that edition's permanent URL. Asserted by pulling the function off
   * the real schema definition and calling it, rather than by reading the file — a
   * `source` that stopped being a function would still look right in a diff.
   */
  it('prefixes the year from `startsAt`, so next year does not collide', () => {
    const generate = slugSource();
    const title = { hr: 'Noć bachate' };

    expect(generate({ title, startsAt: '2026-08-13T19:00:00.000Z' })).toBe('2026 Noć bachate');
    expect(generate({ title, startsAt: '2027-08-12T19:00:00.000Z' })).toBe('2027 Noć bachate');
    // Two editions of one party produce two different slugs, which is the whole point.
    expect(generate({ title, startsAt: '2026-08-13T19:00:00.000Z' })).not.toBe(
      generate({ title, startsAt: '2027-08-12T19:00:00.000Z' }),
    );
  });

  it('falls back to the title alone before a date has been typed', () => {
    // The field sits above `startsAt` in the Studio, so a new document has no date while
    // the title is being written. Without the fallback the suggestion would read
    // `undefined-noc-bachate`, which somebody would accept.
    const generate = slugSource();

    expect(generate({ title: { hr: 'Noć bachate' } })).toBe('Noć bachate');
    expect(generate({ title: { hr: 'Noć bachate' }, startsAt: 'not-a-date' })).toBe(
      'Noć bachate',
    );
    expect(generate({})).toBe('');
  });
});

/* ------------------------------------------------------------- the dates (AC4, §10) */

describe('a date is formatted per locale, and in the studio’s own zone (AC4)', () => {
  /** 21:00 on a Thursday in Zagreb, written as the instant Sanity stores. */
  const AUGUST_EVENING = '2026-08-13T19:00:00.000Z';

  it('writes §10’s two forms, which are not translations of one another', () => {
    expect(formatInstantDate(AUGUST_EVENING, 'hr')).toBe('13. kolovoza 2026.');
    expect(formatInstantDate(AUGUST_EVENING, 'en')).toBe('13 August 2026');
  });

  it('is 24-hour in Croatian and 12-hour in English', () => {
    expect(formatInstantTime(AUGUST_EVENING, 'hr')).toBe('21:00');
    expect(formatInstantTime(AUGUST_EVENING, 'en')).toBe('9:00 pm');
  });

  it('renders the time in the room rather than in UTC', () => {
    /**
     * The one thing a `datetime` field makes easy to get wrong. `19:00Z` is 21:00 in Ilica
     * in August and 20:00 in December, and the build publishes static HTML — so a formatter
     * on UTC freezes 19:00 into the page, and one on the build machine's zone makes the
     * published page depend on where the build ran. Both halves are asserted, because the
     * daylight-saving half is what a fixed `+02:00` offset would get wrong.
     */
    expect(STUDIO_TIME_ZONE).toBe('Europe/Zagreb');
    expect(formatInstantTime('2026-08-13T19:00:00.000Z', 'hr')).toBe('21:00');
    expect(formatInstantTime('2026-12-13T19:00:00.000Z', 'hr')).toBe('20:00');
    // And the date follows the zone too: 23:30 UTC is already tomorrow in Zagreb.
    expect(formatInstantDate('2026-08-13T23:30:00.000Z', 'hr')).toBe('14. kolovoza 2026.');
  });

  it('spells midnight `00:00`, not `24:00`', () => {
    // `hour12: false` alone can resolve to the `h24` cycle. Croatian is the locale that
    // gets it, and „24:00" on a party that starts at midnight reads as a typo.
    expect(formatInstantTime('2026-08-13T22:00:00.000Z', 'hr')).toBe('00:00');
    expect(formatInstantTime('2026-08-13T22:00:00.000Z', 'en')).toBe('12:00 am');
  });

  it('gives the chip a bare day number and an abbreviated month', () => {
    // Croatian's `day: 'numeric'` renders `13.` with its ordinal full stop, which is right
    // in a sentence and wrong stacked above a month — so the day comes off `formatToParts`
    // rather than off the formatted string.
    expect(instantChip(AUGUST_EVENING, 'hr')).toEqual({ day: '13', month: 'kol' });
    expect(instantChip(AUGUST_EVENING, 'en')).toEqual({ day: '13', month: 'Aug' });
  });

  it('refuses anything that is not a UTC ISO instant', () => {
    /**
     * `Intl` renders an unparseable date as the literal words "Invalid Date" — on a card,
     * at 28px, inside the chip. And an offset spelling (`…+02:00`) is the same instant as a
     * different *string*, which is what the upcoming/past split compares, so it would sort
     * into the wrong list. Both are refused rather than formatted.
     */
    expect(isIsoInstant('2026-08-13T19:00:00.000Z')).toBe(true);
    expect(isIsoInstant('2026-08-13T19:00:00Z')).toBe(true);
    expect(isIsoInstant('2026-08-13T21:00:00+02:00')).toBe(false);
    expect(isIsoInstant('2026-08-13')).toBe(false);
    expect(isIsoInstant('nonsense')).toBe(false);

    for (const bad of ['2026-08-13', '2026-08-13T21:00:00+02:00', 'nonsense', '']) {
      expect(() => formatInstantDate(bad, 'hr'), bad).toThrow(/Invalid Date/);
    }
  });

  it('is refused by the decoder too, naming the document and the field', () => {
    // The formatter throwing is the last line; the decoder is where it should stop, because
    // that is the layer whose errors name an `_id` Mina can open.
    const row = {
      _id: 'event-broken',
      slug: 'event-broken',
      title: { hr: 'A', en: 'B' },
      eventType: 'party',
      startsAt: '2026-08-13T21:00:00+02:00',
      venue: 'V',
      description: { hr: 'A', en: 'B' },
      image: { assetId: 'image-abc-16x9-jpg', alt: { hr: 'A', en: 'B' } },
    };

    expect(() => decodeEvent(row)).toThrow('event-broken');
    expect(() => decodeEvent(row)).toThrow('startsAt');
    expect(() => decodeEvent({ ...row, startsAt: '2026-08-13T19:00:00.000Z' })).not.toThrow();
    expect(() =>
      decodeEvent({
        ...row,
        startsAt: '2026-08-13T19:00:00.000Z',
        endsAt: 'tomorrow night',
      }),
    ).toThrow('endsAt');
  });
});

/* ---------------------------------------------------- the event kinds, and one copy of them */

describe('the event kinds are a closed set with one home', () => {
  it('offers the Studio exactly the kinds the page can name', () => {
    // MUSE-76's lesson applied before it happens: the option list is `EVENT_TYPE_NAME`
    // mapped, so the label Mina picks and the label a visitor reads are one string.
    expect(EVENT_TYPE_OPTIONS.map((option) => option.value)).toEqual([...EVENT_TYPES]);
    expect(EVENT_TYPE_OPTIONS.map((option) => option.title)).toEqual(
      EVENT_TYPES.map((eventType) => EVENT_TYPE_NAME.hr[eventType]),
    );
  });

  it('names every kind in both locales, and falls back rather than rendering blank', () => {
    for (const locale of LOCALES) {
      for (const eventType of EVENT_TYPES) {
        expect(eventTypeName(eventType, locale)).toBe(EVENT_TYPE_NAME[locale][eventType]);
        expect(eventTypeName(eventType, locale)).not.toBe('');
      }
    }
    // A kind the schema grows before this map does renders its own value rather than
    // `undefined` — a card with a blank label is worse than one with a raw word on it.
    expect(eventTypeName('bootcampweekend', 'hr')).toBe('bootcampweekend');
  });
});

/* -------------------------------------------------------------------- page metadata */

describe('a detail page describes itself without a `page` document', () => {
  it('names the event beside the studio, in the separator the site already uses', () => {
    expect(eventMetaTitle('Noć bachate', 'Muse by Mina')).toBe('Noć bachate — Muse by Mina');
  });

  it('cuts a long description at a word, and leaves a short one alone', () => {
    const short = 'Party u studiju.';
    expect(eventMetaDescription(short)).toBe(short);

    const long = `${'riječ '.repeat(60)}kraj`;
    const cut = eventMetaDescription(long);
    expect(cut.length).toBeLessThanOrEqual(161);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut).not.toMatch(/\s…$/);
    // Cut at a word rather than mid-syllable: no partial token before the ellipsis.
    expect(cut.slice(0, -1).split(' ').at(-1)).toBe('riječ');
  });

  it('flattens the paragraph breaks a `localeText` field carries', () => {
    expect(eventMetaDescription('Prvi odlomak.\n\nDrugi odlomak.')).toBe(
      'Prvi odlomak. Drugi odlomak.',
    );
  });
});

/* ------------------------------------------------- the staleness window, named not written */

describe('the staleness window is derived from the rebuild cadence, never written down', () => {
  /**
   * MUSE-21's rule, applied to a new page: **what is promised is a duration, and the
   * duration is computed from the cron.** A comment saying „up to six hours" is a comment
   * that is wrong the day `REBUILD_HOURS_UTC` changes, and nothing would say so — which is
   * exactly how „15:20" ended up wrong for half the year.
   *
   * So the prose cites `MAX_WAIT_HOURS` by name and this is the assertion that it has to.
   * It is a text scan, in the shape `test/offerclaims.test.ts` uses, because the thing being
   * protected *is* prose: there is no constant for „how stale can this page be", and
   * inventing one that nothing renders would be a worse answer than a citation.
   */
  const SOURCES = ['src/lib/events.ts', 'src/components/EventPage.astro'];

  it('cites the constant in the files that explain the window', () => {
    for (const file of SOURCES) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(text, `${file} does not name MAX_WAIT_HOURS`).toContain('MAX_WAIT_HOURS');
    }
  });

  it('writes no hour count of its own beside it', () => {
    const offenders: string[] = [];
    for (const file of SOURCES) {
      const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      text.split('\n').forEach((line, index) => {
        // A number or a spelled-out quantity followed by an hour word. „20 1,7,13,19 UTC"
        // is the cron itself and is allowed to be quoted; „six hours" is not.
        if (
          /\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+hours?\b/i.test(line)
        ) {
          offenders.push(`${file}:${index + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      'the window is `MAX_WAIT_HOURS` and must not be restated as a number — the cron ' +
        'can change and a sentence cannot notice (MUSE-21).',
    ).toEqual([]);
  });

  it('has a window at all, so the citation is not decorative', () => {
    expect(MAX_WAIT_HOURS).toBeGreaterThan(0);
    expect(MAX_WAIT_HOURS).toBeLessThanOrEqual(24);
  });
});

/* ------------------------------------------------------------- routing, three lists agree */

describe('the two static routes are declared everywhere a route has to be', () => {
  it('routes the index and the archive, in that order', () => {
    const routes = ROUTES.map(({ route }) => route);
    expect(routes).toContain(EVENTS_ROUTE);
    expect(routes).toContain(EVENTS_ARCHIVE_ROUTE);
    expect(routes.indexOf(EVENTS_ARCHIVE_ROUTE)).toBe(routes.indexOf(EVENTS_ROUTE) + 1);
  });

  it('seeds a `page` document for each, with the label the Studio dropdown shows', () => {
    // The `studioLabel`/`name.hr` agreement is `test/contentdrift.test.ts`'s; this is the
    // half that says the documents are there at all, which is what the build fails on.
    const documented = new Map(
      seedDocs()
        .filter((doc) => doc._type === 'page')
        .map((doc) => [doc.route as string, doc._id]),
    );
    expect(documented.get(EVENTS_ROUTE)).toBe('page-events');
    expect(documented.get(EVENTS_ARCHIVE_ROUTE)).toBe('page-events-archive');
  });

  it('puts the index in the nav and keeps the archive out of every list', () => {
    /**
     * `/events` is in the „More" disclosure rather than the desktop bar, which `nav.ts`
     * argues; what matters here is that it is in *a* list, because `test/nav.test.ts`'s
     * orphan rule is what makes a shipped-but-unlinked page a failure.
     *
     * `/events/archive` is deliberately in no list: a site-wide „Arhiva" entry would
     * advertise past events on every page of a site that has never held one. It is reached
     * from `/events/` instead, unconditionally — which is the other half of the orphan rule
     * and is asserted against the real build below.
     */
    const navRoutes = [...PRIMARY_NAV, ...MORE_NAV].map((item) => item.route);
    expect(navRoutes).toContain(EVENTS_ROUTE);
    expect(navRoutes).not.toContain(EVENTS_ARCHIVE_ROUTE);
  });
});

/* ------------------------------------------------------------------- the rendered markup */

/**
 * Astro's container API: the real components, real props, real markup, no build.
 *
 * What it cannot see is stated rather than skipped — no asset pipeline, so no CSS, no
 * computed style and no layout. `npm run ds` reads the style blocks, the build arm below
 * reads the emitted stylesheet for the one colour rule §7.3 fixes, and `npm run a11y`
 * audits both routes in both themes.
 */
const container = await AstroContainer.create();

const SEED_FIXTURE = process.env[FIXTURE_ENV];
afterAll(() => {
  process.env[FIXTURE_ENV] = SEED_FIXTURE;
});

/** A fixture document, decoded the way the read path hands it to a component. */
function decoded(doc: FixtureDoc): StudioEvent {
  return decodeEvent({
    _id: doc._id,
    slug: (doc.slug as { current: string }).current,
    title: doc.title,
    eventType: doc.eventType,
    startsAt: doc.startsAt,
    endsAt: doc.endsAt,
    venue: doc.venue,
    description: doc.description,
    lineup: doc.lineup,
    ticketUrl: doc.ticketUrl,
    image: {
      assetId: ((doc.image as Record<string, unknown>).asset as { _ref: string })._ref,
      alt: (doc.image as Record<string, unknown>).alt,
      hotspot: (doc.image as Record<string, unknown>).hotspot,
      crop: (doc.image as Record<string, unknown>).crop,
    },
  });
}

const SOON = decoded(EVENT_RENDER_SOON);
const LATER = decoded(EVENT_RENDER_LATER);
const PAST = decoded(EVENT_RENDER_PAST);

/** Markup with its tags stripped, for assertions about what a visitor reads. */
function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8230;|&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('the index lists what is coming (AC1)', () => {
  it('shows the date, the title, the venue and the time of every upcoming event', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Events, {
        props: { locale, upcoming: [SOON, LATER] },
      });
      const read = words(html);

      for (const event of [SOON, LATER]) {
        expect(read, `${event.id} title`).toContain(event.title[locale]);
        expect(read, `${event.id} venue`).toContain(event.venue);
        expect(read, `${event.id} date`).toContain(formatInstantDate(event.startsAt, locale));
        expect(read, `${event.id} time`).toContain(formatInstantTime(event.startsAt, locale));
        expect(html, `${event.id} link`).toContain(`href="${eventUrl(event.slug, locale)}"`);
      }
    }
  });

  it('orders them as the reader meets them, soonest first', async () => {
    const html = await container.renderToString(Events, {
      props: { locale: 'hr' as Locale, upcoming: [SOON, LATER] },
    });
    expect(html.indexOf(SOON.title.hr)).toBeLessThan(html.indexOf(LATER.title.hr));
  });

  it('gives every card a machine-readable date beside the one a human reads', async () => {
    const html = await container.renderToString(Events, {
      props: { locale: 'hr' as Locale, upcoming: [SOON, LATER] },
    });
    for (const event of [SOON, LATER]) {
      expect(html).toContain(`datetime="${event.startsAt}"`);
    }
  });

  it('links the archive whether or not anything is in it', async () => {
    // Unconditional on purpose. A door that appears with the data would make
    // `/events/archive/` a page nothing links to in exactly the state the site ships in,
    // and a permanent record needs a permanent door.
    for (const upcoming of [[], [SOON]]) {
      const html = await container.renderToString(Events, {
        props: { locale: 'hr' as Locale, upcoming },
      });
      expect(html).toContain(`href="${localeUrl(EVENTS_ARCHIVE_ROUTE, 'hr')}"`);
    }
  });
});

describe('with no events at all, the page says so (AC6)', () => {
  /**
   * **The state this page ships in, so it is asserted hardest.**
   *
   * There are no `event` documents in the dataset and nobody has given us any, which is the
   * whole reason the ticket was unblocked. Four claims, and the last two are the ones that
   * would be easy to get wrong in a way that reads fine:
   */
  it('says plainly that there is nothing, as the section’s own heading', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Events, {
        props: { locale, upcoming: [] },
      });
      expect(words(html)).toContain(EVENT_COPY[locale].emptyHeading);
      expect(html, 'the sentence is a heading, not a footnote').toMatch(
        /<h2[^>]*>\s*Nema objavljenih doga|<h2[^>]*>\s*No events are published/,
      );
    }
  });

  it('renders no list and no list heading — not an empty grid', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Events, {
        props: { locale, upcoming: [] },
      });
      expect(html, 'an empty <ul> is a page that looks like it failed to load').not.toMatch(
        /<ul\b/,
      );
      expect(words(html), 'a section heading over nothing').not.toContain(
        EVENT_COPY[locale].upcoming,
      );
    }
  });

  it('offers somewhere to go instead', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Events, {
        props: { locale, upcoming: [] },
      });
      expect(html).toContain(`href="${localeUrl('/schedule', locale)}"`);
      expect(html).toContain(`href="${localeUrl('/contact', locale)}"`);
    }
  });

  it('implies no event, past or future, that nobody has announced', async () => {
    /**
     * The criterion in the ticket's own words: the empty state must not imply events exist,
     * nor hint at past ones that are not there. So the empty *block* names no past event
     * and makes no promise about a future one — „provjeri kasnije" and „coming soon" are
     * MUSE-36's mistake in a smaller font.
     *
     * Stated over the block rather than over the page, because the archive link below it is
     * a navigational affordance and is allowed to say „Arhiva".
     */
    for (const locale of LOCALES) {
      const html = await container.renderToString(Events, {
        props: { locale, upcoming: [] },
      });
      const block = /<h2[^>]*class="emptyH[^"]*"[\s\S]*?<\/p>\s*<p class="exits/.exec(html);
      expect(block, 'no empty-state block to read').not.toBeNull();
      const read = words(block![0]);

      for (const promise of [
        'uskoro',
        'provjeri',
        'najavit',
        'soon',
        'check back',
        'stay tuned',
        'announce',
        'arhiv',
        'archive',
        'past',
        'prošl',
      ]) {
        expect(read.toLowerCase(), `the empty state hints at "${promise}"`).not.toContain(
          promise,
        );
      }
    }
  });
});

describe('the archive keeps what has been (AC3)', () => {
  it('lists a past event with its date, title and venue', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(EventsArchive, {
        props: { locale, past: [PAST] },
      });
      const read = words(html);
      expect(read).toContain(PAST.title[locale]);
      expect(read).toContain(PAST.venue);
      expect(read).toContain(formatInstantDate(PAST.startsAt, locale));
      expect(html).toContain(`href="${eventUrl(PAST.slug, locale)}"`);
    }
  });

  it('says it is empty rather than rendering nothing, and explains the mechanism', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(EventsArchive, {
        props: { locale, past: [] },
      });
      expect(words(html)).toContain(EVENT_COPY[locale].archiveEmptyHeading);
      expect(words(html)).toContain(EVENT_COPY[locale].archiveEmptyBody);
      expect(html).not.toMatch(/<ul\b/);
    }
  });

  it('leads back to the index from either state', async () => {
    for (const past of [[], [PAST]]) {
      const html = await container.renderToString(EventsArchive, {
        props: { locale: 'hr' as Locale, past },
      });
      expect(html).toContain(`href="${localeUrl(EVENTS_ROUTE, 'hr')}"`);
    }
  });
});

describe('a detail page is the whole event, with no Facebook login (AC2)', () => {
  const FUTURE = new Date(Date.now() - 1000);

  it('carries the date, the time, the venue, the description and the line-up', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(EventPage, {
        props: { locale, event: LATER, now: FUTURE },
      });
      const read = words(html);

      expect(read).toContain(LATER.title[locale]);
      expect(read).toContain(LATER.venue);
      expect(read).toContain(formatInstantDate(LATER.startsAt, locale));
      expect(read).toContain(formatInstantTime(LATER.startsAt, locale));
      // Both paragraphs of a `localeText` body, so a renderer that took the first is red.
      for (const paragraph of LATER.description[locale].split('\n\n')) {
        expect(read).toContain(paragraph.trim());
      }
      for (const name of LATER.lineup) expect(read).toContain(name);
      expect(read).toContain(EVENT_COPY[locale].lineup);
    }
  });

  it('prints the end time when there is one, and nothing when there is not', async () => {
    const withEnd = await container.renderToString(EventPage, {
      props: { locale: 'hr' as Locale, event: LATER, now: FUTURE },
    });
    expect(words(withEnd)).toContain(formatInstantTime(LATER.endsAt!, 'hr'));

    const withoutEnd = await container.renderToString(EventPage, {
      props: { locale: 'hr' as Locale, event: SOON, now: FUTURE },
    });
    // `SOON` has no `endsAt`: the „when" line is the start and nothing else.
    expect(words(withoutEnd)).toContain(formatInstantTime(SOON.startsAt, 'hr'));
    expect(withoutEnd).not.toContain(' – ');
  });

  it('offers the ticket link when the dataset has one, and the studio when it does not', async () => {
    const ticketed = await container.renderToString(EventPage, {
      props: { locale: 'hr' as Locale, event: LATER, now: FUTURE },
    });
    expect(ticketed).toContain(`href="${LATER.ticketUrl}"`);
    expect(ticketed).toContain('rel="noopener noreferrer"');
    expect(words(ticketed)).toContain(EVENT_COPY.hr.tickets);

    // „Ostavi prazno i prikazuje se obrazac za kontakt" is what the Studio field promises.
    const unticketed = await container.renderToString(EventPage, {
      props: { locale: 'hr' as Locale, event: SOON, now: FUTURE },
    });
    expect(unticketed).toContain(`href="${localeUrl('/contact', 'hr')}"`);
    expect(words(unticketed)).toContain(EVENT_COPY.hr.ask);
  });

  it('shows no line-up block for an event with no announced guests', async () => {
    const html = await container.renderToString(EventPage, {
      props: { locale: 'hr' as Locale, event: SOON, now: FUTURE },
    });
    expect(SOON.lineup).toEqual([]);
    expect(words(html)).not.toContain(EVENT_COPY.hr.lineup);
  });

  it('says a past event has passed, and stops offering a ticket for it', async () => {
    /**
     * The half of the staleness decision that lands on the page. An event can sit on the
     * upcoming list for up to `MAX_WAIT_HOURS` after it finished, and a shared link reaches
     * this page a year later — so a page that reads as an invitation is the failure.
     *
     * `PAST` carries a `ticketUrl` deliberately: booking a party that has happened is the
     * one thing this page must not offer, and a fixture without one would make that pass
     * for the wrong reason.
     */
    const now = new Date();
    expect(hasPassed(PAST, now)).toBe(true);

    for (const locale of LOCALES) {
      const html = await container.renderToString(EventPage, {
        props: { locale, event: PAST, now },
      });
      expect(words(html)).toContain(EVENT_COPY[locale].passed);
      expect(html, 'a past event still offers its ticket link').not.toContain(PAST.ticketUrl!);
      expect(html).toContain(`href="${localeUrl(EVENTS_ARCHIVE_ROUTE, locale)}"`);
      // And it is still the whole event — an archive that hid the detail would be the
      // deletion this page exists instead of.
      expect(words(html)).toContain(PAST.venue);
      expect(words(html)).toContain(formatInstantDate(PAST.startsAt, locale));
    }
  });

  it('says nothing of the kind about an event that is still to come', async () => {
    // The false-positive half: a notice that rendered always would be on every page.
    for (const locale of LOCALES) {
      const html = await container.renderToString(EventPage, {
        props: { locale, event: LATER, now: FUTURE },
      });
      expect(words(html)).not.toContain(EVENT_COPY[locale].passed);
    }
  });

  it('gives the chip its plum-ink ground through a band role, in both themes (AC5)', () => {
    /**
     * §7.3: a date chip sits on the photograph rather than on the page, so it keeps its
     * plum-ink ground in both themes. The container runs no asset pipeline, so the paint is
     * checked against the *emitted stylesheet* in the build arm below; what is asserted
     * here is the thing a source scan can settle and `npm run ds` cannot — that the chip
     * reaches for a `--band-*` role rather than for `--surface-deep`, which is right in
     * dark and a cream chip on a photograph in light.
     */
    for (const file of ['src/components/EventCard.astro', 'src/components/EventPage.astro']) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      const chip = /\.chip\s*\{[\s\S]*?\}/.exec(source);
      expect(chip, `${file} has no .chip rule`).not.toBeNull();
      expect(chip![0], `${file} chip background`).toContain('var(--band-surface)');
      expect(chip![0], `${file} chip does not follow the page theme`).not.toContain(
        'var(--surface',
      );
    }
  });
});

describe('every string on a card comes from the dataset (MUSE-50)', () => {
  /**
   * The assertion a hardcoded literal fails while every equality test passes.
   *
   * Comparing a rendering to the fixture it just read says nothing: a venue written into
   * `EventCard.astro` matches the fixture's venue and both agree. So the same components are
   * rendered against a **second** dataset that shares no string with the first, and the
   * first set's words have to be absent from the second rendering.
   */
  it('renders a rewritten event and leaves no trace of the original', async () => {
    const rewritten = EVENTS_REWRITTEN.map(decoded);
    const original = [SOON, LATER, PAST];

    for (const locale of LOCALES) {
      const html = await container.renderToString(Events, {
        props: { locale, upcoming: rewritten.filter((event) => !hasPassed(event, new Date())) },
      });
      const read = words(html);

      for (const event of rewritten.filter((e) => !hasPassed(e, new Date()))) {
        expect(read, `${event.id} was not rendered`).toContain(event.title[locale]);
        expect(read, `${event.id}'s venue was not rendered`).toContain(event.venue);
      }
      for (const event of original) {
        expect(read, `${event.id}'s title survived the rewrite`).not.toContain(
          event.title[locale],
        );
        expect(read, `${event.id}'s venue survived the rewrite`).not.toContain(event.venue);
      }
    }
  });

  it('puts no event of its own in the chrome', () => {
    // `EVENT_COPY` is interface chrome in code, which is allowed — and the line between
    // chrome and content is that chrome names no event, no venue, no date and no guest.
    // A „Noć bachate" example sentence in the lede would pass every test above.
    const copy = Object.values(EVENT_COPY).flatMap((locale) => Object.values(locale));
    expect(copy.length).toBeGreaterThan(10);
    for (const line of copy) {
      expect(line, line).not.toMatch(/\b(?:19|20)\d\d\b/);
      expect(line, line).not.toMatch(/\d{1,2}[:.]\d\d/);
      expect(line, line).not.toMatch(/Ilica/i);
    }
  });
});

/* ----------------------------------------------------------------------- the one build */

/**
 * **One `astro build`, spent on the three things the container cannot see.**
 *
 * Declared in `test/helpers/concurrency.ts`. It is a build against a dataset holding two
 * upcoming events and one past one, which is the only way to reach:
 *
 *   - `getStaticPaths` — whether a detail page exists at all;
 *   - the **URL**, resolved through the model of GitHub Pages, which is where „its URL
 *     keeps working" is a 200 rather than a file that happens to be on disk;
 *   - the emitted **stylesheet**, for §7.3's chip ground and MUSE-14's figures.
 *
 * It also carries MUSE-50's build-level half for free: this build's dataset replaces the
 * committed seed's `page` documents, so the two seeded `<title>`s and descriptions must
 * appear in **no byte** of its output — which is the one assertion a literal in
 * `Events.astro` fails while every equality test above passes.
 */
let built: Build;
let host: Host;

beforeAll(async () => {
  built = buildSite(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf(EVENTS_RENDERED as FixtureDoc[], 'events'),
  });
  host = await servePages(built);
}, 240_000);

afterAll(async () => {
  await host?.close();
});

/**
 * The two spellings of a detail page's address, built from **this build's** deploy target.
 *
 * `eventUrl` cannot be used here, and the reason is worth knowing: `localeUrl` reads
 * `import.meta.env.BASE_URL`, which inside the vitest process is `/` rather than the
 * build's `/MuseByMina`. So every assertion against `dist` derives its paths from
 * `basePath(built)` and `built.origin` instead — the same discipline `test/urls.test.ts`
 * keeps, and the reason it spells the URL shape out rather than importing it.
 */
function detailTail(slug: string, locale: Locale): string {
  return `${locale === 'hr' ? '' : 'en/'}events/${slug}/`;
}

/** Site-relative, as the host receives it. */
function detailPath(slug: string, locale: Locale): string {
  return `${basePath(built)}${detailTail(slug, locale)}`;
}

/** Absolute, as a canonical or a sitemap entry spells it. */
function detailUrl(slug: string, locale: Locale): string {
  return `${built.origin}/${detailTail(slug, locale)}`;
}

describe('a past-dated event lands in the archive, and its URL still resolves (AC3)', () => {
  it('builds a page per event, in both locales', () => {
    const emitted = built.htmlFiles();
    for (const event of [SOON, LATER, PAST]) {
      expect(emitted, `hr ${event.slug}`).toContain(`events/${event.slug}/index.html`);
      expect(emitted, `en ${event.slug}`).toContain(`en/events/${event.slug}/index.html`);
    }
  });

  it('answers every detail URL with a 200 and no redirect, in both locales', async () => {
    for (const event of [SOON, LATER, PAST]) {
      for (const locale of LOCALES) {
        const probe = await host.get(detailPath(event.slug, locale));
        expect([probe.status, probe.location], `${locale} ${event.slug}`).toEqual([
          200,
          undefined,
        ]);
      }
    }
  });

  it('shows the upcoming two on the index and the past one on the archive', () => {
    const index = built.read('events/index.html');
    const archive = built.read('events/archive/index.html');

    expect(index).toContain(SOON.title.hr);
    expect(index).toContain(LATER.title.hr);
    expect(index, 'a finished event is still being advertised').not.toContain(PAST.title.hr);

    expect(archive).toContain(PAST.title.hr);
    expect(archive, 'an upcoming event is in the archive').not.toContain(SOON.title.hr);
    expect(archive).not.toContain(LATER.title.hr);
  });

  it('keeps the past event reachable from the archive it is listed on', () => {
    expect(built.read('events/archive/index.html')).toContain(
      `href="${detailPath(PAST.slug, 'hr')}"`,
    );
  });

  it('declares a canonical on every detail page that is that page’s own URL', () => {
    // `test/urls.test.ts` makes this claim over the committed seed, which has no events —
    // so for a dynamic route it is made here. A canonical naming anything else is MUSE-9.
    for (const event of [SOON, LATER, PAST]) {
      for (const locale of LOCALES) {
        const file = `${locale === 'hr' ? '' : 'en/'}events/${event.slug}/index.html`;
        const canonical = canonicalOf(built.read(file));
        expect(canonical, file).toBe(detailUrl(event.slug, locale));
      }
    }
  });

  it('pairs each detail page with its twin in the other locale (§10, MUSE-16)', async () => {
    // The locale switcher is a prefix swap on the current route, so the twin has to exist —
    // which means both `[slug].astro` templates generate the same slug set. Asserted
    // through the host rather than through the file list, because a 301 is not a page.
    for (const event of [SOON, LATER, PAST]) {
      const hr = built.read(`events/${event.slug}/index.html`);
      expect(hr, `${event.slug} hreflang`).toContain(
        `hreflang="en" href="${detailUrl(event.slug, 'en')}"`,
      );
      expect(hr, `${event.slug} switcher`).toContain(`href="${detailPath(event.slug, 'en')}"`);
      const probe = await host.get(detailPath(event.slug, 'en'));
      expect([probe.status, probe.location]).toEqual([200, undefined]);
    }
  });

  it('puts every detail page in the sitemap', () => {
    /**
     * `llms.txt` lists the routes in `ROUTES` and deliberately not one line per event: it is
     * a short index of the site's sections, and it says so by linking the sitemap under
     * „Machine-readable". The sitemap is the surface designed for an unbounded page set, so
     * that is where an event has to be — a detail page in neither would be invisible to a
     * crawler, which is half of what the archive is for.
     */
    const sitemaps = built
      .allFiles()
      .filter((file) => /^sitemap-\d+\.xml$/.test(file))
      .map((file) => built.read(file))
      .join('\n');

    expect(sitemaps.length).toBeGreaterThan(0);
    for (const event of [SOON, LATER, PAST]) {
      for (const locale of LOCALES) {
        expect(sitemaps, `${locale} ${event.slug}`).toContain(detailUrl(event.slug, locale));
      }
    }
    expect(built.read('llms.txt'), 'llms.txt grew a line per event').not.toContain(
      detailUrl(PAST.slug, 'hr'),
    );
  });

  it('paints the date chip on plum-ink in both themes, in the emitted CSS (AC5)', () => {
    /**
     * §7.3, measured against what the build actually emitted rather than against the
     * source. The chip's ground must be the band role — which `src/styles/tokens.css`
     * declares **once on `:root` with no theme variants** — so „in both themes" follows
     * from the token rather than from two rules a theme block could get wrong.
     */
    const css = built
      .allFiles()
      .filter((file) => file.endsWith('.css'))
      .map((file) => built.read(file))
      .join('\n');
    const inline = [
      ...built.read('events/index.html').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g),
    ]
      .map((match) => match[1]!)
      .join('\n');
    const all = `${css}\n${inline}`;

    expect(all).toMatch(/\.chip\[[^\]]*\]\{[^}]*background:var\(--band-surface\)/);
    expect(all, 'the chip follows the page theme somewhere').not.toMatch(
      /\.chip\[[^\]]*\]\{[^}]*background:var\(--surface/,
    );
  });

  it('sets no `font-variant-numeric` anywhere in its own output (MUSE-14)', () => {
    // `npm run ds` forbids the property in a component and `test/numerals.test.ts` measures
    // the glyphs; this is the third reading, against the bytes a visitor receives, and it is
    // here because the date chip is the first numeral this site sets in the display face
    // outside the schedule.
    const sheets = built
      .allFiles()
      .filter((file) => file.endsWith('.css'))
      .map((file) => ({ file, css: built.read(file) }));

    expect(sheets.length).toBeGreaterThan(0);
    for (const { file, css } of sheets) {
      const declarations = [...css.matchAll(/font-variant-numeric\s*:[^;}]*/g)].map(
        (m) => m[0],
      );
      // `:root` and the form-control rule in `src/styles/base.css` are the two the document
      // is allowed to carry; a third would be a component replacing them.
      expect(declarations.length, `${file}: ${declarations.join(' | ')}`).toBeLessThanOrEqual(
        2,
      );
    }
  });

  it('leaves the seeded page titles in no byte of this output (MUSE-50)', () => {
    /**
     * The build read a dataset whose `page` documents are the fixture's, so the committed
     * seed's `/events` and `/events/archive` titles and descriptions must appear nowhere.
     * That is the one assertion a literal in `Events.astro` fails: every equality test above
     * passes while the hardcoded string still happens to match what the seed says.
     */
    const seeded = seedDocs()
      .filter((doc) => doc._id === 'page-events' || doc._id === 'page-events-archive')
      .flatMap((doc) =>
        ['title', 'description'].flatMap((field) =>
          Object.values(doc[field] as Record<string, unknown>).filter(
            (value): value is string => typeof value === 'string' && value.length > 12,
          ),
        ),
      );

    expect(seeded.length, 'no seeded strings to look for').toBe(8);

    const offenders: string[] = [];
    for (const file of built.allFiles()) {
      const bytes = readFileSync(`${built.outDir}/${file}`);
      for (const needle of seeded) {
        if (bytes.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads its own `<title>` from the event rather than from a `page` document', () => {
    // The flip side: the detail page has no `page` document by design, so its `<title>` is
    // derived — and it has to name *this* event rather than the index's title.
    const html = built.read(`events/${PAST.slug}/index.html`);
    expect(html).toContain(`<title>${eventMetaTitle(PAST.title.hr, 'Studio Fixture')}</title>`);
    expect(html).toContain(
      `content="${eventMetaDescription(PAST.description.hr).replace(/&/g, '&amp;')}"`,
    );
  });

  it('builds the nine routed pages plus a detail page per event, and nothing else', () => {
    // The census. „No detail pages are missing" is true of a build that emitted none, and
    // this file's subject is a page set derived from content rather than from a list.
    const pages = built.htmlFiles().filter((file) => file.endsWith('/index.html'));
    const details = pages.filter((file) => /(?:^|\/)events\/[^/]+\/index\.html$/.test(file));
    expect(details.length).toBe(2 * 3 + 2 /* the two archive pages share the prefix */);
  });
});

/* ------------------------------------------------------------------ the card, as a unit */

describe('one card is one component, used by both lists', () => {
  it('renders the same card markup from the index and from the archive', async () => {
    // The two lists are the same object rendered twice; a second copy of the markup is
    // where the archive quietly stops showing a venue.
    const card = await container.renderToString(EventCard, {
      props: { locale: 'hr' as Locale, event: PAST, heading: 'h2' },
    });
    const archive = await container.renderToString(EventsArchive, {
      props: { locale: 'hr' as Locale, past: [PAST] },
    });
    expect(words(archive)).toContain(words(card));
  });

  it('takes its heading level from the page, so neither list skips one', async () => {
    const underSection = await container.renderToString(EventCard, {
      props: { locale: 'hr' as Locale, event: SOON, heading: 'h3' },
    });
    const underH1 = await container.renderToString(EventCard, {
      props: { locale: 'hr' as Locale, event: SOON, heading: 'h2' },
    });
    expect(underSection).toMatch(/<h3[^>]*class="name/);
    expect(underH1).toMatch(/<h2[^>]*class="name/);
  });

  it('hides the chip from the accessibility tree, because the date is already there', async () => {
    // The chip and the `<time>` are two renderings of one date. Announcing „13 kol" and
    // then „13. kolovoza 2026. · 21:00" is the same fact twice in two shapes.
    const html = await container.renderToString(EventCard, {
      props: { locale: 'hr' as Locale, event: SOON, heading: 'h3' },
    });
    expect(html).toMatch(/<p class="chip[^"]*"[^>]*aria-hidden="true"/);
    expect(html).toContain(`datetime="${SOON.startsAt}"`);
  });

  it('reserves the box the photograph will take, at the ratio the Studio promises', async () => {
    // §9 rule 2: `object-fit: cover` with an explicit `aspect-ratio`, and intrinsic
    // `width`/`height` so the card does not reflow when the image lands. The ratio is 16:9
    // because that is what the `event.image` field description tells Mina it will be cropped
    // to — a card at another ratio would crop her hotspot out of frame.
    const html = await container.renderToString(EventCard, {
      props: { locale: 'hr' as Locale, event: SOON, heading: 'h3' },
    });
    const img = /<img\b[^>]*>/.exec(html);
    expect(img).not.toBeNull();
    expect(img![0]).toMatch(/\bwidth="\d+"/);
    expect(img![0]).toMatch(/\bheight="\d+"/);
    expect(img![0]).toContain('loading="lazy"');
    expect(img![0]).toContain(`alt="${SOON.image.alt.hr}"`);
    expect(img![0]).toMatch(/object-position:\s*[\d.]+% [\d.]+%/);
  });
});

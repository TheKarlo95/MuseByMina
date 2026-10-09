import type { Locale } from './i18n';

/**
 * Dates, written the way each locale writes them (design system §10).
 *
 *   HR   `13. kolovoza 2026.`     day, genitive month, year, final full stop
 *   EN   `13 August 2026`
 *
 * Those are not translations of one format; they are two different forms, which is why a
 * date is stored as an ISO string in Sanity and rendered here. A CMS field holding the
 * *formatted* date would be a field that is right in one language and wrong in the other
 * (`sanity/schemaTypes/enums.ts` lists the other rules that stay in code for this reason —
 * `formatTime`, the currency, the level names).
 */

/**
 * **The BCP 47 tag used for formatting, which is not the tag used for `lang`.**
 *
 * `LOCALE_HTML_LANG` in `./i18n.ts` maps `en` to `en`, which is correct for `<html lang>` —
 * the page is in English, not in British English. For *formatting* it is wrong: plain `en`
 * resolves to the US order and produces `August 13, 2026`, which is not what §10 asks for.
 * `en-GB` is the day-first form the design system specifies.
 *
 * So the two maps are deliberately different and must stay separate. Collapsing them would
 * silently change every English date on the site, and the tests that would catch it are
 * reading the rendered string rather than this constant.
 */
const FORMATTING_LOCALE: Record<Locale, string> = { hr: 'hr-HR', en: 'en-GB' };

/**
 * `Intl` does the work, and it gets both forms exactly right — verified against §10 on
 * Node 22, which ships the full ICU data set. Spelling out a Croatian month table by hand
 * was the alternative; it would be a second copy of data the platform already has, and the
 * genitive case (`kolovoza`, not `kolovoz`) is precisely the part a hand-written table gets
 * wrong.
 *
 * `timeZone: 'UTC'` is load-bearing. `foundedOn` is a calendar date with no time in it, and
 * parsing `2026-08-13` yields midnight UTC — so a build running on a machine west of
 * Greenwich would format it as the 12th. The build then publishes static HTML, so that is
 * a wrong date frozen into the page, not a transient display bug.
 */
const FORMATTERS: Record<Locale, Intl.DateTimeFormat> = {
  hr: new Intl.DateTimeFormat(FORMATTING_LOCALE.hr, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }),
  en: new Intl.DateTimeFormat(FORMATTING_LOCALE.en, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }),
};

/**
 * **The studio's own clock, and why a calendar date and an instant need different ones.**
 *
 * `formatDate` below renders a *calendar date* — `studioStory.foundedOn`, a `YYYY-MM-DD`
 * with no time in it — and formats it in UTC, because parsing `2026-08-13` yields midnight
 * UTC and a build west of Greenwich would otherwise publish the 12th.
 *
 * `event.startsAt` is not that. It is an **instant**, a `datetime` in the Studio, and what
 * a reader needs from it is the wall-clock time in the room: an event that starts at nine
 * in the evening in Ilica is `19:00Z` in August and `20:00Z` in December. Rendering it in
 * UTC would publish the UTC hour, and
 * rendering it in the build machine's zone would make the published page depend on where
 * the build ran — the runner is UTC, a developer's box is not, and MUSE-20's byte-identical
 * criterion would fail for a reason nobody would look for. So the zone is named here, once,
 * and it is the studio's.
 *
 * `post.publishedAt` is the second one (MUSE-26), and it is the same rule arriving at a
 * *date* rather than a time: a post published at half past midnight on the 14th in Ilica
 * is `22:30Z` on the **13th**, so formatting it in UTC prints the wrong day — and slicing
 * the first ten characters off the string, which is the tempting shortcut, is the same bug
 * spelled shorter.
 *
 * `Europe/Zagreb` rather than a fixed offset, because Croatia observes daylight saving and
 * a fixed `+02:00` would be an hour wrong for half the year — the same class of mistake
 * `src/lib/rebuild.ts` refuses to make when it promises Mina a duration instead of a clock
 * time.
 */
export const STUDIO_TIME_ZONE = 'Europe/Zagreb';

/** An ISO calendar date — `YYYY-MM-DD` — and nothing looser. */
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * One ISO calendar date, formatted for `locale`.
 *
 * Throws on anything that is not `YYYY-MM-DD`. `new Date('nonsense')` is an Invalid Date
 * and `Intl` renders it as the literal string "Invalid Date" — in the page, at the size of
 * a heading — so the loose path here is a build that succeeds and publishes that.
 */
export function formatDate(iso: string, locale: Locale): string {
  const match = ISO_DATE.exec(iso);
  if (!match) {
    throw new Error(
      `formatDate expected an ISO calendar date like "2026-08-13", got ${JSON.stringify(iso)}. ` +
        `Intl renders an unparseable date as the words "Invalid Date" rather than failing, ` +
        `so this stops here instead of publishing them.`,
    );
  }

  const date = new Date(`${iso}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `formatDate was given ${JSON.stringify(iso)}, which is shaped like a date and is not ` +
        `one — check the day and month numbers.`,
    );
  }

  return FORMATTERS[locale].format(date);
}

/* ------------------------------------------------------------------ instants */

/**
 * An ISO instant as Sanity stores a `datetime`, and as `Date#toISOString` writes one.
 *
 * Deliberately loose about the seconds and the fractional part — Sanity writes
 * `2026-08-13T19:00:00.000Z` and `2026-08-13T19:00:00Z` depending on how the value got
 * there — and deliberately strict about the `Z`. A datetime with a local offset
 * (`…+02:00`) would still parse, but `getEvents` compares `startsAt` against `$now` as a
 * **string** in GROQ, and two spellings of one instant do not compare equal. The decoder
 * refuses the offset form so that „upcoming" cannot be decided lexicographically on a
 * value whose zone is written down rather than normalised.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z$/;

/** Is this an ISO instant in the one spelling the site compares and formats? */
export function isIsoInstant(value: string): boolean {
  return ISO_INSTANT.test(value) && !Number.isNaN(new Date(value).getTime());
}

function instant(iso: string, what: string): Date {
  if (!isIsoInstant(iso)) {
    throw new Error(
      `${what} expected a UTC ISO instant like "2026-08-13T19:00:00.000Z", got ` +
        `${JSON.stringify(iso)}. Intl renders an unparseable date as the words ` +
        `"Invalid Date" rather than failing, so this stops here instead of publishing ` +
        `them at the size of a heading.`,
    );
  }
  return new Date(iso);
}

/**
 * The formatters, built once.
 *
 * Four shapes per locale, and the pair that differs between them is the whole of §10:
 * **Croatian is 24-hour, English is 12-hour.** That is the design system's base rule for
 * prose, and an event card is prose — one date, read on its own. Note that
 * `formatTime` in `src/lib/schedule.ts` goes the *other* way and is 24-hour in both
 * locales; that is a documented exception for the timetable grid, where the times are a
 * column of numbers that has to align. Two rules, two surfaces, and neither is a
 * relaxation of the other.
 *
 * `hourCycle: 'h23'` on the Croatian clock rather than `hour12: false` alone: the latter
 * can resolve to `h24`, which spells midnight `24:00`.
 */
const INSTANT_DATE: Record<Locale, Intl.DateTimeFormat> = {
  hr: new Intl.DateTimeFormat(FORMATTING_LOCALE.hr, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: STUDIO_TIME_ZONE,
  }),
  en: new Intl.DateTimeFormat(FORMATTING_LOCALE.en, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: STUDIO_TIME_ZONE,
  }),
};

const INSTANT_TIME: Record<Locale, Intl.DateTimeFormat> = {
  hr: new Intl.DateTimeFormat(FORMATTING_LOCALE.hr, {
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: STUDIO_TIME_ZONE,
  }),
  en: new Intl.DateTimeFormat(FORMATTING_LOCALE.en, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: STUDIO_TIME_ZONE,
  }),
};

const INSTANT_WEEKDAY: Record<Locale, Intl.DateTimeFormat> = {
  hr: new Intl.DateTimeFormat(FORMATTING_LOCALE.hr, { weekday: 'long', timeZone: STUDIO_TIME_ZONE }),
  en: new Intl.DateTimeFormat(FORMATTING_LOCALE.en, { weekday: 'long', timeZone: STUDIO_TIME_ZONE }),
};

const INSTANT_CHIP: Record<Locale, Intl.DateTimeFormat> = {
  hr: new Intl.DateTimeFormat(FORMATTING_LOCALE.hr, {
    day: 'numeric',
    month: 'short',
    timeZone: STUDIO_TIME_ZONE,
  }),
  en: new Intl.DateTimeFormat(FORMATTING_LOCALE.en, {
    day: 'numeric',
    month: 'short',
    timeZone: STUDIO_TIME_ZONE,
  }),
};

/** One instant's date: `13. kolovoza 2026.` / `13 August 2026` (§10). */
export function formatInstantDate(iso: string, locale: Locale): string {
  return INSTANT_DATE[locale].format(instant(iso, 'formatInstantDate'));
}

/** One instant's time, in the studio's zone: `20:00` / `8:00 pm` (§10). */
export function formatInstantTime(iso: string, locale: Locale): string {
  return INSTANT_TIME[locale].format(instant(iso, 'formatInstantTime'));
}

/** One instant's weekday: `četvrtak` / `Thursday`. */
export function formatInstantWeekday(iso: string, locale: Locale): string {
  return INSTANT_WEEKDAY[locale].format(instant(iso, 'formatInstantWeekday'));
}

/**
 * The two lines of a date chip (§7.3): the day number and the abbreviated month.
 *
 * Returned as parts rather than as a string, because the chip sets them at two different
 * sizes in two different faces — the number in the display face, the month in the label
 * face — and a component that had to split a formatted string would be re-deriving the
 * locale's own punctuation. Croatian's `day: 'numeric'` renders `13.` with its ordinal
 * full stop, which is right in a sentence and wrong stacked above a month, so the day is
 * taken from `formatToParts` rather than from the formatted string.
 */
export function instantChip(iso: string, locale: Locale): { day: string; month: string } {
  const parts = INSTANT_CHIP[locale].formatToParts(instant(iso, 'instantChip'));
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';

  return { day: part('day'), month: part('month') };
}

/** Do two instants fall on the same calendar day in the studio's zone? */
export function sameStudioDay(a: string, b: string): boolean {
  return formatInstantDate(a, 'en') === formatInstantDate(b, 'en');
}

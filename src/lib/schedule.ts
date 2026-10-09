import type { Locale } from './i18n';

/**
 * The weekly schedule's domain model.
 *
 * This file is the part that survived the move to Sanity: types, the closed sets of days
 * and levels, the locale wording for each, and the grouping the two layouts share. The
 * rows themselves are CMS content as of MUSE-36 — `src/lib/sanity/` reads them and
 * `src/data/schedule.ts`, which held thirteen invented classes, is gone.
 *
 * A row stores a weekday key, a 24-hour `HH:MM` string, a level and the names of the
 * people teaching it; the view resolves the keys to words through the maps below. That is
 * what makes `/schedule` and `/en/schedule` two renderings of one dataset rather than two
 * datasets. The class's own name is the one genuinely bilingual *datum* on a row, because
 * it is something the studio typed rather than a key this module can look up.
 */

/** Monday-first, which is how a Croatian week is written and read. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/**
 * The fixed set of levels, in the order a dancer passes through them.
 *
 * **Four since MUSE-36**, when the real timetable arrived: the studio teaches an
 * *Improver* class between the beginner and the intermediate one. The order is
 * load-bearing — it is the grid's row order, the order the homepage doors are picked in,
 * and the order of the Studio's dropdown (`sanity/schemaTypes/enums.ts`) — so a level is
 * inserted in sequence rather than appended.
 */
export const LEVELS = ['beginner', 'improver', 'intermediate', 'advanced'] as const;
export type Level = (typeof LEVELS)[number];

/**
 * There is no `STYLES`, and that is a decision rather than an omission (MUSE-36).
 *
 * The three style names were invented in the foundation commit alongside the thirteen
 * invented classes, and they shaped three style cards, a filter dimension, a homepage
 * section and a required `class.style` field in the Studio. The studio teaches bachata and
 * splits its classes by level only; there was never a style dimension to model. If one
 * ever appears it is a schema change and a product decision, not a constant restored from
 * git history.
 *
 * The values themselves are deliberately **not** written out here. They live in exactly
 * one place — `WITHDRAWN_OPTION_SETS` in `sanity/schemaTypes/enums.ts` — which is the list
 * `test/sanity.test.ts` reads to keep any fixed list in the schema from offering them
 * again, under any field name. A second copy in this comment would be a second copy of a
 * fact, and MUSE-76 is what happens when the thing that matters is written down in prose
 * and asserted nowhere.
 */

export interface ClassEntry {
  day: Weekday;
  /** Start time, 24-hour `HH:MM`. Stored unformatted; the view decides display. */
  start: string;
  /** Minutes. Every class is 90 today; a workshop will not be. */
  durationMin: number;
  level: Level;
  /** The class's own name, as the studio typed it. Bilingual, so it is a Record. */
  name: Record<Locale, string>;
  /**
   * Everyone who teaches this class, in the order the studio listed them.
   *
   * An array, not a name (MUSE-36). Mina and Antonio teach every group class together,
   * which a single field could only have published half of — and lady styling is a known
   * coming class that Mina teaches alone, so one-instructor-per-class is already known to
   * be the wrong shape. Display names rather than ids: a CMS hands over what was typed.
   */
  instructors: string[];
}

export const WEEKDAY_NAME: Record<Locale, Record<Weekday, string>> = {
  hr: {
    mon: 'Ponedjeljak',
    tue: 'Utorak',
    wed: 'Srijeda',
    thu: 'Četvrtak',
    fri: 'Petak',
    sat: 'Subota',
    sun: 'Nedjelja',
  },
  en: {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
  },
};

/**
 * Level names are **English in both locales** — a deliberate exception to the
 * everything-is-bilingual rule, decided for MUSE-6.
 *
 * Design system §7.2 shows these badges as Croatian. They are English here because
 * the level is closer to a proper noun of the bachata scene than to prose: an
 * international social dancer reads "Intermediate" wherever they are, and the
 * studio's own classes are advertised that way. Keeping one spelling per level
 * also means the HR and EN pages render the same badge from the same enum.
 *
 * It is still a Record<Locale, …> so reversing this is a data edit, not a refactor.
 */
export const LEVEL_NAME: Record<Locale, Record<Level, string>> = {
  hr: {
    beginner: 'Beginner',
    improver: 'Improver',
    intermediate: 'Intermediate',
    advanced: 'Advanced',
  },
  en: {
    beginner: 'Beginner',
    improver: 'Improver',
    intermediate: 'Intermediate',
    advanced: 'Advanced',
  },
};

/**
 * What each level assumes, measured in **time danced**.
 *
 * The rule this encodes (MUSE-6): a prerequisite is useless to the person who
 * needs it most if it is written in the vocabulary of the class they have not
 * taken. "Confident cross-body lead" tells a beginner nothing; "about a year of
 * dancing" tells them everything. No step names, no figure names, no course
 * numbering — ever, in either language.
 *
 * ---
 *
 * **`improver` is the one line here nobody has confirmed (MUSE-36).**
 *
 * The other three were written with Mina. „Improver" is a word of the scene, and the
 * honest answer to *who is an Improver?* is "somebody who has finished a beginner course
 * and is a few months in" — which is what the wording says, measured in months because
 * the rule above allows nothing else. It deliberately claims no more than that: no
 * course-completion requirement, no figure vocabulary, no number of terms. Flagged for
 * Karlo to confirm with Mina; if she words it differently, this is a one-line edit and
 * both pages move with it.
 */
export const LEVEL_PREREQUISITE: Record<Locale, Record<Level, string>> = {
  hr: {
    beginner: 'Bez iskustva — nikad nisi plesao ni plesala.',
    improver: 'Plešeš nekoliko mjeseci.',
    intermediate: 'Plešeš oko godinu dana.',
    advanced: 'Plešeš dvije ili više godina.',
  },
  en: {
    beginner: 'No experience — you have never danced.',
    improver: 'A few months of dancing.',
    intermediate: 'About a year of dancing.',
    advanced: 'Two or more years of dancing.',
  },
};

/**
 * A list of names as a sentence: „Mina i Antonio", "Mina and Antonio".
 *
 * Here rather than in the component because both layouts render it and the conjunction is
 * per locale — a comma-joined list reads as a label in either language, and „and" on the
 * Croatian page is the sort of leak nobody greps for. Two names is the case that exists
 * today; three or more take a comma before the conjunction in Croatian *and* in English
 * („Mina, Antonio i Ana" / "Mina, Antonio and Ana"), which is why this is a function and
 * not a `join`.
 *
 * No serial comma: design system §10 does not ask for one, and Croatian forbids it.
 */
export function formatNames(names: readonly string[], locale: Locale): string {
  const and = locale === 'hr' ? 'i' : 'and';
  if (names.length === 0) return '';
  if (names.length === 1) return names[0]!;
  return `${names.slice(0, -1).join(', ')} ${and} ${names[names.length - 1]!}`;
}

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * A start time as the page shows it: 24-hour `HH:MM`, in **both** locales.
 *
 * Design system §10 asks for 12-hour English times in prose, and that holds for
 * prose. A schedule is read as a column of numbers, and mixing `7:30 PM` into a
 * grid whose rows must align destroys the one thing the grid is for — so MUSE-6
 * fixes both locales at 24-hour. Deliberate exception, not an oversight.
 *
 * Throws rather than coercing. A time that is not 24-hour is a content error, and
 * failing the build beats publishing `25:00` or `7:30 PM` to the most-visited
 * page on the site — which matters more once this data comes from a CMS.
 */
export function formatTime(start: string): string {
  if (!HH_MM.test(start)) {
    throw new Error(`Schedule times must be 24-hour HH:MM; got "${start}".`);
  }
  return start;
}

/**
 * The per-day session count, e.g. `3 termina`.
 *
 * Croatian pluralisation, ported from `MuseByMina2/src/data.tsx`: the singular
 * form returns for n ending in 1, except the teens (11, 111…). Everything else
 * takes the genitive plural — so `1 termin`, `2 termina`, `11 termina`,
 * `21 termin`. Also used by the component's client script, which recomputes the
 * count when a filter is applied; keeping the rule in one place is why it is a
 * function and not a template string.
 */
export function classCount(n: number, locale: Locale): string {
  if (locale === 'hr') {
    const one = n % 10 === 1 && n % 100 !== 11;
    return `${n} ${one ? 'termin' : 'termina'}`;
  }
  return `${n} ${n === 1 ? 'class' : 'classes'}`;
}

/**
 * A class's length as a phrase: „90 minuta", "90 minutes".
 *
 * Croatian takes the nominative plural for n ending in 2–4 (except the teens) and the
 * genitive plural everywhere else — `2 minute`, `5 minuta`, `90 minuta`, `22 minute`,
 * `12 minuta`. Every duration the studio has ever used takes `minuta`, which is exactly
 * why this is a function: the lede derives the number from the data (MUSE-36, so that
 * „60 minuta" cannot outlive the 60-minute class), and a 45-minute class would otherwise
 * publish a grammatical error on the most-visited page on the site.
 */
export function minutesPhrase(n: number, locale: Locale): string {
  if (locale === 'hr') {
    const twoToFour = n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14);
    return `${n} ${twoToFour ? 'minute' : 'minuta'}`;
  }
  return `${n} ${n === 1 ? 'minute' : 'minutes'}`;
}

/** The one length every class shares, or `undefined` when they differ. */
export function uniformDuration(entries: readonly ClassEntry[]): number | undefined {
  const lengths = new Set(entries.map((entry) => entry.durationMin));
  return lengths.size === 1 ? [...lengths][0] : undefined;
}

export interface ScheduleDay {
  day: Weekday;
  entries: ClassEntry[];
}

/** Entries grouped by day, in week order, earliest class first, empty days dropped. */
export function groupByDay(entries: ClassEntry[]): ScheduleDay[] {
  return WEEKDAYS.map((day) => ({
    day,
    entries: entries
      .filter((entry) => entry.day === day)
      .sort((a, b) => a.start.localeCompare(b.start)),
  })).filter((group) => group.entries.length > 0);
}

/** The days the desktop grid needs a column for, in week order. */
export function daysWithClasses(entries: ClassEntry[]): Weekday[] {
  return groupByDay(entries).map((group) => group.day);
}

/**
 * The distinct start times the grid needs a row for, earliest first.
 *
 * Derived from the data rather than fixed, so a Saturday morning workshop adds a
 * row instead of being dropped — and an hour nobody teaches never becomes an
 * empty band across the grid.
 */
export function timeRows(entries: ClassEntry[]): string[] {
  return [...new Set(entries.map((entry) => entry.start))].sort((a, b) => a.localeCompare(b));
}

/** The entries at one cell of the grid. Normally one; two is a legitimate clash. */
export function entriesAt(entries: ClassEntry[], day: Weekday, start: string): ClassEntry[] {
  return entries.filter((entry) => entry.day === day && entry.start === start);
}

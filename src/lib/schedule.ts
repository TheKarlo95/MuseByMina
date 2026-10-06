import type { Locale } from './i18n';

/**
 * The weekly schedule's domain model.
 *
 * This file is the part that survives the move to Sanity: types, the closed sets
 * of days / levels / styles, and the locale wording for each. The rows themselves
 * are placeholder content and live in `src/data/schedule.ts` — the one file the
 * Sanity ticket replaces.
 *
 * Nothing here is locale-specific *data*. An entry stores a weekday key, a
 * 24-hour `HH:MM` string and three enum values; the view resolves those to words
 * through the maps below. That is what makes `/schedule` and `/en/schedule` two
 * renderings of one dataset rather than two datasets.
 */

/** Monday-first, which is how a Croatian week is written and read. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** The fixed set of levels: beginner / intermediate / advanced. There is no fourth. */
export const LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export type Level = (typeof LEVELS)[number];

/** The three flavours of bachata the studio teaches, as on the homepage. */
export const STYLES = ['traditional', 'moderna', 'sensual'] as const;
export type Style = (typeof STYLES)[number];

export interface ClassEntry {
  day: Weekday;
  /** Start time, 24-hour `HH:MM`. Stored unformatted; the view decides display. */
  start: string;
  /** Minutes. Every class is 60 today, but a workshop will not be. */
  durationMin: number;
  style: Style;
  level: Level;
  /** Display name. Not an id — a CMS will hand over whatever the studio typed. */
  instructor: string;
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
  hr: { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' },
  en: { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' },
};

/**
 * What each level assumes, measured in **time danced**.
 *
 * The rule this encodes (MUSE-6): a prerequisite is useless to the person who
 * needs it most if it is written in the vocabulary of the class they have not
 * taken. "Confident cross-body lead" tells a beginner nothing; "about a year of
 * dancing" tells them everything. No step names, no figure names, no course
 * numbering — ever, in either language.
 */
export const LEVEL_PREREQUISITE: Record<Locale, Record<Level, string>> = {
  hr: {
    beginner: 'Bez iskustva — nikad nisi plesao ni plesala.',
    intermediate: 'Plešeš oko godinu dana.',
    advanced: 'Plešeš dvije ili više godina.',
  },
  en: {
    beginner: 'No experience — you have never danced.',
    intermediate: 'About a year of dancing.',
    advanced: 'Two or more years of dancing.',
  },
};

export const STYLE_NAME: Record<Locale, Record<Style, string>> = {
  hr: { traditional: 'Tradicionalna', moderna: 'Moderna', sensual: 'Sensual' },
  en: { traditional: 'Traditional', moderna: 'Moderna', sensual: 'Sensual' },
};

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

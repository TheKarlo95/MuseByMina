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

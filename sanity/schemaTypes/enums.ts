import {
  LEVELS,
  LEVEL_NAME,
  STYLES,
  STYLE_NAME,
  WEEKDAYS,
  WEEKDAY_NAME,
} from '../../src/lib/schedule';
import { PAGES } from '../../src/lib/pages';

/**
 * The closed sets, imported from the code that owns them rather than retyped here.
 *
 * This is the **content vs structure** decision of MUSE-19, made concrete.
 *
 * A level is not a word Mina should be able to type. `Level` is a TypeScript union that
 * the schedule grid, the filter chips, the level badge and the trial form's `<select>`
 * values all branch on (`src/lib/schedule.ts`, `src/lib/forms.ts`), and MUSE-11 already
 * reduced the *names* to one source — `LEVEL_NAME` — with a guard test that forbids a
 * second copy anywhere. A free-text `level` field in Sanity would be exactly that
 * second copy, published, with a typo ("Beginer") that renders an unstyled badge and a
 * filter chip that matches nothing. Worse, it would be a copy nobody could grep for.
 *
 * Same for styles and weekdays: `STYLES` drives the three style cards and the filter
 * row, `WEEKDAYS` is Monday-first because that is how a Croatian week is read, and the
 * schedule grid derives its columns from it.
 *
 * So these stay in code, and the Studio offers them as a **fixed list**: Mina picks,
 * she cannot type. The option *titles* come from the same `LEVEL_NAME` / `STYLE_NAME` /
 * `WEEKDAY_NAME` maps the pages render, so what she sees in the Studio is what a
 * visitor sees — and a renamed level is a one-line code change that moves both at once.
 *
 * What *is* content, and does live in Sanity: the class names and descriptions, the
 * instructors, the prices, the events, the images and their alt text, the FAQ, the
 * posts, and the per-page title/description. Everything a studio owner would want to
 * change on a Tuesday afternoon without asking anybody.
 *
 * What is deliberately **not** in Sanity even though it is words — and why:
 *
 *   - `LEVEL_PREREQUISITE` (`src/lib/schedule.ts`). MUSE-6 encoded a rule in it: a
 *     prerequisite is measured in time danced, never in step or figure names, because
 *     "confident cross-body lead" tells a beginner nothing. Code can hold that rule;
 *     a text field invites the first well-meaning edit that breaks it.
 *   - `FORM_COPY` (`src/lib/forms.ts`). The browser needs the validation messages at
 *     runtime, handed over as `data-msg-*` attributes. A half-translated validation
 *     message is a form that cannot be submitted, not a typo.
 *   - The privacy notice. Legal text that needs a git history and a reviewer.
 *   - `formatTime`, `classCount`, the currency and date formats of design system §10.
 *     Those are formatting rules, and a CMS field for one is a way to publish `25:00`.
 *   - The route list below: which pages exist is decided by `src/pages/`, and
 *     `test/seo.test.ts` reads the page list off the filesystem for exactly that reason.
 *     Sanity owns a page's *words*, never its existence.
 */

/** A `list` option as Sanity wants it: stored value plus the label Mina reads. */
export interface EnumOption {
  readonly title: string;
  readonly value: string;
}

/**
 * Levels, labelled with the names the pages render.
 *
 * Deliberately English in both locales (MUSE-11): the level is closer to a proper noun
 * of the bachata scene than to prose, and one spelling per level means the HR and EN
 * pages render the same badge from the same enum. `LEVEL_NAME.hr` is therefore the
 * right label for a Croatian-speaking editor — it is what her Croatian page will say.
 */
export const LEVEL_OPTIONS: readonly EnumOption[] = LEVELS.map((level) => ({
  title: LEVEL_NAME.hr[level],
  value: level,
}));

export const STYLE_OPTIONS: readonly EnumOption[] = STYLES.map((style) => ({
  title: STYLE_NAME.hr[style],
  value: style,
}));

export const WEEKDAY_OPTIONS: readonly EnumOption[] = WEEKDAYS.map((day) => ({
  title: WEEKDAY_NAME.hr[day],
  value: day,
}));

/**
 * The routes a `page` document may describe, read off `src/lib/pages.ts`.
 *
 * One source, so a `page` document can never claim a route the site does not serve —
 * and when MUSE-20 moves the strings into Sanity, the registry that `llms.txt` and
 * `test/seo.test.ts` are built around keeps owning *which* routes exist.
 */
export const ROUTE_OPTIONS: readonly EnumOption[] = PAGES.map((page) => ({
  title: `${page.name.hr} — ${page.route}`,
  value: page.route,
}));

/** Billing period for a pricing tier. The *wording* per locale belongs to the page. */
export const PRICE_PERIODS = ['class', 'course', 'month', 'package'] as const;

export const PRICE_PERIOD_OPTIONS: readonly EnumOption[] = [
  { title: 'po satu', value: 'class' },
  { title: 'po ciklusu', value: 'course' },
  { title: 'mjesečno', value: 'month' },
  { title: 'paket', value: 'package' },
];

/** Event kinds, matching the card variants in design system §7.3. */
export const EVENT_TYPES = ['party', 'workshop', 'bootcamp', 'social'] as const;

export const EVENT_TYPE_OPTIONS: readonly EnumOption[] = [
  { title: 'Party', value: 'party' },
  { title: 'Workshop', value: 'workshop' },
  { title: 'Bootcamp', value: 'bootcamp' },
  { title: 'Social', value: 'social' },
];

/** Where the footer's social icons can point (design system §7.1). */
export const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'tiktok', 'youtube'] as const;

export const SOCIAL_PLATFORM_OPTIONS: readonly EnumOption[] = [
  { title: 'Instagram', value: 'instagram' },
  { title: 'Facebook', value: 'facebook' },
  { title: 'TikTok', value: 'tiktok' },
  { title: 'YouTube', value: 'youtube' },
];

/**
 * Start time, 24-hour `HH:MM`.
 *
 * The same shape `formatTime` in `src/lib/schedule.ts` throws on, so the Studio refuses
 * what the build would refuse — Mina finds out while she is typing rather than from a
 * red deploy. Kept as a string rather than a `datetime` on purpose: a weekly class has
 * a time of day and no date, and a `datetime` would drag a timezone into it.
 */
export const HH_MM_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

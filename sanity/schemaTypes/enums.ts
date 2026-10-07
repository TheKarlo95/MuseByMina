import {
  LEVELS,
  LEVEL_NAME,
  STYLES,
  STYLE_NAME,
  WEEKDAYS,
  WEEKDAY_NAME,
} from '../../src/lib/schedule';
import { ROUTES } from '../../src/lib/pages';

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
 * One source, so a `page` document can never claim a route the site does not serve. The
 * strings moved into Sanity in MUSE-20 and the registry kept owning *which* routes
 * exist — which is why the label here is `studioLabel` and not the document's own
 * `name`: the dropdown has to name a page Mina has not written a document for yet, so
 * the label cannot come from the document.
 */
export const ROUTE_OPTIONS: readonly EnumOption[] = ROUTES.map((entry) => ({
  title: `${entry.studioLabel} — ${entry.route}`,
  value: entry.route,
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

/**
 * Where the footer's social links can point (design system §7.1).
 *
 * `linktree` is here because the studio has one and the footer links to it — MUSE-20
 * moved the three real social URLs into `siteSettings`, and a platform the Studio cannot
 * store is a link the site would have to keep hardcoded. The others are the networks a
 * dance studio plausibly adds next; an unused option costs nothing, a missing one costs
 * an edit nobody can make.
 *
 * **One list, and the names derived from it.** It was two — a tuple with no consumers and
 * a hand-written option list — so adding `linktree` meant adding it twice in this file,
 * in a file whose own opening rule is that an option list is `MAP`ped from the constant
 * that owns it (`LEVEL_OPTIONS`, `STYLE_OPTIONS`, `WEEKDAY_OPTIONS`, `ROUTE_OPTIONS`).
 * Adding it once and forgetting the other would have been a platform the Studio offers
 * and nothing renders, or renders and nothing offers. `test/sanity.test.ts` pins the
 * options to this tuple the same way it pins the levels.
 *
 * The names are proper nouns, so they are the same in both locales and are not content.
 */
export const SOCIAL_PLATFORMS = [
  'instagram',
  'facebook',
  'linktree',
  'tiktok',
  'youtube',
] as const;

export const SOCIAL_PLATFORM_NAME: Record<(typeof SOCIAL_PLATFORMS)[number], string> = {
  instagram: 'Instagram',
  facebook: 'Facebook',
  linktree: 'Linktree',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

export const SOCIAL_PLATFORM_OPTIONS: readonly EnumOption[] = SOCIAL_PLATFORMS.map(
  (platform) => ({ title: SOCIAL_PLATFORM_NAME[platform], value: platform }),
);

/**
 * Start time, 24-hour `HH:MM`.
 *
 * The same shape `formatTime` in `src/lib/schedule.ts` throws on, so the Studio refuses
 * what the build would refuse — Mina finds out while she is typing rather than from a
 * red deploy. Kept as a string rather than a `datetime` on purpose: a weekly class has
 * a time of day and no date, and a `datetime` would drag a timezone into it.
 */
export const HH_MM_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Street, a comma, city — „Ilica 209, Zagreb".
 *
 * The footer renders the address as two lines with the country translated underneath
 * (design system §7.1), so something has to split the one field Mina types.
 * `addressLines` in `src/lib/sanity/decode.ts` splits it on the comma and fails the
 * build naming the document if it cannot; this is the same rule, enforced in the Studio,
 * so she finds out while she is typing rather than from a red deploy — the same reason
 * `HH_MM_PATTERN` is here.
 *
 * The country is deliberately not part of it: it is a translated word, and it lives in
 * `STUDIO` in `src/lib/nav.ts`.
 */
export const ADDRESS_PATTERN = /^[^,]+,[^,]+$/;

import type { Locale } from './i18n';

export interface NavItem {
  /** Route without locale prefix, e.g. `/schedule`. */
  route: string;
  label: Record<Locale, string>;
  /** Shown only in the mobile panel — the desktop bar stays short. */
  mobileOnly?: boolean;
}

/**
 * One list, two information architectures.
 *
 * axcentdance.com's best idea: a single DOM list where CSS hides a few entries on
 * desktop and reveals them in the mobile panel. The desktop bar stays short; the
 * mobile panel is a complete index. No second menu to keep in sync.
 *
 * ---------------------------------------------------------------------------
 * **Every route in this file must have a page behind it** (MUSE-13).
 *
 * The foundation commit declared the finished information architecture here before the
 * pages existed, so twelve of the sixteen menu entries 404ed in both locales — 24 dead
 * links on every page of the site. The list was therefore cut back to the routes that
 * are actually published, and each page ticket (MUSE-22…28) re-adds its own entry as
 * part of being done rather than this file running ahead of `src/pages/`.
 *
 * This is not a convention anyone has to remember: `test/nav.test.ts` serves the built
 * output from a model of GitHub Pages and follows every same-origin link on every page,
 * header and footer alike. A route added here without a page fails the suite with the
 * 404 named, so the IA can grow back one page at a time without ever shipping a dead
 * link.
 *
 * **And the reverse** (MUSE-37): a page added to `src/pages/` that nothing in its own
 * locale links to — not this list, not the footer, not a link in a component — fails the
 * same suite, named, per locale. `/privacy` is why the rule is "linked from somewhere"
 * rather than "listed here": it is footer-only and deliberately not a menu entry. That
 * half of the guard was a tautology until MUSE-37 — every page links to itself through
 * the locale switcher, so every page counted as reached — which is why "each page ticket
 * re-adds its own entry" is enforced rather than trusted.
 *
 * `mobileOnly` is deliberately kept even though the bar is short enough not to need it
 * yet — `/` stays panel-only because the logo is the home link on desktop, which is
 * true at any list length. The twelve pages are coming back; the mechanism is not dead
 * code waiting to be rediscovered.
 * ---------------------------------------------------------------------------
 */
export const PRIMARY_NAV: NavItem[] = [
  { route: '/', label: { hr: 'Početna', en: 'Home' }, mobileOnly: true },
  { route: '/schedule', label: { hr: 'Raspored', en: 'Schedule' } },
  // MUSE-59 and MUSE-60 each re-added one of these, with its page and its documents in
  // the same pull request — which is what "each page ticket re-adds its own entry" means.
  // Both were among MUSE-13's twelve: the entries were here, neither route existed, and
  // both links 404ed in both locales on every page of the site. `/aboutus` waited for its
  // `studioStory` document in particular, because the build fails by name on a missing
  // one, so the entry could not go in ahead of it.
  { route: '/pricing', label: { hr: 'Cjenik', en: 'Pricing' } },
  { route: '/aboutus', label: { hr: 'O nama', en: 'About us' } },
  { route: '/contact', label: { hr: 'Kontakt', en: 'Contact' } },
];

/**
 * The single "More" disclosure. Trust content first, then services.
 *
 * It was empty from MUSE-13 until MUSE-65 — `/firstclass`, `/whatisbachata`,
 * `/etiquette`, `/faq`, `/gallery`, `/blog`, `/privatelessons`, `/weddingdance` and
 * `/roomrental` all lived here with nothing behind them. The header renders no disclosure
 * at all while this is empty: an empty "More" button is a worse affordance than no
 * button, and an `aria-expanded` control that reveals an empty list is a dead end for a
 * screen reader rather than merely a disappointment. `test/nav.test.ts` states that as a
 * conditional on this array rather than as "there is no More button", so the disclosure
 * comes back with its first entry and is held to its own criteria the same day.
 *
 * **`/whatisbachata` is that first entry, and it is here rather than in `PRIMARY_NAV` for
 * the reason the disclosure exists** (MUSE-65). The desktop bar is the decision path —
 * what is on, what it costs, who teaches, how to come — and it is budgeted at four links
 * plus this disclosure (`test/nav.test.ts`, "leaves the desktop bar neither empty nor
 * long"); a fifth uppercase link at 0.18em tracking is what makes that bar wrap. A trust
 * explainer is also not where a returning visitor is going, and its traffic arrives from
 * a search engine rather than from the masthead. It is still a complete entry in the
 * mobile panel and in the footer's quick list, which is what `MORE_NAV.slice(0, 4)` in
 * `Footer.astro` is for.
 */
export const MORE_NAV: NavItem[] = [
  { route: '/whatisbachata', label: { hr: 'Što je bachata', en: 'What is bachata' } },
];

export const CTA = {
  route: '/#trial',
  label: { hr: 'Besplatni probni sat', en: 'Free trial class' },
} as const;

/**
 * What is left of the studio record after MUSE-20: the two values the CMS has no field
 * for.
 *
 * The name, the address, the email address and the three social URLs are `siteSettings`
 * in Sanity, and every surface that shows them reads them from there — including the
 * street and the city, which `addressLines` splits off the one `address` field. There is
 * deliberately no copy of them here: a value in both places is a value that drifts, and
 * the dataset is what deploys.
 *
 * These stay:
 *
 *   - `country` — a translated word rather than part of the address. Mina types one
 *     address, and „Hrvatska"/"Croatia" is the site saying it in the page's language.
 *     A CMS field for it would be a field whose two values must match a locale, which is
 *     the kind of thing a typo makes incoherent rather than merely wrong.
 *   - `countryCode` — the same country as an ISO 3166-1 alpha-2 code, which is what
 *     schema.org's `addressCountry` asks for (MUSE-31). It sits here, beside the word,
 *     rather than in `src/lib/structured-data.ts`, so that the two renderings of one fact
 *     are in one place and a relocation changes both lines at once. It is deliberately
 *     *not* derived from `country`: a name-to-code table is a second thing to maintain,
 *     and these are two spellings of a constant, not a conversion.
 *   - `maps` — a Google Maps share link, which has no field in the schema. It is also
 *     the one value here a wrong edit would break silently: a mistyped URL still looks
 *     like a link.
 */
export const STUDIO = {
  country: { hr: 'Hrvatska', en: 'Croatia' },
  countryCode: 'HR',
  maps: 'https://maps.app.goo.gl/PK2hgiB5ALUi93Er7',
} as const;

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
 * `mobileOnly` is deliberately kept even though the bar is short enough not to need it
 * yet — `/` stays panel-only because the logo is the home link on desktop, which is
 * true at any list length. The twelve pages are coming back; the mechanism is not dead
 * code waiting to be rediscovered.
 * ---------------------------------------------------------------------------
 */
export const PRIMARY_NAV: NavItem[] = [
  { route: '/', label: { hr: 'Početna', en: 'Home' }, mobileOnly: true },
  { route: '/schedule', label: { hr: 'Raspored', en: 'Schedule' } },
  { route: '/contact', label: { hr: 'Kontakt', en: 'Contact' } },
];

/**
 * The single "More" disclosure. Trust content first, then services.
 *
 * Empty until the content pages land — `/firstclass`, `/whatisbachata`, `/etiquette`,
 * `/faq`, `/gallery`, `/blog`, `/privatelessons`, `/weddingdance` and `/roomrental` all
 * lived here with nothing behind them (MUSE-13). The header renders no disclosure at all
 * while this is empty: an empty "More" button is a worse affordance than no button, and
 * an `aria-expanded` control that reveals an empty list is a dead end for a screen
 * reader rather than merely a disappointment.
 */
export const MORE_NAV: NavItem[] = [];

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
 * These two stay:
 *
 *   - `country` — a translated word rather than part of the address. Mina types one
 *     address, and „Hrvatska"/"Croatia" is the site saying it in the page's language.
 *     A CMS field for it would be a field whose two values must match a locale, which is
 *     the kind of thing a typo makes incoherent rather than merely wrong.
 *   - `maps` — a Google Maps share link, which has no field in the schema. It is also
 *     the one value here a wrong edit would break silently: a mistyped URL still looks
 *     like a link.
 */
export const STUDIO = {
  country: { hr: 'Hrvatska', en: 'Croatia' },
  maps: 'https://maps.app.goo.gl/PK2hgiB5ALUi93Er7',
} as const;

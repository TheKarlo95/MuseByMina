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
  /**
   * **`/events` is here and not in `PRIMARY_NAV`, and the bar's budget is the reason**
   * (MUSE-24).
   *
   * It is a decision-path page — a party is a thing somebody comes to — so the obvious
   * home is the desktop bar. The bar has no room: `PRIMARY_NAV` renders four links on
   * desktop plus this disclosure, which is the budget `test/nav.test.ts` holds ("leaves
   * the desktop bar neither empty nor long"), and the note above says what a fifth
   * uppercase link at 0.18em tracking does to it. Events are also the least frequent
   * thing on the site — there are none in the dataset as this ships — so the bar would be
   * spending its last slot on the page most often empty.
   *
   * It is a complete entry in the mobile panel and in the footer's quick list either way,
   * which is what `MORE_NAV.slice(0, 4)` in `Footer.astro` is for.
   *
   * **`/events/archive` is deliberately not in this list, or any list.** It is reached
   * from `/events/` and from a past event's own page, which is where somebody looking for
   * last year's party actually is; a site-wide „Arhiva" entry would advertise past events
   * on every page of a site that has never held one. That makes `/events/archive` and
   * every `/events/<slug>/` the first pages here whose route the footer does not list —
   * see the `aria-current` partition in `test/nav.test.ts`.
   */
  { route: '/events', label: { hr: 'Događaji', en: 'Events' } },
  /**
   * **`/blog` is the third, and the same budget argument applies** (MUSE-26). The bar is
   * still four links plus this disclosure; a blog is also not where a returning visitor
   * is going, and its traffic arrives from a search engine rather than from the masthead
   * — which is the whole point of having one.
   *
   * **`/blog/<slug>` is deliberately not in this list, or any list** — it is a page per
   * `post` document, so which pages exist is content rather than structure, exactly as
   * for an event. The index is the one door, which is also what makes a post's page
   * reachable at all for `test/nav.test.ts`'s orphan rule.
   */
  { route: '/blog', label: { hr: 'Blog', en: 'Blog' } },
];

/**
 * The site's primary call to action: the trial-class form at `/#trial`.
 *
 * **It names the class and says nothing about what it costs** (MUSE-71). From the
 * foundation commit until that ticket this label priced a first class at nothing — on the
 * header button of all fourteen pages, in both locales — and the same promise was
 * repeated in the `#trial` band, `/contact`'s eyebrow, `/schedule`'s CTA band and both
 * `page` descriptions, so it reached Google's result snippets and `llms.txt` as well. The
 * studio offers no such thing: its own 2026/2027 enrolment form lists 55 € regular, 40 €
 * student and 20 € drop-in, and nothing it publishes anywhere mentions one. The claim was
 * invented in the same commit as MUSE-36's thirteen imaginary classes and it survived
 * because nobody thought to question the CTA.
 *
 * So the claim is gone and **nothing replaced it**. A first class now carries no price on
 * the site at all, which is the only honest position available without the studio stating
 * a policy: naming the drop-in rate here would be covering one invented offer with a
 * second, since nobody has said that is what a trial costs.
 * `test/offerclaims.test.ts` fails if any of it comes back — and it reads this file as
 * plain text, prose included, which is why the retired wording is quoted there and not
 * here (the MUSE-42 ruling, as `test/contentdrift.test.ts` applies it).
 *
 * The words are the brief's, shortened. §1 gives *Dođi na probni sat.* as the model
 * sentence, and that sentence is already `/contact`'s `<h1>` and the `#trial` band's
 * eyebrow; a third word-for-word copy on the same page is not emphasis. A header pill is
 * `white-space: nowrap` inside a `flex-wrap: nowrap` chrome, so the bar cannot absorb a
 * longer label either — and a noun is what every other entry in this file is.
 *
 * **It is still a code literal, and the ticket's second criterion asks for a field Mina
 * can edit.** That is a schema change — a `localeString` on `siteSettings`, regenerated
 * artefacts, a projection — and it is deliberately not in this pull request: the live
 * claim is the urgent half, and a CMS-owned CTA is a change of shape that wants its own
 * review. Until it lands, the guard is the only thing holding this label.
 */
export const CTA = {
  route: '/#trial',
  label: { hr: 'Probni sat', en: 'Trial class' },
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

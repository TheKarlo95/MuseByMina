/**
 * **Which webfont subsets a page preloads — per page, derived rather than listed**
 * (MUSE-74).
 *
 * `BaseLayout.astro` preloaded a fixed pair, `cormorant-garamond-latin` and
 * `inter-400-600-latin`, on every page in both locales. Both are faces every page does
 * need, so the only guard watching them — `preloaded ⊆ needed` — was green. What it could
 * not see is the other direction, and the other direction is where the defect was:
 *
 * ```
 * route            faces the page requests   not preloaded
 * /                6                         cormorant-ext, jost, jost-ext, inter-ext
 * /schedule/       5                         jost, jost-ext, inter-ext
 * /en/             3                         jost
 * ```
 *
 * Two consequences, and the first is the one a visitor sees. `@font-face` subsets split on
 * `unicode-range` and **every Croatian diacritic — `č ć ž š đ` — lives in `latin-ext`**.
 * With `font-display: swap` on all six faces, the latin half of a word paints as soon as
 * `…-latin` arrives while the diacritic paints from the system fallback until `…-latin-ext`
 * catches up: „Do**đ**i na probni sat" at 96px with a heavy upright slab mid-word, and
 * „Nau**č**i bachatu u Zagrebu" at 136px, the largest text on the site. The second is
 * flatter and everywhere: `jost-300-500-latin` was preloaded nowhere, and Jost is the label
 * face — masthead, buttons, form labels, above the fold on every page in both locales.
 *
 * This project has now paid three times for the `đ`. The 26px display floor exists because
 * its crossbar vanishes below that and *Dođi* reads as "Dodi" (design system §4); MUSE-35
 * was all six faces falling back to Georgia in dev; this is the subset half.
 *
 * ## The rule, and the one place a human still decides
 *
 * `preloadFaces` answers in four parts, and **they are not equally trustworthy**. Saying
 * which is which is the point of this comment, because the first version of this file got
 * one of them wrong and shipped a second that went stale within a day.
 *
 *   1. **The three `latin` subsets, on every page.** Structural, in the strong sense: the
 *      shell paints in all three families before any page content does — the masthead and
 *      the skip link in Jost, the heading in Cormorant, the footer in Inter. No copy
 *      change can alter that.
 *   2. **Jost's and Inter's `latin-ext`, on every Croatian page.** Structural and
 *      *verified*: the skip link `BaseLayout` renders on every page is „Preskoči na
 *      sadržaj", set in the label face (`.skip-link`, `base.css`); the footer's quick
 *      links include „Početna" and „Što je bachata", set in the body face. Both strings
 *      come from code — the layout itself and `src/lib/nav.ts` — so a Croatian page
 *      cannot be built without diacritics in both faces.
 *   3. **Cormorant's `latin-ext`, on every Croatian page.** *Not* structural — three
 *      Croatian pages do not paint a diacritic in the display face today — but preloaded
 *      unconditionally anyway. See the next section; this is the deliberate cost.
 *   4. **English pages: the `latin` three, plus whatever `EN_LATIN_EXT` names.** The only
 *      hand-maintained table left, and the only additive one.
 *
 * ## Why there is no list that can say "does not need"
 *
 * There was one, per route, for Cormorant's latin-ext. **Two pull requests merged on the
 * day it was written and each invalidated it**, in two different ways:
 *
 *   - **MUSE-71** retired the offer claim `Schedule.astro`'s `trialLede` used to make
 *     and replaced it with **„Dođi na probni sat."**, rendered `<h2 class="displayM">`.
 *     The old wording had no diacritic in it; `/schedule` was listed here as having
 *     plain-latin display copy, and now it sets a `đ` in Cormorant. (The retired string
 *     is deliberately not quoted — `test/offerclaims.test.ts` scans prose too, and it is
 *     right to.)
 *   - **MUSE-72** corrected the regulator's address to **„Ulica Metela Ožegovića 16"**.
 *     A street name is a proper noun, so it is not translated, and it appears verbatim in
 *     the English privacy notice — making `/en/privacy` the first English page in the
 *     project to need `inter-400-600-latin-ext`.
 *
 * Both were caught by the guard before anything deployed, which is the system working.
 * But look at *what* was wrong in each case: a route explicitly recorded as **not
 * needing** a subset. A list that can say "does not need" can be wrong in the direction a
 * visitor sees — a different typeface mid-word, at 96px, measured at a 221 ms window on a
 * throttled cold load. A list that can only *add* is wrong in the direction the
 * performance budget already counts, in bytes, with a ceiling on them.
 *
 * So the subtractive list is gone. **Croatian pages preload all six faces**, and the three
 * that do not need Cormorant's latin-ext today — `/aboutus`, `/pricing`, `/privacy` —
 * carry 33.7 KB they will not paint with. That number was weighed and rejected once in
 * this ticket, correctly, *given a list that could be relied on*; it cannot be, so it is
 * paid. `test/fonts.test.ts` still refuses any other unused preload, and the budget
 * measures what this costs per page.
 *
 * English is the exception that cannot be ruled away, and `EN_LATIN_EXT` is additive for
 * the reason written beside it: the same default there costs 135.9 KB on pages whose
 * entire font payload is 109.8 KB.
 *
 * ## Why this is not derived from the rendered page, measured rather than assumed
 *
 * The obvious objection to any declaration is that the page's own text is knowable at
 * build time. It was tried, and it fails on two independent rocks.
 *
 *   - **The rendered text does not answer the question.** The question is per *face* —
 *     "does this page paint a latin-ext character **in Cormorant**" — and attributing a
 *     character to a face means modelling the cascade. Not in the abstract: on
 *     `/pricing/`, which the browser measures as **not** needing Cormorant's latin-ext,
 *     the rendered HTML contains „Što je bachata" inside `.navList a`, and `.navList a`
 *     *is* `var(--font-display)`. It is not requested only because `.nav` is
 *     `display: none` at the width everything measures at. A model would have to know the
 *     media queries and the computed visibility — it would have to be the engine — and a
 *     model of the engine passes whenever the model is wrong, which is the reasoning
 *     `test/numerals.test.ts` and `test/fonts.test.ts` already rest on.
 *   - **The one hook that exposes the rendered body breaks the page.** `Astro.slots
 *     .render('default')` does return the rendered slot inside this layout's frontmatter,
 *     before `<head>` is emitted — so the body text *is* reachable there, contrary to the
 *     obvious reading. But calling it silently drops every component's hoisted
 *     `<script type="module">`. Measured against a clean build: eight of fifteen pages
 *     lost theirs, including `/schedule/`'s level filters and `/contact/`'s form. A
 *     preload list bought with a dead filter bar is not a trade.
 *
 * So the declaration stays small and additive, and the *measurement* stays where it can
 * be taken honestly: in a browser, with the preload tags stripped out of the document
 * first, by `test/fonts.test.ts`, per page, per locale, per deploy target.
 *
 * ## The residual risk, stated rather than buried
 *
 * `test/fonts.test.ts` runs on pull requests. **The scheduled rebuild (MUSE-21) runs
 * `npm run build` and nothing else**, so a *Sanity* edit can stale `EN_LATIN_EXT` and
 * deploy: an instructor named „Željka" on `/en/aboutus/` would want Inter's latin-ext and
 * not get it. Both strings that broke the old tables were in code and so were gated; a
 * Studio edit is not. Croatian pages are immune by construction now — parts 2 and 3 cover
 * all three faces whatever Mina writes — so the exposure is exactly "a Croatian proper
 * noun entering English copy from the CMS". That is the thing to fix next if it bites.
 */

import type { Locale } from './i18n';

/**
 * The files, imported rather than named as paths.
 *
 * `?url` hands back whatever URL the build gives each file — base joined, content hash and
 * all — which is the same URL Vite writes into the `@font-face` `src` in
 * `src/styles/fonts.css`, because it is the same file going through the same resolver.
 * **That identity is the point** (MUSE-35): a preload whose href is not also a `src` is a
 * second download of a face the page was going to fetch anyway, and from the outside it
 * looks exactly like a working preload. `test/assets.test.ts` holds the two together.
 *
 * This is also what replaced `rootPath()` in the layout. `rootPath` joins the deploy base
 * correctly (MUSE-8), but it can only join it to a path someone typed, and the path someone
 * typed is the thing that went stale.
 *
 * No CSS is imported here, so this module's position in `BaseLayout`'s frontmatter cannot
 * move the built `<head>` (MUSE-43) — the same reason `./icon` and `./share-card` sit where
 * they do.
 */
import cormorantLatin from '../assets/fonts/cormorant-garamond-latin.woff2?url';
import cormorantLatinExt from '../assets/fonts/cormorant-garamond-latin-ext.woff2?url';
import jostLatin from '../assets/fonts/jost-300-500-latin.woff2?url';
import jostLatinExt from '../assets/fonts/jost-300-500-latin-ext.woff2?url';
import interLatin from '../assets/fonts/inter-400-600-latin.woff2?url';
import interLatinExt from '../assets/fonts/inter-400-600-latin-ext.woff2?url';

/** The role a family plays, named the way `tokens.css` names it. */
export type FontRole = 'display' | 'label' | 'body';

/** Which half of the `unicode-range` split a file covers. */
export type FontSubset = 'latin' | 'latin-ext';

export interface Face {
  /**
   * The file's stem, which is how a failure names it.
   *
   * Not the emitted filename: that carries a content hash, which is unpredictable from
   * outside the build, so anything pinning it would be transcribing the output rather than
   * describing it.
   */
  readonly id: string;
  readonly role: FontRole;
  readonly subset: FontSubset;
  /** The URL the build emits, and the one `fonts.css` asks for. */
  readonly href: string;
}

/**
 * Every face `src/styles/fonts.css` declares, in the order a page preloads them.
 *
 * Display first and its two subsets adjacent, because the largest text on every page is a
 * display heading and because the defect this ticket is about is the two halves of *one
 * word* arriving at different times. Then the label face, which is the masthead, then the
 * body face, which is most of the words and none of the first impression.
 */
export const FACES: readonly Face[] = [
  {
    id: 'cormorant-garamond-latin',
    role: 'display',
    subset: 'latin',
    href: cormorantLatin,
  },
  {
    id: 'cormorant-garamond-latin-ext',
    role: 'display',
    subset: 'latin-ext',
    href: cormorantLatinExt,
  },
  { id: 'jost-300-500-latin', role: 'label', subset: 'latin', href: jostLatin },
  {
    id: 'jost-300-500-latin-ext',
    role: 'label',
    subset: 'latin-ext',
    href: jostLatinExt,
  },
  { id: 'inter-400-600-latin', role: 'body', subset: 'latin', href: interLatin },
  {
    id: 'inter-400-600-latin-ext',
    role: 'body',
    subset: 'latin-ext',
    href: interLatinExt,
  },
];

/**
 * **English routes that paint a latin-ext character, and the face that paints it.**
 *
 * This is the only route table left, and it is **additive**: a route not listed here gets
 * no latin-ext subset at all. That is the uncomfortable direction — an omission is a
 * missing preload, which is this ticket's defect — and it is accepted here and nowhere
 * else, for a reason the measurement settles. Defaulting an English page to all three
 * latin-ext subsets costs **135.9 KB** against a current English font payload of 109.8 KB,
 * and six of the seven English pages genuinely need none of them. More than doubling
 * every English page to cover one is not a trade; on the Croatian side, where the same
 * question costs 33.7 KB on three pages, it is, and that is why the two sides are
 * written differently.
 *
 * **It replaces `locale === 'en'` meaning "no latin-ext"**, which was a claim about
 * English copy presented in this file as a structural fact, and which was wrong within a
 * day of being written. A Croatian proper noun inside an English sentence will keep
 * happening — a street, an instructor's name, a quoted phrase — because proper nouns are
 * not translated, and **no locale-based rule will ever predict it**. An additive list
 * plus the guard is the honest answer: `test/fonts.test.ts` compares both directions on
 * every page of every pull request, so an omission is a red CI rather than a deploy.
 *
 * Measured, not reasoned: built, served, and opened in a real browser with the preload
 * tags stripped out of the document. `npm test -- fonts` is that measurement.
 */
const EN_LATIN_EXT: ReadonlyMap<
  string,
  { readonly roles: readonly FontRole[]; readonly why: string }
> = new Map([
  [
    '/privacy',
    {
      roles: ['body'],
      why: "AZOP's \u201EUlica Metela O\u017Eegovi\u0107a 16\u201C \u2014 a street name, so untranslated, and it lands in running prose (MUSE-72)",
    },
  ],
]);

/**
 * The faces `route` needs to paint its first screen in `locale`.
 *
 * `route` is a `routeKey` — locale prefix and deploy base already stripped — so the table
 * above is keyed by route rather than by URL.
 */
export function preloadFaces(route: string, locale: Locale): readonly Face[] {
  const latinExt: readonly FontRole[] =
    locale === 'en'
      ? (EN_LATIN_EXT.get(route)?.roles ?? [])
      : // Croatian: all three, by construction and with no route able to opt out.
        ['display', 'label', 'body'];

  return FACES.filter((face) => face.subset === 'latin' || latinExt.includes(face.role));
}

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
 * ## The rule, and why it is a rule rather than a table of filenames
 *
 * `preloadFaces` answers in three parts, each with a different kind of justification:
 *
 *   1. **The three `latin` subsets, on every page.** Structural: the shell paints in all
 *      three families before any page content does — the masthead and the skip link in
 *      Jost, the heading in Cormorant, the footer in Inter — so there is no page of this
 *      site that does not need all three.
 *   2. **Jost's and Inter's `latin-ext`, on every Croatian page.** Also structural, and
 *      that is the part worth knowing: it does not depend on what the page says. The skip
 *      link `BaseLayout` renders on every page is „Preskoči na sadržaj" and it is set in
 *      the label face (`.skip-link`, `base.css`); the footer's quick links include
 *      „Početna" and „Što je bachata" in the body face. Both come from code — the layout
 *      itself and `src/lib/nav.ts` — so a Croatian page cannot be built without diacritics
 *      in both of those faces.
 *   3. **Cormorant's `latin-ext`, on a Croatian page unless this route's display copy is
 *      known to be plain latin.** This is the one part that is a fact about *content*, and
 *      `DISPLAY_WITHOUT_LATIN_EXT` below is where it is written down.
 *
 * ## Why the exception list runs that way round
 *
 * Note the direction: an unlisted route **gets** the preload. The two ways this can be
 * wrong are not equally bad. Preloading a face the page does not paint with costs 33.7 KB
 * of download nobody looks at — MUSE-8's and MUSE-35's waste pointed the other way, and a
 * preload that outbids something the page does need. *Not* preloading one the page does
 * paint with is this ticket. So the default is the cheaper mistake, and a route comes off
 * the list only with a measurement. `test/fonts.test.ts` fails on both directions anyway,
 * naming the page and the face, which is what makes either one a red test rather than a
 * deploy.
 *
 * It also means the error page needs no special case. `404.astro` is served for every
 * unknown path (MUSE-38), so under `astro dev` its route key is whatever was asked for —
 * never a route this file could have listed. Defaulting to the preload makes the dev server
 * and the build agree about it, and the answer happens to be right for a second reason:
 * that page is bilingual by design, so its Croatian display heading („Ova stranica još ne
 * postoji.") is on it whatever else is.
 *
 * ## What this file deliberately does not try to be
 *
 * The exact form of part 3 is "does any text on this page that is set in the display face
 * contain a latin-ext character", and answering *that* at build time means knowing which
 * text is in which family — which means a model of the cascade, because the three families
 * are assigned by a dozen scoped class names across eleven components, and one of them
 * (`.navList a`, the mobile panel) is `display: none` at the width anything measures at, so
 * its diacritics are not requested at all. A model of the engine passes whenever the model
 * is wrong, which is the reasoning `test/numerals.test.ts` and `test/fonts.test.ts` are both
 * already built on. So the model here is four lines of data with the evidence beside each,
 * and the *measurement* stays where it can be taken honestly: in a browser, with the
 * preload tags stripped out of the document first.
 *
 * The cost of that choice, stated rather than buried: those four entries are about copy, and
 * some of that copy is Mina's. If she rewords `/schedule`'s heading to something with a `č`
 * in it, this file is stale and the build will not say so — `npm test` will, on the next
 * pull request. The alternative considered was preloading `latin-ext` on every Croatian
 * page, which can never go stale and can never be missing a face; measured, that is 33.7 KB
 * of Cormorant nobody paints with on four of the seven Croatian pages, and it fails this
 * ticket's own acceptance criterion in the other direction.
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
 * Croatian routes whose **display** copy is plain latin, with the evidence beside each.
 *
 * Measured, not reasoned: built, served, and opened in a real browser with the preload tags
 * stripped out of the document, which is the only way to ask what the CSS engine wants.
 * `npm test -- fonts` is that measurement and `npm run budget` prints the face count per
 * page. Each entry names the display text that makes it true, so a reader can check it
 * against the page rather than against this list.
 *
 * The heading is not the only display text on these pages — `/pricing`'s prices,
 * `/aboutus`'s instructor names and `/schedule`'s class times are set in the display face
 * too — so each note names the heading and the claim is about all of it.
 *
 * Keyed by `routeKey`, so one entry covers both locales of a route. The English half never
 * reaches the map: `preloadFaces` answers the latin-ext question on the locale first.
 */
const DISPLAY_WITHOUT_LATIN_EXT: ReadonlyMap<string, string> = new Map([
  ['/schedule', '„Raspored" — the weekday headings are the label face, not this one'],
  ['/pricing', '„Cijene", and the prices under it are figures'],
  ['/aboutus', '„O nama", and the instructors are „Mina" and „Antonio"'],
  ['/privacy', '„Pravila privatnosti"'],
]);

/**
 * The faces `route` needs to paint its first screen in `locale`.
 *
 * `route` is a `routeKey` — locale prefix and deploy base already stripped — which is why
 * one map above serves both locales.
 */
export function preloadFaces(route: string, locale: Locale): readonly Face[] {
  const needsDisplayExt = locale !== 'en' && !DISPLAY_WITHOUT_LATIN_EXT.has(route);

  return FACES.filter((face) => {
    if (face.subset === 'latin') return true;
    if (locale === 'en') return false;
    return face.role === 'display' ? needsDisplayExt : true;
  });
}

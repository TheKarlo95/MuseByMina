import type { Locale } from './i18n';

/**
 * **`/gallery` — the photographs, the lightbox, and the page that says there are none**
 * (MUSE-25).
 *
 * This file holds the decisions the ticket asked to be made once and written down. None of
 * it is content: every string here describes the *page*, the *interface* or the *site's own
 * state*, never the studio. A photograph, its alt text and its caption are all
 * `galleryImage` fields in Sanity.
 *
 * ---------------------------------------------------------------------------------
 * ## 1. The empty state is the shipped state, and this page is the hard case
 *
 * There are no `galleryImage` documents, no photography of this studio has been taken, and
 * the owner decided to ship the page anyway because a real page that fills itself is better
 * than a 404. That decision is right and the cost is worth naming plainly: **unlike
 * `/events` and `/blog`, whose purpose survives having no content, a gallery's entire
 * purpose *is* the images.** An events page with no events still tells you the studio runs
 * a weekly timetable; a gallery with no photographs tells you nothing a visitor came for.
 *
 * So this page will look thin until a shoot happens, and the design does not disguise it:
 *
 *   - **No filler.** No placeholder tiles, no decorative frames standing in for
 *     photographs, no stock imagery. MUSE-36 is the precedent — thirteen invented classes
 *     and two instructors who do not teach here, live for the life of the project — and a
 *     grid of grey squares is the same lie with the words taken out.
 *   - **No grid and no section heading when there is nothing** (the `/events` rule). An
 *     empty grid reads as a page that failed to load, which is a worse answer than „there
 *     are none" because it is not even an answer.
 *   - **No lede either**, which is the one thing this page does that `/events` does not.
 *     A lede's job here would be to describe the photographs; with none to describe it
 *     would be a sentence about pictures that do not exist. {@link GALLERY_COPY}'s `lede`
 *     therefore renders only beside a populated grid — see `Gallery.astro`.
 *   - **It promises nothing.** No „coming soon", no „uskoro", no „check back". The empty
 *     body states a present fact — the studio has not been photographed — and offers the
 *     thing that *does* exist: a timetable and a way to ask. „Soon" is a commitment nobody
 *     made, on behalf of a shoot nobody has booked.
 *
 * **The words are code, not CMS**, for `EVENT_COPY`'s reason: „there are no photographs" is
 * a statement about the dataset, and Mina cannot keep a field describing the dataset true
 * because she cannot see when it renders. Everything a reader would call content — the
 * picture, its description, its caption — is a field.
 *
 * ## 2. The lightbox is a native `<dialog>`, opened by script
 *
 * The long argument is in `Gallery.astro`, because it is as much about markup as about
 * these strings. The short version: `showModal()` is the only mechanism in a browser that
 * makes the rest of the document **inert**, and inertness is what „focus is trapped" means
 * when it is true rather than approximated. Escape and focus-return come with it.
 *
 * ## 3. Sizes are the CDN's job and the ratio is CSS's
 *
 * {@link GRID_WIDTHS}, {@link GRID_SIZES}, {@link FULL_WIDTHS} and {@link FULL_SIZES} are
 * the four numbers the markup needs, here rather than in the component so that the budget
 * note, the test and the `<img>` read one declaration. `src/lib/sanity/images.ts` resolves
 * them into a `srcset`.
 * ---------------------------------------------------------------------------------
 */

/** The route. One entry in `ROUTES`, one `page` document, two wrappers. */
export const GALLERY_ROUTE = '/gallery';

/**
 * **How many tiles load before the visitor scrolls, and why it is two and not zero.**
 *
 * §9 rule 5 says `loading="lazy"` below the fold and never on the hero. Taken literally for
 * a gallery that is *entirely* below a text hero, that means every tile is lazy — which is
 * correct for the visitor and has a consequence worth stating: `scripts/budget.mjs` opens
 * each page at 1280×900 and weighs what the browser fetched, so a fully-lazy gallery
 * measures **zero image bytes** however heavy its photographs are. The gate would be green
 * and blind, which is the shape of guard this repository keeps having to replace.
 *
 * Two tiles is the first row at 390px — the width the design system sizes for first — so it
 * is the page's own LCP candidate rather than a number chosen to make a gate see something.
 * On wider viewports the rest of the first row is lazy *and inside the viewport*, which a
 * browser loads immediately anyway, so eagerness buys nothing there and costs nothing here.
 *
 * The honest summary: this makes the budget's `image` line measure a real photograph on a
 * real page instead of nothing. It is not a complete answer to „what does a gallery
 * weigh" — see the note beside `BUDGET.bytes.image`, which says what that line can and
 * cannot see and why no number can cover the scrolled page.
 */
export const EAGER_TILES = 2;

/**
 * **The widths the CDN is asked for, per surface — three rungs each, derived rather than
 * rounded.**
 *
 * Three and not five, and the reason is the HTML budget rather than taste: a Sanity image
 * URL carrying a `rect` is ~150 characters, so every candidate on every photograph is paid
 * in the document on every visit. Six rungs per photograph put a twelve-picture gallery at
 * ~12 KB of `srcset` text, which is a real draw on `BUDGET.bytes.html`; the measurement is
 * recorded there.
 *
 * So each ladder is written against **the boxes the layout can actually paint**, times the
 * device pixel ratios that exist, and the rung is the smallest file that covers the box.
 * The figure in brackets is the oversample the visitor pays.
 *
 * ## The grid: 1:1 tiles, 2 / 3 / 4 columns (§7.4)
 *
 * The boxes, from `Gallery.astro`'s own grid — a 1280px wrap, `--space-7` either side at
 * desktop, 8px gutters:
 *
 * | viewport | columns | box | 1× | 2× | 3× |
 * |---|---|---|---|---|---|
 * | 390 | 2 | 167 px | 167 | 334 | 501 |
 * | 1280+ | 4 | 290 px | 290 | 580 | — |
 *
 *   - `200w` ← 167 (1.20×)
 *   - `350w` ← 290 (1.21×) and 334 (1.05×) — the two commonest cases on the site
 *   - `600w` ← 501 (1.20×) and 580 (1.03×)
 *
 * Every box is covered within 1.21×, which is why there is no fourth rung: adding 450w
 * would improve nothing and cost ~1.8 KB of document on a twelve-picture page.
 *
 * **Nothing above 600w is offered for a tile, and that is the ticket's „do not ship a
 * full-resolution original to a phone" made structural**: the largest file the grid can
 * select is 2.07× the largest box it can paint, and a phone selects 200w or 350w.
 * `test/gallery.test.ts` measures `img.currentSrc` in a real browser at 390 and at 1280 and
 * compares the selected width against the painted one — the only way to check a `sizes`
 * expression, because a model of the selection algorithm passes whenever the model is
 * wrong (`test/fonts.test.ts`'s rule, and `test/numerals.test.ts`'s).
 */
export const GRID_WIDTHS: readonly number[] = [200, 350, 600];

/**
 * What the grid tells the browser a tile will be, matching `Gallery.astro`'s own CSS.
 *
 * The same three breakpoints as the grid's media queries, in the same order, and each value
 * is the box computed above expressed against the viewport — `(content − gutters) ÷
 * columns`, rounded **up** to the next whole percent so the browser never under-selects:
 * 46vw at 390–767 (42.2–46.3% measured), 30vw at 768–1023 (28.5–29.7%), 23vw at 1024–1279
 * (22.1–22.7%), and a fixed 290px once the wrap stops growing.
 *
 * A `sizes` that disagrees with the layout is the silent half of a responsive image: every
 * URL resolves, every picture renders, and the browser quietly picks the wrong file.
 */
export const GRID_SIZES =
  '(min-width: 1280px) 290px, (min-width: 1024px) 23vw, (min-width: 768px) 30vw, 46vw';

/**
 * ## The lightbox: up to 90vw by 85vh (§7.4)
 *
 * A photograph shown at its own ratio inside that box is at most 90vw wide, so the boxes
 * are 351 px (390 × 0.9) through 1152 px (1280 × 0.9):
 *
 *   - `700w` ← 702 (1.00×, a 2× phone — the commonest lightbox there is) and 351 (1.99×)
 *   - `1200w` ← 1053 (1.14×, a 3× phone) and 1152 (1.04×, a 1× desktop)
 *   - `2000w` ← 2304 (0.87×) and is the ceiling
 *
 * **2000 is the ceiling on purpose.** A 2× desktop would want 2304 and gets a photograph
 * that is 13% soft; a 3× phone on a 1440-wide viewport would want more still. That is a
 * better trade than putting a 4000px camera original on a mobile connection for an image
 * the visitor opened with one tap — Mina's uploads are 2–4 MB files, and the number that
 * decides what a visitor downloads has to be ours rather than her camera's.
 *
 * The 1.99× on a 1× phone is the one loose rung and it is deliberate: a fourth rung at
 * 400w would cost a twelfth of the document on every visit to spare the shrinking minority
 * of 1× handsets ~20 KB on a deliberate tap. Noted rather than hidden.
 */
export const FULL_WIDTHS: readonly number[] = [700, 1200, 2000];

/** 90vw, which is what §7.4 gives the lightbox and what `Gallery.astro` sets. */
export const FULL_SIZES = '90vw';

/**
 * **Interface chrome and the empty state.** Croatian first, because Croatian sets the
 * layout (§10).
 *
 * Every string is about the page or the site's own state. Nothing here is a claim about the
 * studio, and nothing here promises anything — see the note at the top of this file for why
 * „uskoro" is forbidden rather than merely avoided.
 */
export const GALLERY_COPY: Record<
  Locale,
  {
    eyebrow: string;
    heading: string;
    /** Rendered only when there are photographs to describe. */
    lede: string;
    /** The section heading over a populated grid. Not rendered when the grid is empty. */
    photographs: string;
    emptyHeading: string;
    emptyBody: string;
    toSchedule: string;
    toContact: string;
    /** The lightbox. */
    lightbox: string;
    open: string;
    close: string;
    previous: string;
    next: string;
  }
> = {
  hr: {
    eyebrow: 'U sali',
    heading: 'Galerija',
    lede: 'Ruke, kontakt, pokret. Odaberi fotografiju za povećani prikaz.',
    photographs: 'Fotografije',
    emptyHeading: 'Nema objavljenih fotografija.',
    emptyBody:
      'Studio nije fotografiran. Kako izgleda sat vidi se najbolje iz sale — ' +
      'raspored je tu, a pitanja su dobrodošla.',
    toSchedule: 'Raspored',
    toContact: 'Kontakt',
    lightbox: 'Povećani prikaz fotografije',
    open: 'Povećaj',
    close: 'Zatvori',
    previous: 'Prethodna',
    next: 'Sljedeća',
  },
  en: {
    eyebrow: 'In the room',
    heading: 'Gallery',
    lede: 'Hands, the connection point, movement. Select a photograph to enlarge it.',
    photographs: 'Photographs',
    emptyHeading: 'No photographs are published.',
    emptyBody:
      'The studio has not been photographed. What a class looks like is best seen in ' +
      'the room — the timetable is here, and questions are welcome.',
    toSchedule: 'Schedule',
    toContact: 'Contact',
    lightbox: 'Enlarged photograph',
    open: 'Enlarge',
    close: 'Close',
    previous: 'Previous',
    next: 'Next',
  },
};

/**
 * „3 / 12", for the lightbox counter (§7.4).
 *
 * A function rather than a template string in the component because the script has to
 * recompute it on every arrow press, and because the separator is a typographic decision
 * (a thin-spaced solidus) that should exist once. Digits are lining and tabular from the
 * document (`src/styles/base.css`), so the counter does not jump as the index crosses ten
 * — and the component must not redeclare `font-variant-numeric` to get that (MUSE-14).
 */
export function galleryPosition(index: number, total: number): string {
  return `${index + 1} / ${total}`;
}

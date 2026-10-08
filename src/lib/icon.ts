/**
 * **The icon-only mark, and the set of `<link rel="icon">` the layout emits** (MUSE-40).
 *
 * Until this ticket the site declared no icon of any kind, so every tab showed a generic
 * document glyph and every bare `/favicon.ico` probe reached GitHub Pages' own 404 page.
 *
 * ## The mark was never missing
 *
 * MUSE-40, MUSE-64 and design system §12 all recorded the icon-only mark as *"Missing"*,
 * and all three were wrong. §12 specifies that mark as **dancer + `M`**, and both are
 * already in `logo/muse-lockup-white-transparent.png`: they occupy the left of the
 * lockup, with „DANCE STUDIO / USE / BY MINA" set to the right of them — the flourished
 * `M` is doing double duty as both the mark and the first letter of „MUSE", which is why
 * the remaining type reads „USE" once the mark is lifted off it. The alpha channel has a
 * **clean 18-pixel empty column run** between the two halves, so the mark comes out with
 * a crop and nothing else.
 *
 * Measured off the supplied file rather than estimated, and `test/icon.test.ts`
 * re-measures all of it against the artwork so the numbers cannot quietly stop being
 * true:
 *
 * ```
 * canvas             1254 × 1254
 * ink bounding box   (179, 256) → (1034, 879)
 * empty column runs  x 640–657   (18px)   ← dancer + M | wordmark
 *                    x 808–813    (6px)   ← inside the wordmark
 *                    x 936–938    (3px)   ← inside the wordmark
 * crop               (179, 256) → (640, 878)
 * icon ink           461 × 622, which is the full crop — nothing clipped, nothing added
 * ```
 *
 * **It is the studio's own artwork.** Nothing here was drawn, traced or improved, which
 * is the bar MUSE-36 set after thirteen invented classes and two invented instructors
 * shipped. What *is* an intervention is the stroke weight — see below — and it is the one
 * judgement in this file.
 *
 * ## Why a stroke-thickened variant exists at all
 *
 * At 180px and up the plain crop is excellent. At 32px and below it is not: the `M` is a
 * fine script and the dancer is thinner still, and once a stroke falls under about one
 * device pixel there is nothing left for the rasteriser to antialias. The mark washes out
 * to a faint smudge that reads as a rendering fault rather than as a logo.
 *
 * So the small sizes are dilated before they are downsampled. This is ordinary **optical
 * sizing** — the same reason no typeface ships one master for 8pt and 72pt, and the
 * reason nobody ships one icon file for 512px and 16px. It is a mild intervention on
 * existing artwork rather than new artwork, but it *is* an intervention, so the amount is
 * a named constant with its measurement beside it rather than a number baked into a PNG
 * nobody can account for.
 */

import plum16 from '../assets/icon/muse-icon-plum-16.png?url&no-inline';
import plum32 from '../assets/icon/muse-icon-plum-32.png?url&no-inline';
import white16 from '../assets/icon/muse-icon-white-16.png?url&no-inline';
import white32 from '../assets/icon/muse-icon-white-32.png?url&no-inline';
import appleTouch from '../assets/icon/muse-apple-touch.png?url&no-inline';

/** The supplied lockup every icon here is cropped out of. */
export const ICON_SOURCE = 'logo/muse-lockup-white-transparent.png';

/**
 * The crop that lifts the dancer + `M` out of the lockup: left, top, right, bottom.
 *
 * The right edge sits at 640 because the alpha channel is empty from 640 to 657. Column
 * 639 is the last with any ink at all and carries a single pixel of alpha 2 — invisible,
 * and kept rather than trimmed, because the edge of the crop is then the artwork's own
 * edge and not a threshold somebody chose.
 */
export const ICON_CROP = { left: 179, top: 256, right: 640, bottom: 878 } as const;

/** The cropped mark's ink size — the whole crop, by construction. */
export const ICON_INK = { width: 461, height: 622 } as const;

/**
 * **How much stroke weight the small sizes are given, in target pixels per side.**
 *
 * The mark's alpha channel is dilated by a disc of radius `STROKE_GAIN ÷ scale` source
 * pixels before it is resampled, so a stroke gains the same *rendered* weight at every
 * size — 19px of dilation at 16, 10px at 32 — rather than the same source weight, which
 * would be invisible at one size and a blob at the other.
 *
 * 0.5 was chosen by rendering 0.4, 0.5 and 0.6 at 16 and 32 against real browser-chrome
 * greys, light and dark, and looking at them at true size. At 0.4 the 16px mark is still
 * wispy; at 0.6 the `M`'s counter starts to close and the dancer merges into its right
 * stem. 0.5 is legible at 16 and still recognisably the script face at 32.
 *
 * The property this encodes — that the small icons carry materially more ink than the
 * plain crop would — is asserted in `test/icon.test.ts` against the committed files,
 * because a regenerated-without-the-dilation icon is a change nothing else would notice:
 * it is the right mark at the right size in the right colour, and it is a smudge.
 */
export const STROKE_GAIN = 0.5;

/** The ink the dilated tab icons actually carry, as mean alpha over the square. */
export const MEASURED_MEAN_ALPHA = { 16: 0.296, 32: 0.198 } as const;

/**
 * How much more ink a shipped tab icon must carry than the plain crop would.
 *
 * Resampling preserves a mean, so the mean alpha of an undilated icon is just the mean
 * alpha of the artwork itself, scaled by how much of the square the portrait mark covers
 * — about 0.059 at both sizes, and `test/icon.test.ts` computes it off the artwork
 * instead of trusting that sentence. The shipped files measure 5.0× that at 16 and 3.4×
 * at 32, so a floor of 2× separates "thickened for the size" from "resampled straight
 * down" with room on both sides and no number anybody has to re-type.
 */
export const MIN_STROKE_RATIO = 2;

/**
 * The apple-touch tile's content inset, as a fraction of the tile on each side.
 *
 * iOS masks the tile to a rounded rectangle and draws it against whatever the home
 * screen is, so unlike the tab icons this one is **opaque** — a transparent
 * apple-touch-icon is composited on black by older iOS and on an unpredictable ground by
 * current iOS. Opaque plum with the white mark is the §12-correct pairing and takes the
 * decision away from the operating system.
 */
export const APPLE_TOUCH_INSET = 0.14;

/** Where the derived icon files live, relative to the repository root. */
export const ICON_DIR = 'src/assets/icon';

/** One `<link rel="icon">` or `<link rel="apple-touch-icon">` the layout emits. */
export interface IconLink {
  rel: 'icon' | 'apple-touch-icon';
  /**
   * The file's name inside `ICON_DIR`.
   *
   * Carried beside `href` rather than derived from it: `href` is whatever Vite emits —
   * a content-hashed path in a build, an unhashed dev one under `astro dev` — so it is
   * the wrong thing to read a filename off. `test/icon.test.ts` opens the artwork
   * through this and matches it to the built URL by stem.
   */
  file: string;
  href: string;
  /** `sizes`, which `test/icon.test.ts` checks against the file's actual dimensions. */
  sizes: string;
  /** The colour scheme this file is drawn for, or `undefined` for a scheme-less icon. */
  media?: string;
}

/**
 * **Every icon the site declares, in document order.**
 *
 * A registry rather than five tags written out in the layout, so that "the page declares
 * what this file says it declares" is a thing a test can assert in both directions —
 * nothing missing, and nothing extra that slipped in beside it.
 *
 * ## Both schemes, and why each has an explicit `media`
 *
 * The supplied artwork is **white**, including the file called "no background", which is
 * white on transparency rather than a dark mark. A white icon is invisible on a light tab
 * strip, and the plum one is very nearly invisible on a dark one — so a single file
 * cannot serve both, and design system §11 makes both themes a hard requirement
 * everywhere else on the site. The plum variant is derived the way §12 derived the plum
 * lockup: RGB replaced, **alpha preserved**, so the antialiased edges still blend. The
 * two variants therefore have byte-identical alpha channels, which is an assertion in
 * `test/icon.test.ts` rather than a claim here.
 *
 * Both schemes carry an explicit, mutually exclusive `media`, rather than one of them
 * being a scheme-less default. That is deliberate and it is a trade:
 *
 *   - **Mutually exclusive**, exactly one candidate matches per scheme, so which icon a
 *     browser picks does not depend on how it breaks a tie between two matching links.
 *     With a scheme-less default plus a dark override, *both* match in dark mode and the
 *     answer is whatever that browser's tie-break happens to be.
 *   - The cost is a browser that does not implement `media` on an icon link at all: it
 *     sees every candidate match and takes the last, which is the white one, which is
 *     invisible on a light tab strip. That is Chrome before 80 and equivalents — long
 *     past the floor anything else here is written against, and the failure is a tab with
 *     no visible icon, which is what the whole site had before this ticket.
 *
 * Note that the icon tags are **not** gated on `indexable`: unlike the canonical and the
 * JSON-LD block, an icon is not a claim about a URL, and the error page gets a tab icon
 * for the same reason it gets a theme colour.
 */
export const ICONS: readonly IconLink[] = [
  {
    rel: 'icon',
    file: 'muse-icon-plum-16.png',
    href: plum16,
    sizes: '16x16',
    media: '(prefers-color-scheme: light)',
  },
  {
    rel: 'icon',
    file: 'muse-icon-plum-32.png',
    href: plum32,
    sizes: '32x32',
    media: '(prefers-color-scheme: light)',
  },
  {
    rel: 'icon',
    file: 'muse-icon-white-16.png',
    href: white16,
    sizes: '16x16',
    media: '(prefers-color-scheme: dark)',
  },
  {
    rel: 'icon',
    file: 'muse-icon-white-32.png',
    href: white32,
    sizes: '32x32',
    media: '(prefers-color-scheme: dark)',
  },
  { rel: 'apple-touch-icon', file: 'muse-apple-touch.png', href: appleTouch, sizes: '180x180' },
];

/** The ink colour each tab icon is drawn in — §12's white mark and its plum derivation. */
export const ICON_COLOURS = { plum: '#420535', white: '#ffffff' } as const;

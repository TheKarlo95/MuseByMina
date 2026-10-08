/**
 * **The brand lockup's geometry, measured off the supplied artwork** (MUSE-64).
 *
 * Design system §12 states two rules about reproducing the lockup — a minimum size and a
 * clear space — and both are expressed in terms of the artwork itself rather than in
 * pixels a component can hard-code. The clear space is *"minimum equal to the cap height
 * of 'MUSE' on all four sides"*, which is a fraction of however large the lockup is
 * drawn. So the fraction lives here, once, and `Lockup.astro` derives the margin from the
 * width it was given. A component that writes its own clear-space number is a component
 * that is wrong at every size but one.
 *
 * Every constant below was measured from `logo/muse-lockup-white-transparent.png` with
 * the fully-transparent border trimmed off — see `logo/README.md` for the trim, which is
 * the only thing done to the supplied file and is lossless.
 */

/**
 * The ink's aspect ratio: 855 × 622 after trimming.
 *
 * The supplied file is a 1254 × 1254 square whose ink occupies 855 × 622 at offset
 * (179, 256) — about half the canvas is transparent padding. That padding is close to,
 * but not exactly, §12's clear space (it is 179px on the left where the cap height is
 * 205px), so it cannot be used *as* the clear space: a component laying the square out
 * would be short on one side and generous on the other, with the lockup off-centre in
 * its own box. The trim removes it and `CAP_HEIGHT_RATIO` puts it back symmetrically.
 */
export const LOCKUP_ASPECT = 855 / 622;

/**
 * The cap height of "MUSE" as a fraction of the lockup's full height.
 *
 * Measured off the artwork: the capitals of U, S and E all run 201–205px within the
 * trimmed 622px height, so 205/622 ≈ 0.330. The "M" is the dancer glyph and is taller;
 * §12 says "the cap height of 'MUSE'", and the letterforms are what sets a cap height.
 */
export const LOCKUP_CAP_HEIGHT_RATIO = 205 / 622;

/**
 * **§12's minimum reproduction size: 100px wide.**
 *
 * This is a legibility floor, not a preference, and it was verified rather than assumed:
 * rendered at 100px the two small lines — "DANCE STUDIO" above and "BY MINA" below — are
 * at the edge of readable, and by 66px they are grey smears. The lockup carries three
 * type sizes inside one image, and the smallest is what sets the floor.
 *
 * `lockupClearSpace` throws below it rather than clamping, because a lockup quietly
 * drawn at 55px is the failure this number exists to prevent and a clamp would hide it.
 */
export const LOCKUP_MIN_WIDTH = 100;

/**
 * §12's clear space for a lockup drawn `width` CSS pixels wide, in CSS pixels.
 *
 * Throws below the minimum size: both §12 rules are about one reproduction, and a caller
 * asking for clear space around an illegible lockup has already made the mistake.
 */
export function lockupClearSpace(width: number): number {
  if (!Number.isFinite(width) || width < LOCKUP_MIN_WIDTH) {
    throw new Error(
      `The brand lockup may not be drawn ${width}px wide. Design system §12 sets a ` +
        `minimum of ${LOCKUP_MIN_WIDTH}px for the lockup — below it "DANCE STUDIO" and ` +
        `"BY MINA" stop being legible. Use the icon-only mark where there is less room ` +
        `than that, once it exists (MUSE-40).`,
    );
  }
  return Math.round((width / LOCKUP_ASPECT) * LOCKUP_CAP_HEIGHT_RATIO);
}

/**
 * The height, in CSS pixels, of a lockup drawn `width` wide — rounded the way a browser
 * lays it out, so a caller can reserve the box and a test can state what fits in a band.
 */
export function lockupHeight(width: number): number {
  return Math.round(width / LOCKUP_ASPECT);
}

/**
 * **The one size the build emits, in device pixels.**
 *
 * 320px wide, as a single file with no `srcset`, serving the footer's 160 CSS px at 2×.
 *
 * A `densities={[1, 2]}` srcset would save about 7 KB on a 1× display, and it is
 * deliberately not used. The budget (`scripts/budget.mjs`) measures what a browser
 * fetches, and Playwright runs at `deviceScaleFactor: 1` — so a srcset would have the
 * gate measure the 160px file while almost every real visitor downloads the 320px one,
 * and the recorded image budget would be a number no phone ever pays. One file means the
 * measurement and the visitor agree. At 11.1 KB the simplicity is worth more than the
 * saving; revisit if a page ever carries photography, where the ratio reverses.
 */
export const LOCKUP_EMITTED_WIDTH = 320;

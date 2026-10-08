# Logo assets

| File | Mark | Ground | Use on |
|---|---|---|---|
| `muse-lockup-white-on-plum.*` | White | Opaque plum `#420535` | — (reference) |
| `muse-lockup-white-transparent.*` | White | Transparent | Any dark surface |

## Two things that trip people up

**Both files are the *white* lockup.** "No background" means transparent, not a dark
mark — so neither can be used on the cream light theme as supplied. The design system
derived a plum version by replacing RGB and preserving alpha; that lives at
`../../MuseByMina2/docs/design-system/assets/muse-logo-plum.png` and is a **bitmap
stopgap, not a vector redraw**.

**The `.svg` files are not vectors.** Each is a base64 PNG embedded as an `<image>`
inside a mask, carried by a transform matrix with ~5.5° of skew. They will not scale past
their raster resolution, cannot be recoloured with `fill` or `currentColor`, and weigh
~85 KB for a logo.

## What the site ships, and what it does not (MUSE-64)

`src/assets/muse-lockup-white.png` is the **only** copy of this artwork the build can
see. It is `muse-lockup-white-transparent.png` with its fully-transparent border trimmed
off — 1254 × 1254 down to **855 × 622**, which is the ink — and nothing else: no resample,
no recolour, no redraw. About half the supplied canvas is padding, and a component laying
the square out would draw the lockup at 68% of the size it asked for, off-centre in its
own box. `src/components/Lockup.astro` is the only thing that imports it; Astro emits one
320px WebP, **11.1 KB**, and `scripts/budget.mjs` budgets it.

`logo/` stays the source directory. Nothing under it is served, imported or referenced by
the site, and the four files here remain exactly as supplied so the trim can be redone
from the original if the artwork is ever replaced.

### Where it appears, and where it cannot

**The footer carries the lockup. The masthead carries the icon-only mark**, and the
reason is arithmetic rather than preference. This is the question somebody asks again
every year, so here is the whole of the answer:

| | Lockup | Icon-only mark |
|---|---|---|
| Artwork, trimmed to its ink | 855 × 622 = **1.372 : 1** | 461 × 622 = **0.741 : 1** |
| §12 minimum reproduction size | **100px wide** | **24px wide** |
| …which is | **73px tall** | 32px tall |
| §12 clear space there (cap height of "MUSE") | **24px** per side | 11px per side |
| So the smallest §12-legal envelope is | **121px tall** | 54px tall |
| Header band (§7.1) | **64px** mobile / 80px desktop | same |
| Fits? | **No — neither band** | **Yes — both** |

73 does not fit in 64 with the clear space and does not fit in 64 *without* it, and 121
does not fit the 80px desktop band either — so the lockup is out of the masthead at every
width, not merely on phones. The size that *would* fit the mobile band is 55px wide, a
little over half the minimum, and at that size "DANCE STUDIO" and "BY MINA" are grey
smears rather than words, which is exactly what the minimum exists to refuse.

**§12 names the fix in its own variants table: the icon-only mark, listed for the
*compact mobile header*.** MUSE-40 shipped that mark; MUSE-67 put it in the band and
deleted the exemption the typeset wordmark had been living under.

#### What the masthead actually draws

| | |
|---|---|
| Height | **36px**, one size in both bands |
| Width that follows | 27px — §12's floor is 24 |
| §12 clear space (cap height of "MUSE" at that scale) | **12px** on all four sides |
| Envelope | **60px**, inside a 64px band with 4px to spare |
| Variant | **White, both themes** — the band is `--surface-deep` |
| Emitted | one 53 × 72 WebP, **1,658 bytes**, 2× for a retina display |

36 rather than the 38 that would exactly fill the band: the four pixels are worth more as
slack than as mark, since a border or a padding change should not be able to make the
clear space quietly false. It is also what the typeset wordmark it replaces occupied —
26px of Cormorant over a 9px label, about 37px of ink — so the masthead's optical weight
did not change when the artwork did. One size in both bands because a second size is a
second dilation radius (below) and therefore a second file, and the wordmark did not
change size between the bands either.

The clear-space fraction is the lockup's, and that is not an approximation: the crop runs
the full height of the lockup's ink (256 → 878 is all 622 of it), so a mark drawn 36px
tall *is* the lockup drawn 36px tall with the type cropped off. `iconClearSpace` in
`src/lib/icon.ts` imports `LOCKUP_CAP_HEIGHT_RATIO` rather than restating it, and refuses
to answer below §12's minimum rather than clamping.

## The icon-only mark was never missing (MUSE-40)

This file, design system §12 and two tickets all recorded the icon-only mark as
**missing**, and all of them were wrong. §12 specifies it as *dancer + `M`*, and both
are already in `muse-lockup-white-transparent.png`: they sit to the left of the type,
and the flourished `M` is doing double duty as the mark *and* as the first letter of
„MUSE", which is why the wordmark beside it reads „DANCE STUDIO / USE / BY MINA".

There is a **clean 18-pixel run of fully transparent columns** between the two halves,
so the mark comes out with a crop and nothing else. **No part of this is drawn, traced
or redrawn** — the same bar `muse-lockup-white.png` is held to above.

### The derivation, exactly — do not re-derive it differently

```
source        muse-lockup-white-transparent.png   1254 × 1254 RGBA
ink bbox      (179, 256) → (1034, 879)
empty cols    x 640–657  (18px)  ← dancer + M | wordmark
crop          (179, 256) → (640, 878)  =  461 × 622, which is all ink on all four edges
```

Then, per output file:

| File (`src/assets/icon/`) | From | Size | Ink |
|---|---|---|---|
| `muse-icon-plum-16.png` | crop, alpha dilated by a disc of r=19, resized to fit the square's height, RGB set to plum | 16 × 16 | `#420535` |
| `muse-icon-plum-32.png` | same, r=10 | 32 × 32 | `#420535` |
| `muse-icon-white-16.png` | same alpha as the plum 16, RGB set to white | 16 × 16 | `#FFFFFF` |
| `muse-icon-white-32.png` | same alpha as the plum 32, RGB set to white | 32 × 32 | `#FFFFFF` |
| `muse-apple-touch.png` | crop, **no dilation**, white, inset 14% on a plum ground, 64-colour palette | 180 × 180 | opaque |
| `muse-mark-white.png` | crop, alpha dilated by a disc of r=5, white — **no resample** (MUSE-67) | 461 × 622 | `#FFFFFF` |

Three things in that table are decisions rather than settings:

**The dilation.** The `M` is a fine script and the dancer is thinner still, so at 32px
and below the strokes fall under a device pixel and antialias away to a smudge. The
small sizes are therefore stroke-thickened before they are resampled — ordinary optical
sizing. The radius is not a fixed number: it is `0.5 ÷ scale`, so every size gains the
same *rendered* half-pixel per side. `STROKE_GAIN` in `src/lib/icon.ts` is that 0.5, and
`test/icon.test.ts` measures the committed files against what an undilated crop would
have produced, so regenerating one without it is a red test rather than a quiet smudge.

`muse-mark-white.png` is the same intervention at the masthead's size and is otherwise
the plain crop — it is kept at the crop's own 461 × 622 because Astro emits the WebP from
it, so the only thing done to the artwork here is the thickening. Its gain is **0.3 CSS
pixels per side**, not 0.5: 36px is twice the tab icon's worst case, and the amount was
chosen by rendering 0, 0.25, 0.3, 0.35 and 0.45 at 1×, 2× and 3× on `--surface-deep` and
looking at them — below 0.3 the 1× mark is still washed, and by 0.35 the dancer's head
and raised arm begin to merge at 2×, which is the detail the mark is for. The unit is CSS
pixels rather than device pixels because one file serves every display, and optical
sizing is about how large the mark is *drawn*. `test/lockup.test.ts` re-measures the
committed file against the supplied lockup every run: it must cover every pixel of the
crop's ink, add none further than r from it, and carry at least 1.6× the crop's ink.

**Two colour variants with identical alpha.** The supplied artwork is white only, which
is invisible on a light tab strip; the plum variant replaces RGB and preserves alpha,
which is how §12 derived the plum lockup and is lossless here because every ink pixel in
the source is pure white. The two variants' alpha channels are byte-identical and a test
says so — that is what keeps them the same mark rather than two similar ones.

**The iOS tile is opaque.** iOS draws an apple-touch-icon on the home screen and
composites a transparent one unpredictably, so it brings its own plum ground.

### Still missing

- A true vector redraw — also unlocks the dancer silhouette as a watermark motif, and is
  the only thing that would let the mark be recoloured with `currentColor`. The icons
  above are rasters cropped from a raster, which is fine at every size a favicon, avatar
  or masthead needs and is not a vector. It would also retire the dilation: a stroked
  vector can simply be drawn heavier at a small size.
- A **social share image** (`og:image`). Not this — `siteSettings.shareImage` is a field
  in Sanity and a 1200 × 630 composition, which a square icon is not.

## Rules

The variant follows the **surface**, not the theme. Header and footer are `--surface-deep`
— plum-ink in *both* themes — so they carry the white lockup even on a light page. Only a
logo on `--surface` swaps with the theme.

Clear space: the cap height of "MUSE" on all four sides. Minimum width 100px for the
lockup, 24px for the icon. Never recolour it in CSS, rotate it, stretch it, or place it
over busy imagery without a scrim.

The tab icons are the one deliberate exception to the clear-space rule, and only to it:
a favicon is drawn in a 16 or 32 pixel box that the browser already pads, so the mark
fills its square's height. §12's 24px minimum is about a mark placed *on a page* — which
is what the masthead is, and it observes both rules.

Full guidance: `../../MuseByMina2/docs/design-system/muse-design-system.md` §12.

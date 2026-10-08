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

**The footer carries it. The masthead does not**, and the reason is arithmetic rather
than preference:

| | |
|---|---|
| §12 minimum reproduction size | **100px wide** |
| Artwork aspect, trimmed | 855 : 622 = **1.372 : 1** |
| So the smallest legible lockup is | **73px tall** |
| §12 clear space at that size (cap height of "MUSE") | **24px** on all four sides |
| Header band (§7.1) | **64px** mobile / 80px desktop |

73 does not fit in 64 with the clear space and does not fit in 64 without it. The size
that *would* fit the mobile band is 55px wide — a little over half the minimum — and at
that size "DANCE STUDIO" and "BY MINA" are grey smears rather than words, which is what
the minimum exists to refuse. The masthead therefore still sets the brand in live type,
which §12 forbids by name; it is registered as a single exemption in
`test/lockup.test.ts` and explained in `src/components/Header.astro`.

**§12 already names the fix and it is in the next section:** the icon-only mark is listed
as the variant for the *compact mobile header*, and it is missing. That is MUSE-40.

## Still missing

- A true vector redraw — also unlocks the dancer silhouette as a watermark motif
- An **icon-only mark** (dancer + `M`), needed for the favicon, social avatar and the
  compact mobile header

## Rules

The variant follows the **surface**, not the theme. Header and footer are `--surface-deep`
— plum-ink in *both* themes — so they carry the white lockup even on a light page. Only a
logo on `--surface` swaps with the theme.

Clear space: the cap height of "MUSE" on all four sides. Minimum width 100px for the
lockup, 24px for the icon once it exists. Never recolour it in CSS, rotate it, stretch it,
or place it over busy imagery without a scrim.

Full guidance: `../../MuseByMina2/docs/design-system/muse-design-system.md` §12.

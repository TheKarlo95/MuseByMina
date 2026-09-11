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

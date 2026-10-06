# Muse by Mina

Website for Muse by Mina — an adult bachata studio in Zagreb, Ilica 209.
Croatian is the primary language; English follows.

**Status:** foundation. Theme, layout, navigation and the homepage are built and verified.
Remaining pages, the CMS and the delivery pipeline are not yet wired up.

## Stack

| Layer | Choice |
|---|---|
| Framework | Astro 7, static output, TypeScript strict |
| Styling | Plain CSS — design tokens + scoped component styles. **No Tailwind.** |
| i18n | Astro i18n; HR at `/`, EN at `/en` |
| Hosting | GitHub Pages via Actions |
| CMS | Sanity — *not yet wired* |
| Video | Cloudflare R2 — *not yet wired* |

Astro rather than a React framework because this is a content site: the build ships
**zero JavaScript files**: the theme switch, language switch and nav are small enough that
Astro inlines them.

## Commands

```bash
npm run dev        # http://localhost:4321/MuseByMina
npm run build
npm run typecheck  # astro check
npm run ds         # design-system compliance
npm run a11y       # axe on every page, both themes (needs a server running)
npm run shots      # screenshots of all theme states → /tmp/muse-shots
```

## The design system

The brand lives in a sibling repo: `../MuseByMina2`, where
`docs/design-system/muse-design-system.md` is **authoritative**. We ported its theme —
palette, role tokens, typography, spacing, fonts — rather than consuming its component
package. Read it before building any UI.

Rules that are load-bearing rather than stylistic:

- **Components reference a role token, never a brand colour.** Gold on cream is 2.02:1 and
  fails every threshold, which is why `--accent` exists: it *is* gold in dark and gold-deep
  in light. `npm run ds` fails the build on a violation.
- **Cormorant never below 26px.** Below ~24px its `đ` crossbar disappears and the studio's
  main call to action, *Dođi na probni sat*, renders as "Dodi".
- **No drop shadows, in either theme.** Depth comes from surface value and hairlines.
- Per-theme alpha values differ **on purpose** — `.56` passes on plum but fails AA on cream.

### The chrome band

Header and footer sit on `--surface-deep`, which is plum-ink in *both* themes, so their
contents must not follow the page theme. That band is named as its own role set
(`--band-surface`, `--band-text`, `--band-accent`, …) so chrome components still reference
a role rather than reaching for `--gold` directly.

## Layout

```
src/
  components/   UI, one file each, styles co-located
  layouts/      BaseLayout — head, theme script, header/footer
  lib/          theme.ts (pre-paint script), i18n.ts, lang.ts, nav.ts
  pages/        index.astro + en/index.astro; thin wrappers over components
  styles/       globals.css → fonts.css + tokens.css + base.css
public/fonts/   6 variable woff2, latin + latin-ext for Croatian
scripts/        a11y, design-system and screenshot gates
```

## Theme and language

Four theme states, all verified: no preference → dark (brand default); OS light → light;
OS dark → dark; an explicit choice wins in both directions. The theme is stamped on `<html>`
by a **blocking inline script in `<head>`** — without it, a viewer who chose light loads the
dark page and watches it flip.

Language defaults from the browser's `Accept-Language`, decided client-side since static
hosting has no edge compute. The redirect is deliberately narrow: homepage only, never if a
choice is stored, and via `replaceState` so Back isn't trapped.

## Deploying

CI builds for the GitHub Pages project path. Once `muse.dance` is registered, change the
env in `.github/workflows/deploy.yml` to `SITE=https://muse.dance` and `BASE=/`, and add a
`CNAME`. Nothing in the code needs to change.

Pages caps a published site at **1 GB**; CI fails above 900 MB. Media belongs on the Sanity
CDN and R2, never in the repo.

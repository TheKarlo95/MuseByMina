# Muse by Mina

Website for Muse by Mina — an adult bachata studio in Zagreb.
Croatian is the primary language; English follows.

## Status

Foundation only. The theme layer is ported and verified; no real pages or CMS yet.

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router), React 19, TypeScript strict |
| Styling | Plain CSS — design tokens + CSS Modules. **No Tailwind.** |
| CMS | Payload 3 at `/admin` — *not yet installed* |
| Database | Postgres on Neon (EU) — *not yet provisioned* |
| Media | Cloudflare R2 via `@payloadcms/storage-s3` — *not yet configured* |
| Hosting | Vercel — *not yet deployed* |

**Payload was chosen over Sanity for two reasons:** it ships a Croatian admin UI
(`@payloadcms/translations/languages/hr`), and its field-level `localized: true`
keeps HR and EN on the *same* document — which is what lets the language switcher
stay on the equivalent page instead of bouncing to the homepage.

## The design system

The brand lives in a sibling repo, `../MuseByMina2`, and
`docs/design-system/muse-design-system.md` there is **authoritative**. Read it before
building any component. We ported the theme, not the component package.

Key rules it encodes, all of which are load-bearing:

- **Components reference a role token, never a brand colour.** Writing
  `color: var(--gold)` is the bug — gold on cream is 2.02:1 and fails every threshold.
- **No drop shadows, in either theme.** Depth comes from surface value and hairlines.
- **Cormorant never goes below 26px.** Below ~24px its `đ` crossbar disappears, turning
  *Dođi na probni sat* into "Dodi".
- Croatian runs 20–25% longer than English, so never fix a button's width.

### What we changed on the way in

The design system shipped Cormorant as two `@font-face` blocks, weights 400 and 600,
pointing at **byte-identical files**. All three families are actually variable fonts
(Cormorant's `wght` axis spans 300–700), so each subset is now declared once with a
weight *range* — real 600 works, and two redundant files are gone.

## Layout

```
src/
  app/            routes; layout.tsx carries the pre-paint theme script
  components/     UI, one folder per component + co-located CSS Module
  lib/            theme.ts (init script), useTheme.ts (store)
  styles/         globals.css → fonts.css + tokens.css + base.css
public/fonts/     6 variable woff2, latin + latin-ext for Croatian
```

`src/styles/tokens.css` is a near-verbatim port of the design system's §1–2. Its alpha
values differ between themes **on purpose** — `.56` gives 5.19:1 on plum but only 3.97:1
on cream, which fails AA. Do not "simplify" them to match.

## Commands

```bash
npm run dev        # dev server
npm run build      # production build
npm run typecheck  # tsc --noEmit
npm run lint
npm run a11y       # axe, both themes — needs the dev server running
npm run shots      # screenshot all four theme states to /tmp/muse-shots
```

## Theme behaviour

Four states, all verified:

| Viewer state | Result |
|---|---|
| No preference | Dark (brand default, on bare `:root`) |
| OS light | Light |
| OS dark | Dark |
| Explicit choice | Wins over the OS, in both directions |

The theme is stamped on `<html>` by a **blocking inline script in `<head>`**
(`src/lib/theme.ts`) before first paint. Without it, a viewer who chose light loads the
dark plum page and watches it flip. `useTheme` only governs later changes.

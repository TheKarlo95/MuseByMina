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
| i18n | Astro i18n; HR at `/`, EN at `/en/` |
| Hosting | GitHub Pages via Actions |
| CMS | Sanity — *not yet wired* |
| Video | Cloudflare R2 — *not yet wired* |

Astro rather than a React framework because this is a content site: the build ships
**zero JavaScript files**: the theme switch, language switch and nav are small enough that
Astro inlines them.

## Commands

```bash
npm run dev        # http://localhost:4321/MuseByMina/
npm run build
npm run typecheck  # astro check
npm test           # vitest — asserts on real build output
npm run ds         # design-system compliance
npm run a11y       # axe on every page, both themes (needs a server running)
npm run shots      # screenshots of all theme states → /tmp/muse-shots
npm run ux:schedule  # /schedule: responsive shift, keyboard, filters (needs a server)
```

All three browser gates take `ORIGIN`/`BASE` from the environment. `a11y` also takes
`ROUTES` and `shots` takes `ROUTE`/`OUT`, so either can be pointed at one page:

```bash
ROUTES=/,/en,/schedule,/en/schedule npm run a11y
ROUTE=/schedule OUT=/tmp/muse-shots/schedule npm run shots   # reports h-overflow at 390px
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
  data/         hardcoded content waiting on the CMS — schedule.ts today.
                Marked as placeholder; components take it as a prop with this
                as the default, so the Sanity swap is a prop change
  layouts/      BaseLayout — head, theme script, header/footer
  lib/          theme.ts (pre-paint script), i18n.ts, lang.ts, nav.ts,
                pages.ts (per-route title + description), site.ts (deploy-root URLs),
                schedule.ts (class model, locale wording, Croatian pluralisation)
                forms.ts (trial-form fields, endpoint and HR/EN copy)
  pages/        thin wrappers over components, one per locale
                robots.txt.ts + llms.txt.ts; generated, not static
  styles/       globals.css → fonts.css + tokens.css + base.css
public/fonts/   6 variable woff2, latin + latin-ext for Croatian
scripts/        a11y, design-system, screenshot and schedule-UX gates
test/           vitest; builds the site and asserts on dist
```

## Theme and language

Four theme states, all verified: no preference → dark (brand default); OS light → light;
OS dark → dark; an explicit choice wins in both directions. The theme is stamped on `<html>`
by a **blocking inline script in `<head>`** — without it, a viewer who chose light loads the
dark page and watches it flip.

Language defaults from the browser's `Accept-Language`, decided client-side since static
hosting has no edge compute. The redirect is deliberately narrow: homepage only, never if a
choice is stored, and via `replaceState` so Back isn't trapped.

## Machine-readable surface

Three files are generated at build time, never checked in, because every URL in them is
absolute and the origin comes from `SITE`/`BASE`:

| File | Source |
|---|---|
| `sitemap-index.xml` + `sitemap-0.xml` | `@astrojs/sitemap`, fed the i18n config so every entry carries `hreflang` alternates |
| `robots.txt` | `src/pages/robots.txt.ts` |
| `llms.txt` | `src/pages/llms.txt.ts`, listing each page with its own `<meta description>` |

`llms.txt` descriptions come from `src/lib/pages.ts`, which is also what the pages render, so
the index cannot drift from the site — and `test/seo.test.ts` enforces that rather than
assuming it, comparing every `llms.txt` description against the `<meta name="description">`
parsed out of that route's built HTML.

**Add a page → add it there.** Forgetting is not a build error: `astro build` exits 0 and
silently omits the page from both the index and the sitemap. `npm test` is what fails — it
derives the expected page list from `src/pages/`, not from the registry.

One caveat worth knowing: on the GitHub Pages project URL these land at
`/MuseByMina/robots.txt`, not the origin root, so crawlers will not find `robots.txt` until
the custom domain is live and `BASE=/`. Project Pages cannot serve the origin root at all —
this is not something the build can fix.

## The trial-class form

`src/components/TrialForm.astro` is the site's one conversion path. It renders in two
places — the homepage `#trial` band and `/contact/` — from a single component, so the two
cannot drift apart. Field list and copy live in `src/lib/forms.ts`.

There is no backend, so submissions go to **Formspark** (`submit-form.com`), chosen because
it keeps submission data inside the EEA — Ireland and Germany — and its DPA is part of the
terms rather than a paid add-on. Spam is handled by a `_gotcha` honeypot plus Formspark's
own filtering: no CAPTCHA script, no third-party request on page load, and therefore no
cookie banner.

```bash
PUBLIC_FORM_ENDPOINT=https://submit-form.com/<form-id> npm run build
```

The form id ships inside every page, so it is configuration rather than a secret — hence the
`PUBLIC_` prefix, and hence nothing to keep out of the repo. **It is not set by default.**
Unset, the form still renders, still validates and is still completable by keyboard;
submitting reports that it could not be delivered and offers the studio inbox instead. CI and
`npm test` build without it on purpose.

`/privacy/` is the notice the form links to. It is footer-only and deliberately absent from
the nav: it exists because the form collects a name, an email address and a phone number,
which is personal data under the GDPR whether or not this site stores any of it.

## Deploying

CI builds for the GitHub Pages project path. Once `muse.dance` is registered, change the
env in `.github/workflows/deploy.yml` to `SITE=https://muse.dance` and `BASE=/`, and add a
`CNAME`. Nothing in the code needs to change.

Pages caps a published site at **1 GB**; CI fails above 900 MB. Media belongs on the Sanity
CDN and R2, never in the repo.

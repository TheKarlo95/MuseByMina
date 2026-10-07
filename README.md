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
| CMS | Sanity — schemas and read path wired; **no page reads it yet** (MUSE-20) |
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

npm run sanity:types   # re-extract the schema + regenerate types — commit the result
npm run sanity:check   # the fast staleness gate that `npm run build` runs first
npm run sanity:read    # every query against the live dataset: OK / EMPTY / BROKEN
npm run sanity:dev     # the Studio locally, http://localhost:3333
npm run sanity:build   # bundle the Studio into .sanity/studio — what CI runs
npm run sanity:deploy  # push the Studio to musebymina.sanity.studio
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
  assets/fonts/ 6 variable woff2, latin + latin-ext for Croatian. In `src/`, not
                `public/`: both the `@font-face` src and the preload resolve through
                Vite, so they are one URL in dev and in the build (MUSE-35)
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

Three signals can pick a language, in this order: **`?lang=` beats a stored `muse-lang`
beats the browser.** The parameter is explicit, it is attached to this request, and it is
how a link gets shared in a particular language, so it overrides — and replaces — a choice
made on an earlier visit. The browser's preference is a default, not a decision, so it goes
last.

Both halves of a language change carry the viewer's `?query` and `#fragment` across: the
automatic redirect (MUSE-10) and the manual switcher (MUSE-16). A fragment is never sent to
the server, so neither can be fixed anywhere but in the browser — the switcher attaches it
to its hrefs client-side, rewriting any `?lang=` to the locale it is switching to so the
destination does not immediately bounce back. `src/lib/lang.ts` is the single place the rule
lives; `test/lang.test.ts` and `test/localeswitch.test.ts` drive both in a real browser and
assert the destination is scrolled clear of the fixed header, not merely that the URL is
right.

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

## The CMS

Content lives in **Sanity** (project `q6fk9usq`, dataset `production`) and is fetched at
**build time**. Nothing Sanity-shaped reaches a visitor: the build still emits zero
JavaScript files, which `test/nojs.test.ts` asserts against `dist`.

```
sanity.config.ts            the Studio (hosted by Sanity, not mounted here)
sanity.cli.ts               studioHost + typegen config
sanity/schemaTypes/         the document types; enums are imported from src/lib/
sanity/schema.json          extracted schema — generated, committed
sanity/schema.stamp.json    source fingerprint — generated, committed
src/lib/sanity/             the one read path; pages import this and nothing else
src/lib/sanity/sanity.types.ts   generated from the schema + the queries
```

Document types: `siteSettings` (a singleton), `page`, `class`, `scheduleSlot`,
`instructor`, `pricingTier`, `event`, `galleryImage`, `post`, `faq`. Field labels and
descriptions are **Croatian**, because the person editing them is.

Three things about this are decisions rather than defaults, and all three are argued at
length in the code:

- **Bilingual values are two named fields** (`hr`, `en`) in one object, not a field-level
  i18n plugin and not one document per locale — `sanity/schemaTypes/objects/locale.ts`.
- **The closed sets stay in code.** Levels, styles, weekdays and the route list are
  imported into the schema from `src/lib/schedule.ts` and `src/lib/pages.ts`, so the
  Studio offers a fixed list — `sanity/schemaTypes/enums.ts`.
- **The Studio is hosted by Sanity**, at `musebymina.sanity.studio`, redeployed by
  `.github/workflows/studio.yml` when a schema file lands on `main` — `sanity.config.ts`.

```bash
SANITY_PROJECT_ID=q6fk9usq SANITY_DATASET=production npm run build
```

Both are repository **variables**, not secrets, and both have the live values as defaults
so an unset build still works. The dataset is publicly readable — an unauthenticated query
returns 200, an unauthenticated write is rejected for want of the `create` permission — so
**there is no read token in this repo and none should be added**. The only secret the
project needs is `SANITY_DEPLOY_TOKEN`, a write credential for Sanity's own hosting, used
by the Studio workflow and nothing else.

GROQ returns `null` for a field that does not exist rather than erroring, so a renamed
field is a silent failure by default. `npm run build` therefore refuses to run with stale
generated artefacts:

```bash
npm run sanity:types    # then commit sanity/schema.json, schema.stamp.json and sanity.types.ts
```

### What "a schema mismatch fails the build" means

`npm run build` is `sanity:check` → `astro check` → `astro build`, in that order, and all
three are load-bearing. `.github/workflows/deploy.yml` runs `npm run build` and nothing
else and does not depend on CI, so that script — not the CI workflow — is the definition
of what cannot reach production.

| what changed | what stops it |
|---|---|
| a schema source edited without regenerating | `sanity:check` — a fingerprint of every file under `sanity/` plus the four app modules the schema is built from |
| a document type or projected field deleted | `sanity:check` — its read-contract pass over `sanity/schema.json` |
| a field's *type* changed (`localeString` → `string`) | `astro check`, through `src/lib/sanity/shape.ts` |
| a typo in a GROQ projection | `astro check`, through the regenerated query types |
| a level added in `schedule.ts` only, or in the schema only | `astro check`, through `shape.ts`'s mutual-assignability assertions |
| the Studio made unbuildable | CI's `npm run sanity:build` — see below |

`astro check` is inside the build script for exactly the middle rows: they are invisible
to the fingerprint, because the schema really was regenerated and the stamp really is
current — the *shape* is what moved. It costs about nine seconds. CI no longer runs
`astro check` as a separate step, because the build already has.

The one check that is CI-only is the Studio bundle (`npm run sanity:build`), and that is
deliberate: a Studio that will not build cannot take the public site down, so failing the
site's deploy on it would be the wrong trade. It runs on every pull request, which is the
thing that was missing — `sanity schema extract` and `sanity schema validate` evaluate the
schema without ever bundling it, so both were green while the Studio could not be built at
all. `styled-components` is declared in `devDependencies` for that reason: it is a peer
dependency of `sanity` and therefore present in `node_modules` regardless, but
`sanity build` preflights *declarations*, not resolution.

## Deploying

CI builds for the GitHub Pages project path. Once `muse.dance` is registered, change the
env in `.github/workflows/deploy.yml` to `SITE=https://muse.dance` and `BASE=/`, and add a
`CNAME`. Nothing in the code needs to change.

Pages caps a published site at **1 GB**; CI fails above 900 MB. Media belongs on the Sanity
CDN and R2, never in the repo.

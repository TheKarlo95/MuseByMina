# Muse by Mina

Adult bachata studio in Zagreb (Ilica 209). Astro, static, deployed to GitHub Pages.
Croatian is primary; English follows.

## Read before touching UI

`../MuseByMina2/docs/design-system/muse-design-system.md` is **authoritative**. Its rules
are load-bearing, not stylistic. The three that break things silently:

- **Components reference a role token, never a brand colour.** Gold on cream is 2.02:1.
  `npm run ds` enforces this.
- **Cormorant never below 26px** — its `đ` crossbar vanishes and *Dođi* renders as "Dodi".
- **No drop shadows, either theme.** Depth is surface value plus hairlines.

Header and footer sit on a band that is plum-ink in *both* themes, so they use the
`--band-*` roles rather than page-theme roles.

## Commands

```bash
npm run dev        # localhost:4321/MuseByMina/
npm run build
npm run typecheck  # astro check
npm test           # vitest — builds the site and asserts on dist
npm run a11y       # axe, every page, both themes — needs a server running
npm run ds         # design-system compliance
npm run shots      # screenshots of all theme states to /tmp/muse-shots
```

## Conventions

- Paths are **English and unhyphenated** (`/schedule`, `/aboutus`); content is Croatian-first.
  HR and EN share slugs, so the language switcher is a prefix swap.
- Locale pages are thin wrappers: `src/pages/x.astro` + `src/pages/en/x.astro` both render a
  shared component from `src/components/`.
- Interactive behaviour goes in a component `<script>`; keep pages static.
- A page's `<title>` and `description` live in `src/lib/pages.ts`, not in the page. `llms.txt`
  publishes the same strings, so a new page must be registered there. **`astro build` will not
  catch an omission** — it exits 0 and quietly leaves the page out of the index. `npm test` is
  the gate: `test/seo.test.ts` reads the page list off `src/pages/` rather than off the
  registry, and compares each `llms.txt` description against the `<meta name="description">`
  in that route's built HTML — so the index cannot drift from the pages.
- No file under `src/` or `public/` may name the deploy host; that is the tree
  `test/seo.test.ts` walks. The host lives in exactly one place, `astro.config.mjs`, as the
  overridable `SITE`/`BASE` default. `sitemap`, `robots.txt` and `llms.txt` all derive their
  origin from it, and the suite rebuilds under a second target to prove a domain move is a
  config change.
- Static assets are referenced through `rootPath()` in `src/lib/site.ts`, never by
  interpolating `import.meta.env.BASE_URL` — whether that carries a trailing slash depends
  on `trailingSlash`, so `${BASE_URL}fonts/x` can silently yield `/MuseByMinafonts/x`. An
  apex build hides this; only the Pages sub-path 404s. `test/assets.test.ts` resolves every
  asset reference in the built HTML to a file in `dist`, under both deploy targets.
- **Page URLs end in a slash.** `trailingSlash: 'always'` + `build.format: 'directory'`,
  so `dist/en/index.html` is served at `/en/` and `/en` 301s to it. Build hrefs with
  `localeUrl()` (`src/lib/i18n.ts`) and nothing else — it is the single place the slash is
  added, and canonical, hreflang, `llms.txt` and every nav link go through it. A URL
  spelled without the slash is a redirect, which disqualifies it as a canonical and gets
  the hreflang cluster dropped (MUSE-9). `test/urls.test.ts` serves `dist` from a model of
  GitHub Pages and fetches every declared URL; `astro preview` answers both spellings with
  200, so it cannot see this class of bug.
- The theme is stamped pre-paint by an inline script (`src/lib/theme.ts`). Never move that
  into a component — it exists to prevent a flash.

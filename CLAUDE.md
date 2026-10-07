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
- **Numerals are set once, on the document.** Cormorant's default figures are old-style,
  so a number in the display face renders `19:00` as `I9:OO`. `src/styles/base.css` asks
  for `lining-nums tabular-nums` and everything inherits it. `font-variant-numeric` is a
  single value, so a component that redeclares it *replaces* that rule rather than adding
  to it — and the bug comes back with the column still neatly aligned. `npm run ds`
  rejects the property in a component; `test/numerals.test.ts` measures the glyphs.

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

npm run sanity:types   # re-extract the schema and regenerate types — commit the result
npm run sanity:check   # the fast gate `npm run build` runs first
npm run sanity:read    # every query against the live dataset: OK / EMPTY / BROKEN
npm run sanity:dev     # the Studio locally, on localhost:3333
npm run sanity:build   # bundle the Studio into .sanity/studio — what CI runs
npm run sanity:deploy  # push the Studio to musebymina.sanity.studio
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
- **CSS never names a root-absolute asset path, and the fonts live in `src/assets/`.**
  Vite rewrites a root-absolute `url()` to include `base` **only at build time**, so a
  `url('/fonts/x.woff2')` against a file in `public/` makes the deploy correct and
  `astro dev` 404 — which is how all six faces fell back to Georgia for the life of the
  project, and why MUSE-14's `II:OO` was invisible locally (MUSE-35). Use a relative
  `url()` into `src/assets/`; Vite then resolves it in both environments. The preload in
  `BaseLayout.astro` imports the *same file* with `?url`, because a preload href that is
  not also a `@font-face` src is a second download of a face the page already fetches —
  both URLs 200, nothing looks wrong. `test/assets.test.ts` resolves every `url()` in the
  emitted CSS against `dist` and asserts the two agree; `test/fonts.test.ts` runs a real
  `astro dev` and asserts six faces load and none fail.
- **A test that can only see `dist` cannot see a dev-only bug.** `test/fonts.test.ts` is
  the one suite that drives `astro dev`, through `astroDev()` in `test/helpers/scratch.ts`
  — the same module that owns `astroBuild()`, so `test/isolation.test.ts`'s child-process
  allow-list stays one entry long. Two things it has to do and you have to keep doing:
  pass `--ignore-lock` (Astro 7 auto-backgrounds the dev server when it detects an agent,
  and a daemon cannot be torn down), and strip `VITEST` from the child env — Astro's
  dev-server plugin returns early when it is set, so the server starts, greets you, and
  answers every route with `Cannot GET`.
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
- **A test never chooses where it builds.** `npm test` runs ten real `astro build`s in
  parallel workers; `test/helpers/scratch.ts` mints a directory per build with `mkdtemp`
  and passes each one its own cache root, so two suites cannot share an output tree and
  nothing has to be wiped. There is nothing to remember here — that is the point. This
  bug was fixed three times as a naming convention (MUSE-9, MUSE-10, MUSE-17) and came
  back twice; `test/isolation.test.ts` now fails if a suite names a build directory,
  deletes anything, or spawns its own build.

## Sanity (MUSE-19)

- **Content is fetched at build time and no Sanity code ships to the visitor.** The built
  output contains **zero `.js` files**; `test/nojs.test.ts` asserts that against `dist`
  along with an allow-list of output extensions. Inline `<script>` blocks are fine and
  expected — a *file* is not. The client reads its config off `process.env`, never
  `import.meta.env`, because Vite inlines the latter into client bundles and leaves the
  former alone.
- **One read module.** All GROQ lives in `src/lib/sanity/queries.ts` and every page
  imports `src/lib/sanity/` and nothing else. `test/sanity.test.ts` fails if a query
  string or `@sanity/client` appears anywhere else under `src/`.
- **Bilingual values are two named fields**, `hr` and `en`, inside a `localeString` /
  `localeText` / `localeRichText` object — not a field-level i18n plugin and not one
  document per locale. HR and EN share slugs and one document renders both, so the shape
  is `Record<Locale, string>`, both locales are separately `required()`, and a half
  translated string is a missing field an error can name. See the long note in
  `sanity/schemaTypes/objects/locale.ts` before changing this: it is hard to reverse once
  content exists.
- **Enums are structure and stay in code.** `LEVELS`, `STYLES`, `WEEKDAYS` and the route
  list are imported *into* the schema from `src/lib/schedule.ts` and `src/lib/pages.ts`
  (`sanity/schemaTypes/enums.ts`), so the Studio offers a fixed list and Mina cannot type
  a level. Prerequisites, form copy, and time/currency formatting are deliberately **not**
  in Sanity — see that file for why each one would be a mistake.
- **Every image field is built by `imageField()`**, which is the only way to get
  `hotspot: true` and a required bilingual `alt`. The design system crops one upload to
  16:9, 4:5, 3:4 and 1:1 (§9), so a hotspot is not a nicety. The shoot direction lives in
  the field *description*, because that is the only instruction Mina actually sees.
- **A schema change must be regenerated and committed.** `npm run build` runs
  `scripts/check-sanity.mjs` first, which hashes **every file under `sanity/`** — no
  extension filter, because an extension allow-list is what made `fields.tsx` invisible —
  plus `sanity.config.ts`, `sanity.cli.ts`, `src/lib/schedule.ts`, `src/lib/pages.ts` and
  `src/lib/sanity/queries.ts`. It fails if `sanity/schema.json`,
  `src/lib/sanity/sanity.types.ts` or `sanity/schema.stamp.json` is stale. This exists
  because **GROQ returns `null` for a field that does not exist rather than erroring** —
  so a renamed field with stale artefacts type-checks, builds, exits 0 and publishes pages
  with the content silently gone. Four layers catch it: the build gate, the gate's
  read-contract check, the compile-time assertions in `src/lib/sanity/shape.ts`, and
  `test/sanity.test.ts`. `.github/workflows/studio.yml`'s `paths:` filter has to be the
  same list, and `test/sanity.test.ts` asserts that rather than a comment asking nicely.
- **"Fails the build" means `npm run build`, which is three commands.**
  `sanity:check` → `astro check` → `astro build`. `astro check` is *inside* the script,
  not a step beside it in CI, because `deploy.yml` runs `npm run build` and nothing else
  and does not depend on CI — and a field's *type* changing, or a typo in a GROQ
  projection, is caught by `astro check` alone. README, "What 'a schema mismatch fails the
  build' means", has the full table.
- **CI bundles the Studio** (`npm run sanity:build`) on every pull request. `sanity schema
  extract` and `sanity schema validate` evaluate the schema without bundling it, so both
  stayed green while the Studio could not be built at all. `styled-components` is in
  `devDependencies` for that reason — it is a peer dependency of `sanity` and so is
  installed regardless, but `sanity build` preflights *declarations*, not resolution.
- **A missing or malformed document fails the build naming itself** — `_id`, type and
  field path — through `src/lib/sanity/decode.ts`. "Unreachable", "empty" and "malformed"
  are three different error types on purpose: the dataset is empty until MUSE-20, so
  "nothing on the page" has to be readable as which of the three it was.
- **The Studio is hosted by Sanity**, at `musebymina.sanity.studio`, never mounted at
  `/studio` here. `.github/workflows/studio.yml` redeploys it when a schema file lands on
  `main`. `SANITY_PROJECT_ID` and `SANITY_DATASET` are repository *variables*; there is
  **no read token anywhere** and none should be added — the dataset is publicly readable
  and writes are rejected unauthenticated.

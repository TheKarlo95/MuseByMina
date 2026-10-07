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
npm run sanity:seed    # import sanity/seed/content.ndjson into the dataset (by _id)
npm run sanity:seed:check  # does the live dataset still say what the seed says?
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
- A page's `<title>` and `description` are a **`page` document in Sanity** (MUSE-20), read
  through `getPage(route)` in the page's frontmatter. `src/lib/pages.ts` keeps only the half
  that is structure — `ROUTES`, which routes the site serves — and the Studio builds its
  route dropdown from it, so Sanity owns a page's words and never its existence. `llms.txt`
  publishes the same strings as the page's `<meta name="description">`, so a new page needs
  **both** a route in `ROUTES` and a document in the Studio. **`astro build` will not catch a
  missing route** — it exits 0 and quietly leaves the page out of the index; `npm test` is
  that gate, because `test/seo.test.ts` reads the page list off `src/pages/` rather than off
  the registry. A missing *document* does fail the build, naming the route and where to add
  it — and so does a second document for a route, because which title the page got would
  otherwise depend on query order. Both are `pagesByRoute` in `src/lib/sanity/index.ts`,
  which passes `minimum: 0` to `requireDocuments` deliberately: a count check there reports
  "the dataset holds 3, this page needs 4 … an empty dataset" and shadows the message that
  names the route, in the single most likely case.
- No file under `src/` or `public/` may name the deploy host; that is the tree
  `test/seo.test.ts` walks. The host lives in exactly one place, `astro.config.mjs`, as the
  overridable `SITE`/`BASE` default. `sitemap`, `robots.txt` and `llms.txt` all derive their
  origin from it, and the suite rebuilds under a second target to prove a domain move is a
  config change.
- **An asset the site's own code uses goes in `src/assets/` and is imported** — never
  `public/` plus a hand-written path. Vite rewrites a root-absolute CSS `url()` to
  include `base` **only at build time**, so `url('/fonts/x.woff2')` against a file in
  `public/` makes the deploy correct and `astro dev` 404: that is how all six faces fell
  back to Georgia for the life of the project, and why MUSE-14's `II:OO` was invisible
  locally (MUSE-35). Importing instead means Vite emits the file with a content hash and
  resolves every reference to it in both environments, with no base-path join anywhere.
  `src/styles/fonts.css` uses a relative `url()` into `src/assets/`; `BaseLayout.astro`
  preloads the *same files* via `?url` imports.
- **A preload must name the same URL as the thing it preloads, and must be a face the
  page actually needs.** Two different failures, both silent. Point the preload at a
  second copy of the font and both URLs are 200, both resolve, and the browser downloads
  each face twice. Point it at a declared-but-unused subset (`-latin-ext` instead of
  `-latin`) and you pay for bytes the page never paints with and lose the preload on the
  ones it does. `test/assets.test.ts` catches the first against `dist`;
  `test/fonts.test.ts` catches the second by loading each page **with the preload tags
  stripped** and recording what the CSS engine then asks for — the only way to measure
  it, since a preload is itself a request and so "was it requested" is true by
  construction.
- `rootPath()`/`rootUrl()` in `src/lib/site.ts` are for files the build publishes at the
  deploy root — `robots.txt`, `llms.txt`, the sitemap — and for a future `favicon.ico` or
  `CNAME`. They are **not** the way to reference a bundled asset; see the bullet above.
  Never interpolate `import.meta.env.BASE_URL` by hand: whether it carries a trailing
  slash depends on `trailingSlash`, so `${BASE_URL}robots.txt` can silently yield
  `/MuseByMinarobots.txt`. An apex build hides this; only the Pages sub-path 404s.
- **A test that can only see `dist` cannot see a dev-only bug.** `test/fonts.test.ts` is
  the one suite that drives `astro dev`, through `astroDev()` in `test/helpers/scratch.ts`
  — the same module that owns `astroBuild()`, so `test/isolation.test.ts`'s child-process
  allow-list stays one entry long. It asserts over three environments: dev, and both
  deploy targets built and served. Two things it has to do and you have to keep doing:
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

## Sanity (MUSE-19, MUSE-20)

- **The build reads Sanity, so a Sanity outage blocks every PR and every deploy.** Three
  jobs run `npm run build` and it fetches live; there is no cached snapshot and no retry of
  our own beyond `@sanity/client`'s defaults. That is the deliberate trade — the
  alternative is publishing pages with empty titles, which `src/lib/sanity/decode.ts`
  exists to refuse — but it is a real availability dependency, and the `continue-on-error`
  probe step in `ci.yml` no longer protects anything from it.
- **The seed is both the migration and the test fixture.** `sanity/seed/content.ndjson`
  holds the five documents that exist — the `siteSettings` singleton and four `page`
  documents — and `npm run sanity:seed` imports it, replacing by `_id`, so the migration is
  reviewable and re-runnable. `vitest.config.ts` points every test build at that same file
  (`MUSE_CONTENT_FIXTURE`) and `src/lib/sanity/fixture.ts` evaluates the *real* queries
  against it with `groq-js`. **The suite never touches the network**, and there is no second
  copy of the content to drift. The deploy has no such variable and fetches live; there is no
  default path and no fallback, so a fixture build cannot happen by accident — and the build
  log says which source it read. What can still age is the seed against the dataset once Mina
  edits in the Studio: `npm run sanity:seed:check` is how you find out, and CI runs it
  `continue-on-error` so drift is reported without failing a pull request. The fixture
  drops `drafts.` documents, because `perspective: 'published'` does and a seed refreshed
  with `sanity dataset export` carries drafts — otherwise the fixture sees a page the
  deploy cannot.
- **What the site published before the migration is frozen in `test/content.test.ts`.**
  `PUBLISHED_BEFORE_THE_MIGRATION` is the only remaining copy of those strings and it is
  what makes "renders byte-identically to the previous deploy" a test rather than a command
  somebody once ran — comparing the build to the seed it just read asserts nothing. When
  Mina legitimately rewords something, delete the entry with a sentence saying so; do not
  quietly update it to match.
- **`siteSettings.address` is one field, rendered on four surfaces.** `addressLines`
  (`src/lib/sanity/decode.ts`) splits it on its one comma for the footer's two-line
  `<address>`; `ADDRESS_PATTERN` makes the Studio refuse what the build would refuse. The
  rule exists because a CMS field nothing renders is worse than no field — it looks like it
  works. Only `country` (a translated word) and `maps` (no field in the schema) are still
  code, in `STUDIO`.
- **The schedule and the instructors are deliberately not in Sanity yet** (MUSE-36).
  `src/data/schedule.ts` is invented content naming instructors who do not exist; importing
  it would make fiction look authoritative in the Studio. The real timetable is entered
  there directly, and `Schedule.astro` already takes its rows as a prop.
- **A page imports `src/lib/sanity` and nothing deeper.** The index is what decodes; a
  module from inside the read path hands back raw rows with silent nulls. Both halves are
  tests, not conventions: `test/sanity.test.ts` fails on an import specifier containing
  `lib/sanity/` from outside the directory, and — splitting each `.astro` file at its
  frontmatter fence — on `lib/sanity` appearing in the *markup* half, where a `<script>`
  would ship it to the browser.
- **Content is fetched at build time and no Sanity code ships to the visitor.** The built
  output contains **zero `.js` files**; `test/nojs.test.ts` asserts that against `dist`
  along with an allow-list of output extensions. Inline `<script>` blocks are fine and
  expected — a *file* is not. The client reads its config off `process.env`, never
  `import.meta.env`, because Vite inlines the latter into client bundles and leaves the
  former alone.
- **One read module.** All GROQ lives in `src/lib/sanity/queries.ts` and every page
  imports `src/lib/sanity/` and nothing else. `test/sanity.test.ts` fails if a query
  string or `@sanity/client` appears anywhere else under `src/`.
- **Every query is executed against a row, and `test/projections.test.ts` is the only
  thing that does it** (MUSE-44). Nine of the eleven queries were run by nothing, so no
  projection in them had ever been checked — `class->nam` type-checked, built, exited 0
  and would have shipped a schedule of blanks. Three layers look like they cover this and
  none does: `npm run sanity:read` runs all eleven live, but against a dataset with no
  classes or images, so all nine report `EMPTY` — correct for an empty dataset and
  indistinguishable from a wrong projection; `test/sanity.test.ts` decodes rows that are
  already **post**-projection, so the test and the query cannot disagree; and `sanity
  typegen` derives result types from the query *text*, so a typo yields a *consistent*
  wrong type. So that suite calls the real readers against structural fixtures in
  `test/helpers/structural-content.ts` — **not** `sanity/seed/content.ndjson`, which
  `npm run sanity:seed` imports into the live dataset. A new query needs a case there, and
  the bar is the ticket's: rename one projected field and the suite must go red. Watch out
  for the fields with a silent fallback — `featured` decodes to `false`, `lineup` to `[]`,
  `author`/`endsAt`/`hotspot` to `undefined` — which is why the fixture fills every
  optional field the seed leaves empty. The fixture also carries `drafts.`-prefixed
  documents, so all forty-odd assertions run against a dataset holding drafts: MUSE-20
  proves the filter works for `page`, which is one of the two queries that *were* already
  executed, and a leaked draft `scheduleSlot` or `pricingTier` is a class or a price on the
  public site that nobody published.
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
  are three different error types on purpose: most of the dataset is still empty
  (MUSE-36), so "nothing on the page" has to be readable as which of the three it was.
- **The Studio is hosted by Sanity**, at `musebymina.sanity.studio`, never mounted at
  `/studio` here. `.github/workflows/studio.yml` redeploys it when a schema file lands on
  `main`. `SANITY_PROJECT_ID` and `SANITY_DATASET` are repository *variables*; there is
  **no read token anywhere** and none should be added — the dataset is publicly readable
  and writes are rejected unauthenticated.

## Rebuilding when Mina publishes (MUSE-21)

- **A schedule, not a webhook, and no GitHub token anywhere.** `deploy.yml` carries a
  `schedule:` trigger alongside `push`. The webhook route (Sanity → `repository_dispatch`)
  works and is what most projects do, but it needs a GitHub PAT living inside a third
  party, which is the one property this project's architecture was arranged to keep. Do
  not add one. The cost is latency, and latency is the thing the Studio can be honest
  about.
- **`src/lib/rebuild.ts` is the only place the cadence is written.** The cron in
  `deploy.yml` and the sentence Mina reads in the Studio are both derived from
  `REBUILD_HOURS_UTC`; `test/rebuild.test.ts` parses the workflow and fails if they
  disagree, and re-derives "when does this cron next fire" independently over a year of
  instants rather than comparing strings. Because the Studio quotes it, that file is in
  `studio.yml`'s `paths:` — as a *studio-only* path, since it defines no field and is
  deliberately not in the schema fingerprint.
- **What Mina is promised is a duration, never a clock time.** Cron is UTC and does not
  shift with daylight saving, so a sentence naming 15:20 is wrong for half the year in a
  way nobody notices until she does. The badge in `sanity/badges.ts` *offers* a local time
  — computed in her browser, which is the only way it can be right in both halves of the
  year — but the commitment is `MAX_WAIT_HOURS`, which is computed from the gaps between
  runs so that bunching them into the working day widens the promise instead of breaking
  it. Keep the spacing uniform or the ceiling grows to the overnight gap.
- **Five edits do not cause five builds, because edits do not cause builds.** The
  debouncing problem the ticket describes does not exist under a schedule; there is nothing
  to add a concurrency group for beyond the `pages` group that was already there.
- **A failed deploy opens an issue assigned to the owner. Do not replace that with
  GitHub's own notification.** For a scheduled workflow GitHub notifies whoever created it,
  moving to whoever last edited the cron and again to whoever re-enabled it, and only if a
  per-account Actions preference is on — a preference with no REST API, so nothing here can
  assert it. Measured while building this: `subscribers_count` on this repository is 0 and
  `GET /subscription` 404s. An assignment notification is "Participating", on by default,
  and independent of both.
- **`npm run build` fetches live and hard-fails on an outage, so the scheduled build
  retries — for that one failure and nothing else.** It greps the failed build for
  `TRANSIENT_BUILD_FAILURE`, which couples a shell script to the wording of an error in
  `src/lib/sanity/client.ts`; `test/content.test.ts` asserts that constant against the
  output of a **real build against an unreachable project**, so rewording the error fails
  a test rather than silently turning the retry off. A content or code failure is not
  retried: it will not pass on the third attempt.
- **GitHub disables a scheduled workflow after 60 days of repository inactivity and
  promises no notification when it does.** A disabled workflow does not fail, so the alert
  above is structurally blind to it, and the disable takes push-triggered deploys with it.
  Synthetic activity to keep the clock alive was rejected — a bot commit or a Dependabot
  schedule rests on an undocumented reading of "repository activity" and would be a guard
  that cannot be tested. Instead `ci.yml`'s `rebuildloop` job reads the documented `state`
  field and fails if it is not `active`. `ci.yml` is the host because it is the only
  workflow here that is not scheduled and so cannot be disabled itself.

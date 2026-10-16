# Muse by Mina

Adult bachata studio in Zagreb (Ilica 209). Astro, static, deployed to GitHub Pages.
Croatian is primary; English follows.

**This file is the rules. `docs/decisions/` is why.** Each rule below is stated in one to
three lines and names the document that argues it — the measurements, the approaches that
were tried and failed, and the defect it came from. **Read the document covering what your
ticket touches before changing anything in that area.** Several of these rules have been
re-broken by somebody who had the rule and not the argument, which is why the arguments
were written down rather than summarised.

| document | covers |
| --- | --- |
| `docs/decisions/pages.md` | what each page says, and what must never be re-added |
| `docs/decisions/content-model.md` | Sanity — schema, queries, the seed, the Studio |
| `docs/decisions/testing.md` | the suite — isolation, concurrency, browsers, dev servers |
| `docs/decisions/design-and-assets.md` | numerals, fonts, preloads, the budget, the brand marks |
| `docs/decisions/build-and-deploy.md` | the deploy host, URLs, the cascade, the rebuild loop |

## Read before touching UI

`../MuseByMina2/docs/design-system/muse-design-system.md` is **authoritative**. Its rules
are load-bearing, not stylistic. The three that break things silently:

- **Components reference a role token, never a brand colour.** Gold on cream is 2.02:1.
  `npm run ds` enforces this.
- **Cormorant never below 26px** — its `đ` crossbar vanishes and *Dođi* renders as "Dodi".
- **No drop shadows, either theme.** Depth is surface value plus hairlines.
- **Numerals are `lining-nums tabular-nums`, set in `src/styles/base.css` and nowhere
  else — in two rules, because form controls do not inherit it.** Never redeclare
  `font-variant-numeric` in a component: it is a single value, so a component *replaces*
  the rule and the bug returns with the column still neatly aligned. `npm run ds` rejects
  the property in a component. → `design-and-assets.md`

Header and footer sit on a band that is plum-ink in *both* themes, so they use the
`--band-*` roles rather than page-theme roles.

## Commands

```bash
npm run dev        # localhost:4321/MuseByMina/ — fetches content live
MUSE_CONTENT_FIXTURE=content/seed.ndjson npm run dev   # …or from the seed, offline
npm run build
npm run preview    # dist, served the way Pages serves it — not `astro preview` (MUSE-52)
npm run typecheck  # astro check
npm test           # vitest — builds the site and asserts on dist
npm run a11y       # axe, every page, both themes — serves dist itself
npm run budget     # the performance budget, per page: budget / actual / headroom
npm run ds         # design-system compliance
npm run format:check   # the formatting convention — fast, names file:line
npm run format -- <file>   # apply it to **one file**; never to the tree (MUSE-58)
                           # it reflows the whole file — read the diff after (MUSE-82)
npm run shots      # screenshots of all theme states to /tmp/muse-shots
npm run worktrees:sweep    # reclaimable per-ticket worktrees; `-- --remove` to do it

npm run sanity:types   # re-extract the schema and regenerate types — commit the result
npm run sanity:check   # the fast gate `npm run build` runs first
npm run sanity:read    # every query against the live dataset: OK / EMPTY / BROKEN
npm run sanity:seed    # import content/seed.ndjson into the dataset (by _id)
npm run sanity:seed:check  # does the live dataset still say what the seed says?
npm run sanity:seed:release  # …and did *this branch* author the difference? (MUSE-78)
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
- The theme is stamped pre-paint by an inline script (`src/lib/theme.ts`). Never move that
  into a component — it exists to prevent a flash.

### Pages, routes and metadata

- **A page's `<title>` and `description` are a `page` document in Sanity**, read through
  `getPage(route)`. `src/lib/pages.ts` holds only `ROUTES` — which routes the site serves —
  so Sanity owns a page's words and never its existence. A new page needs **both** a route
  in `ROUTES` and a document in the Studio. `astro build` will not catch a missing route;
  `npm test` is that gate. → `content-model.md`
- **Three lists disagree and `src/pages/` is the only one that cannot lie** (MUSE-46).
  `test/routes.test.ts` anchors every check on the filesystem. A `page` document for a
  route the site does not serve is a **warning, not a failed build** — do not promote it.
  → `content-model.md`
- **Page URLs end in a slash.** `trailingSlash: 'always'` + `build.format: 'directory'`.
  Build hrefs with `localeUrl()` (`src/lib/i18n.ts`) and nothing else — it is the single
  place the slash is added. A URL spelled without it is a redirect, which disqualifies it
  as a canonical. → `build-and-deploy.md`
- **"Should a crawler index this" and "may this page route by language" are two props**
  (MUSE-38). `BaseLayout.astro` takes `indexable` and `localeTwins`; neither is derived
  from the other, and `const localeRouting = indexable;` is the regression. A cluster of
  one hreflang is not emitted. `404.astro` is bilingual, not client-side-selected.
  → `build-and-deploy.md`
- **A link that offers a language must name it** (MUSE-33, MUSE-56). `carryLocation` is the
  only place that rule lives; `/` is the one route that language-detects, so a bare
  homepage href hands the click to browser detection. → `build-and-deploy.md`
- **Structured data is one module and one `<script>` tag** (MUSE-31).
  `src/lib/structured-data.ts` projects `SiteSettings` into JSON-LD and `BaseLayout.astro`
  emits it; a second emission site is a red test. `DanceSchool` is **not** a schema.org
  type and an unknown `@type` fails silently. → `build-and-deploy.md`
- **The position of an `import` in a component's frontmatter decides CSS cascade order.**
  There is no config for it. `import '../styles/globals.css'` is the **first** import in
  `BaseLayout.astro`, and `BaseLayout` is the first import in every page wrapper.
  → `build-and-deploy.md`

### Assets, fonts and the brand

- **An asset the site's own code uses goes in `src/assets/` and is imported** — never
  `public/` plus a hand-written path. A root-absolute CSS `url()` is rewritten with `base`
  **only at build time**, so it makes the deploy correct and `astro dev` 404 (MUSE-35).
  There is **no `public/`**. → `design-and-assets.md`
- **A preload must name the same URL as the thing it preloads, and the preloaded set must
  be exactly the set the page asks for.** Leave a face out and a word paints in two
  typefaces: every Croatian diacritic lives in `latin-ext`. `src/lib/fonts.ts` is the only
  place the per-page set is decided, and **no list may say a page does *not* need a
  subset** — English is additive-only. → `design-and-assets.md`
- **There is a performance budget, it is `scripts/budget.mjs`, and it is deliberately not
  Lighthouse** (MUSE-63). Bytes per page per resource kind, request count, render-blocking
  count, and how many font faces the host **served**. **No timing and no composite score.**
  One budget for every page, no per-route entries; the font count has a **floor**. Each
  number carries the measurement that set it, and `test/budget.test.ts` reads that JSDoc,
  so raising one silently is a red test. → `design-and-assets.md`
- **The brand lockup is the supplied artwork, rendered by `Lockup.astro` and nowhere else**
  (MUSE-64) — two spans of Cormorant and Jost is the rebuild §12 forbids by name. The
  masthead carries the **icon-only mark** instead, because the lockup does not fit either
  band at a legible size. Do not shrink the lockup into the band to make the guard green.
  → `design-and-assets.md`
- **The icon-only mark is a crop of the lockup, and the small sizes are thickened**
  (MUSE-40). The alpha is dilated before resampling; a regenerated-without-it icon is the
  right mark and a smudge. All five tab files carry **`?url&no-inline`**; the masthead mark
  must **not**. Both colour schemes, mutually exclusive `media`, plus a default opaque tile
  — an unknown media feature is *false*, not ignored (MUSE-75). → `design-and-assets.md`
- **A shared link shows a picture, and `siteSettings.shareImage` decides which** (MUSE-69).
  `shareCard()` is the one decision point. The URL is `new URL(card.src, Astro.site)` —
  **derived, never written**. `og:image:width`/`height` are required, not padding. No
  `og:image:type` and no `og:locale:alternate`. The 404 carries a card.
  → `design-and-assets.md`
- `rootPath()`/`rootUrl()` in `src/lib/site.ts` are for files published at the deploy root
  — `robots.txt`, `llms.txt`, the sitemap. They are **not** how you reference a bundled
  asset. Never interpolate `import.meta.env.BASE_URL` by hand. → `build-and-deploy.md`

### The deploy host

- **The deploy host lives in exactly one file**, `astro.config.mjs`, as the overridable
  `SITE`/`BASE` default — which makes a domain move (MUSE-29) a config change.
  **The guarantee is against `dist`, not against a list of directories** (MUSE-42):
  `test/seo.test.ts` builds under a second host and asserts the first appears nowhere in
  the output. Alongside it a **fast source scan** names the offending file and walks the
  whole repository, taking its exclusions from `.gitignore`. Three paths may name the host
  — `astro.config.mjs`, `.github/workflows/deploy.yml` and `test/`. **Everything else
  fails, prose included.** → `build-and-deploy.md`

### Tests

- **A test never chooses where it builds.** `test/helpers/scratch.ts` mints a directory per
  build and passes each its own cache root. `test/isolation.test.ts` fails if a suite names
  a build directory, deletes anything, or spawns its own build. **The cache root lives in
  `astro.config.mjs`** and is the half that actually fixed the flake.
  **`SCRATCH` being inside the repository is a requirement, not a preference** — an `outDir`
  outside the project root shares one staging directory (MUSE-41, MUSE-92).
  → `testing.md`
- **The heavyweight-operation total is metered and the headroom is zero.** `DECLARED` in
  `test/helpers/concurrency.ts` is a per-file table; adding a build is a one-line edit
  there, deliberately. **Read the measurement table above `BUDGET` before changing either
  number** — the flake is load-sensitive with no threshold. The count is **measured, not
  read off the source**. → `testing.md`
- **A browser suite waits for a condition, never for the clock** (MUSE-54), and
  `test/helpers/browser-settle.ts` is the only place it waits — on the page's own
  `requestAnimationFrame` clock. **The condition must be about the document being
  measured** (MUSE-61): a blank tab satisfies `load` and a `localStorage` read. For a tab
  Chromium opened, `page.url()` is a mirror that can be permanently wrong (MUSE-70) — ask
  the document. **Never gate on `waitForURL(theExpectedUrl)`**; `expect` stays the judge.
  → `testing.md`
- **A browser check never takes a server it did not start** (MUSE-52). `openSite()` in
  `scripts/dist-origin.mjs` serves `dist` in-process on an ephemeral port. Do not put the
  `astro preview` daemon back. `ORIGIN` is **verified** against the local `dist`.
  → `testing.md`
- **A browser check measures the page it names** (MUSE-48). `openCheckPage()` in
  `scripts/browser-checks.mjs` is the only way to open a page; it derives the locale from
  the route and asserts where it landed. That module **owns Playwright** — nothing else in
  `scripts/` or `test/` may call `newContext`, `newPage`, `addInitScript`, `setItem` or
  `chromium.launch`. → `testing.md`
- **A test that can only see `dist` cannot see a dev-only bug.** `test/fonts.test.ts` is
  the one suite that drives `astro dev`, through `astroDev()`. Pass `--ignore-lock` and
  strip `VITEST` from the child env. **A green dev-server suite on your machine is not
  evidence about CI** (MUSE-47) — to reproduce CI, unset `CLAUDECODE`, `AI_AGENT` and
  `CLAUDE_CODE_*` **and set `FORCE_COLOR=1`**. Both halves, or the defect is unreachable.
  The base is configuration, never discovered from a server. → `testing.md`
- **Every page read from a dev server goes through `fetchMeasuredPage`** (MUSE-62), which
  compares the response's canonical against the path requested — the 404 page declares
  none, so it cannot pass for a real page. Not body text: every page contains „Muse by
  Mina". → `testing.md`
- **What `npm run a11y` audits is read off the build, and each page carries its URL and its
  status** (MUSE-55). `auditTargets` walks `dist`; there is no list to extend and no
  `ROUTES` in the script or CI. **It runs every rule axe enables by default — there is no
  tag filter** (MUSE-75). `incomplete` results are notes and are never failed on.
  → `testing.md`
- **The host model serves the error page's *body* on a 404** (MUSE-38), and outside the
  deploy prefix it returns no body. Drive it with `test/helpers/preview.ts`. → `testing.md`
- **A component can be built before its page can be routed** (MUSE-23):
  `MUSE_PREVIEW_ROUTES=<name> npm run build` injects `/<name>-preview`. **Delete the entry
  with the ticket that routes the page.** The registry is empty, which is the healthy
  state. → `testing.md`
- **The formatting convention is stated in `prettier.config.mjs`, and `prettier --write`
  over the tree is still wrong** (MUSE-58). Run `npm run format -- <file>` on the one file
  you touched. **Then read `git diff`** — it reformats the whole file, and if it rewrapped
  code you did not touch, revert and re-apply your hunk by hand (MUSE-82).
  `npm run format:check` is the gate; **`prettier --check` is not and must not become
  one.** → `testing.md`

## Sanity (MUSE-19, MUSE-20)

- **The build reads Sanity, so a Sanity outage blocks every PR and every deploy.** That is
  the deliberate trade — the alternative is publishing pages with empty titles.
  → `content-model.md`
- **It reads the *uncached* host, and that is a correctness setting, not a tuning one**
  (MUSE-81). `useCdn: false`, pinned as the literal type `false`. The cached host is
  eventually consistent, so a build inside the refresh window publishes the previous
  revision with every gate green. The `[content]` line names the host. → `content-model.md`
- **The seed lives in `content/`, not in `sanity/`, and that is load-bearing** (MUSE-45).
  Everything under `sanity/` is schema source and is fingerprinted with no extension
  filter. **Do not fix the next instance by teaching the walk to skip something** — move
  the file. → `content-model.md`
- **The seed is both the migration and the test fixture.** `content/seed.ndjson` holds
  every document that exists; `npm run sanity:seed` imports it, replacing by `_id`. Every
  test build reads that same file and **the suite never touches the network**.
  → `content-model.md`
- **Editing content in a branch is two steps and the order is the whole of it: import,
  then merge** (MUSE-78). An *edit* to an existing document publishes the old value
  successfully with no signal. Importing after the merge needs a forced rebuild — that is
  the forgettable step. `npm run sanity:seed:release` is the blocking gate;
  `sanity:seed:check` beside it must **not** block. → `content-model.md`
- **Removing a document is `npx sanity documents delete <id> --dataset production`, *then*
  `npm run sanity:seed`, in that order** (MUSE-83). `--replace` only writes, so the import
  cannot delete; import-first republishes the rate the branch retired, delete-first
  publishes a page one document short, which is true. **An agent runs neither.**
  → `content-model.md`
- **Only a missing `page` or `prosePage` fails the build** (MUSE-83) — those are looked up
  by route. Every other type is a collection whose `minimum` one existing document already
  satisfies, so adding, editing or removing any other document ships green and publishes
  without it. **Do not fix that by lowering a `minimum`**; `sanity:seed:release` is the
  guard and it blocks on all three. → `content-model.md`
- **Routing a page is two pull-request-shaped halves, and the dataset goes first**
  (MUSE-59, MUSE-60). The branch prepares the seed *and* the route, says in the PR body it
  must not be merged yet, and somebody runs the import between review and merge.
  **An agent does not run that command.** → `content-model.md`
- **A dev server re-reads content per request; a build memoises exactly two readers**
  (MUSE-47, MUSE-94). `getSiteSettings` and the `page` reader — the other thirteen
  re-query per call, **twenty-nine queries to a build**, which `test/devcontent.test.ts`
  counts off the build's own census line rather than taking the log's word for it. Both
  caches are per-build. The gate is the literal `import.meta.hot` (`src/lib/sanity/
  dev.ts`) — write it that way, though all three spellings behave alike; never `NODE_ENV`
  or `process.argv`, which whoever starts the build can set. → `content-model.md`
- **Offline dev is `MUSE_CONTENT_FIXTURE=content/seed.ndjson npm run dev`**, and MUSE-47
  deliberately built no mechanism for it: no fallback, no `dev:offline` script, no second
  gated boolean. → `content-model.md`
- **What the site published before the migration is frozen in `test/content.test.ts`.**
  When Mina legitimately rewords something, delete the entry with a sentence saying so; do
  not quietly update it to match. → `content-model.md`
- **`siteSettings.address` is one field, rendered on five surfaces.** A CMS field nothing
  renders is worse than no field — it looks like it works. `test/contentdrift.test.ts`
  holds a registry of every string field in the seed, each classified as CMS-owned or
  legitimately-in-code with the reason beside it. → `content-model.md`
- **An optional field is a decision, not laziness.** `instructor.portrait`, `bio`,
  `instagram`, `class.description`, `class.image`, `siteSettings.phone` and `openingHours`
  are optional because no real value exists, and a `required()` field with no value can
  only be filled with fiction — which is how MUSE-36 happened. → `content-model.md`
- **A page imports `src/lib/sanity` and nothing deeper.** The index is what decodes; a
  module from inside the read path hands back raw rows with silent nulls. Both halves are
  tests. → `content-model.md`
- **One read module.** All GROQ lives in `src/lib/sanity/queries.ts`. A query string or
  `@sanity/client` anywhere else under `src/` is a red test. → `content-model.md`
- **Content is fetched at build time and no Sanity code ships to the visitor.** The output
  contains **zero `.js` files**. The client reads config off `process.env`, never
  `import.meta.env`. → `content-model.md`
- **Every query is executed against a row, and `test/projections.test.ts` is the only
  thing that does it** (MUSE-44). GROQ returns `null` for a field that does not exist, so
  `class->nam` type-checks, builds and ships blanks. Rename one projected field and that
  suite must go red. → `content-model.md`
- **A query may not run without the parameters it references** (MUSE-51).
  `requireQueryParameters` runs in front of *both* read paths. The count check cannot be
  the instrument — it fires on a legitimate zero result. → `content-model.md`
- **A missing or malformed document fails the build naming itself** — `_id`, type and field
  path — through `src/lib/sanity/decode.ts`. "Unreachable", "empty" and "malformed" are
  three different error types on purpose. → `content-model.md`
- **Every dereference in `queries.ts` is projected beside its `_ref`** (MUSE-49). For an
  optional reference, a deleted target and an empty field arrive identically, so the `_ref`
  is the missing evidence. **The pair must stay a pair**, arrays are read positionally, and
  `instructors` being an array is load-bearing. → `content-model.md`
- **Bilingual values are two named fields**, `hr` and `en`, inside a `localeString` /
  `localeText` object — not a field-level i18n plugin and not one document per locale. Both
  locales separately `required()`. `postTranslation` is the one place the inverse grouping
  is right. → `content-model.md`
- **Enums are structure and stay in code.** `LEVELS`, `WEEKDAYS` and the route list are
  imported *into* the schema. Prerequisites, form copy, and time and currency formatting
  are deliberately **not** in Sanity. → `content-model.md`
- **Every image field is built by `imageField()`**, the only way to get `hotspot: true` and
  a required bilingual `alt`. The shoot direction lives in the field *description*, because
  that is the only instruction Mina sees. → `content-model.md`
- **A schema change must be regenerated and committed.** `npm run build` hashes every file
  under `sanity/` and fails if the generated artefacts are stale. Four layers catch it, and
  `studio.yml`'s `paths:` must be the same list — which is asserted, not asked for.
  The read-contract list is hand-written and **asserted complete** (MUSE-66); a field that
  is only sorted by belongs on it. → `content-model.md`
- **"Fails the build" means `npm run build`, which is three commands:** `sanity:check` →
  `astro check` → `astro build`. `astro check` is *inside* the script, not a CI step beside
  it. → `content-model.md`
- **CI bundles the Studio** (`npm run sanity:build`) on every pull request, because
  `schema extract` and `schema validate` both stay green while the Studio cannot be built.
  → `content-model.md`
- **The Studio is hosted by Sanity**, at `musebymina.sanity.studio`, never mounted at
  `/studio`. `SANITY_PROJECT_ID` and `SANITY_DATASET` are repository *variables*; there is
  **no read token anywhere** and none should be added. → `content-model.md`

## What the pages say

Every rule in this section exists because the site published something nobody had said.
Read `docs/decisions/pages.md` before changing page copy — it records, per page, what was
retired and what must not come back.

- **The schedule is in Sanity, and `src/data/schedule.ts` is gone** (MUSE-36). What is
  published came from Mina: four classes, two evenings, 90 minutes, Mina **and** Antonio on
  every one. **`LEVELS` has four entries in dancer order** — a new level is *inserted*.
  **There is no `STYLES`**, and the guard is the values rather than the name (MUSE-76).
  **No prerequisite is confirmed** (MUSE-85); the record is a type, and it cannot compile
  without a name and a date. → `pages.md`
- **The site makes no claim about what a first class costs** (MUSE-71) and **promises no
  response time** (MUSE-80). Both were published for the life of the project and neither
  was ever offered. **Nothing replaced either** — retiring an unsupported commercial
  promise needs no decision from the studio; adding one does. The guard is
  `test/helpers/offer-claims.ts`, applied to source **and** to `dist`, because a claim
  composed at render time appears in no source file. → `pages.md`
- **`/contact` tells the visitor to do what this build can actually do**, gated on
  `FORM_HAS_PROCESSOR` — the same expression `TrialForm.astro` tests before it will
  `fetch`. **The form's own failure copy is gated on it too** (MUSE-110): with no endpoint
  no message instructs a retry and one line offers the inbox, including the offline one,
  which that branch does reach. `formMessages` in `src/lib/forms.ts` is the only place it
  is decided. → `pages.md`
- **`/privacy/` is a statutory document, so it stays in code** (MUSE-72), and the one fact
  that varies is read off the form's own configuration. Art. 13(1)(e) takes *categories* of
  recipient, so the live paragraph names no provider. **Retention and whether student
  records exist are Mina's decisions and still outstanding.** → `pages.md`
- **`/events`, `/blog` and `/gallery` ship empty, and being honest about that is the page**
  (MUSE-24, MUSE-26, MUSE-25). The empty copy is in **code, not the CMS** — "there are no
  posts" is a statement about the dataset, and Mina cannot keep a field describing the
  dataset true. **Do not seed a post, an event or a photograph to furnish a page.**
  → `pages.md`
- **`/pricing` publishes the studio's three rates, and that is the whole rate card**
  (MUSE-73) — 55 € regular monthly, 40 € student monthly, 20 € drop-in, confirmed by the
  owner on 2026-10-09. A fourth document in the seed is a red test. **Retiring a rate is a
  seed deletion, which this repository cannot finish**: delete first, then import, and an
  agent runs neither. → `pages.md`
- **`/whatisbachata` says what the dance is, and nothing about the curriculum** (MUSE-65).
  The styles are allowed as a sentence and forbidden as structure. → `pages.md`
- **`/aboutus` ships placeholder prose, and it is placeholder where a human can see it**
  (MUSE-60) — in the seed, asserting nothing checkable, and labelled `PRIVREMENI TEKST` in
  the Studio. **Silent** placeholder text is what MUSE-36 is about; placeholder text is
  allowed. **No bio is written for Mina or Antonio and none should be.** → `pages.md`
- **„Dvoja vrata, ne šest." is `Home.astro`'s own line, not the design brief's** (MUSE-80).
  Four comments cited a brief that contains no such phrase. **A fabricated citation is
  worse than fabricated copy**, because the next author trusts it rather than opening the
  file. → `pages.md`
- **Name a commit only after `git log -S` has shown it authored the string, and put the
  command in the pull request** (MUSE-111). Two files blamed two different wrong commits
  for one retired promise, one of them shipped by the ticket whose whole subject was a
  false provenance claim. No test can hold this — the suite has no history to read. **And
  prefer a property to a count**: „67/67 green" was already wrong on the day it merged.
  → `pages.md`

## Rebuilding when Mina publishes (MUSE-21)

- **A schedule, not a webhook, and no GitHub token anywhere.** The webhook route needs a
  PAT living inside a third party, which is the one property this architecture was arranged
  to keep. Do not add one. → `build-and-deploy.md`
- **`src/lib/rebuild.ts` is the only place the cadence is written.** The cron and the
  sentence Mina reads in the Studio are both derived from it, and `test/rebuild.test.ts`
  fails if they disagree. → `build-and-deploy.md`
- **What Mina is promised is a duration, never a clock time.** Cron is UTC and does not
  shift with daylight saving. Keep the spacing uniform or the ceiling grows to the
  overnight gap. → `build-and-deploy.md`
- **A failed deploy opens an issue assigned to the owner. Do not replace that with
  GitHub's own notification**, which moves with whoever last edited the cron and depends on
  a per-account preference with no REST API. → `build-and-deploy.md`
- **`npm run build` hard-fails on an outage, so the scheduled build retries — for that one
  failure and nothing else.** It greps for `TRANSIENT_BUILD_FAILURE`, so rewording that
  error fails a test rather than silently turning the retry off. → `build-and-deploy.md`
- **GitHub disables a scheduled workflow after 60 days of repository inactivity** and
  promises no notification. `ci.yml`'s `rebuildloop` job reads the documented `state` field
  and fails if it is not `active`. → `build-and-deploy.md`

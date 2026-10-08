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
- **Numerals are set in `base.css` and nowhere else — twice, because inheritance only
  covers half the page.** Cormorant's default figures are old-style, so a number in the
  display face renders `19:00` as `I9:OO`. `src/styles/base.css` asks `:root` for
  `lining-nums tabular-nums` and prose inherits it. **Form controls do not inherit it.**
  The UA stylesheet gives `input`, `select`, `textarea` and `button` their own `font`
  *shorthand*, which resets the property — so the declaration is not overridden there, it
  never arrives, and no ordering or `!important` on `:root` can reach it. The same file
  therefore carries a second rule naming those elements (plus `optgroup`, `option` and
  `::file-selector-button`); it is part of the fix, not a nicety (MUSE-57). Both rules
  stay in that one file: `font-variant-numeric` is a single value, so a component that
  redeclares it *replaces* the rule rather than adding to it — and the bug comes back
  with the column still neatly aligned. `npm run ds` rejects the property in a component;
  `test/numerals.test.ts` measures the glyphs, in prose **and** inside a control.

Header and footer sit on a band that is plum-ink in *both* themes, so they use the
`--band-*` roles rather than page-theme roles.

## Commands

```bash
npm run dev        # localhost:4321/MuseByMina/
npm run build
npm run preview    # dist, served the way Pages serves it — not `astro preview` (MUSE-52)
npm run typecheck  # astro check
npm test           # vitest — builds the site and asserts on dist
npm run a11y       # axe, every page, both themes — serves dist itself
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
- **The deploy host lives in exactly one file**, `astro.config.mjs`, as the overridable
  `SITE`/`BASE` default — which is what makes a domain move (MUSE-29) a config change
  rather than a search-and-replace. `sitemap`, `robots.txt` and `llms.txt` all derive
  their origin from it.

  **The guarantee is against `dist`, not against a list of directories** (MUSE-42).
  `test/seo.test.ts` builds under a second `SITE`/`BASE` and asserts the first host — and
  the first sub-path — appears nowhere in that output, every file of it, fonts included.
  That is the actual requirement, and it needs no list: it survives a renamed directory, a
  new top-level folder, a changed `publicDir`, and content arriving from Sanity rather
  than from a file. It used to be a hardcoded scan of `src/` and `public/` with a
  file-count floor, which could not tell "`public/` is absent" from "`public/` has four
  hundred unscanned files" and never read `sanity/` at all — so a host in a seed document
  rendered into all nine pages with the suite green.

  Alongside it, a **fast source scan** names the offending *file*, which a `dist` failure
  cannot. It walks the whole repository, taking its exclusions from `.gitignore`, so there
  is no scan list to keep exhaustive. Three paths may name the host and each is asserted
  to still need to: `astro.config.mjs`, `.github/workflows/deploy.yml` (where a
  *different* host is legitimately named — that is how MUSE-29 happens) and `test/`,
  whose copy is pinned to the config default. **Everything else fails, prose included** —
  a host in `logo/README.md` reaches no page and is still a failure; the reasoning is
  written out above that test and the `ORIGIN=` example in `README.md` was changed to
  `$SITE` rather than exempted.
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
- **The position of an `import` in a component's frontmatter decides CSS cascade order.**
  Astro orders the stylesheets it emits by import-crawl order — `cssOrder` sorts on the
  *sum of the import indices* from a CSS module up to the page — so adding or moving an
  import silently reorders the built `<head>`. It happened twice in one afternoon on
  unrelated tickets (MUSE-35 added a `?url` font import to `BaseLayout.astro`; MUSE-20 put
  a read-path import below `TrialForm` in `Contact.astro`) and one of the two shipped.
  There is **no config for it**: stylesheet order is not configurable in Astro, the import
  position is the only lever. So `import '../styles/globals.css'` is the **first** import
  in `BaseLayout.astro`, and `BaseLayout` is the first import in every page wrapper —
  Astro's own documented advice, and the order the design system needs, since
  `globals.css` is `@font-face`, the `:root` tokens and the element defaults that
  components override at equal specificity. `test/cascade.test.ts` asserts the resulting
  order against `dist` under both deploy targets, keyed on each stylesheet's **role**
  (global layer vs component-scoped) rather than its content-hashed filename, and the
  failure names the component whose imports moved. It also checks the order *inside* the
  shared chunk, because `BaseLayout.*.css` carries the globals and the header's and
  footer's scoped styles together and reordering those two leaves the head untouched.
- **Structured data is one module and one `<script>` tag** (MUSE-31).
  `src/lib/structured-data.ts` projects the `SiteSettings` singleton into JSON-LD and
  `BaseLayout.astro` emits it; `test/structured-data.test.ts` fails if a second `.astro`
  file writes an `application/ld+json` tag, because two emission sites are two answers to
  "does the markup agree with the page". It holds **no** studio details of its own — it
  takes the same memoised `getSiteSettings()` promise `Footer.astro` awaits, so the block
  and the visible page cannot disagree by construction. The suite compares them field by
  field anyway (street and city out of the `<address>`, the address out of the `mailto:`,
  `sameAs` against the `rel="me"` links — the same claim in two syntaxes) and then
  rebuilds the site from an edited dataset and demands both moved: that last assertion is
  the only one a hardcoded copy fails, since every equality test passes while the literal
  still happens to match (MUSE-50). Every URL inside a block comes from `localeUrl` — a
  hand-built one is a 301 and names something other than the page it sits on (MUSE-9) —
  and the 404 carries no block, for the same reason it declares no canonical.
  **`DanceSchool` is not a schema.org type** (it 404s; there is no dance type under
  `LocalBusiness` or `EducationalOrganization`) and an unknown `@type` fails *silently* —
  the validator reports a node with nothing recognised on it — so the studio is
  multi-typed as both and a test pins the names.
- The theme is stamped pre-paint by an inline script (`src/lib/theme.ts`). Never move that
  into a component — it exists to prevent a flash.
- **A browser check never takes a server it did not start** (MUSE-52). `npm run a11y`,
  `npm run shots` and `npm run ux:schedule` get their origin from `openSite()` in
  `scripts/dist-origin.mjs`: with nothing in the environment it serves `dist` from an
  in-process `node:http` host on an **ephemeral** port, the same shape
  `test/helpers/preview.ts` has always used — which is why the vitest suite was never
  exposed to this and the scripts were. `astro preview` daemonises here and **silently
  reuses a daemon on another port**, so `npm run a11y` audited a different agent's
  worktree and reported every route clean in both themes. **`npm run preview` is that same
  in-process host now, not `astro preview`** — the stale daemons were started by hand, so
  retiring it only inside the gates would have left the supply intact — and it 301s the
  unslashed spelling the way Pages does, which `astro preview` never did. Do not put the
  daemon back; the CI step starts none either and `test/origin.test.ts` fails if one
  reappears in the job, in an npm script, or if any browser script reads `ORIGIN` or names
  a port. `ORIGIN` is still how you point a
  check at a real server, and it is now **verified**: every URL the run will measure is
  compared byte for byte against the local `dist` and a difference fails naming both
  digests. `UNVERIFIED_ORIGIN=1` is the opt-out for the deployed site and the log says so.
  Identity is a hash the reader computes over the output tree — **never a stamp in the
  build**, because MUSE-20's byte-identical criterion is live; the suite fingerprints two
  independent builds of the commit and demands they agree. Note the direction of the one
  import that looks backwards: the GitHub Pages resolver lives in `scripts/dist-origin.mjs`
  and `test/helpers/serve.ts` re-exports it, because a `.mjs` script cannot import a `.ts`
  helper and two models of the host would drift (MUSE-9).
- **A browser check measures the page it names** (MUSE-48). `/` client-side-redirects to
  `/en/` unless the browser is Croatian, and every automation defaults to `en-US` — so a
  check that did not pin the locale opened the Croatian homepage, measured the English
  one, and labelled its results `/`. The primary page was the one page the tooling never
  looked at; MUSE-35's QA nearly filed the redirect's refetching as a font-preload bug.
  `scripts/browser-checks.mjs` is the only way to open a page: `openCheckPage(browser,
  site, route)` derives the locale **from the route** — the route is the intent, asking
  for `/en/` is asking for English — pins `navigator.language` *and* the stored language,
  and asserts after navigating that it landed where it asked. That assertion is the
  general half: it catches the next redirect too, whatever it is about. Two scripts used
  to carry a hand-written `addInitScript` line instead, which is exactly the shape of
  defence this repo has watched fail three times. So the module **owns Playwright** —
  nothing in `scripts/` imports it, and no file in `scripts/` or `test/` may call
  `newContext`, `newPage`, `addInitScript`, `setItem` or `chromium.launch`;
  `test/browserlocale.test.ts` reads both directories and fails if one of them opens its
  own browser, so a suite written next year inherits this without knowing it exists. Each
  check prints `describeMeasured()` beside its result, so the log names the page and its
  `<html lang>` rather than the route that was requested. `openRedirectProbe` is the
  deliberate opt-out that asserts nothing, for `test/lang.test.ts` and
  `test/localeswitch.test.ts`, whose subject *is* the redirect — it must be handed a
  browser language rather than defaulted one, and `scripts/` may not use it.
- **What `npm run a11y` audits is read off the build, and each page carries its URL and
  its status** (MUSE-55). It ran over `ROUTES` — two homepages by default, a
  comma-separated list in `ci.yml` whose own comment said "adding a page → add it". The
  error page was never on it and **could not be**: `site.url('/404')` spells
  `/MuseByMina/404/`, which the host answers 404 for because it is not a directory, and
  the gate asserted 200 for everything. Both of those are *correct* — the slash rule is
  MUSE-9 and the 200 was hard-won after the script reported "8/8 clean" against a stale
  server 404ing every route — so the page no happy path links to and every lost visitor
  meets was the one page nothing watched, right after MUSE-38 made it bilingual.
  `auditTargets` in `scripts/dist-origin.mjs` walks `dist` instead and hands back an
  `AuditTarget` per page: the **spelling** and the **status** both come from
  `resolveRequest`, so a page whose correct answer is not 200 is audited at it while
  anything *other* than the expected status is still a loud failure. There is no list to
  extend and `ROUTES` is gone from both the script and CI; `test/origin.test.ts` fails if
  either grows one back. The error page has no locale in its path and is bilingual
  markup, so it is audited **once per locale** — `/MuseByMina/404` (200) and
  `/MuseByMina/en/404` (404), both recorded host behaviours — and
  `test/browserlocale.test.ts` asserts the two arrivals get the same bytes, so the pin
  cannot quietly start selecting a language. `site.at(path)` is the only way to name a
  spelling that is not `pagePath`'s; `pagePath` is still the one place a slash is added.
- **"Should a crawler index this" and "may this page route by language" are two props**
  (MUSE-38). `BaseLayout.astro` takes `indexable` and `localeTwin`, and neither is derived
  from the other — `const localeRouting = indexable;` is the regression, it reads as a
  tidy-up, and `test/nav.test.ts` pins its absence against the source as well as the
  behaviour. `indexable` governs canonical, hreflang, `og:url`, JSON-LD and the sitemap.
  `localeTwin` governs exactly two things: whether the switcher renders, and whether
  `langInitScript` is handed a URL to navigate to. **`langInitScript` ships on every page**;
  `urlFor` answers `string | null` *per locale*, so "there is nowhere to send them" is a
  fact about each URL rather than a flag, and the one `go()` funnel enforces it. The error
  page is the only `localeTwin={false}` page there is, and it reads `?lang=`, folds it and
  persists it like everywhere else — it just does not move anybody, because `/en/404/` is
  itself a 404.

  **`404.astro` is bilingual, not client-side-selected.** One document serves both
  languages, and a bilingual body needs no mechanism, survives JavaScript being off and
  `localStorage` being blocked, has no flash of the wrong language, and gives each locale an
  exit link that resolves 200. A second way of deciding which language to show — separate
  from the redirect, living on one page — is how MUSE-38 happened in the first place: two
  individually-correct mechanisms answering one question between them.

  **A link that offers a language must name it, and `carryLocation` is the only place that
  rule lives** (MUSE-33, MUSE-56). The two exits were built with `localeUrl('/', l)` alone,
  which is asymmetric in a way that is invisible beside MUSE-38's criteria: `/en/` does not
  language-detect, so the English exit always worked, while the Croatian one points at the
  bare deploy root — **the single route on the site that does** — and handed the click to
  browser detection, which overruled it. An `en-US`, `de-DE` or `en`-storing visitor who
  deliberately pressed „Početna" was given the English site, and *neither* exit persisted
  the press. This is the second time a bare homepage href has been reinterpreted; MUSE-33's
  middle-click case was the first. So the guard is the class, not the instance:
  `test/lang.test.ts` reads every page in a browser and fails if a link the page has
  **marked with a language** — `lang` on the anchor or on an ancestor below `<html>`, or
  `hreflang` on the anchor — has an href that does not name that language. Marking rather
  than "crosses locales", because `/` from an `hr-HR` document crosses nothing and is
  exactly the href that broke; in a browser rather than against `dist`, because the
  switcher's `?lang=` is attached on load and the error page's is stamped at render time,
  and the href the browser would navigate to is the one level both are true at. The census
  is pinned too — two exits on the error page, one switch everywhere else — because a guard
  that finds no affordances passes.

  **The error page's monolingual chrome is deliberately not stamped.** Its logo, nav and
  CTA have the identical exposure (`/` and `/#trial` land on the detecting route) and are
  not a language affordance: each is offered once with no counterpart, so following one
  asserts nothing about language, where the exits are a pair and pressing one is a choice.
  There is also no 404-only chrome — stamping it would stamp every Croatian page, which
  would freeze an `en-US` visitor who followed a shared Croatian deep link into Croatian
  the moment they clicked the logo, i.e. break the cohort MUSE-38 exists for. A pressed
  exit stores the language and a stored choice outranks the browser, so the fix governs the
  chrome from the first press anyway; `test/lang.test.ts` pins that composition and pins
  `#trial` surviving the CTA's redirect in both directions (MUSE-10).

  The **footer** marks the current route with `aria-current="page"`, because `/privacy/` is
  reachable only from there (the nav omits it on purpose, MUSE-7) and nothing else on the
  site can mark it. It stays an `<a>`: MUSE-39's rule is that whatever carries
  `aria-current` must either not be a link **or be a link to exactly where we already
  are**, and a footer entry for the current route is the second. It is also `/privacy/`'s
  only self-reference, which `test/nav.test.ts`'s orphan rule is calibrated against.
- **The host model serves the error page's *body* on a 404** (MUSE-38). `resolveRequest`
  returns `404.html` as the `file` on a 404 inside the deploy's prefix, the way GitHub Pages
  does; outside the prefix it returns no body, because that URL space is not ours (MUSE-8).
  It used to answer the status and invent the body, so no browser suite in the repo could
  reach the error page at all and an all-Croatian 404 was only reproducible against the
  deployed site. Drive it with `test/helpers/preview.ts` and an unknown path.
- **A test never chooses where it builds.** `npm test` runs ten real `astro build`s in
  parallel workers; `test/helpers/scratch.ts` mints a directory per build with `mkdtemp`
  and passes each one its own cache root, so two suites cannot share an output tree and
  nothing has to be wiped. There is nothing to remember here — that is the point. This
  bug was fixed three times as a naming convention (MUSE-9, MUSE-10, MUSE-17) and came
  back twice; `test/isolation.test.ts` now fails if a suite names a build directory,
  deletes anything, or spawns its own build.

  **The cache root is the half that actually fixed it, and it lives in
  `astro.config.mjs`** — two lines taking `cacheDir` and `vite.cacheDir` from
  `BUILD_CACHE_DIR`. `outDir` never was the whole story: Astro's and Vite's caches derive
  from the *project root*, so no per-suite output name can isolate them, and Vite's dep
  optimiser commits by renaming `node_modules/.vite/deps` aside and deleting it under the
  other nine builds. Until MUSE-34 nothing asserted those two lines — deleting them left
  all ten files and 204 tests green with the shared cache back. They are now checked twice:
  the config is evaluated with the variable set and unset, and a real build has to leave
  its caches under the directory it was given. ("Afterwards `node_modules/.astro` does not
  exist" was tried and rejected — `npm run build` creates it legitimately and vitest
  creates `node_modules/.vite` itself, so the absence check is vacuous or flaky depending
  on what ran first.)

  **The guard reads syntax, not words** (`test/helpers/source-guard.ts`). The old scan
  searched raw text for `rmSync`/`rmdir`/`promises.rm(` across `test/**/*.ts`, which was
  wrong in three directions at once: an `.mjs` helper was never walked, `import { rm }
  from 'node:fs/promises'` matched no needle, and a doc comment mentioning `rmSync` failed
  CI while a real `rm` beside it passed. Rules are now stated against an import's
  *exported* name, a call's callee and a string literal's value, so an alias cannot hide
  and prose cannot trip them; every extension under `test/` must be declared parsed,
  markup or inert, so a file nothing reads is a failure rather than a blind spot. The
  textual scan survives as a *tripwire* over comment-blanked code — it is what catches an
  `rm -rf` handed to a shell — and the guard's own behaviour has tests, including the
  evasions MUSE-34 demonstrated. One trap if you edit it: blank comments from the
  **parser's** comment ranges, never a bare `ts.createScanner` loop, which desyncs on the
  first template literal with a substitution and then reads every comment as code.

  **`globalSetup` prunes by age; it does not empty the scratch root.** The root was the
  last shared mutable path in the design, and emptying it meant a second vitest in the
  same checkout — `--watch` in another terminal, or a second agent in one worktree —
  deleted the first one's builds mid-flight, which is MUSE-17's flake wearing a different
  hat. An hour is fifteen times the longest a build can live, needs no lock and no pid
  file, and cannot reach anything a live run could still be using.
- **A browser suite waits for a condition, never for the clock** (MUSE-54), and
  `test/helpers/browser-settle.ts` is the only place it waits. Three suites flaked in one
  afternoon with no code in common and one defect in common: a measurement taken at a
  moment. The helper samples on the page's own `requestAnimationFrame` clock, because
  everything these suites wait for — a smooth scroll, a CSS transition — is produced by
  that clock, so on a loaded box the animation and the sampling of it starve *together*.
  Measured: under a starved renderer a smooth fragment scroll does not begin for three to
  seven frames after the click — 90 ms at 10× CPU throttling, 350 ms at 80×, **1272 ms at
  150×** — and the deleted helper's entire defence against that was a fixed `150` with a
  25 ms poll behind it, whose exit condition ("two equal reads") the unmoved page
  satisfies. It then returned the page still at the top, which is exactly the symptom
  MUSE-50 reported. `minFrames` is that pause counted in frames instead, so the margin
  survives the load; the wall clock appears only on the failure path, where it bounds how
  long a *failure* takes to report and the message names the condition and the last thing
  observed. `fixedSleeps` in `test/helpers/source-guard.ts` keeps new sleeps out — as a
  rule about a *call*, so the sentence explaining why a sleep was removed can stay in the
  file it was removed from. What that rule cannot reach is written out beside it and
  asserted: a measurement that never waited at all, a fixed-interval poll spelled with
  `setTimeout`, and a correct wait given too small a budget.

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
- **`siteSettings.address` is one field, rendered on five surfaces.** `addressLines`
  (`src/lib/sanity/decode.ts`) splits it on its one comma for the footer's two-line
  `<address>`; `ADDRESS_PATTERN` makes the Studio refuse what the build would refuse. The
  rule exists because a CMS field nothing renders is worse than no field — it looks like it
  works. Only `country` (a translated word) and `maps` (no field in the schema) are still
  code, in `STUDIO`.

  It said **four** until MUSE-50: `/schedule`'s hero eyebrow spelled the street as a
  literal inside a composed label („Raspored · …"), and MUSE-20's review found its
  surfaces by grepping for the identifier `STUDIO.street`, which a string buried in a
  longer string does not match. **The guard for this existed and was green** —
  `test/content.test.ts` scanned `src/` for the seeded values — because its needle was the
  whole field while the copy was the street half, and because its field list was written
  by hand, so `class.slug` and `scheduleSlot.start` were never on it.
  `test/contentdrift.test.ts` replaces it: a **registry** of every string field in the
  seed, each one classified as CMS-owned or legitimately-in-code with the reason beside
  it, the completeness of that classification asserted so a new field forces the decision,
  the needles including what the read path *derives* (the street, not the city — „Zagreb"
  is a declined word in the homepage h1 and the regulator's address in the privacy
  notice), every exemption asserted still live, and a failure that names `file:line`. The
  same file rebuilds the site from an edited address and demands all five surfaces move,
  which is the only assertion a literal fails while it still happens to match.
- **A component can be built before its page can be routed** (MUSE-23). `/aboutus` is
  built and deliberately not published: its `studioStory` and `instructor` documents do
  not exist, the read path fails the build naming a missing document, and a routed page
  would therefore stop `main` building — every PR, every deploy, every scheduled rebuild.
  `MUSE_PREVIEW_ROUTES=aboutus npm run build` injects `/aboutus-preview` so the component
  can still be asserted on against `dist`, which is the only way to check CSS — Astro's
  container API renders markup without the stylesheet pipeline. `src/lib/preview.ts` is
  the registry, the entry points live under `test/` so `test/seo.test.ts`'s page list
  cannot see them, and unset the variable injects nothing. **Delete the entry with the
  ticket that routes the page**; an entry that outlives its ticket is a page nobody
  shipped.
- **An optional field is a decision, not laziness.** `instructor.portrait`,
  `instructor.instagram`, `instructor.bio`, `class.description`, `class.image`,
  `siteSettings.phone` and `openingHours` are optional because no real value exists for
  any of them, and a `required()` field with no value can only be filled with fiction —
  which is how MUSE-36 happened. The last three came off the required list *in* MUSE-36:
  seeding two real instructors meant a required bio could only be satisfied by writing a
  paragraph about a real person to get past a validator, and the homepage style cards were
  the only consumer `class.description` and `class.image` ever had.

  The cost is paid in the page: the 3:4 placeholder frame in `AboutUs.astro` reserves
  exactly the box a photograph will take, and a bio that has not been written is a card
  that is a name and a role rather than a gap. Making one required later is a schema
  change plus a
  line moved back onto the `Guaranteed` list in `src/lib/sanity/shape.ts` — and note the
  `OptionalIn<>` assertions beside it, which exist because a field with no assertion at all
  is a field nothing watches: delete `instagram` from the projection and the generated type
  simply stops having the key.
- **The schedule is in Sanity, and `src/data/schedule.ts` is gone** (MUSE-36). It held
  thirteen invented classes across five days naming two instructors who do not exist, and
  it was live. What is published now came from Mina: four classes, two evenings, 90
  minutes each, Mina **and** Antonio on every one.

  ```
  PONEDJELJAK   Beginner      19:30–21:00
                Intermediate  21:00–22:30
  ČETVRTAK      Improver      19:30–21:00
                Advanced      21:00–22:30
  ```

  Four things follow from it that are easy to undo by accident:

  - **`LEVELS` has four entries, in dancer order** — `beginner → improver → intermediate
    → advanced`. The order drives the grid, the Studio dropdown and the homepage doors, so
    a new level is *inserted*, never appended. `LEVEL_PREREQUISITE.improver` is the one
    string on the site nobody has confirmed with Mina; it is marked as such in
    `src/lib/schedule.ts`.
  - **There is no `STYLES`.** `['traditional','moderna','sensual']` was invented with the
    rows and had shaped a filter, three homepage cards and a required `class.style` field.
    `test/sanity.test.ts` asserts no field anywhere in the schema is named after a style,
    so it cannot come back without the decision being made again.
  - **`instructors` is an array** on `class` and on `scheduleSlot`, and the override
    *replaces* rather than adds. Not for today's data — for lady styling, a confirmed
    coming class that Mina teaches alone. `formatNames` in `src/lib/schedule.ts` joins
    them („Mina i Antonio" / "Mina and Antonio"); a comma-joined list reads as a label.
  - **Both pages take the rows as a prop with no default.** `/schedule` and `/` pass
    `await getSchedule()`. The old default was what made it possible to render the page
    before anyone had asked the studio what it teaches.

  And one behaviour changed with it: **a homepage door whose level has no class is
  dropped, not a build failure.** MUSE-11 threw, correctly, while the rows were a file in
  this repository. `scheduleSlot.active` is the field Mina uses for a summer pause, so the
  same rule would now mean an ordinary Studio edit stops the site building. The section
  going *empty* is still a build failure — see the note in `Home.astro`.
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
- **Enums are structure and stay in code.** `LEVELS`, `WEEKDAYS` and the route list are
  imported *into* the schema from `src/lib/schedule.ts` and `src/lib/pages.ts`
  (`sanity/schemaTypes/enums.ts`), so the Studio offers a fixed list and Mina cannot type
  a level. `STYLES` was a fourth and MUSE-36 deleted it — a closed set belongs in code
  because the site *branches* on it, not because it is short, and the three styles were
  invented rather than taught. Prerequisites, form copy, and time/currency formatting are deliberately **not**
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
- **A query may not run without the parameters it references** (MUSE-51), and the check is
  in front of *both* read paths — `requireQueryParameters` in `src/lib/sanity/params.ts`,
  called by `runQuery` before it chooses a source. Omit `$now` and the live API refuses the
  request (HTTP 400 `queryParseError`) while `groq-js` answers `[]`, so one mistake used to
  surface as two error classes — and offline it surfaced *only* because `minimum` defaults
  to 1, which made `requireDocuments` report it as "an empty dataset, not a broken query".
  With `minimum: 0`, which `getEvents` explicitly supports, it was silent and published a
  blank page. **The count check cannot be the instrument here**: it fires on a legitimate
  zero-document result and says nothing about a broken query, so the parameters are checked
  before the query runs, which is the only point at which the two cases are distinguishable.
  `queryParameters` scans the query text rather than parsing it, because `groq-js` is a
  devDependency the live path must not need — and `test/projections.test.ts` pins the scanner
  to the real parser, query by query, so a parameter shape it cannot see is a red test.
  **The register of known `groq-js`-vs-live divergences is the header of
  `src/lib/sanity/fixture.ts`**; there are two, both found by someone deliberately looking.
  Add the third there.
- **A missing or malformed document fails the build naming itself** — `_id`, type and
  field path — through `src/lib/sanity/decode.ts`. "Unreachable", "empty" and "malformed"
  are three different error types on purpose: much of the dataset is still empty, so
  "nothing on the page" has to be readable as which of the three it was.
  `referencedTextList` is the one to know about for the schedule: `instructors[]->name`
  answers `null` for an absent field, `[]` for an empty array and `[null, 'Mina']` for a
  deleted reference, and a page joining the names would publish „ i Mina" for the third —
  so the error names the index.
- **Every dereference in `queries.ts` is projected beside its `_ref`** — `author->name`
  next to `"authorRef": author._ref` — and that pair is the whole of MUSE-49. Sanity does
  not clear a reference when its target is deleted, and GROQ answers a broken one with
  `null`, so for an **optional** reference a deleted target and a field nobody filled in
  arrive as the same `undefined` — and an optional field is *allowed* to be empty. A
  deleted author therefore published the post **unsigned**, with nothing said. The `_ref`
  is the missing evidence: **present with a `null` value is dangling, both absent is an
  empty optional field.** A dangling one fails the build naming the document, the field
  path and the deleted `_ref`; see the paragraph on `failDangling` in `decode.ts` for why
  it is fatal rather than a warning, and note that the message says *clearing the field* is
  a valid fix, because for an optional reference it is.

  Three things not to undo. **The pair must stay a pair** — delete a `*Ref` line and
  `decode.ts` fails every row saying the query is broken, while `RefProjected` in
  `shape.ts` stops compiling; either half alone has stopped saying which case it is.
  **Arrays are read positionally and the two lengths are compared**, because a *compacted*
  list is the one failure here with nothing blank to notice: dropping a deleted teacher
  rather than blanking her publishes „Mina" for a class she and Antonio teach — true,
  incomplete, and indistinguishable from a class she teaches alone. And **`instructors`
  being an array is load-bearing beyond two teachers**: `instructors[]->name` over a
  deleted reference is `[null]`, a *non-null* array, so the slot's `coalesce` keeps the
  override instead of falling through to the class's regular teachers. Revert the field to
  a single reference and `/schedule` is back to publishing a real name that is the wrong
  name — which is what `AssertScheduleInstructorsAreAList` guards.
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

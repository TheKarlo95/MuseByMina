# The content model

**This file is the argument, not the rule.** Each rule is stated in `CLAUDE.md`, which
every agent reads; the reasoning, the measurements and the alternatives that were weighed
and rejected live here. Read the section that covers what your ticket touches.

Nothing here is decoration. Each passage records a defect that recurred, or an approach
that was tried and failed, and the cost of rediscovering it is the cost of the original
bug. Do not shorten a passage to tidy it up — if something is genuinely stale, that is a
ticket (MUSE-114 is the open instance).

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

  **Three lists, four disagreements, and `src/pages/` is the only one that cannot lie**
  (MUSE-46). `test/routes.test.ts` holds them to each other and every check is anchored on
  the filesystem. A route in `ROUTES` with **no file** under `src/pages/` used to publish an
  `llms.txt` link to a 404 — silently, because `test/seo.test.ts` only ever looked each
  built page *up* in `llms.txt`; it now resolves every URL that file advertises through the
  model of GitHub Pages and requires a 200, and asserts set equality over page URLs in both
  directions. The partition between a page link and `robots.txt`/`sitemap-index.xml` is
  "does the URL end in a slash", which is the site's own URL shape rather than a list of
  filenames to keep current. A preview route (`MUSE_PREVIEW_ROUTES`) is neither a ghost nor
  a missing page: its entry point is under `test/` and its URL carries `-preview`, and both
  halves are asserted.

  **A `page` document for a route the site does not serve is a warning, not a failed
  build.** Two instruments, neither sufficient alone. The Studio refuses the route —
  `oneOf(Rule, ROUTE_VALUES)` in `sanity/schemaTypes/enums.ts`, which is `Rule.valid()`
  past a gap in Sanity's `StringRule` type; `options.list` is the dropdown, not the
  contract. That reaches Mina while she is typing but cannot cover the other order of
  events: a developer deletes a route and yesterday's valid document is inert today. That
  lands in a PR, so the PR's build log gets it. **Do not promote it to a failure** — the
  document publishes nothing (`getPageMeta` walks `ROUTES`), so a fatal check would let a
  stale CMS row stop every unrelated PR, every deploy and MUSE-21's scheduled rebuild over
  a provably inert condition; `test/routes.test.ts` pins that the ghost build is still
  byte-identical, for exactly that reason. Sanity turns out to *infer* a `valid()` rule
  from `options.list`, so a pasted route was already refused — under the `required()`
  rule's message, the one written for an empty field — and nothing in the repo knew either
  way until the suite started running Sanity's real validator (`@sanity/validation`, a
  declared devDependency for the same reason `styled-components` is one). `ROUTES[].
  studioLabel` duplicating each document's `name.hr` was looked at and left: it is a
  fourth copy of a *label*, not of which pages exist, it has to name a route whose
  document does not exist yet, and tying them would make Mina rewording a page's short
  name a red build.

  `Build.log` in `test/helpers/build.ts` is how an acceptance criterion about what the
  build *says* on success gets read off a real build — the counterpart to `buildFailure`.

- **The build reads Sanity, so a Sanity outage blocks every PR and every deploy.** Three
  jobs run `npm run build` and it fetches live; there is no cached snapshot and no retry of
  our own beyond `@sanity/client`'s defaults. That is the deliberate trade — the
  alternative is publishing pages with empty titles, which `src/lib/sanity/decode.ts`
  exists to refuse — but it is a real availability dependency, and the `continue-on-error`
  probe step in `ci.yml` no longer protects anything from it.

- **It reads the *uncached* host, and that is a correctness setting, not a tuning one**
  (MUSE-81). `useCdn: false` in `src/lib/sanity/client.ts`. The cached read host is
  eventually consistent, so a build starting inside the refresh window after a publish
  reads the **previous** revision and publishes it with every gate green — 200 from the
  API, every document present, nothing for `decode.ts` to object to, `deploy.yml`'s alert
  silent, because nothing failed. Observed: an import verified in the dataset at 10:12, a
  successful rebuild at 10:13, the old text live at 10:14, correct after a second rebuild
  at 10:18. What that breaks is **MUSE-21's promise**: the cron fires at `20 1,7,13,19`
  and Mina is told a *duration*, so an edit published shortly before a run can be read
  pre-publish by that run and wait six hours more than the maximum she was given. The
  comment this replaced argued the opposite and its flaw is worth keeping in mind — it
  reasoned about the *expected* gap between an edit and the next build, when the thing
  being promised is the *worst* one.

  `useCdn` is now the literal type `false` in `SanitySource`, the way `perspective` is
  `'published'`: the two settings here whose loss is silent, each pinned at compile time
  and again by a test. The cost was measured rather than waved away, because the cost is
  the whole argument — five interleaved pairs of real `astro build` runs, median 2.70 s
  cached against 3.13 s uncached, which is **+0.43 s** and inside the noise of a fifteen
  second `npm run build`. The **`[content]` line names the host** beside the dataset, and
  that is the only place „was this build's content current?" can be answered after the
  fact; `contentEndpoint()` asks the client's own `getUrl()` rather than restating the
  rule that turns the flag into a hostname. **Every script reads the same host through
  `queryUrl` in `scripts/seed-compare.mjs`** — `scripts/sanity-read-check.mjs` wrote its
  own URL against the cached one, which could make it report `EMPTY` for a document that
  was in the dataset, the single verdict it exists to tell apart from a broken query.
  `test/endpoint.test.ts` fails on the cached hostname appearing anywhere under `src/` or
  `scripts/`, **prose included**, for `test/seo.test.ts`'s reason; say „the cached host"
  instead.

  **A post-deploy check comparing the published bytes against the dataset was weighed and
  declined.** It would have caught this one, and the ordering objection is real: the
  dataset legitimately moves between a build and a check, so the naive comparison goes red
  on Mina's ordinary evening edit — the loudest possible false alarm, since MUSE-21's
  response to a failed deploy is an assigned issue. The honest version needs each
  document's `_rev` captured at build time *plus* the build's start instant, so that „we
  read a superseded revision" (fatal) can be told from „she edited after we read" (fine) —
  a new build artefact and a new workflow job, to detect a failure the type pin above now
  makes structurally unreachable, and one that **cannot be exercised at all** without a
  content-write token this project deliberately does not have (MUSE-21, MUSE-45). A gate
  nobody can test is a gate that rots, and this repository has three recorded instances of
  exactly that. The proportionate half shipped instead: the log now names the endpoint, so
  a stale deploy is diagnosable after the fact from the build log alone.

- **The seed lives in `content/`, not in `sanity/`, and that is load-bearing** (MUSE-45).
  `scripts/check-sanity.mjs` hashes every file under `sanity/` with **no extension
  filter** — the MUSE-19 rule — and the fingerprint it produces means one thing: *the
  generated artefacts still describe the schema*. Every consumer was written for that one
  meaning, so while the seed sat at `sanity/seed/content.ndjson` a reworded page title
  failed the build until the types were regenerated, made CI print „The Sanity schema
  changed" at somebody who had not been near the schema, and triggered `studio.yml` —
  **the one job that uses `SANITY_DEPLOY_TOKEN`, a write credential** — republishing the
  Studio Mina may have had open. **Do not fix the next instance of this by teaching the
  walk to skip something:** the sweep's whole value is that it has no exceptions, and a
  skip list is MUSE-19's allow-list wearing the other hat. Move the file instead, so
  *"every file under `sanity/` is schema source"* stays true. `test/sanity.test.ts`, "keeps
  the content seed outside the schema fingerprint", states it against
  `MUSE_CONTENT_FIXTURE` rather than a path literal — the file the run actually reads and
  the file `npm run sanity:seed` imports — and checks all four surfaces: `fingerprint()`,
  the committed stamp, `SOURCE_GLOBS` and `studio.yml`'s `paths:`.

- **The seed is both the migration and the test fixture.** `content/seed.ndjson`
  holds every document that exists — the `siteSettings` singleton, the `page` documents,
  the timetable (MUSE-36), the two `pricingTier` documents (MUSE-59) and the `studioStory`
  singleton (MUSE-60) — and `npm run sanity:seed` imports it, replacing by `_id`, so the
  migration is reviewable and re-runnable. `vitest.config.ts` points every test build at that same file
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

- **A dev server re-reads content per request; a build memoises exactly two readers**
  (MUSE-47, MUSE-94).
  „Each reader is memoised for the life of the build" was read as a property of the
  module, and a dev server is also one process that lives for days: measured, three
  reloads of `/schedule/` issued `PAGES_QUERY` once, `SITE_SETTINGS_QUERY` once and
  `SCHEDULE_QUERY` three times, so the timetable followed the Studio and the `<title>`,
  the footer and the JSON-LD did not. *Partly* fresh is what reads as „my change didn't
  save". Both caches are per-build now — `perBuild` in `src/lib/sanity/index.ts` and
  `dataset()` in `fixture.ts`, which froze everything on its own — and the `[content]`
  line names which regime is in force, which is how `test/devcontent.test.ts` asserts it
  off a real `astro build` and a real `astro dev`. One dev-only cost, documented rather
  than fixed: the footer and `structured-data.ts` are then two `SITE_SETTINGS_QUERY`
  calls per render rather than one shared promise.

  **„Each reader" was false, and the build log and a test both said it anyway (MUSE-94).**
  Only `getSiteSettings` and `pagesByRoute` go through `perBuild`; the other thirteen
  readers — one per query in `queries.ts` — re-query on **every call**, in a build exactly
  as under a dev server. Measured with `runQuery` instrumented, from a seed build and a
  live build that agreed to the query: **twenty-nine queries to a build** —
  `scheduleSlot` 6, `event` 6, `post` 5, `studioStory` 2, `prosePage` 2, `pricingTier` 2,
  `instructor` 2, `galleryImage` 2, `siteSettings` 1, `page` 1. The two ones are the whole
  of the memoisation. The announce line said „each reader is queried once and memoised for
  this process", and the only assertion about the memoisation was
  `expect(buildLog).toMatch(/queried once and memoised/)` — a test matching the sentence
  that made the claim, which is MUSE-50's shape in a suite rather than in a component.
  Nothing could have contradicted it: QA replaced the gate with the spelling `dev.ts`
  forbids and the file stayed 18/18 green.

  **The sentence was changed and the readers were not, and the reason is not thrift.**
  `perBuild` keys on nothing, so it cannot memoise a reader that takes an argument, and
  `getEvents`, `getPastEvents` and `getPosts` each take a `now` that goes *into* the
  query — a cache ignoring it would answer one instant's question with another's, which is
  the opposite of why `now` is a parameter (MUSE-20). For the remaining ten the decision
  is already written beside each one: `test/projections.test.ts` swaps the fixture per
  test, so a memoised reader answers the second test from the first test's dataset, and
  that suite says so about the two readers that *do* memoise. Measured cost of leaving the
  seventeen repeats: a live build spends about **1.6 s inside `runQuery` in total**, on an
  `npm run build` that `astro check` dominates. So the log now names the two readers, and
  `census` in `client.ts` prints the count as the build exits — from the process that did
  the counting, because `astro.config.mjs` is a separate module graph and an integration
  hook would hold a copy of the counter that is permanently zero. `QUERIES_PER_BUILD` in
  `test/devcontent.test.ts` pins the number with its measurement beside it, the shape
  `scripts/budget.mjs` uses: adding a page or a reader moves it, and moving it is then a
  deliberate edit rather than a drift nothing reports.

  **MUSE-81's arithmetic was computed from the wrong count and is corrected in
  `client.ts`.** Thirteen was how many *distinct* queries `queries.ts` held, not how many
  a build issues; four scheduled builds a day is **~3,400 requests a month**, not ~1,600.
  The conclusion survives untouched — the read volume the CDN exists for is still not this
  site's — and the whole-build measurement behind it, +0.43 s uncached, was taken on real
  builds and so already contained all twenty-nine queries.

  **Anything that logs from inside a memoised reader now needs to say which it meant.**
  MUSE-46's inert-`page`-document warning sat in `pagesByRoute`, where "warn when it
  happens" and "warn once" had been one sentence; per request they are two, and it would
  otherwise repeat on every reload into the stream the `[content]` line is in. The guard is
  the `inertWarned` comparison beside it, and it is keyed on **the message, not on a
  count**: "once per process" is MUSE-47's own defect in miniature — a log still reporting a
  condition that stopped holding the moment you fixed the document and reloaded. So a
  *changed* warning prints, an identical one does not, and a fixed one goes quiet.
  `test/devcontent.test.ts` drives two different inert documents through one dev session,
  because de-duplicating on "have I ever warned" passes the repeat count and then goes
  silent about the second one. A build is byte-identical to MUSE-46's, which is where
  `test/routes.test.ts` asserts it.

  **The gate is `import.meta.hot` (`src/lib/sanity/dev.ts`), and that is the whole
  point.** `NODE_ENV`, `process.argv` and `npm_lifecycle_event` all tell `astro dev` from
  `astro build` just as reliably — all three measured — and all three are settable by
  whoever starts the build, which disqualifies them for a gate deciding whether content
  may come from a file in the repository. Nothing in a workflow or a script can produce
  an HMR handle. It is not what `test/sanity.test.ts` forbids — that rule is about reading
  *configuration* off `import.meta.env`, which Vite substitutes into client bundles.

  **The spelling is a convention, and the reason given for it was false (MUSE-94).** This
  said: write the literal `import.meta.hot`, because Vite's dev transform rewrites that
  exact member access and so `'hot' in import.meta` is **false** in dev. Measured — with
  `dev.ts` reduced to the in-operator and no literal `import.meta.hot` left in the file,
  comments included, since Vite's injection decision is a source scan — a real `astro dev`
  on Astro 7.3.6 answered `in-operator says true`, with `hot` present in
  `Object.keys(import.meta)`, and selected the dev regime correctly. All three spellings
  behave alike. Write the literal anyway, because it is the form Vite documents and
  statically understands and the others rest on the dev-SSR `import.meta` object happening
  to carry the property; but that is a preference and **it is marked unguarded in
  `dev.ts`**, because no test can distinguish behaviour that is identical, and a guard
  would want a dev server and a probe route against zero headroom in
  `test/helpers/concurrency.ts`. What *is* guarded is the property the gate needs: that it
  cannot be produced from the environment, which `test/devcontent.test.ts` asserts off a
  real `NODE_ENV=development` build's log.

- **Offline dev is `MUSE_CONTENT_FIXTURE=content/seed.ndjson npm run dev`, and
  MUSE-47 deliberately built no mechanism for it.** No fallback (a build that substituted
  the seed for an unreachable dataset is the deploy MUSE-20's four barriers exist to
  prevent), no `dev:offline` script (barrier 3 forbids a `package.json` script from
  assigning the variable, correctly), and no second gated boolean — it would buy forty
  characters of typing and cost a name every future guard has to remember. Discoverability
  is carried by the error instead: `runQuery`'s unreachable-API message prints that command
  **only under a dev server**, because a deploy log must never propose publishing the seed,
  and `deploy.yml` greps that same error to retry. `test/devcontent.test.ts` asserts the
  hint names a seed that is really there and the one `vitest.config.ts` reads.

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

- **Routing a page is two pull-request-shaped halves, and the dataset goes first**
  (MUSE-59, MUSE-60). The build fetches live, so the route and the documents cannot land
  in the same push: the moment `/pricing` was in
  `ROUTES`, every build without a `page` document and two `pricingTier` documents in the
  **live dataset** failed — each PR, the deploy, the scheduled rebuild. So the branch
  prepares `content/seed.ndjson` *and* the route together, says in the PR body that it
  must not be merged yet, and somebody runs `npm run sanity:seed` between review and
  merge. **An agent does not run that command**: it writes to Mina's content, replacing by
  `_id`. `test/pricing.test.ts` keeps the trap as a test — the route with the documents
  removed must fail naming `pricingTier`, and must not carry `TRANSIENT_BUILD_FAILURE`,
  because MUSE-21's retry would otherwise spend three attempts on a dataset that will not
  seed itself.

  **MUSE-60 ran the same sequence for `/aboutus` and found why it matters beyond a red
  build.** The live dataset already held a `studioStory` — created outside any seed,
  carrying `foundedOn: "2025-01-01"`, a founding date nobody has confirmed, and
  paragraphs reading „PLACEHOLDER … nije istinit". It published nothing only because
  the route did not exist. Had the route landed without the seed import, the build
  would not have failed on *that* document — it would have rendered it. So the half of
  the rule that reads as bureaucratic is the load-bearing half: **the dataset is
  authoritative at build time, and a document nobody reviewed is a page nobody
  reviewed.** `npm run sanity:seed:check` is how you find that out before merging, and
  it is worth reading rather than glancing at.

- **Editing content in a branch is two steps and the order is the whole of it: import,
  then merge** (MUSE-78). An **edit to a document that already exists publishes the old
  value successfully**, and had no signal anywhere:
  green PR, green suite, the new text in the diff, the old text on the page. So, for a
  branch that touches `content/seed.ndjson`:

  1. `npm run sanity:seed` — **before the merge**, not after. `--replace` is keyed on
     `_id` and the documents already exist, so importing content whose PR has not landed
     is safe; it is an edit to copy, and the site reads copy from the dataset either way.
  2. Merge. The push deploy is a build, and a build is the only thing that reads the
     dataset, so that build is the one that publishes it. No stale window.

  **Importing after the merge is not enough, and that is the part that caught somebody.**
  MUSE-71 merged at 08:34, the deploy fetched the dataset immediately, the import ran at
  08:41, and the live page still carried the retired claim at 08:42 — everything green.
  Left alone it would have corrected at the next scheduled rebuild, up to
  `MAX_WAIT_HOURS` later, with nothing indicating staleness; it took a
  `workflow_dispatch`. So merging first makes it **three** steps — merge, import, then
  Actions → Deploy to GitHub Pages → Run workflow — and the last is the forgettable one,
  because the import succeeds and looks like the end of the job.

  `npm run sanity:seed:release` is the gate, a step in `ci.yml`'s `sanity` job, and it
  **blocks** — which `sanity:seed:check` beside it still must not (MUSE-45: a Studio edit
  may never fail a deploy). The two are different claims and the difference is
  *direction*. `DRIFTED` is one word for the dataset being ahead, which is Mina editing
  and is nobody's blocker, and the seed being ahead, which is our unshipped change and
  is. The seed is in git, so authorship comes from the diff against the merge base and
  needs no credential: **a value that differs from the dataset *and* from the merge base
  is ours.** A branch that does not touch the seed cannot fail the gate however far the
  dataset has drifted. When both have moved the message says so instead of choosing — on
  one field it prints all three values and asks for the decision to be written into the
  seed; on different fields it warns that the import is `--replace` over the **whole
  file**, so shipping our two fields reverts whatever else Mina changed. It fails open on
  an unreachable API (`npm run build` is already red everywhere on an outage) and it is
  structurally read-only: **auto-seeding on merge was rejected**, because it needs a
  content-write token in CI and MUSE-21 and MUSE-45 both exist to keep one from
  appearing. Do not add one.

- **The build is not the second guard MUSE-78 thought it was: it catches a missing `page`
  or `prosePage` and nothing else** (MUSE-83). MUSE-78's reasoning, its pull request and
  the paragraph that went into `CLAUDE.md` all said an *added* document was safe by
  accident — the build refuses to run without it, so the deploy cannot publish stale
  content. That is true of two document types. The real matrix, measured rather than
  reasoned:

  | the seed change | `npm run build` | what the deploy publishes |
  | --- | --- | --- |
  | adds a `page` / `prosePage` | **fails**, naming the route | — |
  | adds any other document type | passes | the page without it |
  | edits any document | passes | the old value — MUSE-78's subject |
  | removes any document | passes | the document, still |

  `page` and `prosePage` are looked up **by route** — `getPage(route)`,
  `getProsePage(route)` — and `ROUTES` is code, so a route whose document is missing has
  no substitute and the build says which route. Both readers pass `minimum: 0` precisely
  because counting is the wrong instrument for a lookup that knows which document it
  wants. Every other reader counts, `minimum` defaults to 1, and **one existing document
  satisfies it** — so a fourth `pricingTier` in the seed against three in the dataset
  builds green and publishes three cards. Those two types are the ones every previous
  seed addition happened to involve — MUSE-59, MUSE-60, MUSE-65 — which is why the
  protection looked general.

  Proven offline, each row, by pointing a build at a fixture standing in for the
  un-imported dataset (`MUSE_CONTENT_FIXTURE`, which is what every test build reads):
  the seed minus `page-pricing` exits 1 inside `getPage`; minus `prose-whatisbachata`
  exits 1 inside `getProsePage`; minus `pricing-dropin` exits **0**, builds 23 pages and
  publishes two rate cards where the branch's seed has three; with `page-home.description`
  held at its old value it exits 0 and that old sentence is the `<meta name="description">`
  in `dist`.

  **Do not close the gap by lowering a `minimum` elsewhere, or by making an empty
  collection fatal.** `getEvents` deliberately supports zero results, MUSE-51 established
  that the count check is the wrong instrument for a broken query, and MUSE-24 built a
  page whose correct behaviour with no documents is to say so. The build is behaving
  properly; the claim about it was wrong. The gate is where the three unguarded rows are
  named, and it already blocks on all three — an added document reaches `pending` by
  `absent: true`, and its message now says, per type, whether the build is going to fail
  as well or whether this is the only thing that will ever mention it.

- **A removal is checked against the dataset and blocks, because no import can perform
  it** (MUSE-83). MUSE-78 printed "Dropped from `content/seed.ndjson`: … those documents
  are still in the dataset" and **asserted** it: `removed` was the base seed minus the
  head seed, derived from git alone, and the dropped `_id` was then *excluded* from the
  live fetch, because the query is `*[_id in $ids]` over head-seed ids. Three
  consequences, and MUSE-73 — the first ticket to delete a seed document — hit all of
  them: the paragraph printed identically before and after the delete, so re-running the
  gate could not confirm it; and it did not block, because `blocked` was
  `pending.length > 0` and a removal never reached `pending`. So the one operation that
  genuinely needs a second human command had the weakest signal in the file.

  `idsToCheck({ base, head })` is the fix — the union of both seeds' ids — and a dropped
  id that comes back from the dataset is `stillLive: true` and **blocks**; one that does
  not is reported as done. **This does not reopen MUSE-45.** A removal can only come from
  the diff against the merge base, so only a branch authors one; nothing Mina does in the
  Studio drops a line from a committed file, and `sanity:seed:check` beside the gate is
  still `continue-on-error`.

  The sequence it prints is **delete first, then import**, which is MUSE-73's:

  1. `npx sanity documents delete <id> --dataset production`
  2. `npm run sanity:seed`

  Between the two writes the dataset is inconsistent whichever way round they go, and
  MUSE-21's cron can rebuild inside that window. Import-first would have published four
  cards including the retired rate; delete-first publishes a truthful page one rate short.
  As with the import, **an agent runs neither command.**

  What the gate still cannot see, stated rather than left to be rediscovered: a document
  that is in the dataset and in **neither** seed. Both scripts fetch by `_id` from the
  seed, so a document created in the Studio, or dropped from the seed by some earlier
  branch and never deleted, is invisible to the comparison entirely — MUSE-60's unseeded
  `studioStory` was exactly that. Finding those needs a query for everything the dataset
  holds rather than for named ids, it belongs in `npm run sanity:seed:check` where it
  cannot block, and it is not in MUSE-83.

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
  `test/helpers/structural-content.ts` — **not** `content/seed.ndjson`, which
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
  `localeText` object — not a field-level i18n plugin and not one
  document per locale. HR and EN share slugs and one document renders both, so the shape
  is `Record<Locale, string>`, both locales are separately `required()`, and a half
  translated string is a missing field an error can name. See the long note in
  `sanity/schemaTypes/objects/locale.ts` before changing this: it is hard to reverse once
  content exists.

  **There was a third, `localeRichText`, and MUSE-26 deleted it** — see the `/blog` bullet
  for the argument. The deletion makes the rule above *stronger* rather than narrower:
  every bilingual value still requires both locales, with no carve-out, and the one type
  that may be monolingual (`postTranslation`) is not a bilingual value at all. It is one
  object per language, which is the inverse grouping, and it is the one place on this site
  where the inverse is right.

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

  **The read-contract list is hand-written and is asserted complete** (MUSE-66), because it
  used to be only the first: `studioStory` had never been a key, so the whole body of
  `/aboutus` was outside layer two from MUSE-23 that built it to MUSE-60 that published it. It stays hand-written — what it
  holds per type is the *projected subset* of that type's fields, which the schema cannot
  supply without being asserted against itself — and is pinned from both sides instead. The
  gate fails on a document type in `sanity/schema.json` that is neither covered nor named
  in `NOT_READ` with the reason nothing reads it, so a new type forces the decision; each
  exemption (Sanity's two asset types, and nothing else) is asserted to still name a type
  that exists. `test/sanity.test.ts` holds the other side with `groq-js`: the contract is
  exactly the types the queries select on, field for field. **A field that is only sorted
  by belongs on the list too** — `order`, on five types. It is projected by nothing, so it
  is absent from the generated types and `astro check` cannot see it move; renaming it
  reorders a published page with no slot left blank and every other gate green.

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

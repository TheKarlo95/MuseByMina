# The test suite

**This file is the argument, not the rule.** Each rule is stated in `CLAUDE.md`, which
every agent reads; the reasoning, the measurements and the alternatives that were weighed
and rejected live here. Read the section that covers what your ticket touches.

Nothing here is decoration. Each passage records a defect that recurred, or an approach
that was tried and failed, and the cost of rediscovering it is the cost of the original
bug. Do not shorten a passage to tidy it up — if something is genuinely stale, that is a
ticket (MUSE-114 is the open instance).

- **A test that can only see `dist` cannot see a dev-only bug.** `test/fonts.test.ts` is
  the one suite that drives `astro dev`, through `astroDev()` in `test/helpers/scratch.ts`
  — the same module that owns `astroBuild()`, so `test/isolation.test.ts`'s child-process
  allow-list stays one entry long. It asserts over three environments: dev, and both
  deploy targets built and served. Two things it has to do and you have to keep doing:
  pass `--ignore-lock` (Astro 7 auto-backgrounds the dev server when it detects an agent,
  and a daemon cannot be torn down), and strip `VITEST` from the child env — Astro's
  dev-server plugin returns early when it is set, so the server starts, greets you, and
  answers every route with `Cannot GET`.

  **A green dev-server suite on your machine is not evidence about CI** (MUSE-47). The same
  agent detection that auto-backgrounds the server also switches Astro to **JSON** log
  lines; a runner has no agent markers in its environment and gets the ANSI banner written
  for a human. So the output `astroDev()` reads is a *different format* locally and in CI —
  deterministically, not as a race. MUSE-47 shipped a suite that was green here and failed
  there because `DevServer.base` was `new URL(greeting).pathname` and the character after
  the URL in the ANSI form is a colour reset, which a class excluding whitespace, quotes
  and backslashes does not exclude: the base came out `/MuseByMina/%1B[31m/`, every page
  404ed, and the dev server's own 404 line re-coloured the terminal while printing the
  path, so the symptom read as `//schedule/`. The JSON form put a literal backslash there,
  which the class already had — for an unrelated reason.
  To reproduce CI locally, unset `CLAUDECODE`, `AI_AGENT` and `CLAUDE_CODE_*` **and set
  `FORCE_COLOR=1`**. Unsetting the markers alone is not enough and reads as a clean
  reproduction: `kleur` turns colour off when stdout is not a TTY, which it never is under
  a test runner, so the banner comes out plain and the escape sequence is simply absent.
  CI has colour on. Both halves, or the defect is still unreachable.

  Two rules came out of it. **The base is configuration, never something to discover from
  a server**: `astroDev()` takes it from `astro.config.mjs` and only *cross-checks* the
  greeting against it, so a disagreement is one named error instead of every page 404ing.
  The **origin** is the one thing only the server knows, because the port is negotiated —
  and the `/` required after `\d+` in `DEV_ORIGIN` is load-bearing, since stdout is a pipe
  and a chunk can split between two digits of a port number.

  Note what MUSE-48's landing assertion cannot do for you here: it compares the path and
  the `?lang=` it *asked for* against the ones it landed on, so it catches a redirect and
  not a URL that was wrong before it was requested. `astro dev` serves `404.astro` at the bad path with no
  redirect, and that page carries the same six faces and two preloads — so
  `test/fonts.test.ts` measured the error page in all three environments and stayed green.
  A check needs something from the page's own markup saying which page it is, and that is
  one function: `fetchMeasuredPage` in `test/helpers/measured.ts` (MUSE-62), the `fetch`
  side of what `openCheckPage` does for Playwright. It compares each response's
  `<link rel="canonical">` against the path requested, which the 404 page cannot satisfy
  because it declares none, and `assertMeasuredPage` makes the same claim about HTML
  obtained another way — the DOM a browser-opened page ended up with. **Not body text:**
  every page contains „Muse by Mina", so eight copies of one page pass for eight pages.

  `astroDev()` itself fetches one page through it before handing the server over, so the
  *base* is proven rather than cross-checked and no suite has to remember any of this;
  `pagesRender: false` is the opt-out for `test/devcontent.test.ts`'s live arm, whose pages
  are expected to be 500s. Behind that, `unmeasuredDevServers` in
  `test/helpers/source-guard.ts` fails a file that imports `astroDev` without importing
  `./measured` — the belt to the probe's braces, and it lives there because that module is
  the only parser of the test tree (MUSE-61).

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

  **The guard's own rules are read by a parser, and the landing assertion covers `?lang=`**
  (MUSE-107). Post-merge QA of MUSE-48 found four more ways round it, every one of them
  *around* the door rather than through it — the door itself was verified sound. Discovery
  was `/from ['"](playwright|[^'"]*browser-checks\.mjs)['"]/`, a model of an import
  statement, and `await import('play' + 'wright')` is an import it does not describe: a
  probe written that way asked for `/`, reported `measured: /MuseByMina/en/`, and the guard
  stayed green with **no rule applied to the file at all**. The census saw only its build,
  because the census is written by `launchChecks`. The token check was a per-line substring
  scan, so `browser['new' + 'Context']({ locale: 'en-US' })` planted in `scripts/a11y.mjs`
  — a file discovery *had* reached — left it green too; and that scan had to assemble its
  needles from fragments (`new${'Context('}`) so it would not report the prose explaining
  itself, which is the symptom showing in the guard. Both rules now live in
  `test/helpers/source-guard.ts` beside MUSE-34's and MUSE-54's: `drivesBrowser` asks the
  parser which modules a file imports, and `browserOwnership` states the rule against a
  **callee**, so a name assembled from pieces is folded to what it computes, a name in a
  comment or a string is not a call, and the needle-splitting workaround is gone. Every
  offence is reported and each names its call — the four `expect`s per file short-circuited,
  so five planted tokens reported two and named neither, which told the author the fix was
  complete.

  Two more are about what the door does not assert, and only one of them is a scan's
  business. `openCheckPage` compared the **pathname** alone, so a 302 to
  `…/schedule/?lang=hr` resolved: identical path, and `?lang=` is what `src/lib/lang.ts`
  routes language on, so the page was measured under an instruction the check never gave.
  The comparison is now the path **and** `?lang=` — and nothing else in the query, because a
  rule that fires on a parameter nobody routes on is a rule that gets turned off. Then
  `openRedirectProbe`, which asserts nothing **by design** and correctly: no scan can close
  that, because there is no token to plant and no file to discover. A suite written next
  year imports the sanctioned module, opens `/`, lands on `/en/` and labels it `/`, with
  every guard above green. So its callers are a **named list with the reason each one needs
  an unpinned browser**, asserted complete against what the tree does and asserted still
  live — the `test/contentdrift.test.ts` treatment, because the instrument for a door that
  is right is a list, and a list rots.

  And one sweep was narrower than the site: `SWEPT` in `test/lang.test.ts` was `ROUTES` ×
  locales plus `/nope`, so `/events/<slug>/` and `/blog/<slug>/` — real pages, from
  `getStaticPaths`, named by no list in `src/lib/` — were outside the rule that a link
  marked with a language must name it (MUSE-56), which is exactly the rule a detail-page
  template gets wrong. It reads `auditTargets` over the preview's own `dist` instead, the
  same walk `npm run a11y` uses (MUSE-55), pinned by asserting every static route is still
  in what it found. The dataset publishes no post and no event, so this changes no page
  today and is the whole of the guard the day it does.

  Two findings from the same audit are left standing, named rather than fixed. `fixedSleeps`
  runs over `inspectedFiles()`, which is `test/` only, so the four browser checks in
  `scripts/` are ungoverned by it — none contains a sleep today. And `browser-settle.ts`
  checks its failure-path budget *inside* the `requestAnimationFrame` callback, so with
  `rAF` stubbed never to fire the wait was still pending after 8 s and would have ended as
  vitest's bare timeout, the failure MUSE-54 exists to abolish; Playwright disables renderer
  backgrounding, which is what keeps it latent.

- **A discovery scan is a model of another tool's behaviour, and a model is wrong the
  moment the tool changes** (MUSE-96). Three guards in this tree discovered their subjects
  with a rule narrower than the loader they shadow, and all three therefore passed over
  the file that mattered — one shared defect wearing three hats, found by QA of MUSE-46,
  MUSE-48 and MUSE-68 at once.

  `browserFiles` in `test/browserlocale.test.ts` read `test/` with a flat `readdirSync`
  while `vitest.config.ts` includes `test/**/*.test.ts`. So `test/sub/ghost.test.ts`,
  launching Playwright itself and opening a context with a locale on it, **ran as a test
  and reported `1 passed`** with the guard green — the identical file one directory up
  fails three of its tests. The hole was purely directory depth and it defeated two
  guarantees at once: MUSE-48's pinned locale, so a check could measure `/en/` and label it
  `/`, and MUSE-68's census, which recorded nothing because the launch bypassed the one
  door that writes a line. The build side never had the hole — `testFiles()` in
  `source-guard.ts` is recursive — which is why only the browser rule was reachable.

  `test/routes.test.ts` and `test/seo.test.ts` both discovered pages with
  `endsWith('.astro')`, and Astro's `settings.pageExtensions` is **eight** entries:
  `.astro`, `.html` and six Markdown spellings, with no integration and no config.
  `src/pages/etiquette.md` plus its English twin built into `dist/etiquette/index.html`,
  landed in `sitemap-0.xml`, got no `page` document, no `<title>` from Sanity, no nav entry
  and no `llms.txt` line — and `test/routes.test.ts` passed 17/17. So `src/pages/`, the
  one list CLAUDE.md says cannot lie about what exists (MUSE-46), lied. It was not silent
  overall: `test/nav.test.ts` and `test/urls.test.ts` went red with 17 failures between
  them. But that is MUSE-68's own named anti-pattern — the thing reporting is not the thing
  at fault — and not one of those messages said a page was missing from `ROUTES`.

  `owningTestFile()` in `scripts/heavy-census.mjs` matched `([A-Za-z0-9._-]+\.test\.ts)`,
  a filename with no separator in it, and wrote `test/` in front of it. A heavyweight
  operation from `test/sub/ghost.test.ts` was recorded against `test/ghost.test.ts`, which
  does not exist; declaring the real path produced two contradictory problems at once, and
  **the only declaration that made the run exit 0 was the fictitious one** — measured both
  ways. The ratchet on the total still fired, so growth was never invisible, but
  attribution is the whole of what the per-file table is for.

  **The fix is one module and a rule about where a scan's subjects come from.**
  `test/helpers/discovery.ts` obtains the real list wherever the tool will give one:
  `PAGE_EXTENSIONS` is Astro's own `settings.pageExtensions`, read out of
  `createBaseSettings` — the function a build calls — and `vitestFileGlobs()` is the
  `include`/`exclude` vitest resolves for this project, from vitest's own `resolveConfig`.
  Where a list genuinely has to be modelled it says so beside the code and is **pinned to
  the tool**, the way `prerenderStagingDir` is pinned to `getOutDirWithinCwd`: the
  recursive walk of `test/` states what `include` *means* and is asserted against what
  vitest resolves, because evaluating a glob honestly needs vitest's own matcher and
  vitest hands a test no file list without standing up a second vitest; the walk of
  `scripts/` is pinned to `package.json`, since there a module is loaded because something
  names its path. Two further things came out of it. The test-tree scan is now over
  **every** `.ts` under `test/` rather than every suite, because the rule is about files
  and `test/helpers/browser-settle.ts` imports Playwright and had never been read. And the
  census's attribution is a function of a stack string, `owningTestFileFrom`, so the
  subdirectory case is asserted the way `judge` is — against synthetic input, with no
  planted suite and no build to pay for.

  One residual is recorded rather than fixed, in `test/lockup.test.ts`: `markupRegion`
  finds the frontmatter fence with `indexOf('\n---', 3)`, so a frontmatter line *beginning*
  with `---` would close the region early and shift every line number the file reports. No
  `.astro` file in the tree has one — all 48 checked — the symptom is a wrong line number
  rather than a missed violation, and the honest fix is Astro's compiler rather than a
  longer regular expression.

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

  **And it runs every rule axe enables by default — there is no tag filter** (MUSE-75).
  It filtered to `wcag2a`/`wcag2aa`/`wcag21a`/`wcag21aa`, and `heading-order` is tagged
  `best-practice`, so `/pricing/` shipping `h1` → `h3` in both locales was a real axe
  finding on a live page that this gate structurally could not report — MUSE-55's defect
  again, one layer in, with "accessibility: pass" meaning something narrower than it
  reads as. The filter is **gone** rather than extended by a tag: a list of standards
  worth checking is a list to keep current, and with none the next axe-core release
  widens what this sees. The noise was measured before it was adopted — the unfiltered
  run over 16 pages × both themes found that one rule and nothing else at any impact.
  Rules axe ships disabled (experimental, AAA) stay disabled. What a green run still does
  not cover is printed under it: `incomplete` results are reported as notes and never
  failed on, because axe raises them when it cannot compute the answer itself.

- **The host model serves the error page's *body* on a 404** (MUSE-38). `resolveRequest`
  returns `404.html` as the `file` on a 404 inside the deploy's prefix, the way GitHub Pages
  does; outside the prefix it returns no body, because that URL space is not ours (MUSE-8).
  It used to answer the status and invent the body, so no browser suite in the repo could
  reach the error page at all and an all-Croatian 404 was only reproducible against the
  deployed site. Drive it with `test/helpers/preview.ts` and an unknown path.

- **A test never chooses where it builds.** `npm test` performs **84 heavyweight
  operations — 71 real `astro build`s, 4 `astro dev` servers and 9 browser launches —
  across 32 of its 40 files**, in a pool of `availableParallelism() - 1` workers, which
  is 15 on a developer box and 3 on `ubuntu-latest`. (It said *"ten real `astro build`s
  in parallel workers"* until MUSE-68 counted; nothing had ever made that true, and
  `test/lockup.test.ts` reasoned from it.) `test/helpers/scratch.ts` mints a directory
  per build with `mkdtemp` and passes each one its own cache root, so two suites cannot
  share an output tree and nothing has to be wiped. There is nothing to remember here —
  that is the point. This bug was fixed three times as a naming convention (MUSE-9,
  MUSE-10, MUSE-17) and came back twice; `test/isolation.test.ts` now fails if a suite
  names a build directory, deletes anything, or spawns its own build.

  **And the total is now metered, because adding to it breaks a different file**
  (MUSE-68). MUSE-67 gave a new `describe` a build of its own and
  `test/localeswitch.test.ts` went red — `page.waitForEvent: Timeout 20000ms exceeded
  while waiting for event "framenavigated"`, read at the time as a correct wait that never
  got CPU. It was a correct wait on an event that had already been lost; MUSE-70 has the
  measurement, and the load sensitivity below is real either way. Measured
  across two agents: **4 of 15 runs fail at 78 operations and 5 of 8 at 79** — every one
  of them the middle-click MUSE-70 then fixed, so the table's post-MUSE-70 row (MUSE-24:
  5 runs at 81, 0 failures) says that defect is still fixed and **not** that there is
  headroom. So the count is the thing to watch and **the count is measured, not read off
  the source**: a
  scan for `astroBuild`/`astroDev` call sites undercounts by about a fifth, because the
  heavyweight helpers wrap each other (`startPreview` → `buildPreview` → `astroBuild`)
  and a rule stated against a callee — the only kind `source-guard.ts` may state — sees
  the outer name. `scripts/heavy-census.mjs` records one line per operation from the two
  places that can start one, each already the only permitted source by an existing rule;
  `test/helpers/concurrency-reporter.ts` judges the run at `onTestRunEnd`, the first
  moment the count is complete, and prints the total, the pool size and the headroom on
  **every** run so the number in this paragraph cannot go stale the way the last one did.

  `DECLARED` in `test/helpers/concurrency.ts` is a per-file table, so the failure names
  **the file whose count changed** rather than the one counted last; adding a build is a
  one-line edit there, deliberately, because that is where the cost belongs. **The
  headroom is zero and the ceiling is a ratchet, not a safety line** — the flake is
  load-sensitive with no threshold and is present at today's total — so read the
  measurement table above `BUDGET` before changing either number, and do not raise it
  quietly. MUSE-69 is the worked example: its two builds took the run to 80, the guard
  exited 1 on 34 green files naming `test/share.test.ts`, and the entry and the number
  moved together with the measurement. MUSE-24 is the second and took it to 81, for
  **one** build: `/events` needs a dataset with an event in it and no build in the tree has
  ever had one, while the other sixty tests in that file are Astro container renders and
  cost nothing. That split is the thing to copy — the container sees markup, and a build is
  for `getStaticPaths`, a URL and the emitted CSS. The worker count is deliberately **not** the
  divisor: the pool is 15 here and 3 in CI, so dividing
  by it would pass on a laptop and fail on a runner, and pinning it to 10 was measured
  neutral on wall clock and still flaked.

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

  **And it prunes every scratch root under the checkout, not only the one it runs in**
  (MUSE-79). That policy is untouched — same rule, same age, wider reach — because the
  defect was never the rule: one worktree per ticket meant a run in `muse-71` never looked
  at `muse-64`, and a worktree whose pull request merged is never run in again, so
  **30,061 stale build directories accumulated across 43 worktrees** and a run died with
  `ENOSPC`. Every one was older than the age the prune already allowed itself to delete.
  Age stays the only discriminator and that is what makes the wider reach safe: another
  agent's live build is minutes old wherever it lives, so no lock and no pid file is
  needed here either. `scratchRoots()` in `test/helpers/scratch.ts` is where the roots come
  from — it reads `.git` rather than asking `git`, because a `globalSetup` may not start a
  child process — and `test/isolation.test.ts` proves both directions against a
  two-worktree tree.

  **A worktree is the other half of that disk, and it is swept by hand on purpose.** 42 of
  the 52 present belonged to merged pull requests, each with its own 653 MB of
  `node_modules`. `npm run worktrees:sweep` prints a verdict per worktree and removes
  nothing until it is run again with `--remove`; it removes one only when its pull request
  is **merged**, its tree is **clean** and its tip commit exists somewhere other than that
  directory, and it calls `git worktree remove` without `--force` so git re-checks. **Do
  not make it automatic** — an agent's worktree is indistinguishable from an abandoned one
  between two tool calls, and deleting one mid-ticket is worse than the disk pressure. And
  **the signal is the pull request, never the commit graph**: this repository
  squash-merges, so a merged branch is never an ancestor of `main` and
  `git merge-base --is-ancestor` calls all 42 of them unmerged. The per-worktree
  `node_modules` stays — README says which three things break if it is shared, all
  measured — so the sweep is the whole of that answer.

  **A build stages where it outputs, which is why `outDir` may not leave the project
  root** (MUSE-41). The staging area is the *third* directory a build writes, after the
  output and the caches, and it is the one nothing chose: Astro puts it in
  `<outDir>/.prerender/` only while `outDir` starts with `process.cwd()`, and otherwise
  in `<cwd>/.astro/`, renaming every emitted asset out of there. So an `outDir` outside
  the root is either a cross-device `fs.rename` — `EXDEV`, not retryable, an Astro stack
  that never names `outDir` — or, between two concurrent builds, **one shared staging
  directory with content-hashed filenames**, which collides deterministically: both
  builds exit 0 and print `Complete!`, and the second ships nine pages linking a
  stylesheet and six fonts that are not there. Astro exposes no setting for it, so
  `astro.config.mjs` refuses such a build in `astro:config:setup`, naming `outDir`, the
  root and the staging path; satisfy it and the staging directory is inside an output
  `mkdtemp` already made unique, so it is per-build and on the output's own filesystem by
  construction. `test/isolation.test.ts` holds it three ways — the model pinned to Astro's
  own `getPrerenderOutputDirectory`, two claimed output directories yielding two staging
  directories, and a witness file in the shared path that a real build must not delete.
  **`SCRATCH` being inside the repository is therefore a requirement, not a preference**:
  moving it to `os.tmpdir()` was harmless before MUSE-35 emitted any assets, and now puts
  all ten builds back on one staging path.

  **The rule is a test on `outDir` against the root, and asking it about the staging
  directory instead is what deleted a project** (MUSE-92). `stagingFault` used to ask
  *"does this build stage inside its own output?"* — the same question as the rule for a
  descendant and the **opposite** one for an ancestor, because Astro's fallback
  `<cwd>/.astro/.prerender` *is* inside an `outDir` above the root. So the guard allowed
  the one shape its own message ruled out, and QA's `outDir = <root>/..` was emptied by
  Astro and Vite with the project root inside it: sources, caches and all gone, Vite's own
  generic warning the only thing that objected and only after the fact.

  The rule now enforced, and stated, is **`outDir`'s path must start with the project
  root's path and may not be the root itself** — which is *not* „under the project root",
  and the difference is the half that is easy to undo twice. The prefix is **Astro's own
  raw string test**, the one `prerenderStagingDir` models, so a sibling whose name extends
  the root's (`<root>-other/dist`) is allowed: it is outside the root as a *tree* and
  inside it as a *string*, Astro therefore stages it under its own output, and
  `path.relative` would refuse a safe build for nothing. And the root itself is **refused**
  rather than admitted by that prefix — Astro's `validateConfig` refuses the build too, so
  no outcome changed, but a guard against deleting the project may not rest on a check
  inside a dependency.

  **So the message says the prefix rule, says it is Astro's, and names the sibling it
  admits.** MUSE-41's wording outlived MUSE-41's predicate and reads as proof the defect
  was impossible; leaving it would have been the same mistake one case narrower, with the
  allowance this ticket asserted as the counterexample. `test/isolation.test.ts` pins the
  headline — the line `buildErrorHeadline` carries into a failed build's report — against
  both halves, and the ancestor cases are asserted against `stagingFault` as a function
  and **never reproduced**: there is nothing to learn from deleting a second project, and
  the function is what `astro:config:setup` consults.

  **The protected root is Astro's `config.root`, which is `process.cwd()` only when
  nobody passed `--root`** (MUSE-108) — so MUSE-92's own defect survived its fix, one
  level out, and post-merge QA found it. `stagingFault` took the root from the working
  directory and the hook passed no root at all, while Astro resolves `outDir` **against
  the root** (`resolveDirAsUrl(val, fileProtocolRoot)`,
  `core/config/schemas/relative.js`; `resolveRoot` in `core/config/config.js` is where
  the fallback lives). So `astro build --root a/b --outDir ../` yields `outDir = <cwd>/a`,
  which contains the project root, starts with the working directory, and was allowed —
  measured against the real exported predicate. Astro's `validateConfig` does not catch it
  either: it throws only when `outDir` **equals** `root`. Latent, because nothing in
  `package.json`, `ci.yml` or `deploy.yml` passes `--root` and the config declares no
  `root:` — the same latency MUSE-92 accepted, with the same consequence.

  **It is two comparisons now, one per directory Astro resolves against, and that is not
  a check per symptom.** MUSE-92's objection to a check per symptom stands; this is one
  question per directory, and the two coincide for every build in this repository:

  - `outDir` must start with the **root**'s path and not be the root — the deletion.
  - `outDir` must start with the **working directory** — the staging location, and it has
    to be the working directory because `getOutDirWithinCwd` tests
    `fileURLToPath(outDir).startsWith(process.cwd())` literally.

  The second is the half the fix would otherwise have *opened*: `--root <elsewhere>` with
  the default `outDir` passes the containment question — an ordinary `dist` inside its own
  project — and still stages in the shared `<cwd>/.astro/.prerender`, which is MUSE-41's
  `EXDEV` and its silent asset collision. Each clause is asserted with the other dropped,
  so neither can be deleted quietly. The hook trims the trailing separator off both URLs,
  which is load-bearing rather than tidy: `<cwd>/` fails the raw string prefix MUSE-92
  deliberately allows, so an untrimmed root would refuse the sibling whose name extends
  it — a safe build. And the hook is reached through the config's own `integrations` list
  rather than through a second export, because the defect *was* the wiring: a correct
  predicate handed the wrong directory.

  **The over-claim guard is a generated class of wording now, not one banned literal**
  (MUSE-108). It asserted `not.toContain('under the project root')`, and „must be within
  the project directory" is the same over-claim reworded — the shape of MUSE-84's
  first-pass needle, which pinned the two literals its author had already changed. There
  is **no property in the strict sense and the file says so**: the over-claim is a claim
  made in English about a predicate, and no assertion reads English. What is stated
  instead is the pair that makes it checkable — the headline must name the test it
  performs (a string prefix) and may not describe `outDir`'s relation to the root with the
  vocabulary of a directory tree, which every rewording needs. `overclaims` is the cross
  product of six containment prepositions and two subjects, generated rather than listed,
  and it is asserted to fire on three wordings so a guard that finds nothing cannot pass.
  It reads the **headline only**, because the body denies the claim in those very words
  while naming the sibling it admits.

  One hole is left deliberately and is written beside the function:
  `stagingFault('<root>/..', '<root>')` returns `null` for an unnormalised path. It is
  unreachable through the hook — `resolveDirAsUrl` calls `path.resolve` before the hook
  sees `config.outDir` — and the same hole predates MUSE-92. It wants fixing if the
  function ever gains a second caller.

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
  file it was removed from. What that rule cannot reach is written out beside it, and **two
  of the three are asserted**: `test/isolation.test.ts` hands the rule a click followed by a
  geometry read with nothing in between, and a correct wait given a 15-second budget, and
  asserts it is silent on both. The third — a fixed-interval poll spelled with a Node
  `setTimeout` — is **written out and not asserted**, because it is deliberately not
  forbidden: `test/helpers/scratch.ts` uses two for a process-kill grace period, which is a
  timer doing a timer's job, and a rule that fired on it would be turned off rather than
  obeyed. MUSE-107 measured what that costs — `await new Promise((r) => setTimeout(r, 25))`
  planted in `test/lang.test.ts`, and the guard green — so the gap is a known one and the
  claim that it is covered is the thing that was wrong.

  **And the condition has to be about the document being measured** (MUSE-61). The
  middle-click test waited on three real conditions, every one of them satisfiable while
  the tab was still `about:blank`: `context.waitForEvent('page')` resolves when the tab
  *object* exists, `load` has already fired on a blank document, and a `localStorage` read
  there answers from an opaque origin — it raises `SecurityError`, measured. So
  `expect(tab.url())` compared against the empty document Chromium opens a middle-clicked
  tab at, and reddened a pull request that touched no browser code. `settleNewTab` and
  `settleMove` are the gate, and what they wait for is a **main-frame commit read from
  Playwright's own `framenavigated`** — the same bookkeeping `page.url()` reads. An in-page
  `location.href` poll observes the commit too, but in the renderer, and the gap between
  the renderer knowing and the frame bookkeeping knowing is where this was lost: 11 of 160
  trials reproduce the exact CI failure with the tab's first document request delayed 8–14
  ms, and 0 of 240 do with the commit awaited. **Never gate on
  `waitForURL(theExpectedUrl)`** — that hands the judging to the wait, so a dropped
  `?lang=` becomes a 15-second timeout instead of a comparison naming what it got, and
  `?lang=` is the whole subject of those tests. The predicate is a property of the URL
  (*not blank*, *not where we started*); `expect` stays the judge. The `localStorage` wait
  is **gone rather than moved**: `langInitScript` is a blocking head script, so
  `readyState === 'complete'` already proves it ran, and waiting for the thing the next
  line asserts made that assertion unfailable except by timeout. `uncommittedTabs` keeps
  the shape out, and the suite takes delivery of a new tab in exactly one helper so that
  name-scoped rule has one binding to watch rather than three.

  **For a tab Chromium opened, `page.url()` is not that bookkeeping — it is a mirror that
  can be permanently wrong** (MUSE-70), and that was the flake that dominated the suite:
  about one full `npm test` in four, on branches that had touched no browser code, and
  three tickets were reported red for it innocently. **It is fixed and it was not the last
  flake in the suite** — eight consecutive runs afterwards were clean of it and one of them
  failed `test/trialform.test.ts` instead, unexplained; that observation, and what is and
  is not known about it, is recorded once, in `test/helpers/concurrency.ts` (MUSE-91).
  A tab Playwright adopts *after* Chromium opened it
  keeps `page.url() === 'about:blank'` **for the rest of its life** when its first document
  commits inside the adoption window. Measured in the failing run: the tab requested the
  destination's four fonts 60 ms after the `page` event and answered 200 to all of them,
  and twenty seconds later `page.url()` was still `about:blank` while the document's own
  `location.href` was the destination. So the event MUSE-61's wait watches for had come and
  gone, and **raising the 20 s — the obvious fix, and the one the ticket was filed asking
  for — would have bought a slower failure at the same rate.** `settleNewTab` therefore
  asks the document (`waitForFunction`: a non-blank `location.href`, then `readyState ===
  'complete'`) and **returns the URL it established**, so the assertion reads the record the
  wait read — MUSE-61's rule applied, not bent. `middleClickOpens` hands the three tests
  that URL, the `<html lang>` and the stored language rather than a `Page`, which is what
  makes the stale mirror unreachable rather than merely discouraged. `settleCommit` and
  `settleMove` are **unchanged and still right**: a page the test opened is Playwright's
  before it navigates. The 20 s is now sized against a measurement recorded beside it —
  click to a complete document is 524–1288 ms idle, 429–1704 ms at a load average above
  100, over 28 trials.

  **MUSE-70's other half is a retry, and it is the suite's one exception to the rule above**
  — `middleClickOpens` re-clicks, `TAB_ATTEMPTS = 3` asks of `TAB_BUDGET = 12_000` ms each,
  a 36-second worst case — because whether Chromium acts on a middle-click is not a fact
  about this site, and waiting longer was measured and does not work (45 s: 4 of 5 runs
  still failed, each with the click itself finishing in 143–266 ms). It repeats the
  *gesture*, never a wait and never an assertion. Both numbers' measurements live in that
  function's own comment, and so does the `auxclick` record MUSE-91 added beside them: the
  failure message used to cite the MUSE-33 markup assertions as proof the site was not the
  cause, which a script calling `preventDefault` on `auxclick` leaves true — so it now
  reports, from the window, whether the page received the gesture and whether it let it
  through.

- **The formatting convention is stated in `prettier.config.mjs`, and `prettier --write`
  over the tree is still wrong** (MUSE-58). Nothing stated it before, and Prettier's
  default is `singleQuote: false` — so a bare `npx prettier --write <file>` did not follow
  this repository, it overrode it: MUSE-45's pull request arrived as 538/319 for a 96-line
  change, 348 added lines pure requoting, all five checks green. Every value in the config
  was **measured** against the tree, so only the two settings that differ from Prettier's
  defaults are written down; the rest would be a value to re-measure when a default moves.
  Run it on **one file**, the one you touched (`npm run format -- <file>`).

  **Then read `git diff`, because the scoped form is not safe either** (MUSE-82). Prettier
  has no range mode: run it on one file you changed and it reformats *the whole file*. 47 of
  the 96 files it owns differ from its output in wrapping only, so a 12-line change to
  `test/home.test.ts` came back as 65 lines and a 14-line hunk in `test/contact.test.ts` as
  95 — eight blocks of untouched code reflowed, `npm run format:check` green either way,
  because wrapping is deliberately not its business. **That is this design working, not a
  defect**; the alternative is the tree-wide reformat the next paragraph refuses. So the
  working rule is: **run it, read the diff, and if it rewrapped code you did not touch,
  revert the file and re-apply your hunk by hand.** Converging a file is for a branch that
  is *about* that file; it is not worth burying a two-line fix in sixty lines of reflow a
  reviewer then has to read. (Teaching `npm run format` to warn when its output would move
  lines outside your hunk was considered and rejected: it would have to guess your base to
  know which lines are yours, it would fire on roughly half of all files touched, and it
  could only ever *report* what `git diff` already shows — whether a given reflow is
  reviewable is the judgement, and a wrapper cannot make it.)

  **`prettier --check` is not the gate and must not become one.** The tree is not
  Prettier-formatted: 49 of the 96 files Prettier owns are byte-identical under the config,
  47 differ in wrapping only, and 35 are clean at *no* print width because they were
  wrapped by hand. Making that check pass means reformatting the tree, which is a diff
  nobody can review and invalidates every open branch at once — this ticket committing the
  defect it exists to prevent. `npm run format:check` (`scripts/check-format.mjs`) asserts
  the invariant the tree actually holds instead, which is also the whole of MUSE-45's
  damage: **where the quote character is a free choice, this repository picks single.** It
  takes the preferred quote from the resolved config rather than restating it, reads syntax
  so a quote in prose cannot trip it, names `file:line`, runs in 1.3 s, and lives as a step
  in `ci.yml`'s `designsystem` job — the only one needing neither a build nor a browser —
  rather than as a sixth check. Files conform the rest of the way as they are touched.

  Two things in there that look cosmetic and are not. **`sanity typegen` resolves
  `prettier.config.mjs`** for its own output and `resolveConfig` cannot see
  `.prettierignore`, so `src/lib/sanity/sanity.types.ts` is pinned by an `overrides` entry
  to the Prettier *defaults* its generator emits; without it the next
  `npm run sanity:types` rewrites all 146 lines and `ci.yml`'s `sanity` job goes red on a
  branch that never touched the schema. And `*.css` is ignored because Prettier flattens
  `tokens.css`'s hand-aligned table and lowercases hex that is transcribed from the design
  system document; `*.md` because prose wrapping is a judgement and this file is edited by
  every branch at once; `*.astro` because no Astro parser is installed, which is asserted
  still true — add `prettier-plugin-astro` and `test/format.test.ts` fails telling you to
  widen the quote rule past the frontmatter fence.

- **A component can be built before its page can be routed** (MUSE-23), and
  `MUSE_PREVIEW_ROUTES=<name> npm run build` injects `/<name>-preview` so it can still be
  asserted on against `dist` — the only way to check CSS, since Astro's container API
  renders markup without the stylesheet pipeline. `src/lib/preview.ts` is the registry,
  the entry points live under `test/` so `test/seo.test.ts`'s page list cannot see them,
  and unset the variable injects nothing. **Delete the entry with the ticket that routes
  the page**; an entry that outlives its ticket is a page nobody shipped.

  **The registry is empty, and that is the healthy state** (MUSE-60). `aboutus` was the
  only entry there has ever been and MUSE-60 routed the page. Note what that costs and
  what replaced it: "every entry point is under `test/`" is a *loop over the registry*, so
  it now passes without asserting anything — the shape of green test this repo keeps
  re-filing. `test/aboutus.test.ts` keeps it for the next entry and leans on the half that
  still has a subject, which is that `requestedPreviews('aboutus')` **throws** naming the
  name, so a stale variable is an error rather than a build that silently injects nothing.
  The guard on no workflow and no npm script *assigning* the variable is a claim about the
  variable rather than the registry and is unaffected.

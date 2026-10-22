# Build and deploy

**This file is the argument, not the rule.** Each rule is stated in `CLAUDE.md`, which
every agent reads; the reasoning, the measurements and the alternatives that were weighed
and rejected live here. Read the section that covers what your ticket touches.

Nothing here is decoration. Each passage records a defect that recurred, or an approach
that was tried and failed, and the cost of rediscovering it is the cost of the original
bug. Do not shorten a passage to tidy it up — if something is genuinely stale, that is a
ticket: a statement one of these documents makes that the code does not support is filed
and corrected, not trimmed in passing. **No ticket number is named here**, and
`test/docs.test.ts` keeps it that way — a pointer naming whichever ticket happens to be
filed is a claim about status, it stops being true the day that ticket closes, and naming
a successor only moves the staleness to the next close (MUSE-114).

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

- `rootPath()`/`rootUrl()` in `src/lib/site.ts` are for files the build publishes at the
  deploy root — `robots.txt`, `llms.txt`, the sitemap — and for a future `CNAME`. They
  are **not** the way to reference a bundled asset; see the bullet above, and note that
  the favicon this used to name went the other way (MUSE-40).
  Never interpolate `import.meta.env.BASE_URL` by hand: whether it carries a trailing
  slash depends on `trailingSlash`, so `${BASE_URL}robots.txt` can silently yield
  `/MuseByMinarobots.txt`. An apex build hides this; only the Pages sub-path 404s.

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
  and the visible page cannot disagree by construction (in a build; under a dev server
  that is two queries — MUSE-47). The suite compares them field by
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

- **"Should a crawler index this" and "may this page route by language" are two props**
  (MUSE-38). `BaseLayout.astro` takes `indexable` and `localeTwins`, and neither is derived
  from the other — `const localeRouting = indexable;` is the regression, it reads as a
  tidy-up, and `test/nav.test.ts` pins its absence against the source as well as the
  behaviour. `indexable` governs canonical, `og:url`, JSON-LD and the sitemap.
  `localeTwins` governs the switcher, the URLs `langInitScript` is handed, **and the
  hreflang cluster**. **`langInitScript` ships on every page**;
  `urlFor` answers `string | null` *per locale*, so "there is nowhere to send them" is a
  fact about each URL rather than a flag, and the one `go()` funnel enforces it. The error
  page is `localeTwins={[]}`, and it reads `?lang=`, folds it and
  persists it like everywhere else — it just does not move anybody, because `/en/404/` is
  itself a 404.

  **It was `localeTwin?: boolean` until MUSE-26 and the blog is what made a set
  necessary.** A post may be written in one language, so „is there a twin" is one answer
  *per locale* — which is the shape `urlFor` always had — and the hreflang cluster moved
  onto the same function rather than being emitted for `LOCALES` unconditionally. **A
  cluster of one is not emitted**: a lone `hreflang="hr-HR"` is not a self-reference
  inside a group, it is a statement that the page is *for* Croatian speakers, which would
  ask Google to withhold a post from the English search it answers. `@astrojs/sitemap`
  takes that position on its own — `createGetI18nLinks`, `if (links.length <= 1) return
  undefined` — so the page and the sitemap now agree **by rule** rather than by having
  both locales for every route. A one-locale post is also the first live counterexample to
  collapsing the two props: it is indexable and has no twin.

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
  CTA have the identical exposure (`/` and `/#enquiry` land on the detecting route) and are
  not a language affordance: each is offered once with no counterpart, so following one
  asserts nothing about language, where the exits are a pair and pressing one is a choice.
  There is also no 404-only chrome — stamping it would stamp every Croatian page, which
  would freeze an `en-US` visitor who followed a shared Croatian deep link into Croatian
  the moment they clicked the logo, i.e. break the cohort MUSE-38 exists for. A pressed
  exit stores the language and a stored choice outranks the browser, so the fix governs the
  chrome from the first press anyway; `test/lang.test.ts` pins that composition and pins
  `#enquiry` surviving the CTA's redirect in both directions (MUSE-10). The fragment was
  `#trial` until MUSE-136 retired the class it named; what MUSE-10 is about is that a
  fragment survives a redirect, and that is unchanged.

  The **footer** marks the current route with `aria-current="page"`, because `/privacy/` is
  reachable only from there (the nav omits it on purpose, MUSE-7) and nothing else on the
  site can mark it. It stays an `<a>`: MUSE-39's rule is that whatever carries
  `aria-current` must either not be a link **or be a link to exactly where we already
  are**, and a footer entry for the current route is the second. It is also `/privacy/`'s
  only self-reference, which `test/nav.test.ts`'s orphan rule is calibrated against.

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

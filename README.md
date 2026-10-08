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
| CMS | Sanity — the per-page titles/descriptions and the studio details are read from it at build time (MUSE-20); the schedule is not there yet (MUSE-36) |
| Video | Cloudflare R2 — *not yet wired* |

Astro rather than a React framework because this is a content site: the build ships
**zero JavaScript files**: the theme switch, language switch and nav are small enough that
Astro inlines them.

## Commands

```bash
npm run dev        # http://localhost:4321/MuseByMina/
npm run build
npm run preview    # dist, served the way GitHub Pages serves it — not `astro preview`
npm run typecheck  # astro check
npm test           # vitest — asserts on real build output
npm run ds         # design-system compliance
npm run a11y       # axe on every page, both themes (serves dist itself)
npm run shots      # screenshots of all theme states → /tmp/muse-shots
npm run ux:schedule  # /schedule: responsive shift, keyboard, filters

npm run sanity:types   # re-extract the schema + regenerate types — commit the result
npm run sanity:check   # the fast staleness gate that `npm run build` runs first
npm run sanity:read    # every query against the live dataset: OK / EMPTY / BROKEN
npm run sanity:dev     # the Studio locally, http://localhost:3333
npm run sanity:build   # bundle the Studio into .sanity/studio — what CI runs
npm run sanity:deploy  # push the Studio to musebymina.sanity.studio
```

**None of the three browser gates needs a server, and none of them will attach to one.**
Run `npm run build`, then run the gate: it serves `dist` from an in-process host on a port
the kernel picks, and prints the fingerprint of the build it measured before the first
result. `a11y` takes `ROUTES` and `shots` takes `ROUTE`/`OUT`, so either can be pointed at
one page:

```bash
ROUTES=/,/en,/schedule,/en/schedule npm run a11y
ROUTE=/schedule OUT=/tmp/muse-shots/schedule npm run shots   # reports h-overflow at 390px
```

That is MUSE-52, and it is not a convenience. `astro preview` daemonises under this
environment and **silently reuses a daemon on another port**; with several worktrees live
at once, `npm run a11y` bound to a preview belonging to a different agent's worktree and
reported every route clean in both themes about somebody else's build. The script had
already been hardened twice for that class — a status check and a redirect check — and
neither could see it, because both confirm *something* answered rather than **which
build** answered. So there is no longer a port to be handed one.

`ORIGIN`/`BASE` still work, for a server you started yourself or for the deployed site.
When `ORIGIN` is set, every URL the run is about to measure is fetched and compared byte
for byte against the local `dist`, and a difference is a hard failure naming the URL and
both digests. Identity is a hash the *reader* computes over the output tree, so nothing
is stamped into `dist` and MUSE-20's byte-identical criterion is untouched — two builds
of one commit fingerprint the same, which `test/origin.test.ts` asserts. For an origin
that is deliberately not this build:

```bash
ORIGIN=https://thekarlo95.github.io UNVERIFIED_ORIGIN=1 npm run a11y
```

and the log says out loud that the result is not pinned to a local build.

`npm run preview` is the same in-process host, kept running — **not `astro preview`**,
which is what produced the stale daemons in the first place (MUSE-35's review found three
still listening from manual invocations, outliving the sessions that started them) and
which is not a model of the host anyway: it answers both `/MuseByMina` and `/MuseByMina/`
with 200 and never redirects, so a trailing-slash regression is invisible to anyone
checking a page by hand. The replacement 301s the unslashed spelling, exactly as Pages
does, and dies with Ctrl-C.

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
                pages.ts (which routes the site serves — the words are in Sanity),
                sanity/ (the one read path: client, queries, decoders, fixture),
                site.ts (deploy-root URLs),
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

`llms.txt` descriptions come from the `page` documents in Sanity, which is also where the
pages themselves get them, so the index cannot drift from the site — and
`test/seo.test.ts` enforces that rather than assuming it, comparing every `llms.txt`
description against the `<meta name="description">` parsed out of that route's built HTML.

**Add a page → add its route to `src/lib/pages.ts` and a `page` document in the Studio.**
Forgetting the route is not a build error: `astro build` exits 0 and silently omits the
page from both the index and the sitemap. `npm test` is what fails — it derives the
expected page list from `src/pages/`, not from the registry. Forgetting the *document* is
a build error, naming the route and where to add it (`src/lib/sanity/index.ts`), because
a page with no document would publish with an empty `<title>`. Two documents for one route
is an error too: which title the page got would otherwise depend on query order.

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

**Submitting is `fetch` only, and the endpoint is never the `<form>`'s `action`**
(MUSE-15). It used to be, which meant that with the endpoint unset — how the site ships
— the form posted to the page itself and GitHub Pages answered `405 Not Allowed`: an
unstyled server page, every answer gone, the visitor off the site. Two things make that
unreachable now. `method="dialog"` on a form with no ancestor `<dialog>` aborts its own
submission per the HTML form-submission algorithm, *after* firing `submit`, so the
enhanced path is untouched and there is no native POST left to reject. And
`@media (scripting: none)` hides the form so the `<noscript>` block can offer the studio
inbox instead, because a form that cannot be sent should not be filled in.

Pointing `action` at the provider would also stop the 405, and the id is public so it
would not be a disclosure. It was not done because nothing here can check what Formspark
returns for a non-AJAX POST while no form is configured (MUSE-12 is parked), and the
`<noscript>` text would then be describing a confirmation page nobody has seen — which is
the shape of the bug being fixed. If that gets verified, swapping back is an `action`
attribute and a copy change, and `test/trialform.test.ts` already allows a cross-origin
one.

**A failure never shows the visitor a diagnostic.** The block renders a localised line
plus the inbox, and `console.error` gets the real error. Being offline is the one cause
separated out, because it is the only one a visitor can act on; HTTP statuses are
deliberately not in the copy. `test/trialform.test.ts` drives every failure mode —
including a build with no endpoint and a genuinely offline browser — and subtracts the
copy table from what was rendered: anything left over is a leak, which is how that suite
catches a diagnostic nobody has written yet.

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

Document types: `siteSettings` and `studioStory` (both singletons), `page`, `class`,
`scheduleSlot`, `instructor`, `pricingTier`, `event`, `galleryImage`, `post`, `faq`. Field
labels and descriptions are **Croatian**, because the person editing them is.

A singleton gets a fixed document id, a sidebar entry of its own and no "create new"
button (`sanity/structure.ts`, `sanity.config.ts`), because its query pins that id — so a
second copy would be a document the site never reads rather than one it reads at random.
`SINGLETON_TYPES` in `sanity/schemaTypes/index.ts` is the list that drives all three.

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

### What is in the dataset, and how the tests get it

Two document types hold real content today (MUSE-20): the `siteSettings` singleton —
studio name, tagline, summary, address, email, the three social links — and four `page`
documents carrying each route's short name, `<title>` and one-line description. The weekly
schedule and the instructors are deliberately **not** there: `src/data/schedule.ts` is
invented placeholder content naming two instructors who do not exist (MUSE-36), and the
real timetable goes into the Studio directly rather than through a migration.

The migration itself is a committed artefact, not a Studio session:

```bash
npm run sanity:seed         # import sanity/seed/content.ndjson, replacing by _id
npm run sanity:seed:check   # does the live dataset still say what the seed says?
```

That one file is also **the test fixture**. `npm test` runs ten real `astro build`s in
parallel workers, and ten HTTP round-trips per run would make the suite's result depend on
whether anybody is mid-edit in the Studio — so `vitest.config.ts` sets
`MUSE_CONTENT_FIXTURE=sanity/seed/content.ndjson` and `src/lib/sanity/fixture.ts`
evaluates the real queries against it with `groq-js`, Sanity's own GROQ engine. One file,
so the migration and the fixture cannot drift apart.

### A component whose page cannot be routed yet

`/aboutus` is built and not published (MUSE-23). Its `studioStory` and `instructor`
documents do not exist, and the read path fails the build naming a missing document — so
routing the page would stop `main` building, every pull request and every deploy with it.
The component is still held to its acceptance criteria, most of which are statements about
CSS that only a real build produces:

```bash
MUSE_PREVIEW_ROUTES=aboutus npm run build   # injects /aboutus-preview and /en/aboutus-preview
```

`src/lib/preview.ts` is the registry and carries the argument; `astro.config.mjs` injects
the routes from it and announces them in capitals. Unset — which is every deploy, every CI
job and every plain `npm run build` — nothing is injected and the output is identical to a
build that has never heard of it. The entry points live under `test/`, never `src/pages/`,
so a preview route cannot reach `llms.txt`, the sitemap or the nav; `test/aboutus.test.ts`
asserts that, and that no workflow sets the variable.

**An entry in that registry is meant to be short-lived.** If one outlives the ticket that
added it, that is a page somebody forgot to ship.

The deploy fetches live, and cannot do otherwise by accident: there is no default fixture
path and no fallback (a path that does not resolve *fails* the build), the build log says
which source it read with `FIXTURE` in capitals, and `test/content.test.ts` asserts that no
workflow and no npm script *assigns* the variable. What *can* still drift is the seed
against the dataset once Mina edits in the Studio — the deploy publishes her words either
way, and `npm run sanity:seed:check` diffs the two, field by field. CI runs it
`continue-on-error`, so drift is reported and never blocks a pull request.

Two consequences worth knowing before they surprise you:

- **A Sanity outage blocks every pull request and every deploy.** `npm run build` fetches
  live and fails if the API does not answer, and three jobs run it. There is no cached
  last-good snapshot and no retry beyond `@sanity/client`'s defaults. The trade is
  deliberate — the alternative is publishing pages with empty titles — but it is a real
  availability dependency, and `ci.yml`'s `continue-on-error` probe step does not soften
  it.
- **What the site said before the migration is frozen in `test/content.test.ts`.** It is
  the only copy of those strings left, and it is what makes "byte-identical to the previous
  deploy" an assertion instead of a command run once by hand. It is allowed to stop
  matching the day Mina rewords something — delete the entry with a sentence saying who
  changed it, rather than quietly updating it.

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

### How an edit in the Studio reaches the site

The site is static, so publishing in Sanity changes nothing until a build runs. **It runs
on a schedule** — `20 1,7,13,19` UTC, four times a day, from the `schedule:` trigger on
`deploy.yml`.

Not a Sanity webhook, deliberately. The webhook route needs a GitHub token stored inside a
third party, which is the specific property everything else here is arranged to avoid, and
a studio site that changes a few times a week is not worth buying instant rebuilds with it.
`workflow_dispatch` forces a rebuild for *us* with no credential at all; it is not a button
for Mina, because that is the token again.

The interval and what Mina is told are one decision, and `src/lib/rebuild.ts` is where both
live. `REBUILD_HOURS_UTC` produces the cron, and `MAX_WAIT_HOURS` — six, computed from the
largest gap between runs — is the ceiling the Studio promises her beside the Publish button
(`sanity/badges.ts`). The badge offers the next rebuild as a local clock time, computed in
her browser so it survives a daylight-saving change; the *promise* stays a duration,
because cron is UTC and a sentence naming 15:20 would be wrong for half the year.
`test/rebuild.test.ts` parses the workflow, re-derives the firing times independently over
a year of instants, and fails if the schedule and the promise disagree.

Two failure modes, handled differently:

| What breaks | What happens |
| --- | --- |
| Sanity unreachable mid-build | The build retries three times over four minutes, and only for that failure — a missing document or a GROQ typo is not retried |
| The deploy fails anyway | The `alert` job opens one issue, **assigned to the repository owner**, and comments on it rather than opening a second |
| The schedule is auto-disabled after 60 days of repository inactivity | `ci.yml`'s `rebuildloop` job fails on the next pull request, naming the re-enable step |

The alert is an assigned issue rather than GitHub's own notification because that
notification is weaker than it looks: for a scheduled workflow it goes to whoever created
it, moves to whoever last edited the cron syntax, moves again to whoever re-enabled it, and
is gated on a per-account Actions preference that has no API and so cannot be checked or
asserted. This repository's `subscribers_count` is 0 and `GET /subscription` 404s.
Assignment notifications are "Participating", on by default, and independent of all of
that.

The 60-day rule is the one case no alert inside the deploy can reach — a disabled workflow
does not fail, it does not run — and GitHub's documentation promises nothing about telling
anyone. Keeping the clock alive with synthetic activity was rejected: it rests on an
undocumented reading of "repository activity" and could not be tested. The workflow's
`state` field *is* documented, so `ci.yml` reads it instead, from the one workflow here that
is not scheduled and therefore cannot be disabled itself.

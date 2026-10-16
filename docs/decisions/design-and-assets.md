# Design system and assets

**This file is the argument, not the rule.** Each rule is stated in `CLAUDE.md`, which
every agent reads; the reasoning, the measurements and the alternatives that were weighed
and rejected live here. Read the section that covers what your ticket touches.

Nothing here is decoration. Each passage records a defect that recurred, or an approach
that was tried and failed, and the cost of rediscovering it is the cost of the original
bug. Do not shorten a passage to tidy it up — if something is genuinely stale, that is a
ticket (MUSE-114 is the open instance).

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

- **An asset the site's own code uses goes in `src/assets/` and is imported** — never
  `public/` plus a hand-written path. Vite rewrites a root-absolute CSS `url()` to
  include `base` **only at build time**, so `url('/fonts/x.woff2')` against a file in
  `public/` makes the deploy correct and `astro dev` 404: that is how all six faces fell
  back to Georgia for the life of the project, and why MUSE-14's `II:OO` was invisible
  locally (MUSE-35). Importing instead means Vite emits the file with a content hash and
  resolves every reference to it in both environments, with no base-path join anywhere.
  `src/styles/fonts.css` uses a relative `url()` into `src/assets/`; `BaseLayout.astro`
  preloads the *same files* via `?url` imports.

- **A preload must name the same URL as the thing it preloads, and the preloaded set must
  be exactly the set the page asks for.** Three failures, all silent. Point the preload at
  a second copy of the font and both URLs are 200, both resolve, and the browser downloads
  each face twice. Point it at a declared-but-unused subset (`-latin-ext` instead of
  `-latin`) and you pay for bytes the page never paints with and lose the preload on the
  ones it does. **Leave a needed face out and the page paints a word in two typefaces**
  (MUSE-74): `@font-face` subsets split on `unicode-range`, every Croatian diacritic lives
  in `latin-ext`, and `font-display: swap` paints the latin half of „Do**đ**i" in Cormorant
  while the `đ` comes from the system fallback — measured at 221 ms on a throttled cold
  load, 4 ms once both halves are preloaded together. `test/assets.test.ts` catches the
  first against `dist`; `test/fonts.test.ts` catches the other two by loading each page
  **with the preload tags stripped** and recording what the CSS engine then asks for — the
  only way to measure it, since a preload is itself a request and so "was it requested" is
  true by construction — and it compares the two sets **both ways**. The one-directional
  version (`preloaded ⊆ needed`) was green for the life of the project while four of the
  six faces were preloaded on no page at all.

  **The set is therefore per page, and `src/lib/fonts.ts` is the only place it is
  decided.** A Croatian page gets all six; an English page gets the three `latin` subsets
  plus whatever `EN_LATIN_EXT` names. **No list may say a page does *not* need a subset** —
  that list existed, for Cormorant's `latin-ext` per route, and two content PRs
  invalidated it on one day (MUSE-71 put a `đ` in `/schedule`'s display heading; MUSE-72
  put „Ožegovića" into the *English* privacy notice, making `/en/privacy` the first
  English page to need `inter-latin-ext`). A list that can say "does not need" is wrong in
  the direction a visitor reads; one that can only add is wrong in the direction the
  budget counts. The cost is measured and paid: 33.0 KB of Cormorant on the three Croatian
  pages whose headings are diacritic-free today.

  English is additive-only because the same default there costs 135.9 KB against a 109.8 KB
  payload, and because **a Croatian proper noun inside an English sentence will keep
  happening** — a street, an instructor's name, a quoted phrase — and no locale rule
  predicts it. Two things not to retry, both measured rather than assumed: the rendered
  text does **not** answer the question, because it is per *face* and `/pricing/` carries
  „Što je bachata" in `.navList a`, which is Cormorant and `display: none` at the measured
  width; and `Astro.slots.render()`, which does expose the body before `<head>` is emitted,
  **silently drops every component's hoisted `<script>`** — eight of fifteen pages lost
  theirs. Residual risk, stated in the file: `npm test` gates pull requests, the scheduled
  rebuild does not, so a *Sanity* edit putting a Croatian name into English copy can stale
  `EN_LATIN_EXT` and deploy.

- **There is a performance budget, it is `scripts/budget.mjs`, and it is deliberately
  not Lighthouse** (MUSE-63). The original plan listed `lighthouse` among the blocking
  checks; it was never built, and the only size guard was a `du -sm dist` step watching
  the GitHub Pages **1 GB site** limit — which would not notice one page going from 60 KB
  to 2 MB. What is budgeted is what is deterministic about the output: bytes per page per
  resource kind, the request count, how many requests are render-blocking, and **how many
  font faces the host actually serves the page**. **No timing and no composite score**: a
  gate that goes red because the runner was busy is a gate people learn to re-run, and
  then it protects nothing. The one timing collected is `advisory` — printed, and
  `checkBudget` structurally cannot see it, which is a test rather than a comment.

  **One budget for every page, with no per-route entries**, because the page set is read
  off the build: a route that lands tomorrow is budgeted the day it builds and there is no
  list to extend. Each number carries a sentence saying what it was measured at, and
  `test/budget.test.ts` reads the source's own JSDoc so raising one without saying
  anything is a red test. That is the whole argument for having done this now: today
  every number passes at 1.2–1.6×, and after the gallery and the portraits land the same
  numbers are a negotiation about which page to exempt. **The image line was the
  tripwire and MUSE-64 is the ticket it was set for** — 0 → 16 KB, measured at 11.1 KB,
  with the headroom sized for MUSE-40's icon and explicitly not for a photograph. The
  *total* ceiling did not move, which is the shape to copy: raise the one kind on its own
  merits and let the sum stay honest.

  **That negotiation happened in MUSE-25, and the answer was neither a raise nor a
  per-route exemption — it was to budget images per image.** `/gallery` was built against
  a fixture at four album sizes and weighed in a browser with every `cdn.sanity.io`
  request answered by a real photograph encoded at the width the URL asked for. Three
  things came out of it. The weight is **linear in the number of photographs** — 1,023,
  997 and 981 bytes of document per `<img>`, which is six Sanity URLs of `srcset` each, so
  48 KB of html binds at about fifteen pictures, 360 KB of total at fourteen, and 14
  requests at **four**. The multiplier is **editorial**: album size is Mina's decision,
  taken in a Studio, with no pull request — and CI builds from the seed, which has no
  photographs, so a flat raise would be a gate that stays green until the shoot and then
  fails on her upload in `deploy.yml`, where nobody is reading. And the two halves have
  different owners: *how many* pictures is hers, *how big each one is* is ours.

  So `bytes.image` is gone as a per-page sum and `imageResponse` replaces it — **32 KB,
  the heaviest single image response on any page** — which is stricter than the old line
  everywhere except a gallery, fires on every page, and does not move with content. The
  three content-sensitive lines carry a **`perImage` allowance** instead of a raise:
  1,280 bytes on `html` and on `total`, one on `requests`, per `<img>` the document holds,
  counted off the markup so there is still no list anywhere. `total` is additionally
  compared **without photography**, which is why that ceiling did not have to move at all:
  the heaviest page on the site is 307 KB on that basis whether the gallery holds nothing
  or forty-eight. The cost is slack on image-heavy pages — a twenty-four-picture gallery
  is allowed 110 KB of document and uses 65 — and that is the right side to be wrong on,
  because the thing the line protects against is a page growing a *feature*, and a feature
  is still 48 KB whatever the album is.

  The **font count has a floor, and the floor is the half that finds things.** It is
  MUSE-35: all six faces 404ed under `astro dev` for the life of the project, so
  reproduced against a build that is six requests and **zero faces served** — which is why
  the count is of faces the host *served*, not of requests made, and why a ceiling alone
  reads zero as the leanest page it has ever seen. Measured with the preload tags stripped
  out of the document first, `test/fonts.test.ts`'s technique and for its reason. Two
  entry points, one set of numbers: `test/budget.test.ts` is the gate and builds both
  deploy targets, `npm run budget` prints the table over `dist` and runs inside the
  existing `a11y` job (MUSE-58's precedent — not a sixth check).

- **The brand lockup is the supplied artwork, rendered by `Lockup.astro` and nowhere
  else** (MUSE-64). Design system §12 forbids *"rebuild the lockup from separate parts"*
  by name, and two spans of Cormorant and Jost is that construction — it renders
  perfectly, passes every contrast check and looks deliberate, which is why
  `test/lockup.test.ts` reads the markup rather than the page. `src/assets/
  muse-lockup-white.png` is the supplied transparent PNG trimmed to its 855 × 622 of ink;
  `logo/` stays a source directory. One 320px WebP, 11.1 KB, no `srcset` (the gate runs
  at `deviceScaleFactor: 1`, so a 1× entry would budget a file almost nobody fetches) and
  **no theme swap** — both bands are `--surface-deep`, so the white variant is right on
  both. §12's clear space is a *fraction of the drawn size*, so it is derived in
  `src/lib/lockup.ts`, which refuses to draw below §12's 100px rather than clamping.

  **The masthead carries the icon-only mark instead, and which surface gets which is
  arithmetic** (MUSE-67). 100px wide is 73px tall at 1.372:1 and 121px with its clear
  space, against bands of 64px and 80px (§7.1) — so the lockup is out of the masthead at
  *both* widths, not only on phones, and the size that would fit is 55px, where "DANCE
  STUDIO" and "BY MINA" stop being words. §12's variants table names the icon-only mark
  for the compact header; MUSE-40 shipped it, and at **36px tall — 27px wide against
  §12's 24px floor, 12px of clear space, a 60px envelope** — it fits both bands. One
  size in both, because a second size is a second dilation radius and so a second file.
  The full table is in `logo/README.md`, which is where the next person will look. Do not
  shrink the lockup into the band to make the guard green: it would pass, and the logo
  would be illegible.

  `REBUILT_FROM_PARTS` is now **empty**, and both halves of that machine worked in order:
  the entry was asserted *still live*, so fixing the masthead turned the suite red asking
  for the line to be deleted. What replaced the exemption is not an empty map — it is
  `the built masthead presents the mark`, so "no component rebuilds the lockup" cannot be
  satisfied by a band with no brand in it at all.

- **The icon-only mark is a crop of the lockup, and the small sizes are thickened**
  (MUSE-40). §12 specifies it as dancer + `M`; both were already in
  `muse-lockup-white-transparent.png`, with a clean 18px run of transparent columns
  between them and the type, so `src/assets/icon/` is a **crop and nothing else** —
  `logo/README.md` writes the derivation out so nobody re-derives a similar mark instead
  of the same one. The one intervention is optical sizing: below ~1 device pixel of
  stroke there is nothing left to antialias, so the alpha is dilated by `STROKE_GAIN ÷
  scale` before resampling, and `test/icon.test.ts` measures the committed pixels against
  what an undilated crop would have given — a regenerated-without-it icon is otherwise
  the right mark, right size, right colour, and a smudge. The masthead's copy
  (`muse-mark-white.png`, MUSE-67) is the same intervention at a different size and so a
  different amount — **0.3 CSS px per side, not 0.5**, because 36px is twice the tab
  icon's worst case — and it is kept at the crop's own 461 × 622 with no resample, since
  Astro emits the WebP from it. The unit is CSS pixels because one file serves every
  display. **Both schemes, mutually exclusive `media`**: the artwork is white-only,
  invisible on a light tab strip, and the plum variant is §12's recolour (RGB replaced,
  alpha preserved) with a test pinning the two alpha channels byte-identical. All five
  *tab* files carry **`?url&no-inline`** — they are under Vite's 4 KB threshold, and
  inlined they became
  `data:` URIs, which is 8.3 KB of base64 on every page, all five icons shipped to every
  visitor, and the icons out of both the budget's `image` line and
  `test/assets.test.ts`'s reach. The masthead mark does not need the suffix and must not
  have it: it goes through `astro:assets`, which emits a file by construction, and the
  query string would hand the component a URL instead of the `ImageMetadata` `<Image>`
  needs. There is **no `public/`**: on the Pages sub-path a `public/favicon.ico`
  publishes under the base prefix while the bare probe goes to the *origin* root, so it
  would answer nothing and cost MUSE-35's resolution bug. **That argument stands and one
  link was still missing** (MUSE-75): an unknown media feature is *false* rather than
  ignored, so a UA that reads `media` but has no `prefers-color-scheme` ruled out both
  branches and matched no icon at all. The default branch is the **opaque tile** — the
  file the iOS entry already points at — because the four above need a `media` precisely
  *because they are transparent*, and its 180 keeps the pair deterministic, since the
  tie MUSE-40 avoided exists only between candidates of the same declared size. An apex
  domain (MUSE-29) adds a root `favicon.ico` to this and nothing before it does.
  **And the 16 is a smear at true size for the reason §12 implies**: the recipe
  reproduces the committed files to three decimals, raising the gain makes it *worse*,
  padding is a wash, and the only thing that works is cropping the dancer back — which
  is a different mark at one size, so it is Mina's call and is raised rather than taken.
  The measurements are beside `STROKE_GAIN`; do not re-run them. The share card is a
  separate asset and a separate bullet, below.

- **A shared link shows a picture, and `siteSettings.shareImage` is what decides which**
  (MUSE-69). `BaseLayout.astro` emitted `og:title`, `og:description` and `og:url` and no
  image, so every link in a WhatsApp group rendered as a bare line of text — and the CMS
  field for it had existed end to end since MUSE-20 **with no reader**, under a Studio
  description promising Mina that WhatsApp and Facebook would show it. `shareCard()` in
  `src/lib/share-card.ts` is the one decision point: her upload if she has set one,
  `src/assets/muse-share-card.png` if not. **The fallback is allowed and the reasoning is
  the thing to keep**: the rule MUSE-49 and MUSE-36 share is *never assert something
  nobody said*, and the studio's own mark asserts nothing beyond "this is Muse by Mina",
  which every page already says. A fallback the editor does not know about reads as a bug,
  so the field description tells her it exists and that uploading replaces it.

  The URL is `new URL(card.src, Astro.site)` — **derived, never written**, which is the
  whole of why MUSE-42 stays green; a root-relative `og:image` is silently ignored by most
  scrapers, so it has to be absolute and it may not name a host. `og:image:width`/`height`
  are not padding: without them Facebook renders the *first* share of a URL with no image,
  because the card is laid out before the fetch, and `imageSize` answers them for an
  upload off the asset id — clamped to what the asset has and fed back into `imageSrc`, so
  the tag and the bytes cannot disagree. **No `og:image:type`** (`auto=format` makes it
  unknowable) and **no `og:locale:alternate`**: it is an instruction, not a hint — Facebook
  refetches the same URL with `?fb_locale=` expecting a different language, which a static
  site with the locale in the path cannot give it, so it would cache Croatian as the
  English rendering. The hreflang cluster is where the pairing is stated.

  **The 404 carries a card**, unlike the canonical and the JSON-LD, because an image is
  not a claim about a URL — the same reason it carries a tab icon and a `theme-color`. It
  already emits `og:title` and `og:description`, so withholding only the image is exactly
  the bare text card this ticket is about, on the page a dead shared link reaches.

  The card itself is §12 executed rather than a new design (MUSE-40's principle): the
  supplied lockup 500px wide on opaque plum, centred, §12's 120px clear space with 13px of
  slack — `logo/README.md` has the arithmetic and why 500 rather than the 521 §12 allows.
  **`npm run budget` structurally cannot see any of this** and reporting nothing is not
  evidence: no page element references an `og:image`, so headless Chromium never fetches
  one. `test/share.test.ts` weighs the committed file instead — it holds a **ceiling of 40 KB**
  (the committed file is 23,745 bytes today, so it can grow by about 70% before anything
  goes red) — and
  re-measures its pixels against `muse-lockup-white.png` by **column *and* row** ink
  profile — a mirrored copy scores 0.22 on columns and 0.9999 on rows, so one axis alone
  passes it. `assetRefs` reads a `<meta>` image now, which is what gets the card resolved
  against `dist` under both deploy targets by `test/assets.test.ts` with no build added.

  **`og:site_name` was absent until MUSE-75, so a scraper credited „github.io".** With no
  such tag the publisher falls back to the host, which MUSE-29 would only have changed
  into a different wrong answer. It is `settings.studioName`, off the same memoised read
  the footer, the JSON-LD and the card use, and ungated for `og:image`'s reason. The
  assertion with teeth is the one that rebuilds from an edited `studioName`: every
  equality test passes with a literal in the layout.

# What each page says

**This file is the argument, not the rule.** Each rule is stated in `CLAUDE.md`, which
every agent reads; the reasoning, the measurements and the alternatives that were weighed
and rejected live here. Read the section that covers what your ticket touches.

Nothing here is decoration. Each passage records a defect that recurred, or an approach
that was tried and failed, and the cost of rediscovering it is the cost of the original
bug. Do not shorten a passage to tidy it up — if something is genuinely stale, that is a
ticket (MUSE-114 is the open instance).

- **`/privacy/` is a statutory document, so it stays in code — and the one fact that varies
  is read off the form's own configuration** (MUSE-72). It had asserted, in both locales and
  the present tense, that Formspark was the studio's processor under an Art. 28 agreement
  and emailed the messages through, with `PUBLIC_FORM_ENDPOINT` unset for the life of the
  project; that AZOP sat on Selska cesta, which it left in May 2025; and that enquiries are
  kept twelve months and then move to „evidencija polaznika", neither of which anybody had
  decided. Prose in a component cannot be watched, which is MUSE-50's argument — but
  **moving a legal notice to the CMS was weighed and declined**, and the reasoning is
  written out in `Privacy.astro`: AZOP's address has no second surface for a test to compare
  it against in *either* home, so Sanity would buy editability at the price of review and
  gain nothing; and a `required()` retention field can only be satisfied by inventing a
  number, which is how this defect happened. What it got instead is a **dated provenance
  comment** on the address (re-read `azop.hr` and move the date) and `FORM_HAS_PROCESSOR` in
  `src/lib/forms.ts` — the same expression `TrialForm.astro` tests before it will `fetch` —
  gating the recipient paragraph, so the notice and the form are one fact rather than two
  copies. Art. 13(1)(e) takes *categories* of recipient, so the live paragraph names no
  provider: an environment variable says somebody receives the data, never who, and a name
  would be the next unwatched fact. **The guard is both directions** — endpoint unset must
  name no processor, endpoint set must — proved against two real builds at the end of
  `test/trialform.test.ts`, which is the one suite that already serves both states, so it
  cost zero against `DECLARED`'s headroom. **Retention and whether student records exist are
  Mina's decisions and still outstanding**; until she gives them the page says purpose
  limitation and the erasure right and no number. `test/contact.test.ts` used to *demand*
  the string `Formspark`, so the notice could only have been corrected by reddening a test —
  worth remembering the next time an assertion pins a vendor's name.

- **`/aboutus` ships placeholder prose, and it is placeholder where a human can see it**
  (MUSE-60). The owner asked for a few generated sentences so the page could ship. That is
  a stopgap, and it is only a stopgap because of three things, none of which is optional:
  the text is in **`content/seed.ndjson`** rather than in `AboutUs.astro`, so Mina replaces
  it by typing over it; it **asserts nothing checkable** — no founding year, no student
  count, no award, no claim about anybody's training; and the Studio field descriptions say
  `PRIVREMENI TEKST` in Croatian, which is the only instruction she reads. Replacing it is
  a Studio edit and needs no ticket. **Silent** placeholder text is what MUSE-36 is about;
  placeholder text is allowed.

  `studioStory.foundedOn` came off the required list with it, and that is the same
  decision rather than a relaxation: MUSE-23 made the origin story dated on purpose, no
  founding date for this studio is recorded anywhere, and a `required()` date could only
  have been satisfied by picking a plausible day. The page omits the line; the decoder
  still refuses a value that is present and is not a calendar date, and `shape.ts` asserts
  the field *as* optional, because a field with no assertion is a field nothing watches.
  **No bio is written for Mina or Antonio and none should be** — see the optional-field
  note below, which is the same argument on the same page.

- **`/whatisbachata` says what the dance is, and nothing about the curriculum**
  (MUSE-65). It is the one of MUSE-27's four trust pages that could be written without
  Mina, because its subject is general knowledge; the other three are studio facts and
  stay in that ticket. Every sentence on it is either **a fact about the dance** or **a
  fact already published from the dataset**, and the second kind is *read* — the levels
  present in the timetable in `LEVELS` order, the evenings from `groupByDay`, the length
  from `uniformDuration`, the teachers joined by `formatNames`. A literal that happens to
  match today's seed passes every equality test there is; `test/whatisbachata.test.ts`
  rebuilds from an edited dataset and demands the seeded words appear in no byte of
  `dist` (MUSE-50).

  **The styles are allowed as a sentence and forbidden as structure.** The page may say
  that traditional Dominican, modern and sensual exist and differ — that is true of the
  dance. It may not say which is taught here, and MUSE-36's `STYLES` may not come back:
  no schema field named after a style (`test/sanity.test.ts`), no route, no filter, and
  **no section per style**, because three headings in the shape of a course outline read
  as a curriculum whatever the words say. So the three names live in **one** paragraph of
  the CMS body, that is asserted, and the page links to `/schedule` rather than
  explaining the programme. Note the needle: „Dominikanska Republika" is also where the
  dance comes from, so the guard keys on `sensual` and `moderna`, the two words that can
  only be style names here.

  **`prosePage` is one document type designed for four pages and used for one.** Keyed by
  `route` exactly as `page` is, so the Studio dropdown is `ROUTES` and a document cannot
  describe a page the site does not serve; `getProsePage(route)` indexes all of them and
  fails naming the route when there is none **or two**, with `minimum: 0` for
  `pagesByRoute`'s reason. Its body is an array of bilingual paragraphs and **not
  Portable Text**: when MUSE-65 was written nothing on this site rendered it, so the first
  consumer would have had to write a renderer, and Mina would get headings, bold and links
  inside a paragraph whose type scale the design system fixes anyway. `studioStory.story`
  took the same decision and argues it at length. **MUSE-26 wrote the renderer** — it is
  `src/lib/portable-text.ts` and `post.body` is its only caller — and the decision here
  stands for the second reason rather than the first: a page of prose the design system
  sets at one scale has nothing to gain from an editor that can pick a different one. There is no image field, for the
  optional-field reason: no photography of this studio exists.

  One limit, stated rather than discovered: a `prosePage` for a route the site *does*
  serve but whose page renders no prose publishes nothing and nothing says so — MUSE-46's
  inert document minus the half that is detectable. `getProsePage` is asked about one
  route at a time and "which routes have prose" is written down nowhere, deliberately,
  because a fourth list of pages is what MUSE-46 argues against. The dropdown is the
  instrument that reaches Mina. `test/helpers/structural-content.ts` keeps the fixture's
  own list in `PROSE_ROUTES`, and forgetting to extend it is loud: every suite that
  builds the site against `FULL` goes red naming the route.

  **The `<h1>` and the nav label are deliberately different strings** — „Što je bachata?"
  against „Što je bachata" — and `prosePage.heading` is in `test/contentdrift.test.ts`'s
  `CMS_OWNS` while the label is code. The seeded `<title>` *does* repeat the heading,
  which is a copy in the dataset and allowed; the edited-dataset build therefore moves the
  `page` document too, so "the seeded prose appears nowhere in the output" stays a flat
  claim rather than one with a carve-out a real literal could hide inside — the move
  `test/contentdrift.test.ts` makes with `siteSettings.summary`, with a test beside it
  asserting the reason is still true.

  `MORE_NAV` is non-empty for the first time since MUSE-13, which brings the header's
  "More" disclosure back. That is where a trust explainer belongs: the desktop bar is the
  decision path and is budgeted at four links plus the disclosure, a fifth uppercase link
  at 0.18em tracking is what makes it wrap, and the entry is still complete in the mobile
  panel and in the footer's quick list. `test/nav.test.ts` was already written as a
  conditional on `MORE_NAV` rather than as "there is no More button", so the disclosure is
  held to its own criteria the day it comes back.

- **`/events` ships empty, and being honest about that is the page** (MUSE-24). There are
  no `event` documents and nobody has given us any; `getEvents` supports `minimum: 0`, so
  an events page with nothing on it is a legitimate page rather than a broken one — which
  is the whole reason this one could be built while `/gallery` and the trust pages cannot.
  The empty state says „Nema objavljenih događaja.", renders **no list and no section
  heading** (an empty grid reads as a page that failed to load), offers `/schedule` and
  `/contact`, and says nothing at all about past events. Its words are `EVENT_COPY` in
  `src/lib/events.ts` and are deliberately **not** in the CMS: „there are no events" is a
  statement about the dataset, and Mina cannot keep a field describing the dataset true
  because she cannot see when it renders. No invented event anywhere — not in the seed, not
  „to show the layout"; the fixtures are `EVENTS_RENDERED` under `test/`.

  **Three queries over one document type, and the third is the point.** `EVENTS_QUERY` and
  `PAST_EVENTS_QUERY` are **exact complements** given the same `$now`, so every event is on
  exactly one page; they are written out rather than negated, because `endsAt >= $now` over
  an absent `endsAt` is `null` in GROQ and `!null` is `null`, so `!(upcoming)` would drop
  every event with no announced end from *both* lists. `ALL_EVENTS_QUERY` takes **no
  clock** and is what `getStaticPaths` reads: which pages a build emits may not depend on
  when it ran, or an archived event's URL would stop resolving. The partition, and that
  `hasPassed` — the sentence „Ovaj je događaj prošao." on the detail page — agrees with it
  row for row, are `test/projections.test.ts`.

  **The transition is a build, and the window is `MAX_WAIT_HOURS`.** Nothing moves until
  something builds; what builds is a push and MUSE-21's cron, so an event that finished
  just after a run can sit in the upcoming list for very nearly the largest gap between
  runs. Accepted: the alternative is a second answer to the same question in JavaScript on
  a page whose most important reader is a crawler, it is wrong in the harmless direction
  (last night's party, with last night's date printed on it), the detail page says so in
  words, and **no URL depends on it**. The number is cited by name and never written out —
  `test/events.test.ts` fails on an hour count in those files, for the reason MUSE-21
  promises a duration and not a clock time. Nothing on the page is stamped with a build
  time, which would break MUSE-20's byte-identical criterion.

  **The slug is permanent, so the Studio prefixes the year.** `/events/<slug>/` is the
  document's stored slug — not derived from the date at build time, because a derived URL
  moves when Mina corrects a typo and an archive URL that moves is one that 404s for
  everyone who ever linked it. `source: 'title.hr'` alone collides with a repeat annual
  event and leaves her inventing `noc-bachate-2` as that edition's permanent address, so
  the source is a function giving `2026-noc-bachate`. **`archive` is refused**: Astro gives
  a static segment priority, so an event slugged that would build a page nothing can reach.
  `reservedEventSlugs()` reads the children of `/events` off `ROUTES` rather than listing
  them, and `assertEventSlugs` fails the build naming the event, the slug and the route it
  collides with. It is a build guard and not a Studio one on purpose — `Rule.custom` is the
  only instrument Sanity offers for this, and `enums.ts` records that a custom rule is
  skipped without a client, so it would be real in the Studio and unobservable in a test.

  Four smaller things that are easy to undo. **`/events/[slug]` is a template, not a
  page** — it is in `NOT_A_ROUTE`/`NOT_A_PAGE` with the reason, it has no `ROUTES` entry
  and no `page` document (its `<title>` is derived from the event), and it is in the
  **sitemap** and deliberately not in `llms.txt`, which is a short index of the site's
  sections and links the sitemap for the rest. **`getStaticPaths` runs before any page
  renders**, so it is the first read of the build and the one a Sanity outage hits — and
  Astro prints a `getStaticPaths` rejection *without* the error's class name, which would
  have quietly removed `SanityUnavailableError` from the one log that tells `decode.ts`'s
  three outcomes apart; `readStaticPaths` in `src/lib/sanity/index.ts` folds it back in and
  `test/content.test.ts`'s unreachable-API build is the guard. **`/events/archive` is in no
  nav list** — a site-wide „Arhiva" entry would advertise past events on every page of a
  site that has never held one, so it is reached from `/events/`, unconditionally — which
  makes it the first page here whose route the footer does not list, and
  `test/nav.test.ts`'s `aria-current` block is now a partition on „does the footer list
  this section" rather than a claim about every page. And **`src/lib/events.ts` is schema
  source**: the schema imports `EVENT_TYPES`/`EVENT_TYPE_NAME` out of it, so it is in
  `check-sanity.mjs`'s `SOURCES` *and* in `studio.yml`'s `paths:` — two lists, asserted
  equal, and no third.

- **`/gallery` ships with no photographs, and that is the honest hard case** (MUSE-25).
  `/events` and `/blog` ship empty too, and the difference is worth stating because it is
  what the design had to answer: **their purpose survives having no content and a
  gallery's does not.** An events page with nothing on it still tells you the studio runs
  a weekly timetable; a gallery with nothing on it tells a visitor nothing they came for.
  So the page is thin and is not disguised — no placeholder tiles, no decorative frames,
  no stock imagery, and **no lede**, which is the one thing this empty state withholds
  that `/events` keeps, because a lede here could only describe photographs that do not
  exist. It says „Nema objavljenih fotografija.", renders no grid and no section heading,
  states a present fact (the studio has not been photographed) rather than a promise, and
  offers `/schedule` and `/contact`. The words are `GALLERY_COPY` in `src/lib/gallery.ts`
  and are **code, not CMS**, for `EVENT_COPY`'s reason. No `galleryImage` in the seed; the
  fixtures are `GALLERY_RENDERED` under `test/`.

  **It is in `MORE_NAV` and not in the desktop bar**, and that is the ticket's own
  instruction rather than the four-link budget alone: a „Galerija" entry in the masthead
  of all fourteen pages, promising pictures, leading to a page that says there are none,
  is an invitation the site cannot honour repeated fourteen times. Promoting it is the
  shoot's ticket, which is how „the photographs landed" shows up in a diff.

  **The lightbox is a native `<dialog>` opened with `showModal()`, and the reason is one
  word: inertness.** The built output has zero `.js` files, so the mechanism had to be
  CSS, markup or an inline `<script>`, and the three candidates are argued in
  `Gallery.astro`. `:target` cannot trap focus at all and spends the Back button — twelve
  history entries for twelve photographs. `popover="auto"` needs no script, light-dismisses
  and returns focus, and is **specified not to make the rest of the document inert**, so
  Tab walks straight out of a thing that looks, reads and announces as modal. `showModal()`
  gives the trap, Escape, and focus returned to the thumbnail, from the platform — so the
  script writes none of them, and the test for the trap is a test of *inertness* (focus a
  tile behind the dialog; nothing happens) rather than a test that a handler wrapped an
  index. **With scripting off the grid is the gallery**: every photograph is on the page
  with its alt text, and each tile is an `<a href>` to that picture's own 1200w CDN URL, so
  a tap opens the browser's own image view. A `:target` panel underneath was rejected for
  MUSE-38's reason — two mechanisms answering one question, only one of them ever audited.

  **`.frame[hidden] { display: none }` is load-bearing and its absence is silent.**
  `[hidden]` is a *user-agent* rule and any author `display` beats the UA stylesheet, so
  `.frame { display: grid }` quietly put all seven photographs in the layout at once and
  fetched every full-size file the moment the lightbox opened — a stage 5,002px tall in a
  900px viewport, with the picture that was asked for 636px above the top of the screen.
  Found by measuring boxes, not by looking; `test/gallery.test.ts` counts layout boxes and
  full-size requests with the lightbox open, which is why both numbers are pinned.

  **`npm run a11y` only sees a page at rest, so the open lightbox is audited in the
  suite** — both themes, no tag filter, `test/contact.test.ts`'s precedent for the trial
  form's error state and the gap this ticket names.

  **`imageSrcSet` arrived here** (`src/lib/sanity/images.ts`), with the ladders in
  `src/lib/gallery.ts` derived from the boxes the layout can paint rather than rounded —
  three rungs each, every box covered within 1.21× in the grid, nothing above 600w for a
  tile. `test/gallery.test.ts` measures `img.currentSrc` against the painted box in a real
  browser at 390 and 1280, because a model of the selection algorithm passes whenever the
  model is wrong. **§7.4 and §9 disagree about the grid and §9 wins**: §7.4 says „mixed
  aspect ratios", §9 rule 4 says 1:1 for a gallery, the Studio field promises Mina 1:1 and
  the ticket asks for 1:1 — noted in `Gallery.astro` rather than silently resolved.

  Two things raised and not fixed, both in `Gallery.astro`: a modal `<dialog>` does not
  lock the page behind it, and the CSS-only fix (`:has()` plus `overflow: hidden`) costs a
  visible 15px jolt on close unless `scrollbar-gutter: stable` goes on every page of the
  site, which is a layout change that does not belong in this ticket; and nothing here has
  seen Sanity's own encoder, because no photograph has ever been uploaded to this dataset —
  the budget's bytes are a real encoder at the real widths, but not *their* encoder.

- **`/pricing` publishes the studio's three rates, and that is the whole rate card**
  (MUSE-73). 55 € regular monthly, 40 € student monthly, 20 € drop-in — confirmed by the
  owner on 2026-10-09, in those words, after being asked for the complete card.
  `test/pricing.test.ts`'s `CONFIRMED_TIERS` is the receipt and a fourth document in the
  seed is a red test. None of the three is `featured`: nobody has asked which to single
  out, three cards is exactly the arrangement a „most popular" tab is written for, and
  `resolveFeatured` treats zero as a complete page. `features` is `required().min(1)`, so
  „an empty optional field is a decision" could not be taken — each line restates what the
  rate *is* rather than claiming what a month of classes contains, which is the only
  honest thing to put there when the card gives a name, a price and a period and nothing
  else.

  **It said „two periods: 55 € for one month, 100 € for two — and the whole of it" until
  MUSE-73, and that sentence is the shape to learn from.** It was true that MUSE-59 was
  told so; it was not the rate card. The studio's own enrolment form charges three rates
  and no two-month package, so the site was missing the student rate and the drop-in and
  publishing a price nobody offers. **Every mechanism on this board stops the site saying
  more than is true, and nothing watches it saying less** — a frozen list, a document
  count, a residue subtraction and an invented-price scan are all one-directional, and
  all four were green. The receipt now records *who was asked and when*, because that is
  the only instrument there is for the other direction.

  **Retiring a rate is a seed deletion, which is a case this repository cannot finish.**
  `npm run sanity:seed` is `sanity dataset import --replace`: it replaces by `_id` and
  **never deletes** what it was not given, so dropping the line leaves the document live
  and rendering while the suite, reading the seed, shows it gone and passes. The dataset
  half is `sanity documents delete <id>`, a write, and **an agent does not run it** — same
  rule as the import. Order matters and the gap is the reason: delete first, then import.
  Between the two writes the dataset is briefly inconsistent either way, and MUSE-21's
  cron can rebuild inside that window — import-first publishes four cards including the
  retired price, delete-first publishes a truthful page that is one rate short.

- **`/blog` ships empty, and a post may be written in one language** (MUSE-26). Four
  decisions, and the second is the one the ticket was really about.

  **The empty state is the shipped state.** No `post` exists and nobody has written one,
  so `getPosts({ minimum: 0 })` and `Blog.astro` say there is nothing — as the section's
  own heading, with no list rendered at all, offering `/schedule` and `/contact` instead.
  The copy is `BLOG_COPY` in **code, not the CMS**: „there are no posts" is a statement
  about the dataset, and Mina cannot keep a field describing the dataset true because she
  cannot see when it renders. It promises nothing either — „ništa za sada" is a claim
  about a post nobody has written, which is MUSE-36 in a smaller font. **Do not seed a
  post to furnish the page.**

  **A post that exists in only one locale is hidden in the other, and one fact decides
  it.** `post` carries up to two `postTranslation` objects — one per language, each with
  its own title, lede and body — instead of three bilingual fields, and „published in
  Croatian" is „`post.hr` exists". That one fact is what the index filters on, what
  `getStaticPaths` filters on, what `localeTwins` is built from, and therefore what the
  `hreflang` cluster and the switcher read; the sitemap drops a one-member alternate group
  on its own. **All four agree because there is nothing for them to disagree about.** The
  inversion is deliberate and it is the only place on the site it is right: everything
  else bilingual is short, and **nobody writes eight hundred words twice** — a `required()`
  English body can only be satisfied with a machine translation, which is a `required()`
  field filled with fiction. Sanity validates a nested `required()` only when the parent
  object is present, which was **measured against its real validator**, so a *half*
  translated post is still refused naming the field. The one rule it cannot state —
  „at least one of the two" — is `decodePost`'s, because `required()` has no one-of form
  and `Rule.custom` is unobservable in a test. Listing the post in the other locale with a
  „na hrvatskom" badge was the alternative and is argued down in `src/lib/blog.ts`: it
  drops an English reader into a Croatian page whose switcher is correctly hidden.

  **`src/lib/portable-text.ts` is the site's first and only Portable Text renderer**, and
  `@portabletext/to-html` was declined with a measurement rather than on taste. It is in
  the lockfile only as a transitive dependency of a devDependency, so taking it means a new
  `dependencies` entry; and **four of its five unknown-construct defaults are silent** —
  an unmapped block *style* renders as `<p>`, an unmapped list as `<ul>`, an unmapped mark
  as a `<span>` — so getting a failure out of it means remembering five override slots,
  which is the shape of defence this repository has watched fail three times. Here the
  refusal is the default: every branch is exhaustive, the fall-through **throws naming the
  construct, the block `_key`, the document and the three files a new rule goes in**, and
  `PROSE_ELEMENTS` is derived from the same maps so `test/blog.test.ts` can require
  `PostPage.astro` to style every element the renderer can emit. Two things in it that
  look arbitrary and are not: the schema's `h3` style renders as **`<h2>`**, because a
  post's `<h1>` is its title and `heading-order` is live in `npm run a11y` since MUSE-75;
  and **validation happens before the empty-block skip**, because the other order silently
  dropped an unmapped construct inside a block with no readable text — found by a test
  asserting the refusal, not by one asserting the rendering.

  That renderer is also the answer to „a stray image or a wide code block". Neither can
  reach a page: the schema offers neither and the renderer stops the build on either,
  which is stronger than a CSS rule about something nobody has seen. What CSS still has to
  handle is a long unbroken token — a pasted URL as link text — and that is
  `overflow-wrap: anywhere` inside a 68ch measure, measured at 390px with a 200-character
  token in the fixture.

  **The byline always says somebody.** A named `author` is the instructor; an empty one is
  the **studio's own name**, off the same `getSiteSettings()` the footer and the JSON-LD
  read, because „Ostavi prazno i objava je potpisana studijem" is the field's documented
  default; a *deleted* one is a build failure naming the `_ref` (MUSE-49, and this is the
  field that ticket is named after). So there is no „no byline" branch, and the `author`
  /`authorRef` pair must stay a pair.

  **A scheduled post appears at the next build, not at its publish instant**, and the
  worst case is `MAX_WAIT_HOURS` — cited by name and never written as a number, which
  `test/blog.test.ts` asserts. Note the asymmetry with `/events` and do not copy its shape:
  an event must keep its page *after* it happens, so `ALL_EVENTS_QUERY` is clockless; a
  post must not have one *before* it does, so `POSTS_QUERY` is the only query over `post`
  and `getStaticPaths` uses it. No URL is lost by that — the filter only ever drops the
  future.

  Two smaller things. `post.coverImage` is **optional** (the `instructor.portrait`
  decision: no photography of this studio exists, and a required cover can only be
  satisfied with a stock photograph), and `/blog/<slug>/` has **no `page` document** — its
  `<title>` is derived, so `test/routes.test.ts` and `test/seo.test.ts` carry
  `/blog/[slug]` as a *template* rather than a page. `article` structured data is the
  `BlogPosting` node `src/lib/structured-data.ts` adds to the one `@graph`
  `BaseLayout.astro` emits; there is still exactly one `<script type="application/ld+json">`
  on the site (MUSE-31), and a post hands its facts *up* rather than emitting a second.

  **One thing this ticket could not fix and did not hide**: `EN_LATIN_EXT` in
  `src/lib/fonts.ts` is keyed by route, and `/blog/<slug>` is the first route whose key is
  *content*. So an English post containing a Croatian proper noun — „Ožegovića", an
  instructor's name — wants `inter-400-600-latin-ext` and cannot be listed for it, and
  `test/fonts.test.ts` cannot see it either, because no post is in the seed it measures.
  Preloading the three subsets on every English post page was considered and rejected: the
  rule there forbids **any** unused preload on an English page, and an entry measurement
  does not support is exactly what that rule is about. It is MUSE-74's own stated residual
  risk, now reachable from the CMS rather than only in principle, and it wants its own
  ticket.

- **The site makes no claim about what a first class costs** (MUSE-71). „Besplatni probni
  sat" / "Free trial class" was the header CTA on all fourteen pages in both locales, and
  the promise was repeated in the homepage `#trial` band, `/contact`'s eyebrow,
  `/schedule`'s CTA band and both `page` descriptions — so in the two
  `<meta name="description">` tags Google shows and in `llms.txt`. The studio offers no
  such thing: its own 2026/2027 enrolment form lists 55 € regular, 40 € student and 20 €
  drop-in and no trial rate, and the claim came from MUSE-36's commit. It is gone and
  **nothing replaced it** — naming the drop-in rate would cover one invented offer with a
  second, since nobody has said that is what a trial costs. Retiring an unsupported
  commercial promise needs no decision from the studio; **adding one does.**

  The guard is one rule in `test/helpers/offer-claims.ts` applied at two levels, and both
  are load-bearing. **It holds two retired claims, not one** — MUSE-80 added the response
  time below — so each needle carries its own `ticket` and `untrue`, and the failure
  states the one that fired. A third belongs here too rather than in a second mechanism.
  `test/offerclaims.test.ts` reads `src/`, `sanity/` and the seed as plain text, so a
  failure names a `file:line`; `test/content.test.ts` applies the same
  needles to `dist`, because a claim *composed* at render time appears in no source file
  and on every page (MUSE-50) — demonstrated, and caught only there. It uses the build
  that suite already performs: the heavyweight budget has zero headroom. The needles test
  **adjacency**, not the word "free", since seven lines under `src/` use it about Actions
  minutes, a URL fragment and a layout; `INNOCENT` pins each and asserts it still exists.
  There is **no exemption list**, so a comment explaining the removal names the ticket
  instead of quoting the claim — MUSE-42's ruling, as `test/contentdrift.test.ts` applies
  it.

  Two things this cannot do, stated so nobody assumes otherwise. `contentdrift`'s registry
  classifies a field as CMS-owned or in-code and **cannot ask whether a human said it** —
  `page.description` was correctly classified and correctly in the CMS, which is the hole
  this came through, and no test closes it. And the CTA label is still a code literal:
  moving it into `siteSettings` is a schema change and its own ticket.

- **The site promises no response time** (MUSE-80). „Javljamo se u roku od jednog radnog
  dana…" / "We reply within one working day…" was in `src/lib/forms.ts` twice per locale —
  the sent-confirmation body and the `<noscript>` ask — and in `page-contact.description`,
  so also in `/contact`'s `<meta name="description">` and its two `llms.txt` lines. It
  traces to `92f3554`, MUSE-7's implementation commit, whose description never mentions
  one. A **service level** is stronger than marketing copy and enforceable against the
  studio, and it was published beside a form that has **never delivered a message**
  (`PUBLIC_FORM_ENDPOINT` is unset, MUSE-12) — so the clock was promised to start on a
  submission that was never transmitted. Gone, and **nothing replaced it**: "within a few
  days" and "as soon as we can" are the same defect with a different value. If Mina sets
  one it is hers to set and it belongs in the CMS, which is a needle removed from
  `RETIRED_CLAIMS` with her name beside it.

  **The needle's boundary is the unit, and it is not an exemption.** `/privacy` promises
  an answer „u roku od mjesec dana" / "within one month" in both locales — a reply verb
  and a stated period, which no adjacency can tell apart from the retired claim. That is
  the GDPR's own deadline for a data-subject request (Art. 12(3)): law rather than a
  promise, true, and it stays. So the needles match a period in **hours, days or weeks and
  never in months** — note that Croatian spells a month as „mjesec dana", so the unit
  alone cannot carry the distinction and the pattern refuses „mjesec" at the one position
  it can appear. Both `/privacy` lines are pinned in `INNOCENT` and asserted *not* to
  match, so the boundary is tested from both sides. A bare period is not a needle either:
  „working day" is in `src/lib/rebuild.ts` about the cron spacing and "within six hours"
  twice about the rebuild cadence, which is why a reply verb is required beside it.
  `INNOCENT` spans `src/` **and** `sanity/` for that reason — MUSE-71 read only `src/` and
  the nearest miss lives in `sanity/badges.ts`.

- **`/contact` tells the visitor to do what this build can actually do** (MUSE-84). The
  hero said „Ispuni obrazac i javljamo se s terminom…" / "Fill in the form and we will
  come back with a time…" while `PUBLIC_FORM_ENDPOINT` is unset, so the instruction was
  false at the moment it was followed and `/privacy` — corrected in MUSE-72 — said the
  opposite about the same form on the same deploy. `Contact.astro`'s lede reads
  `FORM_HAS_PROCESSOR` now, the same expression the notice and the form's own script
  read: with an endpoint the instruction is restored, without one it names the inbox and
  the address follows it as a link, which is `FormCopy['noscript']`'s convention. **No
  third state and no response time** (MUSE-80).

  **The `page` description is the half that cannot be gated, and that is the general
  lesson.** `page-contact.description` is a `page` document — Sanity owns a page's words
  — so it has no branch to sit in and no configuration to read, and a CMS string beside a
  conditional mechanism has exactly one honest shape: **true in both states**, which here
  means naming no mechanism at all. It is „Javi nam se i dogovaramo termin…" / "Get in
  touch and we will find a time…", and the guard runs the same claim against *both*
  builds rather than two opposite ones. Gating it would mean a second description source
  in code, which is what `getPage(route)` exists to prevent. `test/trialform.test.ts`
  carries all of it — the same two builds MUSE-72 added, so the heavyweight count did not
  move — and `llms.txt` is asserted there too, because it publishes the same strings.

  **MUSE-72 is two halves and the first draft of this copied only one.** `RECIPIENT` is
  *branch identity* — short phrases, both directions, both locales, asserting which
  paragraph rendered — and `NEVER` is a **class** of forbidden claim, asserted against
  both states whatever branch ran, which is why that guard would catch a notice naming a
  *different* processor that does not exist. The first version of this ticket's guard was
  `RECIPIENT` twice: every needle was the sentence being deleted, so it asserted „the old
  words are gone and the new words are here" and nothing about the claim. Measured on the
  branch: a description reading „…pošalji obrazac na ovoj stranici." left 207 tests green
  and published into both `<meta name="description">` tags and both `llms.txt` lines, and
  a second sentence beside the honest hero („Prijavu možeš poslati i kroz obrazac
  ispod.") left 202 green with the page contradicting itself. That is the third ticket in
  a row — MUSE-71, MUSE-80, this — to conclude that **a retired claim needs a needle for
  the class and not for the sentence.**

  So `SUBMIT` is a verb-and-object adjacency („ispuni/pošalji/predaj … obrazac",
  "fill/send/submit … the form") in **both word orders**, because Croatian fronts the
  object as readily as the verb and a verb-first needle misses „Obrazac ispuni i javljamo
  se." It is **not** in `test/helpers/offer-claims.ts` and cannot be: the claim is
  *conditional* — with an endpoint the instruction is legitimate and must be present —
  and `RETIRED_CLAIMS` is a list of things that may appear nowhere, ever.

  **Negation is the boundary, and it is a distinction rather than an exemption.** An
  instruction and a statement that the thing cannot be done are the same verb and the
  same object with „ne" between them: „Bez JavaScripta ovaj se obrazac **ne može** poslati"
  (`FormCopy['noscript']`) is true in every state, and the honest hero and `/privacy` both
  name the form in order to say it cannot be received. So a negation may be neither the
  word in the gap nor the word before the verb. The needle read that `<noscript>` line as
  an instruction until it was — measured, not imagined, which is why `INNOCENT_FORM_PROSE`
  pins six real strings, asserts each one *still published*, and tests the boundary from
  both sides the way `INNOCENT` does.

  „bez obveze" / "no commitment" went with the sentence and nothing replaced it: it is a
  *term of an offer* nobody has specified, where „bez partnera, bez iskustva" are facts
  about how a class runs. `test/pricing.test.ts` already refuses "no commitment" in the
  period names, which is the same claim one layer down.

- **„Dvoja vrata, ne šest." is `Home.astro`'s own line, not the design brief's** (MUSE-80).
  Four comments — two in `src/components/Home.astro`, two in `test/home.test.ts` — cited
  the brief for it. The brief contains no „vrata", no "door" and no "not six"; its only
  six is the six signature devices in §6. The words stayed, because they claim nothing
  about the studio and they are in the register §1 asks for; the attribution went. **A
  fabricated citation is worse than fabricated copy**, because the next author trusts it
  rather than opening the file — which is exactly what happened here, three times after
  the first.

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
    a new level is *inserted*, never appended. **All four of `LEVEL_PREREQUISITE`'s entry
    thresholds are unconfirmed** — this bullet said `improver` was the only one until
    MUSE-85 checked, and the sentence licensing the other three came from the same commit
    that authored `improver`, two days after the rest, about work MUSE-6 had specified for
    three levels. The record is `LEVEL_PREREQUISITE_CONFIRMATION` in `src/lib/schedule.ts`,
    a typed map that cannot say „confirmed" without naming a person and a date, and
    `test/schedule.test.ts` pins it empty and freezes the four published strings.
    **The pages still publish all four**, which is the owner's decision over removing the
    two that carry a number (a year, two years); MUSE-85's second criterion stays open
    until Mina is asked. Do not soften one into vagueness instead — same claim, less
    information.
  - **There is no `STYLES`.** The three style names were invented with the rows and had
    shaped a filter, three homepage cards and a required `class.style` field. The guard is
    **the values, not the name** (MUSE-76): it used to match the English identifier
    `style`, so renaming the field to `vrsta` — same type, same radio layout, same three
    invented values — kept all 1177 tests green, and nothing else saw it either, because
    `READ_CONTRACT` constrains which fields must *exist* per type and never the reverse.
    `test/sanity.test.ts` now reads **`WITHDRAWN_OPTION_SETS`** in
    `sanity/schemaTypes/enums.ts` — the one place in the *schema source* that is allowed
    to hold the three strings, which is why the note in `src/lib/schedule.ts` points at it
    rather than listing them — and fails on three things: a field whose *name* contains `style` or
    `stil` (kept, because it gives the obvious case the clearest message), any fixed
    `options.list` anywhere in the schema offering any of the *values* under any field
    name on any type, and any mention of a value in the schema source at all — the last
    one a text scan over the files the schema fingerprint already covers, because
    `Rule.valid()` declares a closed set that no walk of `options` can see. So it cannot
    come back silently; it can only come back with somebody deleting a registry entry and
    saying who confirmed it. **That conversation is still owed**: the design brief
    (`muse-design-system.md:24`, with „Tri stila. Jedan ritam." in its voice table) says
    the studio *does* teach by those three styles, so MUSE-36 and the human-authored brand
    spec disagree about the same fact. The site claims neither, which is the safe state,
    but one of the two documents is misleading the next author. Ask Mina; do not quietly
    correct either one.
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

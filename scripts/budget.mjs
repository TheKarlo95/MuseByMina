import { describeMeasured, launchChecks, openCheckPage } from './browser-checks.mjs';
import {
  auditTargetsOrExit,
  buildLocation,
  extensionOf,
  openSiteOrExit,
} from './dist-origin.mjs';

/**
 * **The performance budget — MUSE-63.**
 *
 * The original plan listed `lighthouse` among the blocking CI checks and it was never
 * built. Five jobs run on every pull request and **not one of them has an opinion about
 * what a page weighs or how many requests it makes.** The only size guard in the repo
 * watches `du -sm dist` against the GitHub Pages 1 GB *site* limit, which is the ceiling
 * of a hosting plan rather than a number anyone chose: it would not notice one page
 * growing from 60 KB to 2 MB.
 *
 * ## Why the numbers below are not Lighthouse's
 *
 * **Nothing here is a timing and nothing here is a composite score.** LCP, TBT and the
 * 0–100 number vary on a shared runner with whatever else is on the box, and `npm test`
 * alone runs ten real `astro build`s in parallel workers while several agents do the same
 * in neighbouring worktrees. A gate that goes red because the runner was busy is a gate
 * people learn to re-run, and a gate people re-run protects nothing. This repository has
 * spent nine tickets on that lesson in other costumes — three of them (MUSE-33, MUSE-50,
 * MUSE-54) were literally "a measurement taken at a moment rather than after a condition".
 *
 * So every assertion is a property of the **output** plus the **set of requests a browser
 * makes for it**, both of which are the same on an idle runner and a melting one:
 *
 *   - bytes per page, per resource kind, decompressed
 *   - how many requests the page makes to paint
 *   - how many of those are render-blocking
 *   - **how many font faces the page actually requests**, measured with the preload tags
 *     stripped out of the document first
 *
 * A timing *is* collected, and `advisory` is the field it lands in. It is printed and
 * never compared — see `measurePage`.
 *
 * ## Why this is cheap today and expensive in March
 *
 * The site ships zero JavaScript files; a page is HTML, one or two stylesheets and three
 * to six font subsets, and the heaviest page in the build is 296 KB of which 82% is
 * webfont. It passes every number below at 1.2–1.6×, which is the whole argument for
 * setting them now: **a budget set against a lean page is a budget the page already
 * passes.** Set after the gallery, the instructor portraits and the video hero land, the
 * same numbers are a negotiation about which existing page to exempt — and the answer to
 * that negotiation is always a per-route exemption, which is the shape of guard this repo
 * has already had to replace seven times.
 *
 * Hence: **one budget, for every page, with no per-route entries.** A route that lands
 * tomorrow is budgeted the day it builds, because the set of pages is read off the build
 * (`auditTargets`) and the numbers do not know which page they are about. There is nothing
 * here to extend and nothing to forget.
 *
 * ## Two entry points, one set of numbers
 *
 *   - `test/budget.test.ts` is the gate. It builds **both** deploy targets, serves each
 *     one, and runs everything below against every page of both — which is the only way
 *     the `/MuseByMina` sub-path and an apex domain are both covered (MUSE-8).
 *   - `node scripts/budget.mjs` — `npm run budget` — is the report a person reads, over
 *     the `dist` that is already on the box. It prints budget, actual and headroom per
 *     page and exits non-zero on the same problems. CI runs it in the `a11y` job, which
 *     already has a build and a browser.
 *
 * Both import `BUDGET` and `checkBudget` from here, so there is one place a number lives
 * and one place it is compared.
 */

/**
 * The page's weight, split the way a reader thinks about it.
 *
 * Kinds, not MIME types: `woff2` and a future variable font are one line in the budget
 * because they are one decision. Order is the order the table prints in.
 */
export const KINDS = ['html', 'css', 'font', 'image'];

/** What a file extension means. Deterministic, and derived from the URL rather than reported. */
const KIND_BY_EXTENSION = {
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.woff2': 'font',
  '.woff': 'font',
  '.ttf': 'font',
  '.otf': 'font',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.webp': 'image',
  '.avif': 'image',
  '.gif': 'image',
  '.svg': 'image',
  '.ico': 'image',
  '.js': 'js',
  '.mjs': 'js',
};

/**
 * What the browser's own classification means, for a URL with no extension to read.
 *
 * Only the document has one on this site — a page URL ends in a slash (MUSE-9). The rest
 * of the table is there so that a resource arriving from somewhere unexpected is named
 * rather than silently pooled.
 */
const KIND_BY_RESOURCE_TYPE = {
  document: 'html',
  stylesheet: 'css',
  font: 'font',
  image: 'image',
  script: 'js',
};

/**
 * **The budget. One place, as data, with where each number came from beside it.**
 *
 * Every figure is the **measured worst page across both deploy targets** — eight pages
 * each under `/MuseByMina/` and under an apex `/`, sixteen measurements — rounded up to
 * something a person can hold in their head. The Pages sub-path is the worse of the two
 * everywhere, by 0.4 KB of HTML: the base prefix is in every href on the page.
 *
 * The table `npm run budget` prints has a `headroom` row and that row is the deliverable.
 * MUSE-63's second criterion is that the next ticket knows how much room it has rather
 * than discovering it by going red, so the measurement is reproducible by one command
 * instead of being transcribed into a comment that ages.
 *
 * A number with no accounting beside it is a number the next person quietly raises, so
 * each one says what it was measured at **and** what it is protecting against.
 */
export const BUDGET = {
  /** Decompressed bytes per resource kind, per page. */
  bytes: {
    /**
     * HTML: measured worst is `/` at 30.9 KB, the homepage — its own markup plus the
     * theme stamp, the language redirect and the JSON-LD block, all of which are inline by
     * design (`src/lib/theme.ts` has to run before first paint). `/contact/` is 29.5 KB
     * with the trial form in it; `/privacy/` is the lightest at 18.4 KB.
     *
     * 48 KB is ~1.55× the worst page, 17.1 KB of headroom. Not looser than that, because
     * HTML here is hand-written markup rendered at build time: a page needing 48 KB of it
     * has grown a feature, not a paragraph, and a feature is a decision worth noticing.
     *
     * **Plus `perImage.html` per `<img>` the document holds** (MUSE-25), because a
     * responsive image ladder is paid in the document: measured 1,023 bytes per `<img>`
     * on `/gallery`, six Sanity URLs per photograph at ~160 characters each. The base is
     * unchanged — it is still what says „this page has grown a feature" — and the term is
     * what stops the line being a trap that fires at the fifteenth photograph. The
     * accounting is beside `perImage`.
     */
    html: 48 * 1024,
    /**
     * CSS: measured worst is `/schedule/` at 24.6 KB — the shared `BaseLayout` chunk
     * (17.9 KB, which carries the globals plus the header's and footer's scoped styles)
     * plus `Schedule`'s own 6.7 KB. `/privacy/` loads the shared chunk alone at 17.9 KB.
     *
     * 40 KB is ~1.63×, 15.4 KB of headroom — about two more component stylesheets the
     * size of `Schedule`'s. The failure this guards is MUSE-43's cousin: a component that
     * stops being scoped, or the globals ending up in the shared chunk twice. Both roughly
     * double this number while every page still renders perfectly correctly.
     */
    css: 40 * 1024,
    /**
     * Fonts: measured worst is 242.6 KB, which is **all six declared subsets**, and
     * **every Croatian page now transfers it** (MUSE-74). Five of the eight ask for all
     * six because their copy has enough diacritics; the other three are handed Cormorant's
     * latin-ext anyway, 33.0 KB they do not paint with, because the per-route list that
     * used to know which three was invalidated by two content pull requests in one day —
     * `src/lib/fonts.ts` has the argument. English pages take three (109.8 KB), except
     * `/en/privacy/` at 192.9 KB: AZOP's street name is a Croatian proper noun and so is
     * untranslated.
     *
     * **This line did not move for that.** The ceiling was already set at the whole
     * declared set, so a page transferring all of it was always inside it; what the
     * change spends is headroom in `total` below, 48.3 KB to 46.4 KB. Worth knowing when
     * reading the table: the `faces` column is measured with the preload tags stripped,
     * so it still reports what each page *asks* for — five where this says six — and the
     * gap between the two columns is exactly the deliberate over-preload.
     *
     * 288 KB is the whole declared set plus ~19%, 45.4 KB of headroom: enough that a
     * seventh *subset* of a family already here is affordable, not enough for a fourth
     * family. A second copy of an existing face would also fit under this number — the
     * subsets run 16.7 KB to 83.1 KB — which is why `fonts.max` below counts faces as
     * well as weighing them. Two instruments, because this one cannot see that case.
     */
    font: 288 * 1024,
  },
  /**
   * **What one more image on a page is allowed to add, per `<img>` the document holds**
   * (MUSE-25).
   *
   * MUSE-63 wrote that *"after the gallery and the portraits land the same numbers are a
   * negotiation about which page to exempt"*, and predicted the answer would be a
   * per-route exemption. `/gallery` is that ticket, and the negotiation produced a third
   * answer: **the lines a gallery moves are moved per image rather than per route.**
   *
   * The measurement is why. A populated `/gallery` was built against a fixture at four
   * album sizes and weighed in a real browser, with every `cdn.sanity.io` request answered
   * by a real photograph encoded at the width the URL asked for (`webp q80`, which is what
   * `auto=format&q=80` performs):
   *
   * | photographs | `<img>` | html | image | requests | total |
   * |---|---|---|---|---|---|
   * | 0 (the shipped page) | 2 | 18.6 KB | 12.7 KB | 11 | 296.5 KB |
   * | 7 | 16 | 32.6 KB | ~93 KB | 18 | ~391 KB |
   * | 12 | 26 | 42.0 KB | 151.3 KB | 23 | 458.4 KB |
   * | 24 | 50 | 64.6 KB | — | — | — |
   *
   * Three things that table settles.
   *
   * **It is linear in the number of photographs, and the slope is `srcset`.** 1,023, 997
   * and 981 bytes of document per `<img>` across the three populated builds — six URLs per
   * photograph at ~160 characters each, which is the cost of the ticket's own „use Sanity's
   * image pipeline for responsive sizes" requirement. A flat ceiling therefore does not
   * fail *at* some weight, it fails at some **album size**: 48 KB binds at about fifteen
   * photographs, 360 KB of total at about fourteen, and 14 requests at four.
   *
   * **Album size is an editorial decision, taken in a Studio, with no pull request.** So a
   * flat raise is not a budget, it is a **trap with a date on it**: CI builds from the seed,
   * which has no photographs, so the gate would stay green until the shoot — and then fail
   * on Mina's upload, in `deploy.yml`, where nobody is reading. A number that cannot be
   * exceeded by anything a developer does and will certainly be exceeded by something an
   * editor does is worse than no number.
   *
   * **A per-route exemption was the alternative and is refused**, for the reason written at
   * the top of this file: the page set is read off the build, so there is no list to extend
   * and nothing to forget, and seven guards in this repository have already had to be
   * replaced for having one. Per `<img>` keeps that property exactly — the count comes out
   * of the document the browser parsed, the rule is the same on every page, and a route
   * that lands tomorrow is budgeted the day it builds.
   *
   * **1,280 bytes** is ~1.25× the measured 1,023, applied to `html` and to `total`.
   * `requests` gets **1**, which is one fetch per image and no more — the failure it still
   * catches is the same image fetched twice.
   *
   * The cost, stated plainly rather than discovered later: on a page with two images the
   * allowance adds 2.5 KB to a 48 KB line, which is nothing — but on an image-heavy page
   * the *base* is slack, because the base is sized for `/`'s inline JSON-LD and theme stamp
   * and a gallery's own markup is 18.6 KB. A twenty-four-photograph gallery is allowed
   * 110 KB of document and uses 65 KB. That slack is the price of never trapping, and it is
   * the right side to be wrong on: the thing this line protects against is *a page growing
   * a feature*, and a feature is still 48 KB whatever the album is.
   */
  perImage: { html: 1280, total: 1280, requests: 1 },
  /**
   * **The heaviest single image response, on any page — and this is the line with teeth**
   * (MUSE-25).
   *
   * `bytes.image` was a per-page *sum* and is gone, because a sum conflates two things
   * that fail in opposite directions and have different owners: **how many photographs are
   * on the page**, which is Mina's decision and is unbounded by design, and **how big each
   * one is**, which is ours. Once the first is editorial, the second is the only half a
   * budget can honestly hold — and holding it per response is strictly *stronger* than the
   * old sum on every page except a gallery, because the old 16 KB would have passed a
   * single 15 KB logo and this refuses anything over 32 KB anywhere.
   *
   * Measured, at `deviceScaleFactor: 1`, on the populated builds above:
   *
   *   - `muse-lockup-white.*.webp` — **11.1 KB**, the footer lockup on every page (MUSE-64)
   *   - `muse-mark-white.*.webp` — 1.6 KB, the masthead mark (MUSE-67)
   *   - a gallery tile at the `350w` rung the engine selects for a 290 px box — **4.0 KB**
   *     to **11.5 KB** across two real camera photographs, the second a warm, low-light
   *     evening frame, which is the register §9 asks for
   *
   * **32 KB is ~2.8× the measured worst**, and what it buys is the ability to say no to the
   * failure the ticket names: a 2000w original measures 104–297 KB, a 1200w one 61–107 KB,
   * and a 600w tile on a 2× phone 23.6 KB. So an unoptimised photograph fails here on
   * *whatever* page it appears, and the headroom stops at the point where a visitor would
   * be downloading a lightbox-sized file to paint a thumbnail.
   *
   * Two limits, stated rather than left to be discovered. This is measured **at page
   * load**, so the full-size frame the lightbox fetches when a visitor opens it is outside
   * it — `/gallery`'s dialog keeps every frame `hidden`, which is what makes a closed
   * lightbox cost nothing, and `test/gallery.test.ts` asserts that no candidate above the
   * grid's top rung is fetched while it is closed. And the gate runs at 1×, so it measures
   * the rung a 1× display selects; the rungs themselves are bounded in
   * `src/lib/gallery.ts`, where the ladder is derived from the boxes the layout can paint
   * and `test/gallery.test.ts` measures the engine's selection against the painted box.
   */
  imageResponse: 32 * 1024,
  /**
   * **Total decompressed bytes, excluding photography, plus `perImage.total` per `<img>`.**
   *
   * Measured worst is `/` at 307.8 KB, 79% of it webfont — 296.7 KB of it once the footer
   * lockup is taken out. A populated `/gallery` weighs 458.4 KB and **307.1 KB** on the
   * same basis, which is the point: with photography excluded the heaviest page on the site
   * is the same weight it has always been, and the ceiling does not have to move for a
   * gallery at all.
   *
   * 360 KB is ~1.17× of that, 52.9 KB of headroom, and deliberately **tighter than the sum
   * of the per-kind lines** (376 KB): without this, two kinds each growing to the top of
   * its own budget would be a page nobody agreed to and nothing red.
   *
   * **Why photography comes out rather than the ceiling going up** (MUSE-25). Including it
   * makes this number a function of how many photographs Mina has published — 458 KB at
   * twelve, and rising — so it would have to be raised to a figure that is 150 KB of pure
   * slack on all twenty other pages and *still* a trap at some album size. Excluded, the
   * line keeps its full value for every page and every byte that is ours to decide, and
   * the photography is held by `imageResponse` above, per response, which is the half a
   * budget can actually hold. The `perImage.total` term is still here because a
   * photograph's `srcset` is paid in the **document**, and that part is not photography.
   *
   * **The ceiling did not move when the lockup landed** (MUSE-64) and it has not moved for
   * the gallery either — the measurement under it moved, twice, and the headroom absorbed
   * it both times. That is the line doing its job rather than needing maintenance.
   */
  total: 360 * 1024,
  /**
   * Requests a page makes, counting only the ones the host answered 200.
   *
   * Measured 6 (`/en/privacy/`: the document, one stylesheet, three faces, the lockup) to
   * 10 (`/`: the document, two stylesheets, six faces, the lockup). 14 is the ceiling, 4
   * of headroom — MUSE-64 spent one of the five on an image every page shares, which is
   * the cheapest shape an image can have here: one more request for the whole site
   * rather than one per surface.
   *
   * Budgeted beside the bytes rather than instead of them, because the two fail in
   * opposite directions: an unoptimised image moves the bytes and not this, and a gallery
   * of correctly-sized thumbnails moves this and barely the bytes.
   *
   * **Plus `perImage.requests` — one — per `<img>` the document holds** (MUSE-25). A
   * populated `/gallery` measured 23 requests at twelve photographs, of which 14 were
   * images and 9 were the page itself; at twenty-four it would be past 40. So a flat 14
   * binds at **four photographs**, which makes it the first line a gallery breaks and the
   * clearest case for an allowance rather than a raise. One per image is the honest
   * relation and it still refuses the failure this line exists for: the same photograph
   * fetched twice, or a request for something nobody put on the page.
   */
  requests: 14,
  /**
   * Render-blocking requests: the stylesheets in `<head>`, plus any synchronous script.
   *
   * Measured 1 on `/privacy/` (the shared chunk alone) and 2 everywhere else (the shared
   * chunk plus one component's). 4 is the ceiling, 2 of headroom: a third component
   * stylesheet on one page is ordinary, a fifth means the scoping is leaking or somebody
   * added a blocking script.
   *
   * There is no `js` line in `bytes` and none here, on purpose: **the site ships zero
   * JavaScript files and `test/nojs.test.ts` owns that claim** against `dist`, extension
   * allow-list and all. Restating it here would be a second answer to one question. What
   * this file does instead is refuse a resource kind nobody budgeted — see `checkBudget`
   * — so a `.js` request appearing over the wire fails here too, naming itself, without
   * either file having an opinion about the other's number.
   */
  renderBlocking: 4,
  /**
   * **Font faces the page actually requests, with the preload tags stripped out first.**
   *
   * Both ends are the assertion. Measured 3 on the English pages, whose copy is plain
   * ASCII (Inter latin, Jost latin, Cormorant latin), and 6 on `/` and `/contact/`, whose
   * Croatian copy has enough diacritics to pull every latin-ext half in.
   *
   * **The ceiling therefore has no headroom, and that is the claim** rather than an
   * oversight: six is how many faces exist, so "no page requests more faces than the
   * stylesheet declares" is the invariant, and a number above six is a new file rather
   * than a heavier page. Adding a seventh subset means editing `src/styles/fonts.css`,
   * and this line is next to it in the diff.
   *
   *   - `min: 1` is MUSE-35, and it is the end that found something. For the life of the
   *     project `astro dev` answered all six faces with 404 and every page was silently
   *     set in Georgia; reproduced against a build, that is **six requests and zero faces
   *     served**, which is why this count is of faces the host *served* (see
   *     `fontsRequested`) and not of requests made. A ceiling alone reads zero as the
   *     leanest page it has ever seen.
   *   - `max: 6` is the number of faces `src/styles/fonts.css` declares. A seventh served
   *     face means a face was declared twice, or a second copy of a file got into the
   *     output — the page then pays for bytes it never paints with, with every URL still
   *     resolving and every file still present. Worth knowing when reading a diff: a
   *     **byte-identical** copy costs the visitor nothing, because Vite content-hashes
   *     assets and emits one file for both references. Measured, by trying it.
   *
   * Why the preloads come out first: **a `<link rel="preload">` is itself a request**, so
   * "was this face requested" is true by construction for anything preloaded, whether the
   * page had any use for it. `test/fonts.test.ts` found that and stripping the tags is its
   * technique; this reuses it. What is left is what the CSS engine asks for on its own,
   * each `@font-face`'s `unicode-range` matched against the text actually on the page.
   */
  fonts: { min: 1, max: 6 },
};

/** `<link rel="preload">`, as emitted. Stripped before the browser parses the document. */
const PRELOAD_TAG = /<link\b[^>]*\brel="preload"[^>]*>/g;

/**
 * Which kind of weight a URL is.
 *
 * Extension first, because that is a fact about the file in `dist`; the browser's own
 * `resourceType` only decides the extensionless case, which on this site is the document.
 *
 * @param {string} url
 * @param {string} resourceType
 * @returns {string}
 */
export function kindOf(url, resourceType) {
  const byExtension = KIND_BY_EXTENSION[extensionOf(new URL(url).pathname)];
  if (byExtension !== undefined) return byExtension;
  return KIND_BY_RESOURCE_TYPE[resourceType] ?? `other:${resourceType}`;
}

/**
 * How many requests a document blocks first paint on.
 *
 * Read off the markup rather than timed, which is the whole design of this file: a
 * stylesheet in `<head>` blocks rendering by specification, and whether it *did* on one
 * run of one runner is a different and much noisier question.
 *
 *   - every `<link rel="stylesheet">` that is not `media="print"`
 *   - every `<script src>` without `async`, `defer` or `type="module"`
 *
 * The second clause finds nothing today and is not speculative: it is the line that turns
 * "we ship no JavaScript" from a thing somebody remembers into a thing this number knows.
 *
 * @param {string} html
 * @returns {{ count: number, what: string[] }}
 */
export function renderBlocking(html) {
  const what = [];

  for (const [tag] of html.matchAll(/<link\b[^>]*>/g)) {
    const rel = /\brel="([^"]*)"/.exec(tag)?.[1]?.toLowerCase() ?? '';
    if (!rel.split(/\s+/).includes('stylesheet')) continue;
    if (/\bmedia="print"/.test(tag)) continue;
    what.push(`stylesheet ${/\bhref="([^"]*)"/.exec(tag)?.[1] ?? '?'}`);
  }

  for (const [tag] of html.matchAll(/<script\b[^>]*>/g)) {
    const src = /\bsrc="([^"]*)"/.exec(tag)?.[1];
    if (src === undefined) continue;
    if (/\b(async|defer)\b/.test(tag) || /\btype="module"/.test(tag)) continue;
    what.push(`blocking script ${src}`);
  }

  return { count: what.length, what };
}

/**
 * Bytes, as a person reads them. `24.6 KB`, and `0` stays `0`.
 *
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (bytes === 0) return '0';
  // On the magnitude, not the value: the headroom row goes negative the moment a page is
  // over, and `-1080748 B` beside `1055.4 KB` reads as two different units.
  return Math.abs(bytes) < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * **What one page weighs, and what it asked for.**
 *
 * Every response the browser received, with its decompressed length. Decompressed and not
 * transferred, deliberately: the in-process host serves identity encoding and GitHub Pages
 * serves gzip, so a transferred figure would be a budget on a server's compressor rather
 * than on the page — and it would differ between the two environments this gate runs in
 * for a reason that is nobody's defect.
 *
 * Non-200 responses are counted and reported separately rather than folded into the
 * weight: a request for something that is not there costs a round trip and no bytes, and
 * `test/assets.test.ts` is where "every reference resolves" is already asserted against
 * `dist`. Reporting them keeps a 404 from reading as a page that got lighter.
 *
 * @param {import('playwright').Browser} browser
 * @param {{ url: (route: string) => string }} site
 * @param {string} route
 * @returns {Promise<Measurement>}
 */
export async function measurePage(browser, site, route) {
  /** @type {Promise<{ url: string, status: number, kind: string, bytes: number }>[]} */
  const collecting = [];

  const { page, close, measured } = await openCheckPage(browser, site, route, {
    prepare: (opened) => {
      opened.on('response', (response) => {
        collecting.push(
          (async () => {
            const url = response.url();
            const status = response.status();
            const kind = kindOf(url, response.request().resourceType());
            // A response can have no readable body — a 304, a redirect. The request still
            // happened and still counts; the bytes are what is unknown, not zero, and the
            // only kind of response that reaches here without one is also the only kind
            // that carries no weight.
            const bytes = await response.body().then(
              (body) => body.byteLength,
              () => 0,
            );
            return { url, status, kind, bytes };
          })(),
        );
      });
    },
  });

  try {
    const html = await page.content();
    assertDocumentIsItself(route, measured.url, html);
    const blocking = renderBlocking(html);
    const images = imagesIn(html);
    // The condition, not a duration: every face the page has text for has either loaded
    // or failed by the time this resolves, so the request log below is complete.
    await page.evaluate(() => document.fonts.ready);

    /**
     * The one number here that is **not** asserted on, anywhere, by anything.
     *
     * A navigation timing is exactly what the ticket says not to budget: it moves with
     * what else is on the runner. It is collected because it is free once the page is
     * open and because a human reading `npm run budget` wants to know whether the number
     * is 40 ms or 4 s — but `checkBudget` cannot see this field, and if a future edit
     * makes it able to, that edit is the regression.
     */
    const advisory = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = performance
        .getEntriesByType('paint')
        .find((entry) => entry.name === 'first-contentful-paint');
      return {
        loadMs: nav === undefined ? null : Math.round(nav.loadEventEnd),
        firstPaintMs: paint === undefined ? null : Math.round(paint.startTime),
      };
    });

    const responses = await Promise.all(collecting);
    const served = responses.filter((response) => response.status === 200);

    /** @type {Record<string, number>} */
    const bytes = {};
    for (const response of served) {
      bytes[response.kind] = (bytes[response.kind] ?? 0) + response.bytes;
    }

    return {
      route,
      measured,
      bytes,
      total: served.reduce((sum, response) => sum + response.bytes, 0),
      requests: served.length,
      images,
      imageResponses: served
        .filter((response) => response.kind === 'image')
        .map(({ url, bytes: size }) => ({ url, bytes: size })),
      renderBlocking: blocking.count,
      blocking: blocking.what,
      missing: responses
        .filter((response) => response.status !== 200)
        .map((response) => `${response.status} ${response.url}`),
      fonts: await fontsRequested(browser, site, route),
      advisory,
    };
  } finally {
    await close();
  }
}

/**
 * **How many images the document holds** — the multiplier for `BUDGET.perImage`.
 *
 * Read off the markup, for `renderBlocking`'s reason: it is a property of the output, the
 * same on an idle runner and a melting one, and it does not depend on what the browser
 * chose to fetch. That last part is deliberate — the allowance is for what the *document*
 * costs, and a `<img>` inside a closed `<dialog>` is 160 characters of `srcset` whether or
 * not a byte is ever requested for it.
 *
 * `<img>` and nothing else. A CSS `background-image` costs no markup, and a `<source>`
 * inside a `<picture>` would — there are none on this site, and the day there is one this
 * undercounts rather than overcounts, which is the direction a budget should be wrong in.
 *
 * @param {string} html
 * @returns {number}
 */
export function imagesIn(html) {
  return [...html.matchAll(/<img\b/g)].length;
}

/**
 * **The faces a page requests when nothing preloads them for it.**
 *
 * `test/fonts.test.ts`'s technique, and the reasoning is written out there at length: a
 * preload is a request, so the raw request log cannot answer "does this page need this
 * face". Stripping the tags out of the document before the browser parses it leaves
 * whatever the CSS engine asks for on its own.
 *
 * Measured with a real browser rather than by matching `unicode-range` here, for the same
 * reason `test/numerals.test.ts` screenshots glyphs instead of reading `getComputedStyle`:
 * a model of the engine passes whenever the model is wrong.
 *
 * ## Faces the page **got**, not faces it asked for
 *
 * This is the half that makes MUSE-35 reachable at all, and the obvious version misses it.
 * Under `astro dev` the six `@font-face` sources were root-absolute paths into `public/`
 * that Vite does not rewrite when it serves, so the browser **requested all six and was
 * answered 404 six times** and fell back to Georgia. A count of *requests* reads six there
 * and is perfectly happy; the count has to be of faces the host actually served. So the
 * listener is on the response and filters on 200, and the floor in `BUDGET.fonts` is then
 * a floor on something that can really be zero.
 *
 * A 404 is not silently dropped either — `measurePage` records every non-200 response and
 * `npm run budget` prints them under the page, so "requested six, served none" reads as
 * what it is rather than as a page that got lighter.
 *
 * @param {import('playwright').Browser} browser
 * @param {{ url: (route: string) => string }} site
 * @param {string} route
 * @returns {Promise<string[]>}
 */
export async function fontsRequested(browser, site, route) {
  /** @type {Set<string>} */
  const served = new Set();

  const { page, close, measured } = await openCheckPage(browser, site, route, {
    waitUntil: 'load',
    prepare: async (opened, url) => {
      await opened.route(url, async (interception) => {
        const response = await interception.fetch();
        const stripped = (await response.text()).replace(PRELOAD_TAG, '');
        if (stripped.includes('rel="preload"')) {
          throw new Error(
            `The preload tags were not stripped from ${url}, so every preloaded face ` +
              'would be counted as a face the page needs — which is the circularity this ' +
              'measurement exists to break (MUSE-35, MUSE-63).',
          );
        }
        await interception.fulfill({ response, body: stripped });
      });
      opened.on('response', (response) => {
        const request = response.request();
        if (kindOf(request.url(), request.resourceType()) !== 'font') return;
        if (response.status() === 200) served.add(request.url());
      });
    },
  });

  try {
    // The document the browser parsed, not the URL it was handed (MUSE-62).
    assertDocumentIsItself(route, measured.url, await page.content());
    await page.evaluate(() => document.fonts.ready);
    return [...served].sort();
  } finally {
    await close();
  }
}

/**
 * The page measured here is the page that was named — MUSE-62, over a document the browser
 * has already rewritten.
 *
 * `test/helpers/measured.ts` is the implementation and is where the reasoning lives, but it
 * is TypeScript under `test/` and this is a `.mjs` script: a `.mjs` file cannot import a
 * `.ts` helper, which is the same wall that put `resolveRequest` in `scripts/` (MUSE-52)
 * and `openCheckPage` there too (MUSE-48). So the comparison is made here as well, in the
 * same shape, and `test/budget.test.ts` asserts that this function agrees with that module
 * — including on the error page, which declares no canonical and must fail.
 *
 * @param {string} route What was asked for, for the message.
 * @param {string} landed The URL the browser ended on.
 * @param {string} html The document it ended up with.
 */
export function assertDocumentIsItself(route, landed, html) {
  const declared = [...html.matchAll(/<link\b[^>]*>/g)]
    .filter(([tag]) => /\brel="canonical"/i.test(tag))
    .map(([tag]) => /\bhref="([^"]*)"/.exec(tag)?.[1])
    .find((href) => href !== undefined);

  if (declared === undefined) {
    throw new Error(
      `Budgeting ${route}: the page at ${landed} declares no <link rel="canonical">. ` +
        'Every page of this site declares one and `404.astro` deliberately does not ' +
        '(MUSE-38), so this is almost certainly the error page served at a URL that does ' +
        'not exist (MUSE-62) — and whatever was about to be weighed is that page.',
    );
  }

  const asked = new URL(landed).pathname;
  const says = new URL(declared).pathname;
  if (asked !== says) {
    throw new Error(
      `Budgeting ${route}: asked for ${asked} and got a page that says it is ${says}. ` +
        'The weight below would have been recorded against the wrong route (MUSE-62).',
    );
  }
}

/**
 * **Every way one page can be over budget, each naming itself.**
 *
 * The message carries the route, the resource kind, the budget and the actual, in that
 * order, because that is the order the reader needs them in: which page, what about it,
 * what we agreed, what it is.
 *
 * An unbudgeted resource kind is a failure in its own right. That is how `js` is covered
 * without this file restating `test/nojs.test.ts`'s claim, and it is also what keeps the
 * budget from going quiet the first time a `.webm` or a `.wasm` shows up — a kind nobody
 * declared cannot have a number it is under.
 *
 * @param {Measurement} page
 * @returns {string[]}
 */
export function checkBudget(page) {
  /** @type {string[]} */
  const problems = [];
  const over = (kind, actual, budget, unit = 'bytes') =>
    problems.push(
      `${page.route}  ${kind}  budget ${
        unit === 'bytes' ? formatBytes(budget) : budget
      }  actual ${unit === 'bytes' ? formatBytes(actual) : actual}  (over by ${
        unit === 'bytes' ? formatBytes(actual - budget) : actual - budget
      })`,
    );

  /**
   * A per-page ceiling plus whatever the document's images are allowed to add (MUSE-25).
   *
   * `page.images` is counted off the markup, so the allowance is the same number on an
   * idle runner and a melting one — and it is one rule for every page rather than a list
   * of routes that may be heavier. The accounting is beside `BUDGET.perImage`.
   */
  const allowed = (kind, base) => base + (BUDGET.perImage[kind] ?? 0) * page.images;

  for (const [kind, actual] of Object.entries(page.bytes).sort()) {
    // Photography is budgeted per response rather than summed — see `BUDGET.imageResponse`.
    // Skipped here and *not* reported as unbudgeted, which is the one thing this loop must
    // not do: „no budget exists for image" would be a true sentence about a kind that has
    // a stricter budget than it used to.
    if (kind === 'image') continue;

    const budget = BUDGET.bytes[kind];
    if (budget === undefined) {
      problems.push(
        `${page.route}  ${kind}  budget — none declared —  actual ${formatBytes(actual)}  ` +
          `(no budget exists for ${kind}; declare one in BUDGET.bytes in ` +
          'scripts/budget.mjs, with a sentence saying what it was measured at)',
      );
      continue;
    }
    if (actual > allowed(kind, budget)) over(kind, actual, allowed(kind, budget));
  }

  /**
   * Every image response, one at a time, naming the file.
   *
   * The sum would say „this page carries 400 KB of photography", which on a gallery is a
   * sentence about how many pictures Mina published. This says „*this* photograph is
   * 300 KB", which is a sentence about something somebody can fix — and it fires on every
   * page, not only the one with a grid on it.
   */
  for (const image of page.imageResponses ?? []) {
    if (image.bytes <= BUDGET.imageResponse) continue;
    problems.push(
      `${page.route}  image response  budget ${formatBytes(BUDGET.imageResponse)}  actual ` +
        `${formatBytes(image.bytes)}  (over by ${formatBytes(image.bytes - BUDGET.imageResponse)}` +
        ` — ${image.url.slice(image.url.lastIndexOf('/') + 1)}. One file, not the page's ` +
        'total: how many photographs a page shows is an editorial decision and is not ' +
        'budgeted, how big each one is, is ours. Ask the CDN for a width the layout can ' +
        'paint — see the ladders in src/lib/gallery.ts)',
    );
  }

  // Photography out of the total, for the reason written beside `BUDGET.total`: with it in,
  // this number is a function of how many pictures are published.
  const unphotographed = page.total - (page.bytes.image ?? 0);
  if (unphotographed > allowed('total', BUDGET.total))
    over('total', unphotographed, allowed('total', BUDGET.total));
  if (page.requests > allowed('requests', BUDGET.requests))
    over('requests', page.requests, allowed('requests', BUDGET.requests), 'count');
  if (page.renderBlocking > BUDGET.renderBlocking)
    over('render-blocking', page.renderBlocking, BUDGET.renderBlocking, 'count');

  // Both ends, and the floor is the one that matters: MUSE-35's page requested zero.
  const faces = page.fonts.length;
  if (faces < BUDGET.fonts.min) {
    problems.push(
      `${page.route}  font faces  budget at least ${BUDGET.fonts.min}  actual ${faces}  ` +
        '(with the preloads stripped, the host served this page no webfont at all — which ' +
        'is exactly what MUSE-35 looked like for the life of the project: all six faces ' +
        'requested, all six 404ing, every page silently set in Georgia, and MUSE-14 ' +
        'invisible locally because Georgia has lining figures. Check the non-200 lines ' +
        'above the table: requested-and-404ed and never-requested are different bugs)',
    );
  }
  if (faces > BUDGET.fonts.max) {
    // Filenames rather than URLs: seven absolute URLs is a paragraph, and the content hash
    // in each one is the part that tells two copies of a face apart.
    const names = page.fonts.map((url) => url.slice(url.lastIndexOf('/') + 1));
    problems.push(
      `${page.route}  font faces  budget at most ${BUDGET.fonts.max}  actual ${faces}  ` +
        `(${names.join(', ')} — more faces than src/styles/fonts.css declares means a ` +
        'face is declared twice or a second copy of a file is in the output)',
    );
  }

  return problems;
}

/**
 * Everything that was measured, as a table a person can read, headroom included.
 *
 * The headroom column is the deliverable, not decoration: MUSE-63's second acceptance
 * criterion is that the next ticket knows how much room it has rather than discovering it.
 *
 * @param {Measurement[]} pages
 * @returns {string[]}
 */
export function report(pages) {
  const columns = [...KINDS, 'total'];
  const widest = (pick) => Math.max(...pages.map(pick));
  const bytesOf = (page, kind) => (kind === 'total' ? page.total : (page.bytes[kind] ?? 0));

  /**
   * The allowance the worst page was actually judged against, images and all (MUSE-25).
   *
   * Not `BUDGET.bytes[kind]` on its own: `html`, `total` and `requests` carry a per-`<img>`
   * term, so printing the base alone would show a headroom the gate does not use — which
   * is the one thing this table must never do, because MUSE-63's second criterion is that
   * the next ticket reads its room off here rather than discovering it by going red.
   */
  const mostImages = pages.length === 0 ? 0 : widest((page) => page.images ?? 0);
  const allowance = (kind, base) => base + (BUDGET.perImage[kind] ?? 0) * mostImages;

  /** What `total` is compared against: the page without its photography. */
  const unphotographed = (page) => page.total - (page.bytes.image ?? 0);
  /** The single heaviest image response on a page, which is how `image` is budgeted. */
  const heaviestImage = (page) =>
    Math.max(0, ...(page.imageResponses ?? []).map((image) => image.bytes));

  const budgetOf = (kind) =>
    kind === 'total' ? allowance('total', BUDGET.total) : allowance(kind, BUDGET.bytes[kind]);

  /** One line of the table: a label, the byte columns, then the counts. */
  const row = (label, cells, counts) =>
    `${label.padEnd(22)}${cells.map((cell) => String(cell).padStart(11)).join('')}` +
    counts.map((count) => String(count).padStart(7)).join('');

  const lines = [row('page', columns, ['imgs', 'reqs', 'block', 'faces', 'load*'])];

  for (const page of pages) {
    lines.push(
      row(
        page.route,
        columns.map((kind) => formatBytes(bytesOf(page, kind))),
        [
          page.images ?? 0,
          page.requests,
          page.renderBlocking,
          page.fonts.length,
          page.advisory.loadMs === null ? '\u2014' : `${page.advisory.loadMs}ms`,
        ],
      ),
    );
  }

  lines.push('');
  lines.push(
    row(
      'budget',
      columns.map((kind) =>
        kind === 'image' ? `${formatBytes(BUDGET.imageResponse)} ea` : formatBytes(budgetOf(kind)),
      ),
      [
        '',
        allowance('requests', BUDGET.requests),
        BUDGET.renderBlocking,
        `${BUDGET.fonts.min}-${BUDGET.fonts.max}`,
        'n/a',
      ],
    ),
  );
  lines.push(
    row(
      'worst page',
      columns.map((kind) =>
        formatBytes(
          kind === 'image'
            ? widest(heaviestImage)
            : kind === 'total'
              ? widest(unphotographed)
              : widest((page) => bytesOf(page, kind)),
        ),
      ),
      [
        mostImages,
        widest((page) => page.requests),
        widest((page) => page.renderBlocking),
        widest((page) => page.fonts.length),
        '',
      ],
    ),
  );
  lines.push(
    row(
      'headroom',
      columns.map((kind) =>
        formatBytes(
          kind === 'image'
            ? BUDGET.imageResponse - widest(heaviestImage)
            : kind === 'total'
              ? budgetOf(kind) - widest(unphotographed)
              : budgetOf(kind) - widest((page) => bytesOf(page, kind)),
        ),
      ),
      [
        '',
        allowance('requests', BUDGET.requests) - widest((page) => page.requests),
        BUDGET.renderBlocking - widest((page) => page.renderBlocking),
        BUDGET.fonts.max - widest((page) => page.fonts.length),
        '',
      ],
    ),
  );
  lines.push('');
  lines.push(
    '* load is advisory and is asserted on by nothing \u2014 a timing moves with whatever ' +
      'else is on the runner (MUSE-63).',
  );
  lines.push(
    `\u2020 image is budgeted per response, not per page, and total is compared without ` +
      `photography: how many pictures a page shows is an editorial decision, how big each ` +
      `one is, is ours (MUSE-25). The page row shows each page's real figures; budget and ` +
      `headroom show what the gate compares. html, total and requests additionally allow ` +
      `${formatBytes(BUDGET.perImage.html)}, ${formatBytes(BUDGET.perImage.total)} and ` +
      `${BUDGET.perImage.requests} per <img> \u2014 shown here at the worst page's ` +
      `${mostImages}.`,
  );

  return lines;
}

/**
 * The pages a budget is about, out of everything the host serves.
 *
 * Directory URLs — a page URL on this site ends in a slash (MUSE-9) — which leaves out
 * exactly one thing: the error page, served extensionlessly at `…/404`.
 *
 * It is left out because it is the one page that **declares no canonical**, deliberately
 * (MUSE-38: a page served at a URL that does not exist cannot say which URL it is), and
 * every request here goes through a check that the page is the page that was named
 * (MUSE-62). That check fails on the error page by construction, and relaxing it so the
 * 404 could be weighed would give back the exact hole that had `test/fonts.test.ts`
 * measuring `404.astro` in CI for months. Its weight is covered where it can be: it is
 * the smallest page in the build, `test/nojs.test.ts` counts its bytes into `dist`,
 * `test/assets.test.ts` resolves its references, and `npm run a11y` audits it in both
 * locales (MUSE-55).
 *
 * `test/budget.test.ts` asserts that this is the only page dropped, so "the budget covers
 * every page" cannot quietly become "the budget covers six of eight".
 *
 * @template {{ path: string, status: number }} T
 * @param {T[]} targets
 * @returns {{ pages: T[], skipped: T[] }}
 */
export function budgetedPages(targets) {
  const pages = targets.filter((target) => target.path.endsWith('/') && target.status === 200);
  return { pages, skipped: targets.filter((target) => !pages.includes(target)) };
}

/**
 * One page's measurement.
 *
 * @typedef {object} Measurement
 * @property {string} route
 * @property {{ url: string, locale: string, lang: string | null }} measured
 * @property {Record<string, number>} bytes Decompressed bytes by resource kind.
 * @property {number} images How many `<img>` the document holds — `BUDGET.perImage`'s multiplier.
 * @property {{ url: string, bytes: number }[]} imageResponses Every image the host served, one by one.
 * @property {number} total
 * @property {number} requests How many 200s the page needed.
 * @property {number} renderBlocking
 * @property {string[]} blocking What those were, for the failure message.
 * @property {string[]} missing Responses that were not 200, which carry no weight.
 * @property {string[]} fonts Face URLs requested with the preloads stripped.
 * @property {{ loadMs: number | null, firstPaintMs: number | null }} advisory Never asserted.
 */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { base } = buildLocation();
  const { pages, skipped } = budgetedPages(auditTargetsOrExit());
  const site = await openSiteOrExit({ routes: pages });
  const browser = await launchChecks();

  console.log(`pages   ${pages.length} from the build at ${base}`);
  if (skipped.length > 0) {
    console.log(
      `skipped ${skipped.map((target) => target.path).join(' ')}  ` +
        '— declares no canonical, so it cannot vouch for being itself (MUSE-62)',
    );
  }

  /** @type {Measurement[]} */
  const measured = [];
  /** @type {string[]} */
  const problems = [];

  for (const target of pages) {
    const page = await measurePage(browser, site.at(target.path), target.route);
    measured.push(page);
    problems.push(...checkBudget(page));
    // The page that was measured, not the route that was asked for (MUSE-48).
    console.log(`        ${describeMeasured(page.measured)}`);
    if (page.missing.length > 0) {
      console.log(`        not served: ${page.missing.join(', ')}`);
    }
  }

  await browser.close();
  await site.close();

  console.log('');
  for (const line of report(measured)) console.log(line);

  if (problems.length > 0) {
    console.error(
      `\n${problems.length} budget overrun(s) across ${
        new Set(problems.map((problem) => problem.split('  ')[0])).size
      } page(s):\n`,
    );
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
      '\nThe budget is in scripts/budget.mjs, as data, with what each number was measured' +
        '\nat beside it. Raising one is a decision — write down what it became and why.',
    );
    process.exit(1);
  }
  console.log(`\nAll ${measured.length} pages within budget.`);
}

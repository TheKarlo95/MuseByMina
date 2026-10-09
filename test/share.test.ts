import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { LOCALES, LOCALE_HTML_LANG, type Locale } from '../src/lib/i18n';
import { LOCKUP_MIN_WIDTH, lockupClearSpace, lockupHeight } from '../src/lib/lockup';
import {
  ogLocale,
  shareCard,
  SHARE_CARD,
  SHARE_CARD_ARTWORK,
  SHARE_CARD_CLEAR,
  SHARE_CARD_FILE,
  SHARE_CARD_GROUND,
  SHARE_CARD_LOCKUP,
  SHARE_CARD_LOCKUP_WIDTH,
  SHARE_IMAGE_MIN,
  SHARE_IMAGE_WIDTH,
} from '../src/lib/share-card';
import type { ImageRef } from '../src/lib/sanity';
import { assetFile, basePath, buildSite, PAGES_DEPLOY, type Build } from './helpers/build';
import { attr } from './helpers/measured';
import { alphaChannel, decodeOpaqueRgb, header } from './helpers/png';
import { claimOutDir } from './helpers/scratch';
import { seedDocs, type SeedDoc } from './helpers/seed';

/**
 * **MUSE-69 — a shared link shows a picture, and the CMS field for it is read.**
 *
 * Two defects that are one. `BaseLayout.astro` emitted `og:title`, `og:description` and
 * `og:url` and **no image**, so every link to this site in a WhatsApp group or an
 * Instagram DM rendered as a bare line of text; and `siteSettings.shareImage` existed end
 * to end — schema, projection, decoder, generated type — with no reader, which is the
 * failure `CLAUDE.md` names: *a CMS field nothing renders is worse than no field.*
 *
 * ## What is checked where, and why it is split that way
 *
 * Three claims, three instruments, because they fail in three different ways:
 *
 *   1. **The tags are on the page, and the URL is absolute and base-joined.** Against
 *      `dist`. A root-relative `og:image` is silently ignored by most scrapers. That the
 *      host was *derived* rather than written is a claim about two targets and is checked
 *      in `test/seo.test.ts`, not here — see below, and MUSE-77 for the test name that
 *      used to say otherwise.
 *   2. **The upload wins and the brand card is the default.** Against the *function*, and
 *      — for the half that has to survive a real build — against a second build reading an
 *      edited fixture, the `test/structured-data.test.ts` technique. A branch asserted only
 *      in-process is a branch the layout can stop calling.
 *   3. **The brand card is the supplied artwork laid out by §12.** Against the committed
 *      PNG's pixels, re-measured from `src/assets/muse-lockup-white.png` every run — the
 *      instrument `test/lockup.test.ts` points at the masthead mark, and for its reason: a
 *      repository that has shipped an invented schedule (MUSE-36) and an invented founding
 *      date (MUSE-60) does not get to assert brand provenance in a comment.
 *
 * ## What is deliberately **not** here
 *
 * **The second deploy target.** `og:image` is a base-joined asset path with the origin on
 * the front, so it is exactly the class `test/assets.test.ts` already resolves under both
 * `SITE`/`BASE` pairs — this ticket taught `assetRefs` to see a `<meta>` image, so that
 * suite now checks the card resolves to a real file on an apex *and* on the Pages
 * sub-path, with no build added anywhere. And `test/seo.test.ts` builds under a second
 * host and asserts the first appears in no byte of the output, which is what makes
 * "derived, not written" a test. Rebuilding here to make the same two claims a third time
 * would cost the suite two more `astro build` runs for nothing.
 *
 * **`npm run budget`.** It cannot see this and reporting nothing is not evidence: MUSE-40
 * established that headless Chromium never fetches a favicon, and it does not fetch an
 * `og:image` either, because no element on the page references one. The card's weight is
 * asserted below, off the committed file.
 */

/* ------------------------------------------------------------------ reading the markup */

/** The `content` of every `<meta>` whose `property` or `name` is `key`, in document order. */
function metaContents(html: string, key: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/g)) {
    const named = attr(m[0], 'property') ?? attr(m[0], 'name');
    if (named !== key) continue;
    const content = attr(m[0], 'content');
    if (content !== undefined) out.push(content);
  }
  return out;
}

/** The one `<meta>` with this key, or `undefined`. Two is a failure the caller makes. */
function meta(html: string, key: string): string | undefined {
  const all = metaContents(html, key);
  expect(all.length, `${key} is declared ${all.length} times`).toBeLessThan(2);
  return all[0];
}

/** The locale a built page is written in, read off the document rather than off its path. */
function localeOf(html: string): Locale {
  const lang = /<html\b[^>]*\blang="([^"]*)"/.exec(html)?.[1];
  const found = LOCALES.find((l) => LOCALE_HTML_LANG[l] === lang);
  expect(found, `<html lang="${lang}"> is not a locale this site has`).toBeDefined();
  return found!;
}

/* ------------------------------------------------------ comparing two inked rectangles */

/** Pearson correlation of two equally long series. 1 is identical shape. */
function correlation(a: number[], b: number[]): number {
  const mean = (xs: number[]): number => xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const [ma, mb] = [mean(a), mean(b)];
  let product = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]! - ma;
    const y = b[i]! - mb;
    product += x * y;
    varA += x * x;
    varB += y * y;
  }
  return product / Math.sqrt(varA * varB);
}

/** Total ink in each column of a `width × height` coverage map. */
function columnProfile(ink: Float64Array, box: { width: number; height: number }): number[] {
  const out = new Array<number>(box.width).fill(0);
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) out[x]! += ink[y * box.width + x]!;
  }
  return out;
}

/** Total ink in each row of a `width × height` coverage map. */
function rowProfile(ink: Float64Array, box: { width: number; height: number }): number[] {
  const out = new Array<number>(box.height).fill(0);
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) out[y]! += ink[y * box.width + x]!;
  }
  return out;
}

/* ------------------------------------------------------------------- the fixture builds */

function seededSettings(): SeedDoc {
  const found = seedDocs().find((doc) => doc._type === 'siteSettings');
  if (!found) throw new Error('The seed has no `siteSettings` document.');
  return found;
}

/** Write a one-off fixture into a directory nothing else can name, and return its path. */
function fixtureOf(docs: unknown[]): string {
  const path = join(claimOutDir('share-fixture'), 'content.ndjson');
  writeFileSync(path, docs.map((doc) => JSON.stringify(doc)).join('\n') + '\n');
  return path;
}

/**
 * A `shareImage` as the Studio would store one, large enough to be a card.
 *
 * The asset id is the whole of what `imageSrc` and `imageSize` read, and its
 * `-1600x900-jpg` tail is not decoration: it is where the dimensions come from, which is
 * what makes `og:image:width` checkable without fetching anything.
 */
const UPLOADED = {
  _type: 'image',
  asset: {
    _type: 'reference',
    _ref: 'image-abc123def456abc123def456abc123def456abc1-1600x900-jpg',
  },
  alt: {
    _type: 'localeString',
    hr: 'Dvoje plesača u zagrljaju, topla svjetlost sa strane.',
    en: 'Two dancers in a close embrace, warm light from the side.',
  },
} as const;

/** The same ref as the decoder hands it over, for the in-process half. */
const UPLOADED_REF: ImageRef = {
  assetId: UPLOADED.asset._ref,
  alt: { hr: UPLOADED.alt.hr, en: UPLOADED.alt.en },
};

let build: Build;
/** The same site, rebuilt with a `shareImage` set — "Mina uploaded one" as a build. */
let uploaded: Build;

beforeAll(async () => {
  build = buildSite(PAGES_DEPLOY);
  uploaded = buildSite(PAGES_DEPLOY, {
    MUSE_CONTENT_FIXTURE: fixtureOf([
      ...seedDocs().filter((doc) => doc._id !== 'siteSettings'),
      { ...seededSettings(), shareImage: UPLOADED },
    ]),
  });
}, 300_000);

/* ------------------------------------------------------- AC1: the tags, on every page */

describe('AC1: every built page declares a link preview card', () => {
  it('declares og:image, og:image:alt, twitter:card and twitter:image on every page', () => {
    const missing = build.htmlFiles().flatMap((page) => {
      const html = build.read(page);
      return [
        ['og:image', meta(html, 'og:image')],
        ['og:image:alt', meta(html, 'og:image:alt')],
        ['og:image:width', meta(html, 'og:image:width')],
        ['og:image:height', meta(html, 'og:image:height')],
        ['twitter:card', meta(html, 'twitter:card')],
        ['twitter:image', meta(html, 'twitter:image')],
        ['twitter:image:alt', meta(html, 'twitter:image:alt')],
      ]
        .filter(([, value]) => value === undefined || value === '')
        .map(([key]) => `${page}: no ${key}`);
    });

    expect(missing).toEqual([]);
  });

  it('finds pages to check, so the assertion above cannot pass vacuously', () => {
    expect(build.htmlFiles().length).toBeGreaterThan(8);
  });

  /**
   * `summary_large_image`, not `summary`.
   *
   * `summary` renders the image as a small square thumbnail beside the text, which is the
   * outcome this ticket exists to improve on — and it would crop a 1.91:1 card to 1:1,
   * cutting „DANCE STUDIO" and „BY MINA" off the lockup's shoulders.
   */
  it('asks for the large card rather than the thumbnail', () => {
    for (const page of build.htmlFiles()) {
      expect(meta(build.read(page), 'twitter:card'), page).toBe('summary_large_image');
    }
  });

  /**
   * The two image tags name the same URL.
   *
   * X falls back to `og:image` when `twitter:image` is absent, so the second tag exists
   * only to be explicit — and two tags that could disagree are worth nothing unless they
   * cannot. Same for the alt.
   */
  it('gives Twitter the same image and the same alt as Open Graph', () => {
    for (const page of build.htmlFiles()) {
      const html = build.read(page);
      // Both defined first: two absent tags are trivially equal, and an assertion that
      // a missing feature agrees with itself is the shape of green test this repo keeps
      // re-filing.
      expect(meta(html, 'twitter:image'), page).toBeDefined();
      expect(meta(html, 'twitter:image:alt'), page).toBeDefined();
      expect(meta(html, 'twitter:image'), page).toBe(meta(html, 'og:image'));
      expect(meta(html, 'twitter:image:alt'), page).toBe(meta(html, 'og:image:alt'));
    }
  });

  /**
   * **The 404 carries a card too, and that is a decision** (MUSE-38).
   *
   * It carries no canonical and no JSON-LD, because both are claims *about a URL* and the
   * host serves the error page's body for any unknown path — so the URL it would name is
   * itself a 404. An `og:image` names no URL of the site's. It is the same class of thing
   * as the tab icon and `theme-color`, which the error page already carries for exactly
   * this reason (`src/lib/icon.ts`), and the page already emits `og:title` and
   * `og:description` — so withholding only the image would produce precisely the bare text
   * card this ticket is about, on the one page a stale shared link actually reaches.
   */
  it('declares a card on the error page, which declares no canonical', () => {
    const html = build.read('404.html');
    expect(html).not.toContain('rel="canonical"');
    expect(meta(html, 'og:image')).toBeDefined();
    expect(meta(html, 'og:url'), 'the 404 must still claim no URL').toBeUndefined();
  });
});

/* --------------------------------------------- AC1: absolute, base-joined, non-redirecting */

describe('AC1: the card URL is absolute, base-joined, and resolves without a redirect', () => {
  it('is an absolute https URL on the deploy origin', () => {
    for (const page of build.htmlFiles()) {
      const url = meta(build.read(page), 'og:image')!;
      // A root-relative path is silently ignored by most scrapers: the card simply never
      // appears, and the scraper caches that.
      expect(url.startsWith(`${build.origin}/`), `${page}: ${url}`).toBe(true);
      expect(new URL(url).protocol).toBe('https:');
    }
  });

  /**
   * **This checks the shape of the URL, not that the host was derived** — and it used to
   * be named as though it checked the second (MUSE-77).
   *
   * It read `names no host of its own: the URL moves with SITE and BASE`, which it cannot
   * see: both builds in this file are `PAGES_DEPLOY`, so there is one origin to compare
   * against and `'https://thekarlo95.github.io' + card.src` written into
   * `BaseLayout.astro` **passes it**. There is no coverage hole — `test/seo.test.ts`
   * catches that mutation twice, in `dist` and by naming the file — and the delegation is
   * argued in this file's header. The name was the defect: if that suite is ever weakened,
   * a name like the old one reads as cover that was never here, which is the one thing a
   * guard must not do.
   *
   * So it says what it does. The claim is still worth making here, beside the three
   * assertions that share its subject: the card URL carries the deploy's origin and sits
   * under its base prefix, which is the base-path join `og:image` has to be.
   */
  it('carries this build’s origin and base path on the front', () => {
    const url = meta(build.read('index.html'), 'og:image')!;
    expect(url.slice(0, build.origin.length)).toBe(build.origin);
    expect(new URL(url).pathname.startsWith(basePath(build))).toBe(true);
  });

  /**
   * The fact the name above is calibrated against, as an assertion rather than as a note.
   *
   * Both builds are the same deploy target — the second varies the *dataset*, not
   * `SITE`/`BASE` — so nothing in this file can tell a derived host from a written one.
   * Point `uploaded` at the apex and this goes red, which is the moment to re-read the
   * name above, the header's "what is deliberately not here", and `DECLARED`'s reason in
   * `test/helpers/concurrency.ts`, all three of which say "one target, twice".
   *
   * Not a comment, because a comment is what MUSE-77 found: three statements of one fact
   * with nothing holding them to it. And raising the count is not free either — MUSE-68's
   * census is at headroom 0.
   */
  it('builds one deploy target twice, which is why the claim above is the weaker one', () => {
    expect(uploaded.origin).toBe(build.origin);
    expect(basePath(uploaded)).toBe(basePath(build));
  });

  /**
   * A URL that 301s disqualifies a card the way it disqualifies a canonical (MUSE-9) —
   * and here it is also a file-existence question, so both halves are checked: the path
   * is under the deploy's base prefix, and something in `dist` is served at it.
   *
   * `test/assets.test.ts` makes the second claim under both deploy targets now that
   * `assetRefs` reads a `<meta>` image; this one names the card specifically, because a
   * declared card that 404s is worse than no card at all — the scraper caches the failure.
   */
  it('resolves to a real file in the output, under the deploy base path', () => {
    for (const page of build.htmlFiles()) {
      const url = meta(build.read(page), 'og:image')!;
      const path = new URL(url).pathname;
      expect(path.startsWith(basePath(build)), `${page}: ${path}`).toBe(true);
      expect(path.endsWith('/'), `${page}: ${path} would 301 to its directory`).toBe(false);

      const file = assetFile(build, url);
      expect(file !== undefined && build.isFile(file), `${page}: ${url} serves no file`).toBe(
        true,
      );
    }
  });

  /** Every page agrees. One route emitting a stale URL is invisible to a one-page read. */
  it('declares the same card on every page', () => {
    const urls = new Set(build.htmlFiles().map((page) => meta(build.read(page), 'og:image')));
    expect([...urls]).toHaveLength(1);
    expect([...urls][0], 'no page declares a card at all').toBeDefined();
  });

  /**
   * Not a `data:` URI, which is what Vite emits for an asset under its inline threshold.
   *
   * `?url&no-inline` in `src/lib/share-card.ts` is what prevents it, and the failure it
   * prevents is silent: a base64 payload is a perfectly well-formed `content` attribute
   * and a card no scraper can fetch, cache or re-fetch.
   */
  it('is a URL a scraper can fetch, not an inlined data: URI', () => {
    expect(meta(build.read('index.html'), 'og:image')).not.toMatch(/^data:/);
  });
});

/* --------------------------------------------------------- AC1: the alt, in each locale */

describe('AC1: the card is described in the language of the page it sits on', () => {
  it('gives each locale its own og:image:alt', () => {
    const byLocale = new Map<Locale, Set<string>>();
    for (const page of build.htmlFiles()) {
      const html = build.read(page);
      if (page === '404.html') continue; // bilingual by design (MUSE-38); see below.
      const locale = localeOf(html);
      const seen = byLocale.get(locale) ?? new Set<string>();
      seen.add(meta(html, 'og:image:alt')!);
      byLocale.set(locale, seen);
    }

    for (const locale of LOCALES) {
      expect([...(byLocale.get(locale) ?? [])], `${locale} alts`).toHaveLength(1);
    }
    const [hr] = [...byLocale.get('hr')!];
    const [en] = [...byLocale.get('en')!];
    expect(hr, 'the two locales share one alt string').not.toBe(en);
  });

  /**
   * The error page is bilingual markup served at one URL (MUSE-38), so there is no "page's
   * own locale" to pick — `<html lang>` says `hr-HR` and the body says both. It takes the
   * Croatian alt, which is what `<html lang>` promises a screen reader, rather than a
   * concatenation of both.
   */
  it('describes the bilingual error page in the language its <html lang> declares', () => {
    const html = build.read('404.html');
    const locale = localeOf(html);
    const twin = build
      .htmlFiles()
      .find((page) => page !== '404.html' && localeOf(build.read(page)) === locale)!;
    expect(meta(html, 'og:image:alt')).toBeDefined();
    expect(meta(html, 'og:image:alt')).toBe(meta(build.read(twin), 'og:image:alt'));
  });
});

/* --------------------------------------------------------------- AC1: og:locale, MUSE-9 */

describe('AC1: the page says which language it is in, and promises no negotiation', () => {
  it('derives og:locale from the hreflang tag the page already declares', () => {
    for (const page of build.htmlFiles()) {
      const html = build.read(page);
      expect(meta(html, 'og:locale'), page).toBe(ogLocale(LOCALE_HTML_LANG[localeOf(html)]));
    }
  });

  /**
   * **No `og:locale:alternate`, deliberately.** Facebook responds to it by re-requesting
   * the *same URL* with `?fb_locale=…` and expecting a different language back. This site
   * is static with the locale in the path, so that refetch returns Croatian and gets
   * cached as the English rendering — a worse answer than silence. The hreflang cluster is
   * where the pairing is stated, to crawlers that read paths.
   */
  it('declares no og:locale:alternate on any page', () => {
    const offenders = build
      .htmlFiles()
      .filter((page) => metaContents(build.read(page), 'og:locale:alternate').length > 0);
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------- AC2/AC3: the upload wins, the card defaults */

describe('AC2: a shareImage in the Studio is what gets published', () => {
  it('uses the upload, at the width it declares, on every page of a rebuilt site', () => {
    for (const page of uploaded.htmlFiles()) {
      const html = uploaded.read(page);
      const url = meta(html, 'og:image')!;
      expect(url.startsWith('https://cdn.sanity.io/'), `${page}: ${url}`).toBe(true);
      expect(url).toContain('abc123def456abc123def456abc123def456abc1');
      expect(meta(html, 'og:image:width'), page).toBe(String(SHARE_IMAGE_WIDTH));
      // 1600 × 900 asked for at 1200 is 675 tall. Declared, not guessed — see `imageSize`.
      expect(meta(html, 'og:image:height'), page).toBe('675');
    }
  });

  it('takes the alt from the upload, in the page’s own locale', () => {
    for (const page of uploaded.htmlFiles()) {
      if (page === '404.html') continue;
      const html = uploaded.read(page);
      expect(meta(html, 'og:image:alt'), page).toBe(UPLOADED.alt[localeOf(html)]);
    }
  });

  it('ships no reference to the brand card once an upload exists', () => {
    // The strong form: not merely "the tag changed" but "the fallback is gone from the
    // markup", which is what a layout emitting both would fail.
    const stem = SHARE_CARD_FILE.replace(/\.png$/, '');
    // The fallback build is read first, so "the brand card is absent" is a difference
    // rather than a property of a layout that references neither.
    expect(build.read('index.html')).toContain(stem);
    for (const page of uploaded.htmlFiles()) {
      expect(uploaded.read(page), page).not.toContain(stem);
    }
  });

  /** The in-process half: one function decides, so the branch is stated where it is made. */
  it('prefers the upload over the brand card, per locale', () => {
    for (const locale of LOCALES) {
      const card = shareCard(UPLOADED_REF, locale);
      expect(card.fromStudio).toBe(true);
      expect(card.alt).toBe(UPLOADED.alt[locale]);
      expect(card).toMatchObject({ width: 1200, height: 675 });
    }
  });

  /**
   * **The declared size describes the bytes, in the two cases where it easily would not.**
   *
   * A manual crop: `rect` has already trimmed the asset by the time a pixel is served, so
   * a height taken off the *original* would letterbox the card in whichever client trusts
   * the tag. And an upload narrower than the width asked for: the CDN will not invent
   * detail, so `imageSize` clamps and `shareCard` asks `imageSrc` for the clamped width,
   * which is the only reason the two cannot disagree.
   */
  it('declares the cropped size, and never a size larger than the asset has', () => {
    const cropped: ImageRef = {
      ...UPLOADED_REF,
      // Bottom third cropped away: 1600 × 600 of the original 1600 × 900.
      crop: { top: 0, bottom: 1 / 3, left: 0, right: 0 },
    };
    expect(shareCard(cropped, 'hr')).toMatchObject({ width: 1200, height: 450 });

    const small: ImageRef = { ...UPLOADED_REF, assetId: 'image-abc123-800x420-jpg' };
    const card = shareCard(small, 'hr');
    expect(card).toMatchObject({ width: 800, height: 420 });
    expect(card.src, 'the URL asks for a width the asset does not have').toContain('w=800');
  });

  /**
   * An upload too small to render as a card fails the build rather than being swapped out.
   *
   * Substituting would be the invisible failure: Mina uploads something, the site shows
   * something else, nothing says the upload was rejected. The message offers clearing the
   * field as a fix, which is legitimate here — the same call `failDangling` makes for an
   * optional reference (MUSE-49).
   */
  it('refuses an upload below the size a platform draws as a card', () => {
    const tiny: ImageRef = { ...UPLOADED_REF, assetId: 'image-abc123-400x225-jpg' };
    expect(() => shareCard(tiny, 'hr')).toThrow(/400 × 225/);
    expect(() => shareCard(tiny, 'hr')).toThrow(/clear the field/);
    expect(() => shareCard(tiny, 'hr')).toThrow(
      new RegExp(`${SHARE_IMAGE_MIN.width} × ${SHARE_IMAGE_MIN.height}`),
    );
  });

  it('accepts an upload exactly at the floor, so the floor is a floor and not a gap', () => {
    const atFloor: ImageRef = {
      ...UPLOADED_REF,
      assetId: `image-abc123-${SHARE_IMAGE_MIN.width}x${SHARE_IMAGE_MIN.height}-jpg`,
    };
    expect(shareCard(atFloor, 'hr')).toMatchObject(SHARE_IMAGE_MIN);
  });
});

describe('AC3: with no shareImage set, the brand card is published and nothing is blank', () => {
  it('is the state of the dataset today, so the build above is the fallback path', () => {
    expect(seededSettings().shareImage, 'the seed has gained a shareImage').toBeUndefined();
  });

  it('names the composed card and declares its real dimensions', () => {
    const html = build.read('index.html');
    expect(meta(html, 'og:image')).toContain(SHARE_CARD_FILE.replace(/\.png$/, ''));
    expect(meta(html, 'og:image:width')).toBe(String(SHARE_CARD.width));
    expect(meta(html, 'og:image:height')).toBe(String(SHARE_CARD.height));
  });

  it('falls back only when the field is empty', () => {
    const card = shareCard(undefined, 'hr');
    expect(card.fromStudio).toBe(false);
    expect(card).toMatchObject({ width: SHARE_CARD.width, height: SHARE_CARD.height });
    expect(card.alt).not.toBe('');
  });
});

/* ------------------------------------------- the card is §12 applied to a 1200×630 frame */

describe('the brand card is the supplied artwork, laid out by design system §12', () => {
  const file = readFileSync(join('src/assets', SHARE_CARD_FILE));
  const ground = {
    r: Number.parseInt(SHARE_CARD_GROUND.slice(1, 3), 16),
    g: Number.parseInt(SHARE_CARD_GROUND.slice(3, 5), 16),
    b: Number.parseInt(SHARE_CARD_GROUND.slice(5, 7), 16),
  };

  /**
   * How white each pixel is, 0–1, as a plain ratio against the plum ground.
   *
   * The card is two colours and everything between them is antialiasing, so the green
   * channel alone recovers the artwork's alpha: the ground is 0x05 there and the ink is
   * 0xFF, which is the widest of the three separations and the least sensitive to the
   * palette's quantisation.
   */
  function inkMask(): { width: number; height: number; ink: Float64Array } {
    const { header: head, pixels } = decodeOpaqueRgb(file);
    const ink = new Float64Array(head.width * head.height);
    for (let i = 0; i < ink.length; i += 1) {
      ink[i] = (pixels[i * 3 + 1]! - ground.g) / (255 - ground.g);
    }
    return { width: head.width, height: head.height, ink };
  }

  /** The tightest box containing every pixel that is not the ground. */
  function inkBox(): { left: number; top: number; right: number; bottom: number } {
    const { width, height, ink } = inkMask();
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // A whole palette step above the ground, so quantisation noise is not "ink".
        if (ink[y * width + x]! <= 0.01) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
    return { left, top, right, bottom };
  }

  it('is 1200 × 630 — the frame every platform crops towards', () => {
    const head = header(file);
    expect({ width: head.width, height: head.height }).toEqual({
      width: SHARE_CARD.width,
      height: SHARE_CARD.height,
    });
  });

  /**
   * Opaque. `decodeOpaqueRgb` refuses a `tRNS` chunk, so calling it at all is half the
   * assertion; the corners say the ground is the ground rather than merely opaque.
   */
  it('is opaque, on §12’s plum', () => {
    const { width, height } = header(file);
    const { pixels } = decodeOpaqueRgb(file);
    for (const [x, y] of [
      [0, 0],
      [width - 1, 0],
      [0, height - 1],
      [width - 1, height - 1],
    ]) {
      const at = (y! * width + x!) * 3;
      expect([pixels[at], pixels[at + 1], pixels[at + 2]], `corner ${x},${y}`).toEqual([
        ground.r,
        ground.g,
        ground.b,
      ]);
    }
  });

  it('places the lockup in the box the geometry says, centred', () => {
    const box = inkBox();
    expect({
      left: box.left,
      top: box.top,
      width: box.right - box.left + 1,
      height: box.bottom - box.top + 1,
    }).toEqual({
      left: SHARE_CARD_LOCKUP.left,
      top: SHARE_CARD_LOCKUP.top,
      width: SHARE_CARD_LOCKUP.width,
      height: SHARE_CARD_LOCKUP.height,
    });
  });

  /**
   * §12: *clear space minimum equal to the cap height of „MUSE" on all four sides.*
   *
   * Measured off the committed pixels rather than off the constants that placed them, so
   * a card regenerated by hand with the lockup nudged is a failure. The margin is at
   * least the clear space on every side — "minimum" is the word §12 uses.
   */
  it('keeps §12’s clear space on all four sides', () => {
    const box = inkBox();
    const margins = {
      left: box.left,
      top: box.top,
      right: SHARE_CARD.width - 1 - box.right,
      bottom: SHARE_CARD.height - 1 - box.bottom,
    };
    for (const [side, margin] of Object.entries(margins)) {
      expect(margin, `${side} margin is under §12's clear space`).toBeGreaterThanOrEqual(
        SHARE_CARD_CLEAR,
      );
    }
  });

  it('draws the lockup above §12’s minimum reproduction size', () => {
    expect(SHARE_CARD_LOCKUP_WIDTH).toBeGreaterThanOrEqual(LOCKUP_MIN_WIDTH);
  });

  it('derives its geometry rather than restating it', () => {
    // If either §12 rule in `src/lib/lockup.ts` is ever re-measured off the artwork, the
    // card's constants have to move with it — they are the same two functions.
    expect(SHARE_CARD_LOCKUP.height).toBe(lockupHeight(SHARE_CARD_LOCKUP_WIDTH));
    expect(SHARE_CARD_CLEAR).toBe(lockupClearSpace(SHARE_CARD_LOCKUP_WIDTH));
  });

  /**
   * **Nothing was drawn, traced or set in type: the card is the lockup, resampled.**
   *
   * The committed artwork's alpha channel is area-averaged down to the drawn box — every
   * source pixel split across the target cells it covers, which is what a resample does —
   * and the result is compared to the card's ink by **column and row ink profile**: the
   * per-column and per-row sums of coverage.
   *
   * Profiles rather than a pixel diff, because a pixel diff pins the file to one
   * resampler's rounding and goes red on a tool upgrade nobody can see. A profile is the
   * mark's silhouette, and what it separates is exactly what matters here — a wordmark
   * set in Cormorant and Jost (§12's named *"do not"*, and what the masthead carried
   * until MUSE-67), a redraw, a re-crop, a different logo.
   *
   * **Both axes, because each catches what the other cannot.** Measured against the
   * committed files: the artwork scores **0.9999** on both. A horizontally mirrored copy
   * scores 0.2172 on columns and **0.9999 on rows** — mirroring leaves a row profile
   * untouched, so the row test alone would pass it. MUSE-40's icon-only crop, which is
   * the other plausible wrong artwork, scores −0.03 and 0.57.
   */
  it('reproduces the artwork’s own silhouette', () => {
    const artwork = readFileSync(SHARE_CARD_ARTWORK);
    const art = header(artwork);
    const alpha = alphaChannel(artwork);
    const drawn = SHARE_CARD_LOCKUP;

    /** The artwork's alpha, area-averaged into the drawn box — a resample, by hand. */
    const expected = new Float64Array(drawn.width * drawn.height);
    const scaleX = drawn.width / art.width;
    const scaleY = drawn.height / art.height;
    for (let y = 0; y < art.height; y += 1) {
      const y0 = y * scaleY;
      const y1 = y0 + scaleY;
      for (let x = 0; x < art.width; x += 1) {
        const coverage = alpha[y * art.width + x]! / 255;
        if (coverage === 0) continue;
        const x0 = x * scaleX;
        const x1 = x0 + scaleX;
        for (let ty = Math.floor(y0); ty < Math.min(drawn.height, Math.ceil(y1)); ty += 1) {
          const wy = Math.min(y1, ty + 1) - Math.max(y0, ty);
          if (wy <= 0) continue;
          for (let tx = Math.floor(x0); tx < Math.min(drawn.width, Math.ceil(x1)); tx += 1) {
            const wx = Math.min(x1, tx + 1) - Math.max(x0, tx);
            if (wx <= 0) continue;
            expected[ty * drawn.width + tx]! += (coverage * wx * wy) / (scaleX * scaleY);
          }
        }
      }
    }

    const { width, ink } = inkMask();
    const got = new Float64Array(drawn.width * drawn.height);
    for (let y = 0; y < drawn.height; y += 1) {
      for (let x = 0; x < drawn.width; x += 1) {
        got[y * drawn.width + x] = ink[(drawn.top + y) * width + (drawn.left + x)]!;
      }
    }

    expect(
      correlation(columnProfile(expected, drawn), columnProfile(got, drawn)),
      'the card’s column ink profile is not the artwork’s',
    ).toBeGreaterThan(0.99);
    expect(
      correlation(rowProfile(expected, drawn), rowProfile(got, drawn)),
      'the card’s row ink profile is not the artwork’s',
    ).toBeGreaterThan(0.99);
  });

  /**
   * **What the card weighs, measured — because the budget structurally cannot.**
   *
   * `scripts/budget.mjs` records what a browser fetches, and no page element references
   * an `og:image`, so headless Chromium never asks for it and `npm run budget` reports
   * nothing about it. The ceiling that matters is a messaging client's, not the Open
   * Graph spec's 8 MB: WhatsApp and iMessage give up on a preview image well before that,
   * and 300 KB is comfortably inside every published practical limit.
   *
   * The committed file is **23,745 bytes** — a flat ground and one white mark, stored as
   * a 256-colour palette rather than RGBA, which is the same picture at half the size.
   */
  it('weighs well under what a messaging client will fetch', () => {
    expect(file.byteLength).toBeLessThan(300 * 1024);
    expect(file.byteLength).toBeLessThan(40 * 1024);
  });

  it('ships the card into the output exactly once', () => {
    const stem = SHARE_CARD_FILE.replace(/\.png$/, '');
    const emitted = build.allFiles().filter((f) => f.includes(stem));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.endsWith('.png')).toBe(true);
  });
});

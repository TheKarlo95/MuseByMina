import { AxeBuilder } from '@axe-core/playwright';
import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchChecks, openCheckPage } from '../scripts/browser-checks.mjs';
import Gallery from '../src/components/Gallery.astro';
import {
  EAGER_TILES,
  FULL_SIZES,
  FULL_WIDTHS,
  GALLERY_COPY,
  GALLERY_ROUTE,
  GRID_SIZES,
  GRID_WIDTHS,
  galleryPosition,
} from '../src/lib/gallery';
import { LOCALES, localeUrl, type Locale } from '../src/lib/i18n';
import { MORE_NAV, PRIMARY_NAV } from '../src/lib/nav';
import { ROUTES } from '../src/lib/pages';
import { decodeGalleryImage, type GalleryImage } from '../src/lib/sanity/decode';
import { imageSrc, imageSrcSet } from '../src/lib/sanity/images';
import { seedDocs } from './helpers/seed';
import { pagePath, startPreview, type Preview } from './helpers/preview';
import {
  GALLERY_CROPPED,
  GALLERY_HALF_ALT,
  GALLERY_NO_ALT,
  GALLERY_RENDERED,
  GALLERY_RENDERED_IMAGES,
  GALLERY_REWRITTEN,
  fixtureOf,
  type FixtureDoc,
} from './helpers/structural-content';

/**
 * **MUSE-25 — `/gallery`, a lightbox, and the page a studio with no photographs gets.**
 *
 * =================================================================================
 * ## What this suite is about, in the order the ticket put it
 *
 * **1. The empty state is the shipped state.** There are no `galleryImage` documents and
 * no photography of this studio has been taken. Unlike `/events` and `/blog`, whose
 * purpose survives having no content, a gallery's entire purpose *is* the images — so the
 * empty state is not a fallback here, it is the page, and most of what is asserted about it
 * is what it does **not** do: no grid, no section heading, no lede, no placeholder tiles,
 * no promise. The fixtures that populate it live under `test/` and never in
 * `content/seed.ndjson`, which is MUSE-36's rule and `/events`'s precedent.
 *
 * **2. The lightbox traps focus and gives it back.** That is the criterion a modal is
 * most likely to get wrong, and the implementation's answer is to not write it: a native
 * `<dialog>` opened with `showModal()` makes the rest of the document inert, so the trap is
 * the platform's. A test of a trap therefore has to be a test of *inertness* — tab a dozen
 * times and require every landing to be inside the dialog — rather than a test that a
 * handler wrapped an index.
 *
 * **3. `npm run a11y` only sees a page at rest.** It is the gate for `/gallery` closed, in
 * both themes, against every rule axe enables by default. The **open** lightbox is audited
 * here, in both themes, also unfiltered — `test/contact.test.ts`'s precedent for the form's
 * error state, which is the gap the ticket names by name.
 *
 * **4. A phone must not be sent a full-resolution original.** Asserted by measuring
 * `img.currentSrc` in a real browser at 390 and at 1280 and comparing the candidate the
 * engine selected against the box it painted. A model of the selection algorithm would
 * pass whenever the model is wrong, which is `test/fonts.test.ts`'s and
 * `test/numerals.test.ts`'s reasoning applied to `sizes`.
 *
 * ## Two heavyweight operations, and what each is for
 *
 * MUSE-68's budget has no headroom, so the split is deliberate. **One build**, against a
 * dataset holding seven photographs, because the lightbox cannot be opened in Astro's
 * container API — the container runs no asset pipeline, no router and no browser, so it
 * cannot see the emitted CSS, cannot resolve a URL and cannot press a key. **One browser**,
 * for the trap, the keys, the axe audit of the open state and the `currentSrc` measurement.
 * Everything that is markup — every string, every attribute, every branch of the empty
 * state — is a container render and costs nothing.
 *
 * The populated build is also the only place a *populated* gallery exists anywhere in this
 * repository: the committed seed has no photographs, so CI never builds one, which is
 * exactly why `scripts/budget.mjs`'s image line had to be re-measured by hand against this
 * fixture rather than discovered by a red gate. That measurement is recorded beside the
 * number, not here.
 *
 * ## Nothing in this suite touches the network
 *
 * A populated gallery's `<img src>` points at `cdn.sanity.io`, and the fixture asset ids
 * are not real uploads. Every request to that host is intercepted and answered locally, so
 * the suite is offline and deterministic the way every other suite here is. What that
 * cannot prove is the CDN's own encoder — whether `w=350&auto=format&q=80` really returns
 * the bytes the budget was measured against — and that needs a real upload in Mina's
 * dataset, so it is called out in the pull request rather than asserted here.
 * =================================================================================
 */

/** A 1×1 opaque PNG. Stands in for every photograph, so nothing leaves the box. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/AwAAAAwABPtLDUAAAAABJRU5ErkJggg==',
  'base64',
);

const CDN = '**cdn.sanity.io/**';

let container: AstroContainer;
let browser: Browser;
let preview: Preview;

beforeAll(async () => {
  [container, preview, browser] = await Promise.all([
    AstroContainer.create(),
    startPreview('gallery', {
      content: fixtureOf(GALLERY_RENDERED as FixtureDoc[], 'gallery'),
    }),
    launchChecks(),
  ]);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await preview?.close();
});

/** The seven fixture photographs, decoded the way the page receives them. */
function photographsOf(docs: readonly FixtureDoc[]): GalleryImage[] {
  return docs.map((doc) =>
    decodeGalleryImage({
      _id: doc._id,
      caption: doc.caption,
      takenAt: doc.takenAt,
      image: {
        assetId: (doc.image as { asset: { _ref: string } }).asset._ref,
        alt: (doc.image as { alt?: unknown }).alt,
        hotspot: (doc.image as { hotspot?: unknown }).hotspot,
        crop: (doc.image as { crop?: unknown }).crop,
      },
    }),
  );
}

const PHOTOGRAPHS = () => photographsOf(GALLERY_RENDERED_IMAGES);

/**
 * Rendered markup with Astro's attribute escaping undone, so a URL can be compared.
 *
 * Astro escapes `&` in an attribute value to `&amp;`, and a Sanity image URL carries three
 * of them — so `expect(html).toContain(imageSrc(…))` fails on a component that is
 * completely correct. Undone here rather than escaped at the assertion, because the thing
 * being asserted is the URL the browser will resolve, and that is the unescaped one.
 */
function unescaped(html: string): string {
  return html.replaceAll('&amp;', '&');
}

/** Markup with the tags removed, for „does this page say X" over rendered text. */
function words(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface Visit {
  page: Page;
  close(): Promise<void>;
}

/**
 * Open a page of the populated build, with `cdn.sanity.io` answered locally.
 *
 * Through `scripts/browser-checks.mjs` (MUSE-48): the locale comes off the route, both
 * halves of the language pin are set, and the landing URL is asserted inside the door.
 */
async function visit(
  route: string,
  opts: { scheme?: 'dark' | 'light'; width?: number; height?: number } = {},
): Promise<Visit> {
  const { page, close } = await openCheckPage(browser, preview, route, {
    context: {
      colorScheme: opts.scheme ?? 'dark',
      // The a11y gate's viewport by default, so a geometry claim here means the same thing
      // there.
      viewport: { width: opts.width ?? 1280, height: opts.height ?? 900 },
    },
    prepare: async (opened) => {
      await opened.route(CDN, (interception) =>
        interception.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }),
      );
    },
  });
  await page.evaluate(() => document.fonts.ready);
  return { page, close };
}

/* ======================================================= the route is routed everywhere */

describe('routing `/gallery` is all four halves or none of them (MUSE-46)', () => {
  it('is a route, with a page document and a file behind it', () => {
    expect(ROUTES.map(({ route }) => route)).toContain(GALLERY_ROUTE);
    // The three-way agreement itself is `test/routes.test.ts`, anchored on `src/pages/`.
    // What is here is the half that is this ticket's: the seed carries the document, so
    // `npm run sanity:seed` has something to import and the build has a `<title>`.
    const documents = seedDocs().filter(
      (doc) => doc._type === 'page' && doc.route === GALLERY_ROUTE,
    );
    expect(documents.map((doc) => doc._id)).toEqual(['page-gallery']);
  });

  it('is behind the More disclosure and not in the desktop bar', () => {
    // The ticket's own instruction — „this page should not be linked prominently until it
    // has real content" — and the bar's four-link budget, which `test/nav.test.ts` holds.
    // Stated as a test because promoting the entry is how „the photographs landed" is
    // supposed to show up in a diff, and a silent promotion is the thing to notice.
    expect(MORE_NAV.map(({ route }) => route)).toContain(GALLERY_ROUTE);
    expect(PRIMARY_NAV.map(({ route }) => route)).not.toContain(GALLERY_ROUTE);
  });
});

/* ============================================================= with nothing on the page */

describe('with no photographs at all, the page says so (AC5)', () => {
  it('says there are none, as a heading rather than a note', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Gallery, {
        props: { locale, photographs: [] },
      });
      expect(words(html)).toContain(GALLERY_COPY[locale].emptyHeading);
      expect(html).toMatch(/<h2[^>]*class="emptyH/);
    }
  });

  it('renders no grid, no section heading and no lightbox', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Gallery, {
        props: { locale, photographs: [] },
      });
      // An empty grid reads as a page that failed to load, and a heading over nothing reads
      // the same way. A `<dialog>` with no frames is a mechanism with nothing to show.
      expect(html).not.toContain('class="grid"');
      expect(html).not.toContain('data-tile');
      expect(html).not.toContain('<dialog');
      expect(words(html)).not.toContain(GALLERY_COPY[locale].photographs);
    }
  });

  it('withholds the lede, which is the thing `/events` keeps', async () => {
    /**
     * The one structural difference between this empty state and MUSE-24's, and the reason
     * is the ticket's own framing: an events page with no events still has a subject — the
     * studio runs a weekly timetable — so its lede („parties and workshops, each with its
     * own page") describes the *page*. A gallery's lede can only describe the photographs,
     * so with none it would be a sentence about pictures that do not exist.
     */
    for (const locale of LOCALES) {
      const empty = await container.renderToString(Gallery, {
        props: { locale, photographs: [] },
      });
      expect(words(empty)).not.toContain(GALLERY_COPY[locale].lede);

      const full = await container.renderToString(Gallery, {
        props: { locale, photographs: PHOTOGRAPHS() },
      });
      expect(words(full)).toContain(GALLERY_COPY[locale].lede);
    }
  });

  it('offers somewhere else to go', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Gallery, {
        props: { locale, photographs: [] },
      });
      expect(html).toContain(`href="${localeUrl('/schedule', locale)}"`);
      expect(html).toContain(`href="${localeUrl('/contact', locale)}"`);
    }
  });

  it('promises no photography that nobody has booked', async () => {
    /**
     * `/events` and `/blog` each carry a version of this and it matters more here, because
     * this is the page whose content genuinely does not exist: „uskoro" would be a
     * commitment on behalf of a shoot nobody has scheduled, which is MUSE-36's defect in a
     * smaller font and MUSE-71's in a different tense.
     *
     * Read over the empty block rather than the page, the way MUSE-24 states it, and over
     * the *copy table* as well — so the needle cannot be smuggled into a string the
     * container happens not to render in this branch.
     */
    const forbidden = [
      'uskoro',
      'provjeri',
      'najavit',
      'u pripremi',
      'u izradi',
      'soon',
      'check back',
      'stay tuned',
      'coming',
      'watch this space',
      'placeholder',
    ];

    for (const locale of LOCALES) {
      const html = await container.renderToString(Gallery, {
        props: { locale, photographs: [] },
      });
      const read = words(html).toLowerCase();
      for (const promise of forbidden) {
        expect(read, `the empty state hints at "${promise}"`).not.toContain(promise);
      }
      for (const value of Object.values(GALLERY_COPY[locale])) {
        for (const promise of forbidden) {
          expect(value.toLowerCase(), `GALLERY_COPY promises "${promise}"`).not.toContain(
            promise,
          );
        }
      }
    }
  });

  it('keeps the words in code, where the dataset cannot make them untrue', () => {
    /**
     * `EVENT_COPY`'s argument, applied: „there are no photographs" is a statement about the
     * dataset, and a `localeString` for it would be a field whose correct value depends on
     * what else is in the dataset — Mina cannot see when it renders, so she cannot keep it
     * true, and a stale one reads as a claim rather than as a state. The same goes for the
     * lightbox's own labels, which describe a control rather than a photograph.
     *
     * The assertion is that none of *those* strings is also in the seed, which is what a
     * half-migration would look like.
     *
     * **The page's name is deliberately not on this list.** „Galerija" is both this
     * component's `<h1>` and `page-gallery`'s `name.hr`, exactly as „Događaji" is
     * `EVENT_COPY.heading` and `page-events`'s — the two say the same word because it is
     * the right word for the page in both places, not because one derives from the other.
     * `src/lib/pages.ts` argues that case at length for `studioLabel`.
     */
    const describesTheDataset = [
      'emptyHeading',
      'emptyBody',
      'lightbox',
      'open',
      'close',
      'previous',
      'next',
    ] as const;

    const seed = JSON.stringify(seedDocs());
    for (const locale of LOCALES) {
      for (const key of describesTheDataset) {
        const value = GALLERY_COPY[locale][key];
        expect(seed, `"${value}" is in the seed as well as in code`).not.toContain(value);
      }
    }
  });
});

/* ===================================================================== the grid (AC1) */

describe('the photographs render in a grid (AC1)', () => {
  it('renders one tile per photograph, in the order the reader gave them', async () => {
    const photographs = PHOTOGRAPHS();
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs },
    });
    const indices = [...html.matchAll(/data-tile="(\d+)"/g)].map(([, n]) => Number(n));
    expect(indices).toEqual(photographs.map((_, index) => index));
  });

  it('describes every photograph in the page’s own language', async () => {
    for (const locale of LOCALES) {
      const photographs = PHOTOGRAPHS();
      const html = await container.renderToString(Gallery, { props: { locale, photographs } });
      for (const photograph of photographs) {
        expect(html).toContain(`alt="${photograph.image.alt[locale]}"`);
      }
      // And not the other language's, which is what a `localeString` read with a fixed key
      // would produce.
      const other: Locale = locale === 'hr' ? 'en' : 'hr';
      for (const photograph of photographs) {
        expect(html).not.toContain(`alt="${photograph.image.alt[other]}"`);
      }
    }
  });

  it('gives the tile no `aria-label`, so the alt text is its accessible name', async () => {
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs: PHOTOGRAPHS() },
    });
    // An `aria-label` on the anchor would *override* the image's alt, so twelve
    // photographs would announce as twelve identical „Enlarge"s. The name has to come from
    // the picture.
    const tiles = [...html.matchAll(/<a class="tile"[^>]*>/g)].map(([tag]) => tag);
    expect(tiles.length).toBe(GALLERY_RENDERED_IMAGES.length);
    for (const tag of tiles) expect(tag).not.toContain('aria-label');
  });

  it('serves a `srcset` and a matching `sizes`, bounded at 600w', async () => {
    const photographs = PHOTOGRAPHS();
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs },
    });
    expect(html).toContain(`sizes="${GRID_SIZES}"`);

    for (const photograph of photographs) {
      expect(unescaped(html)).toContain(imageSrcSet(photograph.image, GRID_WIDTHS));
    }

    // The ticket's „do not ship a full-resolution original to a phone", read off the
    // markup: no candidate anywhere in the grid is wider than the ladder's top rung.
    const widths = [...html.matchAll(/ (\d+)w[,"]/g)].map(([, n]) => Number(n));
    expect(widths.length).toBeGreaterThan(0);
    expect(Math.max(...widths)).toBeLessThanOrEqual(Math.max(...FULL_WIDTHS));
  });

  it('loads the first row eagerly and the rest lazily (§9 rule 5)', async () => {
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs: PHOTOGRAPHS() },
    });
    const grid = html.slice(html.indexOf('class="grid"'), html.indexOf('<dialog'));
    const loading = [...grid.matchAll(/loading="(\w+)"/g)].map(([, value]) => value);
    expect(loading.slice(0, EAGER_TILES)).toEqual(Array(EAGER_TILES).fill('eager'));
    expect(new Set(loading.slice(EAGER_TILES))).toEqual(new Set(['lazy']));
  });

  it('points `object-position` at the hotspot rather than at the centre', async () => {
    const photographs = PHOTOGRAPHS();
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs },
    });
    // One fixture photograph has a hotspot away from the middle; without it this assertion
    // would pass against a component that hardcoded 50% 50%.
    expect(html).toContain('object-position: 25% 75%');
    const centred = html.match(/object-position: 50% 50%/g) ?? [];
    expect(centred.length).toBeLessThan(photographs.length);
  });

  it('the tile’s href is the photograph, which is what works with scripting off', async () => {
    const photographs = PHOTOGRAPHS();
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs },
    });
    for (const photograph of photographs) {
      // A middle rung rather than the widest: with no script this is what a tap downloads,
      // and the rule about not sending an original to a phone does not stop applying
      // because the visitor has JavaScript disabled.
      expect(unescaped(html)).toContain(
        `href="${imageSrc(photograph.image, { width: FULL_WIDTHS[1]! })}"`,
      );
    }
    expect(FULL_WIDTHS[1]).toBeLessThan(Math.max(...FULL_WIDTHS));
  });
});

/* ================================================================ the lightbox markup */

describe('the lightbox is one dialog holding every photograph', () => {
  it('names itself and starts with every frame hidden', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Gallery, {
        props: { locale, photographs: PHOTOGRAPHS() },
      });
      expect(html).toContain(`aria-label="${GALLERY_COPY[locale].lightbox}"`);

      const frames = [...html.matchAll(/<figure class="frame"[^>]*>/g)].map(([tag]) => tag);
      expect(frames).toHaveLength(GALLERY_RENDERED_IMAGES.length);
      // Every frame hidden at rest is what keeps a closed dialog free: a `loading="lazy"`
      // image in a `display: none` subtree never intersects the viewport and is never
      // fetched. One frame left visible would download a full-size photograph on every
      // visit to the page.
      for (const tag of frames) expect(tag).toContain('hidden');
    }
  });

  it('serves the full-size ladder and 90vw, not the grid’s', async () => {
    const photographs = PHOTOGRAPHS();
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs },
    });
    expect(html).toContain(`sizes="${FULL_SIZES}"`);
    for (const photograph of photographs) {
      expect(unescaped(html)).toContain(imageSrcSet(photograph.image, FULL_WIDTHS));
    }
  });

  it('declares each frame’s own box, so the dialog does not reflow as it loads', async () => {
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs: PHOTOGRAPHS() },
    });
    // The grid's ratio is CSS's (a square frame); the lightbox shows the photograph's own
    // ratio, so there the attributes have to come from the file. 1600×900 fixtures, no
    // manual crop, clamped to the asset by `imageSize`.
    const boxes = [...html.matchAll(/width="(\d+)" height="(\d+)"/g)].map(
      ([, w, h]) => `${w}x${h}`,
    );
    expect(boxes).toHaveLength(GALLERY_RENDERED_IMAGES.length);
    expect(new Set(boxes)).toEqual(new Set(['1600x900']));
  });

  it('renders a caption only where the dataset has one', async () => {
    const photographs = PHOTOGRAPHS();
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs },
    });
    // `[^>]*` because Astro appends its `data-astro-cid-…` scoping attribute to every
    // element it renders, so a regex anchored on `class="caption">` matches nothing.
    const captions = [...html.matchAll(/<figcaption class="caption"[^>]*>([^<]*)</g)].map(
      ([, text]) => text,
    );
    const expected = photographs
      .map((photograph) => photograph.caption?.hr)
      .filter((caption): caption is string => caption !== undefined);

    expect(expected.length).toBeGreaterThan(0);
    expect(expected.length).toBeLessThan(photographs.length);
    expect(captions).toEqual(expected);
  });

  it('keeps the caption out of the grid, which is what the Studio promises Mina', async () => {
    const photographs = PHOTOGRAPHS();
    const html = await container.renderToString(Gallery, {
      props: { locale: 'hr' as Locale, photographs },
    });
    const grid = html.slice(html.indexOf('class="grid"'), html.indexOf('<dialog'));
    for (const photograph of photographs) {
      if (photograph.caption) expect(grid).not.toContain(photograph.caption.hr);
    }
  });

  it('labels its three controls and announces the move', async () => {
    for (const locale of LOCALES) {
      const t = GALLERY_COPY[locale];
      const html = await container.renderToString(Gallery, {
        props: { locale, photographs: PHOTOGRAPHS() },
      });
      for (const label of [t.close, t.previous, t.next]) {
        expect(html).toContain(`aria-label="${label}"`);
      }
      // The counter is a live region: moving by arrow key changes the content of a modal
      // without moving focus, so nothing else would tell a screen-reader user anything
      // happened.
      expect(html).toContain('role="status"');
      expect(html).toContain(galleryPosition(0, GALLERY_RENDERED_IMAGES.length));
      // Every icon is decorative — the button carries the name.
      expect(html).not.toMatch(/<svg(?![^>]*aria-hidden="true")/);
    }
  });
});

/* ============================================= nothing on this page is a code literal */

describe('every photograph’s words come from the dataset (MUSE-50)', () => {
  it('moves when the dataset moves, and leaves nothing behind', async () => {
    /**
     * Comparing a rendering to the fixture it just read asserts nothing: every equality
     * test above passes while a literal in the component still happens to match. So the
     * page is rendered twice against two datasets that share no string, and the first
     * set's words have to appear nowhere in the second rendering.
     *
     * For a gallery the dataset's whole contribution is **alt text and captions**, and alt
     * text is the one that matters: it is the accessible name of every tile, so a literal
     * there is every photograph on the page described as the same thing.
     */
    const before = photographsOf(GALLERY_RENDERED_IMAGES);
    const after = photographsOf(GALLERY_REWRITTEN as FixtureDoc[]);

    for (const locale of LOCALES) {
      const rewritten = await container.renderToString(Gallery, {
        props: { locale, photographs: after },
      });

      for (const photograph of before) {
        expect(rewritten, 'an alt text survived the dataset being rewritten').not.toContain(
          photograph.image.alt[locale],
        );
        if (photograph.caption) {
          expect(rewritten, 'a caption survived the dataset being rewritten').not.toContain(
            photograph.caption[locale],
          );
        }
      }

      for (const photograph of after) {
        expect(rewritten).toContain(photograph.image.alt[locale]);
      }
    }
  });
});

/* ====================================================== alt text is required, in both */

describe('a photograph with no alt text in either locale fails the build', () => {
  it('refuses a half-translated description, naming the field', () => {
    /**
     * §9 rule 3 asks for descriptive alt text on meaningful imagery, and **in a gallery
     * almost nothing is decorative** — there is no decorative image field in this schema at
     * all. So a Croatian-only description is a photograph that is unlabelled for half the
     * audience, and it has to be a failure rather than an empty string.
     *
     * Two instruments, and both already exist: the Studio refuses it while Mina is typing
     * (`imageField`'s `Rule.required()` on `alt`, which `test/sanity.test.ts` asserts for
     * *every* image field anywhere in the schema), and the decoder refuses it at build
     * time. This is the second — asserted against the decoder rather than against a real
     * build, because the decoder *is* the mechanism and `test/content.test.ts` already
     * spends a build proving that a malformed document stops `astro build` by name.
     */
    const half = () => photographsOf([GALLERY_HALF_ALT]);
    expect(half).toThrow(/alt/);
    expect(half).toThrow(/galleryImage/);
    expect(half).toThrow(/gallery-half-alt/);

    const none = () => photographsOf([GALLERY_NO_ALT]);
    expect(none).toThrow(/alt/);
    expect(none).toThrow(/gallery-no-alt/);
  });

  it('accepts a photograph with no caption and no date, which are optional', () => {
    // The other direction, and the one that makes the assertion above mean something: a
    // rule that refused everything would also pass it. `caption` and `takenAt` are
    // deliberately optional — a photograph nobody has a sentence about is an ordinary
    // photograph.
    const minimal = photographsOf([GALLERY_NO_ALT].map(() => GALLERY_RENDERED_IMAGES[3]!));
    expect(minimal[0]!.caption).toBeUndefined();
    expect(minimal[0]!.image.alt.hr).not.toBe('');
  });
});

/* ================================================================== the width ladder */

describe('the width ladder covers the boxes the layout paints', () => {
  it('clamps to the asset, de-duplicates and sorts', () => {
    const [photograph] = photographsOf([GALLERY_CROPPED]);
    // The fixture asset is 1600×900 and the crop takes 80% of its width, so 1280px is all
    // there is: a `2000w` descriptor on a 1280px file is a lie the browser believes.
    const set = imageSrcSet(photograph!.image, [700, 1200, 2000, 4000]);
    const widths = [...set.matchAll(/ (\d+)w/g)].map(([, n]) => Number(n));
    expect(widths).toEqual([700, 1200, 1280]);
    expect(set).toContain('rect=');
  });

  it('refuses an empty width list rather than emitting an empty attribute', () => {
    const [photograph] = photographsOf([GALLERY_CROPPED]);
    expect(() => imageSrcSet(photograph!.image, [])).toThrow(/no widths/);
  });

  it('offers nothing wider than twice the widest box the grid can paint', () => {
    // 290px is the widest tile the grid produces — a 1280px wrap, `--space-7` either side,
    // three 8px gutters, four columns — and it is the number `GRID_SIZES` ends with. The
    // ladder is allowed 2× it for a retina display and no more; the browser measurement
    // below is what proves the `sizes` expression actually selects from it.
    // The *length*, not the media query: `(min-width: 1280px) 290px` has two `px` values
    // and the first one is the breakpoint. A regex that took it would compare 600 against
    // 2560 and pass whatever the ladder said.
    const widest = Number(/\)\s(\d+)px/.exec(GRID_SIZES)![1]);
    expect(widest).toBe(290);
    expect(Math.max(...GRID_WIDTHS)).toBeLessThanOrEqual(widest * 2.1);
    expect(GRID_SIZES.endsWith('46vw')).toBe(true);
  });
});

/* ============================================================== the built page, served */

describe('the built page', () => {
  it('emits the grid’s own stylesheet with four columns at the top breakpoint', async () => {
    const html = await (await fetch(preview.url(GALLERY_ROUTE))).text();
    const hrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map(
      ([, href]) => href,
    );
    const inline = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map(([, css]) => css);
    const linked = await Promise.all(
      hrefs.map(async (href) => (await fetch(new URL(href, preview.origin))).text()),
    );
    const css = [...inline, ...linked].join('\n');

    // §7.4: 2 / 3 / 4 columns, 8px gutters — and `repeat(N, 1fr)` rather than `auto-fit`,
    // which is what stops three photographs stretching across four columns (AC4).
    expect(css).toContain('repeat(2,1fr)');
    expect(css).toContain('repeat(3,1fr)');
    expect(css).toContain('repeat(4,1fr)');
    expect(css).not.toContain('auto-fit');
  });

  it('ships the lightbox as inline script and no file (`test/nojs.test.ts`’s claim)', async () => {
    const html = await (await fetch(preview.url(GALLERY_ROUTE))).text();
    // The whole-output claim is `test/nojs.test.ts`'s. What is asserted here is the half
    // that is this component's: the behaviour is in the document, so there is nothing for a
    // `.js` file to be.
    expect(html).toContain('showModal');
    expect(html).not.toMatch(/<script[^>]+src="[^"]+\.js"/);
  });
});

/* ============================================ the browser: selection, trap, keys, axe */

describe('a phone is not sent a desktop photograph (AC: image pipeline)', () => {
  for (const [label, width, ceiling] of [
    ['390px, two columns', 390, 400],
    ['1280px, four columns', 1280, 600],
  ] as const) {
    it(`at ${label} the engine selects a candidate that fits the box`, async () => {
      const { page, close } = await visit(GALLERY_ROUTE, { width, height: 900 });
      try {
        const measured = await page.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>('.tile img')!;
          return {
            selected: Number(/[?&]w=(\d+)/.exec(image.currentSrc)?.[1] ?? 0),
            painted: Math.round(image.getBoundingClientRect().width),
          };
        });

        // `deviceScaleFactor` is 1 here, so the box and the device pixels are the same
        // number and the selected candidate must be the smallest rung that covers it.
        expect(measured.painted).toBeGreaterThan(0);
        expect(measured.selected).toBeGreaterThanOrEqual(measured.painted);
        expect(measured.selected).toBeLessThanOrEqual(ceiling);
        // The thing the ticket forbids: the top of the ladder on a phone.
        expect(measured.selected).toBeLessThan(Math.max(...FULL_WIDTHS));
      } finally {
        await close();
      }
    });
  }

  it('fetches no full-size photograph while the lightbox is closed', async () => {
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      const requested = await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter((name) => name.includes('cdn.sanity.io')),
      );
      expect(requested.length).toBeGreaterThan(0);
      // Every frame is `hidden`, so no `loading="lazy"` image inside the dialog has a box
      // to intersect the viewport with. A closed lightbox costs nothing.
      for (const url of requested) {
        const width = Number(/[?&]w=(\d+)/.exec(url)?.[1] ?? 0);
        expect(width, `${url} was fetched with the lightbox closed`).toBeLessThanOrEqual(600);
      }
    } finally {
      await close();
    }
  });
});

describe('the lightbox opens, navigates, traps and gives focus back (AC2, AC3)', () => {
  const TILE = 2;
  const total = GALLERY_RENDERED_IMAGES.length;

  it('opens on the photograph that was activated, over a plum-ink scrim', async () => {
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      await page.click(`[data-tile="${TILE}"]`);
      await page.waitForSelector('dialog[data-lightbox][open]');

      const state = await page.evaluate(() => {
        const dialog = document.querySelector<HTMLDialogElement>('dialog[data-lightbox]')!;
        const shown = [...dialog.querySelectorAll<HTMLElement>('[data-frame]')].filter(
          (frame) => !frame.hidden,
        );
        const image = shown[0]!.querySelector('img')!;
        return {
          open: dialog.open,
          frames: shown.map((frame) => frame.dataset.frame),
          counter: dialog.querySelector('[data-count]')!.textContent,
          described: dialog.querySelector('[data-described]')!.textContent,
          alt: image.alt,
          background: getComputedStyle(dialog).backgroundColor,
          // The role token resolved in the dialog's own cascade, so the comparison is
          // „the scrim is `--band-surface` at 96%" rather than a transcribed hex that
          // `npm run ds` would refuse in the component anyway.
          band: (() => {
            const probe = document.createElement('span');
            probe.style.color = 'var(--band-surface)';
            dialog.appendChild(probe);
            const value = getComputedStyle(probe).color;
            probe.remove();
            return value;
          })(),
          wide: image.getBoundingClientRect().width <= window.innerWidth * 0.9 + 1,
          tall: image.getBoundingClientRect().height <= window.innerHeight * 0.85 + 1,
        };
      });

      expect(state.open).toBe(true);
      // Exactly one frame, and it is the one that was activated.
      expect(state.frames).toEqual([String(TILE)]);
      expect(state.counter).toBe(galleryPosition(TILE, total));
      // The hidden half of the live region carries the new photograph's own description:
      // „3 / 7" says where you are and not what you are looking at.
      expect(state.described).toBe(state.alt);
      // §7.4: up to 90vw by 85vh.
      expect(state.wide).toBe(true);
      expect(state.tall).toBe(true);
      /**
       * §7.4: a plum-ink scrim at 96%, in **both** themes.
       *
       * `color-mix()` computes to `color(srgb …)` rather than to `rgba()`, so the channels
       * are parsed out of both values and compared as numbers — and the comparison is
       * against `--band-surface` resolved in the page, which is the role token the design
       * system names for a surface that does not follow the page theme. A transcribed
       * `#1C0217` here would be the same literal `npm run ds` refuses in the component.
       */
      const channels = (value: string) =>
        [...value.matchAll(/[\d.]+/g)].map(([n]) => Number(n));
      const scrim = channels(state.background);
      const band = channels(state.band);
      expect(scrim.slice(0, 3).map((n) => Math.round(n * 255))).toEqual(band.slice(0, 3));
      expect(scrim[3]).toBeCloseTo(0.96, 2);
    } finally {
      await close();
    }
  });

  it('lays out one photograph, and fetches one', async () => {
    /**
     * **`hidden` has to actually hide, and an author `display` quietly beats it.**
     *
     * `[hidden] { display: none }` is a *user-agent* rule, so `.frame { display: grid }`
     * overrode it whatever the specificity — and the symptom was not „the wrong picture is
     * showing", it was a stage 5,002px tall inside a 900px viewport with the photograph
     * that had been asked for 636px above the top of the screen, every frame in the layout
     * and every full-size file fetched the moment the lightbox opened. Found by measuring
     * the boxes rather than by looking, which is why this is a box count and a request
     * count rather than a screenshot.
     *
     * Both halves are asserted, because they fail independently: a frame with no box costs
     * nothing, and a frame with a box costs a photograph.
     */
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      await page.click(`[data-tile="${TILE}"]`);
      await page.waitForSelector('dialog[data-lightbox][open]');
      await page.waitForFunction(() =>
        [...document.querySelectorAll('[data-frame]:not([hidden]) img')].every(
          (image) => (image as HTMLImageElement).complete,
        ),
      );

      const laidOut = await page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>('[data-frame]')].filter(
            (frame) => frame.getClientRects().length > 0,
          ).length,
      );
      expect(laidOut, 'more than one lightbox frame has a layout box').toBe(1);

      /**
       * And the bytes follow — **three photographs, whatever the album size.**
       *
       * The one that is showing, plus the two the script primes so an arrow press paints
       * from cache instead of starting a request. That is a deliberate cost and it is the
       * number to watch: it is a constant, not a fraction of the gallery, so it does not
       * grow with what Mina publishes. Before `.frame[hidden]` was restored it was every
       * photograph in the dataset.
       *
       * The needle is the width: the full-size ladder starts above the grid's top rung, so
       * anything wider than that was fetched for the lightbox and nothing else.
       */
      const full = await page.evaluate(
        (grid: number) =>
          performance
            .getEntriesByType('resource')
            .map((entry) => Number(/[?&]w=(\d+)/.exec(entry.name)?.[1] ?? 0))
            .filter((width) => width > grid),
        Math.max(...GRID_WIDTHS),
      );
      expect(
        full.length,
        `the open lightbox fetched ${full.length} full-size photographs`,
      ).toBe(3);
      expect(full.length, 'the whole album was fetched').toBeLessThan(
        GALLERY_RENDERED_IMAGES.length,
      );
    } finally {
      await close();
    }
  });

  it('keeps focus inside it — the whole document behind is inert', async () => {
    /**
     * This is the criterion the ticket singles out, and the implementation's answer is to
     * not implement it: `showModal()` makes every other element in the document inert by
     * specification, so Tab cycles inside the dialog because there is nowhere else to go.
     *
     * The assertion is therefore about **where focus lands**, not about a handler. Tabbing
     * three times the number of controls proves the cycle rather than the first wrap, and
     * Shift+Tab proves it backwards — a hand-rolled trap that only wrapped forwards is the
     * commonest version of this bug.
     */
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      await page.click(`[data-tile="${TILE}"]`);
      await page.waitForSelector('dialog[data-lightbox][open]');

      /**
       * Where focus is, described rather than judged — so a failure prints the trail.
       *
       * `body` is a legitimate landing and is **not** a leak: Chromium's sequential focus
       * navigation leaves the document for the browser's own chrome between cycles, and
       * `document.activeElement` is `<body>` while it is away. What would be a leak is an
       * element of the page *behind* the dialog, which is what the assertion names.
       */
      const focused = () =>
        page.evaluate(() => {
          const dialog = document.querySelector<HTMLDialogElement>('dialog[data-lightbox]')!;
          const active = document.activeElement;
          if (active === null) return 'null';
          if (dialog.contains(active)) return `dialog:${active.tagName.toLowerCase()}`;
          if (active === document.body) return 'body';
          return `OUTSIDE:${active.tagName.toLowerCase()}.${active.className}`;
        });

      // `showModal` puts focus on the first tabbable child, which is Close.
      expect(await focused()).toMatch(/^dialog:/);

      const trail: string[] = [];
      for (let step = 0; step < 18; step += 1) {
        await page.keyboard.press('Tab');
        trail.push(await focused());
      }
      for (let step = 0; step < 18; step += 1) {
        await page.keyboard.press('Shift+Tab');
        trail.push(await focused());
      }

      // Nothing behind the dialog was ever reachable, in either direction.
      expect(
        trail.filter((where) => where.startsWith('OUTSIDE')),
        `focus left the dialog (trail: ${trail.join(' → ')})`,
      ).toEqual([]);
      // And the cycle comes back in rather than parking outside: a trap that let focus
      // out once and never returned would also have no OUTSIDE landings.
      expect(
        trail.filter((where) => where.startsWith('dialog:')).length,
        `focus never returned to the dialog (trail: ${trail.join(' → ')})`,
      ).toBeGreaterThan(trail.length / 2);
    } finally {
      await close();
    }
  });

  it('makes the page behind it inert, which is what the trap actually is', async () => {
    /**
     * The trap, asserted at the mechanism instead of through the keyboard. A modal
     * `<dialog>` makes every other element in the document inert, so a `.focus()` call on
     * a thumbnail behind it does **nothing** — no handler of ours is involved, there is no
     * index to wrap, and this is the one assertion that distinguishes `showModal()` from
     * `popover="auto"`, which looks modal, reads modal and leaves the page tabbable.
     */
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      await page.click(`[data-tile="${TILE}"]`);
      await page.waitForSelector('dialog[data-lightbox][open]');

      const reachable = await page.evaluate(() => {
        const dialog = document.querySelector<HTMLDialogElement>('dialog[data-lightbox]')!;
        const behind = [
          ...document.querySelectorAll<HTMLElement>('[data-tile], header a, footer a'),
        ].filter((element) => !dialog.contains(element));
        return behind
          .map((element) => {
            element.focus();
            return document.activeElement === element ? element.tagName : null;
          })
          .filter((tag) => tag !== null);
      });

      expect(reachable.length, 'elements behind the open lightbox took focus').toBe(0);
    } finally {
      await close();
    }
  });

  it('navigates with the arrow keys, and wraps at both ends', async () => {
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      await page.click('[data-tile="0"]');
      await page.waitForSelector('dialog[data-lightbox][open]');

      const at = () =>
        page.evaluate(
          () =>
            [...document.querySelectorAll<HTMLElement>('[data-frame]')].find(
              (frame) => !frame.hidden,
            )!.dataset.frame,
        );

      await page.keyboard.press('ArrowRight');
      expect(await at()).toBe('1');
      await page.keyboard.press('ArrowLeft');
      expect(await at()).toBe('0');
      // Off the front: a gallery is a ring, not a list with ends to get stuck on.
      await page.keyboard.press('ArrowLeft');
      expect(await at()).toBe(String(total - 1));
      await page.keyboard.press('ArrowRight');
      expect(await at()).toBe('0');
      await page.keyboard.press('End');
      expect(await at()).toBe(String(total - 1));
      await page.keyboard.press('Home');
      expect(await at()).toBe('0');

      // And the counter follows, because it is the only thing telling a screen reader.
      await page.keyboard.press('ArrowRight');
      expect(await page.textContent('[data-count]')).toBe(galleryPosition(1, total));
    } finally {
      await close();
    }
  });

  it('navigates by pointer too, through the prev/next circles', async () => {
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      await page.click(`[data-tile="${TILE}"]`);
      await page.waitForSelector('dialog[data-lightbox][open]');
      await page.click('[data-next]');
      expect(await page.textContent('[data-count]')).toBe(galleryPosition(TILE + 1, total));
      await page.click('[data-prev]');
      expect(await page.textContent('[data-count]')).toBe(galleryPosition(TILE, total));
    } finally {
      await close();
    }
  });

  it('closes on Escape and returns focus to the thumbnail it opened from', async () => {
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      await page.click(`[data-tile="${TILE}"]`);
      await page.waitForSelector('dialog[data-lightbox][open]');
      // Move away from the photograph that was opened, so „returns to the thumbnail it
      // opened from" is a real claim rather than a coincidence.
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');

      await page.keyboard.press('Escape');
      await page.waitForSelector('dialog[data-lightbox]:not([open])', { state: 'attached' });

      const returned = await page.evaluate(
        () => document.activeElement?.getAttribute('data-tile') ?? null,
      );
      expect(returned).toBe(String(TILE));
    } finally {
      await close();
    }
  });

  it('closes on the close button and on a click outside the photograph', async () => {
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      await page.click(`[data-tile="${TILE}"]`);
      await page.waitForSelector('dialog[data-lightbox][open]');
      await page.click('[data-close]');
      await page.waitForSelector('dialog[data-lightbox]:not([open])', { state: 'attached' });

      await page.click(`[data-tile="${TILE}"]`);
      await page.waitForSelector('dialog[data-lightbox][open]');
      // The scrim: the dialog fills the viewport, so a click near a corner lands on the
      // dialog element and nothing else.
      await page.mouse.click(4, 4);
      await page.waitForSelector('dialog[data-lightbox]:not([open])', { state: 'attached' });
    } finally {
      await close();
    }
  });

  it('opens by keyboard alone, which is how a tile has to be reachable', async () => {
    const { page, close } = await visit(GALLERY_ROUTE);
    try {
      await page.focus('[data-tile="0"]');
      await page.keyboard.press('Enter');
      await page.waitForSelector('dialog[data-lightbox][open]');
      expect(await page.textContent('[data-count]')).toBe(galleryPosition(0, total));
    } finally {
      await close();
    }
  });
});

/* ============================================== axe, with the lightbox open (AC6) */

describe('the open lightbox is axe-clean in both themes (AC6)', () => {
  for (const scheme of ['dark', 'light'] as const) {
    it(`${scheme}: every rule axe enables by default`, async () => {
      /**
       * **`npm run a11y` only sees a page at rest.** It audits `/gallery` and
       * `/en/gallery` closed, in both themes, which is the half that gate can reach; a
       * modal that exists only after a click is invisible to it. That is the gap MUSE-7's
       * QA found with the trial form's error state, and `test/contact.test.ts` is the
       * precedent for closing it here rather than teaching the gate to click things.
       *
       * **No tag filter**, which is MUSE-75's rule: `heading-order` is tagged
       * `best-practice` and a real violation on a live page was invisible for exactly that
       * reason. `contact.test.ts` still filters; that is its ticket's business and not a
       * precedent to copy.
       */
      const { page, close } = await visit(GALLERY_ROUTE, { scheme });
      try {
        await page.click('[data-tile="1"]');
        await page.waitForSelector('dialog[data-lightbox][open]');
        const { violations } = await new AxeBuilder({ page }).analyze();
        expect(violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length} node(s))`)).toEqual(
          [],
        );
      } finally {
        await close();
      }
    });
  }
});

/* ============================================================== 390px, both states */

describe('nothing overflows at 390px (AC7)', () => {
  for (const scheme of ['dark', 'light'] as const) {
    it(`${scheme}: the grid and the open lightbox both fit`, async () => {
      const { page, close } = await visit(GALLERY_ROUTE, { scheme, width: 390, height: 844 });
      try {
        const overflow = () =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          );
        expect(await overflow(), 'the grid overflows 390px').toBeLessThanOrEqual(0);

        await page.click('[data-tile="1"]');
        await page.waitForSelector('dialog[data-lightbox][open]');
        // The lightbox is in the top layer and is 100vw wide, so this is the measurement
        // that catches a photograph, a caption or a control row wider than the phone.
        expect(await overflow(), 'the open lightbox overflows 390px').toBeLessThanOrEqual(0);

        const fits = await page.evaluate(() => {
          const image = document.querySelector<HTMLImageElement>(
            '[data-frame]:not([hidden]) img',
          )!;
          const box = image.getBoundingClientRect();
          return box.left >= -1 && box.right <= window.innerWidth + 1;
        });
        expect(fits).toBe(true);
      } finally {
        await close();
      }
    });
  }
});

/* ===================================================================== the page’s URL */

describe('both locales are served, and the switcher has somewhere to go', () => {
  for (const locale of LOCALES) {
    it(`${locale}: ${pagePath(locale === 'hr' ? GALLERY_ROUTE : `/${locale}${GALLERY_ROUTE}`)} answers 200`, async () => {
      const route = locale === 'hr' ? GALLERY_ROUTE : `/${locale}${GALLERY_ROUTE}`;
      const response = await fetch(preview.url(route));
      expect(response.status).toBe(200);
      const html = await response.text();
      // The deploy host's spelling, not the test server's — the build is configured with
      // `PREVIEW_SITE`, and `pagePath` is the one place the trailing slash is added
      // (MUSE-9). Asserted as the path rather than the whole URL for that reason.
      expect(html).toContain(`<link rel="canonical" href="https://`);
      expect(html).toContain(`${pagePath(route)}">`);
      expect(words(html)).toContain(GALLERY_COPY[locale].heading);
    });
  }
});

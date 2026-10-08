import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  ICON_COLOURS,
  ICON_CROP,
  ICON_DIR,
  ICON_INK,
  ICON_SOURCE,
  ICONS,
  MEASURED_MEAN_ALPHA,
  MIN_STROKE_RATIO,
} from '../src/lib/icon';
import {
  APEX_DEPLOY,
  assetFile,
  assetRefs,
  basePath,
  buildSite,
  PAGES_DEPLOY,
  type Build,
} from './helpers/build';
import {
  alphaChannel,
  COLOUR_TYPE,
  decodeRgba,
  hasTransparencyChunk,
  header,
  inkColours,
  meanAlpha,
} from './helpers/png';

/**
 * **MUSE-40 — the site has an icon, it is the studio's own mark, and it is legible.**
 *
 * Three separate claims, and they fail in three different ways, so they are checked
 * against three different things:
 *
 *   1. **The mark is the artwork.** Asserted against `logo/muse-lockup-white-transparent.png`
 *      itself: the crop that produced the icon is re-measured off the supplied file's alpha
 *      channel every run. If somebody redraws the mark, or re-crops it somewhere else, the
 *      numbers this ticket was argued from stop being true and this suite says so. That
 *      matters more here than it looks: MUSE-40, MUSE-64 and design system §12 all recorded
 *      this mark as *"Missing"* while it sat in the file the whole time, and a repository
 *      that has already shipped an invented schedule (MUSE-36) and an invented `foundedOn`
 *      does not get to assert brand provenance in a comment.
 *
 *   2. **The icons are legible at the size they are for.** Asserted against the committed
 *      PNGs' pixels. This is the ticket's one design judgement — the small sizes carry
 *      more stroke weight than the artwork does, because below about one device pixel of
 *      stroke there is nothing left to antialias — and it is the assertion with no other
 *      symptom. An icon regenerated without it is the right mark, at the right size, in
 *      the right colour, in the right place, and a faint smudge in the tab.
 *
 *   3. **Every icon the page declares is served.** Asserted against `dist`, under both
 *      deploy targets, because a base-path join is what MUSE-8 got wrong and a
 *      root-absolute icon path is *correct* on an apex and a 404 on the Pages sub-path.
 *
 * `test/assets.test.ts` already resolves `rel="icon"` and `rel="apple-touch-icon"` hrefs
 * to files in the output — they were in its `ASSET_RELS` set years before there was an
 * icon to catch. What it cannot do is notice that the tags are *absent*: "every icon
 * reference resolves" is trivially true of a page with no icons, which is exactly the
 * page this ticket started from. The vacuity guard is here.
 */

let pages: Build;
let apex: Build;

beforeAll(async () => {
  pages = buildSite(PAGES_DEPLOY);
  apex = buildSite(APEX_DEPLOY);
}, 240_000);

const TARGETS: [string, () => Build][] = [
  ['Pages sub-path', () => pages],
  ['apex domain', () => apex],
];

/** The committed artwork for one registry entry. */
function iconFile(file: string): Buffer {
  return readFileSync(join(ICON_DIR, file));
}

/** `sizes="32x32"` as a number. Every icon here is square. */
function declaredSize(sizes: string): number {
  const match = /^(\d+)x(\d+)$/.exec(sizes);
  if (match === null) throw new Error(`unreadable sizes="${sizes}"`);
  expect(match[1], `sizes="${sizes}" is not square`).toBe(match[2]);
  return Number(match[1]);
}

/** The tab icons — everything except the opaque iOS tile. */
const TAB_ICONS = ICONS.filter((icon) => icon.rel === 'icon');

/* ------------------------------------------------------------------ *
 * 1. The mark is the supplied artwork, cropped — nothing drawn.
 * ------------------------------------------------------------------ */

describe('MUSE-40: the icon is a crop of the supplied lockup', () => {
  const source = readFileSync(ICON_SOURCE);

  it('the lockup is the 1254×1254 RGBA file every measurement here assumes', () => {
    expect(header(source)).toMatchObject({
      width: 1254,
      height: 1254,
      bitDepth: 8,
      colourType: COLOUR_TYPE.rgba,
    });
  });

  /**
   * The gap the crop is taken at, re-measured rather than quoted.
   *
   * §12 specifies the icon-only mark as *dancer + `M`*, and both sit to the left of the
   * wordmark with nothing between them. "Nothing" is the assertion: a run of columns
   * whose alpha is zero from top to bottom. Cropping there takes the whole mark and no
   * part of the type, which is what makes this a crop rather than a derivation.
   */
  it('has an empty column run between the mark and the wordmark, and crops in it', () => {
    const { header: head, pixels } = decodeRgba(source);

    const inked = (x: number): boolean => {
      for (let y = 0; y < head.height; y += 1) {
        if (pixels[(y * head.width + x) * 4 + 3]! > 0) return true;
      }
      return false;
    };

    // The last column with any ink before the gap, and the first one after it.
    expect(inked(ICON_CROP.right - 1), 'the crop edge cuts through empty space').toBe(true);

    let gap = 0;
    while (!inked(ICON_CROP.right + gap)) gap += 1;

    // Measured 18: columns 640–657 are empty. Asserted as a floor rather than a number,
    // because what the crop needs is clearance, and a wider gap is not a regression.
    expect(
      gap,
      'the dancer+M and the wordmark are not cleanly separable',
    ).toBeGreaterThanOrEqual(12);
  });

  it('crops exactly the ink: nothing clipped, nothing but mark inside', () => {
    const { header: head, pixels } = decodeRgba(source);

    expect(ICON_CROP.right - ICON_CROP.left).toBe(ICON_INK.width);
    expect(ICON_CROP.bottom - ICON_CROP.top).toBe(ICON_INK.height);

    // Every edge of the crop touches ink — so the box is the mark's own bounding box
    // rather than a window somebody centred by eye.
    const anyInk = (xs: [number, number], ys: [number, number]): boolean => {
      for (let y = ys[0]; y < ys[1]; y += 1) {
        for (let x = xs[0]; x < xs[1]; x += 1) {
          if (pixels[(y * head.width + x) * 4 + 3]! > 0) return true;
        }
      }
      return false;
    };

    const { left, top, right, bottom } = ICON_CROP;
    expect(anyInk([left, left + 1], [top, bottom]), 'left edge is padding').toBe(true);
    expect(anyInk([right - 1, right], [top, bottom]), 'right edge is padding').toBe(true);
    expect(anyInk([left, right], [top, top + 1]), 'top edge is padding').toBe(true);
    expect(anyInk([left, right], [bottom - 1, bottom]), 'bottom edge is padding').toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * 2. The committed icons are what the registry says, and legible.
 * ------------------------------------------------------------------ */

describe('MUSE-40: the committed icons', () => {
  it.each(ICONS.map((icon) => [icon.file, icon] as const))(
    '%s is a square PNG of exactly the size it declares',
    (_file, icon) => {
      const head = header(iconFile(icon.file));
      const size = declaredSize(icon.sizes);
      expect({ width: head.width, height: head.height }).toEqual({
        width: size,
        height: size,
      });
    },
  );

  it.each(TAB_ICONS.map((icon) => [icon.file, icon] as const))(
    '%s is drawn in exactly one brand colour',
    (_file, icon) => {
      // One colour, not "mostly one colour": the mark lives entirely in the alpha
      // channel, which is what makes the plum variant a recolour rather than a redraw.
      const expected = icon.file.includes('plum') ? ICON_COLOURS.plum : ICON_COLOURS.white;
      expect([...inkColours(iconFile(icon.file))]).toEqual([expected]);
    },
  );

  /**
   * §12's technique: *RGB replaced, alpha preserved, so antialiased edges still blend.*
   *
   * Byte-identical alpha is that claim stated exactly. It also pins something easier to
   * lose: the two variants are the **same mark**. Regenerate one of them from a different
   * crop, a different dilation or a different resampler and the light and dark tabs show
   * subtly different logos — which nobody sees, because nobody has both at once.
   */
  it.each([16, 32])(
    'the plum and white %spx icons share an alpha channel byte for byte',
    (size) => {
      const plum = alphaChannel(iconFile(`muse-icon-plum-${size}.png`));
      const white = alphaChannel(iconFile(`muse-icon-white-${size}.png`));
      expect(plum.equals(white)).toBe(true);
    },
  );

  /**
   * **The stroke-weight judgement, as a measurement.**
   *
   * Resampling preserves a mean, so an icon made by resizing the plain crop carries the
   * artwork's own mean alpha, scaled by the fraction of the square the portrait mark
   * covers. That number is computed here off the artwork rather than quoted, so the
   * comparison has no constant in it that could be quietly retyped to match a regression.
   */
  it.each(TAB_ICONS.map((icon) => [icon.file, icon] as const))(
    '%s carries materially more ink than the plain crop would',
    (_file, icon) => {
      const size = declaredSize(icon.sizes);
      const { header: head, pixels } = decodeRgba(readFileSync(ICON_SOURCE));

      let total = 0;
      let count = 0;
      for (let y = ICON_CROP.top; y < ICON_CROP.bottom; y += 1) {
        for (let x = ICON_CROP.left; x < ICON_CROP.right; x += 1) {
          total += pixels[(y * head.width + x) * 4 + 3]!;
          count += 1;
        }
      }
      const cropMean = total / count / 255;

      // The mark is portrait, so fitting it to the square's height leaves it narrower
      // than the square — and the mean is diluted by exactly that ratio.
      const markWidth = Math.round((ICON_INK.width * size) / ICON_INK.height);
      const plain = (cropMean * markWidth) / size;

      const actual = meanAlpha(iconFile(icon.file));
      expect(
        actual,
        `${icon.file} inks ${(actual * 100).toFixed(1)}% of its square; the plain crop ` +
          `would ink ${(plain * 100).toFixed(1)}%. This icon was regenerated without the ` +
          `stroke dilation (STROKE_GAIN in src/lib/icon.ts) and is a smudge at true size.`,
      ).toBeGreaterThan(plain * MIN_STROKE_RATIO);
    },
  );

  /** Pinned to the measurement, so "legible" cannot drift in the other direction either. */
  it.each(TAB_ICONS.map((icon) => [icon.file, icon] as const))(
    '%s matches the ink the design decision was made at',
    (_file, icon) => {
      const size = declaredSize(icon.sizes) as 16 | 32;
      expect(meanAlpha(iconFile(icon.file))).toBeCloseTo(MEASURED_MEAN_ALPHA[size], 2);
    },
  );

  /**
   * The iOS tile is opaque, and that is a decision rather than an export default.
   *
   * iOS masks an apple-touch-icon to a rounded rectangle and draws it on the home
   * screen; a transparent one is composited on black by older iOS and on something
   * unpredictable by current iOS. Opaque plum with the white mark is §12's pairing and
   * takes the question away from the operating system.
   */
  it('the apple-touch tile is fully opaque', () => {
    const tile = iconFile('muse-apple-touch.png');
    const head = header(tile);
    expect(
      head.colourType === COLOUR_TYPE.rgb || head.colourType === COLOUR_TYPE.palette,
      `colour type ${head.colourType} carries an alpha channel`,
    ).toBe(true);
    expect(hasTransparencyChunk(tile), 'the tile declares a tRNS chunk').toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Every page declares the set, and the deploy serves all of it.
 * ------------------------------------------------------------------ */

describe('MUSE-40 AC1: every page declares the studio mark, in both colour schemes', () => {
  /** The icon `<link>` tags on one built page, as `rel|sizes|media` plus the href. */
  function iconLinks(build: Build, page: string): { key: string; href: string }[] {
    return [...build.read(page).matchAll(/<link\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /\brel="(icon|apple-touch-icon)"/.test(tag))
      .map((tag) => {
        const get = (name: string): string =>
          new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1] ?? '';
        return {
          key: `${get('rel')}|${get('sizes')}|${get('media')}`,
          href: get('href'),
        };
      });
  }

  const expected = ICONS.map((icon) => `${icon.rel}|${icon.sizes}|${icon.media ?? ''}`);

  for (const [name, build] of TARGETS) {
    it(`declares exactly the registered icon set, on every page (${name})`, () => {
      const target = build();
      const wrong = target
        .htmlFiles()
        .map((page) => ({ page, keys: iconLinks(target, page).map((link) => link.key) }))
        .filter(({ keys }) => keys.join('\n') !== expected.join('\n'))
        .map(({ page, keys }) => `${page}: ${keys.join(', ') || '— no icon tags —'}`);

      expect(
        wrong,
        `every page must declare the five tags in src/lib/icon.ts ICONS, in order`,
      ).toEqual([]);
    });

    /**
     * Both colour schemes, and **different files for each**.
     *
     * The failure this names is not a missing tag — it is two tags pointing at one
     * image. The markup still says it is theme-aware, both hrefs still resolve, the
     * suite above still passes, and half the world gets a mark it cannot see: white on a
     * light tab strip, or plum on a dark one. The supplied artwork is white-only (§12),
     * so collapsing the pair is a one-character edit away at all times.
     */
    it(`serves a different image to each colour scheme (${name})`, () => {
      const target = build();
      const page = target.htmlFiles()[0]!;
      const byScheme = new Map<string, Set<string>>();

      for (const link of iconLinks(target, page)) {
        const [rel, sizes, media] = link.key.split('|');
        if (rel !== 'icon') continue;
        const key = `${sizes} ${media}`;
        byScheme.set(key, (byScheme.get(key) ?? new Set()).add(link.href));
      }

      const schemes = [...byScheme.keys()];
      expect(schemes.some((key) => key.includes('dark'))).toBe(true);
      expect(schemes.some((key) => key.includes('light'))).toBe(true);

      for (const size of ['16x16', '32x32']) {
        const light = [...(byScheme.get(`${size} (prefers-color-scheme: light)`) ?? [])];
        const dark = [...(byScheme.get(`${size} (prefers-color-scheme: dark)`) ?? [])];
        expect(light, `no light-scheme ${size} icon`).toHaveLength(1);
        expect(dark, `no dark-scheme ${size} icon`).toHaveLength(1);
        expect(
          light[0],
          `the ${size} light and dark icons are the same file — one of the two themes ` +
            `is being shown a mark it cannot see (design system §11)`,
        ).not.toBe(dark[0]);
      }
    });

    /**
     * MUSE-8's half: every icon href is under the deploy's base path and names a real
     * file. `test/assets.test.ts` makes the same resolution for every subresource; this
     * states it for the icons specifically, because the failure it guards is silent —
     * a 404ing favicon is a tab with no icon, which is indistinguishable from the tab
     * this ticket started with.
     */
    it(`resolves every icon href under the deploy base to a real file (${name})`, () => {
      const target = build();
      const prefix = basePath(target);

      const broken = target.htmlFiles().flatMap((page) =>
        assetRefs(target.read(page))
          .filter((ref) => /rel="(icon|apple-touch-icon)"/.test(ref.source))
          .flatMap((ref) => {
            if (!ref.url.startsWith(prefix)) {
              return [`${page}: ${ref.url} is not under ${prefix}`];
            }
            const file = assetFile(target, ref.url);
            return file !== undefined && target.isFile(file)
              ? []
              : [`${page}: ${ref.url} resolves to no file in the output`];
          }),
      );

      expect(broken).toEqual([]);
    });

    /** The emitted file is the artwork in `src/assets/icon/`, not some other PNG. */
    it(`emits each registered icon file into the output (${name})`, () => {
      const target = build();
      const emitted = target.allFiles();

      const missing = ICONS.filter((icon) => {
        const stem = icon.file.replace(/\.png$/, '');
        return !emitted.some((f) => f.includes(stem) && f.endsWith('.png'));
      }).map((icon) => icon.file);

      expect(missing).toEqual([]);
    });
  }
});

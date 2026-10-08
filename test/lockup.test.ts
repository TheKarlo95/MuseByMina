import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  ICON_ASPECT,
  ICON_CROP,
  ICON_DIR,
  ICON_INK,
  ICON_MIN_WIDTH,
  ICON_SOURCE,
  iconClearSpace,
  MASTHEAD_DILATION_RADIUS,
  MASTHEAD_MARK_EMITTED,
  MASTHEAD_MARK_FILE,
  MASTHEAD_MARK_HEIGHT,
  MASTHEAD_MEAN_ALPHA,
  MASTHEAD_MIN_STROKE_RATIO,
} from '../src/lib/icon';
import {
  LOCKUP_ASPECT,
  LOCKUP_CAP_HEIGHT_RATIO,
  LOCKUP_EMITTED_WIDTH,
  LOCKUP_MIN_WIDTH,
  lockupClearSpace,
  lockupHeight,
} from '../src/lib/lockup';
import { assetFile, buildSite, PAGES_DEPLOY, type Build } from './helpers/build';
import { decodeRgba, header, inkColours, meanAlpha } from './helpers/png';

/**
 * **MUSE-64 — the brand is the supplied artwork, not two spans that look like it.**
 *
 * Design system §12 lists, under **Do not**, by name: *"rebuild the lockup from separate
 * parts."* The masthead and the footer both did, in Cormorant and Jost positioned by
 * CSS, and the result looks deliberate — which is the whole problem. Nothing renders
 * wrong, no contrast check fails, no page is slow. It is the one §12 rule a reader would
 * never guess was being broken, so a reviewer is not the instrument; this file is.
 *
 * The guard reads the **markup**, not the rendered page, for that reason. There is no
 * property of the output that distinguishes a wordmark set in live type from a logo —
 * the two spans produce perfectly good HTML, and an image produces perfectly good HTML.
 * What distinguishes them is which one the component asked for.
 *
 * ## The exemption is closed (MUSE-67)
 *
 * MUSE-64 left exactly one entry in `REBUILT_FROM_PARTS`, the masthead, with the
 * arithmetic beside it and MUSE-40 named as what would unblock it: §12's minimum for the
 * lockup is 100px wide, the artwork is 1.372:1, so the smallest legible lockup is 73px
 * tall against a 64px band (§7.1) — and 121px with its clear space, which the 80px
 * desktop band does not take either. §12 names the **icon-only mark** for this surface
 * and that artwork did not exist.
 *
 * MUSE-40 shipped it, MUSE-67 put it in the band, and the entry is gone. Both halves of
 * the machine did their job in order and both are still here: the entry was asserted
 * *still live*, so fixing the masthead turned this file red telling the fixer to delete
 * the line, and the scan that found the masthead in the first place still runs over every
 * `.astro` file in the tree. What replaces the exemption is not an empty map and a shrug
 * — it is `the built masthead presents the mark` below, which states what the band carries
 * now, so "no component rebuilds the lockup" cannot be satisfied by a masthead with no
 * brand on it at all.
 */

/* ------------------------------------------------------------ the artwork's geometry */

/**
 * The lockup's parts, as a component that rebuilt it would have to spell them.
 *
 * Matched against an element's **complete** text content, so the needle is the whole of
 * what an element says rather than a substring. „© 2026 Muse by Mina" in the footer's
 * bottom bar is a sentence that contains the brand and is not a lockup; `<span>Muse
 * </span><span>by Mina</span>` is a lockup with a gap in it. The difference is exactly
 * whether the element says only this and nothing else.
 */
const LOCKUP_PARTS = ['Muse', 'by Mina', 'MUSE', 'BY MINA'];

/**
 * **The components allowed to do it anyway. There are none, and that is the state to
 * keep.**
 *
 * Keyed on the path so a second file cannot inherit an exemption by being similar, and
 * every entry is checked twice: the file must still contain the construction (otherwise
 * the entry is stale and must go), and no file outside this map may contain it. MUSE-64
 * registered the masthead here and MUSE-67 deleted it — see the note at the top of this
 * file, and `logo/README.md` for the arithmetic that justified both.
 *
 * An entry added here needs the measurement that forced it and the ticket that removes
 * it, in the string, the way that one did.
 */
const REBUILT_FROM_PARTS: Record<string, string> = {};

/** Every `.astro` file under `src/`, as repo-relative paths. */
function astroSources(): string[] {
  const root = new URL('..', import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : full.endsWith('.astro') ? [full] : [];
    });
  return walk(join(root, 'src'))
    .map((f) => relative(root, f).replace(/\\/g, '/'))
    .sort();
}

/**
 * The half of an `.astro` file Astro ships: everything below the frontmatter fence.
 *
 * Same split as `test/sanity.test.ts`, and for a related reason — a brand string in a
 * frontmatter comment is prose, and this rule is about what the page says.
 */
function markupHalf(source: string): string {
  if (!source.startsWith('---')) return source;
  const close = source.indexOf('\n---', 3);
  return close === -1 ? source : source.slice(close + '\n---'.length);
}

/**
 * Astro comments — `{/* … *␀/}` — blanked out, so prose describing the violation does not
 * read as the violation.
 *
 * `Header.astro`'s exemption note quotes the markup it is apologising for, and a scan
 * that could not tell the two apart would make the honest version of this file fail
 * while a silent one passed. Same lesson as `test/helpers/source-guard.ts`: state the
 * rule against code, never against words.
 */
function withoutComments(markup: string): string {
  return markup
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Elements in `markup` whose entire text content is one of the lockup's parts, as
 * `{ line, text }`.
 *
 * Deliberately not a parser. The shape being looked for is a tag pair with nothing
 * between it but one of four literals, which a regular expression states exactly and a
 * DOM would only state at the cost of a dependency that cannot see `.astro` anyway.
 */
function lockupTextParts(markup: string): { line: number; text: string }[] {
  const found: { line: number; text: string }[] = [];
  const element = /<(\w+)(?:\s[^>]*)?>([^<>{}]*)<\/\1>/g;
  for (const match of markup.matchAll(element)) {
    const text = match[2].trim();
    if (!LOCKUP_PARTS.includes(text)) continue;
    found.push({ line: markup.slice(0, match.index).split('\n').length, text });
  }
  return found;
}

describe('no component rebuilds the lockup from separate parts (§12)', () => {
  const offenders = new Map<string, { line: number; text: string }[]>();

  beforeAll(() => {
    const root = new URL('..', import.meta.url).pathname;
    for (const file of astroSources()) {
      const parts = lockupTextParts(
        withoutComments(markupHalf(readFileSync(join(root, file), 'utf8'))),
      );
      if (parts.length > 0) offenders.set(file, parts);
    }
  });

  it('is looking at the components it thinks it is', () => {
    // A scan that walks nothing passes, which is the shape of green test this repository
    // keeps re-filing. Both ends: there are files, and the two this ticket is about are
    // among them.
    expect(astroSources().length).toBeGreaterThan(10);
    expect(astroSources()).toContain('src/components/Header.astro');
    expect(astroSources()).toContain('src/components/Footer.astro');
  });

  it('holds everywhere except the registered exemptions', () => {
    const unregistered = [...offenders]
      .filter(([file]) => !(file in REBUILT_FROM_PARTS))
      .map(([file, parts]) =>
        parts.map((p) => `${file}:${p.line} renders the lockup part "${p.text}"`).join('\n'),
      );

    expect(
      unregistered.join('\n'),
      'Design system §12 forbids rebuilding the lockup from separate parts. Render ' +
        '`src/components/Lockup.astro` instead, which is the supplied artwork. If this ' +
        'surface genuinely cannot carry it, measure why and add an entry to ' +
        'REBUILT_FROM_PARTS in this file with the reason and the ticket that unblocks it.',
    ).toBe('');
  });

  it('keeps no exemption that has stopped being needed', () => {
    // Vacuous while the map is empty, and kept for the next entry rather than deleted:
    // this is the half that caught MUSE-67. A fixed component with its exemption still
    // registered is a lie that reads as history, and nothing else in the repository can
    // see it. The census below is what carries the claim today.
    for (const [file, reason] of Object.entries(REBUILT_FROM_PARTS)) {
      expect(
        offenders.has(file),
        `${file} is exempted from §12's "do not rebuild the lockup from separate parts" ` +
          `and no longer rebuilds it. Delete the entry from REBUILT_FROM_PARTS. Its ` +
          `reason was: ${reason}`,
      ).toBe(true);
    }
  });

  it('exempts nothing at all, which is the state MUSE-67 left', () => {
    // A census rather than the map's length, and asserted as *empty* rather than merely
    // "small": the last entry was closed by a ticket, so the next one is a decision
    // somebody has to make in a diff rather than by adding a key.
    expect(Object.keys(REBUILT_FROM_PARTS)).toEqual([]);
  });
});

/* ------------------------------ the measurement that decides which mark the band gets */

describe('the masthead has no room for the lockup, and room for the mark', () => {
  /**
   * §7.1: *"Height 64px mobile / 80px desktop."* Restated here because this suite's claim
   * is a comparison between two documents' numbers, and a comparison needs both sides
   * written down. `Header.astro`'s `.inner` is where the site's copy lives.
   */
  const BAND_HEIGHT_MOBILE = 64;
  const BAND_HEIGHT_DESKTOP = 80;

  it('matches the band heights the header actually sets', () => {
    const header = readFileSync(
      new URL('../src/components/Header.astro', import.meta.url),
      'utf8',
    );
    // If the band grows, the arithmetic below changes and the exemption has to be
    // re-argued — so the two numbers are tied together rather than drifting apart.
    expect(header).toContain(`height: ${BAND_HEIGHT_MOBILE}px;`);
    expect(header).toContain(`height: ${BAND_HEIGHT_DESKTOP}px;`);
  });

  it('cannot fit §12’s minimum lockup even without its clear space', () => {
    expect(lockupHeight(LOCKUP_MIN_WIDTH)).toBeGreaterThan(BAND_HEIGHT_MOBILE);
  });

  it('cannot fit it with the clear space at any band width', () => {
    const envelope = lockupHeight(LOCKUP_MIN_WIDTH) + 2 * lockupClearSpace(LOCKUP_MIN_WIDTH);
    expect(envelope).toBeGreaterThan(BAND_HEIGHT_DESKTOP);
  });

  it('refuses to draw the lockup below the minimum rather than clamping it', () => {
    // The failure mode this prevents is a future edit quietly passing 55 to make the
    // masthead fit. A clamp would have rendered it and looked fine in a diff.
    expect(() => lockupClearSpace(LOCKUP_MIN_WIDTH - 1)).toThrow(/§12/);
    expect(() => lockupClearSpace(LOCKUP_MIN_WIDTH)).not.toThrow();
  });

  it('derives the clear space from the drawn size, not from a constant', () => {
    // Two sizes, because a hard-coded padding is right at exactly one of them.
    expect(lockupClearSpace(100)).toBe(24);
    expect(lockupClearSpace(200)).toBe(48);
    expect(LOCKUP_CAP_HEIGHT_RATIO).toBeCloseTo(0.33, 2);
    expect(LOCKUP_ASPECT).toBeCloseTo(1.3746, 4);
  });

  /* ---------------------------------------------------------- and the mark, which does */

  /** The mark as the masthead draws it: height, the width that follows, its clear space. */
  const mark = {
    height: MASTHEAD_MARK_HEIGHT,
    width: Math.round(MASTHEAD_MARK_HEIGHT * ICON_ASPECT),
    clear: iconClearSpace(MASTHEAD_MARK_HEIGHT),
  };

  it('clears §12’s 24px minimum for the icon-only mark', () => {
    // The mark is portrait, so width is its small dimension and the floor binds there.
    expect(mark.width).toBeGreaterThanOrEqual(ICON_MIN_WIDTH);
  });

  it('fits both bands with its clear space on all four sides', () => {
    const envelope = mark.height + 2 * mark.clear;
    expect(envelope).toBeLessThanOrEqual(BAND_HEIGHT_MOBILE);
    expect(envelope).toBeLessThanOrEqual(BAND_HEIGHT_DESKTOP);
    // Stated as a gap rather than only as a ≤, because "fits exactly" is the version of
    // this that a 1px border or a changed padding makes false without anything moving.
    expect(BAND_HEIGHT_MOBILE - envelope).toBeGreaterThanOrEqual(2);
  });

  it('takes its clear space from the same cap height the lockup does', () => {
    // The crop runs the full height of the lockup's ink (256 → 878 is all 622 of it), so
    // a mark drawn H tall *is* the lockup drawn H tall with the type cropped off, and
    // §12's "cap height of MUSE" at that scale is the same fraction. One measurement.
    expect(ICON_CROP.bottom - ICON_CROP.top).toBe(ICON_INK.height);
    expect(iconClearSpace(100)).toBe(Math.round(100 * LOCKUP_CAP_HEIGHT_RATIO));
    expect(iconClearSpace(200)).toBe(2 * iconClearSpace(100));
  });

  it('refuses to draw the mark below §12’s minimum rather than clamping it', () => {
    // `lockupClearSpace`'s rule, for the same reason: the quiet way to make a logo fit a
    // band is to shrink it, and a clamp renders that and looks fine in a diff.
    const tooSmall = Math.floor(ICON_MIN_WIDTH / ICON_ASPECT) - 1;
    expect(() => iconClearSpace(tooSmall)).toThrow(/§12/);
    expect(() => iconClearSpace(MASTHEAD_MARK_HEIGHT)).not.toThrow();
  });

  it('is drawn at the size the header actually sets', () => {
    const header = readFileSync(
      new URL('../src/components/Header.astro', import.meta.url),
      'utf8',
    );
    // Matched as the *unevaluated* source text, which is the point: the assertion is
    // that the header interpolates the constants rather than writing `36px` and `12px`
    // into its CSS, where the arithmetic above could go on being true while the band
    // drew something else entirely.
    expect(header).toContain('--mark-height:${MASTHEAD_MARK_HEIGHT}px');
    expect(header).toContain('--mark-clear:${markClear}px');
  });
});

/* --------------------------------------------------- what the built pages actually do */

/**
 * **One build for the whole file**, at module scope rather than one per `describe`.
 *
 * `buildSite` does not memoise — it is a real `astro build` every call — and `npm test`
 * already runs ten of them across ten parallel workers. An eleventh is not free to the
 * suites that share the runner: `test/localeswitch.test.ts`'s middle-click waits on
 * Chromium opening a background tab, and MUSE-54 measured that class of wait starving
 * under load. The two describes below ask different questions of the same `dist`.
 */
let build: Build;
beforeAll(() => {
  build = buildSite(PAGES_DEPLOY);
}, 240_000);

describe('the built site presents the white lockup', () => {
  /** Every `<img>` tag in `html` whose `src` points at the emitted lockup. */
  function lockupImages(html: string): string[] {
    return [...html.matchAll(/<img\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /muse-lockup-white[^"']*\.webp/.test(tag));
  }

  it('emits exactly one lockup file for the whole site', () => {
    const emitted = build.allFiles().filter((f) => /muse-lockup-white.*\.webp$/.test(f));
    // One file, so the header and the footer could never disagree about the artwork and
    // a visitor pays for it once however many surfaces use it. More than one means a
    // second import got a different transform and the second copy is pure cost — the
    // same failure `test/assets.test.ts` watches for in the fonts.
    expect(emitted).toHaveLength(1);
  });

  it('puts the lockup in the footer of every page', () => {
    for (const page of build.htmlFiles()) {
      const html = build.read(page);
      const footer = html.slice(html.indexOf('<footer'), html.lastIndexOf('</footer>'));
      expect(lockupImages(footer), `${page} footer carries no lockup`).toHaveLength(1);
    }
  });

  it('serves it from a file the deploy really has', () => {
    const images = lockupImages(build.read('index.html'));
    // Named before it is resolved: with no lockup on the page at all, "every reference
    // resolves" is true of the empty set, and this assertion would pass on the build
    // this ticket exists to replace.
    expect(images, 'the homepage carries no lockup to resolve').toHaveLength(1);
    const src = /src="([^"]+)"/.exec(images[0])?.[1] ?? '';
    // Resolved the way the host resolves it, not pattern-matched — MUSE-8's lesson, and
    // the reason a hand-written `public/` path is forbidden (MUSE-35).
    expect(assetFile(build, src), `${src} does not resolve to a file in dist`).not.toBeNull();
  });

  it('names the brand once on the home link, and not twice', () => {
    const html = build.read('index.html');
    const link = /<a class="logo"[\s\S]*?<\/a>/.exec(html)?.[0] ?? '';
    expect(link, 'the masthead home link is gone').not.toBe('');
    // The link owns the accessible name. An `<img>` inside it with a non-empty `alt`
    // would be read after the label on some combinations and before it on others, and
    // the criterion is "exactly once" rather than "at least once".
    expect(link).toContain('aria-label=');
    expect(lockupImages(link)).toHaveLength(0);
  });

  it('gives the footer lockup a name of its own, since nothing else there says it', () => {
    const html = build.read('index.html');
    const footer = html.slice(html.indexOf('<footer'), html.lastIndexOf('</footer>'));
    const img = lockupImages(footer)[0];
    const alt = /alt="([^"]*)"/.exec(img)?.[1] ?? '';
    // Not a link, so there is no ancestor to inherit a name from and no risk of a
    // double announcement — the opposite call from the masthead, for the opposite reason.
    expect(alt).toBe('Muse by Mina');
    expect(footer.slice(0, footer.indexOf(img))).not.toMatch(/<a\b[^>]*>(?![\s\S]*<\/a>)/);
  });

  it('uses one URL in both themes, with no swap and no script', () => {
    const html = build.read('index.html');
    // §12's `.logo-white` / `.logo-plum` utilities are for a logo on `--surface`. The
    // bands are `--surface-deep` in both themes, so a swap here would be two downloads
    // to render the same pixels — and a flash on the theme that loses the race.
    expect(html).not.toContain('<picture');
    expect(html).not.toMatch(/logo-plum|muse-logo-plum|lockup-plum/);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const script of scripts) expect(script).not.toContain('muse-lockup');
  });

  it('reserves the box it will paint in, so the footer does not reflow', () => {
    const img = lockupImages(build.read('index.html'))[0];
    expect(img).toContain(`width="${LOCKUP_EMITTED_WIDTH}"`);
    expect(img).toContain(`height="${lockupHeight(LOCKUP_EMITTED_WIDTH)}"`);
  });

  it('ships no second copy of the source raster', () => {
    // The 1254px original and the two 85 KB pseudo-SVGs live in `logo/`, which is a
    // source directory and not a served one. Anything that reached `dist` got there by
    // being pointed at directly, which is the `public/` mistake MUSE-35 is named after.
    const strays = build
      .allFiles()
      .filter((f) => /lockup/i.test(f) && !/\.webp$/.test(f));
    expect(strays).toEqual([]);
  });
});

/* ------------------------------------------- the mark the masthead carries (MUSE-67) */

describe('the masthead mark is the supplied artwork, thickened for its size', () => {
  /** Memoised — see `cropInk` for why a decode per assertion is not free here. */
  let measured: { ink: Uint8Array; alpha: Uint8Array } | undefined;

  /**
   * The ink mask of the crop, straight off the supplied lockup.
   *
   * Re-measured every run rather than quoted, the way `test/icon.test.ts` re-measures
   * the tab icons: MUSE-36 shipped an invented schedule and MUSE-60 found an invented
   * founding date, so a claim about brand provenance does not get to be a comment.
   *
   * Once per file, though: the supplied lockup is 1254 × 1254, and decoding it per
   * assertion is a megapixel of CPU three times over inside one of ten parallel vitest
   * workers. `test/localeswitch.test.ts`'s middle-click is measurably sensitive to what
   * else is on the runner (MUSE-54, MUSE-61), so a test file's cost is not free.
   */
  function cropInk(): { ink: Uint8Array; alpha: Uint8Array } {
    if (measured !== undefined) return measured;
    const { header: head, pixels } = decodeRgba(readFileSync(ICON_SOURCE));
    const { left, top } = ICON_CROP;
    const ink = new Uint8Array(ICON_INK.width * ICON_INK.height);
    const alpha = new Uint8Array(ink.length);
    for (let y = 0; y < ICON_INK.height; y += 1) {
      for (let x = 0; x < ICON_INK.width; x += 1) {
        const a = pixels[((top + y) * head.width + (left + x)) * 4 + 3]!;
        alpha[y * ICON_INK.width + x] = a;
        ink[y * ICON_INK.width + x] = a > 0 ? 1 : 0;
      }
    }
    measured = { ink, alpha };
    return measured;
  }

  /** A binary mask grown by a disc of radius `r` — the dilation, as a set operation. */
  function dilate(mask: Uint8Array, r: number): Uint8Array {
    const { width: w, height: h } = ICON_INK;
    const out = new Uint8Array(mask.length);
    for (let dy = -r; dy <= r; dy += 1) {
      const dx = Math.floor(Math.sqrt(r * r - dy * dy));
      for (let y = Math.max(0, -dy); y < Math.min(h, h - dy); y += 1) {
        for (let x = 0; x < w; x += 1) {
          if (mask[(y + dy) * w + x] === 0) continue;
          for (let k = Math.max(0, x - dx); k <= Math.min(w - 1, x + dx); k += 1) {
            out[y * w + k] = 1;
          }
        }
      }
    }
    return out;
  }

  const artwork = readFileSync(join(ICON_DIR, MASTHEAD_MARK_FILE));

  it('is the crop, at the crop’s own resolution', () => {
    const head = header(artwork);
    expect({ width: head.width, height: head.height }).toEqual({
      width: ICON_INK.width,
      height: ICON_INK.height,
    });
  });

  it('is drawn in one colour, and it is §12’s white', () => {
    expect([...inkColours(artwork)]).toEqual(['#ffffff']);
  });

  /**
   * **Nothing was drawn and nothing was lost — the file is the crop, thickened.**
   *
   * Two set comparisons rather than a byte-for-byte reproduction of the dilation. A
   * byte test would pin this file to one resampler's rounding and go red on a tool
   * upgrade that changed nothing anybody can see; these two say the thing that actually
   * matters, which is that the committed mark covers the artwork's ink and extends no
   * further from it than the stated radius. A redrawn, traced or re-cropped mark fails
   * one of them, and a mark shipped without the dilation fails the ratio below.
   */
  it('covers every pixel of the artwork’s ink', () => {
    const { ink } = cropInk();
    const { pixels } = decodeRgba(artwork);
    let lost = 0;
    for (let i = 0; i < ink.length; i += 1)
      if (ink[i] === 1 && pixels[i * 4 + 3] === 0) lost += 1;
    expect(lost, `${lost} inked pixels of the crop are blank in ${MASTHEAD_MARK_FILE}`).toBe(0);
  });

  it('adds no ink further from the artwork than the stated radius', () => {
    const grown = dilate(cropInk().ink, MASTHEAD_DILATION_RADIUS);
    const { pixels } = decodeRgba(artwork);
    let invented = 0;
    for (let i = 0; i < grown.length; i += 1) {
      if (pixels[i * 4 + 3]! > 0 && grown[i] === 0) invented += 1;
    }
    expect(
      invented,
      `${invented} pixels of ${MASTHEAD_MARK_FILE} are more than ` +
        `${MASTHEAD_DILATION_RADIUS}px from any ink in ${ICON_SOURCE}. This mark was ` +
        `drawn, traced or cropped somewhere else — see logo/README.md.`,
    ).toBe(0);
  });

  /**
   * **The stroke-weight judgement, as a measurement** — `test/icon.test.ts`'s assertion
   * at this ticket's size. The comparison's other side is computed off the artwork, so
   * there is no constant in it that could be retyped to match a regression.
   */
  it('carries materially more ink than the plain crop would', () => {
    const { alpha } = cropInk();
    let total = 0;
    for (const value of alpha) total += value;
    const plain = total / alpha.length / 255;

    const actual = meanAlpha(artwork);
    expect(
      actual,
      `${MASTHEAD_MARK_FILE} inks ${(actual * 100).toFixed(1)}% of the crop; the plain ` +
        `crop inks ${(plain * 100).toFixed(1)}%. This mark was regenerated without the ` +
        `stroke dilation (MASTHEAD_STROKE_GAIN in src/lib/icon.ts) and is a grey smear ` +
        `at 36px on a 1× display.`,
    ).toBeGreaterThan(plain * MASTHEAD_MIN_STROKE_RATIO);
  });

  it('matches the ink the design decision was made at', () => {
    // The other end: "legible" cannot drift upward into a blob either. At 0.35 CSS px
    // of gain the dancer's head and raised arm merge at 2×, which is the detail the
    // mark exists for.
    expect(meanAlpha(artwork)).toBeCloseTo(MASTHEAD_MEAN_ALPHA, 2);
  });
});

describe('the built masthead presents the mark', () => {
  /** The masthead home link on one built page. */
  function logoLink(page: string): string {
    const link = /<a class="logo"[\s\S]*?<\/a>/.exec(build.read(page))?.[0] ?? '';
    expect(link, `${page} has no masthead home link`).not.toBe('');
    return link;
  }

  /** Every `<img>` in `html` whose `src` points at the emitted mark. */
  function markImages(html: string): string[] {
    return [...html.matchAll(/<img\b[^>]*>/g)]
      .map((m) => m[0])
      .filter((tag) => /muse-mark-white[^"']*\.webp/.test(tag));
  }

  it('puts it in the masthead of every page', () => {
    for (const page of build.htmlFiles()) {
      expect(markImages(logoLink(page)), `${page} masthead carries no mark`).toHaveLength(1);
    }
  });

  it('emits one mark file for the whole site, and serves it', () => {
    const emitted = build.allFiles().filter((f) => /muse-mark-white.*\.webp$/.test(f));
    expect(emitted).toHaveLength(1);
    const src = /src="([^"]+)"/.exec(markImages(logoLink('index.html'))[0]!)?.[1] ?? '';
    expect(assetFile(build, src), `${src} does not resolve to a file in dist`).not.toBeNull();
  });

  it('reserves the box it will paint in, so the band does not reflow', () => {
    const img = markImages(logoLink('index.html'))[0]!;
    expect(img).toContain(`width="${MASTHEAD_MARK_EMITTED.width}"`);
    expect(img).toContain(`height="${MASTHEAD_MARK_EMITTED.height}"`);
  });

  it('leaves the accessible name on the link and not on the image', () => {
    const link = logoLink('index.html');
    // The criterion is "exactly once", not "at least once" (MUSE-64): a non-empty `alt`
    // inside a labelled link is read after the label by some combinations and before it
    // by others, and either way the brand is announced twice.
    expect(link).toContain('aria-label=');
    // Astro emits an empty `alt` as a bare attribute, which is the same thing to a
    // screen reader and is not the same string, so the claim is stated as "has an alt
    // and it says nothing" rather than as a spelling.
    const img = markImages(link)[0]!;
    expect(img).toMatch(/\balt(=""|(?=[\s>]))/);
    expect(img).not.toMatch(/\balt="[^"]+"/);
  });

  it('ships no lockup in the band and no second brand file', () => {
    const link = logoLink('index.html');
    // §12's minimum is the reason — see the measurement above. The failure this names is
    // the quiet one: a lockup scaled into the band renders, passes every other check
    // here, and is illegible.
    expect(link).not.toMatch(/muse-lockup/);
    // And the mark is the mark, not a second PNG that happens to look like it.
    const brand = build.allFiles().filter((f) => /muse-(mark|lockup)/.test(f));
    expect(brand.sort()).toHaveLength(2);
  });

  it('uses one URL in both themes, with no swap and no script', () => {
    const html = build.read('index.html');
    // The band is `--surface-deep` in both themes, so the white mark is right on both.
    // §12's `.logo-white` / `.logo-plum` utilities are for a logo on `--surface`.
    expect(html).not.toMatch(/muse-mark-plum|mark-plum/);
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    for (const script of scripts) expect(script).not.toContain('muse-mark');
  });
});

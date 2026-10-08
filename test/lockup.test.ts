import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  LOCKUP_ASPECT,
  LOCKUP_CAP_HEIGHT_RATIO,
  LOCKUP_EMITTED_WIDTH,
  LOCKUP_MIN_WIDTH,
  lockupClearSpace,
  lockupHeight,
} from '../src/lib/lockup';
import { assetFile, buildSite, PAGES_DEPLOY, type Build } from './helpers/build';

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
 * ## The exemption, and why there is one
 *
 * The masthead is not fixed and is not going to be fixed by this ticket. The arithmetic
 * is in `Header.astro` and in `headroom the masthead does not have` below, which states
 * it as an assertion so that it is re-decided rather than re-assumed: §12's own minimum
 * reproduction size for the lockup is 100px wide, the artwork is 1.372:1, so the
 * smallest legible lockup is 73px tall and the band is 64px (§7.1). §12 names the
 * **icon-only mark** as this surface's variant and that artwork does not exist (MUSE-40).
 *
 * So `REBUILT_FROM_PARTS` holds exactly one entry, with the reason and the blocking
 * ticket beside it, and **the entry is asserted still live** — the pattern
 * `test/contentdrift.test.ts` uses for the same reason. An exemption nobody re-checks is
 * how a stopgap becomes the design. Fix the masthead and this file goes red telling you
 * to delete the line.
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
 * **The one component still allowed to do it, why, and what unblocks it.**
 *
 * Keyed on the path so a second file cannot inherit the exemption by being similar, and
 * every entry is checked twice: the file must still contain the construction (otherwise
 * the entry is stale and must go), and no file outside this map may contain it.
 */
const REBUILT_FROM_PARTS: Record<string, string> = {
  'src/components/Header.astro':
    'The 64px mobile band cannot hold the lockup at §12’s own 100px minimum, which ' +
    'is 73px tall. §12 names the icon-only mark as this surface’s variant and that ' +
    'artwork does not exist — MUSE-40. Delete this entry with that ticket.',
};

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
    for (const [file, reason] of Object.entries(REBUILT_FROM_PARTS)) {
      expect(
        offenders.has(file),
        `${file} is exempted from §12's "do not rebuild the lockup from separate parts" ` +
          `and no longer rebuilds it. Delete the entry from REBUILT_FROM_PARTS. Its ` +
          `reason was: ${reason}`,
      ).toBe(true);
    }
  });

  it('exempts only the masthead, and only while MUSE-40 is open', () => {
    // Pinned as a census rather than left to the map's length: this ticket shipped with
    // exactly one surface unfixed, and a second one appearing is a decision somebody
    // should have to make in a diff rather than by adding a key.
    expect(Object.keys(REBUILT_FROM_PARTS)).toEqual(['src/components/Header.astro']);
    expect(REBUILT_FROM_PARTS['src/components/Header.astro']).toContain('MUSE-40');
  });
});

/* -------------------------------------------- the measurement the exemption rests on */

describe('the masthead has no room for the lockup', () => {
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
});

/* --------------------------------------------------- what the built pages actually do */

describe('the built site presents the white lockup', () => {
  let build: Build;
  beforeAll(() => {
    build = buildSite(PAGES_DEPLOY);
  });

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

import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startPreview, type Preview } from './helpers/preview';
import { seededSchedule } from './helpers/seed';

/**
 * MUSE-14 — numerals set in the display face must be LINING figures.
 *
 * Cormorant Garamond's default figures are old-style: `one` is 386 units tall in
 * a 1000-unit em — exactly x-height — and has no flag and no foot, so it reads as
 * a serifed capital `I`; `zero` sits at x-height too and reads as a small `o`.
 * `19:00` rendered `I9:OO` on the page whose entire job is saying when to turn up.
 *
 * ## Why this suite measures pixels
 *
 * The failure mode of the fix is **not** "the CSS did not apply" — it is "the CSS
 * applied and nothing changed". Three ways that happens:
 *
 *   - the face does not ship `lnum`, so `lining-nums` is a no-op and the
 *     declaration sits there looking correct;
 *   - a component redeclares `font-variant-numeric` (one inherited value, so it
 *     REPLACES rather than adds) and drops `lining-nums` while keeping the column
 *     aligned, which is the state this ticket was filed about;
 *   - the display face is swapped for one whose `lnum` is absent or empty.
 *
 * `getComputedStyle` returns the author's own string in all three. So the central
 * test screenshots the real `<time>` in the real grid and measures where the ink
 * actually **starts**, against the same element with old-style figures forced.
 *
 * Ink *top*, not ink height: old-style `3 4 5 7 9` descend below the baseline, so
 * `19:00` set in text figures is nearly as tall overall as it is in lining ones —
 * height cannot tell them apart and quietly passes. The top edge can: lining
 * figures reach cap height (635/1000 em in this face) and old-style ones stop at
 * x-height (386), a gap of about a quarter of an em that nothing else moves.
 *
 * The control is the same element in the same position with the same colours and
 * the same box, so the comparison survives a change of theme, type size, accent
 * colour or display face — it only asks "are these the tall figures".
 */

/** Device scale for the measurement shots: more rows of pixels per glyph. */
const SCALE = 3;

/**
 * How much higher the ink must start once lining figures are in play, as a
 * fraction of the font size. Cormorant's gap is 0.249 em (cap 635 − x-height
 * 386); 0.12 is comfortably above antialiasing noise and leaves room for a future
 * display face with a shallower cap height.
 */
const MIN_RISE_EM = 0.12;

/**
 * The times the grid's gutter actually shows, read off the CMS seed.
 *
 * It was `['11:00', '19:00', '21:00']` — three of the invented rows (MUSE-36) — which
 * meant the measurement silently stopped happening the moment the real timetable landed:
 * `.gutter time` with the text `11:00` does not exist, so the locator timed out and four
 * cases failed for a reason that had nothing to do with numerals. Derived now, so a
 * schedule edit in the Studio cannot take the only test of MUSE-14 with it.
 *
 * `1` and `0` are the two glyphs the ticket is about — a text-figure `1` reads as `I` and
 * `0` as `o` — so the set is checked for both rather than assumed to contain them.
 */
const TIMES = [...new Set(seededSchedule().map((row) => row.start))].sort();

let browser: Browser;
let preview: Preview;

beforeAll(async () => {
  [preview, browser] = await Promise.all([startPreview('numerals'), chromium.launch()]);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await preview?.close();
});

interface Visit {
  page: Page;
  close(): Promise<void>;
}

async function visit(route: string, colorScheme: 'dark' | 'light'): Promise<Visit> {
  const ctx = await browser.newContext({
    colorScheme,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: SCALE,
  });
  // The homepage language redirect would otherwise take /schedule's visitor away.
  await ctx.addInitScript(() => localStorage.setItem('muse-lang', 'hr'));
  const page = await ctx.newPage();
  await page.goto(preview.url(route), { waitUntil: 'networkidle' });
  // Without this the first shot can catch the fallback face mid-swap.
  await page.evaluate(() => document.fonts.ready);
  return { page, close: () => ctx.close() };
}

/** The `<time>` in the grid gutter whose text is exactly `text`. */
function timeCell(page: Page, text: string) {
  return page.locator('.gutter time', { hasText: new RegExp(`^${text}$`) }).first();
}

interface Ink {
  /** First inked row, measured down from the top of the element's own box. */
  top: number;
  /** Number of inked rows. 0 means the crop found no ink at all. */
  height: number;
}

/**
 * Where the inked pixels sit inside `locator`, in device pixels.
 *
 * Screenshotting the element and decoding it back inside the page is the only way
 * to see the glyphs themselves: layout APIs report the line box, which is the same
 * box whichever figures the shaper picked. Background is sampled from the crop's
 * own top-left corner rather than assumed, so the same measurement works in both
 * themes.
 */
async function inkOf(page: Page, selector: () => ReturnType<typeof timeCell>): Promise<Ink> {
  const el = selector();
  await el.scrollIntoViewIfNeeded();
  const shot = await el.screenshot();
  return page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);

    const at = (i: number) => [data[i], data[i + 1], data[i + 2]] as const;
    const bg = at(0);
    // Generous threshold: the text is gold on plum or plum on cream in this grid,
    // so ink is nowhere near the background and antialiased edges are excluded.
    const inked = (i: number) => {
      const [r, g, b] = at(i);
      return (
        Math.abs(r - bg[0]) + Math.abs(g - bg[1]) + Math.abs(b - bg[2]) > 90
      );
    };

    let top = -1;
    let bottom = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (inked((y * width + x) * 4)) {
          if (top === -1) top = y;
          bottom = y;
          break;
        }
      }
    }
    return top === -1 ? { top: 0, height: 0 } : { top, height: bottom - top + 1 };
  }, `data:image/png;base64,${shot.toString('base64')}`);
}

/**
 * A time as the page renders it, and the same element with old-style figures
 * forced — the control that makes the first measurement mean something — plus the
 * font size both were drawn at.
 */
async function liningVsOldstyle(page: Page, text: string) {
  const lining = await inkOf(page, () => timeCell(page, text));

  await timeCell(page, text).evaluate((el) => {
    (el as HTMLElement).style.fontVariantNumeric = 'oldstyle-nums tabular-nums';
  });
  const oldstyle = await inkOf(page, () => timeCell(page, text));
  await timeCell(page, text).evaluate((el) => {
    (el as HTMLElement).style.fontVariantNumeric = '';
  });

  const fontSize = await timeCell(page, text).evaluate((el) =>
    Number.parseFloat(getComputedStyle(el).fontSize),
  );

  return { lining, oldstyle, fontSize };
}

const CASES = [
  { name: 'hr · dark', route: '/schedule', scheme: 'dark' as const },
  { name: 'hr · light', route: '/schedule', scheme: 'light' as const },
  { name: 'en · dark', route: '/en/schedule', scheme: 'dark' as const },
  { name: 'en · light', route: '/en/schedule', scheme: 'light' as const },
];

describe('a time on /schedule is readable as a number (MUSE-14)', () => {
  it('has a published time carrying both of the glyphs this measures', () => {
    // The guard on the derived set above: a timetable of, say, 18:45 and 22:45 would
    // leave every case below passing without ever drawing a `1` or a `0`.
    expect(TIMES.length, 'the schedule publishes no times at all').toBeGreaterThan(0);
    expect(TIMES.some((time) => time.includes('1')), 'no `1` in any time').toBe(true);
    expect(TIMES.some((time) => time.includes('0')), 'no `0` in any time').toBe(true);
  });

  for (const { name, route, scheme } of CASES) {
    it(`draws cap-height figures — ${name}`, async () => {
      const { page, close } = await visit(route, scheme);
      try {
        for (const text of TIMES) {
          const { lining, oldstyle, fontSize } = await liningVsOldstyle(page, text);
          // Zero ink means the crop found nothing, which is a broken measurement
          // rather than a passing one.
          expect(lining.height, `${text} ink`).toBeGreaterThan(0);
          expect(oldstyle.height, `${text} control ink`).toBeGreaterThan(0);

          const rise = (oldstyle.top - lining.top) / (fontSize * SCALE);
          expect(
            rise,
            `${text}: ink starts at row ${lining.top} as rendered and row ` +
              `${oldstyle.top} with old-style figures forced (${fontSize}px type). ` +
              `The figures are still x-height, so "1" reads as "I" and "0" as "o"`,
          ).toBeGreaterThan(MIN_RISE_EM);
        }
      } finally {
        await close();
      }
    });
  }
});

describe('the rule is the typography layer, not the component', () => {
  it('reaches every place a time is set, in both layouts', async () => {
    const { page, close } = await visit('/schedule', 'dark');
    try {
      // `.slotTime` is the accordion under 768px. It is in the DOM at every width
      // — both layouts are emitted and CSS picks one — so one page covers both.
      const variants = await page.evaluate(() =>
        ['.gutter time', '.slotTime'].map((sel) => {
          const el = document.querySelector(sel);
          if (el === null) throw new Error(`no element matches ${sel}`);
          return { sel, value: getComputedStyle(el).fontVariantNumeric };
        }),
      );
      for (const { sel, value } of variants) {
        expect(value, sel).toContain('lining-nums');
        expect(value, sel).toContain('tabular-nums');
      }
    } finally {
      await close();
    }
  });

  it('applies to a number in the display face that no component asked about', async () => {
    const { page, close } = await visit('/schedule', 'dark');
    try {
      // The point of putting the declaration on the document: MUSE-22 (prices),
      // MUSE-24 (event dates) and the countdown have not been written yet, and
      // must not each rediscover this. A bare element in the display face stands
      // in for all of them.
      const value = await page.evaluate(() => {
        const el = document.createElement('span');
        el.textContent = '25 €';
        el.style.fontFamily = 'var(--font-display)';
        document.body.appendChild(el);
        const v = getComputedStyle(el).fontVariantNumeric;
        el.remove();
        return v;
      });
      expect(value).toContain('lining-nums');
    } finally {
      await close();
    }
  });

  it('keeps the gutter column aligned — tabular figures retained', async () => {
    const { page, close } = await visit('/schedule', 'dark');
    try {
      const boxes = await page.evaluate(() =>
        [...document.querySelectorAll('.gutter time')].map((el) => {
          const r = el.getBoundingClientRect();
          return { text: el.textContent?.trim(), left: Math.round(r.left), width: r.width };
        }),
      );
      expect(boxes.length).toBeGreaterThan(1);
      // Every time in the grid is `HH:MM`, so with tabular figures every cell is
      // the same width — which is what makes the column read as a column.
      const widths = new Set(boxes.map((b) => b.width.toFixed(2)));
      expect([...widths], JSON.stringify(boxes)).toHaveLength(1);
      expect(new Set(boxes.map((b) => b.left)).size).toBe(1);
    } finally {
      await close();
    }
  });

  it('is carried by a face that actually ships the feature', async () => {
    const { page, close } = await visit('/schedule', 'dark');
    try {
      // If the display face has no `lnum` table the declaration is inert and every
      // assertion above would have to be re-derived by eye. Asking the shaper for
      // lining figures must change the advance width of `1`: Cormorant's default
      // `one` is 332/1000 em and `one.lf` is 391.
      const { plain, lining } = await page.evaluate(() => {
        const family = getComputedStyle(
          document.querySelector('.gutter time') as Element,
        ).fontFamily;
        const measure = (variant: string) => {
          const el = document.createElement('span');
          el.textContent = '1';
          el.style.cssText =
            `position:absolute;left:-9999px;top:0;white-space:pre;line-height:1;` +
            `font-size:400px;font-family:${family};font-variant-numeric:${variant}`;
          document.body.appendChild(el);
          const w = el.getBoundingClientRect().width;
          el.remove();
          return w;
        };
        return { plain: measure('normal'), lining: measure('lining-nums') };
      });
      expect(plain).toBeGreaterThan(0);
      expect(
        Math.abs(lining - plain),
        `"1" is ${plain}px wide normally and ${lining}px with lining-nums — the ` +
          `display face does not implement lnum, so the fix is a no-op`,
      ).toBeGreaterThan(1);
    } finally {
      await close();
    }
  });
});

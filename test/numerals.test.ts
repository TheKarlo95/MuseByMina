import type { Browser, Locator, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_LOCALE, LOCALES, type Locale } from '../src/lib/i18n';
import { ROUTES } from '../src/lib/pages';
import { launchChecks, openCheckPage } from '../scripts/browser-checks.mjs';
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
  [preview, browser] = await Promise.all([startPreview('numerals'), launchChecks()]);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await preview?.close();
});

interface Visit {
  page: Page;
  close(): Promise<void>;
}

/**
 * Open `route` at measurement scale, as a visitor of that route's language.
 *
 * Through `scripts/browser-checks.mjs`, which pins the locale the route names and asserts
 * the landing URL (MUSE-48). This suite used to carry its own language-pin line, copied
 * from `scripts/a11y.mjs` — a glyph measured on the wrong language's page is still a
 * glyph, so there is nothing in the numbers that would have said so.
 */
async function visit(route: string, colorScheme: 'dark' | 'light'): Promise<Visit> {
  const { page, close } = await openCheckPage(browser, preview, route, {
    context: {
      colorScheme,
      viewport: { width: 1280, height: 900 },
      deviceScaleFactor: SCALE,
    },
  });
  // Without this the first shot can catch the fallback face mid-swap.
  await page.evaluate(() => document.fonts.ready);
  return { page, close };
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
async function inkOf(page: Page, selector: () => Locator): Promise<Ink> {
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

/**
 * MUSE-57 — a form control is the other kind of text, and the document rule misses it.
 *
 * Everything above measures prose. `input`, `select`, `textarea` and `button` are not
 * prose: the UA stylesheet gives each of them its own `font` **shorthand**, and a
 * shorthand resets every sub-property it does not mention — `font-variant-numeric`
 * included. So the document's `lining-nums tabular-nums` is not overridden on a control,
 * it never arrives. Measured on `/contact` before the fix:
 *
 *     :root     lining-nums tabular-nums
 *     label     lining-nums tabular-nums
 *     select    normal
 *     option    normal
 *     input     normal
 *     textarea  normal
 *     button    normal
 *
 * **This is not MUSE-43 in a different hat.** That was a declaration losing a tie, and
 * the fix was ordering. Nothing about ordering, specificity or `!important` on `:root`
 * reaches an element that does not inherit, so the fix here has to *name the elements*.
 *
 * ## Why this is tested at all, when nothing is visibly wrong
 *
 * No control on the site renders a digit we wrote, and controls are set in Jost/Inter,
 * whose figures are lining already — so the bug draws nothing today. That is exactly the
 * shape of MUSE-14, which survived the life of the project because a fallback font
 * happened to have lining figures. `/pricing` is built and waiting on content (MUSE-22);
 * the day its package `<option>` reads „55 € / mjesec" instead of a tier name, or a CTA
 * reads "Book for 55 €", the digits are inside a control and in the display face at once.
 *
 * ## Why this measures glyphs rather than the computed value
 *
 * Same reason as the suite above, with one more edge: a computed-style assertion would
 * have **passed here all along**. `getComputedStyle(select).fontVariantNumeric` returned
 * an honest `normal` and nothing was asking the question. The sweep below now asks it on
 * every page, but the gate is the measurement — the control as the page renders it,
 * against the same control with old-style figures forced. Before the fix those two are
 * the same picture.
 */

/** Text with both of the glyphs MUSE-14 is about, plus a price — the `/pricing` case. */
const CONTROL_TEXT = '19:00 55 €';

/** The id the probe mounts under. Nothing on the site uses it. */
const PROBE_ID = 'muse57-probe';

/** The elements the UA hands their own `font` shorthand. */
const CONTROLS = ['input', 'select', 'textarea', 'button'] as const;
type Control = (typeof CONTROLS)[number];

/** `/schedule` → `/en/schedule`; `/` → `/en/`. The spelling `openCheckPage` takes. */
function localeRoute(route: string, locale: Locale): string {
  if (locale === DEFAULT_LOCALE) return route;
  return route === '/' ? '/en/' : `/${locale}${route}`;
}

/**
 * Mount one control carrying `CONTROL_TEXT` in the display face, and return its locator.
 *
 * Built in the live page rather than in a fixture, so it is subject to the real cascade
 * — the real `base.css`, the real `@font-face`s, the real theme. A fixture would be
 * testing a copy of the stylesheet rather than the one that ships.
 *
 * The **frame** is stripped (border, padding, and the select's arrow via `appearance`)
 * and the colours pinned to the page's own roles. That is a measurement concern, not a
 * fudge: `inkOf` samples the background from the crop's top-left pixel and takes the
 * topmost inked row anywhere in the crop, so a 1px border would be both the sampled
 * "background" and the highest ink, and the dropdown arrow would out-top the digits.
 * None of `appearance`, `border` or `background` touches the `font` shorthand that
 * causes this bug — with the fix reverted the probe still computes `normal`, and each
 * assertion below prints that computed value beside its measurement to show it.
 */
async function mountControl(page: Page, tag: Control): Promise<Locator> {
  await page.evaluate(
    ({ tag, text, id }) => {
      document.getElementById(id)?.remove();

      const host = document.createElement('div');
      host.id = id;
      host.style.cssText =
        'position:fixed;left:0;top:0;z-index:2147483647;margin:0;padding:0;' +
        'background:var(--surface)';

      let el: HTMLElement;
      if (tag === 'select') {
        const select = document.createElement('select');
        const option = document.createElement('option');
        option.textContent = text;
        select.appendChild(option);
        el = select;
      } else if (tag === 'input') {
        const input = document.createElement('input');
        input.value = text;
        input.size = text.length + 1;
        el = input;
      } else if (tag === 'textarea') {
        const textarea = document.createElement('textarea');
        textarea.rows = 1;
        textarea.cols = text.length + 1;
        textarea.value = text;
        el = textarea;
      } else {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        el = button;
      }

      el.id = `${id}-control`;
      el.style.cssText =
        'appearance:none;-webkit-appearance:none;display:block;' +
        'border:0;padding:0;margin:0;outline:0;resize:none;overflow:hidden;' +
        'background:var(--surface);color:var(--text);' +
        'font-family:var(--font-display);font-size:48px;line-height:1.2';
      host.appendChild(el);
      document.body.appendChild(host);
    },
    { tag, text: CONTROL_TEXT, id: PROBE_ID },
  );
  // A control in the display face is the first thing on this page to want Cormorant at
  // this size; without this the first crop can catch the fallback face.
  await page.evaluate(() => document.fonts.ready);
  return page.locator(`#${PROBE_ID}-control`);
}

/** Tear the probe back down, so one page can carry all four controls in turn. */
function unmountControl(page: Page): Promise<void> {
  return page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, PROBE_ID);
}

/**
 * `/contact` because it is the page that actually has a form, so the probe sits in the
 * cascade a real control sits in. Both themes, and the English page, for the same reason
 * the suite above covers four: the crop samples its own background, and a theme or a
 * locale is the cheapest way for a measurement to be accidentally about something else.
 */
const CONTROL_CASES = [
  { name: 'hr · dark', route: '/contact', scheme: 'dark' as const },
  { name: 'hr · light', route: '/contact', scheme: 'light' as const },
  { name: 'en · dark', route: '/en/contact', scheme: 'dark' as const },
];

describe('a digit inside a form control is a digit too (MUSE-57)', () => {
  for (const { name, route, scheme } of CONTROL_CASES) {
    it(`draws cap-height figures in a control — ${name}`, async () => {
      const { page, close } = await visit(route, scheme);
      try {
        for (const tag of CONTROLS) {
          const control = await mountControl(page, tag);
          const select = () => control;

          const rendered = await control.evaluate(
            (el) => getComputedStyle(el).fontVariantNumeric,
          );
          const fontSize = await control.evaluate((el) =>
            Number.parseFloat(getComputedStyle(el).fontSize),
          );

          const lining = await inkOf(page, select);
          await control.evaluate((el) => {
            (el as HTMLElement).style.fontVariantNumeric = 'oldstyle-nums tabular-nums';
          });
          const oldstyle = await inkOf(page, select);
          await control.evaluate((el) => {
            (el as HTMLElement).style.fontVariantNumeric = '';
          });

          expect(lining.height, `<${tag}> ink`).toBeGreaterThan(0);
          expect(oldstyle.height, `<${tag}> control ink`).toBeGreaterThan(0);

          const rise = (oldstyle.top - lining.top) / (fontSize * SCALE);
          expect(
            rise,
            `<${tag}> computes font-variant-numeric: ${rendered}. Its ink starts at row ` +
              `${lining.top} as the page renders it and row ${oldstyle.top} with ` +
              `old-style figures forced (${fontSize}px type) — the same picture. ` +
              `"${CONTROL_TEXT}" reads as "I9:oo 55 €" inside the control while the ` +
              `prose beside it reads correctly, because the UA font shorthand on a form ` +
              `control resets the document's numerals. src/styles/base.css has to name ` +
              `the element; no ordering or !important on :root can reach it (MUSE-57)`,
          ).toBeGreaterThan(MIN_RISE_EM);

          await unmountControl(page);
        }
      } finally {
        await close();
      }
    }, 120_000);
  }

  it('leaves no control on any page computing something else', async () => {
    // The acceptance criterion in words: *any* input, select, textarea or button on
    // *any* page computes what the document computes. Cheap, and green through the
    // whole of this bug — which is why it is the companion to the measurements above
    // and not the gate.
    const routes = ROUTES.flatMap(({ route }) =>
      LOCALES.map((locale) => localeRoute(route, locale)),
    );
    const offenders: string[] = [];
    let controls = 0;

    for (const route of routes) {
      const { page, close } = await visit(route, 'dark');
      try {
        const found = await page.evaluate(() => {
          // `optgroup` and `option` are in the list because the ticket asks whether they
          // need naming separately. They inherit from the `select` once it is fixed in
          // this engine — but a UA that styles them directly would be a hole, and the
          // question a reader of the rule will have deserves a test rather than a
          // comment.
          const selector = 'input, select, textarea, button, optgroup, option';
          const want = getComputedStyle(document.documentElement).fontVariantNumeric;
          const all = [...document.querySelectorAll(selector)];
          return {
            total: all.length,
            rows: all
              .map((el) => ({
                tag: el.tagName.toLowerCase(),
                value: getComputedStyle(el).fontVariantNumeric,
                text: (el.textContent ?? '').trim().slice(0, 30),
              }))
              .filter((row) => row.value !== want),
          };
        });
        controls += found.total;
        for (const row of found.rows) {
          offenders.push(`${route}  <${row.tag}> "${row.text}" → ${row.value}`);
        }
      } finally {
        await close();
      }
    }

    expect(
      controls,
      'no form control on any page — the sweep measured nothing',
    ).toBeGreaterThan(0);
    expect(
      offenders,
      `a control computes something other than the document's numerals:\n` +
        offenders.join('\n'),
    ).toEqual([]);
  }, 180_000);

  it('reaches the control the UA draws for us, not only the ones in the markup', async () => {
    const { page, close } = await visit('/contact', 'dark');
    try {
      // `::file-selector-button` is a button the UA invents inside `<input type=file>`,
      // and it carries a font shorthand of its own — the same reset one layer down, and
      // naming `input` does not reach it. There is no file input on the site today;
      // that is the argument for closing it here rather than on the day someone adds an
      // upload to the enrolment form. `::placeholder` is checked beside it because it
      // is the case that looks identical and is *not* a hole: it inherits from the
      // input, so fixing the input fixes it, and a future author should not re-add it.
      const probe = await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'file';
        document.body.appendChild(input);
        const value = {
          want: getComputedStyle(document.documentElement).fontVariantNumeric,
          host: getComputedStyle(input).fontVariantNumeric,
          button: getComputedStyle(input, '::file-selector-button').fontVariantNumeric,
          placeholder: getComputedStyle(input, '::placeholder').fontVariantNumeric,
        };
        input.remove();
        return value;
      });
      expect(probe.host, 'input[type=file]').toBe(probe.want);
      expect(probe.button, 'input[type=file]::file-selector-button').toBe(probe.want);
      expect(probe.placeholder, 'input::placeholder').toBe(probe.want);
    } finally {
      await close();
    }
  });
});

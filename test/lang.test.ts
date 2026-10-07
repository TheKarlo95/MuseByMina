import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { LANG_STORAGE_KEY } from '../src/lib/lang';
import { pagePath, startPreview, type Preview } from './helpers/preview';

/**
 * MUSE-10 — the language redirect must carry `#fragment` and `?query` across.
 *
 * Driven in a real browser, not asserted against the generated script string. The whole
 * bug lives in what the *browser* does with the URL the script hands it: a unit test over
 * `langInitScript()` could only check that the source says what we just wrote, and would
 * have passed just as happily before the fix if it had been written to match. The things
 * that actually matter here — that the redirect fires at all for a non-Croatian browser,
 * that the fragment survives `location.replace`, and that the browser then scrolls the
 * trial form into view — are only observable with a document, a viewport and a history
 * stack.
 *
 * `navigator.languages` is what the script reads, and Playwright's context `locale`
 * is the only honest way to set it: overriding the property from an init script would
 * mean testing our stub. So each context below is a browser that genuinely reports the
 * language in question.
 *
 * `location.hash` is never sent to the server, so none of this is visible to the static
 * host or to a fetch-level test — it has to be a browser.
 */

/** The anchor every CTA on the site points at (`src/lib/nav.ts`). */
const TRIAL = '#trial';
const FORM = '[data-trial-form]';

/** A browser that is clearly not Croatian — the only case the redirect fires for. */
const FOREIGN_LOCALE = 'en-US';
const CROATIAN_LOCALE = 'hr-HR';

let browser: Browser;
let preview: Preview;
/** `http://127.0.0.1:<port>` — the preview origin without the deploy base. */
let host: string;

beforeAll(async () => {
  [preview, browser] = await Promise.all([startPreview('lang'), chromium.launch()]);
  host = new URL(preview.origin).origin;
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await preview?.close();
});

/** An absolute URL for a route plus a raw `?query#fragment` suffix. */
function urlFor(route: string, suffix = ''): string {
  return `${host}${pagePath(route)}${suffix}`;
}

interface Visit {
  page: Page;
  close(): Promise<void>;
}

/**
 * Open `url` in a browser reporting `locale`, optionally with a language already stored.
 *
 * `storedLang` is seeded with an init script so it is in `localStorage` *before* the
 * blocking inline script in `<head>` reads it — the same trick `scripts/a11y.mjs` uses
 * to stop the redirect auditing the wrong page.
 */
async function visit(
  url: string,
  opts: { locale: string; storedLang?: string } = { locale: FOREIGN_LOCALE },
): Promise<Visit> {
  const ctx = await browser.newContext({
    locale: opts.locale,
    // Same viewport as the a11y gate, so an "in view" claim here means the same thing there.
    viewport: { width: 1280, height: 900 },
  });
  if (opts.storedLang !== undefined) {
    await ctx.addInitScript(
      ([key, value]) => localStorage.setItem(key, value),
      [LANG_STORAGE_KEY, opts.storedLang] as const,
    );
  }
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await settleScroll(page);
  return { page, close: () => ctx.close() };
}

/**
 * Wait for scrolling to stop, without assuming smooth scrolling is on.
 *
 * The initial pause matters: polling immediately reads the pre-scroll position twice and
 * concludes the page has settled at the top. Same helper shape as `test/contact.test.ts`.
 */
async function settleScroll(page: Page): Promise<void> {
  await page.waitForTimeout(150);
  let last = Number.NaN;
  for (let i = 0; i < 80; i += 1) {
    const y = await page.evaluate(() => Math.round(window.scrollY));
    if (y === last) return;
    last = y;
    await page.waitForTimeout(25);
  }
}

interface Geometry {
  scrollY: number;
  /** Is any part of the element inside the viewport? */
  visible: boolean;
  /** Distance from the top of the viewport to the top of the element. */
  top: number;
}

/** Where `selector` sits relative to the viewport right now. */
function geometryOf(page: Page, selector: string): Promise<Geometry> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el === null) throw new Error(`no element matches ${sel}`);
    const rect = el.getBoundingClientRect();
    return {
      scrollY: Math.round(window.scrollY),
      visible: rect.bottom > 0 && rect.top < window.innerHeight,
      top: Math.round(rect.top),
    };
  }, selector);
}

describe('language redirect — fragment and query survive (MUSE-10)', () => {
  it('lands a non-Croatian browser on /en/#trial with the form in view', async () => {
    const { page, close } = await visit(urlFor('/', TRIAL), { locale: FOREIGN_LOCALE });
    try {
      // The redirect happened at all — otherwise the rest proves nothing.
      expect(new URL(page.url()).pathname).toBe(pagePath('/en'));
      // …and carried the fragment. This is the regression.
      expect(page.url()).toBe(urlFor('/en', TRIAL));

      // The URL is not the acceptance criterion; the form being on screen is.
      const section = await geometryOf(page, TRIAL);
      expect(section.scrollY).toBeGreaterThan(0);
      expect(section.visible).toBe(true);
      // Anchored near the top of the viewport, below the fixed header's scroll-margin
      // (`src/styles/base.css`) rather than level with the window edge.
      expect(section.top).toBeGreaterThanOrEqual(0);
      expect(section.top).toBeLessThan(200);

      // The form itself, not just the section wrapper it lives in.
      const form = await geometryOf(page, FORM);
      expect(form.visible).toBe(true);

      // English page, not a Croatian page at an English URL.
      expect(await page.getAttribute('html', 'lang')).toBe('en');
    } finally {
      await close();
    }
  });

  it('carries a ?query across the redirect, fragment and all', async () => {
    const suffix = `?utm_source=instagram&utm_campaign=trial${TRIAL}`;
    const { page, close } = await visit(urlFor('/', suffix), { locale: FOREIGN_LOCALE });
    try {
      expect(page.url()).toBe(urlFor('/en', suffix));

      const target = new URL(page.url());
      expect(target.searchParams.get('utm_source')).toBe('instagram');
      expect(target.searchParams.get('utm_campaign')).toBe('trial');
      expect(target.hash).toBe(TRIAL);

      expect((await geometryOf(page, FORM)).visible).toBe(true);
    } finally {
      await close();
    }
  });

  it('carries a ?query with no fragment', async () => {
    const { page, close } = await visit(urlFor('/', '?utm_source=qr'), {
      locale: FOREIGN_LOCALE,
    });
    try {
      expect(page.url()).toBe(urlFor('/en', '?utm_source=qr'));
      // No fragment asked for, so no fragment invented and no scrolling.
      expect(new URL(page.url()).hash).toBe('');
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
    } finally {
      await close();
    }
  });

  it('still redirects a bare / with nothing to carry', async () => {
    const { page, close } = await visit(urlFor('/'), { locale: FOREIGN_LOCALE });
    try {
      expect(page.url()).toBe(urlFor('/en'));
    } finally {
      await close();
    }
  });

  it('does not trap Back in a redirect loop', async () => {
    // `location.replace`, not `assign`: the Croatian URL is gone from the stack, so Back
    // cannot return to it and immediately bounce forward again. Measured against the
    // no-redirect case rather than against a hard number, because the stack already
    // holds whatever entries the automation's own first navigation put there.
    const baseline = await visit(urlFor('/', TRIAL), { locale: CROATIAN_LOCALE });
    const redirected = await visit(urlFor('/', TRIAL), { locale: FOREIGN_LOCALE });
    try {
      expect(await redirected.page.evaluate(() => history.length)).toBe(
        await baseline.page.evaluate(() => history.length),
      );

      // And Back genuinely does not return to the page that redirects.
      await redirected.page.goBack({ waitUntil: 'load' }).catch(() => null);
      expect(new URL(redirected.page.url()).pathname).not.toBe(pagePath('/'));
    } finally {
      await Promise.all([baseline.close(), redirected.close()]);
    }
  });
});

describe('language redirect — the guards that must not fire (MUSE-10)', () => {
  it('leaves a Croatian browser on /#trial, scrolled to the form', async () => {
    const { page, close } = await visit(urlFor('/', TRIAL), { locale: CROATIAN_LOCALE });
    try {
      expect(page.url()).toBe(urlFor('/', TRIAL));
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');

      const form = await geometryOf(page, FORM);
      expect(form.scrollY).toBeGreaterThan(0);
      expect(form.visible).toBe(true);
    } finally {
      await close();
    }
  });

  it('leaves a non-Croatian browser alone once a language is stored', async () => {
    for (const storedLang of ['hr', 'en']) {
      const { page, close } = await visit(urlFor('/', TRIAL), {
        locale: FOREIGN_LOCALE,
        storedLang,
      });
      try {
        // A stored choice wins over the browser's preference, whichever way it points —
        // including `en`, where the destination would have been right anyway.
        expect(page.url()).toBe(urlFor('/', TRIAL));
        expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
        expect((await geometryOf(page, FORM)).visible).toBe(true);
      } finally {
        await close();
      }
    }
  });

  it('leaves a non-Croatian browser alone when ?lang= overrides', async () => {
    const suffix = `?lang=hr${TRIAL}`;
    const { page, close } = await visit(urlFor('/', suffix), { locale: FOREIGN_LOCALE });
    try {
      expect(page.url()).toBe(urlFor('/', suffix));
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
      expect((await geometryOf(page, FORM)).visible).toBe(true);
    } finally {
      await close();
    }
  });

  it('never bounces a deep page, fragment or not', async () => {
    // Root route only: `detectLanguage` is passed by `src/pages/index.astro` alone, so a
    // non-Croatian visitor who asked for a specific Croatian page keeps it.
    for (const route of ['/schedule', '/contact']) {
      const { page, close } = await visit(urlFor(route, TRIAL), {
        locale: FOREIGN_LOCALE,
      });
      try {
        expect(new URL(page.url()).pathname).toBe(pagePath(route));
      } finally {
        await close();
      }
    }
  });
});

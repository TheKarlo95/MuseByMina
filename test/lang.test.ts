import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchChecks, openRedirectProbe } from '../scripts/browser-checks.mjs';
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
  [preview, browser] = await Promise.all([startPreview('lang'), launchChecks()]);
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
 * Through `openRedirectProbe` — the one door in `scripts/browser-checks.mjs` that pins no
 * locale and asserts no landing (MUSE-48), because here *where the browser ends up is the
 * thing under test*. Every other suite and every check uses `openCheckPage`, which would
 * pin this suite's subject out of existence. The browser language has to be named rather
 * than defaulted, which is the point: a default is what MUSE-48 is about.
 *
 * `storedLang` is seeded there with an init script, so it is in `localStorage` *before*
 * the blocking inline script in `<head>` reads it, and only when the key is absent — see
 * the note at the probe for why an unconditional write would hide MUSE-33's regression.
 */
async function visit(
  url: string,
  opts: { locale: string; storedLang?: string } = { locale: FOREIGN_LOCALE },
): Promise<Visit> {
  const { page, close } = await openRedirectProbe(browser, {
    navigatorLocale: opts.locale,
    storedLang: opts.storedLang,
    // Same viewport as the a11y gate, so an "in view" claim here means the same thing there.
    context: { viewport: { width: 1280, height: 900 } },
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await settleScroll(page);
  return { page, close };
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

/** The language this browser has stored, or `null`. */
function storedLang(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY);
}

interface Session {
  page: Page;
  /** Navigate, then wait for whatever the inline script did to settle. */
  open(url: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * One browser, kept open across several navigations.
 *
 * MUSE-33's regression is invisible to a single visit: the *first* visit stores a
 * language and the *second* has to obey it. Seeding `localStorage` cannot show it either,
 * because then the seed is doing the storing and the write under test never happens. So
 * this hands back a context the test navigates twice, which is what a visitor does when
 * they follow a shared link today and open the site again tomorrow.
 */
async function session(locale: string): Promise<Session> {
  const { page, close } = await openRedirectProbe(browser, {
    navigatorLocale: locale,
    context: { viewport: { width: 1280, height: 900 } },
  });
  const open = async (url: string): Promise<void> => {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    await settleScroll(page);
  };
  return { page, open, close };
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

  it('leaves a non-Croatian browser alone once Croatian is stored', async () => {
    const { page, close } = await visit(urlFor('/', TRIAL), {
      locale: FOREIGN_LOCALE,
      storedLang: 'hr',
    });
    try {
      // A stored choice wins over the browser's preference. `hr` is the direction where
      // "stay put" is the right outcome; `en` is the other direction and is covered by
      // the MUSE-33 block below, where staying put is the bug.
      expect(page.url()).toBe(urlFor('/', TRIAL));
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
      expect((await geometryOf(page, FORM)).visible).toBe(true);
    } finally {
      await close();
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

/**
 * MUSE-33 — a stored language is an instruction, not a mute button.
 *
 * `lang.ts` opened with `if (localStorage.getItem(KEY)) return;`: the *presence* of a
 * stored value suppressed the redirect and the value itself was never read. So
 * `muse-lang=en` meant "do not redirect to English" — the exact inverse of what it
 * records. It stayed invisible while only a switcher click wrote the key, because staying
 * put happened to be right; MUSE-16 made `?lang=` persist and routed a shared link
 * straight into the backwards branch.
 *
 * Both directions are asserted against a browser preferring the *other* language, which
 * is the only way to tell "obeyed the stored value" apart from "did nothing".
 */
describe('a stored choice is obeyed rather than merely noticed (MUSE-33)', () => {
  it('routes by the stored language and not by the browser, in both directions', async () => {
    for (const [stored, locale, landing, htmlLang] of [
      // The two that matter: a stored choice against a browser preferring the other.
      ['en', CROATIAN_LOCALE, '/en', 'en'],
      ['hr', FOREIGN_LOCALE, '/', 'hr-HR'],
      // And the agreeing pairs, so a fix that simply ignored storage could not pass.
      ['en', FOREIGN_LOCALE, '/en', 'en'],
      ['hr', CROATIAN_LOCALE, '/', 'hr-HR'],
    ] as const) {
      const { page, close } = await visit(urlFor('/', TRIAL), {
        locale,
        storedLang: stored,
      });
      try {
        const where = `stored=${stored} browser=${locale}`;
        expect(new URL(page.url()).pathname, where).toBe(pagePath(landing));
        expect(await page.getAttribute('html', 'lang'), where).toBe(htmlLang);
        // The fragment still survives the hop, and the form is still where it was asked for.
        expect(new URL(page.url()).hash, where).toBe(TRIAL);
        expect((await geometryOf(page, FORM)).visible, where).toBe(true);
      } finally {
        await close();
      }
    }
  });

  it('honours a shared ?lang= link on the next plain visit, both ways', async () => {
    // The reported journey, end to end, in one browser: follow a link someone shared,
    // then come back later to the bare homepage. Before the fix the second visit threw
    // the choice away and language-detected from scratch.
    for (const [requested, landing, htmlLang] of [
      ['en', '/en', 'en'],
      ['hr', '/', 'hr-HR'],
    ] as const) {
      // The browser prefers the *other* language, so detection and the stored choice
      // disagree and only one of them can explain where the visitor ends up.
      const locale = requested === 'en' ? CROATIAN_LOCALE : FOREIGN_LOCALE;
      const visitor = await session(locale);
      try {
        await visitor.open(urlFor('/', `?lang=${requested}`));
        expect(new URL(visitor.page.url()).pathname).toBe(pagePath(landing));
        expect(await storedLang(visitor.page)).toBe(requested);

        // Later, a plain visit — no parameter, nothing but what the browser remembers.
        await visitor.open(urlFor('/'));
        expect(new URL(visitor.page.url()).pathname).toBe(pagePath(landing));
        expect(await visitor.page.getAttribute('html', 'lang')).toBe(htmlLang);
        expect(await storedLang(visitor.page)).toBe(requested);
      } finally {
        await visitor.close();
      }
    }
  });

  it('honours a hand-typed ?lang=EN, and the plain visit after it', async () => {
    // MUSE-39, end to end in one browser. Matching was case-sensitive, so `EN` fell
    // through as unrecognised — correct under the rule that an unusable value is no
    // instruction, but invisible: somebody hand-editing a shared link got no English and
    // no reason why. The second visit is what proves the *write* was folded too: if `EN`
    // had been stored verbatim it would be read back as unrecognised and the browser's
    // Croatian preference would decide instead.
    const visitor = await session(CROATIAN_LOCALE);
    try {
      await visitor.open(urlFor('/', `?lang=EN${TRIAL}`));
      expect(new URL(visitor.page.url()).pathname).toBe(pagePath('/en'));
      expect(await visitor.page.getAttribute('html', 'lang')).toBe('en');
      // Carried, selected, and scrolled to — the fold changes nothing else about the hop.
      expect(new URL(visitor.page.url()).hash).toBe(TRIAL);
      expect((await geometryOf(visitor.page, FORM)).visible).toBe(true);
      // Canonical lowercase, not the spelling that arrived.
      expect(await storedLang(visitor.page)).toBe('en');

      await visitor.open(urlFor('/'));
      expect(new URL(visitor.page.url()).pathname).toBe(pagePath('/en'));
      expect(await storedLang(visitor.page)).toBe('en');
    } finally {
      await visitor.close();
    }
  });

  it('falls back to browser detection for a stored value naming no locale', async () => {
    // A key left by an older build, a typo, or another tab's bug must not strand the
    // visitor: an unusable instruction is no instruction.
    for (const [locale, landing] of [
      [FOREIGN_LOCALE, '/en'],
      [CROATIAN_LOCALE, '/'],
    ] as const) {
      const { page, close } = await visit(urlFor('/'), { locale, storedLang: 'klingon' });
      try {
        expect(new URL(page.url()).pathname, locale).toBe(pagePath(landing));
      } finally {
        await close();
      }
    }
  });

  it('obeys a stored choice spelled in another case, without rewriting it', async () => {
    // MUSE-39. A key left by a hand, by another tab, or by a build predating the fold.
    // Asserted against a browser preferring the other language, which is the only way to
    // tell "obeyed the stored value" apart from "did nothing".
    for (const [stored, locale, landing, htmlLang] of [
      ['EN', CROATIAN_LOCALE, '/en', 'en'],
      ['Hr', FOREIGN_LOCALE, '/', 'hr-HR'],
    ] as const) {
      const { page, close } = await visit(urlFor('/', TRIAL), { locale, storedLang: stored });
      try {
        const where = `stored=${stored} browser=${locale}`;
        expect(new URL(page.url()).pathname, where).toBe(pagePath(landing));
        expect(await page.getAttribute('html', 'lang'), where).toBe(htmlLang);
        // The fragment still survives the hop, same as for a lowercase value.
        expect(new URL(page.url()).hash, where).toBe(TRIAL);
        expect((await geometryOf(page, FORM)).visible, where).toBe(true);
        // Read, not rewritten: the script's one write is the `?lang=` branch, which
        // folds before storing, so nothing uppercase can originate there.
        expect(await storedLang(page), where).toBe(stored);
      } finally {
        await close();
      }
    }
  });

  it('settles after one hop — a stored choice is not a loop', async () => {
    // The destination must not bounce back. `/en/` does not language-detect, and the
    // only redirect this script performs is toward the locale already decided on, so
    // there is nothing left to disagree with once it lands.
    const baseline = await visit(urlFor('/', TRIAL), {
      locale: CROATIAN_LOCALE,
      storedLang: 'hr',
    });
    const redirected = await visit(urlFor('/', TRIAL), {
      locale: CROATIAN_LOCALE,
      storedLang: 'en',
    });
    try {
      expect(await redirected.page.evaluate(() => history.length)).toBe(
        await baseline.page.evaluate(() => history.length),
      );
      await redirected.page.goBack({ waitUntil: 'load' }).catch(() => null);
      expect(new URL(redirected.page.url()).pathname).not.toBe(pagePath('/'));
    } finally {
      await Promise.all([baseline.close(), redirected.close()]);
    }
  });
});

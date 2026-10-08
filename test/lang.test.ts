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

/**
 * MUSE-38 — the page a lost visitor actually meets.
 *
 * GitHub Pages serves one root `404.html` for every unknown path. MUSE-13 gated the locale
 * switcher on `indexable` — correctly, because the switcher is a prefix swap and `/en/404/`
 * is itself a 404 — and the same flag was also gating `langInitScript`, so the error page
 * shipped no language handling of any kind. MUSE-33 then made `?lang=` the strongest
 * routing signal "on every page", which this one page could not honour. Reproduced on the
 * deploy as `nav=en-US /nope/?lang=en → 404 lang=hr-HR switcher=0 stored=null`.
 *
 * Two things have to be true here and they pull in opposite directions: the choice is read
 * and persisted, and **nothing navigates**, because there is nowhere for this page to
 * navigate to. The body is bilingual so that reading and leaving never depended on a
 * script in the first place; the script's only job on this page is to carry the preference
 * forward. Both halves are driven against a real unknown path — `test/helpers/preview.ts`
 * now serves the build's own `404.html` for one, which is what the live host does and what
 * made this reproducible at all.
 */
describe('an unknown path is readable, and keeps the choice (MUSE-38)', () => {
  /** A path the build has no page for — what a stale or mistyped link looks like. */
  const MISSING = '/nope';

  /** The exit link inside a locale's half of the bilingual body. */
  const exitIn = (locale: string): string => `main [lang="${locale}"] a[href]`;

  interface Landing {
    page: Page;
    /** The HTTP status the document itself came back with. */
    status: number;
    close(): Promise<void>;
  }

  /**
   * Land on `url` and keep the response, which `visit` above does not expose.
   *
   * Through `openRedirectProbe` for the same reason the rest of this file uses it: where
   * the browser ends up is the thing under test, so the door that pins a locale and
   * asserts the landing would pin the subject out of existence (MUSE-48). The browser
   * language is named, never defaulted.
   */
  async function land(
    url: string,
    opts: { locale: string; storedLang?: string; javaScript?: boolean } = {
      locale: FOREIGN_LOCALE,
    },
  ): Promise<Landing> {
    const { page, close } = await openRedirectProbe(browser, {
      navigatorLocale: opts.locale,
      storedLang: opts.storedLang,
      context: {
        viewport: { width: 1280, height: 900 },
        ...(opts.javaScript === false ? { javaScriptEnabled: false } : {}),
      },
    });
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    return { page, status: response?.status() ?? 0, close };
  }

  it('serves the real error page for a path that does not exist', async () => {
    // The harness first: if this is a stub body, everything below is measuring nothing.
    const { page, status, close } = await land(urlFor(MISSING));
    try {
      expect(status).toBe(404);
      expect(new URL(page.url()).pathname).toBe(pagePath(MISSING));
      expect(await page.locator('main').count()).toBe(1);
      expect(await page.locator('footer').count()).toBe(1);
    } finally {
      await close();
    }
  });

  it('can be read and left in English by an en-US browser, with nothing stored', async () => {
    // The ticket's first acceptance criterion, with no `?lang=` and no stored value —
    // nothing but a browser that is not Croatian, which is the common case.
    const { page, close } = await land(urlFor(MISSING), { locale: FOREIGN_LOCALE });
    try {
      for (const locale of ['hr', 'en']) {
        expect(
          await page.locator(`main [lang="${locale}"]`).first().isVisible(),
          `the ${locale} half is not visible`,
        ).toBe(true);
      }
      // Readable *and* leavable: the English half's exit is a link to the English site.
      const exit = page.locator(exitIn('en')).first();
      expect(await exit.getAttribute('href')).toBe(pagePath('/en'));
      expect(await exit.isVisible()).toBe(true);

      // And no switcher, which is MUSE-13's constraint and still holds: there is no
      // `/en/404/` for it to point at.
      expect(await page.locator('[data-locale-switch]').count()).toBe(0);
    } finally {
      await close();
    }
  });

  it('reads just as well with JavaScript off', async () => {
    // Why the body is bilingual rather than selected client-side: the page a visitor
    // reaches because something was broken must not depend on a script to be legible.
    const { page, close } = await land(urlFor(MISSING), {
      locale: FOREIGN_LOCALE,
      javaScript: false,
    });
    try {
      for (const locale of ['hr', 'en']) {
        expect(await page.locator(`main [lang="${locale}"]`).first().isVisible()).toBe(true);
      }
      expect(await page.locator(exitIn('en')).first().getAttribute('href')).toBe(
        pagePath('/en'),
      );
    } finally {
      await close();
    }
  });

  it('leaves in English in one click', async () => {
    const { page, close } = await land(urlFor(MISSING), { locale: FOREIGN_LOCALE });
    try {
      await page.locator(exitIn('en')).first().click();
      await page.waitForLoadState('networkidle');
      expect(new URL(page.url()).pathname).toBe(pagePath('/en'));
      expect(await page.getAttribute('html', 'lang')).toBe('en');
    } finally {
      await close();
    }
  });

  it('persists ?lang= rather than discarding it, and does not navigate', async () => {
    // The reported line: `stored=null`. Both locales, because "stored the parameter" and
    // "stored the page's own language" are indistinguishable from the `hr` case alone.
    for (const requested of ['en', 'hr'] as const) {
      const { page, status, close } = await land(urlFor(MISSING, `?lang=${requested}`), {
        locale: FOREIGN_LOCALE,
      });
      try {
        expect(await storedLang(page), requested).toBe(requested);
        // Nowhere to go: a hop would land on a `/en/404/` the host cannot serve.
        expect(new URL(page.url()).pathname, requested).toBe(pagePath(MISSING));
        expect(status, requested).toBe(404);
      } finally {
        await close();
      }
    }
  });

  it('folds the case of a hand-typed ?lang=, here as everywhere', async () => {
    const { page, close } = await land(urlFor(MISSING, '?lang=EN'));
    try {
      expect(await storedLang(page)).toBe('en');
    } finally {
      await close();
    }
  });

  it('stores nothing for a ?lang= naming no locale', async () => {
    const { page, close } = await land(urlFor(MISSING, '?lang=de'));
    try {
      expect(await storedLang(page)).toBeNull();
      expect(new URL(page.url()).pathname).toBe(pagePath(MISSING));
    } finally {
      await close();
    }
  });

  it('carries the choice to the page they go to next', async () => {
    // The half of the bug that outlives the 404: the preference has to reach wherever the
    // visitor goes, which is the whole reason persisting it is not merely cosmetic. One
    // browser, two navigations, and the browser prefers the *other* language each time so
    // that only the stored value can explain the landing.
    for (const [requested, landing] of [
      ['en', '/en'],
      ['hr', '/'],
    ] as const) {
      const locale = requested === 'en' ? CROATIAN_LOCALE : FOREIGN_LOCALE;
      const visitor = await session(locale);
      try {
        await visitor.open(urlFor(MISSING, `?lang=${requested}`));
        expect(new URL(visitor.page.url()).pathname, requested).toBe(pagePath(MISSING));
        expect(await storedLang(visitor.page), requested).toBe(requested);

        await visitor.open(urlFor('/'));
        expect(new URL(visitor.page.url()).pathname, requested).toBe(pagePath(landing));
      } finally {
        await visitor.close();
      }
    }
  });

  it('does not bounce on a stored choice, in either direction', async () => {
    // A stored value is an inference about the visitor, not a request attached to this
    // URL, so it never routes a deep page (`detect` is the homepage's alone) — and here
    // there is no twin to route to even if it did. Read, left alone, not acted on.
    for (const stored of ['en', 'hr'] as const) {
      for (const locale of [FOREIGN_LOCALE, CROATIAN_LOCALE]) {
        const { page, close } = await land(urlFor(MISSING), { locale, storedLang: stored });
        try {
          const where = `stored=${stored} browser=${locale}`;
          expect(new URL(page.url()).pathname, where).toBe(pagePath(MISSING));
          expect(await storedLang(page), where).toBe(stored);
          // Still readable in both languages whatever is stored — the body does not
          // change, which is the point of it being bilingual.
          expect(await page.locator(exitIn('en')).first().isVisible(), where).toBe(true);
          expect(await page.locator(exitIn('hr')).first().isVisible(), where).toBe(true);
        } finally {
          await close();
        }
      }
    }
  });

  it('adds no entry to the history stack, so Back still works', async () => {
    // Nothing navigates here, so the error page must cost a visitor nothing to escape
    // from: Back goes where they came from, not through a replaced URL.
    const baseline = await land(urlFor(MISSING), { locale: CROATIAN_LOCALE });
    const foreign = await land(urlFor(MISSING, '?lang=en'), { locale: FOREIGN_LOCALE });
    try {
      expect(await foreign.page.evaluate(() => history.length)).toBe(
        await baseline.page.evaluate(() => history.length),
      );
    } finally {
      await Promise.all([baseline.close(), foreign.close()]);
    }
  });
});


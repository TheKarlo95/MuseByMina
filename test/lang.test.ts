import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  launchChecks,
  openCheckPage,
  openRedirectProbe,
} from '../scripts/browser-checks.mjs';
import { DEFAULT_LOCALE, LOCALES, type Locale } from '../src/lib/i18n';
import { LANG_PARAM, LANG_STORAGE_KEY } from '../src/lib/lang';
import { ROUTES } from '../src/lib/pages';
import { settleScroll } from './helpers/browser-settle';
import {
  pagePath,
  PREVIEW_BASE,
  startPreview,
  type Preview,
} from './helpers/preview';

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

/**
 * Activate `selector` and wait until the browser has finished moving.
 *
 * The condition, not a clock (MUSE-54). Two facts make this exact rather than a guess:
 * `langInitScript` is a **blocking inline script in `<head>`**, so a document that has
 * reached `readyState === 'complete'` has already decided whether to hop; and
 * `waitForFunction` polls on the page's own `requestAnimationFrame` and re-evaluates in
 * whatever document is current, so a redirect mid-flight is waited out rather than raced.
 * Together they say "the browser has stopped somewhere" — which is what a test reading
 * the landing URL needs, and what a fixed sleep cannot promise on a box running ten
 * builds.
 *
 * The URL has to differ from where the click started, so a click that goes nowhere fails
 * here naming the selector rather than two assertions later as a wrong landing.
 */
async function follow(page: Page, selector: string): Promise<void> {
  const from = page.url();
  await page.locator(selector).first().click();
  try {
    await page.waitForFunction(
      (was) => document.readyState === 'complete' && location.href !== was,
      from,
      { timeout: 20_000 },
    );
  } catch (cause) {
    throw new Error(
      `gave up waiting for ${selector} to settle somewhere other than ${from}`,
      { cause },
    );
  }
  await page.waitForLoadState('networkidle').catch(() => undefined);
}

/**
 * Run `work` over `items`, a few at a time, keeping the input order.
 *
 * The matrix below is eighteen browser contexts whose cases share nothing; serially that
 * is most of this suite's wall clock for assertions that could have run together. Each
 * case already owns its context, so there is nothing to interleave. Same shape as
 * `test/localeswitch.test.ts`'s.
 */
async function inParallel<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      out[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
      // Readable *and* leavable: the English half's exit is a link to the English site,
      // and since MUSE-56 it names the language it leads to rather than only the path.
      const exit = page.locator(exitIn('en')).first();
      expect(await exit.getAttribute('href')).toBe(`${pagePath('/en')}?${LANG_PARAM}=en`);
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
      // Stamped at render time, not on load, so the exit names its language here too
      // (MUSE-56) — see the block at the end of this file for why that matters.
      expect(await page.locator(exitIn('en')).first().getAttribute('href')).toBe(
        `${pagePath('/en')}?${LANG_PARAM}=en`,
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

/**
 * MUSE-56 — the error page's exits have to be links to a *language*, not to a path.
 *
 * MUSE-38 gave the error page two exits, one per locale, each built with
 * `localeUrl('/', l)`. Every one of that ticket's acceptance criteria passes and the pair
 * is still asymmetric, because of where the two hrefs land:
 *
 *   - `/MuseByMina/en/` is the English homepage, which does not `detect` — so the English
 *     exit is immune and lands in English for everybody.
 *   - `/MuseByMina/` is the Croatian homepage, **the one route on the site that does**.
 *     So the Croatian exit handed the visitor straight to browser detection, which then
 *     overruled the click:
 *
 *         nav=en-US stored=null  →  /en/   ← pressed „Početna", got English
 *         nav=de-DE stored=null  →  /en/   ← same
 *         nav=hr-HR stored=en    →  /en/   ← same
 *
 * The cohort that harms is a Croatian reader whose browser is not configured Croatian —
 * a work laptop, a borrowed phone, a default install, which in Zagreb is ordinary. They
 * are shown a bilingual page, they pick the Croatian half, and they are given English.
 * That is MUSE-38's own complaint, re-created by MUSE-38, pointing the other way.
 *
 * The fix is `carryLocation` (`src/lib/lang.ts`), which is where the rule already lived
 * and what the header switcher already does: a link that names its language cannot be
 * reinterpreted. The exits are stamped at render time rather than by a script, because
 * the error page is deliberately legible and leavable with JavaScript off
 * (`src/pages/404.astro`) and a client-side rewrite would make the durability of the
 * exits depend on the one thing that page is written not to depend on.
 *
 * The matrix is written as a single assertion over every combination rather than a case
 * each, so a failure prints the grid the ticket was filed with instead of the first row
 * that broke.
 */
describe("the 404's exits land in the language that was pressed (MUSE-56)", () => {
  /** A path the build has no page for — what a stale or mistyped link looks like. */
  const MISSING = '/nope';

  /** The exit link inside a locale's half of the bilingual body. */
  const exitIn = (locale: Locale): string => `main [lang="${locale}"] a[href]`;

  /** The header CTA: on this page it is the Croatian chrome's link to `/#trial`. */
  const HEADER_CTA = '[data-header] a.cta';

  /** The homepage each locale's exit leads to. */
  const homeOf = (locale: Locale): string => pagePath(locale === 'hr' ? '/' : '/en');

  /**
   * Three browsers: the two the site has a locale for, and one it does not.
   *
   * `de-DE` is the case neither of the others covers. `hr-HR` is Croatian and `en-US` is
   * the mirror, so a fix that merely confused "the browser's language" with "the English
   * locale" would pass on both; a German browser is somebody the site has no page for,
   * who must still be given the language they pressed.
   */
  const BROWSERS = ['en-US', 'hr-HR', 'de-DE'] as const;

  /** `muse-lang` as the visitor arrives: never set, or set on an earlier visit. */
  const STORED = [undefined, 'en', 'hr'] as const;

  interface Pressed {
    navigatorLocale: string;
    storedLang: string | undefined;
    /** The half of the bilingual body whose exit was clicked. */
    pressed: Locale;
  }

  /** What happened, as one line of the ticket's table. */
  function row(
    at: Pressed,
    landed: string,
    htmlLang: string | null,
    stored: string | null,
  ): string {
    return (
      `nav=${at.navigatorLocale} stored=${at.storedLang ?? 'null'} ` +
      `pressed=${at.pressed} → ${landed} lang=${htmlLang} stored=${stored}`
    );
  }

  /**
   * Every combination, in a fixed order so the expected table can be written out.
   *
   * Both exits from each browser and each stored value: 3 × 3 × 2. The English exit is in
   * here because it is the half that already worked, and "must stay true" is an
   * acceptance criterion rather than an assumption — a fix that made the Croatian exit
   * durable by making *both* of them name Croatian would satisfy half this grid.
   */
  const CASES: Pressed[] = BROWSERS.flatMap((navigatorLocale) =>
    STORED.flatMap((storedLang) =>
      LOCALES.map((pressed) => ({ navigatorLocale, storedLang, pressed })),
    ),
  );

  /**
   * Open the error page in a browser of this suite's choosing.
   *
   * Through `openRedirectProbe` like the rest of this file: the subject is where a click
   * takes a browser, so the door that pins a locale and asserts the landing would pin the
   * subject away (MUSE-48). The browser language is named per case, never defaulted —
   * Playwright's own default is `en-US`, which is the first row of the table.
   */
  async function arrive(opts: {
    locale: string;
    storedLang?: string;
    javaScript?: boolean;
  }): Promise<{ page: Page; close(): Promise<void> }> {
    const { page, close } = await openRedirectProbe(browser, {
      navigatorLocale: opts.locale,
      storedLang: opts.storedLang,
      context: {
        // Wide enough that the header is the desktop layout, so the chrome's own links
        // are on screen rather than behind the menu button.
        viewport: { width: 1280, height: 900 },
        ...(opts.javaScript === false ? { javaScriptEnabled: false } : {}),
      },
    });
    await page.goto(urlFor(MISSING), { waitUntil: 'load' });
    return { page, close };
  }

  it('lands in the pressed language from every browser and every stored value', async () => {
    const landed = await inParallel(CASES, 4, async (at) => {
      const { page, close } = await arrive({
        locale: at.navigatorLocale,
        storedLang: at.storedLang,
      });
      try {
        await follow(page, exitIn(at.pressed));
        return row(
          at,
          new URL(page.url()).pathname,
          await page.getAttribute('html', 'lang'),
          await storedLang(page),
        );
      } finally {
        await close();
      }
    });

    // The whole grid, written out. Three facts per row, because each is separately
    // satisfiable: the page that was reached, the language that page declares, and the
    // value left behind for wherever the visitor goes after it.
    expect(landed).toEqual(
      CASES.map((at) =>
        row(at, homeOf(at.pressed), at.pressed === 'hr' ? 'hr-HR' : 'en', at.pressed),
      ),
    );
  });

  it('names the language on the href, so every way of following it is durable', async () => {
    // Not a detail of the fix — it *is* the fix, and it is why the assertion is about the
    // attribute rather than only about a click. Middle-click, "open in new tab" and "copy
    // link address" fire no `click` event, so a link corrected only by a handler is a
    // link corrected for one of the four ways of following it (MUSE-16, MUSE-33).
    const { page, close } = await arrive({ locale: FOREIGN_LOCALE });
    try {
      for (const locale of LOCALES) {
        expect(await page.getAttribute(exitIn(locale), 'href'), `the ${locale} exit`).toBe(
          `${homeOf(locale)}?${LANG_PARAM}=${locale}`,
        );
      }
    } finally {
      await close();
    }
  });

  it('names it in the markup too, so it survives JavaScript being off', async () => {
    // The switcher's `?lang=` is attached on load and deliberately absent from the markup,
    // so a crawler is not offered a second URL for every page on the site
    // (`test/localeswitch.test.ts`). The error page's is the other way round: one page,
    // `noindex`, and a body whose stated reason for being bilingual is that it needs no
    // mechanism. With no script there is no detection to be overruled by either, so this
    // is not what makes a bare href dangerous — it is what makes the fix one token in a
    // template rather than a second mechanism on the page MUSE-38 refused to give one to.
    const { page, close } = await arrive({ locale: FOREIGN_LOCALE, javaScript: false });
    try {
      for (const locale of LOCALES) {
        expect(await page.getAttribute(exitIn(locale), 'href'), locale).toBe(
          `${homeOf(locale)}?${LANG_PARAM}=${locale}`,
        );
      }
    } finally {
      await close();
    }
  });

  /**
   * The Croatian chrome this page also renders — looked at, and deliberately left alone.
   *
   * The header, footer and CTA here are the same components every other page renders, in
   * Croatian, and two of their links (`/` and `/#trial`) land on the one detecting route.
   * Their *exposure* is therefore identical to the Croatian exit's, and they are still not
   * the same thing:
   *
   *   - **They are not a language affordance.** Each is offered once, with no counterpart
   *     in the other language, so following one asserts nothing about language. The two
   *     exits are offered as a pair, one per locale, and it is the pairing that makes a
   *     click a *choice* — which is the thing that may not be overruled.
   *   - **There is no 404-only chrome to change.** Stamping `?lang=hr` on the logo, the
   *     nav and the CTA stamps it on every Croatian page of the site, and that is a
   *     decision about MUSE-10's detection rather than a fix for this defect: it would
   *     freeze an `en-US` visitor who followed a shared Croatian deep link into Croatian
   *     the moment they clicked the logo, which is the cohort MUSE-38 exists for.
   *   - **The fix reaches them anyway, once a choice has been made.** Pressing either exit
   *     stores the language, and a stored choice outranks the browser (MUSE-33), so the
   *     chrome follows the choice from then on. The second test below is that composition.
   *
   * What has to hold either way is MUSE-10: the CTA carries `#trial` across the redirect,
   * in both directions. The *geometry* of the landing — the form on screen below the fixed
   * header — is asserted by the MUSE-10 block above and by `test/localeswitch.test.ts`;
   * the question here is only whether the fragment survived, and into which language.
   */
  it("carries #trial across the chrome's CTA, in both directions", async () => {
    for (const [locale, stored, landing] of [
      // Nothing stored: the browser decides, which is MUSE-10 working as designed.
      [CROATIAN_LOCALE, undefined, '/'],
      [FOREIGN_LOCALE, undefined, '/en'],
      // A stored choice outranks the browser, in the direction that crosses languages.
      [CROATIAN_LOCALE, 'en', '/en'],
      [FOREIGN_LOCALE, 'hr', '/'],
    ] as const) {
      const where = `nav=${locale} stored=${stored ?? 'null'}`;
      const { page, close } = await arrive({ locale, storedLang: stored });
      try {
        expect(await page.getAttribute(HEADER_CTA, 'href'), where).toBe(
          `${pagePath('/')}${TRIAL}`,
        );

        await follow(page, HEADER_CTA);

        const landed = new URL(page.url());
        expect(landed.pathname, where).toBe(pagePath(landing));
        // The regression MUSE-10 exists to prevent, across exactly this redirect.
        expect(landed.hash, where).toBe(TRIAL);
        // And the fragment names something on the page it reached, in that language.
        expect(await page.locator(TRIAL).count(), where).toBe(1);
        expect(await page.locator(FORM).count(), where).toBe(1);
      } finally {
        await close();
      }
    }
  });

  it('lets a pressed exit govern the chrome from then on, fragment included', async () => {
    // The composition, and the reason the chrome needs no change of its own: one browser,
    // two dead links. An `en-US` visitor presses „Početna", which stores `hr`, and the
    // Croatian CTA they meet on the next stale URL is no longer reinterpreted.
    const { page, close } = await arrive({ locale: FOREIGN_LOCALE });
    try {
      await follow(page, exitIn('hr'));
      expect(new URL(page.url()).pathname).toBe(pagePath('/'));
      expect(await storedLang(page)).toBe('hr');

      await page.goto(urlFor(MISSING), { waitUntil: 'load' });
      await follow(page, HEADER_CTA);

      const landed = new URL(page.url());
      expect(landed.pathname).toBe(pagePath('/'));
      expect(landed.hash).toBe(TRIAL);
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
    } finally {
      await close();
    }
  });
});

/**
 * MUSE-56's class, rather than its instance.
 *
 * One token fixes the error page. The thing worth keeping is the rule, because this is the
 * **second** time a bare homepage href has been reinterpreted: MUSE-33 found it on the
 * switcher's middle-clicked link, MUSE-56 found it on the error page's Croatian exit, and
 * both times the href looked like an ordinary link to `/`.
 *
 * So the invariant is stated about markup rather than about either page:
 *
 *   **A link the page has marked with a language of its own — a `lang` attribute on the
 *   anchor or on an ancestor below `<html>`, or an `hreflang` on the anchor — is the page
 *   offering that destination *as* that language. Its href must name the language,
 *   `?lang=` and all.**
 *
 * That definition is what makes this a rule and not a list of two pages. It catches both
 * affordances the site has, for opposite reasons: the switcher's entry carries `lang` and
 * `hreflang` on the `<a>` itself, and the error page's exits sit inside the `lang`-marked
 * halves of its bilingual body. It catches the Croatian exit in particular, which is the
 * case a *cross-locale* rule cannot see — `/` from a document declaring `hr-HR` crosses
 * nothing, and is precisely the href that was reinterpreted.
 *
 * It is read **from the DOM, in a browser**, not out of the built HTML. The switcher's
 * `?lang=` is attached on load and deliberately absent from the markup so a crawler is not
 * offered a second URL for every page on the site; the error page's is stamped at render
 * time, because that page must work with no script at all. The one level both are true at
 * is the href the browser would actually navigate to — which is also the level MUSE-33 is
 * about, since middle-click and "copy link address" read that attribute and fire no
 * handler.
 *
 * The census is asserted as well as the rule. A guard that finds no affordances passes,
 * and would keep passing while an affordance quietly stopped being marked — so the count
 * is pinned per page: one on every ordinary page (the switcher's other-locale entry; the
 * entry for the locale being read is not a link at all, MUSE-39) and two on the error page.
 */
describe('a language affordance names its language (MUSE-33, MUSE-56)', () => {
  /** Every page the build serves, plus a dead path, which is how the 404 is reached. */
  const SWEPT: string[] = [
    ...ROUTES.flatMap(({ route }) => [route, `/en${route === '/' ? '' : route}`]),
    '/nope',
  ];

  /** How many marked links each swept page is expected to carry. */
  const expected = (route: string): number => (route === '/nope' ? 2 : 1);

  /** One link the page has marked with a language, as the browser sees it. */
  interface Affordance {
    /** The language the page marked it with, folded. */
    marked: string;
    /** The `href` attribute verbatim — what "copy link address" would hand over. */
    href: string;
    /** Its resolved path, which is what names the destination's locale. */
    pathname: string;
    /** `?lang=` on the resolved href, or `null` when the link names no language. */
    requested: string | null;
    /** The link's text, so a failure can be read without opening the page. */
    text: string;
  }

  /**
   * Every marked link on the page, read out of the live DOM.
   *
   * `closest('[lang]')` walks anchor-upward, so the nearest marking wins — and
   * `documentElement` is excluded, because every page declares a language there and a rule
   * that counted it would demand `?lang=` on every link the site has.
   */
  function affordances(page: Page, locales: readonly string[]): Promise<Affordance[]> {
    return page.evaluate((known) => {
      const named = (value: string | null | undefined): string | null =>
        typeof value === 'string' && known.includes(value.toLowerCase())
          ? value.toLowerCase()
          : null;

      return [...document.querySelectorAll('a[href]')].flatMap((a) => {
        const nearest = a.closest('[lang]');
        const inherited =
          nearest === null || nearest === document.documentElement
            ? null
            : named(nearest.getAttribute('lang'));
        const marked = named(a.getAttribute('hreflang')) ?? inherited;
        if (marked === null) return [];

        const resolved = new URL((a as HTMLAnchorElement).href, location.href);
        if (resolved.origin !== location.origin) return [];
        return [
          {
            marked,
            href: a.getAttribute('href') ?? '',
            pathname: resolved.pathname,
            requested: resolved.searchParams.get('lang'),
            text: (a.textContent ?? '').trim().slice(0, 40),
          },
        ];
      });
    }, [...locales]);
  }

  /** The locale a built path leads to: `/MuseByMina/en/schedule/` → `en`. */
  function destinationOf(pathname: string): Locale {
    const first = pathname.slice(PREVIEW_BASE.length).split('/').filter(Boolean)[0];
    return LOCALES.find((locale) => locale === first) ?? DEFAULT_LOCALE;
  }

  it('holds for every marked link on every page the site serves', async () => {
    for (const route of SWEPT) {
      // `openCheckPage` here, not the probe: this sweep *measures* pages, so it must come
      // through the door that asserts it measured the page it asked for (MUSE-48). Asking
      // for `/en/schedule` is how it asks for the English one.
      const open = await openCheckPage(browser, preview, route);
      try {
        const marked = await affordances(open.page, LOCALES);

        expect(
          marked.length,
          `${route} carries ${marked.length} marked links: ${JSON.stringify(marked)}`,
        ).toBe(expected(route));

        for (const link of marked) {
          const where = `${route} → ${link.href} (marked ${link.marked}, "${link.text}")`;
          // The rule: the href names a language.
          expect(link.requested, `${where} does not name its language`).not.toBeNull();
          // …the one the page offered it as…
          expect(link.requested, `${where} names the wrong language`).toBe(link.marked);
          // …and the one the path actually leads to, so the two cannot disagree.
          expect(destinationOf(link.pathname), `${where} leads somewhere else`).toBe(
            link.marked,
          );
        }
      } finally {
        await open.close();
      }
    }
  });

  it('finds the error page’s two exits and an ordinary page’s one switch', async () => {
    // The census as a readable list rather than only as a count, so the shape of what is
    // being guarded is in the suite: two exits on the error page, one switch everywhere
    // else, and nothing else on the site marked with a language at all.
    const missing = await openCheckPage(browser, preview, '/nope');
    try {
      const marked = await affordances(missing.page, LOCALES);
      expect(marked.map((link) => `${link.marked} → ${link.href}`).sort()).toEqual([
        `en → ${pagePath('/en')}?${LANG_PARAM}=en`,
        `hr → ${pagePath('/')}?${LANG_PARAM}=hr`,
      ]);
    } finally {
      await missing.close();
    }

    const home = await openCheckPage(browser, preview, '/');
    try {
      const marked = await affordances(home.page, LOCALES);
      expect(marked.map((link) => `${link.marked} → ${link.href}`)).toEqual([
        `en → ${pagePath('/en')}?${LANG_PARAM}=en`,
      ]);
    } finally {
      await home.close();
    }
  });
});


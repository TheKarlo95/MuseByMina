import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Locale } from '../src/lib/i18n';
import { LANG_PARAM, LANG_STORAGE_KEY } from '../src/lib/lang';
import { pagePath, startPreview, type Preview } from './helpers/preview';

/**
 * MUSE-16 — the manual locale switcher must carry `#fragment` and `?query` across, and
 * `?lang=` must actually select a language.
 *
 * Driven in a real browser for the same reason `test/lang.test.ts` is: the bug lives in
 * what the *browser* does with the URL, and none of it is visible to the static host.
 * `location.hash` is never sent to the server, and the href the switcher ships is rewritten
 * client-side after load — a unit test over the generated string would only assert that we
 * wrote what we just wrote, and the acceptance criterion is not a URL at all. It is that
 * the destination is *scrolled to the equivalent anchor*, which needs a document, a
 * viewport and a fixed header to mean anything.
 *
 * "Scrolled to it" is measured against the header, not against zero. MUSE-10's suite
 * asserted only `top >= 0`, which would have passed with the anchor sitting underneath the
 * fixed header — visible to `getBoundingClientRect`, invisible to a human. Here the target
 * has to clear `[data-header]`'s own measured bottom edge.
 */

/** The anchor every CTA on the site points at (`src/lib/nav.ts`). */
const TRIAL = '#trial';
const FORM = '[data-trial-form]';
const HEADER = '[data-header]';
/** The CTA in the header, which is a same-document link to `#trial` on the home pages. */
const CTA = '[data-header] a.cta';

const FOREIGN_LOCALE = 'en-US';
const CROATIAN_LOCALE = 'hr-HR';

/** A locale switch link, by the locale it switches *to*. */
const switchTo = (locale: Locale): string => `[data-locale-switch] a[data-locale="${locale}"]`;

let browser: Browser;
let preview: Preview;
/** `http://127.0.0.1:<port>` — the preview origin without the deploy base. */
let host: string;

beforeAll(async () => {
  [preview, browser] = await Promise.all([
    startPreview('localeswitch'),
    chromium.launch(),
  ]);
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
 * blocking inline script in `<head>` reads it.
 *
 * The seed only writes when the key is absent. An init script runs again on every
 * navigation, including the one the redirect performs, so an unconditional write would
 * reinstate the old value on the destination page and hide the fact that the page we came
 * from had just replaced it.
 */
async function visit(
  url: string,
  opts: { locale: string; storedLang?: string } = { locale: FOREIGN_LOCALE },
): Promise<Visit> {
  const ctx = await browser.newContext({
    locale: opts.locale,
    // Same viewport as the a11y gate, and wide enough that the header is the desktop
    // layout with the locale switch on screen rather than behind the menu button.
    viewport: { width: 1280, height: 900 },
  });
  if (opts.storedLang !== undefined) {
    await ctx.addInitScript(
      ([key, value]) => {
        if (localStorage.getItem(key!) === null) localStorage.setItem(key!, value!);
      },
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
 * concludes the page has settled at the top. Same helper shape as `test/lang.test.ts`.
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

/**
 * Click `selector` and wait for whatever navigation it causes to settle.
 *
 * Covers both kinds: a locale switch is a document navigation, the header CTA to `#trial`
 * is a same-document hash change. Waiting on `load` would hang on the second, so this
 * waits for the URL to change and then for scrolling to stop.
 */
async function clickAndSettle(page: Page, selector: string): Promise<void> {
  const before = page.url();
  await page.locator(selector).click();
  try {
    await page.waitForFunction((was) => location.href !== was, before, { timeout: 10_000 });
  } catch (cause) {
    // A locale switch that redirects straight back to where it started looks exactly like
    // this: the click lands, the navigation happens, and the URL is unchanged.
    throw new Error(
      `clicking ${selector} left the URL at ${before} — it went nowhere, or bounced back`,
      { cause },
    );
  }
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await settleScroll(page);
}

interface Geometry {
  scrollY: number;
  /** Is any part of the element inside the viewport? */
  visible: boolean;
  /** Distance from the top of the viewport to the top of the element. */
  top: number;
  /** Bottom edge of the fixed header, in the same coordinate space. */
  headerBottom: number;
}

/**
 * Where `selector` sits relative to the viewport and to the fixed header, right now.
 *
 * Throws rather than returning a sentinel when nothing matches: the ids happen to be
 * byte-identical between `/` and `/en/` today, but the test must assert the equivalent
 * anchor *resolves* rather than trust that it always will.
 */
function geometryOf(page: Page, selector: string): Promise<Geometry> {
  return page.evaluate(
    ([sel, headerSel]) => {
      const el = document.querySelector(sel!);
      if (el === null) throw new Error(`no element matches ${sel}`);
      const header = document.querySelector(headerSel!);
      const rect = el.getBoundingClientRect();
      return {
        scrollY: Math.round(window.scrollY),
        visible: rect.bottom > 0 && rect.top < window.innerHeight,
        top: Math.round(rect.top),
        headerBottom: header === null ? 0 : Math.round(header.getBoundingClientRect().bottom),
      };
    },
    [selector, HEADER] as const,
  );
}

/**
 * Assert `selector` is anchored where a visitor would call "scrolled to it".
 *
 * Four separate claims, because each of them passes on its own while the page is visibly
 * wrong: the page scrolled at all, the element is in the viewport, it is *below the fixed
 * header* rather than tucked under it, and it is at the top of the viewport rather than
 * merely somewhere on screen. The header check is the one MUSE-10's suite lacked — it
 * asserted `top >= 0`, which a target hidden behind the header satisfies.
 */
async function expectAnchoredAt(page: Page, selector: string): Promise<void> {
  const target = await geometryOf(page, selector);
  expect(target.scrollY).toBeGreaterThan(0);
  expect(target.visible).toBe(true);
  // A header that measured zero would make the clearance check vacuous.
  expect(target.headerBottom).toBeGreaterThan(0);
  // `:target { scroll-margin-top }` in `src/styles/base.css` is what buys this.
  expect(target.top).toBeGreaterThanOrEqual(target.headerBottom);
  expect(target.top).toBeLessThan(200);
}

/**
 * Assert `selector` is on screen on a scrolled page.
 *
 * For the form itself rather than the anchor: `#trial` is the section, and the form sits
 * a few hundred pixels into it, so "at the top of the viewport" is the wrong claim about
 * it. "The visitor can see the form they scrolled down for" is the right one.
 */
async function expectInView(page: Page, selector: string): Promise<void> {
  const target = await geometryOf(page, selector);
  expect(target.scrollY).toBeGreaterThan(0);
  expect(target.visible).toBe(true);
  expect(target.top).toBeGreaterThanOrEqual(target.headerBottom);
}

/** The language this browser has stored, or `null`. */
function storedLang(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY);
}

/** The `href` attribute the switcher currently advertises for `locale`. */
function switchHref(page: Page, locale: Locale): Promise<string | null> {
  return page.getAttribute(switchTo(locale), 'href');
}

describe('locale switch — the fragment survives (MUSE-16)', () => {
  it('switches /en/#trial to the Croatian form, scrolled to it', async () => {
    // The exact journey MUSE-10's QA reproduced: routed to English, scrolled to the form,
    // then switched to Croatian — and landed at the top of the page.
    const { page, close } = await visit(urlFor('/en', TRIAL), { locale: FOREIGN_LOCALE });
    try {
      await expectInView(page, FORM);

      await clickAndSettle(page, switchTo('hr'));

      expect(page.url()).toBe(urlFor('/', TRIAL));
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
      // The equivalent anchor resolved on the destination, and the destination is at it.
      await expectAnchoredAt(page, TRIAL);
      await expectInView(page, FORM);
    } finally {
      await close();
    }
  });

  it('switches /#trial to the English form, scrolled to it', async () => {
    const { page, close } = await visit(urlFor('/', TRIAL), { locale: CROATIAN_LOCALE });
    try {
      await clickAndSettle(page, switchTo('en'));

      expect(page.url()).toBe(urlFor('/en', TRIAL));
      expect(await page.getAttribute('html', 'lang')).toBe('en');
      await expectAnchoredAt(page, TRIAL);
      await expectInView(page, FORM);
    } finally {
      await close();
    }
  });

  it('carries a fragment picked up after load, not just one that was in the URL', async () => {
    // The href is rendered without a fragment, so a switcher that only patched hrefs at
    // build or first paint would drop this one: the visitor arrived at `/en/`, clicked the
    // header CTA to `#trial`, and only then switched language.
    const { page, close } = await visit(urlFor('/en'), { locale: FOREIGN_LOCALE });
    try {
      expect(new URL(page.url()).hash).toBe('');

      await clickAndSettle(page, CTA);
      expect(new URL(page.url()).hash).toBe(TRIAL);

      await clickAndSettle(page, switchTo('hr'));
      expect(page.url()).toBe(urlFor('/', TRIAL));
      await expectInView(page, FORM);
    } finally {
      await close();
    }
  });

  it('carries a ?query across the switch, fragment and all', async () => {
    const suffix = `?utm_source=instagram&utm_campaign=trial${TRIAL}`;
    const { page, close } = await visit(urlFor('/en', suffix), { locale: FOREIGN_LOCALE });
    try {
      await clickAndSettle(page, switchTo('hr'));

      expect(page.url()).toBe(urlFor('/', suffix));
      const landed = new URL(page.url());
      expect(landed.searchParams.get('utm_source')).toBe('instagram');
      expect(landed.searchParams.get('utm_campaign')).toBe('trial');
      expect(landed.hash).toBe(TRIAL);
      await expectInView(page, FORM);
    } finally {
      await close();
    }
  });

  it('carries a ?query with no fragment, on a deep page', async () => {
    const { page, close } = await visit(urlFor('/en/schedule', '?utm_source=qr'), {
      locale: FOREIGN_LOCALE,
    });
    try {
      await clickAndSettle(page, switchTo('hr'));

      expect(page.url()).toBe(urlFor('/schedule', '?utm_source=qr'));
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
      // No fragment asked for, so none invented and nothing scrolled.
      expect(new URL(page.url()).hash).toBe('');
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
    } finally {
      await close();
    }
  });

  it('invents no fragment and no query when the URL has neither', async () => {
    const { page, close } = await visit(urlFor('/en'), { locale: FOREIGN_LOCALE });
    try {
      // The advertised href is clean too — not `…/?#`, which is a different URL to a
      // crawler and an ugly one to copy out of a context menu.
      expect(await switchHref(page, 'hr')).toBe(pagePath('/'));
      expect(await switchHref(page, 'en')).toBe(pagePath('/en'));

      await clickAndSettle(page, switchTo('hr'));

      expect(page.url()).toBe(urlFor('/'));
      expect(new URL(page.url()).search).toBe('');
      expect(new URL(page.url()).hash).toBe('');
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
    } finally {
      await close();
    }
  });

  it('switches a deep page to the equivalent deep page, not the homepage', async () => {
    for (const [from, to] of [
      ['/en/contact', '/contact'],
      ['/en/privacy', '/privacy'],
    ] as const) {
      const { page, close } = await visit(urlFor(from), { locale: FOREIGN_LOCALE });
      try {
        await clickAndSettle(page, switchTo('hr'));
        expect(new URL(page.url()).pathname).toBe(pagePath(to));
      } finally {
        await close();
      }
    }
  });

  it('records the switch, so the homepage redirect does not undo it', async () => {
    const { page, close } = await visit(urlFor('/en', TRIAL), { locale: FOREIGN_LOCALE });
    try {
      await clickAndSettle(page, switchTo('hr'));
      expect(await storedLang(page)).toBe('hr');
    } finally {
      await close();
    }
  });
});

describe('locale switch — it cannot fight the redirect it just triggered (MUSE-16)', () => {
  it('rewrites ?lang= to the locale being switched to, instead of bouncing back', async () => {
    // Carrying `?lang=en` verbatim onto the Croatian homepage would hand the inline
    // selector a URL that explicitly asks for English, which sends the visitor straight
    // back to `/en/` — the switch would be unclickable. The param names a *requested*
    // language, so switching language rewrites it.
    const { page, close } = await visit(urlFor('/en', `?${LANG_PARAM}=en${TRIAL}`), {
      locale: FOREIGN_LOCALE,
    });
    try {
      await clickAndSettle(page, switchTo('hr'));

      // Where the visitor ended up, asserted before the href that took them there: the
      // symptom is being dumped back on the English page, and a test that only compared
      // href strings would be checking our own output rather than the bounce.
      expect(new URL(page.url()).pathname).not.toBe(pagePath('/en'));
      expect(page.url()).toBe(urlFor('/', `?${LANG_PARAM}=hr${TRIAL}`));
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
      await expectInView(page, FORM);

      // And the href the switcher now advertises for the way back.
      expect(await switchHref(page, 'en')).toBe(
        `${pagePath('/en')}?${LANG_PARAM}=en${TRIAL}`,
      );
    } finally {
      await close();
    }
  });

  it('rewrites ?lang= among other params without disturbing them', async () => {
    const { page, close } = await visit(
      urlFor('/', `?utm_source=qr&${LANG_PARAM}=hr`),
      { locale: CROATIAN_LOCALE },
    );
    try {
      await clickAndSettle(page, switchTo('en'));

      const landed = new URL(page.url());
      expect(landed.pathname).toBe(pagePath('/en'));
      expect(landed.searchParams.get(LANG_PARAM)).toBe('en');
      expect(landed.searchParams.get('utm_source')).toBe('qr');
      expect(await page.getAttribute('html', 'lang')).toBe('en');
    } finally {
      await close();
    }
  });
});

describe('?lang= selects a language rather than only suppressing (MUSE-16)', () => {
  it('sends ?lang=en to the English page even on a Croatian browser', async () => {
    const { page, close } = await visit(urlFor('/', `?${LANG_PARAM}=en`), {
      locale: CROATIAN_LOCALE,
    });
    try {
      expect(new URL(page.url()).pathname).toBe(pagePath('/en'));
      expect(await page.getAttribute('html', 'lang')).toBe('en');
      // Persisted the way an explicit click is, so the next visit honours it.
      expect(await storedLang(page)).toBe('en');
    } finally {
      await close();
    }
  });

  it('carries the fragment while selecting, so ?lang=en#trial lands on the form', async () => {
    const { page, close } = await visit(urlFor('/', `?${LANG_PARAM}=en${TRIAL}`), {
      locale: FOREIGN_LOCALE,
    });
    try {
      expect(page.url()).toBe(urlFor('/en', `?${LANG_PARAM}=en${TRIAL}`));
      await expectInView(page, FORM);
    } finally {
      await close();
    }
  });

  it('keeps ?lang=hr on the Croatian page and remembers the choice', async () => {
    const { page, close } = await visit(urlFor('/', `?${LANG_PARAM}=hr${TRIAL}`), {
      locale: FOREIGN_LOCALE,
    });
    try {
      expect(page.url()).toBe(urlFor('/', `?${LANG_PARAM}=hr${TRIAL}`));
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
      expect(await storedLang(page)).toBe('hr');
    } finally {
      await close();
    }
  });

  it('lets ?lang= override a stored choice, both ways', async () => {
    for (const [stored, requested, landing] of [
      ['hr', 'en', '/en'],
      ['en', 'hr', '/'],
    ] as const) {
      const { page, close } = await visit(urlFor('/', `?${LANG_PARAM}=${requested}`), {
        locale: FOREIGN_LOCALE,
        storedLang: stored,
      });
      try {
        // The param is on *this* request and is how a link gets shared in a language;
        // the stored value is a choice from some previous visit. The request wins, and
        // replaces the stored value rather than sitting beside it.
        expect(new URL(page.url()).pathname).toBe(pagePath(landing));
        expect(await storedLang(page)).toBe(requested);
      } finally {
        await close();
      }
    }
  });

  it('settles after one redirect — ?lang=en is not a loop', async () => {
    const baseline = await visit(urlFor('/', TRIAL), { locale: CROATIAN_LOCALE });
    const selected = await visit(urlFor('/', `?${LANG_PARAM}=en${TRIAL}`), {
      locale: FOREIGN_LOCALE,
    });
    try {
      // `location.replace`, so the Croatian URL is gone from the stack and Back cannot
      // return to it and bounce forward again.
      expect(await selected.page.evaluate(() => history.length)).toBe(
        await baseline.page.evaluate(() => history.length),
      );
      await selected.page.goBack({ waitUntil: 'load' }).catch(() => null);
      expect(new URL(selected.page.url()).pathname).not.toBe(pagePath('/'));
    } finally {
      await Promise.all([baseline.close(), selected.close()]);
    }
  });

  it('ignores a ?lang= value that names no locale, and stores nothing', async () => {
    // Unknown values still suppress detection — `?lang=` has always meant "I am choosing",
    // and a typo is not a reason to override it with the browser's preference.
    const { page, close } = await visit(urlFor('/', `?${LANG_PARAM}=klingon`), {
      locale: FOREIGN_LOCALE,
    });
    try {
      expect(page.url()).toBe(urlFor('/', `?${LANG_PARAM}=klingon`));
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
      expect(await storedLang(page)).toBe(null);
    } finally {
      await close();
    }
  });
});

describe('the ?lang= guard matches the param, not a suffix of it (MUSE-16)', () => {
  it('does not let ?slang= suppress the redirect', async () => {
    // `location.search.indexOf('lang=')` matched any param ending in `lang`, so an
    // unrelated query string silently disabled language detection.
    const { page, close } = await visit(urlFor('/', '?slang=whatever'), {
      locale: FOREIGN_LOCALE,
    });
    try {
      expect(page.url()).toBe(urlFor('/en', '?slang=whatever'));
      expect(await page.getAttribute('html', 'lang')).toBe('en');
    } finally {
      await close();
    }
  });

  it('does not let ?slang= select a language either', async () => {
    const { page, close } = await visit(urlFor('/', '?slang=en'), {
      locale: CROATIAN_LOCALE,
    });
    try {
      // A Croatian browser with no stored choice and no real `lang` param stays put.
      expect(page.url()).toBe(urlFor('/', '?slang=en'));
      expect(await storedLang(page)).toBe(null);
    } finally {
      await close();
    }
  });
});

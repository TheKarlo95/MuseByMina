import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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
  /** The context the page lives in — a middle-click opens its new tab here. */
  context: BrowserContext;
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
  return { page, context: ctx, close: () => ctx.close() };
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

      // `?lang=hr` rides along because the href is the record of the choice (MUSE-33).
      expect(page.url()).toBe(urlFor('/', `?${LANG_PARAM}=hr${TRIAL}`));
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

      expect(page.url()).toBe(urlFor('/en', `?${LANG_PARAM}=en${TRIAL}`));
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
      expect(page.url()).toBe(urlFor('/', `?${LANG_PARAM}=hr${TRIAL}`));
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

      // Byte-identical, with `lang` appended rather than the whole query re-serialised.
      expect(page.url()).toBe(
        urlFor('/', `?utm_source=instagram&utm_campaign=trial&${LANG_PARAM}=hr${TRIAL}`),
      );
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

      expect(page.url()).toBe(urlFor('/schedule', `?utm_source=qr&${LANG_PARAM}=hr`));
      expect(await page.getAttribute('html', 'lang')).toBe('hr-HR');
      // No fragment asked for, so none invented and nothing scrolled.
      expect(new URL(page.url()).hash).toBe('');
      expect(await page.evaluate(() => Math.round(window.scrollY))).toBe(0);
    } finally {
      await close();
    }
  });

  it('invents no fragment, and no query beyond the one parameter it means', async () => {
    const { page, close } = await visit(urlFor('/en'), { locale: FOREIGN_LOCALE });
    try {
      // `?lang=` is deliberate (MUSE-33): it is what makes the href a durable link to a
      // language rather than a bare path the auto-redirect is free to reinterpret. What
      // is still not invented is anything else — no `#`, no trailing `?`, no reordering.
      expect(await switchHref(page, 'hr')).toBe(`${pagePath('/')}?${LANG_PARAM}=hr`);
      expect(await switchHref(page, 'en')).toBe(`${pagePath('/en')}?${LANG_PARAM}=en`);

      await clickAndSettle(page, switchTo('hr'));

      expect(page.url()).toBe(urlFor('/', `?${LANG_PARAM}=hr`));
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

  it('selects nothing and stores nothing for a value that names no locale', async () => {
    // A Croatian browser, so detection agrees with staying put and the only thing the
    // assertion can be reading is that `?lang=klingon` selected nothing. Whether an
    // unknown value also *suppresses* detection is the MUSE-33 block below: it must not.
    const { page, close } = await visit(urlFor('/', `?${LANG_PARAM}=klingon`), {
      locale: CROATIAN_LOCALE,
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

/**
 * Where a visit ends up, cheaply, for the enumeration below.
 *
 * `visit()` waits for fonts and for scrolling to settle because its assertions are about
 * geometry. The matrix only asks "which page, and did it stop there", across a hundred-odd
 * combinations, so this waits for `load` and counts main-frame navigations instead.
 *
 * The count is the loop proof. A redirect that lands somewhere which redirects back shows
 * up as a third navigation — or as a `goto` that never resolves, which fails just as
 * loudly. `about:blank` is excluded: it is how the tab starts, not somewhere it went.
 */
interface Landing {
  url: string;
  htmlLang: string | null;
  stored: string | null;
  /** Main-frame document navigations, the first real one included. */
  navigations: number;
}

async function landing(opts: {
  from: string;
  locale: string;
  storedLang?: string;
}): Promise<Landing> {
  const ctx = await browser.newContext({ locale: opts.locale });
  try {
    if (opts.storedLang !== undefined) {
      await ctx.addInitScript(
        ([key, value]) => {
          if (localStorage.getItem(key!) === null) localStorage.setItem(key!, value!);
        },
        [LANG_STORAGE_KEY, opts.storedLang] as const,
      );
    }
    const page = await ctx.newPage();
    let navigations = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && !frame.url().startsWith('about:')) navigations += 1;
    });
    await page.goto(opts.from, { waitUntil: 'load', timeout: 20_000 });
    // Long enough that a second hop would have started if there were going to be one.
    await page.waitForTimeout(200);
    return {
      url: page.url(),
      htmlLang: await page.getAttribute('html', 'lang'),
      stored: await storedLang(page),
      navigations,
    };
  } finally {
    await ctx.close();
  }
}

/**
 * Run `work` over `items`, a few at a time.
 *
 * The enumeration is 128 browser contexts. Serially that is a couple of minutes of the
 * suite's wall clock for assertions that share nothing with each other; a handful at a
 * time keeps it in the tens of seconds. Each case already owns its own context, so there
 * is nothing to interleave.
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

describe('a copied or middle-clicked switcher link is durable (MUSE-33)', () => {
  it('advertises the language on the href, so the link carries the choice', async () => {
    // The irony MUSE-33 names: MUSE-16 made the carry an *href rewrite* precisely because
    // middle-click, "open in new tab" and "copy link address" fire no `click` event — and
    // then left persistence in the click handler, where those paths still miss it. A bare
    // `/MuseByMina/#trial` is not a durable link to Croatian: the homepage redirect is
    // free to reinterpret it, and for a non-Croatian browser it does.
    const { page, close } = await visit(urlFor('/en', TRIAL), { locale: FOREIGN_LOCALE });
    try {
      expect(await switchHref(page, 'hr')).toBe(`${pagePath('/')}?${LANG_PARAM}=hr${TRIAL}`);
      expect(await switchHref(page, 'en')).toBe(
        `${pagePath('/en')}?${LANG_PARAM}=en${TRIAL}`,
      );
    } finally {
      await close();
    }
  });

  it('opens the HR link in a new tab on Croatian, on a browser preferring English', async () => {
    // A genuine middle-click: Chromium opens a background tab, no `click` handler runs,
    // and nothing has been stored. Everything the destination needs has to be in the URL.
    const { page, context, close } = await visit(urlFor('/en', TRIAL), {
      locale: FOREIGN_LOCALE,
    });
    try {
      expect(await storedLang(page)).toBe(null);

      const opened = context.waitForEvent('page');
      await page.locator(switchTo('hr')).click({ button: 'middle' });
      const tab = await opened;
      await tab.waitForLoadState('load');
      await tab.waitForTimeout(200);

      // Croatian, not bounced to `/en/` by the homepage redirect.
      expect(tab.url()).toBe(urlFor('/', `?${LANG_PARAM}=hr${TRIAL}`));
      expect(await tab.getAttribute('html', 'lang')).toBe('hr-HR');
      // And the choice is now recorded, by the link rather than by a handler.
      expect(await storedLang(tab)).toBe('hr');
    } finally {
      await close();
    }
  });

  it('opens the EN link in a new tab on English, and records that too', async () => {
    const { page, context, close } = await visit(urlFor('/', TRIAL), {
      locale: CROATIAN_LOCALE,
    });
    try {
      const opened = context.waitForEvent('page');
      await page.locator(switchTo('en')).click({ button: 'middle' });
      const tab = await opened;
      await tab.waitForLoadState('load');
      await tab.waitForTimeout(200);

      expect(tab.url()).toBe(urlFor('/en', `?${LANG_PARAM}=en${TRIAL}`));
      expect(await tab.getAttribute('html', 'lang')).toBe('en');
      // `/en/` ran no language script before MUSE-33, so a tab opened here displayed
      // English and remembered nothing — and the next plain `/` went Croatian.
      expect(await storedLang(tab)).toBe('en');
    } finally {
      await close();
    }
  });

  it('rewrites the lang parameter and leaves the rest of the query byte-identical', async () => {
    // MUSE-16 rebuilt the whole query through `URLSearchParams.toString()` whenever there
    // was a `lang` to rewrite, which re-encodes what it did not have to touch: `%20` comes
    // back out as `+`. Both decode to a space, so nothing visibly broke — but the function
    // claims to *carry* a visitor's campaign tags and it was rewriting them (MUSE-33).
    const encoded = 'utm_campaign=trial%20class';
    const { page, close } = await visit(
      urlFor('/en', `?${encoded}&${LANG_PARAM}=en${TRIAL}`),
      { locale: FOREIGN_LOCALE },
    );
    try {
      expect(await switchHref(page, 'hr')).toBe(
        `${pagePath('/')}?${encoded}&${LANG_PARAM}=hr${TRIAL}`,
      );

      await clickAndSettle(page, switchTo('hr'));

      expect(page.url()).toBe(urlFor('/', `?${encoded}&${LANG_PARAM}=hr${TRIAL}`));
      // And it still means what it meant, byte-identical or not.
      expect(new URL(page.url()).searchParams.get('utm_campaign')).toBe('trial class');
    } finally {
      await close();
    }
  });

  it('serves a crawler the bare path, with no parameter in the markup', async () => {
    // The `?lang=` is attached client-side. The rendered href stays the clean canonical
    // spelling, so a crawler is not offered a second URL for every page on the site.
    const ctx = await browser.newContext({
      locale: FOREIGN_LOCALE,
      javaScriptEnabled: false,
    });
    try {
      const page = await ctx.newPage();
      await page.goto(urlFor('/en/schedule'), { waitUntil: 'load' });
      expect(await switchHref(page, 'hr')).toBe(pagePath('/schedule'));
      expect(await switchHref(page, 'en')).toBe(pagePath('/en/schedule'));
    } finally {
      await ctx.close();
    }
  });
});

describe('?lang= works off the root, not only on it (MUSE-33)', () => {
  it('sends a deep page to the requested locale and records the choice', async () => {
    for (const [from, to, htmlLang, requested] of [
      ['/schedule', '/en/schedule', 'en', 'en'],
      ['/en/contact', '/contact', 'hr-HR', 'hr'],
    ] as const) {
      // The browser prefers the language the link is *not* asking for, so detection
      // cannot be what explains the outcome.
      const locale = requested === 'en' ? CROATIAN_LOCALE : FOREIGN_LOCALE;
      const result = await landing({
        from: urlFor(from, `?${LANG_PARAM}=${requested}`),
        locale,
      });
      const where = `${from} ?${LANG_PARAM}=${requested}`;
      expect(new URL(result.url).pathname, where).toBe(pagePath(to));
      expect(result.htmlLang, where).toBe(htmlLang);
      expect(result.stored, where).toBe(requested);
      // One hop. The destination is already the locale asked for, so it stops there.
      expect(result.navigations, where).toBe(2);
    }
  });

  it('carries the query and fragment onto the deep destination', async () => {
    const result = await landing({
      from: urlFor('/schedule', `?utm_source=qr&${LANG_PARAM}=en${TRIAL}`),
      locale: CROATIAN_LOCALE,
    });
    expect(result.url).toBe(urlFor('/en/schedule', `?utm_source=qr&${LANG_PARAM}=en${TRIAL}`));
  });

  it('stays put, and stores, when a deep page is already the requested locale', async () => {
    for (const [from, requested, htmlLang] of [
      ['/schedule', 'hr', 'hr-HR'],
      ['/en/schedule', 'en', 'en'],
    ] as const) {
      const result = await landing({
        from: urlFor(from, `?${LANG_PARAM}=${requested}`),
        locale: requested === 'hr' ? FOREIGN_LOCALE : CROATIAN_LOCALE,
      });
      const where = `${from} ?${LANG_PARAM}=${requested}`;
      expect(new URL(result.url).pathname, where).toBe(pagePath(from));
      expect(result.htmlLang, where).toBe(htmlLang);
      expect(result.stored, where).toBe(requested);
      expect(result.navigations, where).toBe(1);
    }
  });

  it('never routes a deep page by the browser or by storage', async () => {
    // `?lang=` is explicit and attached to this request, so it may move a deep page.
    // Nothing else may: MUSE-10's rule that no deep link can bounce is what keeps a
    // shared `/schedule/` landing on `/schedule/`, and widening it would mean a visitor
    // who once chose English could not be sent a Croatian page at all.
    for (const [from, stored] of [
      ['/schedule', 'en'],
      ['/en/schedule', 'hr'],
      ['/contact', undefined],
    ] as const) {
      const result = await landing({
        from: urlFor(from),
        locale: FOREIGN_LOCALE,
        storedLang: stored,
      });
      const where = `${from} stored=${stored}`;
      expect(new URL(result.url).pathname, where).toBe(pagePath(from));
      expect(result.navigations, where).toBe(1);
    }
  });
});

describe('an unusable instruction hands the decision back (MUSE-33)', () => {
  it('detects for a ?lang= value that names no locale, instead of stranding', async () => {
    // `/?lang=de` used to leave an English browser on Croatian: the parameter suppressed
    // detection without selecting anything. Same shape as the `?slang=` bug — a value
    // that is not a supported locale must not silently disable the redirect.
    const result = await landing({
      from: urlFor('/', `?${LANG_PARAM}=de`),
      locale: FOREIGN_LOCALE,
    });
    expect(new URL(result.url).pathname).toBe(pagePath('/en'));
    expect(result.htmlLang).toBe('en');
    // Nothing selected, so nothing recorded — the next visit decides again.
    expect(result.stored).toBe(null);
    expect(result.navigations).toBe(2);
  });

  it('does not let an unknown ?lang= loop through the destination', async () => {
    // The unknown value rides along in the carried query, so `/en/?lang=de` is the page
    // the redirect lands on. It has to read as "nothing asked for" there too.
    const result = await landing({
      from: urlFor('/en', `?${LANG_PARAM}=de`),
      locale: CROATIAN_LOCALE,
    });
    expect(result.url).toBe(urlFor('/en', `?${LANG_PARAM}=de`));
    expect(result.navigations).toBe(1);
  });

  it('detects for a stored value that names no locale', async () => {
    const result = await landing({
      from: urlFor('/'),
      locale: FOREIGN_LOCALE,
      storedLang: 'de',
    });
    expect(new URL(result.url).pathname).toBe(pagePath('/en'));
    expect(result.navigations).toBe(2);
  });
});

/**
 * Every combination, enumerated, because this is the seam where the three rules meet.
 *
 * `?lang=`, a stored choice and the browser's preference now compose, and MUSE-16 already
 * shipped one loop from exactly here — clicking HR on `/en/?lang=en` handed the Croatian
 * page a URL asking for English. Reasoning case by case is what produced that, so the
 * table is the test: every starting URL, every parameter value, every stored value, both
 * browsers, and the claim that each one lands where the precedence rules say *and stops*.
 *
 * `navigations` is 1 for "stayed" and 2 for "one hop". It is never allowed to be 3.
 */
describe('the precedence rules compose without a loop (MUSE-33)', () => {
  /** `?lang=` values worth distinguishing: absent, each locale, and a non-locale. */
  const REQUESTED = [undefined, 'hr', 'en', 'de'] as const;
  /** Stored values, on the same axis. */
  const STORED = [undefined, 'hr', 'en', 'de'] as const;
  /** One page that language-detects and one that must not, in both locales. */
  const ROUTES = [
    ['/', 'hr'],
    ['/', 'en'],
    ['/schedule', 'hr'],
    ['/schedule', 'en'],
  ] as const;

  interface Case {
    from: string;
    locale: string;
    storedLang?: string;
    label: string;
    want: { path: string; htmlLang: string };
  }

  /**
   * Where the rules say a visit ends up, written as the rule rather than as a lookup
   * table so each row says *why* it is what it is.
   */
  function expected(
    route: string,
    here: 'hr' | 'en',
    requested: string | undefined,
    stored: string | undefined,
    browserIsCroatian: boolean,
  ): 'hr' | 'en' {
    if (requested === 'hr' || requested === 'en') return requested;
    // Detection — the stored choice included — is the default locale's homepage only.
    if (!(here === 'hr' && route === '/')) return here;
    if (stored === 'hr' || stored === 'en') return stored;
    return browserIsCroatian ? 'hr' : 'en';
  }

  /** The route a locale serves, in the shape `pagePath` wants. */
  const routeIn = (route: string, locale: 'hr' | 'en'): string =>
    locale === 'en' ? `/en${route === '/' ? '' : route}` : route;

  it(
    'lands where the rules say and settles there, for every combination',
    async () => {
      const cases: Case[] = [];
      for (const [route, here] of ROUTES) {
        for (const browserIsCroatian of [true, false]) {
          for (const requested of REQUESTED) {
            for (const stored of STORED) {
              const suffix = requested === undefined ? '' : `?${LANG_PARAM}=${requested}`;
              const from = routeIn(route, here);
              const want = expected(route, here, requested, stored, browserIsCroatian);
              cases.push({
                from: urlFor(from, suffix),
                locale: browserIsCroatian ? CROATIAN_LOCALE : FOREIGN_LOCALE,
                storedLang: stored,
                label: `${from}${suffix} browser=${
                  browserIsCroatian ? 'hr' : 'en'
                } stored=${stored}`,
                want: {
                  path: pagePath(routeIn(route, want)),
                  htmlLang: want === 'hr' ? 'hr-HR' : 'en',
                },
              });
            }
          }
        }
      }
      // The enumeration is the whole point; a silently empty loop would assert nothing.
      expect(cases.length).toBe(ROUTES.length * 2 * REQUESTED.length * STORED.length);

      const results = await inParallel(cases, 6, (c) =>
        landing({ from: c.from, locale: c.locale, storedLang: c.storedLang }),
      );

      for (const [index, result] of results.entries()) {
        const c = cases[index]!;
        expect(new URL(result.url).pathname, c.label).toBe(c.want.path);
        expect(result.htmlLang, c.label).toBe(c.want.htmlLang);
        // One hop at most, ever. A loop is a third navigation, or a `goto` that never
        // resolves — and both fail here rather than being reasoned about.
        expect(result.navigations, c.label).toBe(
          c.want.path === new URL(c.from).pathname ? 1 : 2,
        );
      }
    },
    600_000,
  );
});

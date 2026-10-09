import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { launchChecks, openRedirectProbe } from '../scripts/browser-checks.mjs';
import type { Locale } from '../src/lib/i18n';
import { LANG_PARAM, LANG_STORAGE_KEY } from '../src/lib/lang';
import {
  settleInteraction,
  settleMove,
  settleNavigation,
  settleNewTab,
  settleScroll,
} from './helpers/browser-settle';
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

/**
 * Any switcher entry, by the locale it names — link or not.
 *
 * `switchTo` above is deliberately an `a`: a *switch* is a thing you can follow, and a
 * selector that quietly matched a non-link would let the switcher stop being one without
 * a single assertion changing. The own-locale entry is not a switch (MUSE-39), so the
 * assertions about it select on the entry rather than on the element it happens to be.
 */
const entryFor = (locale: Locale): string =>
  `[data-locale-switch] [data-locale="${locale}"]`;

let browser: Browser;
let preview: Preview;
/** `http://127.0.0.1:<port>` — the preview origin without the deploy base. */
let host: string;

beforeAll(async () => {
  [preview, browser] = await Promise.all([
    startPreview('localeswitch'),
    launchChecks(),
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
 * Through `openRedirectProbe` — the door in `scripts/browser-checks.mjs` that pins no
 * locale and asserts no landing (MUSE-48). This suite enumerates where the redirect takes
 * a browser, so pinning the locale would pin away its subject; every suite that *measures*
 * a page uses `openCheckPage` instead, and the browser language here has to be named
 * rather than inherited from the automation's default.
 *
 * `storedLang` is seeded there with an init script, so it is in `localStorage` *before*
 * the blocking inline script in `<head>` reads it, and only when the key is absent — see
 * the note at the probe for why an unconditional write would hide the write under test.
 */
async function visit(
  url: string,
  opts: { locale: string; storedLang?: string } = { locale: FOREIGN_LOCALE },
): Promise<Visit> {
  const { page, context, close } = await openRedirectProbe(browser, {
    navigatorLocale: opts.locale,
    storedLang: opts.storedLang,
    // Same viewport as the a11y gate, and wide enough that the header is the desktop
    // layout with the locale switch on screen rather than behind the menu button.
    context: { viewport: { width: 1280, height: 900 } },
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await settleScroll(page);
  return { page, context, close };
}

/**
 * Click `selector` and wait for whatever navigation it causes to settle.
 *
 * Covers both kinds: a locale switch is a document navigation, the header CTA to `#trial`
 * is a same-document hash change. Playwright reports a commit for both, which is why
 * `settleMove` can be the one gate here — and why it is the gate rather than the in-page
 * `location.href` poll this used to run. That poll observed the commit in the *renderer*,
 * one bookkeeping removed from the `page.url()` the assertions below read; MUSE-61 is what
 * that gap costs. A click that goes nowhere, or bounces straight back, is still reported by
 * the wait naming where it stayed.
 */
async function clickAndSettle(page: Page, selector: string): Promise<void> {
  const before = page.url();
  await page.locator(selector).click();
  await settleMove(page, before, `${selector} to go somewhere other than ${before}`);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.evaluate(() => document.fonts.ready);
  await settleScroll(page);
}

/**
 * What a middle-clicked tab turned out to be: where it ended up, in what language, and
 * what it remembered.
 *
 * The same shape `landing()` below answers for a copied address, and for the same reason —
 * it is a *measurement* of the destination rather than a handle to it. Here that is also
 * the fix for MUSE-70: Playwright's `page.url()` for a tab Chromium opened can be
 * permanently `about:blank` (the mechanism and the measurements are at `settleNewTab`), so
 * the three assertions below must not be able to reach it. They cannot — there is no
 * `Page` in scope to read it off.
 *
 * `landing` carries a `navigations` count and this deliberately does not. That counter is
 * `page.on('framenavigated')`, which is the very channel a late-adopted tab loses: it
 * would read 0 for a tab that navigated perfectly well, so it is not a fact about the
 * site. The copied-address case is where "exactly one hop" is asserted, and it can be,
 * because that page was Playwright's before it moved.
 */
interface Opened {
  /** Where the tab ended up, as its own document reports it. */
  url: string;
  htmlLang: string | null;
  stored: string | null;
}

/**
 * How many times Chromium is asked to open the tab, and how long each ask is given.
 *
 * **MUSE-70's second half, and the measurement is why there is a count rather than a bigger
 * number.** The gesture is sometimes simply dropped. Instrumented inside a failing run, the
 * page receives `pointerdown`, `mousedown`, `mouseup` and `auxclick`, all `button=1`, all
 * on the switcher's own `<a>`, none default-prevented, at identical coordinates, with the
 * link's box unmoved and its `href` correct and `target` absent — and Chromium opens no
 * tab, ever. **Waiting longer was tried and does not work**: raised to 45 s, 4 of 5 full
 * runs still failed here, each with the click itself finishing in 143–266 ms and no tab
 * arriving in the remaining forty-four seconds.
 *
 * So the retry is what is left, and it is honest for one reason: *whether Chromium acts on
 * a middle-click is not a fact about this site.* The markup half — that the entry is a
 * plain `<a>` with an `href` and no `target` — is asserted separately and deterministically
 * in the MUSE-33 block, so a switcher that stopped being a link fails there rather than
 * here. A middle-click is also idempotent on the page performing it (it navigates nothing),
 * so asking again costs a click and risks nothing. What this must never become is a retry
 * around the *assertions*: a tab that arrives and cannot be measured is rethrown below.
 *
 * `TAB_BUDGET` covers both halves of one attempt, and each was measured on its own.
 * `locator.click`'s actionability checks took **2.9–3.9 s** at
 * `Emulation.setCPUThrottlingRate: 80` and 143–266 ms in the real failing runs; the `page`
 * event then arrived within **1 ms** of the click returning, 42 of 42 trials, throttled and
 * not. Twelve seconds is about three times the worst click ever measured here, and the loss
 * note below records the click's own duration so the two halves can never be confused for
 * each other. Three attempts bound the helper at 36 s, inside `testTimeout`'s 60 s, and
 * cost nothing at all on the path where the first gesture lands.
 */
const TAB_ATTEMPTS = 3;
const TAB_BUDGET = 12_000;

/**
 * Middle-click `selector` and measure the tab it opened, once that tab holds a document.
 *
 * The one place in the suite a new tab is taken delivery of (MUSE-61). It was three copies
 * of the same four lines, each gating on conditions a blank tab satisfies — and `tab.url()`
 * read against the empty document Chromium opens a middle-clicked tab at is how a pull
 * request touching no browser code went red. `settleNewTab` is the barrier; what it does
 * *not* do, why the `localStorage` wait that used to be here is gone, and why the URL now
 * comes back from the gate rather than off the tab (MUSE-70) are all written out there.
 *
 * **The wait is subscribed before the gesture and that is deliberate** — a `page` event
 * delivered while `click()` was still in flight would otherwise be missed, and Playwright
 * delivers it from the message loop, which runs between two `await`s. The price is that
 * the budget covers the click as well, which is why `TAB_BUDGET` is sized against both and
 * why the loss note says how much of it the click took. An earlier cut subscribed
 * *afterwards* so the budget measured only the tab, and claimed the gap was closed by
 * reading `context.pages()` first; it was, but `const opened = already ?? …` is not a call
 * expression, so `uncommittedTabs` stopped tracking the tab and MUSE-61's guard passed
 * while asserting nothing. Checked by deleting the `settleNewTab` call and watching
 * `test/isolation.test.ts` go red, which is the only way to tell that rule apart from a
 * vacuous one.
 */
async function middleClickOpens(
  page: Page,
  context: BrowserContext,
  selector: string,
): Promise<Opened> {
  const lost: string[] = [];
  for (let attempt = 1; attempt <= TAB_ATTEMPTS; attempt += 1) {
    const opened = context.waitForEvent('page', { timeout: TAB_BUDGET });
    // Park a handler on it before the click. The promise is deliberately created first so
    // no event can be missed, which means its budget can expire while `click()` is still
    // in flight — and a rejection nobody is awaiting yet is an *unhandled* one, which
    // crashes the worker instead of failing the test. Demonstrated with the budget set to
    // 1 ms: the process dies at this line before the click returns. The `await` below is
    // still what reads the outcome.
    void opened.catch(() => undefined);
    const asked = Date.now();
    await page.locator(selector).click({ button: 'middle' });
    const clicked = Date.now() - asked;

    let arrived = false;
    try {
      const tab = await opened;
      arrived = true;
      if (attempt > 1) {
        // Said out loud rather than absorbed. A dropped gesture is the browser's, not the
        // site's, so it must not fail the run — but a *rate* of them is worth seeing, and
        // a retry nobody can observe is how the next person concludes there is nothing
        // here to find (MUSE-70).
        console.error(
          `MUSE-70: Chromium dropped ${lost.length} middle-click(s) on ${selector} ` +
            `before opening the tab — ${lost.join('; ')}`,
        );
      }
      const url = await settleNewTab(tab, `the tab middle-clicking ${selector} opened`);
      return {
        url,
        htmlLang: await tab.getAttribute('html', 'lang'),
        stored: await storedLang(tab),
      };
    } catch (cause) {
      // A tab we were given and could not measure is a failure of the thing under test.
      // Only the browser never producing one is retried.
      if (arrived) throw cause;
      lost.push(`${attempt}: the click took ${clicked}ms, no tab in the ${TAB_BUDGET}ms`);
    }
  }
  throw new Error(
    `Chromium opened no tab for ${TAB_ATTEMPTS} middle-clicks on ${selector} ` +
      `(${lost.join('; ')}). MUSE-70 measured each gesture arriving at the link with ` +
      `auxclick firing undefaulted, so read a run of these as the browser dropping them ` +
      `rather than as a slow machine — and if the click durations above are close to the ` +
      `budget it is the machine after all. That the entry is still a plain link is ` +
      `asserted in the MUSE-33 block, so it is not what this is telling you.`,
  );
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
      // And not stamped onto the locale being read, which is not a link at all (MUSE-39).
      expect(await page.locator(switchTo('en')).count()).toBe(0);

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
  const { page, close } = await openRedirectProbe(browser, {
    navigatorLocale: opts.locale,
    storedLang: opts.storedLang,
  });
  try {
    let navigations = 0;
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame() && !frame.url().startsWith('about:')) navigations += 1;
    });
    await page.goto(opts.from, { waitUntil: 'load', timeout: 20_000 });
    /**
     * Not "long enough that a second hop would have started" — *proof* that none can
     * (MUSE-54). `langInitScript` is a blocking inline script in `<head>`, so a hop is
     * decided before the body parses and therefore before the document it hopped from
     * could ever fire `load`. A document that reaches `complete` is one that stayed, and
     * a hop still in flight is waited out instead of raced; the old 200 ms was a bet that
     * a redirect on a loaded machine is prompt.
     */
    await settleNavigation(page, 'the language redirect to settle on one document');
    return {
      url: page.url(),
      htmlLang: await page.getAttribute('html', 'lang'),
      stored: await storedLang(page),
      navigations,
    };
  } finally {
    await close();
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
      // And it is a *plain* link, which is the site-owned half of "a middle-click opens
      // it in a tab": `target` or `download` on it would change what the browser does
      // with the gesture, and the middle-click case below could then only report that as
      // Chromium declining to open a tab (MUSE-70). Checked here because it is a fact
      // about the markup and so costs no browser tab to establish.
      expect(await page.getAttribute(switchTo('hr'), 'target')).toBe(null);
      expect(await page.getAttribute(switchTo('hr'), 'download')).toBe(null);
      // The English entry is where the visitor already is, so it is not a link to carry
      // anything — the durability claim is about the language they are *not* reading
      // (MUSE-39). The same href seen from the other side is asserted below.
      expect(await page.locator(switchTo('en')).count()).toBe(0);
    } finally {
      await close();
    }
  });

  it('advertises the other language from the Croatian side too', async () => {
    const { page, close } = await visit(urlFor('/', TRIAL), { locale: CROATIAN_LOCALE });
    try {
      expect(await switchHref(page, 'en')).toBe(
        `${pagePath('/en')}?${LANG_PARAM}=en${TRIAL}`,
      );
      expect(await page.locator(switchTo('hr')).count()).toBe(0);
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

      const tab = await middleClickOpens(page, context, switchTo('hr'));

      // Croatian, not bounced to `/en/` by the homepage redirect.
      expect(tab.url).toBe(urlFor('/', `?${LANG_PARAM}=hr${TRIAL}`));
      expect(tab.htmlLang).toBe('hr-HR');
      // And the choice is now recorded, by the link rather than by a handler.
      expect(tab.stored).toBe('hr');
    } finally {
      await close();
    }
  });

  it('opens the EN link in a new tab on English, and records that too', async () => {
    const { page, context, close } = await visit(urlFor('/', TRIAL), {
      locale: CROATIAN_LOCALE,
    });
    try {
      const tab = await middleClickOpens(page, context, switchTo('en'));

      expect(tab.url).toBe(urlFor('/en', `?${LANG_PARAM}=en${TRIAL}`));
      expect(tab.htmlLang).toBe('en');
      // `/en/` ran no language script before MUSE-33, so a tab opened here displayed
      // English and remembered nothing — and the next plain `/` went Croatian.
      expect(tab.stored).toBe('en');
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
    const { page, close } = await openRedirectProbe(browser, {
      navigatorLocale: FOREIGN_LOCALE,
      context: { javaScriptEnabled: false },
    });
    try {
      await page.goto(urlFor('/en/schedule'), { waitUntil: 'load' });
      expect(await switchHref(page, 'hr')).toBe(pagePath('/schedule'));
      // And one link rather than two: the self-reference a crawler was being offered is
      // gone with it (MUSE-39), which is the markup `test/urls.test.ts` walks.
      expect(await page.locator('[data-locale-switch] a').count()).toBe(1);
      expect(await page.getAttribute(entryFor('en'), 'aria-current')).toBe('page');
    } finally {
      await close();
    }
  });
});

/** One switcher entry as the browser sees it, `aria-current` and resolved href included. */
interface Entry {
  locale: string | null;
  /** The element's resolved `href`, or `null` when it is not a link at all. */
  resolved: string | null;
  ariaCurrent: string | null;
}

/** Every entry the switcher renders, in DOM order. */
function entries(page: Page): Promise<Entry[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('[data-locale-switch] [data-locale]')].map(
      (el) => ({
        locale: el.dataset.locale ?? null,
        resolved: el instanceof HTMLAnchorElement ? el.href : null,
        ariaCurrent: el.getAttribute('aria-current'),
      }),
    ),
  );
}

/**
 * MUSE-39 — the entry for the locale you are already reading must not be a navigation.
 *
 * MUSE-33 stamped `?lang=` onto *every* switcher href, the own-locale one included, which
 * is how `/en/schedule/`'s EN entry came to point at `/en/schedule/?lang=en`. Nothing
 * broke: the destination serves the same page and the inline script reads `?lang=en` there
 * as satisfied. But activating it reloaded the document where it used to do nothing, and
 * `aria-current` was left on a link pointing somewhere other than the current address —
 * which is the single thing that attribute asserts.
 *
 * The assertions below are written against the behaviour rather than against the markup,
 * so they hold for either fix the ticket offers: whatever carries `aria-current` must
 * either not be a link or be a link to exactly where we already are, and activating it
 * must not navigate. A test that asserted `SPAN` would be asserting the choice.
 */
describe('the entry for the locale you are reading is inert (MUSE-39)', () => {
  it('carries aria-current on the locale being read, and on nothing else', async () => {
    // Pinned Croatian, and the landing URL asserted, because Playwright defaults to
    // `en-US` and an unpinned probe measures whichever page detection sent it to
    // (MUSE-48). `/en/schedule/` does not detect, so this is belt and braces — and it is
    // the belt that catches the day something here starts to.
    const { page, close } = await visit(urlFor('/en/schedule'), { locale: CROATIAN_LOCALE });
    try {
      expect(page.url()).toBe(urlFor('/en/schedule'));

      const marked = (await entries(page)).filter((entry) => entry.ariaCurrent !== null);
      expect(marked.map((entry) => entry.locale)).toEqual(['en']);
      // If it is still a link, it has to be a link to *here*. This is the inaccuracy:
      // MUSE-33 left `aria-current` on an href pointing at `…/en/schedule/?lang=en`.
      if (marked[0]!.resolved !== null) expect(marked[0]!.resolved).toBe(page.url());
      // `page`, not `true`. `true` is the generic fallback for a set with no better
      // token; this is a page out of a set of pages, which is what the nav already says
      // (`Header.astro`).
      expect(marked[0]!.ariaCurrent).toBe('page');
    } finally {
      await close();
    }
  });

  it('does not navigate when the locale being read is activated', async () => {
    const { page, close } = await visit(urlFor('/en/schedule'), { locale: CROATIAN_LOCALE });
    try {
      expect(page.url()).toBe(urlFor('/en/schedule'));

      // Two independent measurements, because each passes alone while the page visibly
      // reloads: a main-frame navigation, and a request for the document itself.
      let navigations = 0;
      let documents = 0;
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) navigations += 1;
      });
      page.on('request', (request) => {
        if (request.resourceType() === 'document') documents += 1;
      });

      const url = page.url();
      const depth = await page.evaluate(() => history.length);

      await page.locator(entryFor('en')).click();
      /**
       * The browser's own chance to act, measured in frames and in network quiet rather
       * than in milliseconds (MUSE-54). A negative claim has no state to converge on, so
       * what it can honestly wait for is: the page produced real frames after the click,
       * and no document request is still in the air. On a loaded box 500 ms of wall clock
       * can be *zero* frames, which is no chance at all — and a navigation that began
       * just after the sleep expired is a pass this assertion has not earned.
       */
      await settleInteraction(page, 'the activated locale entry to do whatever it does');

      expect(navigations, 'activating the current locale navigated').toBe(0);
      expect(documents, 'activating the current locale re-requested the document').toBe(0);
      expect(page.url()).toBe(url);
      // And no history entry, which is what makes Back behave afterwards.
      expect(await page.evaluate(() => history.length)).toBe(depth);
    } finally {
      await close();
    }
  });

  it('leaves the other locale a durable link, by click and by middle-click', async () => {
    // The half that must *not* change. `?lang=` on the other locale's href is the whole
    // of MUSE-33: it is what a middle-click, an "open in new tab" and a copied address
    // carry, none of which fire a `click` event for a handler to help.
    const { page, context, close } = await visit(urlFor('/en/schedule'), {
      locale: FOREIGN_LOCALE,
    });
    try {
      expect(await switchHref(page, 'hr')).toBe(
        `${pagePath('/schedule')}?${LANG_PARAM}=hr`,
      );
      expect(await storedLang(page)).toBe(null);

      const tab = await middleClickOpens(page, context, switchTo('hr'));

      // MUSE-61's failing line, and MUSE-70's. The comparison is the judge and the gate is
      // only the proof that there is a document to judge — which is why `?lang=` going
      // missing reads as „expected `?lang=hr`, received nothing" rather than as a timeout.
      // Proved both times by building with the parameter dropped; the failure names the
      // URL it got.
      expect(tab.url).toBe(urlFor('/schedule', `?${LANG_PARAM}=hr`));
      expect(tab.htmlLang).toBe('hr-HR');
      expect(tab.stored).toBe('hr');
    } finally {
      await close();
    }
  });

  it('leaves the other locale durable when its address is copied out', async () => {
    // "Copy link address" yields the `href` attribute and nothing else — no handler, no
    // referrer, no storage. So the href is fetched in a browser that has never seen the
    // site and prefers the other language, which is the only way to tell "the link named
    // the language" apart from "the visitor happened to be sent there anyway".
    const { page, close } = await visit(urlFor('/en/schedule'), { locale: FOREIGN_LOCALE });
    let copied: string;
    try {
      copied = (await switchHref(page, 'hr'))!;
    } finally {
      await close();
    }
    expect(copied).toBe(`${pagePath('/schedule')}?${LANG_PARAM}=hr`);

    const result = await landing({ from: `${host}${copied}`, locale: FOREIGN_LOCALE });
    expect(new URL(result.url).pathname).toBe(pagePath('/schedule'));
    expect(result.htmlLang).toBe('hr-HR');
    expect(result.stored).toBe('hr');
    expect(result.navigations).toBe(1);
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
 * MUSE-39 — `?lang=EN` is somebody asking for English, not a typo to be ignored.
 *
 * Matching was case-sensitive, so `EN`, `En` and `HR` all fell through as unrecognised.
 * That was *correct* under the rule above — an unrecognised value must not masquerade as a
 * decision — but `lang` is a parameter a human hand-types or hand-edits out of a shared
 * link, and falling through is invisible: no English, and no indication why.
 *
 * Folding cannot reintroduce MUSE-33's bug, because a folded value either names a locale
 * or still does not: `de` folds to `de` and is still nobody's language here. So the only
 * outcomes that change are the ones that were previously *unreachable* — no spelling in
 * MUSE-33's 240-case cross-product was anything but lowercase or `de`. The two axes gain
 * a mixed-case value below rather than this block standing alone, so the new spellings
 * compose with a stored choice and a browser preference rather than only being checked
 * in isolation.
 *
 * `toLowerCase`, not `toLocaleLowerCase`: the latter folds `I` to `ı` under a Turkish
 * locale, which would make `?lang=EN` work everywhere except in Turkey.
 */
describe('a hand-typed ?lang= is matched case-insensitively (MUSE-39)', () => {
  /** The walk the ticket asks for, in both browsers. */
  const SPELLINGS = ['en', 'EN', 'En', 'hr', 'HR', 'de'] as const;

  it('reads every spelling of a locale as that locale, and nothing else as one', async () => {
    const cases = SPELLINGS.flatMap((requested) =>
      [CROATIAN_LOCALE, FOREIGN_LOCALE].map((locale) => {
        const folded = requested.toLowerCase();
        const known = folded === 'hr' || folded === 'en';
        // Unfolded, this is a request. Unrecognised, it hands the decision to the
        // browser — which is the rule MUSE-33 established and this must not touch.
        const want = known ? folded : locale === CROATIAN_LOCALE ? 'hr' : 'en';
        return {
          requested,
          locale,
          label: `?${LANG_PARAM}=${requested} browser=${locale}`,
          want: {
            path: pagePath(want === 'en' ? '/en' : '/'),
            htmlLang: want === 'en' ? 'en' : 'hr-HR',
            // Only a request is recorded, and only ever in canonical lowercase.
            stored: known ? folded : null,
          },
        };
      }),
    );
    expect(cases.length).toBe(SPELLINGS.length * 2);

    const results = await inParallel(cases, 6, (c) =>
      landing({ from: urlFor('/', `?${LANG_PARAM}=${c.requested}`), locale: c.locale }),
    );

    for (const [index, result] of results.entries()) {
      const c = cases[index]!;
      expect(new URL(result.url).pathname, c.label).toBe(c.want.path);
      expect(result.htmlLang, c.label).toBe(c.want.htmlLang);
      expect(result.stored, c.label).toBe(c.want.stored);
      // Still one hop, whatever the spelling: the destination reads the same parameter
      // the same way, so there is nothing there to reconsider.
      expect(result.navigations, c.label).toBe(c.want.path === pagePath('/') ? 1 : 2);
    }
  });

  it('acts on a deep page for a mixed-case value, both directions', async () => {
    for (const [from, requested, to, stored] of [
      ['/schedule', 'EN', '/en/schedule', 'en'],
      ['/en/schedule', 'Hr', '/schedule', 'hr'],
    ] as const) {
      // The browser prefers the language the link is *not* asking for, so detection
      // cannot be what explains the outcome — and a deep page does not detect anyway.
      const locale = stored === 'en' ? CROATIAN_LOCALE : FOREIGN_LOCALE;
      const result = await landing({
        from: urlFor(from, `?${LANG_PARAM}=${requested}`),
        locale,
      });
      const where = `${from} ?${LANG_PARAM}=${requested}`;
      expect(new URL(result.url).pathname, where).toBe(pagePath(to));
      expect(result.stored, where).toBe(stored);
      expect(result.navigations, where).toBe(2);
    }
  });

  it('obeys a stored value whose case differs, and writes none back', async () => {
    // Where an uppercase stored value can come from: a hand-edited key, another tab, or a
    // build that predates the fold. It is matched, and it is *not* rewritten — the one
    // place this script writes is the `?lang=` branch above, which folds before storing,
    // so no uppercase value can originate here however the key is read.
    for (const [stored, locale, landed] of [
      ['EN', CROATIAN_LOCALE, '/en'],
      ['HR', FOREIGN_LOCALE, '/'],
    ] as const) {
      const result = await landing({ from: urlFor('/'), locale, storedLang: stored });
      const where = `stored=${stored} browser=${locale}`;
      expect(new URL(result.url).pathname, where).toBe(pagePath(landed));
      expect(result.navigations, where).toBe(landed === '/' ? 1 : 2);
      expect(result.stored, where).toBe(stored);
    }
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
  /**
   * `?lang=` values worth distinguishing: absent, each locale, a non-locale — and since
   * MUSE-39 a locale spelled in the wrong case, which is now a request like any other and
   * has to compose with the two signals below it rather than only be checked on its own.
   */
  const REQUESTED = [undefined, 'hr', 'en', 'de', 'EN'] as const;
  /** Stored values, on the same axis. */
  const STORED = [undefined, 'hr', 'en', 'de', 'HR'] as const;
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
    // Case-folded, because a locale named in any case is a locale named (MUSE-39). The
    // fold is *all* that changed: `de` folds to `de` and is still not an answer, so every
    // row that existed before this rule reads exactly as it did.
    const asked = requested?.toLowerCase();
    const remembered = stored?.toLowerCase();
    if (asked === 'hr' || asked === 'en') return asked;
    // Detection — the stored choice included — is the default locale's homepage only.
    if (!(here === 'hr' && route === '/')) return here;
    if (remembered === 'hr' || remembered === 'en') return remembered;
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

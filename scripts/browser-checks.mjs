import { chromium } from 'playwright';

/**
 * **How a browser check opens a page, and how it knows which page it opened.**
 *
 * MUSE-48. `/` client-side-redirects to `/en/` unless the browser's language is Croatian
 * (`src/lib/lang.ts`, MUSE-33 — correct, intended behaviour). Playwright, Puppeteer and a
 * plain headless Chromium all report `en-US`. So **any browser check that does not pin
 * the locale opens the Croatian homepage and silently measures the English one**, while
 * labelling its results `/`:
 *
 *   locale=en-US   final URL: …/MuseByMina/en/
 *   locale=hr-HR   final URL: …/MuseByMina/
 *
 * Croatian is the primary language and `/` is the canonical homepage, so the page our
 * tooling defaulted to never looking at was the most important one on the site. This is
 * not hypothetical: MUSE-35's QA measured an apparent double-download of two fonts on
 * `/`, was about to file it as a preload mismatch, and the real cause was the redirect
 * refetching. The same ticket's review contains a factual disagreement — four font faces
 * or six on `/` — in which both sides were right about the page they actually loaded.
 *
 * Two scripts already defended against it, with a hand-written `addInitScript` line each
 * and a comment above it explaining why. **That was the problem.** The defence was a line
 * every future author had to know to write, and a comment is not a mechanism — MUSE-17
 * was fixed three times as a naming convention and came back twice. So the rule moved
 * into the only door there is:
 *
 *   1. **One door that measures.** `openCheckPage` is how a check gets a page. It takes
 *      the route it intends to measure, derives the locale from that route, sets
 *      `navigator.language` **and** the `muse-lang` key to it, and **asserts after
 *      navigation that the URL it landed on is the URL it asked for.** Nothing is left
 *      for the caller to remember: the route is the intent, and asking for `/en/` is
 *      asking for English.
 *   2. **One door that does not**, `openRedirectProbe`, for the two suites whose subject
 *      *is* the redirect (`test/lang.test.ts`, `test/localeswitch.test.ts`). It performs
 *      no navigation and makes no assertion, it requires the browser language to be named
 *      rather than defaulted, and `scripts/` may not use it at all.
 *
 * The post-navigation assertion is the general half. `scripts/a11y.mjs` grew one by hand
 * after auditing the wrong page twice and `scripts/screenshot-themes.mjs` never had one;
 * it is now impossible to open a page for measurement without it, so it also catches the
 * *next* redirect that moves a check somewhere it did not intend to go, whatever that
 * redirect turns out to be about.
 *
 * **This module owns Playwright for the checks.** `scripts/` may not import it, and no
 * file in `scripts/` or `test/` may call `newContext`, `newPage`, `addInitScript` or
 * `setItem` — so a script or suite written next year cannot start a browser, or decide
 * what language it is measuring, without coming through here, and its author does not have
 * to know this ticket exists. `test/browserlocale.test.ts` discovers those files off the
 * two directories rather than from a list and fails if any of them opens a browser of its
 * own. Reading the stored language is fine, and several suites do; the write is what this
 * owns, because a write is a decision about which page is being measured.
 *
 * It lives in `scripts/` beside `scripts/dist-origin.mjs` rather than in `test/helpers/`
 * for the reason MUSE-52 moved `resolveRequest` the same way: **a `.mjs` script cannot
 * import a `.ts` helper**, and the browser gates are `.mjs`. The suites import it from
 * here, which is the direction that works; the JSDoc types below are what they get.
 */

/**
 * The browser language each locale is measured as.
 *
 * `navigator.languages` is what `langInitScript` reads, and a Playwright context `locale`
 * is the only honest way to set it — overriding the property from an init script would
 * mean every check measured our stub of a browser rather than a browser. The tag is
 * therefore a real one a visitor could have.
 *
 * `en-US` for English because that is what the automation defaults to anyway: pinning it
 * changes nothing for `/en/` and is written down so the English case is a decision rather
 * than an accident. Region is deliberately not load-bearing — every `Intl` format on this
 * site is computed at build time with an explicit locale (`src/lib/dates.ts`,
 * `src/lib/pricing.ts`), so `en-GB` and `en-US` measure the same page.
 *
 * Keyed by the site's own locales. `test/browserlocale.test.ts` asserts these keys are
 * exactly `LOCALES` from `src/lib/i18n.ts` and that each tag names its own locale, so a
 * third locale arrives here as a failing test rather than as an untagged default.
 *
 * @type {Record<string, string>}
 */
export const NAVIGATOR_LOCALE = {
  hr: 'hr-HR',
  en: 'en-US',
};

/**
 * The locale a check measures when its route does not say otherwise.
 *
 * Croatian, because `/` *is* the Croatian homepage — so a check that names no locale
 * measures the page it named, which is the whole acceptance criterion. Pinned against
 * `DEFAULT_LOCALE` in `src/lib/i18n.ts` by `test/browserlocale.test.ts`.
 */
export const DEFAULT_CHECK_LOCALE = 'hr';

/** The key `src/lib/lang.ts` stores a chosen language under. */
const LANG_KEY = 'muse-lang';

/**
 * What a measured page turned out to be.
 *
 * @typedef {object} Measured
 * @property {string} url The URL the browser ended on — not the one that was requested.
 * @property {string} locale The locale the check pinned itself to.
 * @property {string | null} lang The `<html lang>` the page actually served.
 */

/**
 * A page opened for measurement.
 *
 * @typedef {object} CheckPage
 * @property {import('playwright').BrowserContext} context
 * @property {import('playwright').Page} page
 * @property {import('playwright').Response | null} response
 * @property {Measured} measured
 * @property {() => Promise<void>} close
 */

/**
 * A context for observing where the redirect goes. No page is navigated and nothing is
 * asserted.
 *
 * @typedef {object} RedirectProbe
 * @property {import('playwright').BrowserContext} context
 * @property {import('playwright').Page} page
 * @property {() => Promise<void>} close
 */

/**
 * Anything that can name the URL of a route — `openSite()`'s `Site`, the suites'
 * `Preview`, `test/fonts.test.ts`'s `Environment`.
 *
 * Typed as just this one method on purpose: a check should not be able to reach past it
 * to an origin and join a URL itself, because joining the URL by hand is how the
 * trailing slash got lost in MUSE-9.
 *
 * @typedef {{ url: (route: string) => string }} RouteSource
 */

/**
 * The locale a route is in. `/en/schedule` → `en`; `/`, `''`, `schedule/` → `hr`.
 *
 * Read off the route rather than taken as an argument, because the route *is* the intent:
 * a check that asks for `/en/` is asking for the English page, and one that asks for
 * anything else is asking for the Croatian one. Leading and trailing slashes are
 * irrelevant, so `'en/'` and `'/en'` answer the same — the three route sources above
 * spell them differently and none of them should have to care.
 *
 * @param {string} route
 * @returns {string}
 */
export function localeOfRoute(route) {
  const first = String(route).split(/[/?#]/).filter(Boolean)[0];
  return first !== undefined && first in NAVIGATOR_LOCALE ? first : DEFAULT_CHECK_LOCALE;
}

/**
 * One line naming the page a check measured, for the check's own output.
 *
 * MUSE-48's fourth criterion: the page actually measured has to be *in the log*, so a
 * mismatch between intent and reality is visible to a reader rather than only to whoever
 * thinks to re-run with a different locale. The `<html lang>` is in it because that is
 * the page saying which language it is, independently of the URL it was asked for.
 *
 * @param {Measured} measured
 * @returns {string}
 */
export function describeMeasured({ url, locale, lang }) {
  return `${new URL(url).pathname}  locale=${locale}  lang=${lang ?? '—'}`;
}

/**
 * Launch the browser every check drives.
 *
 * Here rather than in each script so that `scripts/` never imports Playwright at all —
 * which is what makes "every check comes through this module" a property of the import
 * graph instead of a convention. `test/browserlocale.test.ts` enforces it.
 *
 * @param {Parameters<typeof chromium.launch>[0]} [options]
 * @returns {Promise<import('playwright').Browser>}
 */
export function launchChecks(options) {
  return chromium.launch(options);
}

/**
 * The browser language tag for a locale, or a failure naming what is missing.
 *
 * @param {string} locale
 * @returns {string}
 */
function navigatorLocaleFor(locale) {
  const tag = NAVIGATOR_LOCALE[locale];
  if (tag === undefined) {
    throw new Error(
      `No browser language is defined for locale "${locale}". ` +
        `Add it to NAVIGATOR_LOCALE in scripts/browser-checks.mjs — ` +
        `a check cannot pin itself to a locale it has no browser for.`,
    );
  }
  return tag;
}

/**
 * Open a page to measure `route` on `site`, as a visitor of that route's language.
 *
 * Both halves of the pin are set, because the redirect reads both and either one alone
 * leaves a hole: `navigator.languages` is what a first-time visitor is routed on, and a
 * stored `muse-lang` outranks it (MUSE-33), so a check whose browser is Croatian but
 * whose storage says `en` would still be moved. The storage write is unconditional and
 * runs on every navigation in the context, so a check that clicks through to a second
 * page keeps its pin.
 *
 * Then the landing URL is compared with the requested one and a mismatch throws. That
 * assertion — not the pin — is the part that generalises: the pin knows about one
 * redirect, and the assertion knows that a check must measure the page it named.
 *
 * @param {import('playwright').Browser} browser
 * @param {RouteSource} site
 * @param {string} route
 * @param {object} [options]
 * @param {string} [options.locale] Override the locale derived from `route`. For the rare
 *   check that wants a page in a browser of the other language; the URL assertion still
 *   holds, so it cannot be used to make a redirect quiet.
 * @param {Record<string, string>} [options.storage] Extra `localStorage` to seed, written
 *   before anything on the page runs — how `scripts/screenshot-themes.mjs` sets a stored
 *   theme. `muse-lang` is always set and cannot be overridden from here.
 * @param {(page: import('playwright').Page, url: string) => Promise<void> | void} [options.prepare]
 *   Runs on the page before navigation, for the listeners and route interceptions that
 *   have to be installed before the first byte arrives.
 * @param {'load' | 'domcontentloaded' | 'networkidle' | 'commit'} [options.waitUntil]
 * @param {import('playwright').BrowserContextOptions} [options.context] Everything else
 *   Playwright takes — viewport, colour scheme, device scale, `javaScriptEnabled`.
 * @returns {Promise<CheckPage>}
 */
export async function openCheckPage(browser, site, route, options = {}) {
  const {
    locale = localeOfRoute(route),
    storage = {},
    prepare,
    waitUntil = 'networkidle',
    context: contextOptions = {},
  } = options;

  const url = site.url(route);
  const context = await browser.newContext({
    ...contextOptions,
    // After the spread, not before: the pin is the one option a caller may not quietly
    // override with a raw `context: { locale }`, because that would be this bug with the
    // door's name on it.
    locale: navigatorLocaleFor(locale),
  });

  try {
    await context.addInitScript(
      (/** @type {[string, string][]} */ entries) => {
        for (const [key, value] of entries) {
          try {
            localStorage.setItem(key, value);
          } catch {
            // A blocked localStorage is not this check's problem to report.
          }
        }
      },
      [...Object.entries(storage), [LANG_KEY, locale]],
    );

    const page = await context.newPage();
    if (prepare) await prepare(page, url);

    const response = await page.goto(url, { waitUntil });
    const landed = page.url();

    if (new URL(landed).pathname !== new URL(url).pathname) {
      throw new Error(
        [
          `A check asked for ${url} and landed on ${landed}.`,
          '',
          `  requested  ${new URL(url).pathname}`,
          `  measured   ${new URL(landed).pathname}`,
          `  pinned to  ${locale} (navigator.language=${navigatorLocaleFor(locale)}, ` +
            `${LANG_KEY}=${locale})`,
          '',
          REDIRECT_ADVICE,
        ].join('\n'),
      );
    }

    return {
      context,
      page,
      response,
      measured: {
        url: landed,
        locale,
        lang: await page.getAttribute('html', 'lang'),
      },
      close: () => context.close(),
    };
  } catch (problem) {
    await context.close();
    throw problem;
  }
}

/**
 * What to do about a landing that is not the page that was asked for. Worth spelling out
 * at the point of failure: a redirect leaves a perfectly healthy page on screen, so the
 * natural reading of the failure is that the check is broken.
 */
const REDIRECT_ADVICE = [
  'MUSE-48: a check must measure the page it names. Something redirected this one, and',
  'whatever it measured would have been reported under the URL above. If the redirect is',
  'correct and the other page is what you want, ask for that route instead — asking for',
  '/en/ is how a check asks for English. If the redirect is new, it is the finding.',
].join('\n');

/**
 * A context for watching where the language redirect takes a browser.
 *
 * The deliberate, named opt-out from everything above, for the two suites whose subject is
 * the redirect itself: nothing is navigated here and no landing is asserted, because where
 * the browser ends up is the thing under test. `scripts/` may not use it — a check that
 * measures a page has no business with a door that does not check where it landed, and
 * `test/browserlocale.test.ts` enforces that.
 *
 * `navigatorLocale` is required rather than defaulted. The whole bug is a browser language
 * that nobody chose, so the one door that does not pin one has to be handed it.
 *
 * `storedLang` seeds `muse-lang` **only when the key is absent**, which is the opposite of
 * the pin above and is why it lives here: an init script runs again on every navigation,
 * so an unconditional write would reinstate the seeded value on the page the redirect
 * lands on and hide the write the page we came from had just made (MUSE-33).
 *
 * @param {import('playwright').Browser} browser
 * @param {object} options
 * @param {string} options.navigatorLocale The language this browser reports, e.g. `en-US`.
 * @param {string} [options.storedLang] A language already stored from an earlier visit.
 * @param {import('playwright').BrowserContextOptions} [options.context]
 * @returns {Promise<RedirectProbe>}
 */
export async function openRedirectProbe(
  browser,
  { navigatorLocale, storedLang, context: contextOptions = {} },
) {
  if (typeof navigatorLocale !== 'string' || navigatorLocale === '') {
    throw new Error(
      'openRedirectProbe needs the browser language it is probing with. The default is ' +
        'the bug (MUSE-48) — name it, e.g. { navigatorLocale: "en-US" }.',
    );
  }

  const context = await browser.newContext({
    ...contextOptions,
    // Last, as in `openCheckPage`: the browser language this probe was handed is the
    // whole point of it and is not a default to be overridden from the side.
    locale: navigatorLocale,
  });

  try {
    if (storedLang !== undefined) {
      await context.addInitScript(
        (/** @type {[string, string]} */ [key, value]) => {
          try {
            if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
          } catch {
            // As above: a blocked localStorage is not this probe's finding.
          }
        },
        [LANG_KEY, storedLang],
      );
    }

    const page = await context.newPage();
    return { context, page, close: () => context.close() };
  } catch (problem) {
    await context.close();
    throw problem;
  }
}

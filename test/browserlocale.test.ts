import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  describeMeasured,
  launchChecks,
  localeOfRoute,
  NAVIGATOR_LOCALE,
  openCheckPage,
  openRedirectProbe,
  DEFAULT_CHECK_LOCALE,
} from '../scripts/browser-checks.mjs';
import { DEFAULT_LOCALE, LOCALES } from '../src/lib/i18n';
import { LANG_STORAGE_KEY } from '../src/lib/lang';
import { PREVIEW_BASE, startPreview, type Preview } from './helpers/preview';

/**
 * MUSE-48 — a browser check measures the page it names, or says so.
 *
 * `/` client-side-redirects to `/en/` unless the browser's language is Croatian
 * (`src/lib/lang.ts`, MUSE-33 — correct behaviour, and out of scope here). Playwright,
 * Puppeteer and a plain headless Chromium all report `en-US`. So every browser check that
 * did not pin the locale opened the Croatian homepage and measured the English one while
 * labelling its results `/` — and the Croatian homepage is the site's primary page, which
 * made it the one page the tooling defaulted to never looking at.
 *
 * MUSE-35's QA hit this in its own first run: it measured an apparent double-download of
 * two fonts on `/`, nearly filed it as a preload mismatch, and the real cause was the
 * redirect refetching. The same ticket's review contains a disagreement about whether `/`
 * needs four font faces or six, in which both measurements were right about the page they
 * actually loaded.
 *
 * Two scripts already defended against it with a hand-written `addInitScript` line each.
 * **That was the bug this file is about** — the defence was a line every future author had
 * to know to write, and MUSE-17 was fixed three times as a convention and came back twice.
 * So the two halves below are the two halves of the fix:
 *
 *   1. **The door.** `openCheckPage` derives the locale from the route, pins
 *      `navigator.language` *and* the stored language to it, and asserts after navigating
 *      that it landed where it asked. The assertion is the half that generalises — the pin knows
 *      about one redirect, the assertion knows a check must measure the page it named.
 *   2. **The guards.** No file under `scripts/` or `test/` may open a browser context of
 *      its own, so a script or suite written next year inherits all of it without its
 *      author having to know any of this. Discovered off the directories, not from a list.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

let browser: Browser;
let preview: Preview;

beforeAll(async () => {
  [preview, browser] = await Promise.all([startPreview('browserlocale'), launchChecks()]);
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await preview?.close();
});

/** What the page says it is, independently of the URL it was asked for. */
async function served(page: import('playwright').Page): Promise<{
  pathname: string;
  lang: string | null;
  navigator: string;
  stored: string | null;
}> {
  return {
    pathname: new URL(page.url()).pathname,
    lang: await page.getAttribute('html', 'lang'),
    navigator: await page.evaluate(() => navigator.language),
    stored: await page.evaluate((key) => localStorage.getItem(key), LANG_STORAGE_KEY),
  };
}

describe('the trap this exists for', () => {
  /**
   * Not a test of our code — a test that the hazard is real and still there. If this ever
   * goes green on `/`, the redirect has changed and everything below is defending against
   * something that no longer happens, which a reader deserves to be told.
   */
  it('a default-locale browser asking for / is taken to /en/', async () => {
    const probe = await openRedirectProbe(browser, { navigatorLocale: 'en-US' });
    try {
      await probe.page.goto(preview.url('/'), { waitUntil: 'networkidle' });
      expect(new URL(probe.page.url()).pathname).toBe('/MuseByMina/en/');
      expect(await probe.page.getAttribute('html', 'lang')).toBe('en');
    } finally {
      await probe.close();
    }
  });

  it('and that is the default every browser automation ships with', async () => {
    // The ticket's claim, checked rather than quoted: with nothing asked for, Chromium
    // reports `en-US`, which is precisely the branch that redirects.
    const probe = await openRedirectProbe(browser, { navigatorLocale: 'en-US' });
    try {
      await probe.page.goto(preview.url('/en'), { waitUntil: 'load' });
      expect(await probe.page.evaluate(() => navigator.language)).toBe('en-US');
    } finally {
      await probe.close();
    }
  });
});

describe('a check that asks for a page measures that page', () => {
  it('asks for / and gets the Croatian homepage', async () => {
    const open = await openCheckPage(browser, preview, '/');
    try {
      expect(await served(open.page)).toEqual({
        pathname: '/MuseByMina/',
        lang: 'hr-HR',
        navigator: 'hr-HR',
        stored: 'hr',
      });
      expect(open.response?.status()).toBe(200);
    } finally {
      await open.close();
    }
  });

  it('asks for /en and gets the English homepage', async () => {
    // The second acceptance criterion: a check that genuinely wants English asks for the
    // English route and gets it. The route is the whole request — there is no second
    // parameter to get wrong.
    const open = await openCheckPage(browser, preview, '/en');
    try {
      expect(await served(open.page)).toEqual({
        pathname: '/MuseByMina/en/',
        lang: 'en',
        navigator: 'en-US',
        stored: 'en',
      });
    } finally {
      await open.close();
    }
  });

  it('reads the locale off the route, however the route is spelled', () => {
    // The three route sources this is handed — `Site`, `Preview`, `Environment` — spell
    // the same route three ways, and none of them should have to care.
    for (const route of ['/', '', '/schedule', 'schedule/', '/contact', '/privacy']) {
      expect(localeOfRoute(route), route).toBe('hr');
    }
    for (const route of ['/en', 'en/', '/en/', '/en/schedule', 'en/schedule/']) {
      expect(localeOfRoute(route), route).toBe('en');
    }
  });

  it('pins a Croatian page reached from a deeper route too', async () => {
    const open = await openCheckPage(browser, preview, '/schedule');
    try {
      const page = await served(open.page);
      expect(page.pathname).toBe('/MuseByMina/schedule/');
      expect(page.navigator).toBe('hr-HR');
      expect(page.stored).toBe('hr');
    } finally {
      await open.close();
    }
  });

  it('keeps the pin across a navigation the check makes itself', async () => {
    // The storage write runs on every navigation in the context, not just the first. A
    // check that clicks a link to `/` from somewhere else must not lose the pin on the
    // way — that would be the same bug one page later.
    const open = await openCheckPage(browser, preview, '/schedule');
    try {
      await open.page.goto(preview.url('/'), { waitUntil: 'networkidle' });
      expect(new URL(open.page.url()).pathname).toBe('/MuseByMina/');
    } finally {
      await open.close();
    }
  });

  it('records the page it actually measured, URL and language both', async () => {
    // The fourth criterion: a mismatch between intent and reality has to be visible in
    // the output rather than only in a reviewer's head. `measured` is read from the page
    // after navigation — never from the request — which is what makes it worth printing.
    const open = await openCheckPage(browser, preview, '/');
    try {
      expect(open.measured.url).toBe(preview.url('/'));
      expect(open.measured.locale).toBe('hr');
      expect(open.measured.lang).toBe('hr-HR');

      const line = describeMeasured(open.measured);
      expect(line).toContain('/MuseByMina/');
      expect(line).toContain('hr-HR');
    } finally {
      await open.close();
    }
  });
});

/**
 * MUSE-55 — the one page whose route carries no locale.
 *
 * Everything above derives the pin from the route because the route is the intent. The
 * error page breaks that cleanly in half: it has **no locale in its path** (one
 * `404.html` for the whole deploy) and it is **bilingual markup** — one document, both
 * languages, no client-side selection, `localeTwin={false}` (MUSE-38). So "which locale
 * is this page" has no answer, and picking one would audit a bilingual page as though it
 * were monolingual.
 *
 * The decision is therefore to audit it **once per locale**, at the URL a visitor of each
 * language actually arrives at — `/MuseByMina/404` for a Croatian browser and
 * `/MuseByMina/en/404` for an English one, which are a 200 and a 404 respectively and are
 * both recorded host behaviours (`test/urls.test.ts`). The two assertions below are what
 * make that a decision rather than a sentence: each pin lands where it asked, and the two
 * get the *same bytes*, so neither pin is secretly selecting a language.
 */
describe('the bilingual error page has no locale in its path', () => {
  /**
   * The preview addressed at one exact URL path — the `Site.at` of
   * `scripts/dist-origin.mjs`, which exists because the error page's spelling is not a
   * directory's and `pagePath` must stay the only place a trailing slash is added
   * (MUSE-9).
   */
  const at = (path: string) => ({
    url: () => `${preview.origin}${path.slice(PREVIEW_BASE.length)}`,
  });

  const SPELLINGS = [
    { route: '/404', path: `${PREVIEW_BASE}/404`, status: 200, locale: 'hr' },
    { route: '/en/404', path: `${PREVIEW_BASE}/en/404`, status: 404, locale: 'en' },
  ] as const;

  it('is measured once per locale, each at the status the host answers', async () => {
    const bodies: string[] = [];
    for (const { route, path, status, locale } of SPELLINGS) {
      const open = await openCheckPage(browser, at(path), route);
      try {
        // Unslashed, and landed where it asked. `/MuseByMina/404/` is a 404 because it is
        // not a directory, which is correct and is not what gets fixed here.
        expect(new URL(open.page.url()).pathname, route).toBe(path);
        expect(open.response?.status(), route).toBe(status);
        // The pin comes off the route, same rule as every other page.
        expect(open.measured.locale, route).toBe(locale);
        expect(await open.page.evaluate(() => navigator.language), route).toBe(
          NAVIGATOR_LOCALE[locale],
        );
        bodies.push(await open.response!.text());
      } finally {
        await open.close();
      }
    }

    // And the pin is not choosing content: both locales are served the same document, so
    // auditing it twice is auditing two arrivals at one bilingual page rather than two
    // pages. The day that stops being true — a 404 that picks a language client-side is
    // exactly the second mechanism MUSE-38 refused — this is the test that says so.
    expect(bodies[0]).toBe(bodies[1]);
  });

  it('is reached by neither locale through the slashed spelling', async () => {
    // `site.url('/404')` produces this, and it is why the gate could not audit the page:
    // the request is legitimate, the body is the error page, and the status is 404.
    const open = await openCheckPage(browser, at(`${PREVIEW_BASE}/404/`), '/404');
    try {
      expect(open.response?.status()).toBe(404);
    } finally {
      await open.close();
    }
  });
});

describe('a check that lands somewhere else fails loudly', () => {
  /**
   * The general mechanism, tested against a redirect that has nothing to do with
   * language. `scripts/a11y.mjs` grew an assertion like this by hand after auditing the
   * wrong page twice, and `screenshot-themes.mjs` never had one; it is now in the only
   * door there is, so the *next* redirect is caught by the same thing.
   */
  async function redirected(route: string, to: string): Promise<Error> {
    const problem = await openCheckPage(browser, preview, route, {
      prepare: async (page, url) => {
        await page.route(url, (interception) =>
          interception.fulfill({ status: 302, headers: { location: preview.url(to) } }),
        );
      },
    }).then(
      (open) => open.close().then(() => null),
      (e: unknown) => e as Error,
    );
    expect(problem, `${route} was not supposed to resolve`).toBeTruthy();
    return problem!;
  }

  it('names both URLs and the locale it pinned', async () => {
    const problem = await redirected('/', '/en');
    expect(problem.message).toContain(preview.url('/'));
    expect(problem.message).toContain('/MuseByMina/en/');
    expect(problem.message).toContain('hr-HR');
    // And says what to do about it, because a redirect leaves a healthy-looking page on
    // screen and the natural reading of the failure is that the check is broken.
    expect(problem.message).toContain('MUSE-48');
  });

  it('leaves no context behind when it fails', async () => {
    // A throw from inside the door must not leak the browser it opened, or a suite that
    // asserts on a failure slowly fills the machine with contexts.
    const before = browser.contexts().length;
    // Between two pages that do not redirect on their own, so what is being measured is
    // the door's own cleanup rather than a hop the site would have made anyway.
    await redirected('/schedule', '/contact');
    expect(browser.contexts().length).toBe(before);
  });
});

describe('the locale it pins is the site’s own', () => {
  it('covers exactly the locales the site has', () => {
    // Not a copy of the list — the list. A third locale added to `src/lib/i18n.ts` has to
    // arrive here as a failing test, because otherwise it silently gets the default
    // browser language and the whole class of bug is back for that locale only.
    expect(Object.keys(NAVIGATOR_LOCALE).sort()).toEqual([...LOCALES].sort());
    expect(DEFAULT_CHECK_LOCALE).toBe(DEFAULT_LOCALE);
  });

  it('gives each locale a browser language that names it', () => {
    for (const [locale, tag] of Object.entries(NAVIGATOR_LOCALE)) {
      expect(tag, locale).toMatch(new RegExp(`^${locale}\\b`, 'i'));
    }
  });

  it('cannot have the pin overridden by a raw context option', async () => {
    // `context` is a passthrough to Playwright, so `locale` is reachable from there. If a
    // caller could set it, the bug would be back with the door's name on it — the one
    // option the passthrough does not carry.
    const open = await openCheckPage(browser, preview, '/', {
      context: { locale: 'en-US' } as { locale: string },
    });
    try {
      const page = await served(open.page);
      expect(page.navigator).toBe('hr-HR');
      expect(page.pathname).toBe('/MuseByMina/');
    } finally {
      await open.close();
    }
  });

  it('refuses a locale it has no browser language for', async () => {
    await expect(openCheckPage(browser, preview, '/', { locale: 'de' })).rejects.toThrow(
      /NAVIGATOR_LOCALE/,
    );
  });

  it('makes the probe door name its browser language rather than default it', async () => {
    // The one door that does not pin anything is the one that may not be handed a
    // default: the whole bug is a browser language nobody chose.
    await expect(openRedirectProbe(browser, {} as { navigatorLocale: string })).rejects.toThrow(
      /MUSE-48/,
    );
  });
});

/**
 * The guards. The door above is only worth its tests if nothing can open a browser
 * without it — including a script or suite written a year from now by somebody who has
 * never read this file.
 */
describe('nothing can open a browser context of its own', () => {
  /**
   * Strings the guards search for, assembled rather than written out.
   *
   * This file is itself a browser-driving file and is checked by the loops below, so a
   * forbidden token spelled literally in an assertion would be found in this file's own
   * source and fail its own guard. Same trick, for the same reason, as
   * `test/origin.test.ts`'s `process.env.${'ORIGIN'}`.
   */
  const FORBIDDEN = {
    newContext: `new${'Context('}`,
    newPage: `new${'Page('}`,
    initScript: `add${'InitScript('}`,
    setItem: `set${'Item('}`,
    launch: `chro${'mium'}`,
  };

  /**
   * Every file in `dir` that drives a browser, read off the directory rather than listed.
   *
   * A file qualifies by **importing** Playwright or this module, which between them are
   * the only two places a browser can come from — so a new script or suite is covered by
   * the loops below the day it is written, with nobody having to add it here. Matched as
   * an import rather than as a mention, because `test/origin.test.ts` names this module in
   * a string (it discovers the same scripts from the other side) and drives no browser at
   * all. `scripts/browser-checks.mjs` is the module the rules are *about*, and is the one
   * exclusion.
   */
  function browserFiles(dir: string, extension: string): string[] {
    const imports = /from ['"](playwright|[^'"]*browser-checks\.mjs)['"]/;
    return readdirSync(join(ROOT, dir))
      .filter((file) => file.endsWith(extension))
      .filter((file) => `${dir}/${file}` !== 'scripts/browser-checks.mjs')
      .filter((file) => imports.test(readFileSync(join(ROOT, dir, file), 'utf8')))
      .map((file) => `${dir}/${file}`)
      .sort();
  }

  const scripts = (): string[] => browserFiles('scripts', '.mjs');
  const suites = (): string[] => browserFiles('test', '.ts');
  const source = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

  /**
   * Where `needle` appears in `file`, as `file:line`, or `[]`.
   *
   * `expect(source(file)).not.toContain(needle)` is the same rule and prints the **whole
   * file** as its diff — 150 lines of `scripts/a11y.mjs`, inside which the planted
   * context call is one line nothing points at, with a stray comment landing at the top of
   * the excerpt as the only visible context (MUSE-77). The needle and the file name were in
   * the message; the offending line was not. Every other guard in this repository names
   * `file:line`, so this one does too.
   *
   * And note why the sentence above does not quote the token: this file is itself checked
   * by the loops below, so a forbidden string spelled literally in prose here fails its own
   * guard. Measured — that is how the first draft of this comment reddened the run.
   */
  function occurrences(file: string, needle: string): string[] {
    return source(file)
      .split('\n')
      .flatMap((line, index) => (line.includes(needle) ? [`${file}:${index + 1}`] : []));
  }

  it('finds every browser check and browser suite there is', () => {
    // The loops below are `for` loops over these lists. A discovery that silently stops
    // matching does not fail them — it makes them pass over nothing, which is the exact
    // shape of "a check that confirms the wrong thing" this ticket is an instance of. So
    // the discovery is asserted before anything is asserted with it.
    expect(scripts()).toEqual([
      'scripts/a11y.mjs',
      'scripts/budget.mjs',
      'scripts/schedule-ux.mjs',
      'scripts/screenshot-themes.mjs',
    ]);
    expect(suites()).toEqual([
      'test/browserlocale.test.ts',
      'test/budget.test.ts',
      'test/contact.test.ts',
      'test/fonts.test.ts',
      'test/gallery.test.ts',
      'test/lang.test.ts',
      'test/localeswitch.test.ts',
      'test/numerals.test.ts',
      'test/trialform.test.ts',
    ]);
  });

  it('lets none of them build a context, a page or an init script', () => {
    for (const file of [...scripts(), ...suites()]) {
      // Opening a context is where the locale is decided, and deciding it by omission is
      // the bug. One module opens them.
      expect(occurrences(file, FORBIDDEN.newContext), file).toEqual([]);
      expect(occurrences(file, FORBIDDEN.newPage), file).toEqual([]);
      // Seeding storage by hand is how the two defended scripts defended themselves —
      // a line each, that nothing made the third script copy. Both ways in are closed:
      // an init script, and a `setItem` from the page once it is open. Reading the key is
      // fine and several suites do it — what the module owns is the write, because a
      // write is a decision about which language the page is being measured as.
      expect(occurrences(file, FORBIDDEN.initScript), file).toEqual([]);
      expect(occurrences(file, FORBIDDEN.setItem), file).toEqual([]);
    }
  });

  it('lets none of them launch a browser for itself', () => {
    for (const file of [...scripts(), ...suites()]) {
      expect(occurrences(file, FORBIDDEN.launch), file).toEqual([]);
    }
  });

  it('keeps Playwright itself out of the scripts', () => {
    for (const file of scripts()) {
      const text = source(file);
      // Not a style rule: with no import of Playwright in `scripts/`, "every check comes
      // through the door" is a property of the import graph rather than a convention
      // anybody has to uphold. `@axe-core/playwright` is a different package and stays.
      expect(text, file).not.toMatch(/from ['"]playwright['"]/);
      expect(text, file).toContain('browser-checks.mjs');
      expect(text, file).toContain('openCheckPage');
    }
  });

  it('makes every check record the page it measured', () => {
    for (const file of scripts()) {
      // The fourth criterion, enforced rather than requested: a check's output has to name
      // the page it actually measured, so a mismatch is visible in the log.
      expect(source(file), file).toContain('describeMeasured');
    }
  });

  it('keeps the unasserted door out of the checks entirely', () => {
    for (const file of scripts()) {
      // `openRedirectProbe` makes no landing assertion, by design, for the two suites
      // whose subject is the redirect. A check that measures a page has no business with
      // it — and leaving it reachable would leave the bypass this whole file closes.
      expect(source(file), file).not.toContain('openRedirectProbe');
    }
  });
});

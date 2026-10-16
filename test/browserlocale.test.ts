import { readFileSync } from 'node:fs';
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
import { LANG_PARAM, LANG_STORAGE_KEY } from '../src/lib/lang';
import {
  scriptFiles,
  scriptsPackageJsonRuns,
  suiteFiles,
  testTreeFiles,
  vitestFileGlobs,
} from './helpers/discovery';
import { PREVIEW_BASE, startPreview, type Preview } from './helpers/preview';
import {
  BROWSER_DOOR,
  browserOwnership,
  callsOf,
  drivesBrowser,
  importsOf,
  listed,
} from './helpers/source-guard';

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

  it('refuses a landing whose ?lang= is not the one it asked for', async () => {
    // MUSE-107. The comparison was the pathname alone, so a redirect that changed only the
    // query resolved — and `?lang=` is not just any query: it is what `src/lib/lang.ts`
    // routes language on, so the page was measured under a language instruction the check
    // never gave. The path really can be unchanged while it happens, which is why the
    // pathname comparison could not see it: `?lang=hr` on the Croatian page redirects
    // nowhere, it is simply obeyed.
    const redirectWithLanguage = {
      prepare: async (page: import('playwright').Page, url: string) => {
        await page.route(url, async (hit) => {
          await hit.fulfill({
            status: 302,
            headers: { location: `${url}?${LANG_PARAM}=hr` },
          });
        });
      },
    };

    const problem = await openCheckPage(browser, preview, '/schedule', redirectWithLanguage)
      .then((open) => open.close().then(() => null))
      .catch((error: Error) => error);

    expect(
      problem,
      'a 302 adding ?lang= to the same path was accepted — the page was measured under a ' +
        'language nobody asked for (MUSE-107)',
    ).not.toBeNull();
    // Both sides named, the way every other refusal in this tree names them.
    expect(problem?.message).toContain(`requested  /MuseByMina/schedule/  ?${LANG_PARAM}=(none)`);
    expect(problem?.message).toContain(`measured   /MuseByMina/schedule/  ?${LANG_PARAM}=hr`);
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
   * Which of `candidates` drive a browser, read off the tree rather than listed.
   *
   * A file qualifies by **importing** Playwright or this module, which between them are
   * the only two places a browser can come from — so a new script or suite is covered by
   * the loops below the day it is written, with nobody having to add it here. Matched as
   * an import rather than as a mention, because `test/origin.test.ts` names this module in
   * a string (it discovers the same scripts from the other side) and drives no browser at
   * all. `scripts/browser-checks.mjs` is the module the rules are *about*, and is the one
   * exclusion.
   *
   * **The candidates come from `test/helpers/discovery.ts`, and that is the fix MUSE-96
   * is.** This function used to do its own discovery with a flat `readdirSync` of one
   * directory, while vitest loads `test/**\/*.test.ts` — so `test/sub/ghost.test.ts`,
   * which launched Playwright itself and opened a context with a locale on it, ran as a
   * test and was invisible to every loop below. The hole was purely directory depth and
   * it defeated MUSE-48's pin and MUSE-68's census at once. The lists are now recursive
   * and the shape of each one is asserted against the tool that loads it, below.
   *
   * **And the question is asked of a parser, which is the fix MUSE-107 is** (`drivesBrowser`
   * in `test/helpers/source-guard.ts`). The predicate here was
   * `/from ['"](playwright|[^'"]*browser-checks\.mjs)['"]/` — a model of an *import
   * statement*, which `await import('play' + 'wright')` is not: a probe written that way
   * opened a context with a locale on it, measured `/en/` while reporting `/`, and no rule
   * in this file applied to the file at all, because discovery never reached it. Demonstrated
   * end to end before it was fixed.
   */
  function browserFiles(candidates: readonly string[]): string[] {
    return candidates
      .filter((file) => file !== BROWSER_DOOR)
      .filter((file) => drivesBrowser(file))
      .sort();
  }

  const scripts = (): string[] => browserFiles(scriptFiles());
  const suites = (): string[] => browserFiles(testTreeFiles());
  const source = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

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
      // Not a suite, and that is the point of widening the scan beyond `test/*.ts`: it
      // imports Playwright for its types and the old flat scan never read it (MUSE-96).
      'test/helpers/browser-settle.ts',
      'test/lang.test.ts',
      'test/localeswitch.test.ts',
      'test/numerals.test.ts',
      'test/trialform.test.ts',
    ]);
  });

  /**
   * **The discovery is a model of vitest's glob, so it is pinned to vitest's glob**
   * (MUSE-96).
   *
   * `suites()` walks `test/` recursively for `.ts`. That states the *meaning* of
   * `include`, and it is a model: the honest evaluator of a glob is vitest's own matcher,
   * which vitest exposes to a test only by standing up a second vitest. So the model is
   * compared with what vitest actually resolves, the way `prerenderStagingDir` is
   * compared with `getOutDirWithinCwd` (MUSE-41) — because a model nothing compares to
   * the thing it models is a second opinion, not a guard.
   *
   * Two claims, and the second is the one with teeth: the walk reaches **every file
   * vitest loads**, and `include` is still a pattern the walk's shape covers. Widen
   * `include` to `src/**\/*.test.ts` and this fails naming the pattern, rather than the
   * loops above quietly passing over a directory.
   */
  it('reaches every file vitest loads, and says so against vitest', async () => {
    const { include, exclude } = await vitestFileGlobs();

    expect(include).toEqual(['test/**/*.test.ts']);
    expect(testTreeFiles()).toEqual(expect.arrayContaining(suiteFiles()));
    expect(suiteFiles().length).toBeGreaterThan(30);
    // Nothing under `test/` may be excluded from the run, or the walk would claim files
    // vitest never loads — the opposite error, and the one that makes a guard noisy
    // rather than blind.
    expect(exclude.filter((pattern) => pattern.includes('test/'))).toEqual([]);
  });

  /**
   * **And the scripts' discovery is a model of `node <path>`, pinned to `package.json`.**
   *
   * There is no list to obtain for `scripts/`: a module there is loaded because an npm
   * script, a workflow step or a person names its path. So the walk claims that anything
   * `.mjs` under `scripts/` is loadable — the widest honest reading — and the pin is that
   * every script `package.json` really runs is in it.
   */
  it('reaches every script package.json runs', () => {
    const runnable = scriptFiles();
    const run = scriptsPackageJsonRuns();

    expect(run.length).toBeGreaterThan(5);
    expect(runnable).toEqual(expect.arrayContaining(run));
  });

  /**
   * **One assertion over every file, and it names every call it found** (MUSE-107).
   *
   * This was four `expect`s per rule inside a `for` loop over two lists, and `expect`
   * short-circuits: a file with all five tokens planted in it reported the first two and
   * named neither of them — the message was the needle and the file, and the needle was
   * assembled from fragments so the guard would not report its own prose. Reporting every
   * offence is not tidiness: the first two told the author their fix was complete.
   *
   * `browserOwnership` states the rule against the **callee**, so a comment that names one
   * of these calls is not one, a computed member is folded to the name it computes, and the
   * reason each name is owned travels with the failure.
   */
  it('lets none of them open a browser, a context, a page or an init script', () => {
    // Opening a context is where the locale is decided, and deciding it by omission is the
    // bug — one module opens them. Seeding storage by hand is how the two defended scripts
    // defended themselves, a line each that nothing made the third script copy, so both
    // ways in are closed: an init script, and a `setItem` from the page once it is open.
    // Reading the key is fine and several suites do it; what the module owns is the write,
    // because a write is a decision about which language the page is being measured as.
    const offences = [...scripts(), ...suites()].flatMap((file) => browserOwnership(file));

    expect(listed(offences)).toEqual([]);
  });

  /**
   * The rules as rules, handed the two evasions MUSE-107 demonstrated.
   *
   * As strings rather than as fixtures on disk, which is how `test/isolation.test.ts` tests
   * the rest of this parser: a file under `test/` that deliberately breaks the rules is a
   * worse problem than the one it solves. And a string is why these probes can spell the
   * forbidden names at all — a literal is not a call, which is the whole reason MUSE-34
   * made these rules read syntax instead of text.
   */
  it('discovers a file that obtains Playwright by an assembled dynamic import', () => {
    const probe = "const { chromium } = await import('play' + 'wright');";

    expect(drivesBrowser('probe.ts', probe)).toBe(true);
    // And the token rules therefore apply to it, which is the half that was lost: the
    // bypass was not that the import was allowed, it was that no rule was ever reached.
    expect(listed(browserOwnership('probe.ts', `${probe}\nawait chromium.launch();`))).toHaveLength(
      1,
    );
  });

  it('reads a launcher taken off a namespace import', () => {
    // MUSE-113. `import * as` recorded an entry with no imported name, so the launcher
    // rule above — which is keyed on that name — went quiet, and the property read is the
    // only place the launcher is spelled in code. `drivesBrowser` never had the hole,
    // because it is keyed on the *module*; this rule is the one that did.
    const probe = ["import * as pw from 'playwright';", 'const launcher = pw.chromium;'].join(
      '\n',
    );

    expect(drivesBrowser('probe.ts', probe)).toBe(true);
    expect(listed(browserOwnership('probe.ts', probe))).toHaveLength(1);
    expect(listed(browserOwnership('probe.ts', probe))[0]).toContain('chromium');
  });

  it('fires on a forbidden call written as a computed member', () => {
    const probe = "const context = await browser['new' + 'Context']({ locale: 'en-US' });";
    const [offence] = browserOwnership('probe.ts', probe);

    expect(offence?.line).toBe(1);
    expect(listed(browserOwnership('probe.ts', probe))[0]).toContain('newContext');
  });

  it('reports every forbidden call in one file, each naming the call it found', () => {
    const probe = [
      "const context = await browser.newContext({ locale: 'en-US' });",
      'const page = await context.newPage();',
      'await context.addInitScript(() => {});',
      "await page.evaluate(() => localStorage.setItem('muse-lang', 'en'));",
      'const second = await chromium.launch();',
    ].join('\n');

    const found = listed(browserOwnership('test/somewhere.test.ts', probe));

    expect(found).toHaveLength(5);
    for (const [index, call] of [
      'newContext',
      'newPage',
      'addInitScript',
      'setItem',
      'launch',
    ].entries()) {
      expect(found[index], call).toContain(`test/somewhere.test.ts:${index + 1}`);
      expect(found[index], call).toContain(call);
    }
  });

  it('does not fire on prose, on a string, or on reading the stored language', () => {
    // The false positive that made the textual scan assemble its needles from fragments.
    // This file, `scripts/browser-checks.mjs` and `test/helpers/discovery.ts` all name
    // these calls in prose because that is where the rule is explained, and a guard that
    // failed on the explanation would get the explanation deleted.
    const prose = [
      '/** A check may not call newContext, newPage, addInitScript or setItem. */',
      "const named = 'newContext';",
      'const stored = localStorage.getItem(KEY);',
      'const browser = await launchChecks();',
    ].join('\n');

    expect(browserOwnership('probe.ts', prose)).toEqual([]);
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
      // `openRedirectProbe` makes no landing assertion, by design, for the suites whose
      // subject is the redirect. A check that measures a page has no business with it —
      // and leaving it reachable would leave the bypass this whole file closes.
      expect(source(file), file).not.toContain(PROBE);
    }
  });

  /**
   * **The door that asserts nothing is a named list of callers, with a reason each**
   * (MUSE-107).
   *
   * `openRedirectProbe` is exported, correct, and makes no landing assertion by design —
   * so it is the realistic version of every bypass this file is about, and it cannot be
   * closed by a scan: there is no token to plant and no file to discover. A suite written
   * next year imports the sanctioned module, opens `/`, lands on `/en/` and labels it `/`,
   * and every guard above stays green. `scripts/` was forbidden it; nothing pinned the
   * suites.
   *
   * So the instrument is a list, and a list in this repository gets the
   * `test/contentdrift.test.ts` treatment: every entry carries the reason it is an entry,
   * the set is asserted **complete** against what the tree actually does, and it is
   * asserted **still live**, so an entry that stops being true is a failure rather than a
   * sentence nobody re-reads. Adding a caller is then a deliberate act with a sentence
   * attached, which is the whole of what this guard can honestly ask for.
   */
  const PROBE = 'openRedirectProbe';

  const PROBE_CALLERS: Record<string, string> = {
    'test/lang.test.ts':
      'MUSE-10 and MUSE-33 — its subject is where the redirect takes a browser, so the ' +
      'pin openCheckPage applies would pin the subject out of existence.',
    'test/localeswitch.test.ts':
      'MUSE-56 — the same subject from the switcher’s side: 18 browser-language × ' +
      'stored-language combinations, each asserted to land in the pressed language.',
    'test/browserlocale.test.ts':
      'this file — it tests the door itself, including that it refuses a browser language ' +
      'nobody named, which is the defect MUSE-48 is.',
  };

  /**
   * Every file that reaches the unasserted door, by the name it imports or by the call.
   *
   * Two signals because one import spelling leaves no name behind: `const { openRedirectProbe }
   * = await import('../scripts/browser-checks.mjs')` is an import of the module and of no
   * name, and the call is what is left to see. Read from the parser for the reason the whole
   * of MUSE-107 is: a concatenation defeats a regular expression and not a syntax tree.
   *
   * Over the **whole** of both trees rather than over `browserFiles()`, because a file that
   * is handed the function as an argument imports neither Playwright nor this module.
   */
  function probeCallers(): string[] {
    return [...scriptFiles(), ...testTreeFiles()]
      .filter((file) => file !== BROWSER_DOOR)
      .filter(
        (file) =>
          importsOf(file).some((entry) => entry.name === PROBE) ||
          callsOf(file).some((call) => call.name === PROBE),
      )
      .sort();
  }

  it('pins the door that asserts nothing to a named set of callers', () => {
    expect(
      probeCallers(),
      `${PROBE} makes no landing assertion (MUSE-48). Every file that opens it is named in ` +
        `PROBE_CALLERS with the reason its subject needs an unpinned browser; a file here ` +
        `and not there is a page measured with nothing checking which page it was.`,
    ).toEqual(Object.keys(PROBE_CALLERS).sort());
  });

  it('keeps every reason on that list a reason, and every entry still live', () => {
    // The half that rots. A list of exemptions written once is a list nobody re-reads, so
    // the entries are checked against the tree and the reasons against being sentences.
    for (const [file, why] of Object.entries(PROBE_CALLERS)) {
      expect(probeCallers(), `${file} no longer uses ${PROBE} — delete its entry`).toContain(
        file,
      );
      expect(why.length, `${file}: the reason is too short to be one`).toBeGreaterThan(60);
      expect(why, `${file}: the reason names no ticket and no subject`).toMatch(
        /MUSE-\d+|this file/,
      );
    }
  });
});

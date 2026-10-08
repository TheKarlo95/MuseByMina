import { AxeBuilder } from '@axe-core/playwright';

import {
  DEFAULT_CHECK_LOCALE,
  NAVIGATOR_LOCALE,
  describeMeasured,
  launchChecks,
  openCheckPage,
} from './browser-checks.mjs';
import { auditTargetsOrExit, openSiteOrExit } from './dist-origin.mjs';

/**
 * Design system §11 makes accessibility a hard requirement in BOTH themes, with
 * published contrast tables. This is the gate that keeps that mechanical.
 *
 * **What it audits is read off the build, not listed** (MUSE-55). This used to be
 * `ROUTES` — two homepages by default, and a comma-separated list in `ci.yml` that said
 * "adding a page → add it" out loud. It was never complete, and it structurally could not
 * be: the error page's URL is spelled without a trailing slash and its correct status at
 * `/MuseByMina/en/404` is 404, and this script asked `site.url()` for the first and
 * asserted 200 for the second. So the one page no happy path links to, that every lost
 * visitor meets, and that MUSE-38 had just turned into a bilingual page with two `<h1>`s,
 * two `lang` blocks and two exits, was the one page this gate never looked at — while
 * `/contact`'s trial form had axe coverage only because somebody remembered to extend the
 * list in CI.
 *
 * `auditTargets` walks the output tree instead, and each page arrives carrying the URL the
 * host serves it at and the status the host answers — both from `resolveRequest`, the one
 * model of GitHub Pages here. A page added under `src/pages/` is audited the day it
 * builds, with no list anywhere to extend.
 */
const targets = auditTargetsOrExit({
  // The error page has no locale in its path, so it is audited once per locale. These two
  // are the site's own, pinned to `src/lib/i18n.ts` by `test/browserlocale.test.ts`.
  locales: Object.keys(NAVIGATOR_LOCALE),
  defaultLocale: DEFAULT_CHECK_LOCALE,
});

/**
 * The server this audit measures — and the only thing that knows whose build is on it.
 *
 * No server is started for us and none is attached to: with nothing in the environment,
 * `openSite` serves `dist` from an in-process host on an ephemeral port. That is MUSE-52.
 * This script reported every route clean in both themes against a stale `astro preview`
 * daemon belonging to a **different agent's worktree**, because `astro preview`
 * daemonises here and silently reuses one on another port. The status check below was
 * added for that class and could not see it — a status confirms *something* answered, not
 * which build. An explicit `ORIGIN` is still honoured and is now proved byte-identical to
 * the local build before anything is audited, and either way the two lines logged above
 * name the build these results are about.
 *
 * The targets are handed over rather than a route list, so the byte comparison covers the
 * error page's spelling and status too.
 */
const site = await openSiteOrExit({ routes: targets });

/**
 * The browser, and the locale each page is audited as.
 *
 * `scripts/browser-checks.mjs` opens every page (MUSE-48). This script used to carry a
 * hand-written `addInitScript` line pinning the stored language, with a comment saying that
 * without it `/` redirects an `en-US` browser to `/en/` and the English page gets audited
 * twice — and that line, which every future check had to know to copy, was the bug the
 * ticket is about. The locale now comes off the route, and the landing URL is asserted
 * inside the door rather than here: that assertion was added to this file by hand after it
 * audited the wrong page twice, which is exactly why it belongs where nobody can omit it.
 *
 * `site.at(target.path)` is how a page whose URL is not a directory's gets opened without
 * reopening that door: the path comes from the host model, and the route beside it still
 * decides the locale pin. `/404` is pinned `hr` and `/en/404` is pinned `en` — the error
 * page is bilingual markup, so neither pin selects a language; what they do is audit the
 * page as a visitor of each language actually meets it.
 */
const browser = await launchChecks();
let failures = 0;

console.log(`pages   ${targets.length} from the build, both themes`);

for (const target of targets) {
  for (const scheme of ['dark', 'light']) {
    /** @type {Awaited<ReturnType<typeof openCheckPage>>} */
    let open;
    try {
      open = await openCheckPage(browser, site.at(target.path), target.route, {
        context: { colorScheme: scheme, viewport: { width: 1280, height: 900 } },
      });
    } catch (problem) {
      // A landing that is not the page we named. The door's message explains itself.
      failures += 1;
      console.log(`✗ ${target.route} ${scheme}`);
      console.log(`${problem instanceof Error ? problem.message : String(problem)}`);
      continue;
    }

    const { page, response, measured } = open;

    // A 404 body audits perfectly clean. Without this the gate reports success
    // for a page that does not exist — which it did, against a stale dev server
    // on a port it had silently fallen back from.
    //
    // The expectation is the status **this build** gives this URL rather than a literal
    // 200 (MUSE-55), because the error page's is 404 at `…/en/404` and that is the only
    // way to audit it at all. The comparison itself is not relaxed: anything other than
    // the expected status is still a loud failure, which is the whole of what the literal
    // was protecting.
    const status = response?.status() ?? 0;
    if (status !== target.status) {
      failures += 1;
      console.log(
        `✗ ${target.route} ${scheme} — expected ${target.status}, got ${status} at ${measured.url}`,
      );
      await open.close();
      continue;
    }
    await page.evaluate(() => document.fonts.ready);

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    // The page that was audited, not the route that was asked for (MUSE-48): a reader of
    // this log can see which language each line is about without re-running anything. The
    // status is in it for the same reason — `…/en/404  404` is a pass, and a reader should
    // not have to take that on trust.
    const tag = `${scheme.padEnd(5)} ${describeMeasured(measured)}  ${status}`;
    if (violations.length === 0) {
      console.log(`✓ ${tag}  no violations`);
    } else {
      failures += violations.length;
      console.log(`✗ ${tag}  ${violations.length} violation(s)`);
      for (const v of violations) {
        console.log(`   [${v.impact}] ${v.id} — ${v.help}`);
        for (const n of v.nodes.slice(0, 3)) {
          console.log(`      ${n.target.join(' ')}`);
          const msg = n.any?.[0]?.message ?? n.all?.[0]?.message;
          if (msg) console.log(`      → ${msg}`);
        }
      }
    }
    await open.close();
  }
}

await browser.close();
await site.close();
if (failures) {
  console.log(`\n${failures} violation(s) total`);
  process.exit(1);
}
console.log(`\nAll ${targets.length} pages clean in both themes.`);

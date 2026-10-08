import { AxeBuilder } from '@axe-core/playwright';

import { describeMeasured, launchChecks, openCheckPage } from './browser-checks.mjs';
import { openSiteOrExit } from './dist-origin.mjs';

/**
 * Design system §11 makes accessibility a hard requirement in BOTH themes, with
 * published contrast tables. This is the gate that keeps that mechanical.
 */
const ROUTES = (process.env.ROUTES ?? '/,/en').split(',');

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
 * Page URLs carry a trailing slash (`trailingSlash: 'always'`, MUSE-9); `site.url` is the
 * one place that is added. Auditing the unslashed spelling would audit a redirect.
 */
const site = await openSiteOrExit({ routes: ROUTES });

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
 */
const browser = await launchChecks();
let failures = 0;

for (const route of ROUTES) {
  for (const scheme of ['dark', 'light']) {
    /** @type {Awaited<ReturnType<typeof openCheckPage>>} */
    let open;
    try {
      open = await openCheckPage(browser, site, route, {
        context: { colorScheme: scheme, viewport: { width: 1280, height: 900 } },
      });
    } catch (problem) {
      // A landing that is not the page we named. The door's message explains itself.
      failures += 1;
      console.log(`✗ ${route} ${scheme}`);
      console.log(`${problem instanceof Error ? problem.message : String(problem)}`);
      continue;
    }

    const { page, response, measured } = open;

    // A 404 body audits perfectly clean. Without this the gate reports success
    // for a page that does not exist — which it did, against a stale dev server
    // on a port it had silently fallen back from.
    const status = response?.status() ?? 0;
    if (status !== 200) {
      failures += 1;
      console.log(`✗ ${route} ${scheme} — expected 200, got ${status} at ${measured.url}`);
      await open.close();
      continue;
    }
    await page.evaluate(() => document.fonts.ready);

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    // The page that was audited, not the route that was asked for (MUSE-48): a reader of
    // this log can see which language each line is about without re-running anything.
    const tag = `${scheme.padEnd(5)} ${describeMeasured(measured)}`;
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
console.log('\nAll pages clean in both themes.');

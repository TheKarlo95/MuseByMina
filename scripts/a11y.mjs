import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

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
 * daemonises here and silently reuses one on another port. The two checks below were
 * both added for that class and neither could see it — a status and a redirect confirm
 * *something* answered, not which build. An explicit `ORIGIN` is still honoured and is
 * now proved byte-identical to the local build before anything is audited, and either
 * way the two lines logged above name the build these results are about.
 *
 * Page URLs carry a trailing slash (`trailingSlash: 'always'`, MUSE-9); `site.url` is the
 * one place that is added. Auditing the unslashed spelling would audit a redirect.
 */
const site = await openSiteOrExit({ routes: ROUTES });
const pageUrl = (route) => site.url(route);

const browser = await chromium.launch();
let failures = 0;

for (const route of ROUTES) {
  const url = pageUrl(route);

  for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 1280, height: 900 },
    });
    // Pin the language, or the homepage's Accept-Language redirect sends an
    // en-US browser to /en and we audit the English page twice.
    await ctx.addInitScript(() => localStorage.setItem('muse-lang', 'hr'));

    const page = await ctx.newPage();
    const response = await page.goto(url, { waitUntil: 'networkidle' });

    // A 404 body audits perfectly clean. Without this the gate reports success
    // for a page that does not exist — which it did, against a stale dev server
    // on a port it had silently fallen back from.
    const status = response?.status() ?? 0;
    if (status !== 200) {
      failures += 1;
      console.log(`✗ ${route} ${scheme} — expected 200, got ${status} at ${url}`);
      await ctx.close();
      continue;
    }
    if (new URL(page.url()).pathname !== new URL(url).pathname) {
      failures += 1;
      console.log(`✗ ${route} ${scheme} — redirected to ${page.url()}, audited the wrong page`);
      await ctx.close();
      continue;
    }
    await page.evaluate(() => document.fonts.ready);

    const { violations } = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();

    const tag = `${route} ${scheme}`.padEnd(14);
    if (violations.length === 0) {
      console.log(`✓ ${tag} no violations`);
    } else {
      failures += violations.length;
      console.log(`✗ ${tag} ${violations.length} violation(s)`);
      for (const v of violations) {
        console.log(`   [${v.impact}] ${v.id} — ${v.help}`);
        for (const n of v.nodes.slice(0, 3)) {
          console.log(`      ${n.target.join(' ')}`);
          const msg = n.any?.[0]?.message ?? n.all?.[0]?.message;
          if (msg) console.log(`      → ${msg}`);
        }
      }
    }
    await ctx.close();
  }
}

await browser.close();
await site.close();
if (failures) {
  console.log(`\n${failures} violation(s) total`);
  process.exit(1);
}
console.log('\nAll pages clean in both themes.');

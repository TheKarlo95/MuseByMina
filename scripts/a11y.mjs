import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

/**
 * Design system §11 makes accessibility a hard requirement in BOTH themes, with
 * published contrast tables. This is the gate that keeps that mechanical.
 */
const ORIGIN = process.env.ORIGIN ?? 'http://localhost:4321';
const BASE = process.env.BASE ?? '/MuseByMina';
const ROUTES = (process.env.ROUTES ?? '/,/en').split(',');

/**
 * Page URLs carry a trailing slash (`trailingSlash: 'always'`, MUSE-9). Auditing the
 * unslashed spelling would audit a redirect, not the page.
 */
const pageUrl = (route) =>
  `${ORIGIN}${BASE.replace(/\/+$/, '')}${route === '/' ? '' : route}/`;

const browser = await chromium.launch();
let failures = 0;

for (const route of ROUTES) {
  const url = pageUrl(route);

  for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({
      colorScheme: scheme,
      viewport: { width: 1280, height: 900 },
    });
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
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
if (failures) {
  console.log(`\n${failures} violation(s) total`);
  process.exit(1);
}
console.log('\nAll pages clean in both themes.');

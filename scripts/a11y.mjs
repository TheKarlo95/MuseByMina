import { chromium } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';

const URL = process.env.URL ?? 'http://localhost:3000/';
const browser = await chromium.launch();
let failures = 0;

for (const [name, scheme] of [['dark', 'dark'], ['light', 'light']]) {
  const ctx = await browser.newContext({ colorScheme: scheme, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);

  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();

  if (violations.length === 0) {
    console.log(`✓ ${name}: no violations`);
  } else {
    failures += violations.length;
    console.log(`✗ ${name}: ${violations.length} violation(s)`);
    for (const v of violations) {
      console.log(`   [${v.impact}] ${v.id} — ${v.help}`);
      for (const n of v.nodes.slice(0, 3)) {
        console.log(`      ${n.target.join(' ')}`);
        if (n.any?.[0]?.message) console.log(`      → ${n.any[0].message}`);
      }
    }
  }
  await ctx.close();
}

await browser.close();
process.exit(failures ? 1 : 0);

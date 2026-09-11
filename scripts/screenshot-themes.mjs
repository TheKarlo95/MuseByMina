import { chromium } from 'playwright';

const URL = 'http://localhost:3000/';
const browser = await chromium.launch();

async function shot(name, { colorScheme, stored }) {
  const ctx = await browser.newContext({
    colorScheme,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 2,
  });
  if (stored) {
    await ctx.addInitScript(
      ([k, v]) => localStorage.setItem(k, v),
      ['muse-theme', stored],
    );
  }
  const page = await ctx.newPage();
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);

  const bg = await page.evaluate(() =>
    getComputedStyle(document.body).backgroundColor,
  );
  const attr = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  console.log(`${name.padEnd(26)} data-theme=${String(attr).padEnd(7)} body-bg=${bg}`);

  await page.screenshot({ path: `/tmp/muse-shots/${name}.png`, fullPage: true });
  await ctx.close();
}

await shot('01-os-dark', { colorScheme: 'dark' });
await shot('02-os-light', { colorScheme: 'light' });
await shot('03-os-dark-chose-light', { colorScheme: 'dark', stored: 'light' });
await shot('04-os-light-chose-dark', { colorScheme: 'light', stored: 'dark' });

await browser.close();

import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const ORIGIN = process.env.ORIGIN ?? 'http://localhost:4321';
const BASE = process.env.BASE ?? '/MuseByMina';
const OUT = process.env.OUT ?? '/tmp/muse-shots';

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

async function shot(name, { route = '/', colorScheme, stored, viewport, mobile }) {
  const ctx = await browser.newContext({
    colorScheme,
    viewport: viewport ?? { width: 1280, height: 900 },
    deviceScaleFactor: mobile ? 3 : 2,
    isMobile: !!mobile,
    hasTouch: !!mobile,
  });
  if (stored) {
    await ctx.addInitScript(
      ([k, v]) => localStorage.setItem(k, v),
      ['muse-theme', stored],
    );
  }
  // Keep the homepage language redirect out of the screenshots.
  await ctx.addInitScript(() => localStorage.setItem('muse-lang', 'hr'));

  const page = await ctx.newPage();
  await page.goto(`${ORIGIN}${BASE}${route === '/' ? '' : route}`, {
    waitUntil: 'networkidle',
  });
  await page.evaluate(() => document.fonts.ready);

  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const attr = await page.evaluate(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );

  console.log(
    `${name.padEnd(26)} data-theme=${String(attr).padEnd(7)} bg=${bg.padEnd(20)} h-overflow=${overflow}px`,
  );
  if (overflow > 0) process.exitCode = 1;

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await ctx.close();
}

await shot('01-os-dark', { colorScheme: 'dark' });
await shot('02-os-light', { colorScheme: 'light' });
await shot('03-os-dark-chose-light', { colorScheme: 'dark', stored: 'light' });
await shot('04-os-light-chose-dark', { colorScheme: 'light', stored: 'dark' });
await shot('05-mobile-dark', {
  colorScheme: 'dark',
  viewport: { width: 390, height: 844 },
  mobile: true,
});
await shot('06-mobile-light', {
  colorScheme: 'light',
  viewport: { width: 390, height: 844 },
  mobile: true,
});
await shot('07-en-dark', { route: '/en', colorScheme: 'dark' });

await browser.close();

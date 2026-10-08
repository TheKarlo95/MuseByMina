import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

import { openSiteOrExit } from './dist-origin.mjs';

const OUT = process.env.OUT ?? '/tmp/muse-shots';

/**
 * Which page to shoot. The theme states and the 390px overflow check are the same
 * questions on every page, so the route is a parameter rather than the homepage:
 *
 *   ROUTE=/schedule OUT=/tmp/muse-shots/schedule npm run shots
 */
const ROUTE = process.env.ROUTE ?? '/';
const EN_ROUTE = ROUTE === '/' ? '/en' : `/en${ROUTE}`;

/**
 * The server these are screenshots **of**, resolved the same way `scripts/a11y.mjs`
 * resolves it: an in-process host over `dist` on an ephemeral port unless `ORIGIN` says
 * otherwise, and a byte-for-byte comparison against the local build when it does
 * (MUSE-52).
 *
 * This script had the same exposure as the audit and not even the status check — a shot
 * of a different worktree's build is a PNG that looks exactly like a shot of yours, and
 * the h-overflow number beside it is about their CSS.
 *
 * Page URLs carry a trailing slash (`trailingSlash: 'always'`, MUSE-9); `site.url` adds it.
 */
const site = await openSiteOrExit({ routes: [ROUTE, EN_ROUTE] });
const pageUrl = (route) => site.url(route);

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

async function shot(name, { route = ROUTE, colorScheme, stored, viewport, mobile }) {
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
  await page.goto(pageUrl(route), { waitUntil: 'networkidle' });
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
await shot('07-en-dark', { route: EN_ROUTE, colorScheme: 'dark' });

await browser.close();
await site.close();

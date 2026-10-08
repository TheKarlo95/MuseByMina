import { mkdirSync } from 'node:fs';

import { describeMeasured, launchChecks, openCheckPage } from './browser-checks.mjs';
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

mkdirSync(OUT, { recursive: true });

/**
 * Every shot is opened by `scripts/browser-checks.mjs`, which pins the locale the route
 * names and asserts the page it landed on (MUSE-48).
 *
 * This script is the reason the ticket was written as a mechanism rather than a note. It
 * carried the same hand-written language-pin line as the audit but **no landing
 * assertion**, so a redirect would have produced seven PNGs of a page that looks exactly
 * like the one asked for, with an `h-overflow` number beside it that was about the other
 * language's copy. There is no way to notice that in a screenshot.
 */
const browser = await launchChecks();

async function shot(name, { route = ROUTE, colorScheme, stored, viewport, mobile }) {
  const { page, measured, close } = await openCheckPage(browser, site, route, {
    // The theme a returning visitor chose, which is the whole point of shots 03 and 04.
    // Seeded through the door so that nothing here touches `addInitScript` — one place
    // writes storage before a page loads, and the language pin cannot be left out of it.
    storage: stored ? { 'muse-theme': stored } : {},
    context: {
      colorScheme,
      viewport: viewport ?? { width: 1280, height: 900 },
      deviceScaleFactor: mobile ? 3 : 2,
      isMobile: !!mobile,
      hasTouch: !!mobile,
    },
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
  // The page this PNG is of, in the log beside it (MUSE-48). A shot is the one output
  // format that cannot say which language it is: both homepages look the same at a
  // glance, and every earlier run of this script labelled them by the route it asked for.
  console.log(`${' '.repeat(26)} ${describeMeasured(measured)}`);
  if (overflow > 0) process.exitCode = 1;

  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  await close();
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

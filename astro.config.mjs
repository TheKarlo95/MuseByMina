// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

/**
 * Deploy target.
 *
 * Until muse.dance is registered the site lives at the GitHub Pages project
 * URL, which serves from a sub-path — so assets need `base`. Both are env-driven
 * so moving to the custom domain is a config change in CI, not a code change:
 *
 *   SITE=https://muse.dance BASE=/ npm run build
 */
const SITE = process.env.SITE ?? 'https://thekarlo95.github.io';
const BASE = process.env.BASE ?? '/MuseByMina';

const DEFAULT_LOCALE = 'hr';

/**
 * Locale path segment → hreflang tag.
 *
 * Keep in sync with `LOCALE_HTML_LANG` in `src/lib/i18n.ts`, which is what the pages
 * themselves declare in `<link rel="alternate">`. `test/seo.test.ts` fails if the
 * sitemap and the pages disagree, so this stays mechanical rather than aspirational.
 */
const HREFLANG = { hr: 'hr-HR', en: 'en' };

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'never',

  // Croatian is primary and sets the tone; English follows it (design system §10).
  // prefixDefaultLocale: false puts HR at / and EN at /en/.
  i18n: {
    locales: Object.keys(HREFLANG),
    defaultLocale: DEFAULT_LOCALE,
    routing: {
      prefixDefaultLocale: false,
      redirectToDefaultLocale: false,
    },
  },

  // Every URL it writes is derived from `site` + `base`, so a deploy-target change
  // is picked up with no code edit. The i18n block gives each entry an xhtml:link
  // alternate per locale.
  integrations: [
    sitemap({ i18n: { defaultLocale: DEFAULT_LOCALE, locales: HREFLANG } }),
  ],

  build: {
    // One stylesheet beats a waterfall of tiny ones on a content site.
    inlineStylesheets: 'auto',
  },
});

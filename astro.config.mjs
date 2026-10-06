// @ts-check
import { defineConfig } from 'astro/config';

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

export default defineConfig({
  site: SITE,
  base: BASE,
  trailingSlash: 'never',

  // Croatian is primary and sets the tone; English follows it (design system §10).
  // prefixDefaultLocale: false puts HR at / and EN at /en/.
  i18n: {
    locales: ['hr', 'en'],
    defaultLocale: 'hr',
    routing: {
      prefixDefaultLocale: false,
      redirectToDefaultLocale: false,
    },
  },

  build: {
    // One stylesheet beats a waterfall of tiny ones on a content site.
    inlineStylesheets: 'auto',
  },
});

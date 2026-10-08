// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

import {
  PREVIEW_ROUTE_ENV,
  PREVIEW_ROUTES,
  previewPatterns,
  requestedPreviews,
} from './src/lib/preview';

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

/**
 * Where this build keeps its caches.
 *
 * Astro's own cache and Vite's dependency cache both default to a path under the
 * *project root* — `node_modules/.astro` and `node_modules/.vite` — so every
 * simultaneous `astro build` in one checkout shares them, whatever `--outDir` each was
 * given. Vite's dependency optimiser commits by renaming `node_modules/.vite/deps`
 * aside and deleting it, which is a destructive write to a directory the other builds
 * are reading. `npm test` runs ten builds at once (MUSE-17), and no per-suite output
 * name can isolate a directory the suite never names.
 *
 * So the cache root is overridable, the same way SITE/BASE are, and the test helper
 * gives each build its own. Unset in CI and in `npm run build`, where the defaults are
 * what you want: one checkout, one build, a warm cache between runs.
 *
 * **Both lines below are load-bearing and both are tested** (MUSE-34). They were not:
 * deleting them left the whole suite green — 10 files, 204 tests — with the shared cache
 * back and the race restored, and the only symptom would have been intermittent CI months
 * later. `test/isolation.test.ts` now evaluates this config with the variable set and
 * unset, and separately runs a real build and demands its caches landed under the
 * directory it was given.
 */
const BUILD_CACHE_DIR = process.env.BUILD_CACHE_DIR;

const DEFAULT_LOCALE = 'hr';

/**
 * Locale path segment → hreflang tag.
 *
 * Keep in sync with `LOCALE_HTML_LANG` in `src/lib/i18n.ts`, which is what the pages
 * themselves declare in `<link rel="alternate">`. `test/seo.test.ts` fails if the
 * sitemap and the pages disagree, so this stays mechanical rather than aspirational.
 */
const HREFLANG = { hr: 'hr-HR', en: 'en' };

/**
 * Throwaway routes for a component whose page does not exist yet. **Test-only.**
 *
 * `src/lib/preview.ts` holds the registry and the long argument for why this exists at
 * all; the short version is that MUSE-23 built `/aboutus` against a dataset that has no
 * origin story and no instructors in it, and routing the page would stop `main` from
 * building. Unset — which is every deploy, every CI job and every `npm run build` — this
 * injects nothing and the output is identical to a build that has never heard of it.
 *
 * `integrations` below spreads the result, so an empty list is genuinely no integration
 * rather than an integration that does nothing.
 */
function previewRoutes() {
  const requested = requestedPreviews(process.env[PREVIEW_ROUTE_ENV]);
  if (requested.length === 0) return [];

  return [
    {
      name: 'muse-preview-routes',
      hooks: {
        /** @param {{ injectRoute: (route: { pattern: string, entrypoint: string }) => void, logger: { warn: (msg: string) => void } }} ctx */
        'astro:config:setup': ({ injectRoute, logger }) => {
          for (const name of requested) {
            for (const pattern of previewPatterns(name)) {
              injectRoute({ pattern, entrypoint: PREVIEW_ROUTES[name] });
            }
          }
          // Capitals, for the reason `src/lib/sanity/client.ts` announces a fixture read
          // in capitals: a build carrying extra routes is otherwise indistinguishable in
          // its log from one that is not.
          logger.warn(
            `PREVIEW ROUTES injected: ${requested.join(', ')}. ` +
              `${PREVIEW_ROUTE_ENV} is set; this output is for the test suite and must ` +
              `never be deployed.`,
          );
        },
      },
    },
  ];
}

export default defineConfig({
  site: SITE,
  base: BASE,

  // See BUILD_CACHE_DIR above. `undefined` leaves Astro's and Vite's own defaults alone.
  cacheDir: BUILD_CACHE_DIR,
  vite: { cacheDir: BUILD_CACHE_DIR ? `${BUILD_CACHE_DIR}/vite` : undefined },

  /**
   * Directory-style output is served at the slashed URL, so the slashed URL is the only
   * spelling that can be canonical (MUSE-9).
   *
   * `build.format` defaults to `'directory'` — Astro writes `dist/en/index.html` — and
   * every static host, GitHub Pages included, answers `/en` with a 301 to `/en/`. Paired
   * with the old `trailingSlash: 'never'` that meant every canonical, hreflang alternate
   * and sitemap `<loc>` named a URL that redirected, so nothing on the site was
   * self-referential and Google drops an hreflang cluster whose targets redirect.
   *
   * `build.format: 'file'` is the other way out, and does not work here. Tried and
   * measured, not assumed:
   *
   *   - The deploy root is a directory whatever the format, so `/MuseByMina` keeps 301ing
   *     to `/MuseByMina/`. The homepage — the one URL that matters most — would still
   *     have a redirecting canonical.
   *   - `Astro.url.pathname` then carries the `.html`, so `routeKey` reads `/index.html`
   *     and the pages declare `…/MuseByMina/index.html` and `…/MuseByMina/en/en.html`.
   *   - It leans on the host resolving `/en` to `en.html`, which Pages happens to do and
   *     a bare `nginx` does not.
   *
   * `@astrojs/sitemap` reads this setting, so the sitemap follows with no code of ours.
   */
  trailingSlash: 'always',

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
    // Empty unless MUSE_PREVIEW_ROUTES is set. See `previewRoutes` above.
    ...previewRoutes(),
  ],

  build: {
    // One stylesheet beats a waterfall of tiny ones on a content site.
    inlineStylesheets: 'auto',
  },
});

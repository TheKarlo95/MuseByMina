// @ts-check
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * **Where a build stages its prerendered output, and why `outDir` may not leave the
 * project root** (MUSE-41).
 *
 * `BUILD_CACHE_DIR` above exists because `outDir` is not the only directory a build
 * writes. Astro's prerender staging area is a third, and unlike the other two nothing
 * here chose it: `getOutDirWithinCwd` (`astro/dist/core/build/common.js`) stages in
 * `<outDir>/.prerender/` **only when `outDir` starts with `process.cwd()`**, and
 * otherwise falls back to the one directory it knows is writable, `<cwd>/.astro/`.
 * `ssrMoveAssets` then `fs.rename`s every emitted asset out of there into `outDir`. That
 * fallback has two failure modes and both were measured on this repository:
 *
 *   - **Cross-device.** A rename across a filesystem boundary is `EXDEV`, which is not a
 *     retryable error. `npx astro build --outDir /tmp/…` — `/tmp` is a tmpfs here — dies
 *     in `ssrMoveAssets` with an Astro stack that never mentions `outDir`, under both
 *     deploy targets. The branch was dead code until MUSE-35 put six content-hashed font
 *     files in the emitted assets: before that there was nothing to move.
 *   - **Shared, and silent.** Two concurrent builds whose `outDir` is outside the root
 *     stage into *the same* `<cwd>/.astro/.prerender/`, and the filenames are
 *     content-hashed, so two builds of one tree collide deterministically rather than
 *     occasionally. Measured: both exited 0, both printed `9 page(s) built` and
 *     `Complete!`; the first carried all nine assets and the second had **no `_astro/`
 *     directory at all**, with its HTML still linking the stylesheet and all six faces.
 *     A site with no CSS and no webfonts, reported as a success.
 *
 * This is MUSE-17 in a directory no suite names — `test/isolation.test.ts`'s rule is that
 * nothing under `test/` may *name* a build directory, so a directory Astro derives is
 * structurally invisible to it.
 *
 * **Astro exposes no setting for it** (checked, 7.3.6: `getPrerenderOutputDirectory` is
 * the only caller and it takes nothing but `config.outDir`), so the requirement is
 * stated here instead, in front of every build there is — `npm run build`, CI's three
 * jobs, the suite's ten, and a hand-typed `npx astro build`. `stagingGuard` below runs in
 * `astro:config:setup`, which already sees a `--outDir` off the command line and runs
 * before a single file is emitted, so a refused build leaves nothing behind to clean up.
 *
 * Satisfy it and both failures are gone by construction rather than by luck: the staging
 * directory is *inside* the output directory, which `test/helpers/scratch.ts` mints with
 * `mkdtemp`, so it is per-build and on the output's own filesystem.
 *
 * ---
 *
 * `prerenderStagingDir` is that rule as a function: Astro's staging directory for a build
 * that writes to `outDir`. Deliberately faithful rather than tidy: Astro's test is a **raw string prefix** with no
 * separator, so a sibling directory whose name extends the root's — `<root>-other/dist` —
 * counts as inside it and stages locally. That build is safe, and a stricter model would
 * reject it for nothing. `test/isolation.test.ts` pins this to Astro's own
 * `getPrerenderOutputDirectory`, the way `queryParameters` is pinned to the real GROQ
 * parser: a model nothing compares against the thing it models is a second opinion.
 *
 * @param {string} outDir Absolute path to the build's output directory.
 * @param {string} [cwd] The working directory the build will run in.
 * @returns {string} Absolute path, no trailing separator.
 */
export function prerenderStagingDir(outDir, cwd = process.cwd()) {
  return outDir.startsWith(cwd)
    ? join(outDir, '.prerender')
    : join(cwd, '.astro', '.prerender');
}

/**
 * Why this `outDir` cannot be built into, or `null` if it can.
 *
 * One question — *is `outDir` inside the project root?* — rather than a list of the ways
 * a build can go wrong. `EXDEV`, the shared directory and the deleted project are three
 * symptoms of the same condition, and a check per symptom is a check that misses the
 * fourth.
 *
 * **It asks that about `outDir` and not about the staging directory** (MUSE-92). It used
 * to compare the staging directory against `outDir` — *does this build stage inside its
 * own output?* — which is the same question for a descendant and the **opposite** one for
 * an ancestor: for an `outDir` above the root, Astro's fallback `<cwd>/.astro/.prerender`
 * is inside it, so the proxy answered "yes, it stages locally" and the build ran. Astro
 * and Vite then emptied the output directory, which contained the project root, and
 * deleted the project — sources, caches and all, with Vite's own generic warning the only
 * thing that objected and only after the fact. The rule the message below has always
 * stated is the right one, so it is now the rule the code states too.
 *
 * Two boundaries, both deliberate:
 *
 *   - **The prefix is Astro's own raw string test**, the one `prerenderStagingDir` models,
 *     so the sibling whose name extends the root's (`<root>-other/dist`) is still allowed.
 *     It stages inside its own output, so it is safe, and `path.relative` would refuse it
 *     for nothing.
 *   - **The root itself is not *under* the root.** Astro refuses that build on its own —
 *     `validateConfig`, `the outDir cannot be the root folder` — so nothing's outcome
 *     changes, but a guard against deleting the project may not rest on a check inside a
 *     dependency, and the rule would otherwise be one case wider than the sentence.
 *
 * @param {string} outDir Absolute path to the build's output directory.
 * @param {string} [cwd] The working directory the build will run in.
 * @returns {string | null}
 */
export function stagingFault(outDir, cwd = process.cwd()) {
  if (outDir.startsWith(cwd) && relative(cwd, outDir) !== '') return null;

  return [
    'outDir must live under the project root (MUSE-41, MUSE-92).',
    '',
    `  outDir   ${outDir}`,
    `  root     ${cwd}`,
    `  staging  ${prerenderStagingDir(outDir, cwd)}`,
    '',
    'Astro stages prerendered output in <outDir>/.prerender/ only when outDir starts',
    'with the working directory, and otherwise in <cwd>/.astro/.prerender/ — renaming',
    'every emitted asset out of it. This outDir is not under the project root, so the',
    'build would fail with EXDEV across a filesystem boundary, and silently lose assets',
    'to whichever concurrent build renames them first when it does not. And an outDir at',
    'or above the project root is emptied before the build writes it, which deletes the',
    'project. Build into the project root and copy or serve the output from there.',
  ].join('\n');
}

/** Refuse a build that would stage outside its own output directory. See above. */
function stagingGuard() {
  return {
    name: 'muse-staging-guard',
    hooks: {
      /** @param {{ config: { outDir: URL } }} ctx */
      'astro:config:setup': ({ config }) => {
        const fault = stagingFault(fileURLToPath(config.outDir).replace(/[/\\]$/, ''));
        if (fault !== null) throw new Error(fault);
      },
    },
  };
}

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
    // First, so a build that cannot stage safely is refused before anything else
    // in this list does any work. See the long note above `prerenderStagingDir`.
    stagingGuard(),
    sitemap({ i18n: { defaultLocale: DEFAULT_LOCALE, locales: HREFLANG } }),
    // Empty unless MUSE_PREVIEW_ROUTES is set. See `previewRoutes` above.
    ...previewRoutes(),
  ],

  build: {
    // One stylesheet beats a waterfall of tiny ones on a content site.
    inlineStylesheets: 'auto',
  },
});

/**
 * **What the loaders actually load — asked of them where it can be asked, modelled and
 * pinned where it cannot** (MUSE-96).
 *
 * Three guards in this tree discovered their subjects with a rule *narrower* than the
 * thing that loads them, and all three therefore passed over the file that mattered:
 *
 *   - `test/browserlocale.test.ts` read `test/` one directory deep with a flat
 *     `readdirSync`, while vitest loads `test/**\/*.test.ts`. A suite at
 *     `test/sub/ghost.test.ts` launching its own Chromium ran, and the guard that exists
 *     to make that impossible reported nothing — MUSE-48's pinned locale and MUSE-68's
 *     census defeated at once.
 *   - `test/routes.test.ts` and `test/seo.test.ts` discovered pages with
 *     `endsWith('.astro')`, while Astro routes **eight** extensions. `src/pages/
 *     etiquette.md` built, landed in the sitemap, and had no `ROUTES` entry, no `page`
 *     document and no `llms.txt` line — so `src/pages/`, the one list CLAUDE.md says
 *     cannot lie about what exists, lied, and MUSE-46's own suite stayed green.
 *   - `owningTestFile()` in `scripts/heavy-census.mjs` matched a bare filename, so the
 *     census attributed a subdirectory suite's build to a file that does not exist. That
 *     one is fixed in `scripts/heavy-census.mjs` itself; the two scans live here.
 *
 * **The shared defect is that a scan is a model of another tool's behaviour, and a model
 * is wrong the moment the tool changes.** So the rule this module follows is the one
 * `prerenderStagingDir` follows in `astro.config.mjs` (MUSE-41): obtain the real answer
 * from the tool where the tool will give it, and where it will not, say out loud that
 * what is left is a model and pin it to the tool with an assertion. A model nothing
 * compares to the thing it models is a second opinion, not a guard.
 *
 * Which is which here:
 *
 *   - **Obtained.** `PAGE_EXTENSIONS` is Astro's own `settings.pageExtensions`, read out
 *     of `createBaseSettings` — the function a build calls — rather than a list of
 *     extensions somebody believed Astro served.
 *   - **Obtained.** `vitestFileGlobs()` returns the `include`/`exclude` vitest resolves
 *     for this project, from vitest's own `resolveConfig`.
 *   - **Modelled, and pinned.** `suiteFiles()` is a recursive walk of `test/` for
 *     `*.test.ts`, because matching a glob needs vitest's matcher and vitest exports no
 *     file-list function a test can cheaply call. `test/browserlocale.test.ts` asserts the
 *     walk against `vitestFileGlobs()`, so a change to `include` fails loudly instead of
 *     leaving the walk quietly narrower than the run.
 *   - **Modelled, and pinned.** `scriptFiles()` is a recursive walk of `scripts/` for
 *     `.mjs`, because the loader is `node <path>` out of `package.json`. The pin is
 *     `package.json` itself: every script file npm invokes must appear in the walk.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The repository root. */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Every file under `dir`, recursively, as absolute paths.
 *
 * Recursive is the whole point: every defect this module is named for was a scan that
 * stopped at the first directory while the loader did not.
 */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(full) : [full];
    })
    .sort();
}

/* --------------------------------------------------------------- the test tree */

/**
 * Every suite vitest loads, as repo-relative paths — **a model of `include`, pinned to
 * it** by `test/browserlocale.test.ts`.
 *
 * The flat `readdirSync` this replaces was wrong by exactly one directory level, and the
 * escape was cheap: a file in any subdirectory of `test/` was loaded by vitest and
 * invisible to every rule stated over `test/`.
 *
 * It is a walk and not a glob match because the only honest way to evaluate
 * `test/**\/*.test.ts` is vitest's own matcher, and vitest exposes no file-list function a
 * test can call without standing up a second vitest. So the walk states the glob's
 * *meaning* and the pin states that the glob still means that.
 */
export function suiteFiles(): string[] {
  return filesUnder(join(ROOT, 'test'))
    .map((file) => relative(ROOT, file).replace(/\\/g, '/'))
    .filter((file) => file.endsWith('.test.ts'));
}

/**
 * Every TypeScript file under `test/`, as repo-relative paths.
 *
 * Wider than `suiteFiles()` on purpose. The browser rule CLAUDE.md states is about
 * *files* — „no file in `scripts/` or `test/` may call `newContext`, `newPage`,
 * `addInitScript`, `setItem` or a Playwright launch" — and a helper is a file. The flat
 * scan this replaces read `test/*.ts`, which happened to be every suite and no helper, so
 * `test/helpers/browser-settle.ts` imported Playwright and was never checked.
 */
export function testTreeFiles(): string[] {
  return filesUnder(join(ROOT, 'test'))
    .map((file) => relative(ROOT, file).replace(/\\/g, '/'))
    .filter((file) => file.endsWith('.ts'));
}

/**
 * The `include` and `exclude` globs vitest resolves for this project — **asked of
 * vitest**, not read off `vitest.config.ts` by eye.
 *
 * `resolveConfig` is vitest's own config resolution, so the answer carries vitest's
 * defaults as well as this repository's overrides. It costs about a second and starts
 * nothing: no worker, no server, no child build. It is deliberately not used to *produce*
 * the file list — see `suiteFiles()` — only to check that the list's shape is still the
 * one vitest asks for.
 */
export async function vitestFileGlobs(): Promise<{ include: string[]; exclude: string[] }> {
  const { resolveConfig } = await import('vitest/node');
  const resolved = await resolveConfig({ root: ROOT });
  return { include: [...resolved.test.include], exclude: [...resolved.test.exclude] };
}

/* ----------------------------------------------------------------- the scripts */

/**
 * Every module under `scripts/`, as repo-relative paths — **a model of `node <path>`,
 * pinned to `package.json`.**
 *
 * There is no list to obtain here: a script is loaded because an npm script, a workflow
 * step or a person names its path. So the walk claims that anything `.mjs` under
 * `scripts/` is loadable, which is the widest honest reading, and the pin asserts that
 * every script `package.json` actually runs is in it.
 */
export function scriptFiles(): string[] {
  return filesUnder(join(ROOT, 'scripts'))
    .map((file) => relative(ROOT, file).replace(/\\/g, '/'))
    .filter((file) => file.endsWith('.mjs'));
}

/** Every `scripts/…` path `package.json`'s own scripts hand to node. */
export function scriptsPackageJsonRuns(): string[] {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const named = Object.values(manifest.scripts ?? {}).flatMap(
    (command) => command.match(/scripts\/[\w./-]+\.mjs/g) ?? [],
  );
  return [...new Set(named)].sort();
}

/* ------------------------------------------------------------- the page tree */

/**
 * The extensions Astro routes under `src/pages/` — **Astro's own list**, not ours.
 *
 * `endsWith('.astro')` was the defect: Astro's `settings.pageExtensions` is
 * `['.astro', '.html', ...SUPPORTED_MARKDOWN_FILE_EXTENSIONS]`, which is eight entries,
 * and a page in any of the other seven was served and undiscovered.
 *
 * Read the way `test/isolation.test.ts` reads `getPrerenderOutputDirectory`: resolve the
 * installed `astro` and load the module beside it, because the package's `exports` map
 * publishes neither. `pageExtensions` does not depend on the config — `createBaseSettings`
 * sets it from constants — so the config passed here is a shell, and the call touches no
 * filesystem (checked: it creates no `.astro/` directory).
 *
 * One residual, stated rather than hidden: an integration may add an extension through
 * `addPageExtension` (`@astrojs/mdx` adds `.mdx`). This repository's integrations do not,
 * and the two suites that use this list are read against `src/pages/`, so an extension
 * added by an integration would be a page on disk that this list does not claim — the
 * same shape of hole one layer out. If an integration that adds one is ever installed,
 * this must come from `astro:config:done`'s settings instead.
 */
export const PAGE_EXTENSIONS: readonly string[] = astroPageExtensions();

function astroPageExtensions(): string[] {
  const require_ = createRequire(import.meta.url);
  const module_ = new URL(
    './core/config/settings.js',
    pathToFileURL(require_.resolve('astro')),
  );
  const path = fileURLToPath(module_);

  let loaded: { createBaseSettings?: (config: unknown, logLevel: string) => unknown };
  try {
    loaded = require_(path) as typeof loaded;
    if (loaded.createBaseSettings === undefined) throw new Error('not exported');
  } catch (cause) {
    throw new Error(
      `Could not read Astro's own page-extension list from ${path}. The route guards ` +
        `(test/routes.test.ts, test/seo.test.ts) discover pages with it rather than with a ` +
        `hand-written list of extensions (MUSE-96); if Astro has moved it, re-derive this ` +
        `against the new one rather than pinning a list of extensions here.`,
      { cause },
    );
  }

  const root = pathToFileURL(join(ROOT, '/'));
  const settings = loaded.createBaseSettings(
    {
      root,
      srcDir: new URL('src/', root),
      publicDir: new URL('public/', root),
      outDir: new URL('dist/', root),
      build: {},
      legacy: {},
    },
    'silent',
  ) as { pageExtensions?: unknown };

  const extensions = settings.pageExtensions;
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new Error(
      `Astro's createBaseSettings() returned no pageExtensions (MUSE-96). The route ` +
        `guards cannot discover pages without it.`,
    );
  }
  return [...(extensions as string[])].sort();
}

/**
 * Every file under `dir` that Astro would route as a page, as absolute paths.
 *
 * `dir` rather than a fixed `src/pages` because `test/routes.test.ts` and
 * `test/seo.test.ts` each hold their own `PAGES_DIR` constant.
 */
export function pageFilesUnder(dir: string): string[] {
  return filesUnder(dir).filter((file) =>
    PAGE_EXTENSIONS.includes(extname(file).toLowerCase()),
  );
}

/** `en/schedule.astro` → `en/schedule`; any extension Astro routes, not just `.astro`. */
export function stripPageExtension(file: string): string {
  const extension = extname(file);
  return PAGE_EXTENSIONS.includes(extension.toLowerCase())
    ? file.slice(0, -extension.length)
    : file;
}

/** Whether `absolute` is a file on disk. */
export function isFile(absolute: string): boolean {
  try {
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

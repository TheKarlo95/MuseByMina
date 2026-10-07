import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The one directory anything under `test/` builds into, and the only path anything under
 * `test/` deletes.
 *
 * Inside the repo rather than `os.tmpdir()` on purpose: Astro moves files out of its
 * build staging area with `fs.rename`, which fails with EXDEV when the output directory
 * is on a different filesystem.
 *
 * `test/helpers/clean-scratch.ts` empties it once per run as a `globalSetup`, before any
 * worker exists. That is the only `rm` in the test tree, and `test/isolation.test.ts`
 * fails if a second one appears.
 */
export const SCRATCH = join(ROOT, 'node_modules/.muse-test-builds');

/**
 * Mint a fresh, empty build directory for the caller.
 *
 * This is the fix for MUSE-17, and the reason it is a function rather than a rule in a
 * comment. Three separate agents fixed this bug by giving each suite a *different name*
 * for its output — a `globalSetup` wipe for `build.ts` (MUSE-9), a `suite` parameter for
 * `preview.ts` (MUSE-10) — and it came back both times, because a name is a convention
 * and a convention has to be remembered by whoever writes the next suite.
 *
 * `mkdtempSync` is not a convention. The kernel picks the suffix, and `mkdtemp` either
 * returns a directory that did not exist a moment ago or fails; it cannot hand two
 * callers the same tree. So:
 *
 *   - a new suite cannot collide with an existing one, whatever it passes or forgets to;
 *   - no caller needs to wipe anything, because what it is given is already empty — and
 *     a wipe is what deleted a sibling's output in both earlier incidents.
 *
 * `hint` only shapes the directory name, so a failure message says which suite owns the
 * tree. It has no bearing on isolation: two callers passing the same hint still get
 * different directories, and it is stripped to word characters so it cannot steer the
 * result out of `SCRATCH` either.
 */
export function claimOutDir(hint?: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  return mkdtempSync(join(SCRATCH, `${label(hint) || callingSuite() || 'suite'}-`));
}

/** A directory-name fragment and nothing else: no separators, no `..`, no surprises. */
function label(raw: string | undefined): string {
  return (raw ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
}

/**
 * The test file that called in, read off the stack — best effort, for readability only.
 *
 * Deliberately not `expect.getState().testPath`: this module is also loaded by the
 * `globalSetup`, which runs outside a test worker where importing `vitest` is not safe.
 */
function callingSuite(): string {
  return label(/([^/\\]+)\.test\.ts/.exec(new Error().stack ?? '')?.[1]);
}

/**
 * Vitest stamps Vite's own reserved env names onto `process.env` for the test run.
 * Inherited by a child `astro build` they override the real config — `BASE_URL=/`
 * silently flattens `base`, and `NODE_ENV=test` is not what CI builds with. Drop them so
 * the child sees exactly the environment the deploy workflow gives it.
 */
const VITEST_LEAKS = ['BASE_URL', 'MODE', 'DEV', 'PROD', 'SSR', 'NODE_ENV'];

/**
 * Build the real site into a directory nothing else can name, and return that directory.
 *
 * The single place in `test/` that runs `astro build`. Deliberately shells out rather
 * than poking at Astro internals: every acceptance criterion in this repo is about what
 * lands in the deployed output.
 *
 * `BUILD_CACHE_DIR` is the second half of the isolation, and the part the three earlier
 * fixes missed. `outDir` is not the only directory a build writes: Astro derives its own
 * cache (`node_modules/.astro`) and Vite's dependency cache (`node_modules/.vite`) from
 * the *project root*, which every concurrent build shares — and Vite's dep optimiser
 * commits by renaming `node_modules/.vite/deps` aside and deleting it. No per-suite
 * output name can isolate a directory the suite never names, so `astro.config.mjs` takes
 * the cache root from this variable and each build gets its own.
 *
 * On failure the child's output is folded into the thrown error. `execFileSync` with
 * `stdio: 'pipe'` throws `Command failed: npx astro build …` and keeps the actual Astro
 * diagnostics on `.stdout`/`.stderr`, where a `beforeAll` failure never shows them — the
 * reason the three earlier sightings of this bug were all diagnosed from scratch.
 */
export function astroBuild(env: NodeJS.ProcessEnv, hint?: string): string {
  const outDir = claimOutDir(hint);

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of VITEST_LEAKS) delete childEnv[key];

  try {
    execFileSync('npx', ['astro', 'build', '--outDir', outDir], {
      cwd: ROOT,
      env: { ...childEnv, ...env, BUILD_CACHE_DIR: `${outDir}.cache` },
      stdio: 'pipe',
    });
  } catch (cause) {
    const { stdout, stderr } = cause as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      [
        `astro build failed (outDir ${outDir})`,
        `--- stdout ---\n${String(stdout ?? '')}`,
        `--- stderr ---\n${String(stderr ?? '')}`,
      ].join('\n'),
      { cause },
    );
  }

  return outDir;
}

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { recordHeavyOperation } from '../../scripts/heavy-census.mjs';

import { fetchMeasuredPage } from './measured';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * The one directory anything under `test/` builds into, and the only path anything under
 * `test/` deletes.
 *
 * **Inside the repository, and that is a requirement rather than a preference**
 * (MUSE-41). Astro stages a build's prerendered output in `<outDir>/.prerender/` only
 * while `outDir` sits under the working directory, and otherwise in `<cwd>/.astro/`,
 * renaming every emitted asset out of there — which is `EXDEV` across a filesystem
 * boundary, and one directory shared by every concurrent build when it is not. So moving
 * this to `os.tmpdir()` does not merely risk a cross-device build: it puts all ten of
 * them back on a single staging path, which is MUSE-17 with the names taken away.
 *
 * This used to be the paragraph above as a comment that happened to be true — it was
 * written before MUSE-35 emitted any assets, so there was nothing to move and nothing
 * would have broken. It is now checked: `astro.config.mjs` refuses a build that would
 * stage outside its own output, and `test/isolation.test.ts` asserts both that this path
 * is under the project root and that two builds the helper hands out get two staging
 * directories.
 *
 * `test/helpers/clean-scratch.ts` prunes it once per run as a `globalSetup`, before any
 * worker exists, and prunes **by age** — it is the last shared mutable path in a design
 * whose point is that nothing is shared, and a second vitest in the same checkout used to
 * delete the first one's builds mid-flight (MUSE-34). That is the only `rm` in the test
 * tree, and `test/isolation.test.ts` fails if a second one appears.
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

/**
 * Where the build that writes to `outDir` keeps its caches.
 *
 * A sibling of the output rather than a child of it, so it is minted with the output and
 * pruned with it, and so it cannot turn up in `dist` — `test/nojs.test.ts` asserts the
 * built output contains no `.js` file, and Vite's optimised dependencies are a few
 * hundred of them.
 *
 * It is a function because `test/isolation.test.ts` has to be able to say where a build's
 * caches should have landed, and because `astroBuild` and `astroDev` have to agree. One
 * expression in three places was the shape of MUSE-10.
 */
export function cacheDirFor(outDir: string): string {
  return `${outDir}.cache`;
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
 * Vitest stamps Vite's own reserved env names, and its own, onto `process.env` for the
 * test run. Inherited by a child `astro build` or `astro dev` they override the real
 * config — `BASE_URL=/` silently flattens `base`, and `NODE_ENV=test` is not what CI
 * builds with. Drop them so the child sees exactly the environment the deploy workflow
 * gives it.
 *
 * `VITEST` is the one with teeth, and it is why this list grew (MUSE-35): Astro's dev
 * server plugin **returns early when `process.env.VITEST` is set**
 * (`astro/dist/vite-plugin-astro-server/plugin.js`), because Astro's own suite mounts
 * the server itself. A child `astro dev` that inherits it starts, prints its greeting,
 * reports healthy, and answers every route with `Cannot GET` — a dev server with no
 * site in it. Nothing about that reads as an environment leak from the test's side.
 */
const VITEST_LEAKS = [
  'BASE_URL',
  'MODE',
  'DEV',
  'PROD',
  'SSR',
  'NODE_ENV',
  'VITEST',
  'VITEST_MODE',
  'VITEST_POOL_ID',
  'VITEST_WORKER_ID',
  'TEST',
];

/**
 * `09:36:55 [ERROR] [vite] ✗ Build failed` → the part after the marker.
 *
 * Astro prefixes every error it reports with `[ERROR]`, behind an optional timestamp. That
 * marker is the whole of the rule below: a scan for the *words* in a build log is what
 * `test/helpers/source-guard.ts` exists to argue against, and three shapes were measured
 * before this was written (see `buildErrorHeadline`).
 *
 * Anchored at the start of the line, which is only true of a line with its colour taken
 * off — see the note on `FORCE_COLOR` in `buildErrorHeadline`.
 */
const ASTRO_ERROR_LINE = /^(?:\d{2}:\d{2}:\d{2}\s+)?\[ERROR\]\s*(.*)$/;

/**
 * A line that continues the previous one with *context* rather than with the cause: a
 * stack frame, a code frame, or one of Astro's labelled blocks.
 *
 * Structural rather than a list of banners to keep current, which is the direction that
 * matters: the question being asked is "does the next line say something new", and the
 * three kinds of line that never do are recognisable by their own shape.
 */
const ASTRO_ERROR_CONTEXT = /^\s*(?:at\s|[╭╰│├┬─└┌]|Hint:|Location:|Stack trace:)/;

/**
 * The reason a build failed, in one line, or `''` if the output does not name one.
 *
 * **The headline of a `beforeAll` build failure used to be only `astro build failed
 * (outDir …)`** (MUSE-77), with the cause buried in the folded-in log — so deleting
 * `src/assets/icon/muse-icon-white-32.png` reported itself as an unexplained build
 * failure plus 31 tests never executed, and `[UNRESOLVED_IMPORT] Could not resolve …`,
 * which names the file *and* the import site, was somewhere further down the scroll. A
 * build failure inside a `beforeAll` is the common shape across this suite now, so it is
 * fixed once, here, rather than per file.
 *
 * Three real failures were captured on this tree to write the rule against, because a
 * wrong headline is worse than a generic one — the whole lesson of the ticket:
 *
 *   1. `[ERROR] [vite] ✗ Build failed in 212ms` / `[UNRESOLVED_IMPORT] Could not resolve
 *      '…' in src/lib/icon.ts` — a deleted asset. The banner, then the cause.
 *   2. `[ERROR] [muse-staging-guard] An unhandled error occurred …` / `outDir must live
 *      under the project root (MUSE-41).` — same shape, our own integration.
 *   3. `[ERROR] SanityContentError: There is no \`siteSettings\` document …` / `    at
 *      requireDocument (…)` — the cause is *on* the marker line and what follows is a
 *      stack frame.
 *
 * So: the marker line, plus the line after it when that line says something new. Nothing
 * is ever dropped — the full log still follows on the error — and when no `[ERROR]` line
 * is found this answers `''` and the headline stays exactly as it was.
 *
 * **Every line is stripped of colour first, and that is MUSE-47's lesson rather than a
 * tidy-up.** Astro 7 switches to JSON log lines when it detects an agentic environment and
 * writes the human banner otherwise, so the same failure arrives in two formats —
 * deterministically, by where it ran. The first draft of this matched `[ERROR]` at the
 * start of a line, passed every local run, and answered `''` on a CI runner, where the
 * line really reads:
 *
 *     \x1b[31m\x1b[1m10:03:30\x1b[22m [ERROR] [muse-staging-guard]\x1b[39m An unhandled…
 *
 * Reproduce that locally by unsetting `CLAUDECODE`, `AI_AGENT` and `CLAUDE_CODE_*` **and**
 * setting `FORCE_COLOR=1`: `kleur` turns colour off when stdout is not a TTY, which it
 * never is under a test runner, so unsetting the markers alone gives a plain banner and
 * reads as a clean reproduction.
 */
export function buildErrorHeadline(output: string): string {
  const lines = output.split('\n').map((line) => line.replace(ANSI, ''));
  const marker = lines.findIndex((line) => ASTRO_ERROR_LINE.test(line));
  if (marker === -1) return '';

  const said = (ASTRO_ERROR_LINE.exec(lines[marker]!)?.[1] ?? '').trim();
  const after = lines[marker + 1];
  const detail =
    after !== undefined &&
    after.trim() !== '' &&
    !ASTRO_ERROR_CONTEXT.test(after) &&
    !ASTRO_ERROR_LINE.test(after)
      ? after.trim()
      : '';

  return detail === '' ? said : `${said} — ${detail}`;
}

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
 * the cache root from this variable and each build gets its own. Those two lines in the
 * config *are* the fix, and until MUSE-34 nothing asserted them — delete them and the
 * whole suite stayed green with the shared cache back. `test/isolation.test.ts` is what
 * keeps them now, against a real build.
 *
 * On failure the child's output is folded into the thrown error, which is where a
 * `beforeAll` failure never shows it otherwise — the reason the three earlier sightings
 * of this bug were all diagnosed from scratch. **And the cause is lifted onto the first
 * line** (MUSE-77), because that is the line a test runner prints beside the file name;
 * see `buildErrorHeadline`.
 *
 * **A successful build's output is kept too** (MUSE-46), under `buildLog`. "The build
 * warns, naming the document" is an acceptance criterion in exactly the shape
 * `buildFailure` already serves for "the build fails, naming the document", and a
 * warning that only a unit test has seen is a warning nothing proves the build prints.
 * `spawnSync` rather than `execFileSync` for that reason and one more: `execFileSync`
 * hands back stdout alone on success, and `console.warn` from a page's frontmatter goes
 * to stderr — so a check that read only the return value would depend on which stream a
 * message happened to pick.
 */
export function astroBuild(env: NodeJS.ProcessEnv, hint?: string): string {
  recordHeavyOperation('build');
  const outDir = claimOutDir(hint);

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of VITEST_LEAKS) delete childEnv[key];

  const child = spawnSync('npx', ['astro', 'build', '--outDir', outDir], {
    cwd: ROOT,
    env: { ...childEnv, ...env, BUILD_CACHE_DIR: cacheDirFor(outDir) },
    stdio: 'pipe',
  });

  const said = [
    `--- stdout ---\n${String(child.stdout ?? '')}`,
    `--- stderr ---\n${String(child.stderr ?? '')}`,
  ].join('\n');

  if (child.error || child.status !== 0) {
    const why = buildErrorHeadline(said);
    const headline = `astro build failed (outDir ${outDir})${why === '' ? '' : `: ${why}`}`;
    throw new Error([headline, said].join('\n'), { cause: child.error });
  }

  BUILD_LOGS.set(outDir, said);
  return outDir;
}

/**
 * Run `astro build` into a directory **outside** the project root, and hand back what it
 * said. **This is expected to fail**, and the failure is the subject (MUSE-41).
 *
 * Every other caller here gets a directory under `SCRATCH`, because that is the only
 * place a build can stage safely. This one deliberately asks for the opposite, so that
 * "the build refuses it, naming the cause" is a claim about a real `astro build` rather
 * than about a function called in isolation — the acceptance criterion is phrased against
 * `astro build --outDir`, and before the guard this exited non-zero from inside
 * `ssrMoveAssets` with an `EXDEV` stack.
 *
 * `os.tmpdir()` for the same reason: on the machine this was found on it is a tmpfs, so
 * it is the cross-device case as well as the outside-the-root one. The guard fires on the
 * second, which makes the test deterministic wherever `/tmp` happens to live.
 *
 * It lives here rather than in the suite because this module is the single entry on
 * `test/isolation.test.ts`'s child-process allow-list, and a new name on that list per
 * new need is the defect that file exists to stop. Nothing is written to the directory —
 * the guard runs in `astro:config:setup` — and nothing deletes it, like everywhere else
 * here; it is an empty `mkdtemp` directory under the system temp root.
 */
export function astroBuildOutside(hint?: string): {
  outDir: string;
  status: number | null;
  output: string;
} {
  recordHeavyOperation('build');
  const outDir = mkdtempSync(join(tmpdir(), `muse-outside-${label(hint) || 'suite'}-`));

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of VITEST_LEAKS) delete childEnv[key];

  const child = spawnSync('npx', ['astro', 'build', '--outDir', outDir], {
    cwd: ROOT,
    env: { ...childEnv, BUILD_CACHE_DIR: cacheDirFor(claimOutDir(hint)) },
    stdio: 'pipe',
  });

  return {
    outDir,
    status: child.status,
    output: `${String(child.stdout ?? '')}\n${String(child.stderr ?? '')}`,
  };
}

/** What each successful build printed, keyed by the directory it built into. */
const BUILD_LOGS = new Map<string, string>();

/**
 * Everything `astro build` wrote while producing `outDir`, both streams.
 *
 * Keyed by the output directory because that is the one name a build already has and
 * cannot share — `claimOutDir` mints it with `mkdtemp`, so two builds can never collide
 * on this map the way they used to collide on the directory itself (MUSE-17).
 */
export function buildLog(outDir: string): string {
  const log = BUILD_LOGS.get(outDir);
  if (log === undefined) {
    throw new Error(
      `No build log for ${outDir}. Only a build this process ran through astroBuild() ` +
        `has one, and only if it succeeded — a failed build's output is on the error it threw.`,
    );
  }
  return log;
}

/**
 * A running `astro dev`, and the origin it actually bound to.
 *
 * `origin` and `base` are read off what the server printed rather than off what it was
 * asked for: the port is negotiated (see `astroDev`) and the base comes from the config,
 * so assuming either is how a suite ends up asserting against a server that is not there.
 */
export interface DevServer {
  /** Scheme, host and the port it really bound to — no path. */
  origin: string;
  /** The path the site is mounted under, slash included: `/MuseByMina/`, or `/`. */
  base: string;
  /** Absolute URL for a site route: `url('schedule/')` → `…/MuseByMina/schedule/`. */
  url(route: string): string;
  /** Everything the server has written to stdout/stderr so far, for failure messages. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * The **origin** in the dev server's greeting: `┃ Local    http://localhost:4321/…`.
 *
 * Origin only — scheme, host and the port it really bound to. That is the one fact about
 * a dev server that only the server knows, because the port is negotiated (see
 * `astroDev`), and it is therefore the only fact worth reading out of a log line.
 *
 * **The base used to be read from here too, and that was MUSE-47's CI failure.** The
 * greeting is written for a human, so what follows the URL is a colour reset, and a
 * character class that excludes whitespace, quotes and backslashes does not exclude
 * `ESC`:
 *
 *     ┃ Local    \x1b[36mhttp://localhost:59102/MuseByMina/\x1b[31m
 *
 * The old pattern matched through that escape, `new URL` percent-encoded it, and the base
 * came out `/MuseByMina/%1B[31m/` — so every page 404ed, and the dev server's own 404 log
 * line re-coloured the terminal while printing it, which is why the path read as
 * `//schedule/` rather than as anything recognisable.
 *
 * It survived two years of local runs because Astro 7 switches to **JSON** log lines when
 * it detects an agentic environment (`astro/dist/cli/agent.js`), and in that form the next
 * character after the URL is a literal backslash — which the exclusion set already had,
 * for the unrelated reason MUSE-35 put it there. The plain ANSI banner is only produced
 * where nobody was looking: a CI runner.
 *
 * The lesson is not "add `\x1b` to the class". It is that the base is **configuration**,
 * not something to discover from a server: `astroDev` takes it from `astro.config.mjs`,
 * and cross-checks the greeting against it rather than parsing the greeting for it.
 *
 * The trailing `/` is required but not captured, and that is load-bearing: stdout is a
 * pipe, so a chunk boundary can fall between two digits of the port. Without an anchor
 * after `\d+` the pattern happily matches `http://localhost:591` and the suite then talks
 * confidently to the wrong port.
 */
const DEV_ORIGIN = /(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]):\d+)\//;

/** Colour codes and the like, for comparing a greeting written for a human. */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * The `base` the site is served under, as `astro.config.mjs` resolves it.
 *
 * Imported rather than pinned. `test/` is allowed a copy of the deploy target
 * (`test/helpers/preview.ts` has one, and `test/seo.test.ts` asserts it still matches),
 * but a copy *here* would be a second model of the one thing this helper got wrong, which
 * is how MUSE-9 happens twice. The config reads `process.env.BASE` at import, so this is
 * the default only — a caller that passes `BASE` is answered from its own value.
 *
 * Dynamically imported, inside the one async function that needs it, so the `globalSetup`
 * that imports `SCRATCH` from this module does not evaluate the Astro config and its
 * integrations on its way to pruning a directory.
 */
async function configuredBase(): Promise<string> {
  const loaded = (await import('../../astro.config.mjs')) as { default: { base?: string } };
  return loaded.default.base ?? '/';
}

/** `/MuseByMina` → `/MuseByMina/`; `/` and `''` → `/`. Exactly one slash at each end. */
function asBase(raw: string): string {
  const trimmed = raw.replace(/^\/+|\/+$/g, '');
  return trimmed === '' ? '/' : `/${trimmed}/`;
}

/** Give up waiting for the greeting. Generous: a cold Vite optimise is not instant. */
const DEV_READY_TIMEOUT_MS = 120_000;

/** How long a stopped server gets to exit on SIGTERM before it is killed outright. */
const DEV_STOP_GRACE_MS = 5_000;

/**
 * Every dev server this worker has started and not yet stopped.
 *
 * A leaked `astro dev` does not merely waste a port: it keeps a Vite server and a file
 * watcher alive against this checkout for as long as the machine is up, and the next
 * run inherits them. `afterAll` covers the ordinary path; this covers the one where the
 * worker dies first.
 */
const running = new Set<ChildProcess>();
process.once('exit', () => {
  for (const child of running) signalGroup(child, 'SIGKILL');
});

/**
 * Signal a child **and everything it started**, not just the process we hold.
 *
 * `npx astro dev` is three processes — the `npx` shim, `npm exec`, and the Astro server
 * that actually holds the port — and `child.kill()` signals only the first. npm does
 * forward SIGTERM today, so the obvious version appears to work; it is a behaviour of
 * the package manager, not a guarantee, and when it does not hold the symptom is an
 * orphaned dev server nobody connects to this suite. `detached: true` makes the child a
 * process-group leader, and signalling `-pid` reaches the whole group.
 *
 * ESRCH means the group is already gone, which is the outcome we wanted.
 */
function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Start a real `astro dev` and resolve once it is answering, MUSE-35.
 *
 * The second thing in `test/` that starts a child process, and it lives here for the
 * same reason the first one does: this module is the single entry on
 * `test/isolation.test.ts`'s allow-list, and widening that list by one file per need is
 * the defect this repo keeps re-filing. A dev server also needs a cache root of its own
 * for exactly the reason a build does — Vite's dependency optimiser commits by renaming
 * `node_modules/.vite/deps` aside and deleting it, and `npm test` has ten builds in
 * flight — so it is minted the same way, by `claimOutDir`.
 *
 * Three flags of note:
 *
 *   - `--ignore-lock` keeps the server in the **foreground**. Astro 7 auto-backgrounds
 *     `astro dev` when it detects an agentic environment (`cli/agent.js`), and a
 *     daemonised server is one this helper cannot hold a handle to or reliably kill. It
 *     also means a developer's own dev server on 4321 neither blocks the suite nor is
 *     stopped by it.
 *   - `--port` gets an ephemeral port rather than the default, so parallel workers do
 *     not queue behind each other probing 4321, 4322, 4323…
 *   - …and the port is still **parsed back out of the greeting**, because Astro moves to
 *     the next free port when the one it was given is taken. The number we asked for is
 *     a hint; the number it printed is the truth.
 *
 * Before it hands the server over it **fetches one page and checks that the page says it
 * is that page** — see the probe at the end of this function. `pagesRender: false` is the
 * deliberate opt-out, for the one caller whose pages are *expected* not to render.
 */
export async function astroDev(
  env: NodeJS.ProcessEnv,
  hint?: string,
  { pagesRender = true }: { pagesRender?: boolean } = {},
): Promise<DevServer> {
  recordHeavyOperation('dev');
  const cacheDir = claimOutDir(hint);

  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  for (const key of VITEST_LEAKS) delete childEnv[key];

  // 49152–65535 is the IANA ephemeral range; nothing well-known lives there.
  const port = 49152 + Math.floor(Math.random() * 16_000);

  const child = spawn('npx', ['astro', 'dev', '--ignore-lock', '--port', String(port)], {
    cwd: ROOT,
    env: { ...childEnv, ...env, BUILD_CACHE_DIR: cacheDirFor(cacheDir) },
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so `stop()` can take the Astro server down with the
    // `npx` shim that spawned it — see `signalGroup`.
    detached: true,
  });
  running.add(child);

  let log = '';
  const collect = (chunk: Buffer): void => {
    log += String(chunk);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const stop = async (): Promise<void> => {
    running.delete(child);
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => signalGroup(child, 'SIGKILL'), DEV_STOP_GRACE_MS);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      signalGroup(child, 'SIGTERM');
    });
  };

  const origin = await new Promise<string>((resolve, reject) => {
    const fail = (why: string): void => {
      void stop();
      reject(new Error(`${why}\n--- astro dev output ---\n${log}`));
    };

    const timer = setTimeout(
      () => fail(`astro dev did not come up within ${DEV_READY_TIMEOUT_MS}ms`),
      DEV_READY_TIMEOUT_MS,
    );
    const settle = (fn: () => void): void => {
      clearTimeout(timer);
      child.stdout?.off('data', watch);
      child.stderr?.off('data', watch);
      fn();
    };

    const watch = (): void => {
      const match = DEV_ORIGIN.exec(log.replace(ANSI, ''));
      if (match) settle(() => resolve(match[1]!));
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
    child.once('error', (cause) =>
      settle(() => fail(`astro dev failed to spawn: ${cause.message}`)),
    );
    child.once('exit', (code) =>
      settle(() => fail(`astro dev exited (code ${code}) before it was ready`)),
    );
    watch();
  });

  /**
   * The base comes from the configuration the child was given, never from its output.
   *
   * `env.BASE` if the caller asked for one, else whatever this process already had — the
   * child inherits it — else the config's own default. That is the same three-step answer
   * the child itself computes, so the two cannot disagree by construction.
   */
  const base = asBase(env.BASE ?? childEnv.BASE ?? (await configuredBase()));

  /**
   * …and then the greeting is *checked* against it, rather than parsed for it.
   *
   * If the server is serving a different prefix from the one this helper is about to
   * build URLs under, every page 404s. That used to be the symptom of the bug above and
   * it took a CI run and a coloured log line to recognise; as one error naming both
   * strings it takes a glance. The comparison is on an ANSI-stripped copy because the
   * greeting is written for a human.
   */
  const announced = `${origin}${base}`;
  if (!log.replace(ANSI, '').includes(announced)) {
    await stop();
    throw new Error(
      `astro dev is not serving ${announced}. The base came from ` +
        `${env.BASE !== undefined ? '`env.BASE`' : childEnv.BASE !== undefined ? 'the inherited `BASE`' : '`astro.config.mjs`'}` +
        `, and the server's greeting does not contain that prefix — so every URL this ` +
        `helper builds would 404.\n--- astro dev output ---\n${log}`,
    );
  }

  const server: DevServer = {
    origin,
    base,
    // `base` ends in exactly one slash and the route is stripped of its leading ones, so
    // this cannot emit `//` however it is called.
    url: (route) => `${origin}${base}${route.replace(/^\/+/, '')}`,
    output: () => log,
    stop,
  };

  /**
   * …and then one page is fetched, and that page is asked which page it is (MUSE-62).
   *
   * The cross-check above compares two strings. This asks the server, through the same
   * `fetchMeasuredPage` the suites use, and it is the half that generalises: a `base` from
   * configuration is only correct if the configuration is the one the child read, and a
   * greeting that *contains* the prefix can still be a server serving something else at
   * it. What every caller actually depends on is that `server.url(route)` names a real
   * page — so that is what is checked, once, before the handle exists.
   *
   * Why it is here rather than in each suite: `test/fonts.test.ts` measured `404.astro` in
   * CI for the life of MUSE-35's coverage and stayed green, because the error page carries
   * the same stylesheet, the same six faces and the same two preloads. Its own
   * per-request canonical check (MUSE-62) is what catches a wrong *route*; this catches a
   * wrong *base*, which is the failure that makes every route wrong at once, and it
   * catches it for a suite written next year that has never heard of either ticket.
   *
   * `pagesRender: false` is for `test/devcontent.test.ts`'s live arm, whose Sanity project
   * does not exist: every page it serves is a 500 **and that is its assertion**. An
   * opt-out that asserts nothing, named so that using it is a decision — the shape
   * `openRedirectProbe` has in `scripts/browser-checks.mjs`.
   */
  if (pagesRender) {
    try {
      await fetchMeasuredPage(server.url(''), `astro dev (${label(hint) || 'no hint'})`);
    } catch (problem) {
      await stop();
      throw new Error(
        `${problem instanceof Error ? problem.message : String(problem)}\n` +
          `--- astro dev output ---\n${log}`,
        { cause: problem },
      );
    }
  }

  return server;
}

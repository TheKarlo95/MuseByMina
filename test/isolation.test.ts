import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TestCase, TestModule } from 'vitest/node';
import { describe, expect, it, vi } from 'vitest';

import pruneScratch from './helpers/clean-scratch';
import HookFailureReporter from './helpers/hook-failure-reporter';
import {
  astroBuild,
  astroBuildOutside,
  cacheDirFor,
  claimOutDir,
  SCRATCH,
} from './helpers/scratch';
import {
  buildDirectoryNames,
  copyPasteTripwire,
  deletions,
  fixedSleeps,
  frag,
  INERT_EXTENSIONS,
  inspectedFiles,
  listed,
  processStarts,
  testFiles,
  uncheckedKinds,
  uncommittedTabs,
  unmeasuredDevServers,
} from './helpers/source-guard';

/**
 * MUSE-17 — build isolation, enforced rather than documented.
 *
 * The bug has been fixed three times. MUSE-9 found two suites building into one shared
 * tree and added a `globalSetup` wipe; MUSE-10 found the same thing in the preview helper
 * and gave each suite its own *named* directory; it kept flaking. Every fix so far was a
 * convention — "name your directory something nobody else used" — and a convention only
 * holds for as long as the next author happens to know it.
 *
 * So the invariants live here, as tests, not in a comment:
 *
 *   1. Every build's **caches** are its own, not the checkout's. This is the half that
 *      actually fixed the flake and the half that had no test at all (MUSE-34).
 *   2. The helper cannot hand two callers the same directory, whatever they ask for.
 *   3. Nothing under `test/` can name a build directory; only the helper mints them.
 *   4. Nothing under `test/` deletes anything, except the one `globalSetup` that runs
 *      before any worker exists — and it only prunes what no run could still be using.
 *   5. Nothing under `test/` starts a child process except through that one helper.
 *   6. A file whose hook died is *reported*, not counted as a deselected skip.
 *   7. Nothing under `test/` waits on the clock instead of on a condition (MUSE-54).
 *      That rule reaches the fixed sleep and not the other two shapes MUSE-54 found; what
 *      it cannot see is written out at `fixedSleeps` and asserted below.
 *   8. Every build **stages** inside its own output directory (MUSE-41) — the third
 *      directory a build writes, after the output and the caches, and the one that is
 *      invisible to (3) because Astro derives it rather than us naming it.
 *   9. Nothing under `test/` asserts about a tab it has not seen commit a document
 *      (MUSE-61), and nothing drives a dev server without asking whether its URLs name
 *      real pages (MUSE-62). Both are the family MUSE-48 named: a check that measures
 *      something other than the thing it is about. Their limits are written out at the
 *      rules and asserted at the bottom of this file, like (7)'s.
 *
 * (5) is deliberately about *child processes*, not about `astro build`. MUSE-35 needed
 * a real `astro dev` — the bug it fixes is invisible to anything that reads `dist` —
 * and the tempting move was a second entry on the allow-list below. An allow-list with
 * a new hole punched in it for each new need is the defect this file exists to stop, so
 * `astroDev()` went into `test/helpers/scratch.ts` beside `astroBuild()` instead, and
 * the list is still one file long. It should stay that way.
 *
 * (3)–(5) are read off the **syntax** of the test tree itself, by
 * `test/helpers/source-guard.ts`: an import's exported name, a call's callee, a string
 * literal's value. Before MUSE-34 they were substring searches over raw text, which is a
 * guard with two kinds of wrong answer — it missed `import { rm } from 'node:fs/promises'`
 * and it fired on the word `rmSync` inside a doc comment. Both are now tested on the
 * rules themselves, at the bottom of this file, so the guard's own behaviour is a claim
 * with a test behind it rather than an assumption.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The helper that owns build directories, caches and child processes. */
const BUILD_HELPER = 'test/helpers/scratch.ts';

/** The one `globalSetup`, the only thing in the tree allowed to delete. */
const SCRATCH_CLEANER = 'test/helpers/clean-scratch.ts';

/** Every rule applied to every file it can read, bar the ones named as exempt. */
function offences(
  rule: (file: string) => { file: string; line: number; what: string }[],
  allowed: string[] = [],
): string[] {
  return listed(
    inspectedFiles()
      .filter((file) => !allowed.includes(file))
      .flatMap((file) => rule(file)),
  );
}

describe('a build keeps its caches to itself', () => {
  /**
   * MUSE-34's headline. `outDir` was never the whole fix: Astro derives its own cache
   * (`node_modules/.astro`) and Vite's dependency cache (`node_modules/.vite`) from the
   * *project root*, which every concurrent build shares whatever output directory it was
   * given — and Vite's dep optimiser commits by renaming `node_modules/.vite/deps` aside
   * and **deleting** it while the other nine builds are reading it.
   *
   * The fix is two lines in `astro.config.mjs` taking the cache root from
   * `BUILD_CACHE_DIR`, and until MUSE-34 nothing asserted them. Deleting both left the
   * suite green — 10 files, 204 tests — with the shared cache back and the original race
   * restored. The only symptom would have been intermittent CI months later.
   */
  it('mints a cache root per build, under the scratch root', () => {
    const first = cacheDirFor(claimOutDir('cacheiso'));
    const second = cacheDirFor(claimOutDir('cacheiso'));

    expect(first).not.toBe(second);
    for (const dir of [first, second]) {
      expect(dir.startsWith(`${SCRATCH}/`), dir).toBe(true);
      expect(relative(SCRATCH, dir)).not.toContain('..');
    }
  });

  /**
   * Both halves of the config, evaluated rather than grepped.
   *
   * `astro.config.mjs` is imported for real with `BUILD_CACHE_DIR` set and unset, and the
   * two values it derives are read off the config object. A substring check for the word
   * `cacheDir` would pass against a line that had been commented out, reordered into the
   * wrong block, or pointed at a constant; this cannot. Unset has to stay `undefined` as
   * well, because that is what gives `npm run build` and CI the warm shared cache they
   * want — a default of "somewhere under node_modules" would be slower every deploy.
   */
  it('takes both cache roots from BUILD_CACHE_DIR, and only from there', async () => {
    const sentinel = cacheDirFor(claimOutDir('cacheiso'));

    const set = await loadAstroConfig(sentinel);
    expect(set.cacheDir).toBe(sentinel);
    expect(set.vite?.cacheDir).toBe(`${sentinel}/vite`);

    const unset = await loadAstroConfig(undefined);
    expect(unset.cacheDir).toBeUndefined();
    expect(unset.vite?.cacheDir).toBeUndefined();
  });

  /**
   * And the same claim against a real build, which is the one no refactor can argue with.
   *
   * Vite writes its optimised dependencies the moment it builds, so a cache root that has
   * been honoured is a cache root with files in it. Remove either line from
   * `astro.config.mjs` and `${outDir}.cache` is never created.
   *
   * The ticket's suggested form — "afterwards `node_modules/.astro` does not exist" — was
   * tried and rejected: `npm run build` legitimately creates it (it runs before `npm test`
   * in the gate), and vitest's own dep optimiser creates `node_modules/.vite` for the test
   * run itself. Both make the absence check either vacuous or flaky depending on what ran
   * first, which is a weaker assertion dressed as a stronger one. Asserting where the
   * cache *did* go needs no clean checkout and no cooperation from anything else.
   */
  it("puts a real build's caches in that directory and not in the checkout", () => {
    const outDir = astroBuild({}, 'cacheiso');
    const cache = cacheDirFor(outDir);

    expect(existsSync(cache), `${cache} was never written`).toBe(true);

    const deps = join(cache, 'vite/deps');
    expect(existsSync(deps), `${deps} was never written`).toBe(true);
    expect(readdirSync(deps).length).toBeGreaterThan(0);
  }, 180_000);
});

describe('a suite cannot be handed a directory another suite owns', () => {
  it('never returns the same directory twice', () => {
    const claimed = Array.from({ length: 100 }, () => claimOutDir('guard'));
    expect(new Set(claimed).size).toBe(claimed.length);
  });

  it('returns a directory that exists and is empty', () => {
    const out = claimOutDir('guard');
    expect(statSync(out).isDirectory()).toBe(true);
    expect(readdirSync(out)).toEqual([]);
  });

  it('keeps every claimed directory under the one scratch root', () => {
    // Including when the name it is asked for would climb out of it.
    for (const hint of ['guard', '', '../../etc', 'a/b', '..']) {
      const out = claimOutDir(hint);
      expect(out.startsWith(`${SCRATCH}/`), hint).toBe(true);
      expect(relative(SCRATCH, out), hint).not.toContain('..');
    }
  });

  it('cannot be made to collide by two callers asking for the same name', () => {
    // The `hint` is the part of the old design that a copy-pasted suite got wrong. It
    // now only shapes the directory name, so asking for a taken one is harmless.
    const [first, second] = [claimOutDir('contact'), claimOutDir('contact')];
    expect(first).not.toBe(second);
    expect(dirname(first)).toBe(dirname(second));
  });

  it('does not wipe anything when it mints a directory', () => {
    // The failure mode in both earlier incidents: a suite cleared its output directory
    // before building, and a sibling was building into it. Claiming is not a clear.
    const sentinel = join(claimOutDir('guard'), 'built.html');
    writeFileSync(sentinel, 'output of a build that is still running');
    for (let i = 0; i < 25; i += 1) claimOutDir('guard');
    expect(existsSync(sentinel)).toBe(true);
    expect(readFileSync(sentinel, 'utf8')).toContain('still running');
  });
});

describe('the one wipe in the tree cannot reach a live build', () => {
  /**
   * The last shared mutable path in a design whose point is that nothing is shared.
   *
   * The `globalSetup` used to empty `SCRATCH` outright. That is safe for the run that
   * calls it — a `globalSetup` precedes every worker — and unsafe for anybody else's:
   * a second vitest in the same checkout, which is `--watch` in another terminal or a
   * second agent in the same worktree, deleted the first one's builds mid-flight and the
   * symptom was the original MUSE-17 flake wearing a different hat. CI never saw it,
   * because CI checks out fresh.
   *
   * So the cleaner prunes by **age** instead: a directory no run could still be using.
   * Nothing has to be coordinated, no lock has to be released on a crash, and the
   * housekeeping it was there for still happens.
   */
  it('leaves a build that a concurrent run could still be writing', () => {
    const live = join(claimOutDir('guard'), 'index.html');
    writeFileSync(live, 'a build another vitest is still writing');

    pruneScratch();

    expect(existsSync(live)).toBe(true);
    expect(readFileSync(live, 'utf8')).toContain('still writing');
  });

  it('still clears what an earlier run left behind', () => {
    mkdirSync(SCRATCH, { recursive: true });
    const stale = mkdtempSync(join(SCRATCH, 'yesterday-'));
    writeFileSync(join(stale, 'index.html'), 'output of a run that finished long ago');

    const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(stale, longAgo, longAgo);

    pruneScratch();

    expect(existsSync(stale)).toBe(false);
  });
});

describe('a build stages its prerendered output where it writes it', () => {
  /**
   * MUSE-41 — the third directory a build writes, and the one no suite names.
   *
   * `BUILD_CACHE_DIR` above fixed the second. The third is Astro's prerender staging
   * area, and nothing chose it: `getOutDirWithinCwd` stages in `<outDir>/.prerender/`
   * **only when `outDir` starts with `process.cwd()`**, and otherwise falls back to
   * `<cwd>/.astro/` and renames every emitted asset out of it. Both failures were
   * measured on this tree before the guard went in:
   *
   *   - a build into `/tmp` (a tmpfs here) died in `ssrMoveAssets` with
   *     `EXDEV: cross-device link not permitted` and an Astro stack that never mentions
   *     `outDir`;
   *   - two concurrent builds outside the root both exited 0 and printed
   *     `9 page(s) built` … `Complete!`, and the second had **no `_astro/` directory at
   *     all** while its HTML still linked the stylesheet and all six fonts. The first
   *     build had renamed them out of the shared staging directory.
   *
   * `test/isolation.test.ts`'s other rules cannot see this: they are about the
   * directories *we* name, and this is a directory Astro derives. So the invariant is
   * stated positively instead — **a build's staging directory is inside its own output
   * directory** — which makes it per-build (the output is minted with `mkdtemp`) and
   * on the output's own filesystem, both by construction.
   *
   * None of this leans on `SCRATCH` happening to sit inside the repository. That is the
   * property the ticket asked for and the reason the second test below is the one with
   * teeth: move `SCRATCH` to `os.tmpdir()` and every build's staging directory collapses
   * onto the one shared path, which it reports.
   */

  it("models Astro's staging directory, pinned to Astro's own resolver", async () => {
    // The model is ours — Astro exposes no setting and no supported export for this
    // (checked: `getPrerenderOutputDirectory` is the only caller and it takes nothing
    // but `config.outDir`). So it is pinned to the real function, the way
    // `queryParameters` is pinned to the real GROQ parser: a model nothing compares to
    // the thing it models is a second opinion, not a guard.
    const { prerenderStagingDir } = await loadStagingRules();
    const astroSays = await astroStagingResolver();

    const cwd = process.cwd();
    for (const outDir of [
      join(cwd, 'dist'),
      claimOutDir('staging'),
      join(tmpdir(), 'elsewhere'),
      join(dirname(cwd), 'sibling', 'dist'),
      // The quirk worth modelling faithfully rather than tidying: Astro's test is a raw
      // string prefix with no separator, so a *sibling* whose name extends the root's
      // counts as inside it and stages locally. That build is safe, and a stricter model
      // would reject it for no reason.
      `${cwd}-other/dist`,
      cwd,
    ]) {
      expect(prerenderStagingDir(outDir, cwd), outDir).toBe(astroSays(outDir, cwd));
    }
  });

  it('stages two concurrent builds in two different directories', async () => {
    // The acceptance criterion, against the directories the helper really hands out.
    // Two builds in flight at once is the ordinary state of this suite — there are ten.
    const { prerenderStagingDir } = await loadStagingRules();

    const [first, second] = [claimOutDir('staging'), claimOutDir('staging')];
    const staging = [prerenderStagingDir(first), prerenderStagingDir(second)];

    expect(staging[0]).not.toBe(staging[1]);
    expect(within(staging[0]!, first)).toBe(true);
    expect(within(staging[1]!, second)).toBe(true);
    expect(staging[0]).not.toBe(SHARED_STAGING);
    expect(staging[1]).not.toBe(SHARED_STAGING);
  });

  it('would share one directory if the scratch root left the project', async () => {
    // The inverse, written out so the test above is known to have teeth rather than
    // assumed to. `SCRATCH` under `os.tmpdir()` was a legal edit before MUSE-35 and is
    // the first thing a reader is tempted to do; it collapses every build onto one
    // staging path, which is MUSE-17 with the names taken away.
    const { prerenderStagingDir } = await loadStagingRules();

    const elsewhere = [join(tmpdir(), 'muse-builds', 'a'), join(tmpdir(), 'muse-builds', 'b')];
    const staging = elsewhere.map((dir) => prerenderStagingDir(dir));

    expect(staging[0]).toBe(staging[1]);
    expect(staging[0]).toBe(SHARED_STAGING);
  });

  it('keeps the scratch root inside the project root', () => {
    // Criterion four: the constraint was a comment in `test/helpers/scratch.ts` that
    // happened to be true. Now it is read off the value.
    expect(within(SCRATCH, ROOT), `${SCRATCH} is not under ${ROOT}`).toBe(true);
  });

  it('refuses an outDir that would stage anywhere else, naming the cause', async () => {
    const { stagingFault } = await loadStagingRules();
    const cwd = process.cwd();

    expect(stagingFault(join(cwd, 'dist'), cwd)).toBeNull();
    expect(stagingFault(claimOutDir('staging'), cwd)).toBeNull();

    const fault = stagingFault(join(tmpdir(), 'muse-dist'), cwd);
    expect(fault).not.toBeNull();
    // Named: the output it was given, the directory it would have staged in, and the
    // two things that go wrong there. An EXDEV stack out of `ssrMoveAssets` names none
    // of them, which is why this is a message rather than a `try`/`catch`.
    expect(fault).toContain(join(tmpdir(), 'muse-dist'));
    expect(fault).toContain(SHARED_STAGING);
    expect(fault).toContain('EXDEV');
    expect(fault).toContain('MUSE-41');
  });

  it('refuses it in a real build, before anything is staged', () => {
    // The whole point of the ticket, end to end: `npx astro build --outDir` at another
    // filesystem. `/tmp` is a tmpfs on the machine this was found on, so before the
    // guard this exited non-zero from `ssrMoveAssets`; the failure is now the config's
    // and it arrives before a single file is written.
    const { status, output, outDir } = astroBuildOutside('staging');

    expect(status, output).not.toBe(0);
    expect(output).toContain('MUSE-41');
    expect(output).toContain(outDir);
    expect(output).not.toContain('EXDEV:');
    expect(output).not.toContain('ssrMoveAssets');

    // And nothing was staged, so there is no 233KB of orphaned entry chunk to find
    // later: the build never got as far as emitting one.
    expect(existsSync(join(outDir, '_astro'))).toBe(false);
  }, 120_000);

  it('leaves the directory every build would have shared alone', () => {
    // The same claim as a side effect of a real build rather than as arithmetic over
    // paths. Astro removes its staging directory when it is done with it (`fs.rm`, at
    // the end of `viteBuild`), so a witness placed in the shared one is deleted by any
    // build that stages there — including one in another worker, which is the concurrent
    // case. A build that stages under its own output cannot reach it.
    mkdirSync(SHARED_STAGING, { recursive: true });
    const witness = join(SHARED_STAGING, 'MUSE-41-witness.txt');
    writeFileSync(
      witness,
      'Placed by test/isolation.test.ts. If a build stages here it deletes this file.\n',
    );

    astroBuild({}, 'staging');

    expect(
      existsSync(witness),
      `${witness} was deleted, so a build staged in the directory every build shares`,
    ).toBe(true);
  }, 180_000);

  /** Where every build would stage if `outDir` left the project root. */
  const SHARED_STAGING = join(process.cwd(), '.astro', '.prerender');

  /** Is `child` inside `parent`? */
  function within(child: string, parent: string): boolean {
    const step = relative(parent, child);
    return step !== '' && !step.startsWith('..') && !isAbsolute(step);
  }
});

describe('the rules are enforced on the test tree, not remembered', () => {
  it('reads every file under test/, or says which it cannot', () => {
    // MUSE-34's second hole: the walk collected `.ts` and nothing else, so the same rogue
    // code in a `.mjs` helper was invisible — and the guard was green in the run where
    // two suites collided and one never ran. A file nothing reads is now a failure that
    // names the extension and where to declare it.
    expect(listed(uncheckedKinds())).toEqual([]);
  });

  it('skips nothing it walks except data that cannot execute', () => {
    // The walk and the filter are separate claims, and it was the *filter* that was
    // broken: `.endsWith('.ts')`. This says the filter drops only inert data, whatever
    // the tree happens to hold — so it keeps holding when `test/preview/aboutus.astro`
    // is deleted with the ticket that routes the page, and when the next kind of helper
    // arrives.
    const inert = new Set<string>(INERT_EXTENSIONS);
    const inspected = new Set(inspectedFiles());
    const skipped = testFiles().filter((file) => !inspected.has(file));

    expect(skipped.filter((file) => !inert.has(extname(file).toLowerCase()))).toEqual([]);
  });

  it('lets no suite name a build directory of its own', () => {
    // A build directory lives under the dependency folder. Exactly one file is allowed to
    // know that path; a suite that spells out its own is how MUSE-10 happened.
    expect(offences(buildDirectoryNames, [BUILD_HELPER])).toEqual([]);
  });

  it('lets nothing but the globalSetup delete anything', () => {
    expect(offences(deletions, [SCRATCH_CLEANER])).toEqual([]);
  });

  it('lets nothing but the build helper start a child process', () => {
    // A suite that started its own `astro build` would be free to choose an output
    // directory again, which is the hole all three earlier fixes left open.
    //
    // One entry. A dev server is a child process too and goes in the same module
    // (MUSE-35) — the answer to a new need is never a second name on this list.
    expect(offences(processStarts, [BUILD_HELPER])).toEqual([]);
  });

  it('lets no suite wait on the clock instead of on a condition', () => {
    // MUSE-54. No exemptions, and there is no file that needs one: every wait these
    // suites perform now goes through `test/helpers/browser-settle.ts`, which waits on
    // the page's own frame clock and on load state.
    //
    // The instance is cheap and the pattern is what keeps returning — MUSE-33 replaced
    // the sleep that had just failed and left three behind in the same file, and all
    // three were still there when two more suites flaked on the same afternoon. So this
    // is a rule about the class, like every other rule in this describe block.
    expect(offences(fixedSleeps)).toEqual([]);
  });

  it('lets no suite judge a tab it has not seen commit a document', () => {
    // MUSE-61. The instance was one `expect(tab.url())` reading `about:blank`; the pattern
    // is that `waitForEvent('page')` is an event about a tab object and every gate the
    // suite then had — `load` on an already-loaded blank document, a `localStorage` read
    // against an opaque origin — was satisfiable while the tab held nothing.
    //
    // No exemptions, and the tree needs none: the suite takes delivery of a new tab in one
    // helper, which hands it to `settleNewTab` before returning it.
    expect(offences(uncommittedTabs)).toEqual([]);
  });

  it('lets no suite drive a dev server without measuring which page it got', () => {
    // MUSE-62, whose runtime probe in `astroDev()` is the primary defence; this is the
    // belt. The rule is MUSE-61's author's to own because this is the only parser of the
    // test tree and a second one would be worse than the rule being absent.
    expect(offences(unmeasuredDevServers)).toEqual([]);
  });

  it('keeps the textual tripwire green as well', () => {
    // Crude on purpose, and no longer the only line: it is what catches a deletion
    // through a package nobody has modelled, or an `rm -rf` handed to a shell.
    expect(offences(copyPasteTripwire, [BUILD_HELPER, SCRATCH_CLEANER])).toEqual([]);
  });
});

/**
 * The guard, tested as a guard.
 *
 * Every probe below is an evasion MUSE-34 actually demonstrated against the old scan, or
 * the false positive it demonstrated in the same file. They are strings rather than
 * fixture files because a fixture is a file under `test/` that deliberately breaks the
 * rules, which is a worse problem than the one it solves — and they are assembled with
 * `frag` for the reason `source-guard.ts` explains: a probe containing the literal word
 * would make this file an offender in the suite above.
 */
describe('the guard catches what it claims to, and nothing else', () => {
  const RM = frag('r', 'm');
  const RM_SYNC = frag('r', 'mSync');
  const SPAWN = frag('spa', 'wn');
  const NODE_MODULES = frag('node', '_modules');
  const TAB_EVENT = frag('waitFor', 'Event');
  const TAB_COMMIT = frag('settleNew', 'Tab');
  const DEV_SERVER = frag('astro', 'Dev');

  it('catches a deletion imported from fs/promises', () => {
    // The exact evasion in the ticket: the old needles were `rmSync`, `rmdir` and
    // `promises.rm(`, and this matched none of them.
    const probe = [
      `import { ${RM} } from 'node:fs/promises';`,
      `await ${RM}(dir, { recursive: true, force: true });`,
    ].join('\n');

    expect(deletions('probe.ts', probe).length).toBeGreaterThan(0);
  });

  it('catches a deletion hidden behind an alias', () => {
    const probe = [
      `import { ${RM_SYNC} as tidy } from 'node:fs';`,
      'tidy(dir, { recursive: true });',
    ].join('\n');

    expect(deletions('probe.ts', probe).length).toBeGreaterThan(0);
  });

  it('catches a deletion reached through a namespace or a require', () => {
    const viaNamespace = [
      "import * as fs from 'node:fs';",
      `fs.${RM_SYNC}(dir, { recursive: true });`,
    ].join('\n');
    const viaRequire = [
      "const fs = require('node:fs');",
      `fs['${RM_SYNC}'](dir, { recursive: true });`,
    ].join('\n');

    expect(deletions('probe.cjs', viaNamespace).length).toBeGreaterThan(0);
    expect(deletions('probe.cjs', viaRequire).length).toBeGreaterThan(0);
  });

  it('does not fire on a comment that merely mentions one', () => {
    // The false positive, which matters as much as the misses: a guard whose message
    // points at prose gets its needle edited rather than its hole fixed. The second
    // probe is the ticket's own file — a doc comment that tripped the rule beside a real
    // call that did not.
    const prose = [
      '/**',
      ` * Never ${RM_SYNC} a build directory: a sibling under ${NODE_MODULES} may be`,
      ` * building into it. Not ${RM}, not ${frag('r', 'mdir')}, not a shelled-out`,
      ' * delete either.',
      ' */',
      'export const note = 1;',
      `// ${SPAWN} is also out, and so is naming ${NODE_MODULES}/.astro here.`,
    ].join('\n');

    expect(deletions('probe.ts', prose)).toEqual([]);
    expect(processStarts('probe.ts', prose)).toEqual([]);
    expect(buildDirectoryNames('probe.ts', prose)).toEqual([]);
    expect(copyPasteTripwire('probe.ts', prose)).toEqual([]);
  });

  it('reads a .mjs helper by the same rules as a .test.ts', () => {
    // MUSE-34's second hole, as code: identical rogue content, a plain `.mjs` extension.
    const probe = [
      `import { ${SPAWN}Sync } from 'node:child${'_'}${'process'}';`,
      `${SPAWN}Sync('npx', ['astro', 'build', '--outDir', '${NODE_MODULES}/.shared']);`,
    ].join('\n');

    expect(processStarts('helper.mjs', probe).length).toBeGreaterThan(0);
    expect(buildDirectoryNames('helper.mjs', probe).length).toBeGreaterThan(0);
  });

  it("reads an .astro component's frontmatter", () => {
    const probe = [
      '---',
      `import { ${RM_SYNC} } from 'node:fs';`,
      `${RM_SYNC}(dir, { recursive: true });`,
      '---',
      '<p>a preview route</p>',
    ].join('\n');

    expect(deletions('probe.astro', probe).length).toBeGreaterThan(0);
  });

  it('does not mistake a regular expression for a child process', () => {
    // `DEV_URL.exec(log)` is in the helper this guard protects, and half the suites parse
    // something. A member `exec` is a regex; a bare one cannot be.
    const probe = ['const hit = /(a)(b)/.exec(line);', 'const next = hit?.[1];'].join('\n');

    expect(processStarts('probe.ts', probe)).toEqual([]);
  });

  const SLEEP = frag('waitFor', 'Timeout');

  it('catches a fixed sleep however it is called', () => {
    // MUSE-54's teeth: a method call, a bare call, and a call through a string key —
    // `page['waitForTimeout'](150)` is the obvious way round a rule that only looked at
    // property accesses, and `deletions` already models it for `fs['rmSync']`.
    const asMember = `await page.${SLEEP}(150);`;
    const asBare = `await ${SLEEP}(25);`;
    const asKey = `await page['${SLEEP}'](200);`;

    for (const probe of [asMember, asBare, asKey]) {
      expect(fixedSleeps('probe.ts', probe).length, probe).toBeGreaterThan(0);
    }
  });

  it('leaves an alias to the AST rule’s blind spot and the tripwire behind it', () => {
    // Honest about the seam, and the reason the textual needle was added as well. The
    // call is `pause(…)`, which no rule over callees can recognise — there is no import
    // to resolve the alias through, the way `deletions` resolves `rm as tidy`, because
    // this one is a method on a Playwright object rather than a module export. The
    // *declaration* still spells the name in code, so the second line catches it.
    const probe = [`const { ${SLEEP}: pause } = page;`, 'await pause(150);'].join('\n');

    expect(fixedSleeps('probe.ts', probe)).toEqual([]);
    expect(copyPasteTripwire('probe.ts', probe).length).toBeGreaterThan(0);
  });

  it('names the file and the line so the failure is actionable', () => {
    const probe = ['const a = 1;', '', `await page.${SLEEP}(400);`].join('\n');
    const [offence] = fixedSleeps('test/somewhere.test.ts', probe);

    expect(offence?.file).toBe('test/somewhere.test.ts');
    expect(offence?.line).toBe(3);
    expect(listed(fixedSleeps('test/somewhere.test.ts', probe))[0]).toContain(
      'test/somewhere.test.ts:3',
    );
  });

  it('does not fire on a comment that explains why a sleep was removed', () => {
    // The false positive that matters most for *this* rule. The reasoning for every one
    // of MUSE-54's replacements is written beside it and names the call it replaced; a
    // guard that failed on prose would get those sentences deleted, which is how the
    // knowledge is lost rather than kept. `source-guard.ts`'s own doc comment names it
    // several times and the suite above is green, which is this claim in the live tree.
    const prose = [
      '/**',
      ` * Not a ${SLEEP}: the condition is the frame clock, because a fixed sleep is a`,
      ' * bet that the machine is not busy.',
      ' */',
      'export const note = 1;',
      `// Was: await page.${SLEEP}(150), which read the position mid-scroll.`,
    ].join('\n');

    expect(fixedSleeps('probe.ts', prose)).toEqual([]);
    expect(copyPasteTripwire('probe.ts', prose)).toEqual([]);
  });

  it('cannot reach a measurement that simply never waited', () => {
    // The honesty this ticket asked for, as a test rather than a caveat in prose. This is
    // `test/contact.test.ts`'s CTA flake in miniature: a click and a geometry read with
    // nothing in between. There is no call to forbid, so the rule is silent — and saying
    // so here means the next person to widen the guard can delete this test on purpose
    // instead of discovering the gap in a flake.
    const probe = [
      'await link.click();',
      'const top = await page.evaluate(() => target.getBoundingClientRect().top);',
      'expect(top).toBeGreaterThan(headerBottom);',
    ].join('\n');

    expect(fixedSleeps('probe.ts', probe)).toEqual([]);
    expect(copyPasteTripwire('probe.ts', probe)).toEqual([]);
  });

  it('cannot tell a generous timeout from a tight one', () => {
    // And `test/trialform.test.ts`'s: the right condition on too small a budget. A
    // timeout is a number, and no rule over syntax has an opinion about numbers.
    const probe = "await page.waitForSelector('[data-form-status]', { timeout: 15_000 });";

    expect(fixedSleeps('probe.ts', probe)).toEqual([]);
  });

  it('still trips the tripwire on a shape no rule models', () => {
    // Why the textual scan stays: nothing above understands a shell string, and the
    // AST rules are honest about that.
    const probe = `const cleanup = \`${RM} -rf \${dir}\`;`;

    expect(deletions('probe.ts', probe)).toEqual([]);
    expect(copyPasteTripwire('probe.ts', probe).length).toBeGreaterThan(0);
  });

  it('catches the middle-click test as MUSE-61 found it', () => {
    // Verbatim shape of the failing test: the tab taken out of the event, then three waits
    // a blank tab satisfies. Named `probe.ts` so the rule is being tested, not the tree.
    const probe = [
      `const opened = context.${TAB_EVENT}('page', { timeout: 15_000 });`,
      "await page.locator(switchTo('hr')).click({ button: 'middle' });",
      'const tab = await opened;',
      "await tab.waitForLoadState('load');",
      'await tab.waitForFunction((key) => localStorage.getItem(key) !== null, KEY);',
      'expect(tab.url()).toBe(expected);',
    ].join('\n');

    const [offence] = uncommittedTabs('test/somewhere.test.ts', probe);
    expect(offence?.line).toBe(1);
    expect(listed(uncommittedTabs('test/somewhere.test.ts', probe))[0]).toContain(
      'test/somewhere.test.ts:1',
    );
    expect(offence?.what).toContain(TAB_COMMIT);
  });

  it('is satisfied by the commit wait, however the tab was obtained', () => {
    // Both idioms: the promise held in a variable, and the event awaited inline. And the
    // `popup` event as well as `page`, since either produces the same blank tab.
    for (const probe of [
      [
        `const opened = context.${TAB_EVENT}('page');`,
        'const tab = await opened;',
        `await ${TAB_COMMIT}(tab, 'the tab to commit');`,
      ].join('\n'),
      [
        `const tab = await context.${TAB_EVENT}('popup');`,
        `await ${TAB_COMMIT}(tab, 'the tab to commit');`,
      ].join('\n'),
    ]) {
      expect(uncommittedTabs('probe.ts', probe), probe).toEqual([]);
    }
  });

  it('does not fire on a comment that explains the blank-tab trap', () => {
    // The MUSE-34 property, for this rule too: the paragraph in `browser-settle.ts` that
    // explains what a tab event does not prove must not be the thing that fails CI.
    const prose = [
      `// ${TAB_EVENT}('page') resolves when the tab object exists, not when it has`,
      '// navigated — so `const tab = await opened` holds about:blank.',
      'await settleScroll(page);',
    ].join('\n');

    expect(uncommittedTabs('probe.ts', prose)).toEqual([]);
    expect(copyPasteTripwire('probe.ts', prose)).toEqual([]);
  });

  it('cannot see a tab the file never gives a name to', () => {
    // Written out because a limit nobody states is read as a limit that does not exist.
    // There is no binding to follow here, so the rule is silent; the suite's single point
    // of delivery is what makes that acceptable rather than a hole.
    const probe = [
      `const opened = context.${TAB_EVENT}('page');`,
      "await (await opened).waitForLoadState('load');",
      'expect((await opened).url()).toBe(expected);',
    ].join('\n');

    expect(uncommittedTabs('probe.ts', probe)).toEqual([]);
  });

  it('catches a dev server driven without the which-page check, and clears one with it', () => {
    // MUSE-62's rule. The offence is the import, so the message can name the line that
    // brought the server in rather than the first request that measured the wrong page.
    const without = [
      `import { ${DEV_SERVER} } from './helpers/scratch';`,
      `dev = await ${DEV_SERVER}({}, 'fonts');`,
    ].join('\n');
    const with_ = [
      "import { fetchMeasuredPage } from './helpers/measured';",
      `import { ${DEV_SERVER} } from './helpers/scratch';`,
      `dev = await ${DEV_SERVER}({}, 'fonts');`,
    ].join('\n');

    expect(unmeasuredDevServers('probe.ts', without).length).toBeGreaterThan(0);
    expect(unmeasuredDevServers('probe.ts', without)[0]?.line).toBe(1);
    expect(unmeasuredDevServers('probe.ts', with_)).toEqual([]);
  });
});

describe('the run reports a dead hook rather than swallowing it', () => {
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');

  it('still prunes the scratch root once, before the workers start', () => {
    expect(config).toContain('globalSetup');
    expect(config).toContain('clean-scratch');
  });

  it('registers the reporter that names a file which never ran', () => {
    // Without it the summary says "19 skipped" for a file whose beforeAll died, which is
    // how three incidents of this bug read as "nothing to see here".
    expect(config).toContain('hook-failure-reporter');
    expect(config).toContain("'default'");
  });

  /**
   * And what it does, not just that it is registered (MUSE-34's fifth hole).
   *
   * The two assertions below are the reporter's whole contract, and they fail in opposite
   * directions: invert its `mode !== 'run'` filter and the file whose hook died goes
   * unreported *and* a deliberate `.skip` gets announced as broken. A substring check on
   * `vitest.config.ts` cannot see either.
   */
  it('names a file whose tests never ran', () => {
    const output = reportOn([
      failedModule('test/contact.test.ts', [
        neverRanTest(),
        neverRanTest(),
        neverRanTest(),
      ]),
    ]);

    expect(output).toContain('test/contact.test.ts');
    expect(output).toContain('3 test(s) never executed');
    expect(output).toContain('NEVER RAN');
  });

  it('leaves tests their author deliberately skipped alone', () => {
    const output = reportOn([
      failedModule('test/contact.test.ts', [skippedTest('skip'), skippedTest('todo')]),
    ]);

    expect(output).toBe('');
  });

  it('says nothing about a file that ran and failed honestly', () => {
    const output = reportOn([
      failedModule('test/contact.test.ts', [ranTest('failed'), ranTest('passed')]),
    ]);

    expect(output).toBe('');
  });

  it('says nothing at all about a clean run', () => {
    expect(reportOn([passedModule('test/contact.test.ts', [ranTest('passed')])])).toBe('');
  });
});

/**
 * The two staging rules out of `astro.config.mjs` (MUSE-41).
 *
 * The config is the one place the rule is written — it is in front of every build there
 * is, including a hand-typed `npx astro build` — so the test reads it from there rather
 * than keeping a copy.
 */
async function loadStagingRules(): Promise<StagingRules> {
  vi.resetModules();
  return (await import('../astro.config.mjs')) as unknown as StagingRules;
}

/** The named exports of `astro.config.mjs` this file has an opinion about. */
interface StagingRules {
  prerenderStagingDir(outDir: string, cwd?: string): string;
  stagingFault(outDir: string, cwd?: string): string | null;
}

/**
 * Astro's *own* answer to "where will this build stage its prerendered output", as a
 * function of `outDir` and `cwd`.
 *
 * `getPrerenderOutputDirectory` is not on Astro's `exports` map, so it is reached through
 * the package's resolved entry point rather than by spelling a path — which also keeps
 * this file clear of `test/isolation.test.ts`'s own rule about naming build directories.
 *
 * If a future Astro moves or renames it this throws at import, and that is the intended
 * outcome: the model in `astro.config.mjs` is a model of this function, and an Astro
 * upgrade is exactly when somebody needs to look at it again. The message says so.
 */
async function astroStagingResolver(): Promise<
  (outDir: string, cwd: string) => string
> {
  const entry = createRequire(import.meta.url).resolve('astro');
  const utils = new URL('./prerender/utils.js', pathToFileURL(entry));

  let resolve: (settings: unknown) => URL;
  try {
    const loaded = (await import(utils.href)) as {
      getPrerenderOutputDirectory?: (settings: unknown) => URL;
    };
    if (loaded.getPrerenderOutputDirectory === undefined) throw new Error('not exported');
    resolve = loaded.getPrerenderOutputDirectory;
  } catch (cause) {
    throw new Error(
      `Could not read Astro's own staging-directory resolver at ${utils.pathname}. ` +
        `prerenderStagingDir() in astro.config.mjs models that function (MUSE-41); if ` +
        `Astro has moved it, re-derive the model against the new one rather than ` +
        `deleting this test.`,
      { cause },
    );
  }

  return (outDir, cwd) => {
    const was = process.cwd();
    try {
      process.chdir(cwd);
      const url = resolve({
        buildOutput: 'static',
        adapter: undefined,
        config: { outDir: pathToFileURL(`${outDir}/`) },
      });
      return fileURLToPath(url).replace(/[/\\]$/, '');
    } finally {
      process.chdir(was);
    }
  };
}

/**
 * `astro.config.mjs`, evaluated with `BUILD_CACHE_DIR` set to `cacheRoot`.
 *
 * The module reads `process.env` once, at import, so two values need two evaluations —
 * hence `vi.resetModules()` rather than a cache-busting query string, which vite refuses
 * to resolve when the specifier is not a literal. The variable is restored afterwards
 * because this worker goes on to build.
 */
async function loadAstroConfig(cacheRoot: string | undefined): Promise<AstroConfigCaches> {
  const before = process.env.BUILD_CACHE_DIR;
  if (cacheRoot === undefined) delete process.env.BUILD_CACHE_DIR;
  else process.env.BUILD_CACHE_DIR = cacheRoot;

  try {
    vi.resetModules();
    const loaded = (await import('../astro.config.mjs')) as { default: AstroConfigCaches };
    return loaded.default;
  } finally {
    if (before === undefined) delete process.env.BUILD_CACHE_DIR;
    else process.env.BUILD_CACHE_DIR = before;
  }
}

/** The two values of the config this file has an opinion about. */
interface AstroConfigCaches {
  cacheDir?: string | undefined;
  vite?: { cacheDir?: string | undefined } | undefined;
}

/** Everything the reporter wrote to stderr for these modules. */
function reportOn(modules: TestModule[]): string {
  let written = '';
  const stderr = process.stderr;
  const original = stderr.write.bind(stderr);
  stderr.write = ((chunk: unknown) => {
    written += String(chunk);
    return true;
  }) as typeof stderr.write;

  try {
    new HookFailureReporter().onTestRunEnd(modules);
  } finally {
    stderr.write = original;
  }
  return written;
}

/** A test vitest was asked to run that never produced a result: a hook above it died. */
function neverRanTest(): TestCase {
  return { options: { mode: 'run' }, result: () => ({ state: 'skipped' }) } as unknown as TestCase;
}

/** A test its author skipped on purpose. */
function skippedTest(mode: 'skip' | 'todo'): TestCase {
  return { options: { mode }, result: () => ({ state: 'skipped' }) } as unknown as TestCase;
}

/** A test that ran. */
function ranTest(state: 'passed' | 'failed'): TestCase {
  return { options: { mode: 'run' }, result: () => ({ state }) } as unknown as TestCase;
}

function failedModule(id: string, tests: TestCase[]): TestModule {
  return stubModule(id, 'failed', tests);
}

function passedModule(id: string, tests: TestCase[]): TestModule {
  return stubModule(id, 'passed', tests);
}

/**
 * The slice of vitest's `TestModule` the reporter actually reads.
 *
 * A stub rather than a nested real run: the state this reporter exists for — a module
 * marked failed whose tests have no result — is precisely the state that is awkward to
 * produce on purpose, and a reporter is a pure function of what it is handed.
 */
function stubModule(id: string, state: 'failed' | 'passed', tests: TestCase[]): TestModule {
  return {
    relativeModuleId: id,
    state: () => state,
    children: { allTests: () => tests },
  } as unknown as TestModule;
}

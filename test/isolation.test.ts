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
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TestCase, TestModule } from 'vitest/node';
import { describe, expect, it, vi } from 'vitest';

import pruneScratch from './helpers/clean-scratch';
import HookFailureReporter from './helpers/hook-failure-reporter';
import { astroBuild, cacheDirFor, claimOutDir, SCRATCH } from './helpers/scratch';
import {
  buildDirectoryNames,
  copyPasteTripwire,
  deletions,
  frag,
  INERT_EXTENSIONS,
  inspectedFiles,
  listed,
  processStarts,
  testFiles,
  uncheckedKinds,
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

  it('still trips the tripwire on a shape no rule models', () => {
    // Why the textual scan stays: nothing above understands a shell string, and the
    // AST rules are honest about that.
    const probe = `const cleanup = \`${RM} -rf \${dir}\`;`;

    expect(deletions('probe.ts', probe)).toEqual([]);
    expect(copyPasteTripwire('probe.ts', probe).length).toBeGreaterThan(0);
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

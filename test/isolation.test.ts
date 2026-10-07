import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { claimOutDir, SCRATCH } from './helpers/scratch';

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
 *   1. The helper cannot hand two callers the same directory, whatever they ask for.
 *   2. Nothing under `test/` can name a build directory; only the helper mints them.
 *   3. Nothing under `test/` deletes anything, except the one `globalSetup` that runs
 *      before any worker exists.
 *   4. Nothing under `test/` starts a child process except through that one helper.
 *
 * (4) is deliberately about *child processes*, not about `astro build`. MUSE-35 needed
 * a real `astro dev` — the bug it fixes is invisible to anything that reads `dist` —
 * and the tempting move was a second entry on the allow-list below. An allow-list with
 * a new hole punched in it for each new need is the defect this file exists to stop, so
 * `astroDev()` went into `test/helpers/scratch.ts` beside `astroBuild()` instead, and
 * the list is still one file long. It should stay that way.
 *
 * (2)–(4) are read off the source of the test tree itself, so a new suite that reaches
 * past the helper fails this file rather than quietly reintroducing the race.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Every `.ts` file in the test tree, as repo-relative paths. */
function testSources(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
    });
  return walk(TEST_DIR)
    .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
    .sort();
}

/**
 * The files that contain `needle`, other than the ones allowed to.
 *
 * Needles are assembled from fragments on purpose: this file is part of the tree it
 * walks, so a literal would make the guard report itself and the exemption list would
 * have to include the guard — which is exactly the hole these tests exist to close.
 */
function offenders(needle: string, allowed: string[]): string[] {
  return testSources().filter(
    (file) =>
      !allowed.includes(file) && readFileSync(join(ROOT, file), 'utf8').includes(needle),
  );
}

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

describe('the rules are enforced on the test tree, not remembered', () => {
  it('lets no suite name a build directory of its own', () => {
    // A build directory lives under the dependency folder. Exactly one file is allowed
    // to know that path; a suite that spells out its own is how MUSE-10 happened.
    expect(offenders(`node_${'modules'}/`, ['test/helpers/scratch.ts'])).toEqual([]);
  });

  it('lets nothing but the globalSetup delete a directory', () => {
    // Matched without the call parens, so aliasing the import on the way in does not
    // get past it — the imported name still appears in the import clause.
    const removers = [`rm${'Sync'}`, `rm${'dir'}`, `promises.${'rm'}(`];
    for (const needle of removers) {
      expect(offenders(needle, ['test/helpers/clean-scratch.ts']), needle).toEqual([]);
    }
  });

  it('lets nothing but the build helper start a child process', () => {
    // A suite that started its own `astro build` would be free to choose an output
    // directory again, which is the hole all three earlier fixes left open. The module
    // itself is on the list, so an aliased import does not slip through either.
    //
    // One entry. A dev server is a child process too and goes in the same module
    // (MUSE-35) — the answer to a new need is never a second name on this list.
    const starters = [
      `node:child_${'process'}`,
      `exec${'FileSync'}`,
      `exec${'Sync'}`,
      `s${'pawn'}`,
    ];
    for (const needle of starters) {
      expect(offenders(needle, ['test/helpers/scratch.ts']), needle).toEqual([]);
    }
  });
});

describe('the run reports a dead hook rather than swallowing it', () => {
  const config = readFileSync(join(ROOT, 'vitest.config.ts'), 'utf8');

  it('still empties the scratch root once, before the workers start', () => {
    expect(config).toContain('globalSetup');
    expect(config).toContain('clean-scratch');
  });

  it('registers the reporter that names a file which never ran', () => {
    // Without it the summary says "19 skipped" for a file whose beforeAll died, which is
    // how three incidents of this bug read as "nothing to see here".
    expect(config).toContain('hook-failure-reporter');
    expect(config).toContain("'default'");
  });
});

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { scratchRoots } from './scratch';

/**
 * How old a build directory has to be before this is allowed to delete it.
 *
 * Generously longer than any build can live: `hookTimeout` is four minutes, so a build
 * still being written is minutes old at worst, and an hour is fifteen times that. Shorter
 * than a working session, so yesterday's output does not sit in `node_modules` forever.
 *
 * The number is not load-bearing; the *existence* of a threshold is. See below.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Prune the build scratch root once per run, before any test file loads.
 *
 * The only `rm` in the test tree, and `test/isolation.test.ts` fails if a second one
 * appears. It is housekeeping, not isolation: `claimOutDir` hands out a directory that is
 * already empty, so nothing here is required for a run to be correct. This just stops
 * yesterday's builds accumulating.
 *
 * **It prunes by age rather than emptying the root, and that is the point** (MUSE-34).
 * A `globalSetup` runs in the main process before any worker exists, so there is no build
 * *of this run's* for it to delete — but there may be another run's. A second vitest in
 * the same checkout — `--watch` in one terminal and `npm test` in another, or two agents
 * in one worktree — used to have its builds deleted from under it by whichever started
 * second, and the symptom was MUSE-17's original flake wearing a different hat: a build
 * directory that existed when the child was spawned and did not when it wrote. CI never
 * saw it, because CI checks out fresh.
 *
 * An age threshold needs no coordination, no lock to release on a crash and no pid file
 * to go stale, and it cannot reach a directory a live run could still be using. It leaves
 * `SCRATCH` the last shared mutable path in the design, which is why it is also the last
 * one that can destroy anything: it can't.
 *
 * Only the entries directly under a scratch root are considered — the output directories
 * and cache roots `claimOutDir` and `cacheDirFor` mint — so this never walks into a build.
 *
 * **And it is every scratch root in the checkout, not just this worktree's** (MUSE-79).
 * The policy above is unchanged and so is the age; what was wrong was the *reach*. One
 * worktree per ticket means a run in one of them never looked at the others, and a
 * worktree whose pull request merged is never run in again — so its builds were never
 * reached by anything, and 30,061 of them filled the disk until a run died with ENOSPC.
 * Age is still the only discriminator, which is what makes the wider scope safe: another
 * agent's *live* build is minutes old wherever it lives, and nothing here can see it.
 * `scratchRoots()` is where the roots come from, and it is in `scratch.ts` because that
 * file is the only one allowed to know the path.
 *
 * The first run after this lands has a backlog to clear and can take a while; every run
 * after it has at most an hour's worth.
 */
export default function setup(): void {
  prune();
}

/**
 * The prune itself, over every scratch root under `repository`.
 *
 * Separate from the default export because `globalSetup` is **called with vitest's own
 * context object** as its first argument: a `base` parameter on `setup` would be handed a
 * `GlobalSetupContext` on every real run and prune whatever that stringified to. This
 * takes the argument instead, so `test/isolation.test.ts` can point the whole thing at a
 * tree of its own and watch a second worktree's stale build go.
 */
export function prune(repository?: string): void {
  const cutoff = Date.now() - STALE_AFTER_MS;

  for (const root of scratchRoots(repository)) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue; // Another run's sweep took the root itself between those two calls.
    }
    for (const entry of entries) {
      const path = join(root, entry);
      try {
        if (statSync(path).mtimeMs > cutoff) continue;
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Another run pruning the same leftovers got there first. Housekeeping is not
        // something to fail a run over, and the whole point of the threshold is that
        // whatever it does reach is nobody's.
      }
    }
  }
}

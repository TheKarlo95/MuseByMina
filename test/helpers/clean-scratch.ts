import { rmSync } from 'node:fs';

import { SCRATCH } from './scratch';

/**
 * Empty the build scratch root once per run, before any test file loads.
 *
 * The only `rm` in the test tree, and `test/isolation.test.ts` fails if a second one
 * appears. A `globalSetup` runs in the main process before any worker exists, so there
 * is no build for it to delete — unlike a wipe inside a build helper, which is what
 * deleted a sibling suite's output in MUSE-9 and again in MUSE-10.
 *
 * It is housekeeping, not isolation: `claimOutDir` hands out a directory that is already
 * empty. This just stops yesterday's builds accumulating in `node_modules`.
 */
export default function setup(): void {
  rmSync(SCRATCH, { recursive: true, force: true });
}

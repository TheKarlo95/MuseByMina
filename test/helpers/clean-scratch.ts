import { rmSync } from 'node:fs';

import { SCRATCH } from './build';

/**
 * Empty the build scratch directory once per run, before any test file loads.
 *
 * A `globalSetup` rather than a lazy wipe inside `buildSite`: vitest runs test files in
 * parallel, so "wipe if I am the first to build" ran once per file and deleted a sibling
 * suite's output from under a running `astro build`.
 */
export default function setup(): void {
  rmSync(SCRATCH, { recursive: true, force: true });
}

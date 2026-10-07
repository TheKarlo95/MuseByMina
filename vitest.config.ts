import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Housekeeping only: empties the build scratch root once, before the parallel
    // workers start. Isolation itself comes from `test/helpers/scratch.ts`, which hands
    // every build a directory no other suite can name (MUSE-17).
    globalSetup: ['test/helpers/clean-scratch.ts'],
    // `fileParallelism` stays on. The suite launches ten real `astro build` runs and
    // serialising the files would roughly triple the wall clock; with the output
    // directories minted rather than named, parallel builds no longer share anything
    // mutable, so the speed costs no correctness. The fix is isolation, not a queue.
    //
    // The default reporter calls the tests in a file whose `beforeAll` died "skipped".
    // That reading is how this bug survived three sightings, so a second reporter says
    // out loud that the file never ran.
    reporters: ['default', './test/helpers/hook-failure-reporter.ts'],
    // The SEO suite shells out to two real `astro build` runs.
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});

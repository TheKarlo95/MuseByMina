import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    /**
     * **Where the suite gets its content, and the only place this is said (MUSE-20).**
     *
     * The suite runs ten real `astro build`s in parallel workers. Fetching from the
     * Sanity API in each of them would buy ten HTTP round-trips per run, a new flakiness
     * source, and a suite whose result depends on whether anybody is mid-edit in the
     * Studio. So every build reads `sanity/seed/content.ndjson` instead — **the same
     * file `npm run sanity:seed` imports into the dataset**, evaluated by Sanity's own
     * GROQ engine against the real queries (`src/lib/sanity/fixture.ts`).
     *
     * One file, so the migration artefact and the test fixture cannot diverge: changing
     * what gets imported changes what the tests read.
     *
     * It is set here rather than in `test/helpers/scratch.ts` because it is a property of
     * the *run*, not of a build: `astroBuild` passes `process.env` to the child, so every
     * build — including the ones `test/helpers/preview.ts` starts — inherits it with
     * nothing to remember. The deploy workflow sets nothing, and therefore fetches live;
     * `test/content.test.ts` asserts that it never does.
     */
    env: { MUSE_CONTENT_FIXTURE: 'sanity/seed/content.ndjson' },
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

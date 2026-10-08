import { getViteConfig } from 'astro/config';
import type { TestUserConfig } from 'vitest/config';

const test: TestUserConfig = {
  include: ['test/**/*.test.ts'],
  /**
   * **Where the suite gets its content, and the only place this is said (MUSE-20).**
   *
   * The suite runs ten real `astro build`s in parallel workers. Fetching from the
   * Sanity API in each of them would buy ten HTTP round-trips per run, a new flakiness
   * source, and a suite whose result depends on whether anybody is mid-edit in the
   * Studio. So every build reads `content/seed.ndjson` instead — **the same
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
   *
   * A suite that renders a component in-process rather than building the site reads it
   * the same way — `src/lib/sanity/fixture.ts` resolves `process.env` per query — so
   * `test/pricing.test.ts` points it at a dataset of its own and nothing here changes.
   */
  env: { MUSE_CONTENT_FIXTURE: 'content/seed.ndjson' },
  // Housekeeping only: prunes stale directories from the build scratch root once, before
  // the parallel workers start. Isolation itself comes from `test/helpers/scratch.ts`,
  // which hands every build a directory no other suite can name and a cache root of its
  // own (MUSE-17). It prunes *by age* rather than emptying the root, so a second vitest in
  // this checkout cannot delete this one's builds — see the file (MUSE-34), and
  // `test/isolation.test.ts`, which asserts both halves of that against a real run.
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
};

/**
 * **Astro's own Vite config, not a bare Vitest one (MUSE-22).**
 *
 * `test/pricing.test.ts` imports `src/components/Pricing.astro` and renders it through
 * Astro's container API, because `/pricing` is deliberately not a route yet — there are
 * no real prices. That needs the `.astro` compiler in the pipeline, and `getViteConfig`
 * is how Astro supplies it: it loads `astro.config.mjs` and hands back the same Vite
 * config a build uses, with this test block merged in. Without it the import fails in
 * `vite:import-analysis` on the first `{expression}` in the markup, which reads like a
 * syntax error in the component rather than a missing plugin.
 *
 * Every assertion that was here before is untouched by it: they read `dist` or spawn a
 * build, and a build is a child process with its own config. Checked by running the
 * whole suite before and after the change.
 *
 * The cast is the one wart. `getViteConfig` takes Vite's `UserConfig`, which has no
 * `test` key — Vitest adds that by module augmentation, and the `vite` types Astro's
 * signature refers to are not the declaration `vitest/config` augments. So the block
 * above is typed as `TestUserConfig`, where every option in it *is* checked, and the
 * cast covers only the handover.
 */
export default getViteConfig({ test } as Parameters<typeof getViteConfig>[0]);

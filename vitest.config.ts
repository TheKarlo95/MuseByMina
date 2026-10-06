import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Clears the build scratch space once, before the parallel workers start — each
    // suite shells out to real `astro build` runs into it.
    globalSetup: ['test/helpers/clean-scratch.ts'],
    // The SEO suite shells out to two real `astro build` runs.
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});

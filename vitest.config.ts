import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The SEO suite shells out to two real `astro build` runs.
    testTimeout: 60_000,
    hookTimeout: 240_000,
  },
});

import { defineCliConfig } from 'sanity/cli';

/**
 * CLI config for `sanity schema extract`, `sanity typegen generate` and `sanity deploy`.
 *
 * `studioHost` fixes the hosted Studio's URL at **https://musebymina.sanity.studio**, so
 * `sanity deploy` is non-interactive and always lands on the same address. That matters
 * more than it looks: without it the CLI prompts for a hostname on first deploy, which
 * means it cannot run in CI, which means the Studio only gets redeployed when somebody
 * remembers — and a Studio one schema behind the dataset shows Mina fields that no
 * longer exist and hides ones that do.
 *
 * `.github/workflows/studio.yml` runs the deploy on every push to `main` that touches a
 * schema file. See that file for the one secret it needs.
 */
export default defineCliConfig({
  api: {
    projectId: process.env.SANITY_STUDIO_PROJECT_ID ?? 'q6fk9usq',
    dataset: process.env.SANITY_STUDIO_DATASET ?? 'production',
  },
  studioHost: 'musebymina',

  /**
   * `sanity typegen generate` — schema in, TypeScript out.
   *
   * `path` is `queries.ts` alone rather than `src/**`, which is both faster and a second
   * statement of the one-module rule: a GROQ query written anywhere else would not even
   * get a generated type, never mind a reviewed one.
   *
   * `overloadClientMethods` is off on purpose. It augments `@sanity/client`'s own
   * `fetch` signature globally, which is convenient in a Sanity-shaped app and wrong
   * here: this site's read path is `src/lib/sanity/index.ts`, every query goes through
   * `runQuery`, and a global augmentation would make `client.fetch` look typed from
   * anywhere — the opposite of the single entry point MUSE-19 asks for. The types are
   * consumed explicitly in `src/lib/sanity/shape.ts` instead.
   */
  typegen: {
    path: './src/lib/sanity/queries.ts',
    schema: './sanity/schema.json',
    generates: './src/lib/sanity/sanity.types.ts',
    overloadClientMethods: false,
  },

  /**
   * Let Sanity keep the hosted Studio's own runtime current.
   *
   * With auto-updates on, a Sanity patch release reaches Mina without a deploy from
   * here. What it does *not* cover is the schema: that is this repo's, and the workflow
   * is what pushes it. Keeping the two separate is the point — the Studio's framework
   * and the studio's content model have different release cadences.
   *
   * Nested under `deployment` because the top-level `autoUpdates` spelling is deprecated
   * as of `sanity@6`: it still works, but every CLI invocation printed a migration
   * warning, and a warning nobody can act on is a warning everybody learns to skip.
   */
  deployment: {
    autoUpdates: true,
  },

  /**
   * `sanity build` defaults its output to `dist/`, which is Astro's.
   *
   * Nothing currently runs both in one working tree, but a Studio bundle landing in the
   * directory the deploy workflow uploads to GitHub Pages would publish React, the
   * editor and a login form to the public site — and `test/nojs.test.ts` only runs
   * against a fresh `astro build`, so it would not necessarily catch it. The npm
   * scripts therefore always name `.sanity/studio` explicitly, and that path is
   * gitignored.
   */
});

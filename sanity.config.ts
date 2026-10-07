import { defineConfig } from 'sanity';
import { structureTool } from 'sanity/structure';

import { schemaTypes } from './sanity/schemaTypes';
import { singletonTypes, structure } from './sanity/structure';

/**
 * The Studio — **hosted by Sanity, not mounted at `/studio` in this app.**
 *
 * The decision and its two reasons (MUSE-19):
 *
 *   1. This site ships **zero JavaScript files**. `test/nojs.test.ts` asserts it against
 *      the built output, because it is a real property of a static marketing site and
 *      not an aspiration. Mounting the Studio here would add React, the editor and the
 *      whole Sanity runtime to the same build — not to the visitor's page, but to the
 *      same `dist`, the same deploy, and the same place a bundling mistake can leak.
 *   2. Isolation of failure. On Sanity's hosting, a broken Studio build, an expired
 *      token or a plugin regression cannot take the public site down; they are not even
 *      the same deployment. The site's content is already baked into static HTML, so a
 *      Studio outage is invisible to visitors.
 *
 * Mina gets one URL and a login. `studioHost` in `sanity.cli.ts` fixes that URL, and
 * `.github/workflows/studio.yml` redeploys it whenever a schema file changes on `main`,
 * so a schema change cannot leave her editing against a stale Studio.
 *
 * Project id and dataset are overridable from the environment with the live values as
 * defaults — the same pattern `SITE`/`BASE` use in `astro.config.mjs`, and for the same
 * reason: pointing the Studio at a staging dataset must be a config change, not a code
 * change, while the unset case stays the one you want.
 *
 * Neither is a secret, and neither is treated as one. The dataset is publicly readable
 * by design (an unauthenticated query returns 200; an unauthenticated write is rejected
 * for want of the `create` permission), and both ids travel inside every request the
 * Studio's own JavaScript makes. **There is deliberately no read token anywhere in this
 * repo** — a secret that is not needed is a secret that can leak. If drafts ever have
 * to stay private, that is a dataset-visibility change plus a token, not a code change.
 *
 * `SANITY_STUDIO_` is the prefix, not a stylistic choice: it is the only prefix the
 * Studio bundler substitutes into the browser build.
 */
const projectId = process.env.SANITY_STUDIO_PROJECT_ID ?? 'q6fk9usq';
const dataset = process.env.SANITY_STUDIO_DATASET ?? 'production';

export default defineConfig({
  name: 'default',
  title: 'Muse by Mina',

  projectId,
  dataset,

  // No plugins beyond the structure tool. Every plugin is a thing that can break
  // between a schema change and the next deploy, and a tab Mina has to be told to
  // ignore. Vision in particular is a developer tool; GROQ is debugged from a terminal.
  plugins: [structureTool({ structure })],

  schema: {
    types: schemaTypes,
    // Hide the singleton from "create new". See `sanity/structure.ts`.
    templates: (templates) =>
      templates.filter(({ schemaType }) => !singletonTypes.has(schemaType)),
  },

  document: {
    // Same rule for the "+" menu and the global create shortcut.
    newDocumentOptions: (items) =>
      items.filter(({ templateId }) => !singletonTypes.has(templateId)),
    // A singleton cannot be deleted or duplicated; both would leave the site reading a
    // document id that no longer exists.
    actions: (actions, { schemaType }) =>
      singletonTypes.has(schemaType)
        ? actions.filter(
            ({ action }) => action !== 'delete' && action !== 'duplicate' && action !== 'unpublish',
          )
        : actions,
  },
});

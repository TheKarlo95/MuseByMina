import { createClient, type SanityClient } from '@sanity/client';

import { SanityUnavailableError } from './decode';

/**
 * The one Sanity client, and the one place a network call is made.
 *
 * **Build time only.** This module must never reach a visitor's browser. Three things
 * hold that, in order of how much they can be trusted:
 *
 *   1. `test/nojs.test.ts` asserts the built output contains **zero `.js` files** and no
 *      Sanity marker string. That is the real guarantee, because it reads `dist`.
 *   2. Nothing under `src/components/` or `src/pages/` imports this module yet, and
 *      when MUSE-20 wires it in it will be from Astro frontmatter, which runs in Node at
 *      build time and is never shipped. `test/sanity.test.ts` fails if a `<script>` or a
 *      component ever imports it.
 *   3. The configuration is read from `process.env`, **not** `import.meta.env`. Vite
 *      inlines any `import.meta.env` name carrying the `PUBLIC_` prefix into client
 *      bundles; `process.env` it leaves alone, and `process` does not exist in a
 *      browser at all. So a future mistake that pulls
 *      this into a client bundle throws a `ReferenceError` on load rather than quietly
 *      working — and quietly working is what would ship a CMS client to a static
 *      marketing site.
 *
 * There is **no read token**, deliberately. The dataset is publicly readable (verified:
 * an unauthenticated query returns 200, an unauthenticated write is rejected for want of
 * the `create` permission) and the content is published on the public web anyway, so a
 * token would add a secret to rotate and leak without protecting anything. If drafts
 * ever need to stay private that is a dataset-visibility change plus a token, not a code
 * change — and `perspective: 'published'` below is already the right behaviour for it.
 */

/**
 * Overridable, with the live values as defaults — the same pattern `SITE`/`BASE` use in
 * `astro.config.mjs`, so pointing a build at a staging dataset is a config change.
 * Neither value is a secret; both travel in the URL of every request.
 */
const PROJECT_ID = process.env.SANITY_PROJECT_ID ?? 'q6fk9usq';
const DATASET = process.env.SANITY_DATASET ?? 'production';

/**
 * Pinned, not `'latest'`.
 *
 * GROQ's behaviour is versioned by date, and `'latest'` means a build in six months can
 * answer a query differently from a build today with no commit in between. For a site
 * whose content is baked into static HTML, that is a change nobody asked for arriving
 * through a deploy that was meant to be a typo fix.
 */
const API_VERSION = '2024-10-01';

let cached: SanityClient | undefined;

export function sanityClient(): SanityClient {
  if (cached) return cached;
  cached = createClient({
    projectId: PROJECT_ID,
    dataset: DATASET,
    apiVersion: API_VERSION,
    // The CDN is the right default for a build: it is cheaper, and the build only ever
    // wants published content. MUSE-21's rebuild webhook is what makes an edit appear,
    // so a few seconds of CDN lag costs nothing.
    useCdn: true,
    // Drafts exist in the dataset and are readable because the dataset is public. A
    // build must never render one — that is how an unfinished price reaches the web.
    perspective: 'published',
  });
  return cached;
}

/** What the read path reports about itself, for build logs and the read-check script. */
export interface SanitySource {
  projectId: string;
  dataset: string;
  apiVersion: string;
}

export function sanitySource(): SanitySource {
  return { projectId: PROJECT_ID, dataset: DATASET, apiVersion: API_VERSION };
}

/**
 * Run a query, and turn *any* failure to get an answer into `SanityUnavailableError`.
 *
 * The separation this enforces is the one MUSE-19 asks for: by the time a caller sees a
 * return value, the query has provably run. Everything after this point — an empty
 * array, a null singleton, a null field — is content, and `decode.ts` is what judges it.
 * Collapsing the two is how "the dataset is empty" and "the query is broken" become the
 * same symptom.
 *
 * The message names the project, the dataset and the query, because the most likely
 * cause is a build pointed at the wrong dataset, and the second most likely is a GROQ
 * parse error — and neither is identifiable from "fetch failed".
 *
 * **Returns undecoded rows, and nothing stops a page calling it.** This is exported for
 * `./index.ts`, which decodes everything it gets back; importing it from outside
 * `src/lib/sanity/` buys raw data with silent nulls and no named error. MUSE-20 makes
 * that an assertion rather than a sentence — see the decision recorded in the header of
 * `./index.ts`.
 */
export async function runQuery<T>(
  query: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  try {
    return await sanityClient().fetch<T>(query, params);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new SanityUnavailableError(
      `Sanity did not answer a query against project \`${PROJECT_ID}\`, dataset ` +
        `\`${DATASET}\` (api v${API_VERSION}): ${reason}\n` +
        `This is the read path failing, not missing content. Check the dataset name, ` +
        `then that the query parses — \`node scripts/sanity-read-check.mjs\` runs every ` +
        `query in \`queries.ts\` against the live API and reports each one as OK, EMPTY ` +
        `or BROKEN.\n` +
        `Query was:\n${query.trim()}`,
    );
  }
}

import { createClient, type SanityClient } from '@sanity/client';

import { SanityUnavailableError } from './decode';
import { FIXTURE_ENV, fixturePath, runFixtureQuery } from './fixture';

/**
 * The one Sanity client, and the one place a network call is made.
 *
 * (Or not made: `MUSE_CONTENT_FIXTURE` makes `runQuery` evaluate the same queries against
 * the committed seed with `groq-js`, which is how `npm test` runs ten builds without
 * touching the network. See `./fixture.ts` — including the four things that keep that
 * path out of a deploy.)
 *
 * **Build time only.** This module must never reach a visitor's browser. Three things
 * hold that, in order of how much they can be trusted:
 *
 *   1. `test/nojs.test.ts` asserts the built output contains **zero `.js` files** and no
 *      Sanity marker string. That is the real guarantee, because it reads `dist`.
 *   2. The components and pages that read content (MUSE-20) do so from Astro
 *      frontmatter, which runs in Node at build time and is never shipped — and they
 *      import `src/lib/sanity`, never this module. `test/sanity.test.ts` fails on
 *      `lib/sanity` appearing in the *markup* half of any `.astro` file, where a
 *      `<script>` would ship it, and on an import specifier that reaches inside the read
 *      path from outside it.
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

/**
 * **The client's configuration, as one value.**
 *
 * Spelled out here and passed whole to `createClient` so that `sanitySource()` can
 * return the real thing. The alternative — a test grepping this file for
 * `perspective: 'published'` — was tried and was worse than nothing: the comment above
 * about dataset visibility *mentions* the flag, so deleting the actual line left the grep
 * passing. A guard that a sentence about the thing can satisfy is not a guard.
 *
 * `as const` matters: it keeps the literal types, so `SanitySource` can require
 * `perspective: 'published'` and a change here stops compiling.
 */
const CLIENT_CONFIG = {
  projectId: PROJECT_ID,
  dataset: DATASET,
  apiVersion: API_VERSION,
    // The CDN is cheaper and the build only ever wants published content, so it is the
    // right default for a *scheduled* or hand-run build.
    //
    // It is the wrong default for MUSE-21, and the comment here used to claim the
    // opposite — "the rebuild webhook is what makes an edit appear, so a few seconds of
    // CDN lag costs nothing". Backwards: a publish webhook fires a build at the instant
    // of publish, which is precisely when the CDN is stalest, so the expected outcome is
    // a green deploy that republishes the pre-edit content and Mina pressing publish
    // again. Measured here while verifying MUSE-20: an edit took about a minute to
    // appear. `scripts/sanity-seed-check.mjs` already reads the uncached host for exactly
    // this reason.
    //
    // Left as `true` deliberately — flipping it is MUSE-21's call to make with its
    // webhook in hand, not a drive-by here — but it is a known defect, not a trade-off.
    useCdn: true,
    // Drafts exist in the dataset and are readable because the dataset is public. A
    // build must never render one — that is how an unfinished price reaches the web.
    // `src/lib/sanity/fixture.ts` drops `drafts.` documents for the same reason, which is
    // the half of this that an offline build can actually exercise.
    perspective: 'published',
} as const;

let cached: SanityClient | undefined;

export function sanityClient(): SanityClient {
  if (cached) return cached;
  cached = createClient(CLIENT_CONFIG);
  return cached;
}

/**
 * What the read path reports about itself, for build logs and for tests.
 *
 * `perspective` is typed as the literal `'published'` on purpose: it is the one setting
 * here whose loss is silent and expensive — the deploy would start publishing drafts with
 * every check still green — and no offline build can exercise it. So it is pinned twice,
 * at compile time by this type and at run time by `test/content.test.ts` asserting the
 * value `sanitySource()` returns.
 */
export interface SanitySource {
  projectId: string;
  dataset: string;
  apiVersion: string;
  useCdn: boolean;
  perspective: 'published';
}

export function sanitySource(): SanitySource {
  return CLIENT_CONFIG;
}

let announced = false;

/**
 * Say once per build where the content came from.
 *
 * The one line of output this module produces, and it earns its place: a build reading
 * the committed seed instead of the dataset is otherwise indistinguishable from a build
 * reading the dataset — both are green and both publish pages. `FIXTURE` is in capitals
 * so it is visible in a deploy log that nobody is reading closely. See
 * `./fixture.ts` for the other three things that keep a fixture out of a deploy.
 */
function announce(fixture: string | undefined): void {
  if (announced) return;
  announced = true;
  if (fixture === undefined) {
    console.log(
      `[content] live — project ${PROJECT_ID}, dataset ${DATASET}, api v${API_VERSION}`,
    );
  } else {
    console.log(
      `[content] FIXTURE — ${fixture}\n` +
        `[content] FIXTURE builds are for the test suite. ${FIXTURE_ENV} is set; unset it ` +
        `to read the live dataset.`,
    );
  }
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
 * **Returns undecoded rows.** This is exported for `./index.ts`, which decodes everything
 * it gets back; importing it from outside `src/lib/sanity/` would buy raw data with
 * silent nulls and no named error — which is why that is now an assertion rather than a
 * sentence (`test/sanity.test.ts`, "lets a page import the read path, but not the modules
 * inside it").
 */
export async function runQuery<T>(
  query: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const fixture = fixturePath();
  announce(fixture);
  if (fixture !== undefined) return runFixtureQuery<T>(query, params, fixture);

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

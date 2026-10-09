import { createClient, type SanityClient } from '@sanity/client';

import { SanityUnavailableError } from './decode';
import { inDevServer } from './dev';
import { FIXTURE_ENV, fixturePath, runFixtureQuery } from './fixture';
import { requireQueryParameters } from './params';

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
  // **The uncached host. This is a correctness setting, not a performance one (MUSE-81).**
  //
  // The cached read host is *eventually consistent*: it is refreshed after a mutation,
  // not synchronously with it. A build that starts inside that window reads the previous
  // revision — and nothing downstream can tell. The query returns 200, every document is
  // present, `decode.ts` has nothing to object to, `astro build` exits 0 and the deploy
  // reports success. The output is simply one revision behind, which makes it the one
  // content failure this project has no other defence against: every other one is loud.
  //
  // Observed:
  //
  //     10:12  an import of `content/seed.ndjson`, verified in the dataset
  //     10:13  a `workflow_dispatch` rebuild — completed/success
  //     10:14  the live page still serving the previous description
  //     10:18  a second rebuild, no other change — correct
  //
  // **What it breaks is MUSE-21's promise, not somebody's manual procedure.** The cron
  // fires at `20 1,7,13,19` and what Mina is promised is a *duration*, `MAX_WAIT_HOURS`
  // in `src/lib/rebuild.ts`. An edit published shortly before one of those runs can be
  // read pre-publish *by that run*, so it waits for the next one — six hours after she
  // was told the maximum, with a green deploy in between, so `deploy.yml`'s failure
  // alert never fires. The comment this replaces argued the opposite, that a scheduled
  // rebuild is never close enough to a publish for the lag to matter. The flaw in it was
  // reasoning about the *expected* gap between an edit and the next build when the thing
  // being promised is the *worst* one.
  //
  // With the uncached host each read answers with the dataset as of the moment it is
  // asked, and reads only ever move forward, so a build cannot publish a revision older
  // than the dataset held when it started. (It can publish one *newer* — thirteen
  // queries over a few seconds, and Mina could publish between the first and the last.
  // That is a different thing and not worth machinery: no page goes stale, and the next
  // scheduled build converges.)
  //
  // **Measured, because the cost is the whole of the argument.** All thirteen queries in
  // `./queries.ts`, run sequentially, median of seven rounds: 294 ms cached, 648 ms
  // uncached — about 27 ms a query, so ~0.35 s on a build of fifteen-odd seconds, and
  // that is the ceiling rather than the figure, since the readers are memoised and pages
  // do not wait on each other. Four scheduled builds a day times thirteen queries is
  // ~1,600 requests a month. The read volume the CDN exists for is not this site's.
  //
  // `cacheMode: 'noStale'` is the other candidate and is declined. It is a *request*
  // option rather than a config one, so its correctness would rest on every call site
  // passing it instead of on the one object `sanitySource()` already describes; it buys
  // the latency back only for objects the cache has not been told are stale; and it
  // would leave two answers in this repository to "which host is fresh", when
  // `scripts/seed-compare.mjs` has read the uncached one all along for this same reason.
  useCdn: false,
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
 * **Two of these are literal types rather than `string`/`boolean`, and both for the same
 * reason: they are the settings whose loss is silent.** No offline build can exercise
 * either, so a flipped value would ship with every check green — drafts on the public
 * site for one, content one revision behind for the other. Each is therefore pinned
 * twice: at compile time by this interface, which stops `CLIENT_CONFIG` assigning the
 * other value, and at run time by a test reading what `sanitySource()` returns —
 * `perspective` in `test/content.test.ts`, `useCdn` in `test/endpoint.test.ts`.
 *
 * `useCdn: false` is MUSE-81's half. It reads as a tuning knob, which is exactly why it
 * is typed shut: see the long note on the property for why the cached host cannot be
 * used by a build whose freshness somebody has been promised.
 */
export interface SanitySource {
  projectId: string;
  dataset: string;
  apiVersion: string;
  useCdn: false;
  perspective: 'published';
}

export function sanitySource(): SanitySource {
  return CLIENT_CONFIG;
}

/**
 * Where a query is actually fetched from, **asked of the client rather than re-derived.**
 *
 * `useCdn` is a flag, not an address: the client turns it into one of two hosts, and only
 * the client knows the rule (`apiHost`, `useProjectHostname` and the flag all feed it).
 * A log line that restated the rule would be a second answer to the question it exists to
 * answer — the MUSE-9 shape, two models of one thing drifting — and the one failure that
 * matters here is precisely a build reading a host nobody intended. So this calls
 * `getUrl()`, which is the same function the request path calls, with the same
 * `canUseCdn` the request path passes for a data query.
 */
export interface ContentEndpoint {
  /** The URL prefix a query is fetched from, as the client resolves it. */
  url: string;
  /** Whether that host is the eventually-consistent one. */
  cached: boolean;
}

export function contentEndpoint(): ContentEndpoint {
  const client = sanityClient();
  const { useCdn } = client.config();
  return { url: client.getUrl(`/data/query/${DATASET}`, useCdn), cached: useCdn };
}

/**
 * What the build log says about the endpoint.
 *
 * Pure, and takes the endpoint rather than reading it, so both regimes are assertable
 * offline — including the one this repository is not supposed to be in. A message that
 * could only be produced by configuring the thing it warns about is a message nothing can
 * check.
 */
export function endpointNote({ url, cached }: ContentEndpoint): string {
  const { host } = new URL(url);
  return cached
    ? `${host} — CACHED, and that host is eventually consistent: this build may have read ` +
        `a revision the dataset had already replaced, and will publish it with every ` +
        `check green (MUSE-81).`
    : `${host} — uncached, so the content is what the dataset held when this build asked ` +
        `for it.`;
}

let announced = false;

/**
 * Say once per build where the content came from, **and whether it will be read again**.
 *
 * The one line of output this module produces, and it earns its place: a build reading
 * the committed seed instead of the dataset is otherwise indistinguishable from a build
 * reading the dataset — both are green and both publish pages. `FIXTURE` is in capitals
 * so it is visible in a deploy log that nobody is reading closely. See
 * `./fixture.ts` for the other three things that keep a fixture out of a deploy.
 *
 * **The caching clause is MUSE-47's half**, and it is here rather than in a document
 * because this is the one line somebody is already looking at when the question arises.
 * „Is what I am seeing current?" has two answers in this project — a build answers it
 * once and a dev server answers it per request — and before MUSE-47 the output said
 * neither, which is how „the memoisation is right for a build" came to be read as a
 * property of the module. A log that names the regime is also what makes the regime
 * assertable from outside the process: `test/devcontent.test.ts` reads it off a real
 * `astro build` and a real `astro dev` rather than trusting a unit test about an
 * `import.meta` constant.
 *
 * **The endpoint clause is MUSE-81's half.** A stale deploy is green, so the log is the
 * only place „was this build's content current?" can be answered after the fact — and it
 * could not be, because the line named the dataset and never the host it was read from.
 * That is the one fact about a finished build that is otherwise unrecoverable: the dataset
 * will have moved on by the time anybody thinks to ask.
 */
function announce(fixture: string | undefined): void {
  if (announced) return;
  announced = true;
  const dev = inDevServer();
  const caching = !dev
    ? `[content] build — each reader is queried once and memoised for this process.`
    : fixture === undefined
      ? `[content] dev server — every reader is re-read on each request, so a Studio ` +
        `edit shows up on reload.`
      : `[content] dev server — the file is re-read on each request, so editing it ` +
        `shows up on reload.`;
  if (fixture === undefined) {
    console.log(
      `[content] live — project ${PROJECT_ID}, dataset ${DATASET}, api v${API_VERSION}\n` +
        `[content] ${endpointNote(contentEndpoint())}\n` +
        caching,
    );
  } else {
    console.log(
      `[content] FIXTURE — ${fixture}\n` +
        (dev
          ? `[content] FIXTURE — this dev server is reading a file in the repository, not ` +
            `the live dataset, so a Studio edit will never appear. ${FIXTURE_ENV} is set; ` +
            `unset it to read the live dataset.`
          : `[content] FIXTURE builds are for the test suite. ${FIXTURE_ENV} is set; ` +
            `unset it to read the live dataset.`) +
        `\n${caching}`,
    );
  }
}

/**
 * What to tell a dev server whose query could not be answered.
 *
 * Appended to the unreachable-API error, and **only under a dev server**. The same error
 * is what a failed deploy prints, and a deploy log is the last place to suggest reading a
 * fixture: `.github/workflows/deploy.yml` greps that error for `TRANSIENT_BUILD_FAILURE`
 * and retries, and the correct remedy there is to wait for Sanity, never to publish the
 * committed seed. So the advice goes to the only reader it is advice for.
 *
 * This is MUSE-47's answer to „`npm run dev` now requires network": not a fallback —
 * a build that silently substituted the seed for an unreachable dataset is the deploy
 * failure MUSE-20's four barriers exist to prevent, and a *dev* session that did it would
 * be the MUSE-35 shape again, dev and the build disagreeing about something invisible.
 * One sentence, at the moment it is needed, naming the whole command.
 */
function offlineHint(): string {
  if (!inDevServer()) return '';
  return (
    `\nNo network? This dev server can render from the committed seed instead — ` +
    `\`${FIXTURE_ENV}=content/seed.ndjson npm run dev\`. It is the same file ` +
    `\`npm run sanity:seed\` imports, so it is the content as of the last migration, and ` +
    `the log says FIXTURE for as long as it is set. A deploy may never set it.`
  );
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
 *
 * **The parameter check is in front of the branch, not inside either arm (MUSE-51).** A
 * query referencing a parameter the caller did not supply cannot be answered by anything,
 * and the two paths used to fail at it differently — HTTP 400 live, `[]` from `groq-js`,
 * which `requireDocuments` then mislabelled "an empty dataset, not a broken query" and
 * `minimum: 0` accepted in silence. Checked here, both paths fail with one error class and
 * one message, before a source is even chosen. `./params.ts` has the long note.
 */
export async function runQuery<T>(
  query: string,
  params: Record<string, unknown> = {},
): Promise<T> {
  const fixture = fixturePath();
  announce(fixture);
  requireQueryParameters(query, params);
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
        `or BROKEN.` +
        offlineHint() +
        `\nQuery was:\n${query.trim()}`,
    );
  }
}

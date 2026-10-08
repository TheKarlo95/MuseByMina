import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { SanityUnavailableError } from './decode';
import { requireQueryParameters } from './params';

/**
 * **Running the real queries against the committed seed, with no network.**
 *
 * `npm test` runs ten real `astro build`s in parallel workers (MUSE-17). If every one of
 * them fetched from the Sanity API, the suite would buy ten HTTP round-trips per run, a
 * new flakiness source, and a result that depends on whether anybody happens to be
 * mid-edit in the Studio. None of that is acceptable in a test suite.
 *
 * The alternative that is usually reached for — a hand-written fixture of the content a
 * page expects — is worse in a different way: it is a second copy, and it drifts until
 * the tests are passing against content that no longer exists anywhere.
 *
 * So there is exactly one copy. `sanity/seed/content.ndjson` is **both** the migration
 * artefact `npm run sanity:seed` imports into the dataset **and** the fixture the suite
 * builds against. Changing what gets imported changes what the tests read; they cannot
 * disagree, because they are the same file.
 *
 * And the queries are not stubbed either. `groq-js` is Sanity's own GROQ engine, so the
 * literal text in `./queries.ts` is parsed and evaluated here exactly as the API
 * evaluates it. A typo in a projection, a renamed attribute, a `coalesce` that orders
 * differently — all of it behaves the same way offline, which is the only thing that
 * makes a local evaluation worth trusting over a recorded response.
 *
 * ---
 *
 * **The register of known divergences from the live API.**
 *
 * "Exactly as the API evaluates it" is the premise, and it is **not quite true**. Two
 * places where this path and the live path disagree have been found so far, and both were
 * found by somebody deliberately going looking rather than by a failing build — which is
 * the whole reason this list exists. A third one will exist; it should be found by reading
 * this, and added here when it is.
 *
 * Neither of them is a `groq-js` bug. Both are things the API does *around* evaluating
 * GROQ, which a local evaluator has no way to know about.
 *
 *   1. **Drafts.** Found with MUSE-20, closed there.
 *      The live client reads with `perspective: 'published'`, so `drafts.<id>` documents
 *      are invisible to it. `groq-js` has no notion of a perspective and sees every
 *      document in the dataset it is handed — and `sanity dataset export`, the obvious way
 *      to refresh the seed, carries drafts. Left alone that is four routes offline and
 *      three live, or worse, a suite asserting content no visitor can be served.
 *      *What is done about it:* `published()` below drops `drafts.`-prefixed documents,
 *      the fixture's half of the flag in `./client.ts`. Watched by
 *      `test/projections.test.ts`, "an unpublished draft is invisible to every query" —
 *      the seed holds drafts on purpose, so the filter is exercised by every assertion in
 *      that file rather than only by its own.
 *
 *   2. **A parameter the caller did not supply.** Found with MUSE-44, closed in MUSE-51.
 *      The live API refuses the request: HTTP 400 `queryParseError`, "param $now
 *      referenced, but not provided". `groq-js` substitutes nothing and answers `[]`. So
 *      one mistake surfaced as two error classes — and offline it only surfaced at all
 *      because `requireDocuments` defaults `minimum` to 1, which made it report the empty
 *      result as "an empty dataset, not a broken query". With `minimum: 0`, which
 *      `getEvents` explicitly supports, it was silent and published a blank page.
 *      *What is done about it:* `requireQueryParameters` in `./params.ts`, called by
 *      `runQuery` in front of **both** paths and again below for callers that come
 *      straight here. Neither engine is asked, so neither can be the one that is right.
 *      Watched by `test/projections.test.ts`, "a query run without a parameter it
 *      references", which asserts the two paths produce the *same message*.
 *
 * Two habits are what turned both of these up, and they are cheap:
 *
 *   - **`npm run sanity:read`** runs every query in `./queries.ts` against the live API
 *     and reports each as OK, EMPTY or BROKEN. Anything this path answers that that one
 *     calls BROKEN is a divergence.
 *   - **Ask what the API does that evaluation does not.** Both entries above are exactly
 *     that: a perspective, and a request-validation step. Remaining candidates of the same
 *     shape, none currently reachable — dataset ACLs and document-level permissions,
 *     `useCdn` staleness, the API's query size and execution limits, and `API_VERSION`
 *     being a date while `groq-js` is a semver. The last pair is why `groq-js` is pinned
 *     to an exact version in `package.json`: it is the suite's only consumer of GROQ
 *     semantics, and a caret range would let a minor bump change what the tests believe
 *     GROQ means with no commit in between — the same argument that pins `API_VERSION`.
 *     `test/sanity.test.ts` asserts the pin.
 *
 * ---
 *
 * **Why this cannot quietly become how the site is deployed.**
 *
 * Four things, none of which is "remember not to":
 *
 *   1. There is no default path and no fallback. Unset, `runQuery` fetches live; set to a
 *      file that is not there, the build *fails* — it never silently reverts to the API
 *      and never renders an empty page.
 *   2. The build log says which source it read, with `FIXTURE` in capitals, so a build
 *      that took this path is visible in any log it produced.
 *   3. `test/content.test.ts` asserts that neither `.github/workflows/deploy.yml` nor any
 *      `package.json` script mentions the variable. The only place it is set is
 *      `vitest.config.ts`.
 *   4. `groq-js` is a devDependency and is imported dynamically, so nothing about the
 *      live read path depends on it being installed at all.
 */

/** The environment variable that selects a local content source. Test-only. */
export const FIXTURE_ENV = 'MUSE_CONTENT_FIXTURE';

/** The path a local content source was requested at, or `undefined` for the live API. */
export function fixturePath(): string | undefined {
  const raw = process.env[FIXTURE_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  const trimmed = raw.trim();
  return isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
}

/**
 * The documents in an NDJSON file, as a GROQ dataset.
 *
 * Unreadable or unparseable is `SanityUnavailableError`, not a content error: nothing was
 * answered, so there is nothing to judge. That keeps the three outcomes
 * `src/lib/sanity/decode.ts` draws apart — unreachable, empty, malformed — meaning the
 * same thing whichever source a build read.
 */
function readDataset(path: string): unknown[] {
  let ndjson: string;
  try {
    ndjson = readFileSync(path, 'utf8');
  } catch (cause) {
    throw new SanityUnavailableError(
      `The content fixture named by \`${FIXTURE_ENV}\` could not be read: ${path}\n` +
        `This is the read path failing, not missing content — nothing answered, so there ` +
        `is nothing to judge. Unset \`${FIXTURE_ENV}\` to read the live dataset instead. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  const documents: unknown[] = [];
  const lines = ndjson.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim() === '') continue;
    try {
      documents.push(JSON.parse(line));
    } catch (cause) {
      throw new SanityUnavailableError(
        `The content fixture named by \`${FIXTURE_ENV}\` is not NDJSON: ${path} line ` +
          `${index + 1} is not a JSON document. One JSON document per line. ` +
          `(${cause instanceof Error ? cause.message : String(cause)})`,
      );
    }
  }
  return documents.filter(published);
}

/**
 * Is this a published document rather than a draft?
 *
 * The fixture's half of `perspective: 'published'` in `./client.ts`, and it has to be
 * here or the two sources disagree about what the dataset contains. A draft lives at
 * `drafts.<id>` alongside its published twin, so a seed taken from
 * `sanity dataset export` — the obvious way to refresh it — carries both, and the fixture
 * would then see a page the deploy cannot: four routes offline, three live. Green suite,
 * red deploy, and the difference invisible in the diff of the seed.
 *
 * The reverse is worse and quieter: a page that exists *only* as a draft gives the
 * fixture a document the build is right to ignore, so the suite would assert content that
 * no visitor can ever be served.
 */
function published(document: unknown): boolean {
  const id = (document as { _id?: unknown } | null)?._id;
  return typeof id !== 'string' || !id.startsWith('drafts.');
}

let cached: { path: string; dataset: unknown[] } | undefined;

/** Parse the NDJSON once per build, however many queries a build runs. */
function dataset(path: string): unknown[] {
  if (cached?.path !== path) cached = { path, dataset: readDataset(path) };
  return cached.dataset;
}

/**
 * Evaluate a GROQ query against the fixture, as Sanity's API would.
 *
 * A GROQ *syntax* error is the read path failing rather than content missing, for the
 * same reason a 400 from the API is: the query never ran.
 *
 * A **missing parameter** is the same thing, and divergence 2 above is that `groq-js` does
 * not think so — it answers `[]`. `runQuery` already checked, so this call is for the
 * direct callers that do not come through it (`test/projections.test.ts` evaluates query
 * text against a fixture itself), and it is here for the same reason `published()` is:
 * this module has to behave like the API wherever it is used from, not only when `runQuery`
 * happens to be the caller.
 */
export async function runFixtureQuery<T>(
  query: string,
  params: Record<string, unknown>,
  path: string,
): Promise<T> {
  requireQueryParameters(query, params);
  const { evaluate, parse } = await import('groq-js');
  try {
    const tree = parse(query);
    const value = await evaluate(tree, { dataset: dataset(path), params });
    return (await value.get()) as T;
  } catch (cause) {
    if (cause instanceof SanityUnavailableError) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new SanityUnavailableError(
      `A query could not be evaluated against the content fixture ${path}: ${reason}\n` +
        `Query was:\n${query.trim()}`,
    );
  }
}

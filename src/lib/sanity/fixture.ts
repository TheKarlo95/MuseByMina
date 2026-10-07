import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import { SanityUnavailableError } from './decode';

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
 */
export async function runFixtureQuery<T>(
  query: string,
  params: Record<string, unknown>,
  path: string,
): Promise<T> {
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

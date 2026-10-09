/**
 * **Comparing `content/seed.ndjson` with the live dataset — the one comparison, in one place.**
 *
 * Two checks ask a question about the same two things and MUSE-78 is the reason they are
 * not two comparisons:
 *
 *   - `scripts/sanity-seed-check.mjs` asks *"do they disagree?"* and reports it. On
 *     demand, and `continue-on-error` in CI, because a Studio edit must never fail a
 *     deploy.
 *   - `scripts/sanity-seed-release.mjs` asks *"did **this branch** author the
 *     disagreement, and has it been imported yet?"* and fails if the answer is "yes, and
 *     no". That one blocks, and it is allowed to, because the thing it names is our own
 *     unshipped change rather than Mina's published words.
 *
 * The *direction* is the whole of MUSE-78 and it lives in the second script. What lives
 * here is the part that has no opinion: parse the seed, strip the structure, flatten to
 * leaves, read the dataset. Both scripts agree about what a difference *is* by
 * construction, which matters because the blocking check's credibility rests on the
 * non-blocking one having reported the same facts.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Where the seed lives, relative to the repository root. One spelling. */
export const SEED_PATH = 'content/seed.ndjson';

const SEED_FILE = fileURLToPath(new URL(`../${SEED_PATH}`, import.meta.url));

/**
 * A leaf that is not there at all.
 *
 * Distinct from `null`, which is a value Sanity stores and GROQ returns. "The field is
 * absent" and "the field holds null" are the two halves of MUSE-49's reasoning about
 * references, and a check that conflated them would read a cleared field as unchanged.
 */
export const ABSENT = Symbol('absent');

/** Every document in an NDJSON seed, in file order. */
export function parseSeed(text) {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));
}

/** The committed seed, as text, so a caller can compare it with another revision's. */
export const readSeed = () => readFileSync(SEED_FILE, 'utf8');

/** Drop `_key`, `_type` and friends: they are structure, not content. */
export function contentOf(value) {
  if (Array.isArray(value)) return value.map(contentOf);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, nested]) => [key, contentOf(nested)]),
    );
  }
  return value;
}

/** Every leaf of `value`, as `path` → scalar, so a difference can be named. */
export function leaves(value, path = '') {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => leaves(entry, `${path}[${index}]`));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, nested]) =>
      leaves(nested, path ? `${path}.${key}` : key),
    );
  }
  return [[path, value]];
}

/**
 * One document as `path` → scalar, structure stripped. A `Map`, not a list of pairs: both
 * callers look paths up, and the list form made the old comparison quadratic in the leaf
 * count for no reason anybody wanted.
 */
export const leafMap = (doc) => new Map(leaves(contentOf(doc)));

/** The leaf at `path`, or `ABSENT`. */
export const leafAt = (map, path) => (map.has(path) ? map.get(path) : ABSENT);

/** A leaf as a message can print it. `ABSENT` prints as a word, not as `undefined`. */
export const showLeaf = (value) => (value === ABSENT ? '(absent)' : JSON.stringify(value));

/**
 * The leaves on which a seeded document and the dataset disagree.
 *
 * **Only the fields the seed sets.** A field Mina fills in that the seed leaves empty —
 * `phone`, say — is not a disagreement: the seed makes no claim about it. This is the
 * asymmetry that keeps the on-demand check quiet about an almost-empty dataset, and it is
 * equally load-bearing for the release gate, which would otherwise report every optional
 * field as something to reconcile.
 */
export function differences(seeded, published) {
  const live = leafMap(published);
  return [...leafMap(seeded)]
    .filter(([path, value]) => leafAt(live, path) !== value)
    .map(([path, value]) => ({ path, seed: value, live: leafAt(live, path) }));
}

/**
 * Where the dataset is read from. Repository *variables* in CI, defaults here, and **no
 * token** — the dataset is publicly readable and writes are rejected unauthenticated, so
 * both of these scripts are structurally read-only.
 */
export const target = () => ({
  projectId: process.env.SANITY_PROJECT_ID ?? 'q6fk9usq',
  dataset: process.env.SANITY_DATASET ?? 'production',
  apiVersion: process.env.SANITY_API_VERSION ?? '2024-10-01',
});

/**
 * **The uncached read host — one spelling, for every script that reads the dataset.**
 *
 * The cached host is eventually consistent, so asked a minute after an import it answers
 * with the previous content. For a drift check that is worse than no check at all: the
 * fix for a red gate *is* an import, and the gate would stay red after it. These two
 * scripts have read the uncached host since MUSE-20 for exactly that reason.
 *
 * It is a constant here rather than a literal at each call site because it was not one
 * spelling: `scripts/sanity-read-check.mjs` wrote its own URL and reached for the cached
 * host, which is how a run against a freshly seeded dataset could report EMPTY for
 * documents that were there — "correct for an empty dataset" being the one verdict that
 * script exists to tell apart from a broken query. It now builds its URL here. The build
 * answers the same question in `src/lib/sanity/client.ts` and answers it the same way
 * (MUSE-81); it cannot share this module, which is the `dist-origin.mjs` constraint —
 * a `.mjs` script cannot import a `.ts` one — so the two are checked against each other
 * by `test/endpoint.test.ts` instead of trusted to agree.
 */
export const API_HOST = 'api.sanity.io';

/** A GROQ query and its parameters, as a URL against the uncached host. */
export function queryUrl(query, params = {}, where = target()) {
  const search = new URLSearchParams({ query });
  for (const [key, value] of Object.entries(params)) {
    search.set(`$${key}`, JSON.stringify(value));
  }
  return (
    `https://${where.projectId}.${API_HOST}/v${where.apiVersion}/data/query/` +
    `${where.dataset}?${search}`
  );
}

/**
 * The named documents, read from the dataset.
 *
 * Throws on anything other than a 200. Both callers decide for themselves what an
 * unreachable API means; they do not agree about it, so this must not decide for them.
 */
export async function fetchLive(ids, where = target()) {
  const response = await fetch(queryUrl('*[_id in $ids]', { ids }, where));
  if (!response.ok) {
    throw new Error(
      `Could not read the dataset: HTTP ${response.status}\n${await response.text()}`,
    );
  }
  const { result } = await response.json();
  return result ?? [];
}

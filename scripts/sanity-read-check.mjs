/**
 * Run every query in `src/lib/sanity/queries.ts` against the live dataset and say, per
 * query, which of three things happened:
 *
 *   OK      HTTP 200 and the shape the read path expects — including zero documents,
 *           which is a legitimate answer from an empty dataset.
 *   EMPTY   HTTP 200, zero documents. Printed separately from OK on purpose.
 *   BROKEN  a GROQ parse error, an HTTP error, or no answer at all.
 *
 * The distinction is the whole reason this script exists. Most of the dataset is still
 * empty — MUSE-20 migrated the `siteSettings` singleton and the four `page` documents,
 * and the schedule and instructors are MUSE-36 — so most queries legitimately return
 * nothing, which is also exactly what a typo'd attribute name, a renamed field or an
 * unreachable API look like from a page template that just maps over an array. A silent
 * empty result is how this fails later, so "empty" is made loud here and, at build time,
 * in `requireDocuments` in `src/lib/sanity/decode.ts`.
 *
 *   SANITY_PROJECT_ID=q6fk9usq SANITY_DATASET=production node scripts/sanity-read-check.mjs
 *
 * Reads only. The dataset is publicly readable and no token is used or needed; an
 * unauthenticated write is rejected by the API for want of the `create` permission, so
 * this script cannot change anything even by accident.
 */
import { readFileSync } from 'node:fs';

const PROJECT_ID = process.env.SANITY_PROJECT_ID ?? 'q6fk9usq';
const DATASET = process.env.SANITY_DATASET ?? 'production';
const API_VERSION = process.env.SANITY_API_VERSION ?? '2024-10-01';

/**
 * Query names and their text, read off the source rather than imported.
 *
 * `queries.ts` is TypeScript and this is a plain `.mjs` script run by `node`, so an
 * import would need a build step. The queries are plain template literals with no
 * interpolation — see the module's own note on why — which makes reading them out of the
 * source exact rather than approximate.
 */
function loadQueries() {
  const source = readFileSync(new URL('../src/lib/sanity/queries.ts', import.meta.url), 'utf8');
  const pattern = /export const (\w+) = defineQuery\(`([\s\S]*?)`\);/g;
  return [...source.matchAll(pattern)].map(([, name, query]) => ({ name, query }));
}

function url(query, params) {
  const search = new URLSearchParams({ query });
  for (const [key, value] of Object.entries(params)) {
    search.set(`$${key}`, JSON.stringify(value));
  }
  return `https://${PROJECT_ID}.apicdn.sanity.io/v${API_VERSION}/data/query/${DATASET}?${search}`;
}

/** Every parameter any query takes, so one call site can run all of them. */
const PARAMS = { now: new Date().toISOString() };

function describe(result) {
  if (Array.isArray(result)) {
    return result.length === 0
      ? { verdict: 'EMPTY', detail: 'returned an empty array' }
      : { verdict: 'OK', detail: `${result.length} document(s)` };
  }
  if (result === null) {
    return { verdict: 'EMPTY', detail: 'returned null — no such document' };
  }
  if (typeof result === 'object') {
    const values = Object.values(result);
    const allZero = values.length > 0 && values.every((v) => v === 0);
    return allZero
      ? { verdict: 'EMPTY', detail: 'every count is 0' }
      : { verdict: 'OK', detail: JSON.stringify(result) };
  }
  return { verdict: 'OK', detail: JSON.stringify(result) };
}

const queries = loadQueries();
if (queries.length === 0) {
  console.error('Found no queries in src/lib/sanity/queries.ts — did the file move?');
  process.exit(1);
}

console.log(`project ${PROJECT_ID} · dataset ${DATASET} · api v${API_VERSION}\n`);

let broken = 0;
let empty = 0;

for (const { name, query } of queries) {
  let response;
  try {
    response = await fetch(url(query, PARAMS));
  } catch (cause) {
    broken += 1;
    console.log(`BROKEN  ${name} — could not reach the API: ${cause.message}`);
    continue;
  }

  const body = await response.text();
  if (!response.ok) {
    broken += 1;
    // A GROQ parse error is a 400 with the offending position in the body. That is the
    // single most useful line this script can print, so it is printed whole.
    console.log(`BROKEN  ${name} — HTTP ${response.status}: ${body.slice(0, 400)}`);
    continue;
  }

  const { result } = JSON.parse(body);
  const { verdict, detail } = describe(result);
  if (verdict === 'EMPTY') empty += 1;
  console.log(`${verdict.padEnd(7)} ${name} — ${detail}`);
}

console.log(
  `\n${queries.length} queries · ${broken} broken · ${empty} parsed and answered with nothing`,
);

if (broken > 0) {
  console.error(
    '\nAt least one query did not run. That is a broken read path, not an empty dataset.',
  );
  process.exit(1);
}

if (empty === queries.length) {
  console.log(
    'Every query parsed and answered — and every one of them with nothing. For most of\n' +
      'them that is the correct answer from an empty dataset, but MUSE-20 seeded the\n' +
      '`siteSettings` singleton and the four `page` documents: if those two are EMPTY as\n' +
      'well, the dataset has lost them. Run `npm run sanity:seed`.',
  );
}

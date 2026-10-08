/**
 * Does the live dataset still say what `content/seed.ndjson` says?
 *
 * This is the one thing the MUSE-20 fixture decision cannot prove on its own, and it is
 * worth being honest about. The seed is both the migration artefact and the content the
 * test suite builds against, so there is no *second copy* of the content in the
 * repository — but the dataset is a live system, and the moment Mina edits a page title
 * in the Studio the dataset and the seed disagree. Nothing is broken when that happens:
 * the deploy publishes her words (it fetches live) and the suite goes on asserting
 * against the seed, because what it is really asserting is that the page and `llms.txt`
 * render *whatever the CMS holds*. But a stale seed is a fixture nobody has looked at in
 * a while, so this makes the staleness visible on demand:
 *
 *     npm run sanity:seed:check
 *
 * Deliberately **not** part of `npm run build`. A Studio edit must never fail a deploy —
 * being able to change copy without one is the entire point of the CMS.
 *
 * Reads only, over the public API, with no token. Compares only the fields the seed
 * actually sets, so a field Mina fills in that the seed leaves empty — `phone`, say — is
 * not reported as drift.
 */
import { readFileSync } from 'node:fs';

const PROJECT_ID = process.env.SANITY_PROJECT_ID ?? 'q6fk9usq';
const DATASET = process.env.SANITY_DATASET ?? 'production';
const API_VERSION = process.env.SANITY_API_VERSION ?? '2024-10-01';
const SEED = new URL('../content/seed.ndjson', import.meta.url);

const seeded = readFileSync(SEED, 'utf8')
  .split('\n')
  .filter((line) => line.trim() !== '')
  .map((line) => JSON.parse(line));

/** Drop `_key`, `_type` and friends: they are structure, not content. */
function content(value) {
  if (Array.isArray(value)) return value.map(content);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !key.startsWith('_'))
        .map(([key, nested]) => [key, content(nested)]),
    );
  }
  return value;
}

/** Every leaf of `value`, as `path` → scalar, so a difference can be named. */
function leaves(value, path = '') {
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
 * The uncached API host, not `apicdn` — the one place in this repo that wants it.
 *
 * The build reads through the CDN on purpose (it is cheaper, and a published build only
 * ever wants published content, so a few seconds of lag costs nothing). A drift check is
 * the opposite: asked a minute after an import or a Studio edit, the CDN answers with the
 * previous content and this script reports drift that does not exist — which is worse
 * than not having the check, because the next person stops trusting it.
 */
const ids = seeded.map((doc) => doc._id);
const query = `*[_id in $ids]`;
const url =
  `https://${PROJECT_ID}.api.sanity.io/v${API_VERSION}/data/query/${DATASET}?` +
  new URLSearchParams({ query, $ids: JSON.stringify(ids) });

console.log(`project ${PROJECT_ID} · dataset ${DATASET} · api v${API_VERSION}\n`);

const response = await fetch(url);
if (!response.ok) {
  console.error(`Could not read the dataset: HTTP ${response.status}`);
  console.error(await response.text());
  process.exit(1);
}
const { result } = await response.json();
const live = new Map((result ?? []).map((doc) => [doc._id, doc]));

let drifted = 0;
let missing = 0;

for (const doc of seeded) {
  const published = live.get(doc._id);
  if (!published) {
    missing += 1;
    console.log(`MISSING  ${doc._id} (${doc._type}) — run \`npm run sanity:seed\``);
    continue;
  }

  const differences = leaves(content(doc)).filter(([path, value]) => {
    const found = leaves(content(published)).find(([key]) => key === path);
    return !found || found[1] !== value;
  });

  if (differences.length === 0) {
    console.log(`SAME     ${doc._id}`);
    continue;
  }

  drifted += 1;
  console.log(`DRIFTED  ${doc._id} (${doc._type})`);
  for (const [path, value] of differences) {
    const found = leaves(content(published)).find(([key]) => key === path);
    console.log(`           ${path}`);
    console.log(`             seed: ${JSON.stringify(value)}`);
    console.log(`             live: ${JSON.stringify(found?.[1])}`);
  }
}

console.log(
  `\n${seeded.length} seeded document(s) · ${missing} missing · ${drifted} drifted`,
);

if (missing > 0 || drifted > 0) {
  console.error(
    '\nThe dataset and the seed disagree. If the dataset is right — somebody edited in\n' +
      'the Studio — update `content/seed.ndjson` so the test fixture is the\n' +
      'content that actually exists. If the seed is right, `npm run sanity:seed`.',
  );
  process.exit(1);
}

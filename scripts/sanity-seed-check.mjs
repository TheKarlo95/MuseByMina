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
 *
 * ## What this check cannot tell you, and where that lives now
 *
 * It reports one word, `DRIFTED`, for two opposite situations, and MUSE-78 is the ticket
 * about the difference. **The dataset ahead** is Mina editing: not a release blocker, and
 * the reason this step is `continue-on-error` in CI. **The seed ahead** is us changing
 * content in a pull request, and that change does not reach a visitor until somebody
 * imports it — which is a release blocker that was, until MUSE-78, completely silent.
 *
 * Telling them apart needs evidence this script does not have: the seed as it stood
 * *before* the branch. So the direction, the ordering and the gate live in
 * `scripts/sanity-seed-release.mjs`, and the comparison both scripts perform lives in
 * `scripts/seed-compare.mjs` so that the blocking check and this one cannot disagree
 * about what a difference is.
 */
import {
  differences,
  fetchLive,
  parseSeed,
  readSeed,
  SEED_PATH,
  showLeaf,
  target,
} from './seed-compare.mjs';

const seeded = parseSeed(readSeed());
const where = target();

console.log(
  `project ${where.projectId} · dataset ${where.dataset} · api v${where.apiVersion}\n`,
);

let published;
try {
  published = await fetchLive(
    seeded.map((doc) => doc._id),
    where,
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
const live = new Map(published.map((doc) => [doc._id, doc]));

let drifted = 0;
let missing = 0;

for (const doc of seeded) {
  const found = live.get(doc._id);
  if (!found) {
    missing += 1;
    console.log(`MISSING  ${doc._id} (${doc._type}) — run \`npm run sanity:seed\``);
    continue;
  }

  const changed = differences(doc, found);
  if (changed.length === 0) {
    console.log(`SAME     ${doc._id}`);
    continue;
  }

  drifted += 1;
  console.log(`DRIFTED  ${doc._id} (${doc._type})`);
  for (const { path, seed, live: value } of changed) {
    console.log(`           ${path}`);
    console.log(`             seed: ${showLeaf(seed)}`);
    console.log(`             live: ${showLeaf(value)}`);
  }
}

console.log(
  `\n${seeded.length} seeded document(s) · ${missing} missing · ${drifted} drifted`,
);

if (missing > 0 || drifted > 0) {
  console.error(
    '\nThe dataset and the seed disagree. If the dataset is right — somebody edited in\n' +
      `the Studio — update \`${SEED_PATH}\` so the test fixture is the\n` +
      'content that actually exists. If the seed is right, `npm run sanity:seed`.\n' +
      '\nWhich of those it is, this check cannot tell you: `npm run sanity:seed:release`\n' +
      'can, because it reads the seed as it stood before the branch (MUSE-78).',
  );
  process.exit(1);
}

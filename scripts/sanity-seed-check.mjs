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
 * ## Three findings, and why the third one is here rather than in the gate
 *
 * `MISSING` and `DRIFTED` are about documents the seed names. `UNSEEDED` is MUSE-123: a
 * document **in the dataset and in no seed at all**, which both comparisons were
 * structurally unable to see, because both fetch the dataset by `_id` *taken from the
 * seed* — `*[_id in $ids]`. MUSE-83 widened the release gate's ids to the union of the
 * base and head seeds, which is what makes a *dropped* document visible; an id no seed
 * has ever held is outside that union too.
 *
 * Two ways it happens, and one has already happened:
 *
 *   - **Created in the Studio and never seeded.** MUSE-60 found the live dataset holding
 *     a `studioStory` with `foundedOn: "2025-01-01"` — a founding date nobody has
 *     confirmed — and paragraphs reading „PLACEHOLDER … nije istinit". It published
 *     nothing only because `/aboutus` was not yet a route. Had the route landed without
 *     the seed import, the build would not have *failed* on that document; it would have
 *     rendered it.
 *   - **Dropped by an older branch and never deleted.** `npm run sanity:seed` is
 *     `sanity dataset import --replace`: it replaces by `_id` and never deletes. So a
 *     document a past branch retired is still live, and that branch merged long ago, so
 *     no diff against a merge base mentions it any more.
 *
 * It belongs **here and not in `scripts/sanity-seed-release.mjs`**. That gate blocks, and
 * a document Mina created legitimately is precisely the case that must not fail a pull
 * request (MUSE-45). This check reports without blocking — `continue-on-error` in
 * `ci.yml` — which is the right register for „the dataset holds something the seed does
 * not describe". `test/seedcheck.test.ts` pins that placement in all three places it
 * could be undone.
 *
 * The scope is `READ_CONTRACT` — the document types the read path reads — because
 * Sanity's own `sanity.imageAsset` and `sanity.fileAsset` records are in every dataset
 * legitimately and are not content. That list is kept exhaustive by the schema gate
 * itself (MUSE-66: a document type in neither `READ_CONTRACT` nor `NOT_READ` fails the
 * build), so a new type Mina fills in joins this scope by joining that contract. Drafts
 * are invisible for a different and equally deliberate reason: reading one needs a token,
 * and there is none.
 *
 * ## What this check cannot tell you, and where that lives now
 *
 * `DRIFTED` is one word for two opposite situations, and MUSE-78 is the ticket about the
 * difference. **The dataset ahead** is Mina editing: not a release blocker, and the
 * reason this step is `continue-on-error` in CI. **The seed ahead** is us changing
 * content in a pull request, and that change does not reach a visitor until somebody
 * imports it — which is a release blocker that was, until MUSE-78, completely silent.
 *
 * Telling them apart needs evidence this script does not have: the seed as it stood
 * *before* the branch. So the direction, the ordering and the gate live in
 * `scripts/sanity-seed-release.mjs`, and the comparison both scripts perform lives in
 * `scripts/seed-compare.mjs` so that the blocking check and this one cannot disagree
 * about what a difference is.
 *
 * ## An unreachable API: the verdict fails open, the exit code does not
 *
 * Two different things get called *failing open* and only one of them is the exit code.
 *
 * **The verdict fails open.** A dataset that did not answer yields „could not tell" and
 * nothing else: no document is reported `MISSING`, `DRIFTED` or `UNSEEDED` on evidence
 * that never arrived. `scripts/sanity-seed-release.mjs` does the same, and there the
 * exit code follows, because *there* the exit code blocks a merge and „we could not
 * tell" must not.
 *
 * **The exit code reports that the question went unanswered — `1`.** This step is
 * `continue-on-error: true` in `ci.yml`, so nothing is blocked by it either way, which
 * means the only reader of the code is a human or an agent running the command. For that
 * reader `0` says *all clear*, and „I could not read the dataset" is not all clear.
 * `exitCode` is the one place that decision lives and `test/seedcheck.test.ts` pins it
 * both ways, because the old script's exit was pinned by nothing and could therefore have
 * moved in silence.
 */
import { READ_CONTRACT } from './check-sanity.mjs';
import {
  differences,
  fetchLive,
  parseSeed,
  queryUrl,
  readSeed,
  SEED_PATH,
  showLeaf,
  target,
} from './seed-compare.mjs';

/**
 * @typedef {{ _id: string, _type: string }} Row
 * @typedef {Record<string, any> & Row} Doc
 * @typedef {{ path: string, seed: any, live: any }} Change
 * @typedef {Row & { state: 'same' | 'missing' | 'drifted', changed: Change[] }} Seeded
 * @typedef {{
 *   unreadable: boolean,
 *   documents: Seeded[],
 *   missing: Row[],
 *   drifted: Seeded[],
 *   unseeded: Row[],
 *   disagrees: boolean,
 * }} Verdict
 */

/**
 * The document types the site reads, which is the scope an unseeded document is looked
 * for in. Taken from the schema gate's `READ_CONTRACT` rather than written out here —
 * see the header: that list is asserted exhaustive against the schema, and the two
 * `sanity.*` asset types are excluded because somebody wrote down *why* they are not
 * content, not because a filter happens to name them.
 */
export const CONTENT_TYPES = Object.keys(READ_CONTRACT).sort();

/**
 * **What the dataset holds, as ids and types** — the one question neither script asked.
 *
 * A projection rather than whole documents: the comparison is `_id` set subtraction, and
 * the fields of a document nobody has reviewed are exactly what a human should go and
 * read in the Studio rather than have printed here. The `$types` filter narrows the reply
 * to content; the same narrowing is applied again in `seedVerdict`, so a reply that
 * arrived unnarrowed produces the same verdict.
 */
export const UNSEEDED_QUERY = '*[_type in $types]{_id, _type}';

/**
 * `UNSEEDED_QUERY` against the uncached host, through `queryUrl` so the host has one
 * spelling (MUSE-81).
 *
 * Throws on anything other than a 200, like `fetchLive`, and for the same reason: what an
 * unreachable API *means* is the caller's decision, and the two callers of this module's
 * neighbour do not agree about it.
 *
 * @param {string[]} [types]
 * @param {ReturnType<typeof target>} [where]
 * @returns {Promise<Row[]>}
 */
export async function fetchIndex(types = CONTENT_TYPES, where = target()) {
  const response = await fetch(queryUrl(UNSEEDED_QUERY, { types }, where));
  if (!response.ok) {
    throw new Error(
      `Could not read the dataset: HTTP ${response.status}\n${await response.text()}`,
    );
  }
  const { result } = await response.json();
  return result ?? [];
}

/**
 * **The whole verdict, as a pure function of the seed and the dataset's two replies.**
 *
 * Pure because it has to be testable: MUSE-123's finding cannot be exercised by writing
 * to the dataset — no script here holds a credential and none should — so the only way to
 * prove it is to hand the comparison a dataset that holds something the seed does not.
 * `test/seedcheck.test.ts` does exactly that, as `test/seedrelease.test.ts` does for the
 * release gate.
 *
 * `documents` keeps the seed's own file order, because that is the order the report reads
 * in; `missing` and `drifted` are the same rows bucketed, because that is what the
 * decision needs. Both, rather than one derived at each call site.
 *
 * @param {{ seeded: Doc[], live: Doc[] | null, index: Row[] | null, types?: string[] }} input
 * @returns {Verdict}
 */
export function seedVerdict({ seeded, live, index, types = CONTENT_TYPES }) {
  if (live === null || index === null) {
    return {
      unreadable: true,
      documents: [],
      missing: [],
      drifted: [],
      unseeded: [],
      disagrees: false,
    };
  }

  const published = new Map(live.map((doc) => [doc._id, doc]));

  /** @type {Seeded[]} */
  const documents = seeded.map((doc) => {
    const found = published.get(doc._id);
    if (!found) return { _id: doc._id, _type: doc._type, state: 'missing', changed: [] };
    const changed = differences(doc, found);
    return {
      _id: doc._id,
      _type: doc._type,
      state: changed.length === 0 ? 'same' : 'drifted',
      changed,
    };
  });

  // The subtraction MUSE-123 is about. The seed's ids are the only thing that makes a
  // live document "described", and the type scope is applied here as well as in the
  // query so the rule is a property of the comparison.
  const described = new Set(seeded.map((doc) => doc._id));
  const scope = new Set(types);
  const unseeded = index
    .filter((row) => !described.has(row._id) && scope.has(row._type))
    .map(({ _id, _type }) => ({ _id, _type }))
    .sort((one, other) => one._id.localeCompare(other._id));

  const missing = documents.filter((doc) => doc.state === 'missing');
  const drifted = documents.filter((doc) => doc.state === 'drifted');

  return {
    unreadable: false,
    documents,
    missing: missing.map(({ _id, _type }) => ({ _id, _type })),
    drifted,
    unseeded,
    disagrees: missing.length > 0 || drifted.length > 0 || unseeded.length > 0,
  };
}

/**
 * The verdict as lines, in seed order, with the counts last.
 *
 * `0 unseeded` in the summary is load-bearing: a check that prints nothing when it found
 * nothing cannot be told apart from a check that did not look.
 *
 * @param {Verdict} verdict
 * @returns {string[]}
 */
export function seedReport(verdict) {
  if (verdict.unreadable) {
    return [
      'The dataset could not be read, so whether it still says what the seed says is',
      'unknown — and unknown is what this reports: nothing is called missing, drifted or',
      'unseeded on evidence that did not arrive. It exits 1 all the same. The step is',
      '`continue-on-error` in `ci.yml`, so that blocks nothing; the code is read by a',
      'human, and a check that could not answer must not say nothing is wrong.',
    ];
  }

  /** @type {string[]} */
  const lines = [];

  for (const doc of verdict.documents) {
    if (doc.state === 'missing') {
      lines.push(`MISSING  ${doc._id} (${doc._type}) — run \`npm run sanity:seed\``);
      continue;
    }
    if (doc.state === 'same') {
      lines.push(`SAME     ${doc._id}`);
      continue;
    }
    lines.push(`DRIFTED  ${doc._id} (${doc._type})`);
    for (const { path, seed, live } of doc.changed) {
      lines.push(`           ${path}`);
      lines.push(`             seed: ${showLeaf(seed)}`);
      lines.push(`             live: ${showLeaf(live)}`);
    }
  }

  for (const { _id, _type } of verdict.unseeded) {
    lines.push(`UNSEEDED ${_id} (${_type}) — in the dataset, described by no seed`);
  }

  lines.push(
    '',
    `${verdict.documents.length} seeded document(s) · ${verdict.missing.length} missing · ` +
      `${verdict.drifted.length} drifted · ${verdict.unseeded.length} unseeded`,
  );

  return lines;
}

/**
 * What to do about it, when there is something to do. Empty when the dataset agrees with
 * the seed, and empty on an unreachable API — there is no advice to give about an outage.
 *
 * @param {Verdict} verdict
 * @returns {string[]}
 */
export function seedAdvice(verdict) {
  /** @type {string[]} */
  const advice = [];
  if (verdict.unreadable) return advice;

  if (verdict.missing.length > 0 || verdict.drifted.length > 0) {
    advice.push(
      '',
      'The dataset and the seed disagree. If the dataset is right — somebody edited in',
      `the Studio — update \`${SEED_PATH}\` so the test fixture is the`,
      'content that actually exists. If the seed is right, `npm run sanity:seed`.',
      '',
      'Which of those it is, this check cannot tell you: `npm run sanity:seed:release`',
      'can, because it reads the seed as it stood before the branch (MUSE-78).',
    );
  }

  if (verdict.unseeded.length > 0) {
    advice.push(
      '',
      `${verdict.unseeded.length} document(s) above are in the dataset and in no seed, and`,
      'neither this check nor `npm run sanity:seed:release` could see that before MUSE-123:',
      'both fetch the dataset by `_id` taken from the seed. Nothing is necessarily broken —',
      'the deploy publishes what the dataset holds — but it is content nobody reviewed, and',
      'routing one page is all it takes to render it: MUSE-60 found a `studioStory` with an',
      'unconfirmed founding date and paragraphs reading „PLACEHOLDER".',
      '',
      `If it should exist, add it to \`${SEED_PATH}\` so the fixture describes what the site`,
      'reads. If it should not, it has to be deleted from the dataset — `npx sanity documents',
      'delete <id> --dataset production`, then `npm run sanity:seed` — and **an agent runs',
      'neither command.**',
    );
  }

  return advice;
}

/**
 * **The exit code, which is not the same question as the verdict.**
 *
 * `1` for a disagreement and `1` for „could not tell", `0` only when the dataset was read
 * and said what the seed says. The verdict still fails open — see the header — and this is
 * the half that does not: the step is `continue-on-error`, so the code blocks nothing and
 * its one reader is a human, for whom `0` means *all clear*.
 *
 * @param {Verdict} verdict
 * @returns {0 | 1}
 */
export function exitCode(verdict) {
  return verdict.unreadable || verdict.disagrees ? 1 : 0;
}

/* ------------------------------------------------------------------ the command */

if (import.meta.url === `file://${process.argv[1]}`) {
  const seeded = parseSeed(readSeed());
  const where = target();

  console.log(
    `project ${where.projectId} · dataset ${where.dataset} · api v${where.apiVersion}\n`,
  );

  /** @type {Doc[] | null} */
  let live = null;
  /** @type {Row[] | null} */
  let index = null;

  try {
    [live, index] = await Promise.all([
      fetchLive(
        seeded.map((/** @type {any} */ doc) => doc._id),
        where,
      ),
      fetchIndex(CONTENT_TYPES, where),
    ]);
  } catch (error) {
    // Both reads or neither: a verdict assembled from one of them would report every
    // seeded document as missing, or every unseeded one as absent, on a half-answered
    // outage. See the header for why this is not a failure.
    console.warn(`${error instanceof Error ? error.message : String(error)}\n`);
  }

  const verdict = seedVerdict({ seeded, live, index });
  for (const line of seedReport(verdict)) console.log(line);
  for (const line of seedAdvice(verdict)) console.error(line);

  process.exit(exitCode(verdict));
}

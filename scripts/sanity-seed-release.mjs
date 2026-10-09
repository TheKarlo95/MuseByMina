/**
 * **A content change in a branch does not reach a visitor until a build runs after an
 * import. This is the check that says so, in order — MUSE-78.**
 *
 * The build fetches the live dataset; the test suite reads `content/seed.ndjson`
 * (`MUSE_CONTENT_FIXTURE`, MUSE-20). So a change to the seed behaves in two completely
 * different ways depending on whether it adds a document or edits one:
 *
 * | the branch | tests | CI | the live site |
 * | -- | -- | -- | -- |
 * | **adds** a document | pass — the fixture has it | **red** — the build names the missing document | — |
 * | **edits** a document | pass | **green** | **unchanged** |
 *
 * The adding case is safe by accident: the build cannot publish content it refuses to
 * build against, so somebody imports and CI goes green. The editing case had **no signal
 * at all** — a green pull request, a suite asserting the new text, a reviewer reading the
 * new text in the diff, and a deployed page still serving the old one.
 *
 * ## The timeline this exists because of
 *
 * MUSE-71 removed a commercial promise the studio does not offer — „besplatni probni
 * sat" — from five code surfaces and from two `page` descriptions. It merged as
 * `ea55858`:
 *
 *     08:34  the push deploy builds ea55858 → fetches the dataset → the old description
 *     08:41  `npm run sanity:seed` imports the new descriptions
 *     08:42  the live site still serves „… Dođi na besplatni probni sat."
 *     08:43  a forced workflow_dispatch rebuild
 *     08:48  correct
 *
 * Everything was green at 08:42. **Seeding after the merge is not enough**, because the
 * only thing that reads the dataset is a build and the push-triggered deploy always fires
 * before anyone can run the import. Left alone the fix would have appeared at the next
 * scheduled rebuild — up to `MAX_WAIT_HOURS` later (`src/lib/rebuild.ts`) — with nothing
 * anywhere indicating the site was stale. So this check does not say "a seed is needed".
 * "Run `npm run sanity:seed`" is precisely what was done, and the site stayed wrong. It
 * names **the sequence**, and which sequence depends on whether the commit has landed.
 *
 * ## Direction, which is the whole of the ticket
 *
 * `npm run sanity:seed:check` already compares the seed with the dataset and reports
 * `DRIFTED`. That one word covers two opposite situations:
 *
 *   - **the dataset is ahead** — Mina edited in the Studio. The deploy publishes her
 *     words; the seed is a stale fixture. **Not a release blocker**, which is why that
 *     step is `continue-on-error` in CI and must stay so (MUSE-45): being able to change
 *     copy without a deploy is the entire point of the CMS.
 *   - **the seed is ahead** — we changed content in a pull request. The change does not
 *     ship until somebody imports. **That is a release blocker.**
 *
 * Telling them apart needs one piece of evidence `sanity:seed:check` does not have: the
 * seed as it stood *before* the branch. The seed is in git, so that evidence is free and
 * needs no credential — `git show <merge-base>:content/seed.ndjson`. Per leaf:
 *
 * | before the branch | this branch | the dataset | what it is | blocks |
 * | -- | -- | -- | -- | -- |
 * | `x` | `x` | `x` | nothing happened | no |
 * | `x` | `x` | `y` | **the dataset is ahead** — Mina editing | **no** |
 * | `x` | `y` | `y` | **imported** — the sequence was followed | no |
 * | `x` | `y` | `x` | **stale** — ours, unshipped | **yes** |
 * | `x` | `y` | `z` | **both moved, on one field** — a conflict | **yes**, naming both |
 *
 * Authorship is what the git half establishes, and it is the only thing that can: a value
 * that differs from the dataset *and* from the merge base is ours, and nothing about the
 * dataset alone could have said so.
 *
 * ## What happens when both have moved
 *
 * Two shapes, and the message distinguishes them rather than picking a direction.
 *
 * **On one field** — the last row above. Somebody edited in the Studio after the branch
 * forked, so importing reverts their wording and merging without importing drops ours.
 * This check refuses to choose: it prints all three values and asks for the decision to
 * be recorded in the seed, which is the only place an import can read it from.
 *
 * **On different fields** — we rewrote `page-home.description`, Mina rewrote
 * `siteSettings.tagline`. Reported as *collateral*, because `npm run sanity:seed` is
 * `sanity dataset import --replace` over the **whole file**: it replaces all twenty-odd
 * documents, so the import that ships our two fields silently reverts her edit as well.
 * Collateral never blocks on its own — a branch that touches nothing must not go red
 * because somebody reworded a title this morning — but it is printed beside the blocker,
 * because the remedy for it ("refresh the seed from the dataset first") has to happen
 * *before* the import the blocker is asking for.
 *
 * ## Why an unreachable API passes
 *
 * Because "we could not tell" must not block a pull request — `ci.yml`'s `rebuildloop`
 * job establishes that — and because here it costs nothing: since MUSE-20 `npm run build`
 * fetches the dataset at build time and hard-fails if Sanity does not answer, in the
 * `check` job, in the `a11y` job and in `deploy.yml`. An outage therefore already makes
 * every pull request red. A second red for the same outage would only teach people to
 * ignore this one.
 *
 * ## No credential
 *
 * The dataset is publicly readable and this script only ever issues a GROQ `GET`. It
 * **cannot** import, and it is not the place to add one: option 3 on the ticket —
 * auto-seeding on merge — needs a content-write token in CI, and this project's
 * architecture was deliberately arranged so that no such token exists (MUSE-21 declined a
 * GitHub PAT inside Sanity; MUSE-45 kept content edits away from `SANITY_DEPLOY_TOKEN`).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  ABSENT,
  differences,
  fetchLive,
  leafAt,
  leafMap,
  parseSeed,
  readSeed,
  SEED_PATH,
  showLeaf,
  target,
} from './seed-compare.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ------------------------------------------------------------------ the verdict */

/**
 * What the branch claims about the dataset, and whether the dataset holds it yet.
 *
 * Pure, and the reason the whole decision is a function of three arguments: a test can
 * hand it a base seed, a head seed and a dataset and assert every row of the table above
 * without a network, a build, a browser or a child process — the last of which
 * `test/isolation.test.ts` forbids under `test/` anyway.
 *
 * @param base  the seed as it stood at the merge base, parsed. `[]` if the file is new.
 * @param head  the seed on this branch, parsed.
 * @param live  the matching documents from the dataset, or `null` if it could not be read.
 */
export function releaseVerdict({ base, head, live }) {
  const baseById = new Map(base.map((doc) => [doc._id, doc]));
  const headById = new Map(head.map((doc) => [doc._id, doc]));
  const liveById = live === null ? null : new Map(live.map((doc) => [doc._id, doc]));

  /** `_id`s whose content this branch changed — the git half, independent of the dataset. */
  const authored = [];
  /** Authored and not in the dataset yet. The blocker. */
  const pending = [];
  /** Authored and already in the dataset: the sequence was followed. */
  const imported = [];
  /** The dataset is ahead here and this branch did not author it. Never blocks. */
  const collateral = [];
  /** Dropped from the seed. An import never deletes, so the document is still live. */
  const removed = [];

  for (const [id, before] of baseById) {
    if (!headById.has(id)) removed.push({ id, type: before._type });
  }

  for (const [id, doc] of headById) {
    const before = baseById.get(id);
    const was = before ? leafMap(before) : new Map();
    const now = leafMap(doc);
    const paths = [...new Set([...was.keys(), ...now.keys()])].sort();
    const changed = new Set(paths.filter((path) => leafAt(was, path) !== leafAt(now, path)));

    if (changed.size > 0) authored.push(id);

    if (!liveById) continue;
    const published = liveById.get(id);

    if (!published) {
      // No document at all. The *adding* case, which the build already refuses to
      // publish past — reported here too so one message carries the whole sequence.
      pending.push({
        id,
        type: doc._type,
        absent: true,
        fields: changed.size > 0 ? [...changed] : [...now.keys()],
      });
      continue;
    }

    const live2 = leafMap(published);

    if (changed.size > 0) {
      const fields = [...changed].map((path) => {
        const baseValue = leafAt(was, path);
        const seedValue = leafAt(now, path);
        const liveValue = leafAt(live2, path);
        const kind =
          liveValue === seedValue
            ? 'imported'
            : liveValue === baseValue
              ? 'stale'
              : 'conflict';
        return { path, base: baseValue, seed: seedValue, live: liveValue, kind };
      });
      const unshipped = fields.filter((field) => field.kind !== 'imported');
      if (unshipped.length > 0) pending.push({ id, type: doc._type, fields: unshipped });
      else imported.push({ id, type: doc._type, fields: fields.map((f) => f.path) });
    }

    // Everything the dataset disagrees with that this branch did not write. The import
    // is `--replace` over every document in the file, so this is what it would revert.
    const theirs = differences(doc, published).filter(({ path }) => !changed.has(path));
    if (theirs.length > 0) collateral.push({ id, type: doc._type, fields: theirs });
  }

  const conflicts = pending.flatMap(({ id, type, fields = [] }) =>
    fields.filter((field) => field.kind === 'conflict').map((field) => ({ id, type, field })),
  );

  return {
    authored,
    pending,
    imported,
    collateral,
    removed,
    conflicts,
    unreadable: liveById === null,
    /** The one bit CI reads. Nothing else in here may fail a run. */
    blocked: pending.length > 0,
  };
}

/* ------------------------------------------------------------------ the message */

const bullet = (field) =>
  field.kind === 'conflict'
    ? [
        `      ${field.path}   conflict — the dataset holds neither value`,
        `        before this branch: ${showLeaf(field.base)}`,
        `        this branch:        ${showLeaf(field.seed)}`,
        `        the dataset:        ${showLeaf(field.live)}`,
      ]
    : [
        `      ${field.path}   not imported`,
        `        this branch:  ${showLeaf(field.seed)}`,
        `        the dataset:  ${showLeaf(field.live)}`,
      ];

/**
 * The report, as lines.
 *
 * `merged` is the whole reason this is not one fixed paragraph. Before the merge there is
 * **one** step and no stale window; after it there are **two**, and the second — a forced
 * rebuild — is the one that gets forgotten, because the first one succeeds and looks like
 * the end of the job. That is the MUSE-71 timeline exactly.
 */
export function report(verdict, { merged = false } = {}) {
  const lines = [];

  if (verdict.unreadable) {
    lines.push(
      'The dataset could not be read, so whether this branch’s content has been imported',
      'is unknown. Not failing on it: `npm run build` fetches the dataset in three jobs and',
      'hard-fails on an outage, so an unreachable API is already red everywhere it matters.',
    );
    if (verdict.authored.length > 0) {
      lines.push(
        '',
        `This branch does change ${SEED_PATH}: ${verdict.authored.join(', ')}.`,
        'Run `npm run sanity:seed:release` again once the API answers.',
      );
    }
    return lines;
  }

  // A removal is a change to the seed even though it changes no document's content, so
  // it has to count here or a branch that only drops a document reports as touching
  // nothing — which is true of the dataset and false of the file.
  const touched = [...verdict.authored, ...verdict.removed.map(({ id }) => id)];

  if (touched.length === 0) {
    lines.push(`This branch does not change ${SEED_PATH}, so there is nothing to import.`);
    if (verdict.collateral.length > 0) {
      lines.push(
        '',
        `The dataset is ahead of the seed in ${verdict.collateral.length} document(s) — that is`,
        'Mina editing in the Studio, the deploy publishes her words, and no pull request fails',
        'for it. `npm run sanity:seed:check` is the report; refreshing the seed keeps the test',
        'fixture honest and is not urgent.',
      );
    }
    return lines;
  }

  lines.push(
    `This branch changes ${touched.length} document(s) in ${SEED_PATH}:`,
    `  ${touched.join(', ')}`,
  );

  if (verdict.imported.length > 0) {
    lines.push('', 'Already in the dataset — these will ship with the next build:');
    for (const { id, type, fields } of verdict.imported) {
      lines.push(`  ${id} (${type})   ${fields.join(', ')}`);
    }
  }

  if (verdict.pending.length === 0) {
    lines.push(
      '',
      'Every content change on this branch is already in the dataset. Merging publishes it:',
      'the deploy that fires on merge is a build, and a build is the only thing that reads',
      'the dataset.',
    );
  } else {
    const consequence = merged
      ? 'The deploy for this commit has already published the old values.'
      : 'Merging now would publish the old values.';
    lines.push(
      '',
      `NOT IMPORTED — ${verdict.pending.length} document(s). ${consequence}`,
      '',
    );
    for (const entry of verdict.pending) {
      lines.push(`    ${entry.id} (${entry.type})`);
      if (entry.absent) {
        lines.push(
          '      the dataset has no such document — this is the *adding* case, which the',
          '      build refuses to publish past, so it cannot reach a visitor silently',
        );
      } else {
        for (const field of entry.fields) lines.push(...bullet(field));
      }
    }
  }

  if (verdict.conflicts.length > 0) {
    lines.push(
      '',
      'BOTH HAVE MOVED, on the same field. Somebody edited in the Studio after this branch',
      'forked, so importing reverts their wording and merging without importing drops ours.',
      'This check will not choose between them: decide which text is right, write it into',
      `${SEED_PATH}, and import that. Fields: ` +
        verdict.conflicts.map(({ id, field }) => `${id}.${field.path}`).join(', '),
    );
  }

  if (verdict.collateral.length > 0) {
    lines.push(
      '',
      'THE IMPORT WOULD ALSO REVERT these, which this branch did not write — the dataset is',
      'ahead of the seed and `npm run sanity:seed` is `--replace` over every document in the',
      'file, not only the ones you edited. Fold them into the seed first, or the import ships',
      'our change and quietly undoes somebody else’s:',
    );
    for (const { id, type, fields } of verdict.collateral) {
      lines.push(`    ${id} (${type})`);
      for (const { path, seed, live } of fields) {
        lines.push(
          `      ${path}`,
          `        the seed:     ${showLeaf(seed)}`,
          `        the dataset:  ${showLeaf(live)}`,
        );
      }
    }
  }

  if (verdict.removed.length > 0) {
    lines.push(
      '',
      `Dropped from ${SEED_PATH}: ${verdict.removed.map(({ id }) => id).join(', ')}. An import`,
      'never deletes, so those documents are still in the dataset and the site still reads',
      'them. Delete them in the Studio if that was the intent.',
    );
  }

  if (verdict.pending.length > 0) lines.push('', ...sequence({ merged }));
  return lines;
}

/**
 * The order of operations, which is the deliverable. Not "remember to seed".
 *
 * Three sequences are viable and this names one of them, because the other two are worse
 * in ways somebody has to decide to accept:
 *
 *   1. **Import, then merge.** One step, no stale window. `--replace` is keyed on `_id`
 *      and these documents already exist, so importing content whose pull request has not
 *      landed is safe — it is an edit to copy, and the site reads copy from the dataset
 *      either way.
 *   2. **Merge, import, then force a rebuild.** Two manual steps and the second is the
 *      forgettable one. It is what MUSE-71 did, and the second step is why the site was
 *      wrong for fourteen minutes rather than six hours.
 *   3. **Merge, import, and accept the stale window** until the next scheduled rebuild.
 *      Honest only if somebody has decided that is acceptable. For a false commercial
 *      promise it plainly was not.
 */
export function sequence({ merged = false } = {}) {
  if (!merged) {
    return [
      'THE SEQUENCE — import first, then merge:',
      '',
      '    npm run sanity:seed      # --replace, keyed on _id; the documents already exist',
      '',
      'Then re-run this check; it goes green when the dataset agrees, and the deploy that',
      'fires on merge is the first build that reads the new content. One step, no window.',
      '',
      'Importing *after* the merge is not enough. The push-triggered deploy has fetched the',
      'dataset before you can run the import, so the site keeps serving the old value until',
      'the next scheduled rebuild — up to `MAX_WAIT_HOURS` (src/lib/rebuild.ts) — with',
      'nothing indicating it is stale. That is MUSE-71: pull request green, import green,',
      'page wrong.',
    ];
  }
  return [
    'THE SEQUENCE — this commit is already on `main`, so the deploy for it has published',
    'the old values. Two steps, and the second is the one that gets forgotten:',
    '',
    '    1.  npm run sanity:seed',
    '    2.  Actions → Deploy to GitHub Pages → Run workflow',
    '',
    'Step 2 is not optional: a build is the only thing that reads the dataset, and the one',
    'for this commit has already run. Without it the fix waits for the next scheduled',
    'rebuild — up to `MAX_WAIT_HOURS` (src/lib/rebuild.ts). Next time, import before',
    'merging: one step and no stale window.',
  ];
}

/* ------------------------------------------------------------------ the git half */

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();

/** A sha that is all zeros is GitHub's "there was no before" — a new branch or a force-push. */
const NO_SHA = /^0+$/;

/**
 * The commit this branch's seed should be compared against.
 *
 * `SEED_BASE_SHA` is what CI hands over: `github.event.pull_request.base.sha` on a pull
 * request, `github.event.before` on a push to `main`. Locally there is no event, so the
 * merge base against `origin/main` is computed instead — which is the same commit, and
 * makes the check runnable by hand before pushing, which is where it is cheapest to obey.
 */
export function baseRevision(env = process.env) {
  const given = env.SEED_BASE_SHA?.trim();
  if (given) {
    // An all-zero sha is GitHub saying there *was* no before, and it must not fall
    // through to the merge base: on a push to `main` that resolves to HEAD, which makes
    // the base equal the head and reports "this branch changes nothing" about a commit
    // nobody has compared with anything. "We could not tell" is the honest answer.
    if (NO_SHA.test(given)) return null;
    try {
      return { rev: git('rev-parse', '--verify', `${given}^{commit}`), how: 'SEED_BASE_SHA' };
    } catch {
      return null;
    }
  }
  for (const ref of ['origin/main', 'main']) {
    try {
      return { rev: git('merge-base', 'HEAD', ref), how: `merge-base with ${ref}` };
    } catch {
      /* not fetched, or no such ref */
    }
  }
  return null;
}

/** The seed at a revision. `null` means the file did not exist there. */
export function seedAt(rev) {
  try {
    return git('show', `${rev}:${SEED_PATH}`);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ the command */

if (import.meta.url === `file://${process.argv[1]}`) {
  const where = target();
  const merged = process.env.SEED_MERGED === 'true';

  console.log(
    `project ${where.projectId} · dataset ${where.dataset} · api v${where.apiVersion}`,
  );

  const head = parseSeed(readSeed());
  const at = baseRevision();

  if (!at) {
    // Nothing to diff against — a shallow clone with no base, or GitHub's all-zero
    // `before` on a force-push. "We could not tell" passes, loudly, and says which half
    // was missing so the fix is to the workflow rather than to the branch.
    console.log('base: <could not be determined>\n');
    console.warn(
      `Could not work out which revision to compare ${SEED_PATH} against, so whether this\n` +
        'branch changes content is unknown. In CI that means `SEED_BASE_SHA` is unset or the\n' +
        'checkout is too shallow to hold it — `actions/checkout` needs `fetch-depth: 0`.',
    );
    process.exit(0);
  }

  console.log(`base: ${at.rev} (${at.how})\n`);
  const baseText = seedAt(at.rev);
  const base = baseText === null ? [] : parseSeed(baseText);

  let live = null;
  try {
    live = await fetchLive(
      head.map((doc) => doc._id),
      where,
    );
  } catch (error) {
    console.warn(`${error.message}\n`);
  }

  const verdict = releaseVerdict({ base, head, live });
  const lines = report(verdict, { merged });
  for (const line of lines) (verdict.blocked ? console.error : console.log)(line);

  process.exit(verdict.blocked ? 1 : 0);
}

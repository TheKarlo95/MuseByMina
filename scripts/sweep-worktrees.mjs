/**
 * **Reclaim the worktrees whose tickets are finished — MUSE-79, the half that is not
 * automatic, and the reason it is not.**
 *
 * This project runs one git worktree per ticket, and nothing has ever removed one. When
 * the ticket was filed there were 52, **42 of them belonging to merged pull requests**,
 * each carrying its own `node_modules` — 117 of those across the tree — and its own
 * accumulated build output. The build output is now swept by age on every run
 * (`test/helpers/clean-scratch.ts`); a worktree is the other half, and it cannot be swept
 * by age, because the age of a worktree says nothing at all about whether somebody is
 * working in it.
 *
 * ## Why this is a command and not a schedule
 *
 * **An agent's worktree looks exactly like an abandoned one between two tool calls.** No
 * file is open, no process is running, nothing is locked, and the last commit may be an
 * hour old because the agent is reading. Deleting one mid-ticket destroys work that exists
 * nowhere else and is worse than the disk pressure this ticket is about — so there is no
 * `schedule:`, no hook and nothing in `globalSetup` that calls any of this. A human runs
 * it, reads the table, and runs it again with `--remove`.
 *
 * The build prune can be automatic because age is a sound discriminator there: a live
 * build is minutes old (MUSE-34). Nothing here has an equivalent, so the discriminator is
 * evidence instead — a merged pull request plus a clean tree plus a tip commit the pull
 * request already contains.
 *
 * ## The trap: this repository squash-merges
 *
 * A squash merge creates a **new commit** on `main` with no parent link to the branch, so
 * a merged feature branch is **never** an ancestor of `main` and
 * `git merge-base --is-ancestor` reports every single merged worktree as unmerged. The
 * commit graph cannot answer this question here. The pull request's own state can, so that
 * is what is read — `gh pr list`, one call, no credentials of ours.
 *
 * ## What it refuses to remove, and why each one
 *
 *   - **the checkout itself** — it is not a worktree to reclaim;
 *   - **a dirty tree** — uncommitted or untracked work exists nowhere else. Ignored files
 *     do not count, which is what makes `node_modules` not a blocker;
 *   - **a detached HEAD** — there is no branch, so there is no pull request to ask about;
 *   - **a branch with no merged pull request** — including one with no pull request at
 *     all, which is the shape an in-progress ticket has;
 *   - **a branch whose pull request is still open**;
 *   - **a locked worktree** — git was told to leave it alone.
 *
 * `git worktree remove` is then called **without `--force`**, so git re-checks the clean
 * tree itself: the verdict and the removal disagree in git's favour.
 *
 * ## The third verdict, which this machine needs and the ticket did not foresee
 *
 * A merged pull request and a clean tree were the ticket's criteria, and on this box three
 * of the five merged worktrees satisfy both while holding **commits that are in no pull
 * request and on no remote** — a branch force-pushed or rebased before it merged leaves
 * the local tip behind, and the squash commit on `main` has a different hash and a
 * different tree. The content is almost certainly in `main`; nothing here can show that it
 * is. So those are reported as `REVIEW`, with the one command that answers it, and
 * `--remove` does not touch them. A sweep that is right about 2 and silent about 3 is
 * worth more than one that is confident about 5.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * One worktree, as `git worktree list --porcelain` describes it plus what its own status
 * says.
 *
 * @typedef {object} Worktree
 * @property {string} path Absolute, as git reports it.
 * @property {string | null} branch Short name, or `null` for a detached HEAD.
 * @property {string} head The tip commit.
 * @property {boolean} locked Git was told to leave this one alone.
 * @property {boolean} dirty Tracked changes or untracked files; ignored files do not count.
 * @property {boolean} pushed `HEAD` is contained in some remote-tracking ref, so the
 *   commits here exist somewhere other than this directory.
 * @property {boolean} main The checkout itself rather than a linked worktree.
 */

/**
 * A pull request, as `gh pr list` reports it.
 *
 * @typedef {object} PullRequest
 * @property {number} number
 * @property {string} state `MERGED`, `OPEN` or `CLOSED`.
 * @property {string} headRefName The branch it was opened from.
 * @property {string} headRefOid The commit it was merged (or last pushed) at.
 */

/** What to do about one worktree, and the sentence the table prints for it. */
/**
 * @typedef {object} Verdict
 * @property {'remove' | 'keep' | 'review'} action
 * @property {string} why
 */

/* ------------------------------------------------------------------ the decision */

/**
 * Whether `worktree` may be reclaimed, given every pull request the repository has.
 *
 * Pure, so it is the part with tests: `test/isolation.test.ts` hands it the cases above
 * rather than making a worktree and a pull request to find out.
 *
 * @param {Worktree} worktree
 * @param {PullRequest[]} pulls
 * @returns {Verdict}
 */
export function verdict(worktree, pulls) {
  if (worktree.main) return { action: 'keep', why: 'the checkout itself' };
  if (worktree.locked) return { action: 'keep', why: 'locked' };
  if (worktree.dirty) return { action: 'keep', why: 'uncommitted or untracked work' };
  if (worktree.branch === null) {
    return { action: 'keep', why: 'a detached HEAD, so there is no pull request to ask about' };
  }

  const mine = pulls.filter((pull) => pull.headRefName === worktree.branch);
  if (mine.some((pull) => pull.state === 'OPEN')) {
    const open = mine.find((pull) => pull.state === 'OPEN');
    return { action: 'keep', why: `pull request #${open?.number} is still open` };
  }

  const merged = mine.filter((pull) => pull.state === 'MERGED');
  if (merged.length === 0) {
    // Note what this is *not*: `git merge-base --is-ancestor`. This repository
    // squash-merges, so that answers "unmerged" for every worktree here.
    return { action: 'keep', why: 'no merged pull request for this branch' };
  }

  const landed = merged.find((pull) => pull.headRefOid === worktree.head);
  if (landed === undefined && !worktree.pushed) {
    const at = merged.map((pull) => `#${pull.number} at ${short(pull.headRefOid)}`).join(', ');
    return {
      action: 'review',
      why:
        `merged (${at}) but HEAD is ${short(worktree.head)}, which is in no pull request ` +
        'and on no remote — the usual cause is a branch rebased before it merged',
    };
  }

  const why = landed === undefined ? 'merged, and HEAD is on a remote' : 'merged at this HEAD';
  return { action: 'remove', why: `pull request #${(landed ?? merged[0])?.number} ${why}` };
}

/** @type {(oid: string) => string} */
const short = (oid) => oid.slice(0, 7);

/* ----------------------------------------------------------------------- the shell */

/** @type {(args: string[], cwd?: string) => string} */
function git(args, cwd = ROOT) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Every worktree of this checkout, each one asked whether it is dirty.
 *
 * @returns {Worktree[]}
 */
export function worktrees() {
  /** @type {Worktree[]} */
  const found = [];
  /** @type {Partial<Worktree> | null} */
  let current = null;

  const flush = () => {
    if (current?.path !== undefined) {
      found.push({
        path: current.path,
        branch: current.branch ?? null,
        head: current.head ?? '',
        locked: current.locked ?? false,
        main: found.length === 0,
        dirty: isDirty(current.path),
        pushed: isPushed(current.head ?? ''),
      });
    }
    current = null;
  };

  for (const line of git(['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current = { path: line.slice('worktree '.length) };
    } else if (current === null) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'locked' || line.startsWith('locked ')) {
      current.locked = true;
    }
  }
  flush();

  return found;
}

/**
 * Tracked changes or untracked files in `path`.
 *
 * `--porcelain` alone, so **ignored** files are not reported: `node_modules` and the build
 * scratch root are both ignored, and a worktree is not kept alive by its own dependencies.
 * A worktree git cannot answer about counts as dirty — not being able to tell is not a
 * licence to delete.
 *
 * @param {string} path
 * @returns {boolean}
 */
function isDirty(path) {
  try {
    return git(['status', '--porcelain'], path).trim() !== '';
  } catch {
    return true;
  }
}

/**
 * Is `head` reachable from any remote-tracking ref?
 *
 * The question behind it is "do these commits exist anywhere but this directory", and a
 * remote is the only place that is true of. `false` on an error, for `isDirty`'s reason.
 *
 * @param {string} head
 * @returns {boolean}
 */
function isPushed(head) {
  try {
    return git(['branch', '-r', '--contains', head]).trim() !== '';
  } catch {
    return false;
  }
}

/**
 * Every pull request this repository has, or an exit if `gh` cannot say.
 *
 * One call for all of them rather than one per branch: the state of a branch's pull
 * request is the only thing here that cannot be read off the disk, and a sweep that
 * half-knows is a sweep that must not delete anything.
 *
 * @returns {PullRequest[]}
 */
export function pullRequests() {
  try {
    const json = execFileSync(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        '500',
        '--json',
        'number,state,headRefName,headRefOid',
      ],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(json);
  } catch (cause) {
    console.error(
      'Could not ask GitHub which pull requests are merged, so nothing is safe to remove:\n' +
        `  ${cause instanceof Error ? cause.message : String(cause)}\n\n` +
        'The commit graph is not an alternative — this repository squash-merges, so every\n' +
        'merged branch reads as unmerged. Authenticate `gh` and run this again.',
    );
    process.exit(2);
  }
}

/** How much `path` is holding, in megabytes, best effort. */
/** @type {(path: string) => number} */
function megabytes(path) {
  try {
    return Number.parseInt(
      execFileSync('du', ['-sm', path], { encoding: 'utf8' }).split('\t')[0],
      10,
    );
  } catch {
    return 0;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const remove = process.argv.includes('--remove');
  const pulls = pullRequests();
  const judged = worktrees().map((worktree) => ({ worktree, ...verdict(worktree, pulls) }));

  let reclaimed = 0;
  for (const { worktree, action, why } of judged) {
    const name = worktree.path.replace(`${ROOT}`, '') || '.';
    if (action === 'keep') {
      console.log(`  keep    ${name}\n          ${why}`);
      continue;
    }
    if (action === 'review') {
      console.log(
        `  REVIEW  ${name}  (${megabytes(worktree.path)} MB)\n          ${why}\n` +
          `          git -C ${worktree.path} log --oneline origin/main..HEAD`,
      );
      continue;
    }

    const size = megabytes(worktree.path);
    reclaimed += size;
    if (!remove) {
      console.log(`  WOULD REMOVE  ${name}  (${size} MB)\n          ${why}`);
      continue;
    }
    try {
      // No `--force`: git re-checks the working tree itself, so a verdict this script got
      // wrong about cleanliness is refused by the thing that actually knows.
      git(['worktree', 'remove', worktree.path]);
      console.log(`  removed ${name}  (${size} MB)\n          ${why}`);
    } catch (cause) {
      reclaimed -= size;
      console.log(
        `  kept    ${name}\n          git refused to remove it: ` +
          `${cause instanceof Error ? cause.message.split('\n')[0] : String(cause)}`,
      );
    }
  }

  if (remove) git(['worktree', 'prune']);

  const removable = judged.filter((entry) => entry.action === 'remove').length;
  const review = judged.filter((entry) => entry.action === 'review').length;
  console.log(
    `\n${judged.length} worktree(s); ${removable} whose pull request is merged and whose ` +
      `tree is clean, holding ${reclaimed} MB` +
      `${review > 0 ? `; ${review} needing the one-line check above` : ''}.`,
  );
  if (!remove && removable > 0) {
    console.log(
      'Nothing was removed. Run `npm run worktrees:sweep -- --remove` to reclaim them.',
    );
  }
}

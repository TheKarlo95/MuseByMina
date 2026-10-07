---
description: Pick up Linear tickets in To Do, implement them test-first in isolated worktrees, and open PRs
---

Work the Linear board. Arguments (optional): a specific ticket id like `MUSE-6`, otherwise
drain **both** queues.

$ARGUMENTS

## 1. Read the board — BOTH queues

Use the Linear MCP. Team is `MuseByMina`.

- No argument → `list_issues` for **`To Do`** (the team may name it `Todo`; accept either)
  **and** for **`QA Ready`**. Both. Every run.
- An argument → `get_issue` for that id, whatever state it is in.

To Do is work to build (§2–§7). QA Ready is work to verify (§8). A run that handles one and
silently ignores the other is the bug this instruction exists to prevent: there is no daemon
here, so a queue nobody reads is a queue that never moves. Tickets sat in QA Ready for a
whole session because this command only ever looked at To Do.

Report both queues up front, even when one is empty, so it is visible that both were checked.
If both are empty, say so and stop. Do not invent work.

**Read the ticket properly before starting.** If the acceptance criteria are vague,
contradictory, or would need a decision you cannot make from the repo, move the ticket to
**Blocked**, comment on it saying exactly what you need, and move on to the next one. A vague
ticket is a bug in the ticket — do not paper over it by guessing.

## 2. One worktree per ticket

Tickets are independent, so run them in parallel — but **never in the same working tree**.
Spawn one subagent per ticket with `isolation: "worktree"`. Two agents sharing a tree will
corrupt each other's work.

Use Linear's own branch name (`gitBranchName` on the issue, e.g.
`feature/muse-6-build-schedule-weekly-class-grid`) so Linear links the PR back to the ticket
automatically.

Move the ticket to **In Progress** when its agent starts.

## 3. Implement test-first

Each subagent follows the same loop:

1. Write a failing test that encodes the **acceptance criterion**, not the implementation.
2. Watch it fail for the right reason.
3. Make it pass with the smallest change that does so.
4. Repeat per criterion.

This is where the whole pipeline is weakest: a suite that tests whatever was written is
green and worthless. The test must come from the ticket's Given/When/Then, not from the code.

Read `CLAUDE.md` for project conventions and honour them. In particular:

- `../MuseByMina2/docs/design-system/muse-design-system.md` is authoritative for anything visual.
- Components reference a role token, never a brand colour. `npm run ds` enforces it.
- Default to static; add a `<script>` only where behaviour genuinely needs one.
- Pages are thin wrappers; shared components take a `locale` prop.
- Every user-facing string needs both HR and EN.

## 4. Gate before opening the PR

All four must pass locally first. Do not open a PR on red.

```bash
npm run typecheck
npm run ds
npm run build
npm run a11y        # needs a server: npm run dev &
```

## 5. Open the PR

```bash
gh pr create --fill --head <branch>
```

The PR body must state what changed, why, which acceptance criteria it satisfies, and
anything deliberately left out. Link the ticket. Then move it to **Code Review**.

`main` is protected: squash-only, linear history, all three CI checks required, and admin
bypass is off. **Never try to push to main directly** — it will be rejected, correctly.

## 6. Review

Spawn reviewers in parallel, each with one lens. Give one of them the single job of asking
**"do these tests test the requirement, or the implementation?"** — that is the failure no
status check can catch.

Post findings as PR comments. Apply the fixes that are right; push back in the thread on the
ones that are not, with reasoning. Do not silently accept a wrong review.

## 7. Hand over

Report, per ticket: what it does, the PR link, what CI says, what the reviewers raised, and
anything you are unsure about. Then stop.

**A human merges.** Agents do not merge, and do not try to approve — Anthropic blocks
self-approval by design, and the merge decision is deliberately yours.

## 8. The QA Ready queue

On merge the ticket lands in **QA Ready** and waits. QA Ready is a queue, not a status: it
means "deployed and nobody has verified it yet". Drain it on every run, alongside To Do.

**Never QA your own work inline.** Spawn a fresh subagent per ticket, with no knowledge of
how the thing was built. Whoever implemented a change is the worst person to check it — they
verify what they intended rather than what shipped, and they already believe it works. That
separation is the entire point of the stage.

Give each QA subagent the ticket id and the deployed URL, and nothing else. Specifically:

1. Move the ticket to **QA Testing** before dispatching.
2. It reads the acceptance criteria **from Linear itself**, never a second-hand summary, and
   never the PR description — checking against the PR is checking the work against its own
   author's account of itself.
3. It verifies **against the deployed site**, not a local build. The artefact a visitor
   receives is the only one that counts, and a green CI run is not QA.
4. It writes its own throwaway probe rather than running the repo's suite or `scripts/*.mjs`
   — those encode the implementer's assumptions, including any blind spot being checked for.
5. It looks for **collateral damage outside the ticket's scope**. Several live defects on
   this project surfaced exactly that way, while checking something unrelated.
6. It reports a verdict per criterion with the command and output behind each, and does not
   change ticket state itself.

Then you move it: all criteria pass → **QA Approved** → **Done**. Anything failed → back to
**Todo** with a comment naming what broke. Pre-existing problems become their own ticket
rather than blocking this one — and say which is which.

A criterion that cannot be checked yet (a missing credential, an unset variable) is
**blocked**, not passed. Name it, and name what would settle it.

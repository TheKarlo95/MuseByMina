---
description: Pick up Linear tickets in To Do, implement them test-first in isolated worktrees, and open PRs
---

Work the Linear board. Arguments (optional): a specific ticket id like `MUSE-6`, otherwise
take everything currently in **To Do**.

$ARGUMENTS

## 1. Read the board

Use the Linear MCP. Team is `MuseByMina`.

- No argument → `list_issues` with `state: "To Do"` (the team may name it `Todo`; accept either).
- An argument → `get_issue` for that id, whatever state it is in.

If nothing is in To Do, say so and stop. Do not invent work.

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

After a merge, QA runs against the live site and the ticket moves QA Testing → QA Approved →
Done.

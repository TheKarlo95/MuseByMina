import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * **`CLAUDE.md` is auto-loaded into every agent's context, so its size is a recurring
 * cost multiplied by the fan-out** (MUSE-115). It reached **41,000 tokens / 1,871 lines**
 * before anybody measured it: a QA batch of five agents spent 1,123,565 tokens, and
 * ~205,000 of that was five copies of one file, most of it prose the agent had no use
 * for. The agent verifying a dev-server helper read the pricing rate card.
 *
 * The split is the fix and this file is what keeps it: the rules live in `CLAUDE.md`, the
 * arguments in `docs/decisions/`. Nothing stops the file growing back — it grew the first
 * time one well-argued paragraph at a time, every one of them worth writing — so the
 * ceiling below is a **ratchet, not a safety line**, in the shape `scripts/budget.mjs`
 * uses: a number with the measurement that set it, so raising it is a decision somebody
 * writes down rather than a diff nobody notices.
 *
 * **What belongs in `CLAUDE.md`:** the imperative, in one to three lines, plus the
 * document that argues it. A rule that exists to stop a *reflex* stays there in full —
 * `test/format.test.ts`'s "is written down where the next agent reads it" is the worked
 * example, and that test is the reason the split is rules-stay / arguments-move rather
 * than a word count.
 *
 * **What belongs in `docs/decisions/`:** the measurements, the approaches that were tried
 * and failed, and the history. An agent is pointed at the one or two documents its ticket
 * touches.
 */
describe('the instruction file an agent cannot skip (MUSE-115)', () => {
  const DECISIONS = 'docs/decisions';
  const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');

  /**
   * Measured 2026-10-16, immediately after the split: **371 lines, 26,230 characters.**
   * The ceiling is characters rather than lines because characters are what context costs
   * — a rule rewrapped onto one long line is not cheaper — and it leaves room for roughly
   * twenty more rules at three lines each. If a change needs more than that, it is an
   * argument, and an argument has somewhere else to go.
   */
  const CEILING = 32_000;

  it('states the rules and nothing longer, so the per-agent tax stays paid once', () => {
    expect(claude.length).toBeLessThanOrEqual(CEILING);

    // The floor is the half that finds things: a file emptied into `docs/decisions/`
    // would pass a ceiling alone, and an agent would then arrive with no rules at all.
    // MUSE-35's font count is the precedent — a ceiling reads zero as the leanest page
    // it has ever seen.
    expect(claude.length).toBeGreaterThan(15_000);
  });

  it('points only at documents that exist, in both directions', () => {
    const present = readdirSync(join(ROOT, DECISIONS))
      .filter((f) => f.endsWith('.md'))
      .sort();

    // Two citation forms, both live in `CLAUDE.md`: the table at the top gives full
    // paths, and each rule ends with an arrow and a bare filename.
    const cited = new Set<string>();
    for (const m of claude.matchAll(/docs\/decisions\/([a-z-]+\.md)/g)) cited.add(m[1]);
    for (const m of claude.matchAll(/→ `([a-z-]+\.md)`/g)) cited.add(m[1]);

    // A pointer to a document that is not there is MUSE-80's defect — a citation the
    // next author trusts rather than opening the file — and MUSE-111 is the open
    // instance of it. An *orphaned* document is the other direction and is just as bad:
    // an argument nobody is sent to is an argument nobody reads.
    expect([...cited].sort()).toEqual(present);
  });

  it('gives every document an argument to make, rather than a heading', () => {
    for (const file of readdirSync(join(ROOT, DECISIONS)).filter((f) => f.endsWith('.md'))) {
      const body = readFileSync(join(ROOT, DECISIONS, file), 'utf8');

      // Each document opens by saying it is the argument and not the rule, so somebody
      // who lands in one from a grep knows which half they are reading.
      expect(body).toContain('This file is the argument, not the rule');

      // And it has to carry real content. The split moved 1,808 lines; the smallest
      // document took 211. A document that shrank to its preamble means its bullets went
      // somewhere unrecorded, which the line-loss check at migration time would not
      // catch on a later edit.
      expect(body.length).toBeGreaterThan(5_000);
    }
  });
});

/**
 * **MUSE-91 — a documented claim that the suite is clean, and a retry written down only in
 * the file that performs it.**
 *
 * Both halves were found by QA of MUSE-70, which is the ticket that fixed the middle-click
 * flake. Two surfaces said that one *was the last flake in the suite*; eight consecutive
 * full runs afterwards found no middle-click failure and one unexplained
 * `test/trialform.test.ts` failure, so the claim was false while every rule citing it was
 * green. And `middleClickOpens`'s retry — the considered exception to *"a browser suite
 * waits for a condition, never for the clock"* — existed nowhere an agent reads, which is
 * how an exception becomes a precedent.
 *
 * So this is a guard on the *prose*, deliberately: the thing that went wrong was a
 * sentence, and the measurements behind it live in `test/helpers/concurrency.ts`.
 */
describe('what the rules claim about the suite flaking (MUSE-91)', () => {
  const claude = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8');
  const read = (file: string) => readFileSync(join(ROOT, file), 'utf8');

  /** Everything an agent is pointed at, plus the two modules that carried the claim. */
  const SURFACES = [
    'CLAUDE.md',
    ...readdirSync(join(ROOT, 'docs/decisions'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => `docs/decisions/${f}`),
    'test/helpers/browser-settle.ts',
    'test/helpers/concurrency.ts',
    'test/localeswitch.test.ts',
  ];

  it('says on no surface that the last flake is gone', () => {
    // Claim-shaped forms only. „It was **not** the last flake" is the correction and has
    // to pass, so the pattern matches the assertion and not the word — a guard that fired
    // on the retraction would be turned off rather than obeyed.
    const claimed = /(?:was|is|were) the last flake|no remaining flake|the suite has no flake/;
    for (const file of SURFACES) {
      expect(read(file), `${file} claims the suite has no flake left`).not.toMatch(claimed);
    }
  });

  it('records the failure that is not the middle-click, with what is not known about it', () => {
    // The flake table is where the next author will look, so the observation lives beside
    // it rather than in a ticket. What is *not* known is the load-bearing half: a
    // mechanism nobody measured, written as though it were measured, is MUSE-80's defect.
    const census = read('test/helpers/concurrency.ts');
    expect(census).toContain('MUSE-91');
    expect(census).toContain('test/trialform.test.ts');
    expect(census).toMatch(/not bisected/);
    expect(census).toMatch(/inventing the mechanism/);
  });

  it('writes the retry, its budget and its worst case beside the rule it bends', () => {
    const suite = read('test/localeswitch.test.ts');
    const attempts = /const TAB_ATTEMPTS = ([\d_]+);/.exec(suite)?.[1] ?? '';
    const budget = /const TAB_BUDGET = ([\d_]+);/.exec(suite)?.[1] ?? '';
    expect([attempts, budget]).not.toContain('');

    // Derived from the constants, so raising either one in the test file fails here until
    // the rule an agent actually reads is raised with it. That is the whole defect: the
    // 36-second worst case was half of MUSE-70's pull request title and was written down
    // in one file, the one nobody reads before changing it.
    const worst =
      (Number(attempts.replace(/_/g, '')) * Number(budget.replace(/_/g, ''))) / 1000;
    const rule = /never for the clock[\s\S]*?→ `testing\.md`/.exec(claude)?.[0] ?? '';
    expect(rule).toContain(`TAB_ATTEMPTS = ${attempts}`);
    expect(rule).toContain(`TAB_BUDGET = ${budget}`);
    expect(rule).toContain(`${worst} s`);
    // And it is stated as an exception. A retry recorded without that word reads as
    // permission for the next one.
    expect(rule).toMatch(/exception/);
  });
});

/**
 * **MUSE-114 — a pointer that names the ticket which is open is a claim about status, and
 * status is the one thing a document cannot keep true.**
 *
 * All five documents ended their preamble with „that is a ticket (MUSE-114 is the open
 * instance)". It was right the day it was written and wrong the day that ticket closed —
 * the defect these documents exist to argue against, inside the sentence that argues it.
 * Naming a successor moves the staleness to the next close rather than removing it, so the
 * preambles name no ticket at all and say instead what is durably true: a statement the
 * code does not support is filed and corrected rather than trimmed.
 *
 * Keyed on the **shape** rather than on the five lines that were fixed — a `MUSE-…` beside
 * „open", „current" or „outstanding" *instance*, in either order, within one sentence. Not
 * „live instance" or „the next instance": both are live prose in `content-model.md` and
 * mean an occurrence of a defect, which is what these documents are made of.
 *
 * A ticket reference anywhere else in them is **provenance**, which is the opposite of a
 * status claim: it says where a passage came from and stays true forever. So the second
 * test is a floor — a guard that could be satisfied by deleting every reference would
 * eventually be satisfied that way, which is MUSE-35's lesson about a ceiling with no
 * floor, one document down.
 */
describe('a decision document names no ticket as the open instance (MUSE-114)', () => {
  const DECISIONS = 'docs/decisions';
  const files = readdirSync(join(ROOT, DECISIONS))
    .filter((f) => f.endsWith('.md'))
    .sort();

  /**
   * Whitespace is collapsed before matching, because these documents are hand-wrapped and
   * the two halves of the claim can land on different lines; `[^.]` then keeps the window
   * inside one sentence, so a reference in the next sentence is not read as part of this
   * one.
   */
  const STATUS =
    /MUSE-\d+[^.]{0,80}?(?:open|current|outstanding)\s+instance|(?:open|current|outstanding)\s+instance[^.]{0,80}?MUSE-\d+/i;

  it.each(files)('%s names no ticket as the open instance of anything', (file) => {
    const flat = readFileSync(join(ROOT, DECISIONS, file), 'utf8').replace(/\s+/g, ' ');
    const claim = STATUS.exec(flat)?.[0];
    expect(claim, `${file} names a ticket as the open instance of something`).toBe(
      undefined,
    );
  });

  it.each(files)('%s still cites the tickets its passages came from', (file) => {
    // Measured 2026-10-16: 23, 32, 77, 77 and 83 references across the five. The floor is
    // ten, which no document is near and a stripped one would fail.
    const body = readFileSync(join(ROOT, DECISIONS, file), 'utf8');
    expect(body.match(/MUSE-\d+/g)?.length ?? 0).toBeGreaterThan(10);
  });
});

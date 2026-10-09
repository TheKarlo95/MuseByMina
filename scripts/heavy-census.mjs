/**
 * The run's concurrency meter: one line per heavyweight operation, as it happens.
 *
 * **Why this is measured rather than counted in the source** (MUSE-68). The obvious
 * guard is a scan of `test/` for calls to `buildSite`/`astroDev`, and it undercounts by
 * about a fifth in a direction nobody would notice, because the heavyweight helpers wrap
 * each other: `startPreview` calls `buildPreview`, which calls `astroBuild`. A rule
 * stated against a callee — which is the only kind of rule `test/helpers/source-guard.ts`
 * is allowed to state, and rightly (MUSE-34) — sees `startPreview` and reports nothing.
 * Measured against the real run, `test/trialform.test.ts` performs three heavyweight
 * operations and names none of them. A loop would be invisible the same way.
 *
 * So the two places that actually start heavyweight work write a line each, and the
 * budget is judged on what the run did:
 *
 *   - `test/helpers/scratch.ts` — the single place an `astro build` or an `astro dev`
 *     child is spawned, which `test/isolation.test.ts` enforces;
 *   - `scripts/browser-checks.mjs` — the single place Playwright is launched, which
 *     `test/browserlocale.test.ts` enforces.
 *
 * **It lives in `scripts/` as `.mjs` for the reason `scripts/dist-origin.mjs` does.** A
 * `.mjs` module cannot import a `.ts` helper, and `browser-checks.mjs` is one of the two
 * writers, so a TypeScript home here would mean two spellings of one file format drifting
 * apart — the failure CLAUDE.md records against the GitHub Pages resolver. `test/helpers/
 * concurrency.ts` re-exports this and owns the budget; nothing here knows what a budget is.
 *
 * **Off unless a run turns it on.** The sink is named by an environment variable that
 * `test/helpers/concurrency.ts` sets as a `globalSetup`, so `npm run a11y`, `npm run
 * shots` and a developer's own `astro build` write nothing and need to know nothing.
 */

import { appendFileSync, readFileSync } from 'node:fs';

/**
 * The variable naming this run's census file.
 *
 * Per **run**, not per checkout: two vitest runs in one worktree is a case this repo
 * already protects (MUSE-34's pruning-by-age), and a shared sink would count one run's
 * builds against the other's budget — a guard that invents its own flake.
 */
export const CENSUS_ENV = 'MUSE_HEAVY_CENSUS';

/**
 * What the meter weighs, and the admission that it weighs them equally.
 *
 * An `astro build` is ten-odd seconds of multi-core CPU; a browser is a process that
 * holds cores for as long as the file that opened it runs; an `astro dev` is both. They
 * are not equal, and nothing measured here could tell you the ratio — so the meter counts
 * operations rather than pretending to cost them, and the budget is calibrated against a
 * run whose mix is the mix below. A ticket that changes the *mix* sharply rather than the
 * count is outside what this number can see, and should say so.
 */
export const HEAVY_KINDS = ['build', 'dev', 'browser'];

/** A file that performed heavyweight work, when the stack could not name one. */
export const UNATTRIBUTED = '<unattributed>';

/**
 * Record one heavyweight operation against the test file that asked for it.
 *
 * The owner is read off the stack rather than from vitest's state, because one of the two
 * writers is a `.mjs` script that `npm run a11y` also loads, and `expect.getState()` is
 * not available there — nor in the `globalSetup`, which is why `test/helpers/scratch.ts`
 * already reads its directory-name hint the same way. A frame naming no `.test.ts` is
 * recorded as `UNATTRIBUTED` and fails the budget rather than quietly going uncounted.
 *
 * Never throws. A meter that can break a build it is only watching is worse than no meter.
 *
 * @param {string} kind One of `HEAVY_KINDS`.
 */
export function recordHeavyOperation(kind) {
  const sink = process.env[CENSUS_ENV];
  if (sink === undefined || sink === '') return;
  try {
    appendFileSync(sink, `${kind}\t${owningTestFile()}\n`);
  } catch {
    // The sink is gone, or the disk is full. Neither is this function's business.
  }
}

/** The nearest `*.test.ts` on the stack, or `UNATTRIBUTED`. */
function owningTestFile() {
  const stack = new Error().stack ?? '';
  const match = /([A-Za-z0-9._-]+\.test\.ts)/.exec(stack);
  return match === null ? UNATTRIBUTED : `test/${match[1]}`;
}

/**
 * Read a census file into `{ kind, owner }` records.
 *
 * Blank and malformed lines are dropped: the file is append-only and written from a dozen
 * processes, so a torn final line is a thing that can happen and is not evidence of
 * anything. An unknown `kind` is kept — `judge` reports it, because a writer this module
 * does not know about is exactly the blind spot the whole file exists to close.
 *
 * @param {string} text
 * @returns {{ kind: string, owner: string }[]}
 */
export function parseCensus(text) {
  return text
    .split('\n')
    .map((line) => line.split('\t'))
    .filter((parts) => parts.length === 2 && parts[0] !== '' && parts[1] !== '')
    .map(([kind, owner]) => ({ kind, owner }));
}

/**
 * Read the census at `path`, or `[]` if nothing was written.
 *
 * @param {string} path
 * @returns {{ kind: string, owner: string }[]}
 */
export function readCensus(path) {
  try {
    return parseCensus(readFileSync(path, 'utf8'));
  } catch {
    return [];
  }
}

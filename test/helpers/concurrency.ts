/**
 * **What the run asks of one machine, measured — and a ratchet so it cannot grow quietly.**
 *
 * MUSE-68. `test/isolation.test.ts` says a suite may not *name* a build directory, delete
 * anything, or spawn its own build. All three are right and all three are silent about
 * **how many** builds the run performs — so MUSE-67 gave a new `describe` a build of its
 * own, and `test/localeswitch.test.ts` went red on a `page.waitForEvent` timeout two files
 * away. That is the worst failure shape this board has: the thing reporting is not the
 * thing at fault, it degrades rather than breaks, and a re-run usually passes.
 *
 * **Read `BUDGET` before trusting this file's number for anything.** The measurement says
 * the flake is load-sensitive with no threshold — it is present at the total this tree
 * already performs — so what is enforced here is a *ratchet*, not a safety line, and
 * saying which is which is most of the point.
 *
 * ## What the budget is over, and why it is not builds
 *
 * **Total heavyweight operations — every `astro build`, every `astro dev` and every
 * browser launch — not builds alone.** The run contends for cores, and all three take
 * them. A suite that opened six browsers would be competing for exactly the resource
 * `localeswitch` ran out of, and a guard that counted only builds would miss it *while
 * reading as though it covered the problem*. That is this board's signature defect and it
 * is not worth committing inside the guard meant to prevent it.
 *
 * The meter weighs the three equally, which is a simplification stated out loud in
 * `scripts/heavy-census.mjs`: nothing measured here could support a ratio between them.
 * The recorded total is a total of a run whose *mix* is the mix in `DECLARED`.
 *
 * ## What it is not over
 *
 * Not **peak** concurrency. A file's heavyweight operations run serially inside it, so the
 * run's peak is the pool size whatever any one file does — MUSE-67's extra build did not
 * raise it, and a guard on peak would have passed. What the extra build lengthened was the
 * window in which every core was busy, and that window is what a browser's waits are
 * measured against.
 *
 * ## Why it is measured and not counted in the source
 *
 * Because a source scan is wrong by about a fifth, silently. See the header of
 * `scripts/heavy-census.mjs`: the heavyweight helpers wrap each other, so a rule stated
 * against a callee — the only kind `test/helpers/source-guard.ts` may state (MUSE-34) —
 * sees `startPreview` and reports nothing, and `test/trialform.test.ts`'s three operations
 * go uncounted. A total that is wrong by a fifth is worse than no total at all, because
 * the next ticket reasons from it.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CENSUS_ENV,
  HEAVY_KINDS,
  readCensus,
  UNATTRIBUTED,
} from '../../scripts/heavy-census.mjs';

import { SCRATCH } from './scratch';

export { CENSUS_ENV, HEAVY_KINDS, recordHeavyOperation } from '../../scripts/heavy-census.mjs';

/**
 * **The recorded total, and a ratchet on it. Not a safety line — read this.**
 *
 * `82` is what this tree performs, measured — 70 `astro build`s, 4 `astro dev` servers
 * and 8 browser launches across 31 of the 36 files. It is **not** the point below which
 * the suite is safe, and the number must never be described as though it were, because
 * the measurement says there is no such point:
 *
 * | total | pool | runs | failed | measured by |
 * |---|---|---|---|---|
 * | **78** — the tree before MUSE-69 | 15 | 6 | 1 | MUSE-68, idle box |
 * | **78** | 15 | 3 | 1 | MUSE-68, box shared with another agent's suite |
 * | **78** | 10 | 3 | 1 | MUSE-68, idle box |
 * | **78** | 15 | 3 | 1 | MUSE-69, independently, on `main` |
 * | **79** — one extra `buildSite` in `test/lockup.test.ts` | 15 | 4 | 2 | MUSE-68 |
 * | **79** — MUSE-67's first cut | ~15 | 4 | 3 | MUSE-67 |
 * | **80** — `test/share.test.ts`, now merged | 15 | 4 | 1 | MUSE-69, its branch |
 * | **80** — this tree, rebased | 15 | 5 | 1 | MUSE-68, idle box |
 * | **81** — `test/events.test.ts` | 15 | **5** | **0** | MUSE-24, idle box, after MUSE-70 |
 * | **82** — `test/blog.test.ts`   | 15 | **6** | **0** | MUSE-26, idle box, after MUSE-70 |
 *
 * Every failure in that table is the same test and the same error: `test/localeswitch.
 * test.ts`'s middle-click, `page.waitForEvent: Timeout 20000ms exceeded while waiting for
 * event "framenavigated"`, reported by `settleNewTab` as *"it is still at about:blank"*.
 * So three things are true at once and all three matter:
 *
 *   - **It is not a resource timeout, and the twenty seconds were never the problem** —
 *     corrected by MUSE-70, which fixed it. The event had already been lost: for a tab
 *     Chromium opens and Playwright adopts afterwards, `page.url()` can stay
 *     `about:blank` for the tab's whole life while the document sits loaded underneath,
 *     so that wait could not have succeeded at any budget. The *rate* is still load
 *     sensitive, which is why this table reads the way it does and why the ratchet below
 *     is still worth having. MUSE-61's fix also holds — `settleMove` is untouched; see
 *     `settleNewTab` in `test/helpers/browser-settle.ts` for the measurement.
 *   - **Adding work makes it worse**, and that is the ticket: 4 of 15 at 78 against 5 of 8
 *     at 79, in two independent measurements by two agents.
 *   - **There is no threshold at 78, 79, 80 or anywhere**, and that is why this is not a
 *     capacity line. 78 fails about one run in four and so does 80 — including on this
 *     branch, with the guard green and the total exactly as recorded. So a ceiling pinned at the tree's own total is a **ratchet**
 *     and nothing more: it makes growth deliberate, attributed and recorded. It does not
 *     make the suite reliable. The residual flake was a separate defect and MUSE-70 fixed
 *     it in `settleNewTab` — **not by raising that 20 s**, which is where this note used to
 *     point and would not have worked.
 *
 * So **the headroom is zero by construction**, and that is not a near-miss: it means every
 * change to the run's heavyweight total goes through `DECLARED` with a reason. A ticket
 * that needs an operation frees one — `test/content.test.ts`'s ten are the obvious place
 * to look — or raises this with a measurement beside it. A margin nobody measured is spent
 * by the next ticket, and the ticket after that inherits the flake.
 *
 * MUSE-69 is the worked example and it happened while this was being written: its
 * `test/share.test.ts` landed two builds on `main`, the run went to 80, and the guard
 * exited 1 on 34 green files naming `test/share.test.ts` as undeclared. The entry below
 * and this number were then both moved **with the measurement that justifies them**, which
 * is the whole of the process this file is asking for.
 *
 * **MUSE-24 is the second, and it is the first row of that table taken after MUSE-70.**
 * `/events` needs one build whose dataset holds an event — `getStaticPaths`, the URL
 * through the host model and the emitted stylesheet are the three things Astro's container
 * API structurally cannot see, and no build in the tree has ever had an event in it. The
 * rest of that suite's sixty-one tests are container renders and cost nothing, which is
 * why the entry is 1 and not 3. Measured at 81: **5 runs, 0 failures**, on an idle box at a
 * pool of 15.
 *
 * Read that `0` carefully, because it is the one number in this table that is *not*
 * evidence about the flake. Every failure above is `test/localeswitch.test.ts`'s
 * middle-click, and **MUSE-70 fixed it** — the wait was on an event that had already been
 * lost, so it could not have succeeded at any budget. Five clean runs at 81 therefore say
 * „the defect MUSE-70 fixed is still fixed", not „there is headroom above 80". The ratchet
 * stays, and it stays for the reason it was built: the load sensitivity it was measured
 * against was real, nothing has disproved it, and the next author to need an operation
 * should have to say so here.
 *
 * **MUSE-26 is the third, and it landed on top of MUSE-24 rather than instead of it.**
 * `/blog` needs one build whose dataset holds posts: `getStaticPaths` over a dynamic
 * route, the URL through the host model, the emitted stylesheet for the prose rules, the
 * sitemap's `xhtml:link` groups and the `<head>`'s `hreflang` cluster are the five things
 * Astro's container API structurally cannot see, and no build in the tree has ever had a
 * post in it. It could not borrow `test/events.test.ts`'s build either — the two fixtures
 * hold different document types. The rest of that suite is container renders and pure
 * functions, which is why the entry is 1 and not 3. Measured at **82**: 6 runs, 0
 * failures, on an idle box at a pool of 15.
 *
 * Read that `0` the way MUSE-24's row has to be read — it says „the defect MUSE-70 fixed
 * is still fixed", not „there is headroom". **Two tickets have now each taken one, which
 * is the pattern to watch**: a page type whose content is unbounded needs a build with
 * that content in it, and the next one will too. If a third arrives, the question to ask
 * first is whether the three can share one build against a dataset holding all three
 * document types — not whether 83 is fine.
 *
 * ## Why the worker count is not the divisor
 *
 * MUSE-68 asked for this number to be derived from the worker count, from the model *"ten
 * builds, ten workers, an eleventh is one too many"*. The run performs **68 builds, 4 dev
 * servers and 8 browser launches** across a pool of `availableParallelism() - 1` —
 * **fifteen** here and **three** on `ubuntu-latest`. So the model is wrong about both
 * numbers, and dividing by the pool would make the same tree pass on a laptop and fail on
 * a runner, which is a guard pointing backwards.
 *
 * Changing the pool does not help either, which was measured rather than assumed: pinned
 * to ten on this box the suite ran 95/92/96 s against 96/101/98/99 s at fifteen — neutral
 * — and still failed 1 of 3, with the same error. (An earlier reading of 164 s for the
 * pinned pool was a box shared with another agent's suite, and is retracted.) The pool
 * size is stated in `vitest.config.ts` so it has one home and the reporter can print it
 * beside this total; it is not in the arithmetic.
 */
export const BUDGET = 82;

/**
 * Every test file that performs heavyweight work, and how much.
 *
 * A pinned expectation, in the shape this repository already uses for `READ_CONTRACT`,
 * `Guaranteed` and `PUBLISHED_BEFORE_THE_MIGRATION`: the *total* is what the budget caps,
 * but a total alone can only name the file that happened to be counted last. This table is
 * what lets the failure name the file that actually changed.
 *
 * **Adding a build is therefore a one-line edit here, on purpose.** The cost of a new
 * heavyweight operation belongs in front of the author who is adding it — which is exactly
 * the lesson MUSE-67 wrote beside its own `beforeAll` and the reason this ticket exists.
 * Check the headroom in the same breath.
 *
 * The numbers are measured, not counted: `npm test` prints the census and the headroom on
 * every run.
 */
export const DECLARED: ReadonlyMap<string, { ops: number; why: string }> = new Map([
  [
    'test/content.test.ts',
    {
      ops: 10,
      why: 'the migration freeze: live, edited, draft, and six builds that must fail',
    },
  ],
  [
    'test/aboutus.test.ts',
    { ops: 5, why: 'both targets, an edited dataset, and two missing-document failures' },
  ],
  [
    'test/devcontent.test.ts',
    { ops: 5, why: 'two builds and three dev servers — the only suite that needs both' },
  ],
  [
    'test/origin.test.ts',
    { ops: 5, why: 'the origin verifier compares a build against a second, foreign one' },
  ],
  [
    'test/whatisbachata.test.ts',
    { ops: 5, why: 'the page, an edited dataset, and three content failures' },
  ],
  ['test/budget.test.ts', { ops: 3, why: 'both targets, and a browser to measure them in' }],
  [
    'test/fonts.test.ts',
    { ops: 4, why: 'dev, both built targets, and a browser to measure them in' },
  ],
  [
    'test/isolation.test.ts',
    {
      ops: 3,
      why: 'two isolated builds and the one that must refuse to stage outside the root',
    },
  ],
  [
    'test/pricing.test.ts',
    { ops: 3, why: 'the published prices, a repriced dataset, and an unseeded failure' },
  ],
  [
    'test/structured-data.test.ts',
    { ops: 3, why: 'both targets, and an edited dataset the block has to follow' },
  ],
  [
    'test/trialform.test.ts',
    { ops: 3, why: 'a preview with the stub endpoint, one without, and a browser' },
  ],
  ['test/assets.test.ts', { ops: 2, why: 'both deploy targets' }],
  [
    'test/share.test.ts',
    {
      ops: 2,
      why:
        'one deploy target twice: the seeded card and an uploaded one (MUSE-69) — the ' +
        'second target is seo.test.ts’s and assets.test.ts’s (MUSE-77)',
    },
  ],
  ['test/browserlocale.test.ts', { ops: 2, why: 'a served preview and a browser' }],
  ['test/cascade.test.ts', { ops: 2, why: 'both deploy targets' }],
  ['test/contact.test.ts', { ops: 2, why: 'a served preview and a browser' }],
  ['test/home.test.ts', { ops: 2, why: 'the page and a paused-schedule dataset' }],
  ['test/icon.test.ts', { ops: 2, why: 'both deploy targets' }],
  ['test/lang.test.ts', { ops: 2, why: 'a served preview and a browser' }],
  [
    'test/localeswitch.test.ts',
    { ops: 2, why: 'a served preview and a browser — the suite this ticket was found by' },
  ],
  ['test/numerals.test.ts', { ops: 2, why: 'a served preview and a browser' }],
  ['test/routes.test.ts', { ops: 2, why: 'the routed site and one with a ghost route' }],
  [
    'test/seo.test.ts',
    { ops: 2, why: 'both deploy targets — the host guarantee is the difference between them' },
  ],
  ['test/urls.test.ts', { ops: 2, why: 'both deploy targets' }],
  ['test/contentdrift.test.ts', { ops: 1, why: 'one build from an edited address' }],
  [
    'test/lockup.test.ts',
    { ops: 1, why: 'one build for the file (MUSE-67 — this is the hoist)' },
  ],
  ['test/nav.test.ts', { ops: 1, why: 'one build' }],
  [
    'test/events.test.ts',
    {
      ops: 1,
      why:
        'one build against a dataset holding events — `getStaticPaths`, the URL through ' +
        'the host model, and the emitted CSS are the three things Astro’s container API ' +
        'structurally cannot see, and no existing build has an event in it (MUSE-24)',
  ],
  [
    'test/blog.test.ts',
    {
      ops: 1,
      why:
        'one build against a dataset holding posts — `getStaticPaths`, the URL through ' +
        'the host model, the emitted prose CSS, the sitemap’s alternates and the ' +
        '`hreflang` cluster are what Astro’s container API structurally cannot see, and ' +
        'no existing build has a post in it (MUSE-26)',
    },
  ],
  ['test/nojs.test.ts', { ops: 1, why: 'one build' }],
  ['test/schedule.test.ts', { ops: 1, why: 'one build' }],
]);

/** What `DECLARED` adds up to. */
export function declaredTotal(): number {
  return [...DECLARED.values()].reduce((sum, { ops }) => sum + ops, 0);
}

/** Heavyweight operations left before the run hits its ceiling. */
export function headroom(): number {
  return BUDGET - declaredTotal();
}

/** One heavyweight operation, as the census recorded it. */
export interface HeavyRecord {
  kind: string;
  owner: string;
}

/** The verdict on one run. */
export interface Verdict {
  /** Problems, each a complete sentence naming a file. Empty means the run is in budget. */
  problems: string[];
  /** One line for the log, whether or not there were problems. */
  summary: string;
}

/**
 * Judge a run against the budget — the whole rule, as a function of its inputs.
 *
 * Separated from the reporter so it can be *tested as a rule*, which is how every other
 * guard in this tree is kept honest: `test/isolation.test.ts` hands it synthetic censuses
 * and reads the verdict, rather than asserting that a reporter is registered.
 *
 * `ran` is the set of test files vitest actually executed, and it is what makes a filtered
 * run safe. `vitest run test/lockup.test.ts` produces a census of one file; without `ran`
 * the only honest readings would be "every other declared file has vanished" or "the total
 * is comfortably under budget", and the second is the one that would have been chosen.
 * With it, a file that ran is held to its declaration, a file that did not is not
 * mentioned, and the total is only compared with the ceiling when the whole suite ran.
 */
export function judge(records: readonly HeavyRecord[], ran: readonly string[]): Verdict {
  const observed = new Map<string, number>();
  for (const { owner } of records) observed.set(owner, (observed.get(owner) ?? 0) + 1);

  const executed = new Set(ran);
  const problems: string[] = [];

  const unattributed = observed.get(UNATTRIBUTED) ?? 0;
  if (unattributed > 0) {
    problems.push(
      `${unattributed} heavyweight operation(s) could not be attributed to a test file. ` +
        `The census is the budget's only evidence, so an operation it cannot place is a ` +
        `hole in it — see owningTestFile() in scripts/heavy-census.mjs.`,
    );
  }

  const unknown = [...new Set(records.map(({ kind }) => kind))].filter(
    (kind) => !HEAVY_KINDS.includes(kind),
  );
  for (const kind of unknown) {
    problems.push(
      `the census holds operations of kind "${kind}", which scripts/heavy-census.mjs ` +
        `does not declare. Add it to HEAVY_KINDS, or stop writing it.`,
    );
  }

  for (const [owner, count] of [...observed].sort(([a], [b]) => a.localeCompare(b))) {
    if (owner === UNATTRIBUTED) continue;
    const declared = DECLARED.get(owner);
    if (declared === undefined) {
      problems.push(
        `${owner} performs ${count} heavyweight operation(s) and is not in DECLARED ` +
          `(test/helpers/concurrency.ts). Add it with a reason. The run has ` +
          `${headroom()} operation(s) of headroom before the budget of ${BUDGET}.`,
      );
    } else if (declared.ops !== count) {
      problems.push(
        `${owner} performs ${count} heavyweight operation(s); DECLARED says ` +
          `${declared.ops} ("${declared.why}"). An astro build, an astro dev or a ` +
          `browser launch was added or removed here — update the entry, and check the ` +
          `headroom: the budget is ${BUDGET} and the declared total is ` +
          `${declaredTotal()}.`,
      );
    }
  }

  for (const [owner, { ops }] of DECLARED) {
    if (executed.has(owner) && !observed.has(owner)) {
      problems.push(
        `${owner} ran and performed no heavyweight work; DECLARED says ${ops}. Either the ` +
          `suite stopped building — in which case delete the entry — or the census stopped ` +
          `being written.`,
      );
    }
  }

  const total = records.length;
  const complete = [...DECLARED.keys()].every((file) => executed.has(file));
  if (complete && total > BUDGET) {
    problems.push(
      `the run performs ${total} heavyweight operations; ${BUDGET} is what the tree is ` +
        `recorded as performing. This is a ratchet rather than a safe ceiling — the ` +
        `middle-click flake it exists for is present at ${BUDGET} too — but adding work ` +
        `measurably worsens it, and the symptom shows up in an unrelated browser file ` +
        `(MUSE-68). Free an operation, or raise this in test/helpers/concurrency.ts with ` +
        `a measurement beside it. Do not raise it quietly.`,
    );
  }

  const scope = complete ? 'whole suite' : `${executed.size} file(s)`;
  const summary =
    `concurrency: ${total} heavyweight operation(s) over ${scope}; budget ${BUDGET}; ` +
    `headroom ${complete ? BUDGET - total : headroom()}`;

  return { problems, summary };
}

/**
 * The census file for this run, or `undefined` outside one.
 *
 * Read from the environment rather than from a module-level variable, and that is
 * load-bearing: `setup()` below is loaded by vitest's own module runner and
 * `test/helpers/concurrency-reporter.ts` by the reporter loader, so the two get separate
 * instances of this module even though they run in the same process. A variable here
 * would be set in one of them and `undefined` in the other, and the budget would be
 * judged on an empty census — green, for ever, for no reason anybody could see.
 */
export function censusPath(): string | undefined {
  const path = process.env[CENSUS_ENV];
  return path === undefined || path === '' ? undefined : path;
}

/** Read this run's census. */
export function thisRunsCensus(): HeavyRecord[] {
  const path = censusPath();
  return path === undefined ? [] : readCensus(path);
}

/**
 * Open the census, as a `globalSetup`.
 *
 * A `globalSetup` runs in the main process before any worker is forked, so setting the
 * variable here is the one point at which it reaches **both** sides of the measurement:
 * the forked workers inherit it, and the reporter — which runs in this process — reads
 * the same path at the end. A reporter hook could not do the first and `test.env` could
 * not do the second.
 *
 * The sink is minted per run with `mkdtemp`, for the reason `claimOutDir` is: two vitest
 * runs in one worktree is a case this repository already protects (MUSE-34), and a sink
 * they shared would count one run's builds against the other's budget — a guard that
 * invents its own flake. It sits under the scratch root, so pruning by age reaches it
 * like everything else there.
 */
export default function setup(): void {
  mkdirSync(SCRATCH, { recursive: true });
  const sink = join(mkdtempSync(join(SCRATCH, 'census-')), 'heavy.tsv');
  writeFileSync(sink, '');
  process.env[CENSUS_ENV] = sink;
}

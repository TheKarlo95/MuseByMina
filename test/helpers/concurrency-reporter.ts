import type { Reporter, TestModule, Vitest } from 'vitest/node';

import { BUDGET, type HeavyRecord, judge, thisRunsCensus } from './concurrency';

/**
 * Say what the run asked of the machine, and fail it when that is too much (MUSE-68).
 *
 * **A reporter rather than a test**, for one reason: no test can see the whole run. The
 * census is written by thirty-three files in ten parallel workers, so a file asserting on
 * it would be reading a partial count — and a partial count under a ceiling is the
 * reassuring answer, which is how this class of guard ends up green and useless. A
 * reporter's `onTestRunEnd` is the first moment the number is complete.
 *
 * **It is also where the headroom gets said out loud.** One line on every run, pass or
 * fail, because the alternative is a number in `CLAUDE.md` that nothing refreshes — which
 * is precisely the state of the "ten real `astro build`s" sentence this ticket replaced.
 *
 * `process.exitCode` is the teeth. A reporter cannot mark a test failed, so an overshoot
 * would otherwise print under a green summary — exactly the misreading
 * `./hook-failure-reporter.ts` exists to correct — and the block below is loud for the
 * same reason that one is.
 */
export default class ConcurrencyBudgetReporter implements Reporter {
  /**
   * Where the records come from, injectable for one reason: so this class can be *tested
   * as a reporter* rather than asserted to be registered.
   *
   * `expect(config).toContain('hook-failure-reporter')` is the guard MUSE-34 took apart —
   * it says a reporter exists and nothing about what it does, and inverting the filter
   * inside that one left it green. `test/isolation.test.ts` hands this a census and reads
   * both things it writes: the block, and `process.exitCode`. Injecting the *source* and
   * not the verdict keeps `judge` in the path, so the test cannot pass a reporter that
   * forgot to call it.
   *
   * **Not a defaulted constructor parameter**, which is the obvious spelling and does not
   * work: vitest hands a custom reporter its own options object, so a default would be
   * overwritten by it and the real run would call `undefined`. It is a key *inside* the
   * options instead, which vitest never sets.
   */
  constructor(private readonly options?: { census?: () => HeavyRecord[] }) {}

  /**
   * The pool size, read from the resolved configuration rather than recomputed.
   *
   * It is not in the budget's arithmetic — `./concurrency.ts` says at length why it must
   * not be — but it is the other half of what a reader needs, and `vitest.config.ts` is
   * the one place it is stated. Recomputing `availableParallelism() - 1` here would be a
   * second copy of vitest's default, which is the defect this ticket is surrounded by.
   */
  private workers?: number;

  onInit(vitest: Vitest): void {
    this.workers = vitest.config.maxWorkers as number | undefined;
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const read = this.options?.census ?? thisRunsCensus;
    const { problems, summary } = judge(
      read(),
      testModules.map((module) => module.relativeModuleId),
    );

    const measured =
      this.workers === undefined ? summary : `${summary}; ${this.workers} workers`;

    if (problems.length === 0) {
      process.stderr.write(`\n  ${measured}\n`);
      return;
    }

    process.exitCode = 1;
    const lines = [
      '',
      `  ⚠  CONCURRENCY — the run's heavyweight work no longer matches the ${BUDGET} recorded:`,
      '',
      ...problems.map((problem) => `     • ${problem}`),
      '',
      `     ${measured}`,
      '',
      '     Every astro build, astro dev and browser in a run competes for the same cores,',
      '     and the symptom of asking for more is not here: it is an unrelated browser',
      '     suite timing out on a wait that is perfectly correct (MUSE-68). The recorded',
      '     total is a ratchet, not a safe ceiling — read the measurement table above',
      '     BUDGET in test/helpers/concurrency.ts before changing either number.',
      '',
    ];
    process.stderr.write(`${lines.join('\n')}\n`);
  }
}

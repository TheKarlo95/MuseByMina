import type { Reporter, TestCase, TestModule } from 'vitest/node';

/**
 * Say out loud when a test file never ran.
 *
 * When a `beforeAll` throws, vitest marks the file failed and every test inside it
 * **skipped** — so the summary reads
 *
 *     Test Files  1 failed | 7 passed (8)
 *          Tests  157 passed | 19 skipped (176)
 *
 * which looks like 19 tests somebody chose to deselect. It is MUSE-17's whole reason for
 * going unnoticed through three incidents: the one line a human reads says "skipped",
 * and the cheap response to a red run — re-run it — is also how a real failure gets
 * waved through.
 *
 * There is no vitest option that counts those tests as failures, so this prints the
 * distinction the summary cannot: which file never ran, and how many assertions were
 * therefore never made. Tests the author wrote as `.skip`/`.todo` are left alone — only
 * tests that were meant to run and did not are reported.
 *
 * **Both halves of that are tested** (MUSE-34). Its only guard used to be
 * `expect(config).toContain('hook-failure-reporter')`, which says a reporter is
 * registered and nothing about what it reports — invert the `mode` filter in `neverRan`
 * and the textual check stayed green while a dead file went unannounced and every
 * deliberate `.skip` was announced as broken. `test/isolation.test.ts` hands this class
 * the four module states that matter and reads what it writes.
 */
export default class HookFailureReporter implements Reporter {
  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const casualties = testModules
      .filter((module) => module.state() === 'failed')
      .map((module) => ({ module, lost: neverRan(module) }))
      .filter(({ lost }) => lost.length > 0);

    if (casualties.length === 0) return;

    const lines = [
      '',
      '  ⚠  FILE(S) THAT NEVER RAN — not "skipped", broken:',
      '',
      ...casualties.map(
        ({ module, lost }) =>
          `     ${module.relativeModuleId} — ${lost.length} test(s) never executed; a hook above them failed.`,
      ),
      '',
      '     The summary above counts these as "skipped". They are not deselected tests:',
      '     the assertions were never made, so nothing in those files has been verified.',
      '',
    ];
    process.stderr.write(`${lines.join('\n')}\n`);
  }
}

/** Tests in `module` that were meant to run and never produced a result. */
function neverRan(module: TestModule): TestCase[] {
  return [...module.children.allTests()].filter((test) => {
    if (test.options.mode !== 'run') return false;
    const state = test.result().state;
    return state !== 'passed' && state !== 'failed';
  });
}

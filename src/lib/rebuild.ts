/**
 * **How often the site rebuilds itself, and the one place that number is written (MUSE-21).**
 *
 * The site is static, so a publish in the Studio changes nothing until a build runs. The
 * decision taken on MUSE-21 was a **scheduled rebuild** rather than a Sanity webhook: the
 * webhook route needs a GitHub token living inside a third party, and avoiding exactly
 * that is why this project orchestrates locally instead of running agents in CI. A studio
 * site that changes a few times a week is not worth buying instant rebuilds with the one
 * property everything else here was arranged to keep.
 *
 * What a schedule cannot do is tell Mina "your change is live now". What it can do — and
 * what the ticket actually asks for — is give her a **ceiling she can rely on without
 * being told anything**. That is this module's real job: the cron expression the deploy
 * runs on and the sentence she reads in the Studio are both derived from the hours below,
 * so the promise cannot drift from the schedule that keeps it. `test/rebuild.test.ts`
 * fails if `.github/workflows/deploy.yml` and `REBUILD_CRON` disagree.
 *
 * Three things about the numbers themselves:
 *
 *   - **Spacing is uniform, and that is not tidiness.** The promise Mina gets is a
 *     duration ("within six hours"), never a clock time, because cron is UTC and does not
 *     shift with daylight saving — a sentence naming 15:20 would be wrong for half the
 *     year, in a way nobody would notice until she did. A duration is true year-round, and
 *     it is only as small as the *largest* gap between runs, so `MAX_WAIT_HOURS` is
 *     computed from the gaps rather than asserted. Bunch the runs into the working day and
 *     the ceiling grows to the overnight gap, which is the honest answer.
 *   - **Four a day, not twenty-four.** Actions minutes are free on a public repository, so
 *     the cost of hourly is not money: it is that twenty-four green no-op runs a day is
 *     the background against which a real failure has to stand out, and every run is a
 *     live Sanity read. Four keeps the run list readable, makes the median wait three
 *     hours, and still lands one run late in the Zagreb evening, which is when the
 *     timetable actually gets edited.
 *   - **:20 past, not :00.** GitHub's own documentation says the `schedule` event is
 *     delayed during its highest-load windows and that those include the start of every
 *     hour, and recommends scheduling away from it.
 */

/** Minutes past the hour, in UTC. See the note above on why this is not zero. */
export const REBUILD_MINUTE_UTC = 20;

/**
 * The UTC hours a rebuild starts, ascending.
 *
 * Zagreb is UTC+1 in winter and UTC+2 in summer, so these land at roughly 02:20, 08:20,
 * 14:20 and 20:20 local time in winter and an hour later in summer. Nothing downstream
 * depends on that drift, because nothing downstream quotes a clock time as a promise.
 */
export const REBUILD_HOURS_UTC = [1, 7, 13, 19] as const;

/**
 * The `schedule:` line in `.github/workflows/deploy.yml`, derived rather than repeated.
 *
 * `test/rebuild.test.ts` parses the workflow and compares. The two have to agree because
 * the Studio quotes this schedule to Mina as a commitment: a cron edited without the copy
 * following it turns her one reliable fact into a wrong one.
 */
export const REBUILD_CRON = `${REBUILD_MINUTE_UTC} ${REBUILD_HOURS_UTC.join(',')} * * *`;

/**
 * The longest anyone can wait between publishing and the change being built.
 *
 * Measured off the real gaps, including the one that wraps midnight, so an uneven schedule
 * reports its worst case instead of its average. This is the number the Studio promises
 * and therefore the number that may not be optimistic.
 */
export const MAX_WAIT_HOURS = Math.max(
  ...REBUILD_HOURS_UTC.map((hour, index, hours) =>
    index === hours.length - 1 ? 24 - hour + hours[0] : hours[index + 1] - hour,
  ),
);

/**
 * The substring `.github/workflows/deploy.yml` greps a failed build's output for before it
 * retries.
 *
 * `npm run build` fetches from Sanity and hard-fails if the API does not answer, which is
 * the right trade — the alternative is publishing pages with empty titles — but it means a
 * transient Sanity blip would page a human about a site that is fine. So the scheduled
 * build retries, and **only** for that one class of failure: a missing document, a GROQ
 * typo or a type error is not going to pass on the third attempt, and retrying it would
 * only delay the red by four minutes.
 *
 * This is the message `runQuery` throws (`src/lib/sanity/client.ts`), so the workflow and
 * the error are coupled — which is why `test/content.test.ts` asserts this pattern against
 * the output of a **real build against an unreachable project**, rather than against the
 * string's presence in either file. Reword that error and the test fails, not the deploy.
 */
export const TRANSIENT_BUILD_FAILURE = 'Sanity did not answer a query';

/**
 * The next instant the site rebuilds, strictly after `now`.
 *
 * Pure, and the reason the Studio can say something better than a paragraph of static
 * copy: the badge computes this in Mina's own browser, so the time it shows her is in her
 * timezone and correct across a daylight-saving change without anything being configured.
 */
export function nextRebuild(now: Date): Date {
  for (const dayOffset of [0, 1]) {
    for (const hour of REBUILD_HOURS_UTC) {
      // `Date.UTC` normalises an overflowing day, so `+ 1` on the 31st is next month.
      const at = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate() + dayOffset,
          hour,
          REBUILD_MINUTE_UTC,
        ),
      );
      if (at.getTime() > now.getTime()) return at;
    }
  }
  // Unreachable while `REBUILD_HOURS_UTC` is non-empty: tomorrow's first run is always
  // ahead of any instant today. Thrown rather than returned so an empty list is a loud
  // failure in CI instead of a Studio that quietly stops answering the question.
  throw new Error(
    'No next rebuild: `REBUILD_HOURS_UTC` is empty, so the site has no rebuild schedule ' +
      'and nothing can be promised about when a publish appears.',
  );
}

/**
 * That instant as a local clock time, for the Studio.
 *
 * `timeZone` is a parameter only so tests can be deterministic; the Studio passes nothing
 * and gets the browser's zone, which is the whole point.
 */
export function formatLocalTime(at: Date, timeZone?: string): string {
  return new Intl.DateTimeFormat('hr-HR', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  }).format(at);
}

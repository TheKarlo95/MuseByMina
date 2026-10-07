import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { rebuildBadgeDescription } from '../sanity/badges';
import {
  MAX_WAIT_HOURS,
  REBUILD_CRON,
  REBUILD_HOURS_UTC,
  REBUILD_MINUTE_UTC,
  TRANSIENT_BUILD_FAILURE,
  formatLocalTime,
  nextRebuild,
} from '../src/lib/rebuild';

/**
 * MUSE-21 — the scheduled rebuild, and the promise the Studio makes about it.
 *
 * Most of this ticket is YAML, which is the hardest kind of thing to test honestly: a test
 * that greps a workflow for the string it was written against asserts that somebody typed
 * something, not that anything works. So this suite deliberately does not do that. It
 * asserts the three things here that are actually properties rather than text:
 *
 *   1. **The schedule in the workflow and the schedule the code believes in are the same
 *      schedule** — checked by implementing "when does this cron next fire" a second time,
 *      independently, from the cron string parsed out of `deploy.yml`, and comparing it to
 *      `nextRebuild` over a year of instants. String equality is asserted too, but the
 *      year of samples is what would catch `nextRebuild` being wrong about a cron it
 *      agrees with.
 *   2. **The ceiling the Studio promises Mina is true, and tight.** `MAX_WAIT_HOURS` is
 *      derived from the gaps rather than written down, and the sampling below is what makes
 *      "within six hours" a measured statement instead of arithmetic nobody checked.
 *   3. **The badge is daylight-saving-correct**, which is the whole reason it can name a
 *      clock time at all, and the reason the *promise* beside it may not be one.
 *
 * What is not here, because it cannot be: that a cron line actually causes GitHub to start
 * a run. That is verified by triggering one, and the run id is in the pull request.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEPLOY = '.github/workflows/deploy.yml';

const deploy = readFileSync(join(ROOT, DEPLOY), 'utf8');

/** Every `- cron: '…'` in the workflow, in order. */
const crons = [...deploy.matchAll(/^\s*- cron: '(.+)'$/gm)].map(([, cron]) => cron);

/**
 * "When does `M H * * *` next fire, strictly after `now`" — a second implementation.
 *
 * Written from the cron string the workflow really contains, so it shares nothing with
 * `src/lib/rebuild.ts` but the answer. Only the shape this project uses is supported; a
 * cron with anything else in it is a failure rather than a silent pass, because an
 * unsupported field would make every comparison below vacuous.
 */
function nextFiring(cron: string, now: Date): Date {
  const [minute, hours, dayOfMonth, month, dayOfWeek] = cron.split(' ');
  expect([dayOfMonth, month, dayOfWeek], `${cron} is not a daily cron`).toEqual([
    '*',
    '*',
    '*',
  ]);
  expect(minute, `${cron} has a minute field this test cannot read`).toMatch(/^\d+$/);
  expect(hours, `${cron} has an hour field this test cannot read`).toMatch(/^\d+(,\d+)*$/);

  const atMinute = Number(minute);
  const atHours = hours.split(',').map(Number);
  // A day either side, so a `now` late on the 31st is answered from the next month.
  for (let day = 0; day <= 1; day += 1) {
    for (const hour of atHours.slice().sort((a, b) => a - b)) {
      const at = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate() + day,
        hour,
        atMinute,
      );
      if (at > now.getTime()) return new Date(at);
    }
  }
  throw new Error(`\`${cron}\` never fires again after ${now.toISOString()}`);
}

/** Instants spread across a year, deliberately not aligned to the hour. */
function* sampleYear(): Generator<Date> {
  const start = Date.UTC(2026, 0, 1, 0, 3);
  const step = 37 * 60 * 1000;
  for (let t = start; t < start + 366 * 24 * 60 * 60 * 1000; t += step) {
    yield new Date(t);
  }
}

describe('the workflow and the code agree about when the site rebuilds', () => {
  it('declares exactly one schedule, and it is the one the code derives', () => {
    /**
     * Not a style check. The Studio tells Mina how long she waits, and that sentence is
     * computed from `REBUILD_HOURS_UTC`; the thing that actually rebuilds the site is this
     * cron. If the two can be edited apart, her one reliable fact becomes a wrong one, and
     * nothing would be red — the site would still deploy, on a schedule nobody described.
     */
    expect(crons).toEqual([REBUILD_CRON]);
  });

  it('answers "when next?" the same way the workflow\'s own cron does, all year', () => {
    // The real check behind the string comparison above: that `nextRebuild` is right about
    // the cron it agrees with. Two independent implementations over ~14,000 instants.
    const cron = crons[0];
    for (const now of sampleYear()) {
      expect(nextRebuild(now).toISOString(), now.toISOString()).toBe(
        nextFiring(cron, now).toISOString(),
      );
    }
  });

  it('keeps the manual trigger, which is how a rebuild is forced without a credential', () => {
    // `workflow_dispatch` is what makes the whole arrangement recoverable: a content fix
    // can be published without waiting for the next slot, and no token exists anywhere.
    // It is not a button for Mina — that would need the credential MUSE-21 declined.
    expect(deploy).toMatch(/^ {2}workflow_dispatch:$/m);
  });
});

describe('the wait the Studio promises is a real ceiling', () => {
  it('never makes anyone wait longer than it says', () => {
    /**
     * The promise is a duration, never a clock time, because cron is UTC and does not
     * shift with daylight saving — a sentence naming 15:20 is wrong for half the year in a
     * way nobody notices until Mina does. A duration is only true if it covers the
     * *largest* gap between runs, including the one over midnight, which is why
     * `MAX_WAIT_HOURS` is computed from the gaps and measured here rather than asserted.
     */
    const ceiling = MAX_WAIT_HOURS * 60 * 60 * 1000;
    let worst = 0;
    for (const now of sampleYear()) {
      const wait = nextRebuild(now).getTime() - now.getTime();
      expect(wait, `${now.toISOString()} waits past the ceiling`).toBeLessThanOrEqual(
        ceiling,
      );
      expect(wait, `${now.toISOString()} is not in the future`).toBeGreaterThan(0);
      worst = Math.max(worst, wait);
    }

    // And the ceiling is tight: a promise of six hours on a schedule whose worst case is
    // three would be safe and useless. Within the sampling step of the real maximum.
    expect(ceiling - worst).toBeLessThan(40 * 60 * 1000);
  });

  it('runs often enough to be worth promising, and not so often that a failure hides', () => {
    // Four a day: the median wait is half the ceiling, the run list stays readable enough
    // that a red one is visible, and one run lands late in the Zagreb evening, which is
    // when the timetable gets edited. Asserted as a range rather than the number, because
    // the number is a judgement and the range is the constraint it has to satisfy.
    expect(REBUILD_HOURS_UTC.length).toBeGreaterThanOrEqual(2);
    expect(REBUILD_HOURS_UTC.length).toBeLessThanOrEqual(8);
    // Away from the top of the hour: GitHub documents the `schedule` event as delayed
    // during its highest-load windows and names the start of every hour as one.
    expect(REBUILD_MINUTE_UTC).toBeGreaterThan(0);
  });
});

describe('what Mina reads beside the Publish button', () => {
  // Winter and summer in Zagreb. The same UTC slot, two different local clock times.
  const ZAGREB = 'Europe/Zagreb';
  const winter = new Date('2026-03-28T12:00:00Z');
  const summer = new Date('2026-06-28T12:00:00Z');

  it('names the next rebuild in the reader\'s own timezone', () => {
    /**
     * This is why the badge can give a clock time at all: it is computed in her browser,
     * so `formatLocalTime` resolves to Europe/Zagreb without anything being configured —
     * and it is right in both halves of the year, which a string baked at build time
     * could not be.
     *
     * Both instants pick the same UTC slot. If the badge were rendering UTC, or a fixed
     * offset, these two would read the same and this test would be the only thing that
     * noticed.
     */
    const inWinter = rebuildBadgeDescription(winter, ZAGREB);
    const inSummer = rebuildBadgeDescription(summer, ZAGREB);

    expect(nextRebuild(winter).toISOString()).toBe('2026-03-28T13:20:00.000Z');
    expect(nextRebuild(summer).toISOString()).toBe('2026-06-28T13:20:00.000Z');

    expect(inWinter.label).toContain('14:20');
    expect(inSummer.label).toContain('15:20');
    expect(inWinter.label).not.toEqual(inSummer.label);
  });

  it('promises the duration and offers the time, not the other way round', () => {
    // The ceiling is the commitment and has to survive a daylight-saving change; the
    // clock time is a convenience and is hedged ("oko"). If these were swapped the badge
    // would be confidently wrong for half the year.
    const badge = rebuildBadgeDescription(winter, ZAGREB);
    const time = formatLocalTime(nextRebuild(winter), ZAGREB);

    expect(badge.title).toContain(`${MAX_WAIT_HOURS} h`);
    expect(badge.title).toContain(time);
    expect(badge.label).toContain(time);
    expect(badge.label).toContain('oko');

    // And it tells her what to do when the deadline passes. The predictable failure is
    // not that she waits — it is that she decides it did not work and publishes again.
    expect(badge.title).toContain('ne objavljuj ponovno');
  });

  it('is short enough to read in a document footer', () => {
    // A badge label is rendered inline beside Publish; a sentence there is truncated, and
    // a truncated promise is worse than none. The explanation lives in the tooltip.
    const badge = rebuildBadgeDescription(winter, ZAGREB);
    expect(badge.label!.length).toBeLessThanOrEqual(28);
    expect(badge.title!.length).toBeGreaterThan(badge.label!.length);
  });
});

describe('a Sanity outage is retried instead of paging a human', () => {
  it('greps the failed build for the message the read path really throws', () => {
    /**
     * The coupling this guards: the workflow decides whether to retry by looking for a
     * substring of an error message that lives in `src/lib/sanity/client.ts`. Reword the
     * error and the retry silently stops happening — green until the first outage, then a
     * false alarm at 01:20, and an alert that cries wolf is an alert nobody reads.
     *
     * Two halves, and the other one is the important one: `test/content.test.ts` asserts
     * this same constant against the output of a **real build against an unreachable
     * project**, so the chain is message → constant → workflow with a real failure at one
     * end. This half only has to show the workflow uses the constant.
     */
    expect(deploy).toContain(TRANSIENT_BUILD_FAILURE);
  });

  it('retries only that, and not a content or code failure', () => {
    // A missing document, a GROQ typo or a type error will not pass on the third attempt.
    // Retrying them buys nothing and delays the red, so the workflow bails out of the
    // loop instead — asserted as the bail-out being there, since the alternative is a
    // loop that retries everything and looks identical from the outside.
    expect(deploy).toMatch(/if ! grep -q .* "\$log"; then/);
    expect(deploy).toContain('Not retrying');
  });
});

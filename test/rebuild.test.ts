import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { rebuildBadge, rebuildBadgeDescription } from '../sanity/badges';
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
 *   4. **The mechanisms are mounted** (MUSE-93). Everything above tests behaviour that is
 *      reachable from Node: a cron string, a derived ceiling, a pure function. Three of
 *      MUSE-21's parts are not — a CI job, a workflow job and one line of Studio config —
 *      and each of the three could be deleted outright with this suite and the whole of
 *      `npm test` green. QA did exactly that: `ci.yml`'s `rebuildloop` job and
 *      `deploy.yml`'s `alert` job each came out whole at 1478 tests passing, and the badge
 *      came off `sanity.config.ts` at 87. They are one defect, not three — *a pure
 *      function is tested and its mounting is not* — so `MOUNTED` below is one table
 *      applied three times rather than three bespoke checks, and each entry carries the
 *      sentence saying what stops happening when the mechanism goes.
 *
 * What is not here, because it cannot be: that a cron line actually causes GitHub to start
 * a run. That is verified by triggering one, and the run id is in the pull request.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const WORKFLOWS = '.github/workflows';
const DEPLOY = '.github/workflows/deploy.yml';
const CI = '.github/workflows/ci.yml';
const CONFIG = 'sanity.config.ts';
const BADGES = 'sanity/badges';

/**
 * The check name branch protection requires, so renaming the job is a red test here rather
 * than a required check that can never be satisfied again.
 */
const REBUILD_LOOP_CHECK = 'the rebuild loop is still enabled';

/**
 * The trigger MUSE-21 declined, by name.
 *
 * A Sanity webhook reaches a repository through this trigger, and calling it needs a GitHub
 * token living inside a third party — the one property this project's architecture was
 * arranged to keep. Forbidden rather than merely unused: the no-token property was verified
 * live (the only secret in CI is a Sanity *write* token, the `github-pages` environment
 * holds nothing, there are no deploy keys) and nothing stopped the next person adding one.
 * Written here and not in a workflow comment on purpose, because the scan below reads the
 * workflows as text, prose included, which is MUSE-42's ruling.
 */
const WEBHOOK_TRIGGER = 'repository_dispatch';

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

/* --------------------------------------------------------- reading a workflow as structure */

/**
 * **A workflow read as structure, not searched as text** (MUSE-93).
 *
 * This suite's own standard, set by the cron comparison above: a test that greps a workflow
 * for the string it was written against asserts that somebody typed something. The question
 * here is a different one — *does this workflow still declare this job, and does that job
 * still have the properties the mechanism depends on* — and that is a question about the
 * document's shape, so the document is read as one.
 *
 * It is deliberately a small reader rather than a YAML library: the only parsers declared
 * in `package.json` are `typescript` and `groq-js`, and `yaml` is present solely as a
 * transitive dependency of Astro and Sanity. Leaning on an undeclared package is the exact
 * shape that failed Sanity's declaration preflight for `styled-components` — installed,
 * undeclared, invisible to every gate that reads `package.json` — and adding a dependency
 * to parse five mappings is a worse trade than forty lines that are tested below.
 *
 * What it models: block mappings keyed by indentation, sequence items that open a mapping
 * on the same line (`- name: Audit`), and **block scalars**, whose content is skipped so a
 * line of shell or of issue body can never be read as a key. That last one is the reason
 * the reader exists at all — `deploy.yml`'s alert body contains the line
 * `- Trigger: ...`, which is a mapping entry to anything matching text.
 */
type Region = {
  /** Whatever followed the colon on the key's own line, trimmed. */
  readonly value: string;
  /** The key's line, and the first line that is no longer under it. */
  readonly from: number;
  readonly to: number;
};

type Mapping = ReadonlyMap<string, Region>;

type Keyed = {
  /** The key this line opens, or `null` for a line that opens none. */
  readonly key: string | null;
  /** The column the key name starts at — its indent inside the enclosing mapping. */
  readonly indent: number;
  readonly value: string;
};

const NOT_A_KEY: Keyed = { key: null, indent: -1, value: '' };

/** One entry per line of the file, saying whether that line opens a key and at what indent. */
function scan(text: string): Keyed[] {
  const out: Keyed[] = [];
  let scalar: number | null = null;
  for (const raw of text.split('\n')) {
    const indent = raw.search(/\S/);
    // Inside a block scalar: anything more indented than the key that opened it, and any
    // blank line, is content. The first line at or left of that indent ends it.
    if (scalar !== null && (indent === -1 || indent > scalar)) {
      out.push(NOT_A_KEY);
      continue;
    }
    scalar = null;
    const opened = /^(\s*(?:-\s+)?)([A-Za-z_][\w.-]*):(?:\s+(\S.*?))?\s*$/.exec(raw);
    if (!opened) {
      out.push(NOT_A_KEY);
      continue;
    }
    const [, lead, key, value = ''] = opened;
    out.push({ key, indent: lead.length, value });
    // `|`, `>`, and their chomping and indentation indicators.
    if (/^[|>][-+\d]*$/.test(value)) scalar = lead.length;
  }
  return out;
}

/** The mapping whose keys sit at `indent`, within the half-open line range. */
function mappingAt(
  scanned: readonly Keyed[],
  indent: number,
  from: number,
  to: number,
): Mapping {
  const opens: Keyed[] = [];
  const at: number[] = [];
  for (let line = from; line < to; line += 1) {
    const read = scanned[line];
    if (read.key === null || read.indent > indent) continue;
    // Left the mapping: a key further left belongs to something enclosing it.
    if (read.indent < indent) break;
    opens.push(read);
    at.push(line);
  }
  const found = new Map<string, Region>();
  opens.forEach((open, index) => {
    found.set(open.key as string, {
      value: open.value,
      from: at[index],
      to: index + 1 < at.length ? at[index + 1] : to,
    });
  });
  return found;
}

const EMPTY: Mapping = new Map();

type Workflow = {
  readonly file: string;
  readonly text: string;
  /** The top-level mapping: `name`, `on`, `permissions`, `concurrency`, `jobs`. */
  readonly top: Mapping;
  /** What starts a run of this workflow. */
  readonly triggers: Mapping;
  readonly jobs: Mapping;
  /** A job's own keys — empty for a job that is not there, so a predicate can say so. */
  readonly keysOf: (job: string) => Mapping;
  /** A mapping nested under one of those keys, such as a job's `permissions`. */
  readonly under: (job: string, key: string) => Mapping;
  /** Every line of the job, shell and all. */
  readonly bodyOf: (job: string) => string;
};

function workflow(file: string): Workflow {
  const text = readFileSync(join(ROOT, WORKFLOWS, file), 'utf8');
  const lines = text.split('\n');
  const scanned = scan(text);
  const top = mappingAt(scanned, 0, 0, scanned.length);
  const nested = (region: Region | undefined, indent: number): Mapping =>
    region ? mappingAt(scanned, indent, region.from + 1, region.to) : EMPTY;
  const jobs = nested(top.get('jobs'), 2);
  const keysOf = (job: string): Mapping => nested(jobs.get(job), 4);
  return {
    file,
    text,
    top,
    triggers: nested(top.get('on'), 2),
    jobs,
    keysOf,
    under: (job, key) => nested(keysOf(job).get(key), 6),
    bodyOf: (job) => {
      const region = jobs.get(job);
      return region ? lines.slice(region.from, region.to).join('\n') : '';
    },
  };
}

const ci = workflow(basename(CI));
const deployed = workflow(basename(DEPLOY));

/* ----------------------------------------------- the badge's mounting, read off the syntax */

const configSource = readFileSync(join(ROOT, CONFIG), 'utf8');
const configTree = ts.createSourceFile(CONFIG, configSource, ts.ScriptTarget.Latest, true);

/**
 * The local names `sanity.config.ts` imports from `sanity/badges`.
 *
 * Read off the import's resolved *path* rather than its text, so a specifier spelled another
 * way still counts and a module that merely sounds like it does not. Parsed for
 * `test/helpers/source-guard.ts`'s reason, which is written out at length there: a rule
 * stated against an imported name cannot be dodged by an alias, and a doc comment
 * mentioning the name cannot trip it.
 */
function badgeImports(): string[] {
  const names: string[] = [];
  configTree.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) return;
    if (join(ROOT, node.moduleSpecifier.text) !== join(ROOT, BADGES)) return;
    const bound = node.importClause?.namedBindings;
    if (bound && ts.isNamedImports(bound)) {
      names.push(...bound.elements.map((element) => element.name.text));
    }
  });
  return names;
}

/** Does this subtree name one of them? */
function references(node: ts.Node, names: readonly string[]): boolean {
  if (ts.isIdentifier(node) && names.includes(node.text)) return true;
  let found = false;
  node.forEachChild((child) => {
    if (!found) found = references(child, names);
  });
  return found;
}

/**
 * Is one of those names handed to Sanity as the `badges` of the `document` options?
 *
 * The nesting is asserted rather than the name alone: `badges` on its own could be any
 * property of any object in the file, and the only one that puts a sentence in front of
 * Mina is the one Sanity reads.
 */
function mountedAsDocumentBadge(names: readonly string[]): boolean {
  let mounted = false;
  const walk = (node: ts.Node, enclosing: readonly string[]): void => {
    let within = enclosing;
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      within = [...enclosing, node.name.text];
      if (
        node.name.text === 'badges' &&
        enclosing.includes('document') &&
        references(node.initializer, names)
      ) {
        mounted = true;
      }
    }
    node.forEachChild((child) => walk(child, within));
  };
  walk(configTree, []);
  return mounted;
}

/* ---------------------------------------------------------- the three mountings (MUSE-93) */

type Property = {
  /** The claim, as the test name reads it. */
  readonly claim: string;
  /** True while the mounting still has it. */
  readonly holds: () => boolean;
};

type Mount = {
  /** The mechanism, named the way a failure has to name it. */
  readonly mechanism: string;
  /** Where it is mounted. */
  readonly where: string;
  /** What stops happening when it is deleted. Printed on every failure below. */
  readonly lost: string;
  readonly properties: readonly Property[];
};

const MOUNTED: readonly Mount[] = [
  {
    mechanism: '`ci.yml`’s `rebuildloop` job',
    where: CI,
    lost:
      'GitHub disables a scheduled workflow after 60 days of repository inactivity and ' +
      'promises no notification when it does. A disabled workflow does not fail — it does ' +
      'not run — so `deploy.yml`’s `alert` job is structurally blind to it: there is no ' +
      'run in which to execute it. The disable takes push-triggered deploys with it, so ' +
      'this is also "my merge did not deploy". Synthetic activity to keep the clock alive ' +
      'was weighed and rejected; detecting the documented `state` is the whole answer, and ' +
      'this job is the only thing that reads it.',
    properties: [
      {
        claim: 'is a job, and not a paragraph about one',
        holds: () => ci.jobs.has('rebuildloop'),
      },
      {
        claim: 'keeps the name branch protection requires of it',
        holds: () => ci.keysOf('rebuildloop').get('name')?.value === REBUILD_LOOP_CHECK,
      },
      {
        claim: 'asks the API for the state of the workflow that carries the cron',
        holds: () => {
          const body = ci.bodyOf('rebuildloop');
          // The probed file, so renaming the deploy workflow cannot leave this probing a
          // workflow that does not exist — which answers 404 and degrades to the warning.
          const probed = /actions\/workflows\/([\w.-]+)/.exec(body)?.[1];
          return probed === basename(DEPLOY) && body.includes('.state');
        },
      },
      {
        claim: 'fails on the state GitHub documents for that disable, rather than warning',
        holds: () => {
          const body = ci.bodyOf('rebuildloop');
          return body.includes('disabled_inactivity') && /exit 1/.test(body);
        },
      },
      {
        claim: 'is hosted by the one workflow here that cannot be auto-disabled itself',
        holds: () => !ci.triggers.has('schedule') && deployed.triggers.has('schedule'),
      },
    ],
  },
  {
    mechanism: '`deploy.yml`’s `alert` job',
    where: DEPLOY,
    lost:
      'Nobody finds out that an unattended rebuild failed, and the site goes stale with ' +
      'nothing said. GitHub’s own notification is not a substitute and the ticket argues ' +
      'it at length: for a scheduled workflow it goes to whoever created it, moves to ' +
      'whoever last edited the cron and again to whoever re-enabled it, and only if a ' +
      'per-account Actions preference is on — a preference with no REST API, so nothing ' +
      'here can assert it. Measured while MUSE-21 was built: `subscribers_count` is 0 and ' +
      '`GET /subscription` answers 404. An assignment notification is "Participating", on ' +
      'by default, and independent of both.',
    properties: [
      {
        claim: 'is a job, and not a paragraph about one',
        holds: () => deployed.jobs.has('alert'),
      },
      {
        claim: 'runs in the one case it exists for, which `needs:` would otherwise skip',
        holds: () => (deployed.keysOf('alert').get('if')?.value ?? '').includes('failure()'),
      },
      {
        claim: 'waits on both halves of the deploy, so either failing reaches a person',
        holds: () => {
          const needs = deployed.keysOf('alert').get('needs')?.value ?? '';
          return ['build', 'deploy'].every(
            (job) => deployed.jobs.has(job) && needs.includes(job),
          );
        },
      },
      {
        claim: 'may open an issue and may do nothing else',
        holds: () => {
          const permissions = deployed.under('alert', 'permissions');
          return (
            [...permissions.keys()].join(',') === 'issues' &&
            permissions.get('issues')?.value === 'write'
          );
        },
      },
      {
        claim: 'assigns it, which is the half that makes the notification arrive',
        holds: () => {
          const body = deployed.bodyOf('alert');
          return (
            body.includes('gh issue create') &&
            body.includes('--assignee') &&
            body.includes('repository_owner')
          );
        },
      },
    ],
  },
  {
    mechanism: 'the rebuild badge’s mounting in `sanity.config.ts`',
    where: CONFIG,
    lost:
      'The one sentence Mina ever reads about the cadence disappears from the Studio, and ' +
      'every other assertion in this file still passes — `rebuildBadgeDescription` is a ' +
      'pure function and the tests above call it directly. It is MUSE-21’s AC2 and it has ' +
      'no second visible artefact: with the badge unmounted, publishing is followed by ' +
      'silence again. Nothing else in the repository reads this option; unmounting it was ' +
      'green at 87 tests, the stale schema stamp being the only complaint and `npm run ' +
      'sanity:types` the documented way to make that one go away.',
    properties: [
      {
        claim: 'imports the badge from the module this suite tests',
        holds: () => badgeImports().includes('rebuildBadge'),
      },
      {
        claim: 'hands it to Sanity as the document badge, where she presses Publish',
        holds: () => mountedAsDocumentBadge(badgeImports()),
      },
      {
        claim: 'and the thing mounted is a badge rather than a name',
        holds: () => typeof rebuildBadge === 'function',
      },
    ],
  },
];

describe('the reader the mount table leans on', () => {
  it('reads a line of shell as shell, whatever column it is in', () => {
    // The reader's own test, against a source string rather than a file, for the reason
    // `test/a11yrules.test.ts` states: a guard whose only subject is the tree it was
    // written against passes for whatever reason happens to be true today. `leaked` sits
    // inside a block scalar at the depth a mapping key would occupy.
    const fixture = [
      'on:',
      '  push:',
      'jobs:',
      '  demo:',
      '    steps:',
      '      - name: Probe',
      '        run: |',
      '          echo one',
      '          leaked: true',
      '',
      '    permissions:',
      '      actions: read',
    ].join('\n');

    const keys = scan(fixture)
      .filter((line) => line.key !== null)
      .map((line) => `${line.indent}:${line.key}`);

    expect(keys).toEqual([
      '0:on',
      '2:push',
      '0:jobs',
      '2:demo',
      '4:steps',
      '8:name',
      '8:run',
      '4:permissions',
      '6:actions',
    ]);
  });

  it('reads both real workflows as the documents they are', () => {
    expect([...ci.top.keys()]).toEqual(['name', 'on', 'concurrency', 'jobs']);
    expect([...deployed.top.keys()]).toEqual([
      'name',
      'on',
      'permissions',
      'concurrency',
      'jobs',
    ]);
    expect([...ci.triggers.keys()]).toEqual(['pull_request', 'push']);
    expect([...deployed.triggers.keys()]).toEqual(['push', 'schedule', 'workflow_dispatch']);

    // A job's own keys and nothing its shell says. Both of these bodies are mostly block
    // scalars, and the alert's issue body contains lines that are mapping entries to any
    // reader that only matches text.
    expect([...ci.keysOf('rebuildloop').keys()]).toEqual([
      'name',
      'runs-on',
      'permissions',
      'steps',
    ]);
    expect([...deployed.keysOf('alert').keys()]).toEqual([
      'name',
      'needs',
      'if',
      'runs-on',
      'permissions',
      'steps',
    ]);
  });
});

for (const mount of MOUNTED) {
  describe(`${mount.mechanism} is mounted, not only argued for`, () => {
    for (const property of mount.properties) {
      it(property.claim, () => {
        expect(
          property.holds(),
          `${mount.mechanism} is gone or changed in ${mount.where}. ${mount.lost}`,
        ).toBe(true);
      });
    }
  });
}

describe('the badge offers a clock time and promises none', () => {
  /** `14:20`, `2:20`, `14.20` — any way a clock time is written in either locale. */
  const CLOCK = /\d{1,2}[:.]\d{2}/g;

  /** Instants across a year, so both halves of the daylight-saving year are read. */
  function* sampleFortnights(): Generator<Date> {
    const start = Date.UTC(2026, 0, 1, 0, 3);
    const step = 13 * 24 * 60 * 60 * 1000 + 7 * 60 * 1000;
    for (let t = start; t < start + 366 * 24 * 60 * 60 * 1000; t += step) yield new Date(t);
  }

  it('names no clock time but the one it computed for the reader', () => {
    /**
     * The absence, which the presence assertions above cannot see (MUSE-93). The badge
     * *may* name a clock time, because it computes one in her browser and so is right in
     * both halves of the year; a clock time it did **not** compute is a sentence baked
     * against one of the two, and „Gradnje su svaki dan u 14:20, 20:20, 02:20 i 08:20."
     * was added to the title with every test in this file green. Correct in Zagreb in
     * winter, an hour wrong every summer, and `npm run ds` and `npm run format:check` do
     * not read copy.
     *
     * So every clock time in the rendered copy has to *be* the computed one, and there has
     * to be at least one, or a badge that names no time would satisfy this vacuously.
     * Rendered rather than scanned off `sanity/badges.ts`, because a claim composed at
     * render time appears in no source file (MUSE-50) — and in two zones, so a time that
     * happens to match in Zagreb does not pass for a literal.
     */
    const offenders: string[] = [];
    for (const zone of ['Europe/Zagreb', 'UTC']) {
      for (const now of sampleFortnights()) {
        const badge = rebuildBadgeDescription(now, zone);
        const at = formatLocalTime(nextRebuild(now), zone);
        const where = `${zone} at ${now.toISOString()}`;
        for (const [part, copy] of [
          ['label', badge.label ?? ''],
          ['title', badge.title ?? ''],
        ] as const) {
          const times = [...copy.matchAll(CLOCK)].map(([found]) => found);
          if (times.length === 0) {
            offenders.push(`${part} names no time at all (${where})`);
          }
          for (const found of times) {
            if (found !== at) offenders.push(`${part} names ${found}, not ${at} (${where})`);
          }
        }
      }
    }
    expect(
      offenders,
      'the badge may offer the time it computed and may name no other: cron is UTC and ' +
        'does not shift with daylight saving, so a clock time written into the copy is ' +
        'wrong for half the year in the direction nobody notices. The promise is ' +
        '`MAX_WAIT_HOURS`.',
    ).toEqual([]);
  });
});

describe('no GitHub credential, and no trigger a third party could pull', () => {
  /** Read off the directory rather than listed, so a fourth workflow is covered too. */
  const all = readdirSync(join(ROOT, WORKFLOWS))
    .filter((file) => /\.ya?ml$/.test(file))
    .sort()
    .map((file) => workflow(file));

  it('covers every workflow in the directory, so there is no list to extend', () => {
    const files = all.map(({ file }) => file);
    expect(files).toContain(basename(CI));
    expect(files).toContain(basename(DEPLOY));
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('declares no trigger a Sanity webhook could call', () => {
    /**
     * **This is why MUSE-21 chose a schedule over a webhook**, and until MUSE-93 nothing
     * stopped it coming back. The webhook route works and is what most projects do; it
     * needs a GitHub token living inside Sanity, and the cost of the schedule is latency,
     * which the Studio can be honest about. Parsed as a trigger *and* scanned as text: a
     * commented-out one is a keystroke from live, and the reasoning belongs in a test
     * rather than in a workflow comment the scan would then have to exempt.
     */
    for (const wf of all) {
      expect(
        [...wf.triggers.keys()],
        `${wf.file} declares the trigger MUSE-21 declined`,
      ).not.toContain(WEBHOOK_TRIGGER);
      expect(wf.text, `${wf.file} names the trigger MUSE-21 declined`).not.toContain(
        WEBHOOK_TRIGGER,
      );
    }
  });

  it('names no GitHub credential, in any form', () => {
    for (const wf of all) {
      // `secrets.GH…` covers a PAT under any of the names one gets called, and
      // `secrets.GITHUB_TOKEN` with it — which is the same ephemeral token as
      // `github.token` and so costs nothing to spell the other way.
      expect(wf.text, `${wf.file} reads a GitHub credential out of secrets`).not.toMatch(
        /secrets\.GH/i,
      );
      const tokens = [...wf.text.matchAll(/GH_TOKEN:\s*(.+)$/gm)].map(([, value]) =>
        value.trim(),
      );
      for (const token of tokens) {
        // The per-run token, which expires with the job and lives nowhere.
        expect(token, `${wf.file} hands \`gh\` something other than the run's own token`).toBe(
          '${{ github.token }}',
        );
      }
    }
  });

  it('keeps one secret in CI, and it is not a GitHub credential', () => {
    /**
     * Asserted as the whole set rather than as a prohibition, in the shape this repository
     * uses for `READ_CONTRACT` and `RETIRED_CLAIMS`: a new secret is then a decision
     * somebody writes down, and the one exemption is asserted to still be live rather than
     * inherited. `SANITY_DEPLOY_TOKEN` is a Sanity *write* token — it publishes the Studio
     * (`studio.yml`) — and gives nobody anything on GitHub, which is the property.
     */
    const named = new Set<string>();
    for (const wf of all) {
      for (const [, secret] of wf.text.matchAll(/secrets\.([A-Za-z_]\w*)/g)) named.add(secret);
      // And each one is consumed as what it is: a Sanity credential, named for Sanity.
      for (const line of wf.text.split('\n')) {
        if (!line.includes('secrets.')) continue;
        expect(line.trim(), `${wf.file} uses a secret for something other than Sanity`).toMatch(
          /^SANITY_\w+:\s*\$\{\{\s*secrets\./,
        );
      }
    }
    expect(
      [...named].sort(),
      'a secret appeared in a workflow: say what it is for. MUSE-21 and MUSE-45 both exist ' +
        'to keep a GitHub credential out of this repository, and the deliberate state is ' +
        'that the only one here cannot act on GitHub at all.',
    ).toEqual(['SANITY_DEPLOY_TOKEN']);
  });
});

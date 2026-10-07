import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildSite, PAGES_DEPLOY, type Build } from './helpers/build';
import { SCHEDULE } from '../src/data/schedule';
import { LOCALES, type Locale } from '../src/lib/i18n';
import {
  LEVELS,
  LEVEL_NAME,
  STYLES,
  STYLE_NAME,
  WEEKDAY_NAME,
  type Level,
} from '../src/lib/schedule';

/**
 * MUSE-11 — the homepage and `/schedule` named the same class two different
 * things: the Croatian homepage said *Početni*, the Croatian schedule said
 * *Beginner*.
 *
 * The two strings were the symptom. The cause was that `Home.astro` kept its own
 * copy of the level names (and `forms.ts` a third), so `LEVEL_NAME` in
 * `src/lib/schedule.ts` was one of three places a level could be spelled. This
 * suite is built to fail on the *cause*, in four layers that fail for different
 * reasons:
 *
 *   1. **agreement** — for each locale, the name the homepage shows for a level
 *      equals the name `/schedule` shows for the same level. No expected string
 *      anywhere in the assertion: it compares two independent renderings of the
 *      same datum, so it cannot pass by agreeing with a stale literal. This is
 *      the layer that fails on the bug as reported.
 *   2. **provenance** — every level name in the built output equals
 *      `LEVEL_NAME[locale][level]`, read from the module under test. Edit the
 *      single source and the whole site moves with it; edit one page and this
 *      fails.
 *   3. **the decision** — level names are English in both locales (MUSE-6),
 *      restated here as a literal so that reversing it has to be deliberate, and
 *      no retired Croatian level word survives anywhere in `dist`. Layer 1 is
 *      satisfied by two pages being *consistently* wrong; this is what pins the
 *      value. It also sweeps the trial form's `<option>`s and the schedule's
 *      filter chips, which carry level names without being either page's doors.
 *   4. **the guard** — no file under `src/` other than `src/lib/schedule.ts` may
 *      contain a level name as a literal. Layers 1–3 are satisfied by a
 *      hardcoded copy that happens to agree today; this is the one that fails
 *      the moment a second copy exists, which is the third acceptance criterion.
 *
 * Layer 4 reads sources; 1–3 read the built HTML, as the rest of the suite does.
 */

// --------------------------------------------------------------------------
// Oracles
// --------------------------------------------------------------------------

/**
 * MUSE-6's decision, restated rather than imported.
 *
 * `LEVEL_NAME` stays a `Record<Locale, …>` so that reversing English-everywhere
 * is a data edit. This is the test that makes the reversal visible instead of
 * silent: it fails, you read the comment, you update it on purpose.
 */
const ENGLISH_LEVEL_NAMES = {
  beginner: 'Beginner',
  intermediate: 'Intermediate',
  advanced: 'Advanced',
} as const;

/**
 * The Croatian level words MUSE-6 retired — and which MUSE-11 found still live
 * in `Home.astro`'s doors and in the trial form's level select.
 *
 * A substring sweep for these is the end-to-end net under layers 1–2: it does
 * not care how the string got onto the page, or whether the element that carries
 * it was marked up as a level at all.
 */
const RETIRED_HR_LEVEL_NAMES = ['Početni', 'Srednji', 'Napredni'] as const;

/** Where each page is published. `build.format` is `directory`. */
const HOME: Record<Locale, string> = { hr: 'index.html', en: 'en/index.html' };
const SCHEDULE_PAGE: Record<Locale, string> = {
  hr: 'schedule/index.html',
  en: 'en/schedule/index.html',
};

/** The locale a built page renders in, from where it was written. */
function localeOf(file: string): Locale {
  return file.startsWith('en/') ? 'en' : 'hr';
}

// --------------------------------------------------------------------------
// HTML helpers — same regex-over-built-output approach as the other suites.
// --------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

function decode(text: string): string {
  return text.replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole);
}

/**
 * The text a visitor can read, whitespace collapsed.
 *
 * `<script>` and `<style>` bodies are dropped first. They survive tag-stripping
 * as text, and a bundled module can legitimately contain any string — counting
 * them would make the layer-3 sweep assert about JavaScript source rather than
 * about what the page says.
 */
function visibleText(html: string): string {
  return decode(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, ' ')
      .replace(/<[^>]*>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Visible text of one fragment. */
function text(html: string): string {
  return visibleText(html);
}

/**
 * Every rendered level name in a fragment, with the level it claims to be.
 *
 * The markup contract MUSE-11 introduces: an element that displays a level's
 * name carries `data-level-name="<level key>"` and shows nothing else. One
 * self-describing unit, so a single matcher finds them on any page — the doors
 * on the homepage, the accordion rows and grid blocks on `/schedule`.
 */
function levelNames(html: string): { level: string; shown: string }[] {
  const found: { level: string; shown: string }[] = [];
  const re = /<([a-z]+)\b[^>]*\bdata-level-name="([^"]*)"[^>]*>([\s\S]*?)<\/\1>/g;
  for (const m of html.matchAll(re)) {
    found.push({ level: decode(m[2]!), shown: text(m[3]!) });
  }
  return found;
}

/** The distinct names a page renders, grouped by level key. */
function namesByLevel(html: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const { level, shown } of levelNames(html)) {
    const names = out.get(level) ?? new Set<string>();
    names.add(shown);
    out.set(level, names);
  }
  return out;
}

interface Door {
  level: string;
  name: string;
  when: string;
}

/**
 * The homepage's "new to dancing?" doors.
 *
 * `data-door="<level key>"` marks one. "Two doors, not six" is an editorial
 * choice from the design brief, so the count is part of the contract: reading
 * the doors off the schedule must not turn into listing every class.
 */
function doors(html: string): Door[] {
  const found: Door[] = [];
  for (const m of html.matchAll(/<li\b[^>]*\bdata-door="([^"]*)"[^>]*>([\s\S]*?)<\/li>/g)) {
    const inner = m[2]!;
    const when = /<[a-z]+\b[^>]*\bdata-when\b[^>]*>([\s\S]*?)<\/[a-z]+>/.exec(inner);
    found.push({
      level: decode(m[1]!),
      name: levelNames(inner)[0]?.shown ?? '',
      when: when ? text(when[1]!) : '',
    });
  }
  return found;
}

const HH_MM = /\b((?:[01]\d|2[0-3]):[0-5]\d)\b/;

// --------------------------------------------------------------------------
// Source helpers — layer 4.
// --------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The one file allowed to spell a level name, and the one allowed to spell a
 * style name. Everything else under `src/` has to go through the map.
 */
const SINGLE_SOURCE = 'src/lib/schedule.ts';

/** Every file under `src/`, as repo-relative paths. */
function sourceFiles(dir = join(ROOT, 'src')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(full) : [relative(ROOT, full).replace(/\\/g, '/')];
  });
}

/**
 * Block comments removed, so prose about the decision does not read as a copy of
 * it. `/* … *\/` covers CSS and the body of an Astro `{/* … *\/}` too.
 *
 * Line comments are deliberately left in: a `//` matcher would have to guess
 * whether `https://` starts one, and a level name written into a line comment is
 * still a second spelling that will drift.
 */
function stripBlockComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
}

/** The distinct display names a locale map renders, across every locale. */
function displayNames<K extends string>(
  map: Record<Locale, Record<K, string>>,
  keys: readonly K[],
): string[] {
  return [...new Set(LOCALES.flatMap((locale) => keys.map((key) => map[locale][key])))];
}

let build: Build;
const page = {} as Record<Locale, { home: string; schedule: string }>;

beforeAll(async () => {
  build = buildSite(PAGES_DEPLOY);
  for (const locale of LOCALES) {
    page[locale] = {
      home: build.read(HOME[locale]),
      schedule: build.read(SCHEDULE_PAGE[locale]),
    };
  }
}, 240_000);

/**
 * AC1 — Given the Croatian homepage, then the beginner doors use the same level
 * names as `/schedule`.
 *
 * Asserted for both locales and with no expected string in sight: whatever the
 * schedule calls a level is what the homepage has to call it.
 */
describe('AC1: the homepage and /schedule agree on what a level is called', () => {
  for (const locale of LOCALES) {
    it(`names every level on / exactly as /schedule does (${locale})`, () => {
      const home = namesByLevel(page[locale].home);
      const schedule = namesByLevel(page[locale].schedule);

      expect(home.size, 'the homepage renders no level names at all').toBeGreaterThan(0);
      expect(schedule.size, '/schedule renders no level names at all').toBeGreaterThan(0);

      for (const [level, names] of home) {
        const onSchedule = schedule.get(level);
        expect(onSchedule, `/schedule never names the ${level} level`).toBeDefined();
        expect(
          [...names].sort(),
          `/ and /schedule disagree on the ${level} level in ${locale}`,
        ).toEqual([...onSchedule!].sort());
      }
    });

    it(`spells each level exactly one way per page (${locale})`, () => {
      for (const html of [page[locale].home, page[locale].schedule]) {
        for (const [level, names] of namesByLevel(html)) {
          expect([...names], `two spellings of ${level} on one page`).toHaveLength(1);
        }
      }
    });
  }
});

/**
 * AC2 — Given either locale, then every level name on the site comes from
 * `LEVEL_NAME`.
 */
describe('AC2: every level name in the output comes from LEVEL_NAME', () => {
  it('renders every marked level name straight out of the map', () => {
    const pages = build.htmlFiles();
    expect(pages.length, 'no built pages found').toBeGreaterThan(0);

    let checked = 0;
    for (const file of pages) {
      const locale = localeOf(file);
      for (const { level, shown } of levelNames(build.read(file))) {
        expect(LEVELS, `${file} declares a level "${level}" that is not in LEVELS`).toContain(
          level,
        );
        expect(shown, `${file} renders ${level} as "${shown}"`).toBe(
          LEVEL_NAME[locale][level as Level],
        );
        checked += 1;
      }
    }
    expect(checked, 'found no level names to check — is the markup contract still there?')
      .toBeGreaterThan(0);
  });

  it('names all three levels on /schedule in both locales', () => {
    // The map is only a single source if the whole fixed set flows through it.
    for (const locale of LOCALES) {
      const byLevel = namesByLevel(page[locale].schedule);
      for (const level of LEVELS) {
        expect([...(byLevel.get(level) ?? [])], `${level} missing from /schedule (${locale})`)
          .toEqual([LEVEL_NAME[locale][level]]);
      }
    }
  });
});

/**
 * The MUSE-6 decision itself. Layer 1 cannot see a consistent reversal and layer
 * 2 reads the same map the site does, so the value is pinned here.
 */
describe('level names are English in both locales (MUSE-6)', () => {
  it('keeps LEVEL_NAME a per-locale map holding the English names', () => {
    for (const locale of LOCALES) {
      for (const level of LEVELS) {
        expect(LEVEL_NAME[locale][level], `${locale}.${level}`).toBe(
          ENGLISH_LEVEL_NAMES[level],
        );
      }
    }
  });

  it('publishes no retired Croatian level word on any page', () => {
    for (const file of build.htmlFiles()) {
      const content = visibleText(build.read(file));
      for (const word of RETIRED_HR_LEVEL_NAMES) {
        expect(content, `${file} still says "${word}"`).not.toContain(word);
      }
    }
  });
});

/**
 * AC3 — Given the suite, then a test fails if a level name is hardcoded in a
 * component rather than read from `LEVEL_NAME`.
 *
 * The forbidden set is derived from the map, not listed: hardcoding a level name
 * means writing whatever the map currently says, so the guard follows a data
 * edit instead of going stale. The retired Croatian words are added on top,
 * because they are what MUSE-11 actually found and a reversal of MUSE-6 must not
 * quietly re-permit them in a component.
 */
describe('AC3: the guard — a level name may not be hardcoded outside LEVEL_NAME', () => {
  const groups = [
    {
      kind: 'level',
      source: SINGLE_SOURCE,
      map: 'LEVEL_NAME',
      names: [...displayNames(LEVEL_NAME, LEVELS), ...RETIRED_HR_LEVEL_NAMES],
    },
    {
      kind: 'style',
      source: SINGLE_SOURCE,
      map: 'STYLE_NAME',
      names: displayNames(STYLE_NAME, STYLES),
    },
  ];

  for (const group of groups) {
    it(`finds no ${group.kind} name written out anywhere but ${group.source}`, () => {
      const files = sourceFiles();
      expect(files, 'the source tree walk found nothing').toContain(SINGLE_SOURCE);

      const offenders: string[] = [];
      for (const file of files) {
        if (file === group.source) continue;
        const source = stripBlockComments(readFileSync(join(ROOT, file), 'utf8'));
        for (const name of group.names) {
          if (source.includes(name)) offenders.push(`${file} → "${name}"`);
        }
      }

      expect(
        offenders,
        `${group.kind} names belong to ${group.map} in ${group.source}; ` +
          `read them from there instead of spelling them out`,
      ).toEqual([]);
    });
  }

  it('checks a set of names that is actually non-empty', () => {
    // A derived forbidden set is only a guard while it has something in it.
    for (const group of groups) expect(group.names.length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * The doors themselves: an editorial selection of two, whose class details are
 * read from the schedule data rather than typed again.
 */
describe('the two beginner doors', () => {
  for (const locale of LOCALES) {
    it(`offers two doors, not six (${locale})`, () => {
      // "Two doors, not six" is the design brief's choice. Deriving the doors
      // from the schedule must not turn into listing every class.
      expect(doors(page[locale].home)).toHaveLength(2);
    });

    it(`opens each door onto a distinct level from the fixed set (${locale})`, () => {
      const levels = doors(page[locale].home).map((d) => d.level);
      for (const level of levels) expect(LEVELS).toContain(level);
      expect(new Set(levels).size, 'two doors onto the same level').toBe(levels.length);
    });

    it(`shows a session that really exists in the schedule (${locale})`, () => {
      for (const door of doors(page[locale].home)) {
        const days = Object.entries(WEEKDAY_NAME[locale]) as [
          keyof (typeof WEEKDAY_NAME)['hr'],
          string,
        ][];
        const day = days.find(([, name]) => door.when.includes(name))?.[0];
        expect(day, `"${door.when}" names no ${locale} weekday`).toBeDefined();

        const start = HH_MM.exec(door.when)?.[1];
        expect(start, `"${door.when}" carries no 24-hour time`).toBeDefined();

        expect(
          SCHEDULE.some((e) => e.day === day && e.start === start && e.level === door.level),
          `the ${door.level} door points at ${day} ${start}, which is not a ${door.level} class`,
        ).toBe(true);
      }
    });

    it(`writes the door time as 24-hour, like the schedule (${locale})`, () => {
      for (const door of doors(page[locale].home)) {
        expect(door.when, `"${door.when}" is not 24-hour`).toMatch(HH_MM);
        expect(door.when).not.toMatch(/\b\d{1,2}(?::\d{2})?\s?[ap]\.?m\.?\b/i);
      }
    });
  }
});

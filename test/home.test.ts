import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildSite, PAGES_DEPLOY, type Build } from './helpers/build';
import { claimOutDir } from './helpers/scratch';
import { seedDocs, seededSchedule } from './helpers/seed';
import { FORM_COPY } from '../src/lib/forms';
import { LOCALES, type Locale } from '../src/lib/i18n';
import {
  LEVELS,
  LEVEL_NAME,
  LEVEL_PREREQUISITE,
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
 *      value.
 *   4. **the guard** — no file under `src/` other than `src/lib/schedule.ts` may
 *      write a level name, or a level's prerequisite, as its own string. Layers
 *      1–3 are satisfied by a hardcoded copy that happens to agree today; this is
 *      the one that fails the moment a second copy exists, which is the third
 *      acceptance criterion.
 *
 * Layer 4 reads sources; 1–3 read the built HTML, as the rest of the suite does.
 *
 * ---
 *
 * **MUSE-18 — what layer 3 does *not* do, and what replaced the claim that it did.**
 *
 * This docstring used to say layer 3 "also sweeps the trial form's `<option>`s and
 * the schedule's filter chips". Both halves were wrong. It sweeps `dist` for the
 * three *retired Croatian words* and nothing else, so relabelling either to an
 * arbitrary new string — `Novice`, `Expert` — passed all four layers; and the
 * filter chips no longer exist at all, MUSE-36 having deleted `STYLES` and the
 * style filter.
 *
 * The fix is not a fifth layer. The form's level options now carry
 * `data-level-name`, the same markup contract the doors and the schedule's slots
 * carry, so layers 1–2 cover them for free — and `the trial form's level options`
 * below asserts the attribute is *present*, because layers 1–2 can only check the
 * elements that opt in, and an element that quietly stops opting in is the hole
 * this ticket was about. The option's submitted `value` is now the level key, so
 * there is one string per level in the whole system rather than a display name and
 * a parallel wire format that drifted (`pocetni` / `improver` / `srednji`).
 *
 * What covers a level name rendered by some *future* component that forgets the
 * attribute is layer 4: it cannot spell the name in the first place, so it has to
 * read `LEVEL_NAME`, and reading `LEVEL_NAME` is what the attribute documents.
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
  // MUSE-36: the real timetable has four levels, and `Improver` is the scene's own word
  // for the one between — so it is English for exactly the reason the other three are.
  improver: 'Improver',
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
/** The page MUSE-18 measured: `grep -c data-level-name` returned 0 here. */
const CONTACT_PAGE: Record<Locale, string> = {
  hr: 'contact/index.html',
  en: 'en/contact/index.html',
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
 * on the homepage, the accordion rows and grid blocks on `/schedule`, and since
 * MUSE-18 the `<option>`s of the trial form's level select.
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
 * `data-door="<level key>"` marks one. "Two doors, not six" is this page's own
 * editorial choice and not the design brief's — the brief has no door in it at
 * all, which MUSE-80 checked and `Home.astro` now records. The count is part of
 * the contract either way: reading the doors off the schedule must not turn into
 * listing every class.
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

interface LevelOptionEl {
  /** `value` as submitted. */
  value: string;
  /** `data-level-name`, or `undefined` when the option does not declare a level. */
  level: string | undefined;
  /** What the visitor reads. */
  label: string;
}

/**
 * The options of the trial form's level `<select>`, in document order.
 *
 * Read off `name="level"` rather than off a class, because the submitted name is the
 * thing the form provider sees and therefore the thing that cannot be renamed silently.
 * The package `<select>` on `/pricing` is a different field and is not matched.
 */
function levelSelectOptions(html: string): LevelOptionEl[] {
  const select = /<select\b[^>]*\bname="level"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  if (!select) return [];
  return [...select[1]!.matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/g)].map((m) => {
    const attrs = m[1]!;
    const value = /\bvalue="([^"]*)"/.exec(attrs);
    const level = /\bdata-level-name="([^"]*)"/.exec(attrs);
    return {
      value: value ? decode(value[1]!) : '',
      level: level ? decode(level[1]!) : undefined,
      label: text(m[2]!),
    };
  });
}

// --------------------------------------------------------------------------
// Source helpers — layer 4.
// --------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/**
 * The one file allowed to spell a level's name or its prerequisite. Everything
 * else under `src/` has to go through the map.
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

/**
 * Does `source` spell `name` out as a string of its own?
 *
 * **Why this is not `source.includes(name)`** (MUSE-18). It was, and `Advanced` is an
 * ordinary English word: the day somebody writes „Advanced booking" into a page the
 * guard fails for a reason that has nothing to do with level names, and the obvious
 * way out is to weaken it — which costs the whole mechanism. CSS (`.advanced` is
 * lowercase, but `[data-level="Advanced"]` would not be) and `//` comments are in
 * scope for the same reason.
 *
 * So the name has to be the *whole* of something rather than a substring of it: the
 * match requires a quote, a backtick or a tag boundary on both sides. That is every
 * way a level name can reach a page as its own string —
 *
 *   `'Advanced'`   `"Advanced"`   \`Advanced\`   `label="Advanced"`   `>Advanced</span>`
 *
 * — and it is not satisfied by `'Advanced booking from 1 June'`, by
 * `// Advanced booking is a separate flow`, or by `>Advanced booking<`. What it gives
 * up is a level name *concatenated* into a longer string (`` `${x} Advanced` ``). That
 * is a deliberate trade and the narrow end of it: a level name is a badge, rendered on
 * its own, and the two render sites that exist both put it in its own element. A level
 * name mid-sentence is prose about a level rather than a second copy of its name.
 *
 * Surrounding whitespace and newlines are allowed, so a name on its own line inside a
 * template or an element still matches.
 */
function spellsOut(source: string, name: string): boolean {
  const token = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`['"\`>]\\s*${token}\\s*['"\`<]`).test(source);
}

/**
 * The committed seed with every slot of one level switched off, written where nothing
 * else can name it.
 *
 * `test/helpers/scratch.ts` owns the directory (MUSE-17): a suite may not choose one.
 */
function pauseLevelFixture(level: string): string {
  const classIds = new Set(
    seedDocs()
      .filter((doc) => doc._type === 'class' && doc.level === level)
      .map((doc) => doc._id),
  );
  expect(classIds.size, `the seed has no ${level} class to pause`).toBeGreaterThan(0);

  const docs = seedDocs().map((doc) =>
    doc._type === 'scheduleSlot' &&
    classIds.has((doc.class as { _ref?: string } | undefined)?._ref ?? '')
      ? { ...doc, active: false }
      : doc,
  );

  const path = join(claimOutDir('home-paused'), 'content.ndjson');
  writeFileSync(path, docs.map((doc) => JSON.stringify(doc)).join('\n') + '\n');
  return path;
}

let build: Build;
const page = {} as Record<Locale, { home: string; schedule: string }>;
/** The same site with the beginner class paused in the "Studio" — see the suite below. */
let paused: Build;

beforeAll(async () => {
  build = buildSite(PAGES_DEPLOY);
  for (const locale of LOCALES) {
    page[locale] = {
      home: build.read(HOME[locale]),
      schedule: build.read(SCHEDULE_PAGE[locale]),
    };
  }

  /**
   * One extra build, with every beginner slot switched off.
   *
   * `scheduleSlot.active` is the field Mina uses for a summer pause, so this is an
   * ordinary Studio edit rather than a broken dataset — and before MUSE-36 it would have
   * stopped the build, because the beginner door threw when it could not find a class.
   * The rows were a file in this repository then; they are content now.
   */
  paused = buildSite(PAGES_DEPLOY, {
    MUSE_CONTENT_FIXTURE: pauseLevelFixture('beginner'),
  });
}, 300_000);

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
 * MUSE-18 — the trial form's level `<select>`, which the guard could not see.
 *
 * Layers 1–2 check every element carrying `data-level-name` and are blind to every
 * element that does not, so coverage is a property of the *markup* and has to be
 * asserted as one. `/contact` carried four `<option>`s with no attribute, and
 * relabelling them `Novice` / `Expert` passed all four layers — measured on the
 * deployed site, not theorised.
 *
 * Three things are pinned here. That the select exists and is found at all, so this
 * suite cannot pass by matching nothing. That every option which *is* a level
 * declares which level it is — the sentence layers 1–2 then enforce. And that the
 * submitted `value` is the level key, which is the other half of the ticket: the
 * values were `pocetni` / `improver` / `srednji` / `napredni`, one list in two
 * conventions, because the display name and the wire format were separate tables
 * and only one of them had a guard.
 *
 * The blank "not sure yet" option is the one option that is deliberately *not* a
 * level (MUSE-7 — a beginner who cannot self-assess is the most likely person to
 * fill this form in), so it carries no attribute and is asserted to carry none:
 * marking it would make layer 2 demand that prose equal a level name.
 */
describe('the trial form’s level options are covered by the same mechanism', () => {
  /** Every built page that renders the form. Not a list — the form moves between pages. */
  function pagesWithLevelSelect(): string[] {
    return build.htmlFiles().filter((file) => levelSelectOptions(build.read(file)).length > 0);
  }

  it('finds the level select on /contact in both locales, and on more than one page', () => {
    for (const locale of LOCALES) {
      expect(
        levelSelectOptions(build.read(CONTACT_PAGE[locale])).length,
        `no level <select name="level"> on ${CONTACT_PAGE[locale]}`,
      ).toBe(LEVELS.length + 1);
    }
    // `/` and `/pricing` render the same component; a single hit would mean the
    // matcher found the one page somebody remembered rather than the contract.
    expect(pagesWithLevelSelect().length, 'the form is rendered on one page only').toBeGreaterThan(
      2,
    );
  });

  it('marks every level option with data-level-name, on every page that has the form', () => {
    for (const file of pagesWithLevelSelect()) {
      const [notSure, ...levels] = levelSelectOptions(build.read(file));

      expect(notSure!.value, `${file}: the first option is not the blank one`).toBe('');
      expect(notSure!.level, `${file}: the "not sure yet" option claims to be a level`)
        .toBeUndefined();

      expect(
        levels.map((option) => option.level),
        `${file}: a level option carries no data-level-name, so the guard cannot see it`,
      ).toEqual([...LEVELS]);
    }
  });

  it('submits the level key as the option value, so there is one string per level', () => {
    for (const file of pagesWithLevelSelect()) {
      for (const option of levelSelectOptions(build.read(file)).slice(1)) {
        expect(option.value, `${file}: the ${option.level} option submits "${option.value}"`).toBe(
          option.level,
        );
        expect(LEVELS, `${file}: "${option.value}" is not a level key`).toContain(option.value);
      }
    }
  });

  it('keeps the blank option’s wording translated, since it is prose and not a level', () => {
    const [hr, en] = LOCALES.map((locale) => levelSelectOptions(build.read(CONTACT_PAGE[locale]))[0]!);
    expect(hr!.label.trim(), 'the blank option lost its wording').not.toBe('');
    expect(en!.label, 'the "not sure yet" option is not translated').not.toBe(hr!.label);
  });

  it('reads the option labels out of LEVEL_NAME rather than a second table', () => {
    // Layer 2 asserts this against the markup. This asserts it against the module the
    // form reads, which is where both locales drifting *together* would start — the
    // case `formcopy.test.ts` cannot see, because it only compares HR with EN.
    for (const locale of LOCALES) {
      const options = FORM_COPY[locale].levels;
      expect(options.slice(1).map((option) => option.label)).toEqual(
        LEVELS.map((level) => LEVEL_NAME[locale][level]),
      );
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
 *
 * `spellsOut` rather than `includes` since MUSE-18 — see the note there for what
 * that gives up and why the substring version could not survive.
 */
describe('AC3: the guard — a level name may not be hardcoded outside LEVEL_NAME', () => {
  const groups = [
    {
      kind: 'level',
      source: SINGLE_SOURCE,
      map: 'LEVEL_NAME',
      names: [...displayNames(LEVEL_NAME, LEVELS), ...RETIRED_HR_LEVEL_NAMES],
    },
    /**
     * `LEVEL_PREREQUISITE` — the same guarantee, one field over (MUSE-18).
     *
     * `Home.astro` held a verbatim second copy of
     * `LEVEL_PREREQUISITE[locale].intermediate` in its door copy: „Plešeš oko godinu
     * dana." / "About a year of dancing.", byte-identical, on a page that renders a
     * level beside it. Exactly the shape MUSE-11 had just fixed for the *name*, and
     * nothing watched the prerequisite — so the fix is the same guard rather than a
     * note asking the next author to look.
     *
     * It needs no layer-1/2 counterpart. A prerequisite is a sentence, not a badge:
     * there is no second rendering of the same datum to compare against, and the
     * `data-level-name` contract exists because a *name* is a one-word element whose
     * provenance is otherwise unknowable. Here the guard over the source is the whole
     * mechanism — the string cannot be written twice, so there is nothing to
     * reconcile.
     */
    {
      kind: 'prerequisite',
      source: SINGLE_SOURCE,
      map: 'LEVEL_PREREQUISITE',
      names: displayNames(LEVEL_PREREQUISITE, LEVELS),
    },
    /**
     * There was a `style` group here, over `STYLE_NAME`, and MUSE-36 deleted the map
     * along with `STYLES` and `class.style` — the three styles were invented with the
     * thirteen invented classes and the studio does not teach by them.
     *
     * The guard it provided is replaced rather than dropped, from two other directions:
     * `test/sanity.test.ts` asserts the schema has no `style` field on `class` at all,
     * and `test/schedule.test.ts` asserts no style filter chip survives on `/schedule`.
     * A dist-wide sweep for the three *words* was considered and rejected — „sensualna
     * bachata" is an ordinary phrase a dance studio may legitimately write, so a guard
     * on the word would eventually be weakened rather than obeyed, which is MUSE-18's
     * note about `Advanced` one field over.
     */
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
          if (spellsOut(source, name)) offenders.push(`${file} → "${name}"`);
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
    expect(groups.length, 'the guard has no groups left to check').toBeGreaterThan(0);
    for (const group of groups) expect(group.names.length).toBeGreaterThanOrEqual(3);
  });

  /**
   * MUSE-18 — the matcher stopped being a substring search, and a narrower matcher is
   * a weaker guard unless somebody measures where the new edge is.
   *
   * So the edge is a test. `caught` is every way a level name reaches a page as its
   * own string, including the two the real offenders used — an object-literal value in
   * `forms.ts` and a text node in `Home.astro`. `ignored` is the prose the substring
   * version failed on, which is the only reason this changed.
   */
  it('still catches every way a level name can be written out', () => {
    const caught = [
      `  label: 'Advanced',`,
      `  label: "Advanced",`,
      '  label: `Advanced`,',
      `<p class="cardName">Advanced</p>`,
      `<span>\n  Advanced\n</span>`,
      `<option value="napredni">Advanced</option>`,
      `aria-label="Advanced"`,
      `{'Advanced'}`,
      `[data-level="Advanced"] { color: red; }`,
      `  intermediate: 'Plešeš oko godinu dana.',`,
    ];
    for (const sample of caught) {
      expect(spellsOut(sample, 'Advanced') || spellsOut(sample, 'Plešeš oko godinu dana.'), sample)
        .toBe(true);
    }
  });

  it('no longer fails on ordinary prose that happens to contain the word', () => {
    const ignored = [
      `  lede: 'Advanced booking opens on 1 June.',`,
      `// Advanced booking is a separate flow — see MUSE-99.`,
      `<p>Advanced booking opens on 1 June.</p>`,
      `.advancedToggle { display: none; }`,
      `const advanced = levels.at(-1);`,
    ];
    for (const sample of ignored) {
      expect(spellsOut(sample, 'Advanced'), sample).toBe(false);
    }
  });
});

/**
 * MUSE-36 — the homepage's „Tri okusa, jedan ples" section, and what replaced it.
 *
 * Nothing did, deliberately: three cards describing Traditional / Moderna / Sensual
 * bachata, a distinction the studio does not make and that was invented alongside the
 * invented timetable. Asserted as an absence so the section cannot come back by being
 * pasted from git history without the decision being made again — and asserted on the
 * *shape* rather than on the three words, which `AC3` explains.
 */
describe('the homepage no longer describes three styles of bachata', () => {
  for (const locale of LOCALES) {
    it(`renders exactly one card grid, the two doors (${locale})`, () => {
      const html = page[locale].home;
      const grids = [...html.matchAll(/<ul\b[^>]*class="[^"]*\bcards\b[^"]*"/g)];
      expect(grids, `${locale} homepage card grids`).toHaveLength(1);
      expect(doors(html), 'the one grid is not the doors').toHaveLength(2);
    });

    it(`keeps no three-up grid rule in its stylesheet (${locale})`, () => {
      // The `.cards.three` rule had one user. A rule with no user is where the section
      // comes back from.
      const styles = [...page[locale].home.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)]
        .map((m) => m[1]!)
        .join('\n');
      expect(styles).not.toMatch(/\.cards\.three\b/);
    });
  }
});

/**
 * The doors themselves: an editorial selection of two, whose class details are
 * read from the schedule data rather than typed again.
 */
describe('the two beginner doors', () => {
  for (const locale of LOCALES) {
    it(`offers two doors, not six (${locale})`, () => {
      // "Two doors, not six" is the page's own choice, not the brief's (MUSE-80).
      // Deriving the doors from the schedule must not turn into listing every class.
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
          seededSchedule().some(
            (row) => row.day === day && row.start === start && row.level === door.level,
          ),
          `the ${door.level} door points at ${day} ${start}, which is not a ${door.level} class`,
        ).toBe(true);
      }
    });

    it(`drops a door whose level is paused rather than failing the build (${locale})`, () => {
      /**
       * MUSE-36 — the rows are CMS content now, so this had to change.
       *
       * `firstSession` threw when a door's level had no class: "a door onto a level
       * nobody teaches is worse than one door fewer". Correct while the schedule was a
       * file in this repository, where a missing level could only be a developer's
       * mistake. Now `scheduleSlot.active` is the field Mina uses for a summer pause, and
       * the same rule would mean an ordinary Studio edit stops the site building.
       *
       * So the door goes and the page stands. What MUSE-11 was protecting is untouched:
       * a door still cannot show a day and time the schedule does not have, because with
       * no class there is nothing for it to show.
       */
      const html = paused.read(HOME[locale]);
      const remaining = doors(html);

      expect(remaining.map((d) => d.level), 'the paused level still has a door').not.toContain(
        'beginner',
      );
      expect(remaining.length, 'every door vanished — the section is empty').toBeGreaterThan(0);

      // And the doors that survive still point at classes that run.
      for (const door of remaining) {
        const start = HH_MM.exec(door.when)?.[1];
        expect(
          seededSchedule().some(
            (row) => row.start === start && row.level === door.level,
          ),
          `the ${door.level} door points at ${door.when}, which is not a ${door.level} class`,
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

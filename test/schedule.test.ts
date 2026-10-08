import { beforeAll, describe, expect, it } from 'vitest';

import {
  assetFile,
  buildSite,
  linkHrefs,
  PAGES_DEPLOY,
  type Build,
} from './helpers/build';
import { seededSchedule, seedDocsOfType, type SeedRow } from './helpers/seed';
import { classCount } from '../src/lib/schedule';

/**
 * **The timetable Mina supplied, as a photograph of a sheet of paper (MUSE-36).**
 *
 * The one literal in this file that is content rather than vocabulary, and it is here
 * because it is the only thing in the repository that can disagree with the CMS. Every
 * other assertion below compares the page against `sanity/seed/content.ndjson`; this
 * compares the seed against the studio. Without it the suite would be satisfied by a
 * page that renders the dataset perfectly, which is exactly what it was doing while
 * thirteen invented classes were live.
 *
 * Four classes, two days, ninety minutes, two instructors on every one of them.
 */
const REAL_TIMETABLE = [
  { day: 'mon', start: '19:30', durationMin: 90, level: 'beginner', instructors: ['Mina', 'Antonio'] },
  { day: 'mon', start: '21:00', durationMin: 90, level: 'intermediate', instructors: ['Mina', 'Antonio'] },
  { day: 'thu', start: '19:30', durationMin: 90, level: 'improver', instructors: ['Mina', 'Antonio'] },
  { day: 'thu', start: '21:00', durationMin: 90, level: 'advanced', instructors: ['Mina', 'Antonio'] },
] as const;

/**
 * MUSE-6 — `/schedule`, the weekly class grid.
 *
 * These assertions come from the ticket's Given/When/Then. Only *one* build is
 * needed here (unlike `seo.test.ts`), because nothing on this page depends on
 * the deploy target.
 *
 * Division of labour between this file and `scripts/schedule-ux.mjs`:
 *
 *   here (built HTML)   — content and semantics: the markup both layouts are cut
 *                         from, the copy, the locale-correct day names and times,
 *                         the prerequisite wording, the empty-state string.
 *   schedule-ux.mjs     — anything that needs a layout engine or an input device:
 *                         which view a 390px / 1280px viewport actually *shows*,
 *                         keyboard operation of the accordion, and the filter
 *                         producing the empty state. A regex cannot see any of it.
 *
 * ---------------------------------------------------------------------------
 * The structural contract asserted below, stated up front rather than inferred
 * from whatever markup the component happens to emit:
 *
 *   - each class is one element carrying `data-slot`, plus `data-level` and
 *     `data-style` so a client-side filter has something to act on;
 *   - the accordion is native `<details>`/`<summary>`, one per day — which is
 *     also what makes AC6's "keyboard alone" true with no JavaScript at all;
 *   - the desktop view is a `<table>` whose `<th scope="col">` are day names and
 *     whose `<th scope="row">` are times, i.e. a day × time grid a screen reader
 *     can announce positionally.
 *
 * A component that met the criteria some other way would need these updated. The
 * assertions themselves are about the criteria, not about this markup.
 * ---------------------------------------------------------------------------
 */

/**
 * The user-facing vocabulary, written out here on purpose.
 *
 * Importing these maps from `src/lib/schedule.ts` would make the locale criteria
 * untestable — the test would agree with the implementation by construction.
 *
 * *Which* classes exist is read off `sanity/seed/content.ndjson` instead
 * (`./helpers/seed.ts`), because since MUSE-36 the rows are CMS content: the file the
 * suite builds against is the file `npm run sanity:seed` imports, so "the page renders
 * the dataset" and "the dataset is the real timetable" are two separate, checkable
 * claims rather than one circular one.
 */
const DAY_NAME = {
  hr: {
    mon: 'Ponedjeljak',
    tue: 'Utorak',
    wed: 'Srijeda',
    thu: 'Četvrtak',
    fri: 'Petak',
    sat: 'Subota',
    sun: 'Nedjelja',
  },
  en: {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
  },
} as const;

/**
 * Level badges are English in both locales (MUSE-6 decision) — see LEVEL_NAME.
 *
 * Four of them since MUSE-36: the studio teaches an *Improver* class between the
 * beginner and the intermediate one, and the order here is the order the grid, the
 * homepage doors and the Studio dropdown all take from `LEVELS`.
 */
const LEVEL_NAME = {
  hr: {
    beginner: 'Beginner',
    improver: 'Improver',
    intermediate: 'Intermediate',
    advanced: 'Advanced',
  },
  en: {
    beginner: 'Beginner',
    improver: 'Improver',
    intermediate: 'Intermediate',
    advanced: 'Advanced',
  },
} as const;

/** The level keys, in grid order. Written out, like the names. */
const LEVEL_KEYS = ['beginner', 'improver', 'intermediate', 'advanced'] as const;

type LevelKey = (typeof LEVEL_KEYS)[number];
type DayKey = keyof (typeof DAY_NAME)['hr'];

/** AC4, verbatim from the ticket and from design system §7.2. */
const EMPTY_STATE = {
  hr: 'Nema termina za odabrani filter.',
  en: 'No classes match the selected filter.',
} as const;

type Locale = 'hr' | 'en';
const LOCALES: Locale[] = ['hr', 'en'];

/** Where each locale's page is published. `build.format` is `directory`. */
const PAGE_FILE: Record<Locale, string> = {
  hr: 'schedule/index.html',
  en: 'en/schedule/index.html',
};

// --------------------------------------------------------------------------
// HTML helpers. Same regex-over-built-output approach as the other suites: the
// assertions are about what the deploy serves, so they read the deployed bytes.
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

/** Visible text of an HTML fragment, whitespace collapsed. */
function text(html: string): string {
  return decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** The `<main>` element's inner HTML — the page's own content, without chrome. */
function main(html: string): string {
  const m = /<main\b[^>]*>([\s\S]*)<\/main>/.exec(html);
  expect(m, 'the page has no <main>').not.toBeNull();
  return m![1]!;
}

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? decode(m[1]!) : undefined;
}

/** Every `<details>…</details>` on the page, outer HTML. Not nested here. */
function detailsBlocks(html: string): string[] {
  return [...html.matchAll(/<details\b[^>]*>[\s\S]*?<\/details>/g)].map((m) => m[0]!);
}

/** Every `<table>…</table>`, outer HTML. */
function tableBlocks(html: string): string[] {
  return [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/g)].map((m) => m[0]!);
}

/** Every element carrying `data-slot`, as `{ tag, inner }`. One per class. */
function slots(html: string): { tag: string; inner: string }[] {
  const out: { tag: string; inner: string }[] = [];
  // Slots contain no nested slot, so a lazy match to the matching close tag of
  // the same element name is enough.
  for (const m of html.matchAll(/<(\w+)\b([^>]*\bdata-slot\b[^>]*)>([\s\S]*?)<\/\1>/g)) {
    out.push({ tag: `<${m[1]} ${m[2]}>`, inner: m[3]! });
  }
  return out;
}

/** `<time>` elements: the machine value and the visible one. */
function times(html: string): { datetime: string | undefined; shown: string }[] {
  return [...html.matchAll(/<time\b([^>]*)>([\s\S]*?)<\/time>/g)].map((m) => ({
    datetime: attr(`<time ${m[1]}>`, 'datetime'),
    shown: text(m[2]!),
  }));
}

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

/**
 * Whole-word containment that works in Croatian.
 *
 * `\b` is defined against ASCII `\w`, so `/\bČetvrtak\b/` never matches: `Č` is
 * not a word character, and the boundary it asks for does not exist after a
 * space. Unicode property lookarounds do what `\b` was meant to do here.
 */
function wordIn(haystack: string, word: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${word}(?![\\p{L}\\p{N}])`, 'iu').test(haystack);
}

/** `Utorak` → `tue`, for whichever locale is being read. */
function dayKeyFrom(name: string, locale: Locale): string | undefined {
  return Object.entries(DAY_NAME[locale]).find(([, label]) => label === name)?.[0];
}

/** `day|time` → the slot's visible text, read off the mobile accordion. */
function accordionSlots(html: string, locale: Locale): Map<string, string> {
  const found = new Map<string, string>();

  for (const block of detailsBlocks(html)) {
    const summary = /<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(block);
    expect(summary, 'a <details> with no <summary> is not operable').not.toBeNull();

    // The day is whichever locale day name the summary opens with; the count and
    // chevron follow it, so match the label rather than the whole summary text.
    const day = Object.entries(DAY_NAME[locale]).find(([, label]) =>
      wordIn(text(summary![1]!), label),
    )?.[0];
    expect(day, `no ${locale} day name in summary: ${text(summary![1]!)}`).toBeDefined();

    for (const slot of slots(block)) {
      const time = times(slot.inner)[0];
      expect(time, `accordion slot on ${day} has no <time>`).toBeDefined();
      found.set(`${day}|${time!.shown}`, text(slot.inner));
    }
  }

  return found;
}

/**
 * `day|time` → the slot's visible text, read off the desktop grid.
 *
 * Reconstructed from the table's own headers: a cell's day is its column's
 * `<th scope="col">` and its time is its row's `<th scope="row">`. That is the
 * same information a screen reader uses, so if the grid is navigable this works,
 * and if it is not, this fails.
 */
function gridSlots(html: string, locale: Locale): Map<string, string> {
  const tables = tableBlocks(html);
  expect(tables, 'no <table> — AC2 asks for a day × time grid').toHaveLength(1);
  const table = tables[0]!;

  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
  expect(rows.length, 'the grid has no rows').toBeGreaterThan(1);

  const colHeads = [
    ...rows[0]!.matchAll(/<th\b([^>]*)>([\s\S]*?)<\/th>/g),
  ].map((m) => ({ scope: attr(`<th ${m[1]}>`, 'scope'), label: text(m[2]!) }));

  // Column 0 is the time gutter; the rest are days, in week order.
  const columns = colHeads.map((h) => {
    expect(h.scope, `header "${h.label}" has no scope`).toBe('col');
    return dayKeyFrom(h.label, locale);
  });
  expect(
    columns.slice(1).every((c) => c !== undefined),
    `grid column headers are not ${locale} day names: ${colHeads.map((h) => h.label).join(', ')}`,
  ).toBe(true);

  const found = new Map<string, string>();

  for (const row of rows.slice(1)) {
    const rowHead = /<th\b([^>]*)>([\s\S]*?)<\/th>/.exec(row);
    expect(rowHead, 'a grid row has no <th> time header').not.toBeNull();
    expect(attr(`<th ${rowHead![1]}>`, 'scope'), 'the time gutter is not a row header').toBe(
      'row',
    );
    const time = text(rowHead![2]!);

    const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]!);
    expect(cells.length, `row ${time} has ${cells.length} cells, expected ${columns.length - 1}`)
      .toBe(columns.length - 1);

    cells.forEach((cell, i) => {
      for (const slot of slots(cell)) {
        found.set(`${columns[i + 1]}|${time}`, text(slot.inner));
      }
    });
  }

  return found;
}

/** The published timetable, joined out of the seed. The oracle for everything below. */
const ROWS: SeedRow[] = seededSchedule();

/** `day|time` for every published class, the key both views are checked against. */
function expectedKeys(): string[] {
  return ROWS.map((row) => `${row.day}|${row.start}`).sort();
}

/** The row at one `day|time` key. */
function rowAt(key: string): SeedRow {
  const found = ROWS.find((row) => `${row.day}|${row.start}` === key);
  if (!found) throw new Error(`No seeded class at ${key}.`);
  return found;
}

/**
 * Every fact a rendered class has to carry: its name, its level, and each teacher.
 *
 * The instructors are checked one name at a time rather than as the joined phrase, so
 * the assertion is about *who is named* and stays true of „Mina i Antonio" and of
 * "Mina and Antonio" alike — the conjunction is `formatNames`'s business and is pinned
 * separately below.
 */
function factsOf(row: SeedRow, locale: Locale): string[] {
  return [row.name[locale], LEVEL_NAME[locale][row.level as LevelKey], ...row.instructors];
}

let build: Build;
const page = {} as Record<Locale, string>;

beforeAll(async () => {
  build = buildSite(PAGES_DEPLOY);
  for (const locale of LOCALES) page[locale] = build.read(PAGE_FILE[locale]);
}, 240_000);

/**
 * MUSE-36 — the acceptance criterion that matters more than any layout rule: every
 * published row is a class that actually runs.
 *
 * Asserted against the CMS seed rather than against the page, because this is a claim
 * about the *content*: the page can only be right if what it reads is right.
 */
describe('MUSE-36: the dataset is the studio timetable, not an invention', () => {
  it('publishes exactly the four classes Mina supplied', () => {
    expect(
      seededSchedule().map(({ day, start, durationMin, level, instructors }) => ({
        day,
        start,
        durationMin,
        level,
        instructors,
      })),
    ).toEqual(
      [...REAL_TIMETABLE]
        .map((row) => ({ ...row, instructors: [...row.instructors] }))
        .sort((a, b) => `${a.day}|${a.start}`.localeCompare(`${b.day}|${b.start}`)),
    );
  });

  it('names only instructors who exist', () => {
    // Luka and Petra were in the invented data and are not people. The set of names the
    // schedule can possibly show is the set of `instructor` documents, so it is checked
    // against the documents rather than against a deny-list of the two wrong names.
    const documented = seedDocsOfType('instructor').map((doc) => doc.name as string).sort();
    expect(documented).toEqual(['Antonio', 'Mina']);

    const shown = [...new Set(seededSchedule().flatMap((row) => row.instructors))].sort();
    expect(shown).toEqual(documented);
  });

  it('gives every slot both of its teachers, not one of them', () => {
    // The schema models an array because Mina and Antonio teach together — a single
    // reference could only have published half of each row.
    for (const row of seededSchedule()) {
      expect(row.instructors, `${row.slotId} teachers`).toEqual(['Mina', 'Antonio']);
    }
  });
});

/**
 * The ticket's premise: `/schedule` is linked from the nav and the homepage hero
 * but does not exist, so both hit the 404.
 */
describe('the page exists at the route the site already links to', () => {
  it('is published in both locales', () => {
    for (const locale of LOCALES) {
      expect(build.isFile(PAGE_FILE[locale]), `${PAGE_FILE[locale]} is missing`).toBe(true);
    }
  });

  it('resolves every internal link to /schedule to a real file', () => {
    // The bug, stated as a test: links existed, the page did not. Collected
    // across every built page so the nav and the hero are both covered without
    // naming either.
    const broken: string[] = [];
    const root = new URL(`${build.origin}/`);

    for (const file of build.htmlFiles()) {
      for (const m of build.read(file).matchAll(/<a\b[^>]*href="([^"]*)"/g)) {
        const href = decode(m[1]!);
        let resolved: URL;
        try {
          resolved = new URL(href, root);
        } catch {
          continue;
        }
        if (resolved.origin !== root.origin) continue;
        // Page URLs end in a slash since MUSE-9; accept only that spelling.
        if (!/\/schedule\/$/.test(resolved.pathname)) continue;

        const route = resolved.pathname
          .slice(root.pathname.length)
          .replace(/^\/+|\/+$/g, '');
        if (!build.isFile(`${route}/index.html`)) broken.push(`${file}: ${href}`);
      }
    }

    expect(broken).toEqual([]);
  });

  it('is linked from somewhere, so the check above cannot pass vacuously', () => {
    const linking = build
      .htmlFiles()
      .filter((f) => /href="[^"]*\/schedule\/"/.test(build.read(f)));
    expect(linking.length, 'nothing links to /schedule').toBeGreaterThan(0);
  });
});

/**
 * AC1 — Given a viewport under 768px, when I open `/schedule`, then classes are
 * grouped by day as an accordion, each row showing time, class name, level and
 * instructor.
 *
 * Which view a narrow viewport *shows* is `scripts/schedule-ux.mjs`; the markup
 * it shows is here.
 */
describe('AC1: a per-day accordion, each row carrying all four facts', () => {
  for (const locale of LOCALES) {
    it(`groups the classes by day as native <details> (${locale})`, () => {
      const blocks = detailsBlocks(main(page[locale]));
      const days = new Set(ROWS.map((row) => row.day));

      // One disclosure per day that has classes — not one per class, and not a
      // single disclosure wrapping everything.
      expect(blocks).toHaveLength(days.size);
    });

    it(`opens the first day, so the page is not a wall of closed rows (${locale})`, () => {
      const blocks = detailsBlocks(main(page[locale]));
      const open = blocks.filter((b) => /<details\b[^>]*\bopen\b/.test(b));
      expect(open).toHaveLength(1);
      expect(blocks.indexOf(open[0]!)).toBe(0);
    });

    it(`shows every class exactly once, under its own day (${locale})`, () => {
      expect([...accordionSlots(main(page[locale]), locale).keys()].sort()).toEqual(
        expectedKeys(),
      );
    });

    it(`gives each row its time, class name, level and instructors (${locale})`, () => {
      const found = accordionSlots(main(page[locale]), locale);

      for (const row of ROWS) {
        const rendered = found.get(`${row.day}|${row.start}`)!;
        for (const value of factsOf(row, locale)) {
          expect(
            rendered,
            `${row.day} ${row.start} row is missing "${value}"`,
          ).toContain(value);
        }
      }
    });

    it(`states the length of every class, which is 90 minutes now (${locale})`, () => {
      // 60 was the only duration that had ever existed before MUSE-36, in the data and
      // in the page's own lede. Read off the dataset rather than restated, so the
      // assertion is "the page says what the class is" and not "the page says 90".
      const found = accordionSlots(main(page[locale]), locale);
      for (const row of ROWS) {
        expect(
          found.get(`${row.day}|${row.start}`)!,
          `${row.day} ${row.start} does not say how long the class is`,
        ).toContain(`${row.durationMin} min`);
      }
    });

    it(`labels each day with its session count, pluralised (${locale})`, () => {
      // Design system §7.2: the collapsed row is day + session count + chevron.
      const byDay = new Map<string, number>();
      for (const row of ROWS) byDay.set(row.day, (byDay.get(row.day) ?? 0) + 1);

      for (const block of detailsBlocks(main(page[locale]))) {
        const summary = text(/<summary\b[^>]*>([\s\S]*?)<\/summary>/.exec(block)![1]!);
        const day = Object.entries(DAY_NAME[locale]).find(([, label]) =>
          wordIn(summary, label),
        )![0]!;
        expect(summary).toContain(classCount(byDay.get(day)!, locale));
      }
    });
  }
});

/**
 * AC2 — Given a viewport of 768px or more, then **the same data** renders as a
 * day × time grid.
 */
describe('AC2: the same data as a day × time grid', () => {
  for (const locale of LOCALES) {
    it(`places every class at its own day and time (${locale})`, () => {
      expect([...gridSlots(main(page[locale]), locale).keys()].sort()).toEqual(
        expectedKeys(),
      );
    });

    it(`renders the grid from the same data as the accordion (${locale})`, () => {
      // The real content of "the same data": two layouts, one dataset. Compares
      // the rendered text of each cell against the matching accordion row, so a
      // view that quietly drops the instructor or the prerequisite fails.
      const accordion = accordionSlots(main(page[locale]), locale);
      const grid = gridSlots(main(page[locale]), locale);

      expect([...grid.keys()].sort()).toEqual([...accordion.keys()].sort());
      for (const [key, cell] of grid) {
        const row = accordion.get(key)!;
        for (const value of factsOf(rowAt(key), locale)) {
          expect(cell, `grid cell ${key} is missing "${value}"`).toContain(value);
          expect(row, `accordion row ${key} is missing "${value}"`).toContain(value);
        }
      }
    });

    it(`is real HTML, never an image (${locale})`, () => {
      // The ticket's loudest note. An <img>, <picture>, <canvas>, SVG <image> or
      // a CSS background-image anywhere in the schedule would mean the data is
      // not text.
      const content = main(page[locale]);
      for (const pattern of [/<img\b/, /<picture\b/, /<canvas\b/, /<image\b/]) {
        expect(pattern.test(content), `${pattern} in the schedule`).toBe(false);
      }
      expect(/background-image/.test(content)).toBe(false);
    });
  }
});

/**
 * AC3 — Given any viewport, when I read a class, then its prerequisite is
 * written as time danced (e.g. "oko godinu dana"), never as jargon.
 */
describe('AC3: the prerequisite is time danced, not jargon', () => {
  /**
   * Vocabulary a visitor who has never danced cannot decode. Dance-step names,
   * course-ware numbering and figure names all describe a prerequisite in terms
   * of the thing you would only know *after* taking the class.
   */
  const JARGON = [
    'cross-body',
    'cross body',
    'dile que no',
    'enchufla',
    'sombra',
    'copa',
    'bachata basic',
    'basic step',
    'osnovni korak',
    'figura',
    'syllabus',
    'modul',
    'module',
    'level 1',
    'level 2',
    'level 3',
    'razina 1',
    'razina 2',
    'razina 3',
    'b1',
    'b2',
  ];

  for (const locale of LOCALES) {
    it(`states a prerequisite for every class, in both views (${locale})`, () => {
      const prerequisites = {
        hr: {
          beginner: /bez iskustva/i,
          // Improver sits between "never danced" and "about a year" (MUSE-36).
          improver: /mjesec/i,
          // The ticket's own example.
          intermediate: /oko godinu dana/i,
          advanced: /godin/i,
        },
        en: {
          beginner: /no experience/i,
          improver: /months/i,
          intermediate: /about a year/i,
          advanced: /years/i,
        },
      }[locale];

      for (const view of [accordionSlots, gridSlots]) {
        const found = view(main(page[locale]), locale);
        for (const row of ROWS) {
          const slot = found.get(`${row.day}|${row.start}`)!;
          expect(
            slot,
            `${view.name} ${row.day} ${row.start} (${row.level}) states no time danced`,
          ).toMatch(prerequisites[row.level as keyof typeof prerequisites]);
        }
      }
    });

    it(`measures the prerequisite in time, not in steps or course numbers (${locale})`, () => {
      const content = text(main(page[locale]));
      const offenders = JARGON.filter((word) => wordIn(content, word));
      expect(offenders, `jargon on the ${locale} schedule`).toEqual([]);
    });
  }
});

/**
 * AC4 — Given a filter that matches nothing, then the empty state reads
 * "Nema termina za odabrani filter."
 *
 * The filter interaction itself is `scripts/schedule-ux.mjs`; what it reveals
 * has to be in the served HTML, which is what is checked here.
 */
describe('AC4: the empty state', () => {
  it('ships the exact Croatian wording the ticket specifies', () => {
    expect(main(page.hr)).toContain(EMPTY_STATE.hr);
  });

  it('ships an English counterpart rather than the Croatian string', () => {
    expect(main(page.en)).toContain(EMPTY_STATE.en);
    expect(main(page.en)).not.toContain(EMPTY_STATE.hr);
  });

  it('is hidden until a filter empties the schedule', () => {
    for (const locale of LOCALES) {
      const line = new RegExp(`<[^>]*\\bhidden\\b[^>]*>\\s*${EMPTY_STATE[locale]}`);
      expect(line.test(main(page[locale])), `${locale} empty state is visible at rest`).toBe(
        true,
      );
    }
  });

  it('offers a filter for every level, and none for a style', () => {
    // Level was one of the two dimensions design system §7.5 named; the other was
    // style, and MUSE-36 deleted it — the studio has no style dimension, so the three
    // chips filtered a field that was invented along with the rows. Asserted as an
    // absence as well as a presence: a leftover style chip would filter on an attribute
    // no class carries and so would match nothing at all.
    for (const locale of LOCALES) {
      const content = main(page[locale]);
      for (const level of LEVEL_KEYS) {
        expect(content, `no ${level} filter (${locale})`).toMatch(
          new RegExp(`data-filter="level"[^>]*data-value="${level}"`),
        );
      }
      expect(content, `a style filter survives on /schedule (${locale})`).not.toContain(
        'data-filter="style"',
      );
    }
  });

  it('offers a chip per level from the fixed set, not per level in the data', () => {
    /**
     * **What keeps the empty state reachable now that there is one filter dimension.**
     *
     * This used to be "at least one level+style pair matches nothing", which was true of
     * the invented data (no advanced traditional class) and is meaningless with styles
     * gone. The replacement is the property it was really standing in for: the chips are
     * rendered from `LEVELS`, so the page offers one for every level **whether or not a
     * class of that level runs**. Today all four do, so no single chip empties the
     * schedule — but a class paused for the summer (`active: false` on its slot, which is
     * what that field is for) leaves its chip in place with nothing behind it, and
     * „Nema termina za odabrani filter." is what the visitor gets. That is a state Mina
     * can reach from the Studio this afternoon, not a hypothetical.
     *
     * The grid's *empty cell* is the state reachable from today's data, and it is
     * asserted separately below.
     */
    for (const locale of LOCALES) {
      const offered = [
        ...main(page[locale]).matchAll(/data-filter="level"[^>]*data-value="([^"]*)"/g),
      ].map((m) => m[1]!);
      expect(offered, `level chips (${locale})`).toEqual(['all', ...LEVEL_KEYS]);
    }

    // And the claim the comment rests on: the chip set does not shrink to the levels
    // that happen to be in the dataset.
    expect(LEVEL_KEYS.length).toBeGreaterThanOrEqual(new Set(ROWS.map((r) => r.level)).size);
  });

  it('leaves a cell of the grid empty, so the empty cell is a rendered state', () => {
    /**
     * Four levels across two days is eight level+day combinations and four classes, so
     * most of that matrix is empty: selecting any one level leaves the other day's
     * column with nothing in it, which is the grid's empty cell. Asserted against the
     * data rather than hoped for — the same shape as the assertion it replaces.
     *
     * `scripts/schedule-ux.mjs` is where a browser confirms the cell is actually painted
     * empty; a regex cannot see a filter run.
     */
    const taught = new Set(ROWS.map((row) => `${row.level}|${row.day}`));
    const days = [...new Set(ROWS.map((row) => row.day))];
    const all = LEVEL_KEYS.flatMap((level) => days.map((day) => `${level}|${day}`));

    expect(days.length, 'the grid has fewer than two day columns').toBeGreaterThan(1);
    expect(
      all.filter((pair) => !taught.has(pair)),
      'every level runs on every day, so no filter can empty a grid cell',
    ).not.toEqual([]);
  });
});

/**
 * AC5 — Given either locale, when the page renders, then times are 24-hour and
 * day names are correct for that locale.
 */
describe('AC5: 24-hour times and locale-correct day names', () => {
  for (const locale of LOCALES) {
    it(`writes every time as 24-hour HH:MM (${locale})`, () => {
      const found = times(main(page[locale]));
      expect(found.length, 'no <time> elements on the schedule').toBeGreaterThan(0);

      for (const { datetime, shown } of found) {
        expect(shown, `"${shown}" is not 24-hour HH:MM`).toMatch(HH_MM);
        expect(datetime, `<time> showing ${shown} has no machine-readable value`).toMatch(
          HH_MM,
        );
        expect(datetime, `<time datetime> and its text disagree (${shown})`).toBe(shown);
      }
    });

    it(`uses no 12-hour clock anywhere (${locale})`, () => {
      // English is where this would slip: design system §10 asks for 12-hour EN
      // times in prose, but a schedule column has to stay scannable, and the
      // ticket is explicit that both locales are 24-hour.
      expect(text(main(page[locale]))).not.toMatch(/\b\d{1,2}(?::\d{2})?\s?[ap]\.?m\.?\b/i);
    });

    it(`names the days in ${locale} and in no other locale`, () => {
      const content = text(main(page[locale]));
      const other: Locale = locale === 'hr' ? 'en' : 'hr';
      const days = new Set(ROWS.map((row) => row.day as DayKey));

      for (const day of days) {
        expect(content, `${DAY_NAME[locale][day]} missing`).toContain(DAY_NAME[locale][day]);
        expect(
          content,
          `${DAY_NAME[other][day]} leaked onto the ${locale} page`,
        ).not.toContain(DAY_NAME[other][day]);
      }
    });

    it(`names the levels in ${locale}, from the fixed set of four`, () => {
      const content = text(main(page[locale]));
      for (const level of LEVEL_KEYS) {
        expect(content).toContain(LEVEL_NAME[locale][level]);
      }
    });

    it(`writes a half-hour start as a half hour (${locale})`, () => {
      // 19:30 is the first `:30` start the site has ever had — every invented class
      // began on the hour, so nothing had exercised the grid's row derivation, the
      // `<time datetime>` or `formatTime` against one.
      const halfHours = ROWS.filter((row) => row.start.endsWith(':30'));
      expect(halfHours.length, 'no half-hour class to check').toBeGreaterThan(0);

      for (const row of halfHours) {
        const shown = times(main(page[locale])).filter((t) => t.shown === row.start);
        // Once in the accordion's own row, once in the grid's time gutter.
        expect(shown.length, `${row.start} is not rendered as a time`).toBeGreaterThan(0);
        for (const { datetime } of shown) expect(datetime).toBe(row.start);
      }
    });
  }
});

/**
 * MUSE-36 — two instructors on one class, read as a sentence in each language.
 *
 * The schema models an array because Mina alone teaches lady styling, a class that is
 * coming and has a different instructor set. What a visitor sees of that decision is one
 * phrase, and a phrase joined with a comma („Mina, Antonio") or with the wrong
 * conjunction is the kind of thing only a reader notices — MUSE-14 was found by looking.
 */
describe('both teachers, named together, in each language', () => {
  const CONJOINED = { hr: 'Mina i Antonio', en: 'Mina and Antonio' } as const;

  for (const locale of LOCALES) {
    it(`joins the two names with the ${locale} conjunction`, () => {
      const content = text(main(page[locale]));
      expect(content, `${locale} never says "${CONJOINED[locale]}"`).toContain(
        CONJOINED[locale],
      );
      // A list is not a comma-separated dump, and not the other language's word for "and".
      expect(content).not.toContain('Mina, Antonio');
      expect(content).not.toContain(CONJOINED[locale === 'hr' ? 'en' : 'hr']);
    });

    it(`names both teachers on every single class (${locale})`, () => {
      for (const view of [accordionSlots, gridSlots]) {
        const found = view(main(page[locale]), locale);
        for (const row of ROWS) {
          const slot = found.get(`${row.day}|${row.start}`)!;
          for (const name of row.instructors) {
            expect(slot, `${view.name} ${row.day} ${row.start} omits ${name}`).toContain(
              name,
            );
          }
        }
      }
    });
  }

  it('publishes no instructor who does not exist', () => {
    // The two invented names the page carried until this ticket. Checked over the whole
    // built site, not just `/schedule`, because the homepage reads the same data.
    for (const file of build.htmlFiles()) {
      // Script bodies survive tag-stripping as text, and a bundled module may legitimately
      // contain any string — so they come out before the sweep, as `home.test.ts` does.
      const content = text(
        build.read(file).replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ' '),
      );
      for (const ghost of ['Luka', 'Petra']) {
        expect(content, `${file} still names ${ghost}`).not.toMatch(
          new RegExp(`(?<![\\p{L}\\p{N}])${ghost}(?![\\p{L}\\p{N}])`, 'u'),
        );
      }
    }
  });

  it('tells a visitor how long a class is, and does not still say 60 minutes', () => {
    // The lede said „Satovi traju 60 minuta." on both pages. Every class is 90.
    const lengths = new Set(ROWS.map((row) => row.durationMin));
    expect(lengths.size, 'classes of differing length — the lede cannot state one').toBe(1);
    const minutes = [...lengths][0]!;

    expect(text(main(page.hr))).toContain(`${minutes} minuta`);
    expect(text(main(page.en))).toContain(`${minutes} minutes`);
    for (const locale of LOCALES) {
      expect(text(main(page[locale])), `${locale} lede`).not.toMatch(
        /\b60\s*(?:min|minut)/i,
      );
    }
  });
});

/**
 * The per-day count, ported from `MuseByMina2/src/data.tsx` rather than
 * reinvented. The ticket names the three cases; the teens are the trap.
 */
describe('Croatian pluralisation of the session count', () => {
  it('takes the singular for n ending in 1, except the teens', () => {
    expect(classCount(1, 'hr')).toBe('1 termin');
    expect(classCount(21, 'hr')).toBe('21 termin');
    expect(classCount(101, 'hr')).toBe('101 termin');
    expect(classCount(11, 'hr')).toBe('11 termina');
    expect(classCount(111, 'hr')).toBe('111 termina');
  });

  it('takes the genitive plural for everything else', () => {
    for (const n of [0, 2, 3, 4, 5, 12, 22, 100]) {
      expect(classCount(n, 'hr')).toBe(`${n} termina`);
    }
  });

  it('pluralises English on its own rule', () => {
    expect(classCount(1, 'en')).toBe('1 class');
    for (const n of [0, 2, 11, 21]) expect(classCount(n, 'en')).toBe(`${n} classes`);
  });
});

/**
 * Design system invariants this page could break in ways `npm run ds` cannot
 * see: `ds` catches brand colours, not sizes or shadows.
 */
describe('design-system rules the component could break silently', () => {
  /** Every rule the schedule page actually loads — inline `<style>` and linked. */
  function pageCss(locale: Locale): string {
    const html = build.read(PAGE_FILE[locale]);
    const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
    const linked = linkHrefs(html, 'stylesheet')
      .map((href) => assetFile(build, href))
      .filter((file): file is string => file !== undefined && build.isFile(file))
      .map((file) => build.read(file));
    return [...inline, ...linked].join('\n');
  }

  it('never sets Cormorant below its 26px floor', () => {
    // The schedule is where this bites: the reference bundle sets the slot time
    // in --font-display at 1.25rem (20px), under the floor, which would cost
    // every Croatian đ in the time column its crossbar.
    const blocks = [...pageCss('hr').matchAll(/\{[^{}]*\}/g)].map((m) => m[0]!);
    const display = blocks.filter((b) => /font-family:\s*var\(--font-display\)/.test(b));
    expect(display.length, 'no --font-display rule found — is the CSS being read?')
      .toBeGreaterThan(0);

    const offenders = display.filter((block) => {
      // `clamp(min, …)` is a fluid size whose floor is the first value.
      const size = /font-size:\s*(?:clamp\(\s*)?([\d.]+)rem/.exec(block);
      return size !== null && Number(size[1]) * 16 < 26;
    });
    expect(offenders).toEqual([]);
  });

  it('adds no drop shadow', () => {
    const css = pageCss('hr');
    expect(css).not.toMatch(/box-shadow\s*:\s*(?!none)/);
    expect(css).not.toMatch(/filter\s*:\s*[^;}]*drop-shadow/);
  });
});

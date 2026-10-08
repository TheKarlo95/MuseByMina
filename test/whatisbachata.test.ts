import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PAGES_DEPLOY,
  basePath,
  buildFailure,
  buildSite,
  canonicalOf,
  type Build,
} from './helpers/build';
import { seedDocs, seededSchedule, type SeedDoc } from './helpers/seed';
import { servePages, type Host } from './helpers/serve';
import { fixtureOf, type FixtureDoc } from './helpers/structural-content';
import { LOCALES, type Locale } from '../src/lib/i18n';
import { MORE_NAV, PRIMARY_NAV } from '../src/lib/nav';
import { ROUTES } from '../src/lib/pages';
import { LEVELS, LEVEL_NAME, WEEKDAY_NAME, formatNames, minutesPhrase } from '../src/lib/schedule';
import { FIXTURE_ENV } from '../src/lib/sanity/fixture';
import { schemaTypes } from '../sanity/schemaTypes';
import { SINGLETON_TYPES } from '../sanity/schemaTypes';

/**
 * MUSE-65 — `/whatisbachata`, the one trust page whose content is general knowledge.
 *
 * ---------------------------------------------------------------------------------
 * **Why this page could be written and the other three could not.**
 *
 * MUSE-27 bundles four trust pages — `/faq`, `/firstclass`, `/whatisbachata`,
 * `/etiquette` — on the grounds that they share a shape: prose from the CMS. That is
 * right about the shape and wrong about the blocker. Three of the four are *studio
 * facts*: what to wear, where the door is, what happens when you arrive, which house
 * rules apply. None of those can be written without asking Mina, and MUSE-36 is what
 * happens when this repository writes studio facts nobody confirmed — thirteen invented
 * classes naming two instructors who do not exist, live.
 *
 * What bachata is, where it comes from and how it is counted is none of that. It is
 * general knowledge, verifiable, and owned by nobody.
 *
 * **So the content rule of this ticket is a rule about every sentence on the page**, and
 * it is the thing this file exists to hold:
 *
 *   - a sentence may describe **the dance**; or
 *   - it may state a fact **already published from the dataset** — the levels, the days,
 *     the length of a class, who teaches — and then it must be *read* from the dataset
 *     rather than retyped.
 *
 * Nothing else. In particular **no claim that this studio teaches a particular style.**
 * MUSE-36 deleted a `STYLES` enum (`['traditional','moderna','sensual']`) because those
 * three were invented alongside the fake schedule and had shaped a filter, three homepage
 * cards and a required `class.style` field; `test/sanity.test.ts` asserts that no field
 * anywhere in the schema is named after a style, *so that the decision has to be made
 * again rather than drifting back in*. This page is allowed to say that the styles exist,
 * because that is a fact about the dance. It is not allowed to say which are taught here,
 * and it may not reintroduce a style **as structure** — no enum, no filter, no field, no
 * per-style section that reads like a curriculum. The assertions under "the style trap"
 * below are the ones that would catch each of those.
 * ---------------------------------------------------------------------------------
 *
 * **The ordering trap, and why this is a two-step ticket.** `npm run build` fetches the
 * live dataset and `src/lib/sanity/decode.ts` fails the build by name when a document a
 * page needs is absent — so the route cannot land before the documents exist in
 * `production`. The branch prepares `content/seed.ndjson` *and* the route together, and
 * somebody runs `npm run sanity:seed` between review and merge (MUSE-59, MUSE-60).
 * "A missing document fails the build naming itself" is asserted at the bottom of this
 * file, because that failure is the guard working rather than a bug to route around.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ROUTE = '/whatisbachata';
const PROSE_ID = 'prose-whatisbachata';

const PAGE_FILE: Record<Locale, string> = {
  hr: 'whatisbachata/index.html',
  en: 'en/whatisbachata/index.html',
};

const WRAPPERS = ['src/pages/whatisbachata.astro', 'src/pages/en/whatisbachata.astro'];
const COMPONENT = 'src/components/WhatIsBachata.astro';

/** The `prosePage` document the committed seed publishes for this route. */
function seededProse(): SeedDoc {
  const found = seedDocs().filter(
    (doc) => doc._type === 'prosePage' && doc.route === ROUTE,
  );
  expect(found.map((doc) => doc._id), `one prosePage for ${ROUTE}`).toHaveLength(1);
  return found[0]!;
}

interface SeededSection {
  heading: Record<Locale, string>;
  body: Record<Locale, string>[];
}

function seededSections(doc: SeedDoc = seededProse()): SeededSection[] {
  return doc.sections as unknown as SeededSection[];
}

/**
 * Every word of the page's prose that comes out of the seed, both locales, flattened.
 *
 * `_type` and `_key` are deliberately not in here. `Object.values` over a `localeString`
 * also hands back `"localeString"`, and a paragraph's `_key` can be a two-byte needle
 * that matches inside a woff2 by coincidence — a failure with nothing wrong behind it
 * (the trap `test/aboutus.test.ts` names).
 */
function seededWords(doc: SeedDoc = seededProse()): string[] {
  const fields = [
    doc.heading as Record<Locale, string>,
    doc.lede as Record<Locale, string>,
    ...seededSections(doc).flatMap((section) => [section.heading, ...section.body]),
  ];
  const words = fields.flatMap((field) => LOCALES.map((locale) => field[locale]));
  expect(words.every((word) => typeof word === 'string' && word.trim() !== '')).toBe(true);
  expect(words.length).toBeGreaterThan(0);
  return words;
}

/** The component's own source, for the assertions that are about what it does not say. */
function componentSource(): string {
  return readFileSync(join(ROOT, COMPONENT), 'utf8');
}

/** Its `<style>` block alone. */
function componentStyle(): string {
  const source = componentSource();
  return source.slice(source.indexOf('<style>'));
}

/** Headings in document order, as `[level, text]`. */
function headings(html: string): [number, string][] {
  return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => [
    Number(m[1]),
    m[2]!.replace(/<[^>]*>/g, '').trim(),
  ]);
}

/** The page's own `<main>`, so the header's and footer's markup is out of the way. */
function main(html: string): string {
  const found = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html);
  expect(found, 'no <main> in the built page').not.toBeNull();
  return found![1]!;
}

let page: Build;
let host: Host;

beforeAll(async () => {
  // The committed seed, with no override: what the deploy will read once the dataset is
  // seeded, and therefore the only build that can say what a visitor sees.
  page = buildSite(PAGES_DEPLOY);
  host = await servePages(page);
}, 240_000);

afterAll(async () => {
  await host?.close();
});

/* ----------------------------------------------------------- the page is a page */

describe('AC1: /whatisbachata is a page of this site, in both locales', () => {
  it('publishes both locale pages from the committed seed', () => {
    expect(page.has(PAGE_FILE.hr)).toBe(true);
    expect(page.has(PAGE_FILE.en)).toBe(true);
  });

  it('answers 200 at the slashed spelling and 301s the other, through the Pages model', async () => {
    // The model `test/urls.test.ts` pins against the live deploy's observed behaviour.
    // `astro preview` answers both spellings with 200, so it cannot see this (MUSE-9).
    const base = basePath(page);
    for (const path of [`${base}whatisbachata/`, `${base}en/whatisbachata/`]) {
      expect(await host.get(path), path).toEqual({ status: 200, location: undefined });
    }
    expect(await host.get(`${base}whatisbachata`)).toEqual({
      status: 301,
      location: `${base}whatisbachata/`,
    });
  });

  it('declares a canonical that is itself and fetches 200, not a redirect', async () => {
    for (const locale of LOCALES) {
      const canonical = canonicalOf(page.read(PAGE_FILE[locale]));
      expect(canonical, locale).toBe(
        `${page.origin}${locale === 'hr' ? '' : '/en'}/whatisbachata/`,
      );
      // A canonical that 301s disqualifies itself and drops the hreflang cluster, which
      // is the whole of MUSE-9 — so it is fetched rather than eyeballed.
      expect(await host.getUrl(canonical!), locale).toEqual({
        status: 200,
        location: undefined,
      });
    }
  });

  it('appears in the sitemap and in llms.txt, at the URLs it is served at', () => {
    const sitemaps = page
      .allFiles()
      .filter((file) => file.endsWith('.xml'))
      .map((file) => page.read(file))
      .join('\n');
    expect(sitemaps, 'no sitemap in the output').toContain('<loc>');

    for (const locale of LOCALES) {
      const url = `${page.origin}${locale === 'hr' ? '' : '/en'}/whatisbachata/`;
      expect(sitemaps, locale).toContain(`<loc>${url}</loc>`);
      expect(page.read('llms.txt'), locale).toContain(url);
    }
  });

  it('is one route in ROUTES, two files under src/pages/, and one `page` document', () => {
    // MUSE-46's three-way agreement, stated here because *this* ticket is the one that
    // could ship two of the three: a route with no document is a red build, a route with
    // no file is a dead link in `llms.txt`.
    expect(ROUTES.map((entry) => entry.route)).toContain(ROUTE);
    for (const file of WRAPPERS) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
    }
    expect(
      seedDocs().filter((doc) => doc._type === 'page' && doc.route === ROUTE).map((d) => d._id),
    ).toHaveLength(1);
  });

  it('meets the reader before the schedule does, in ROUTES order', () => {
    // `llms.txt` and the Studio dropdown are both in this order, and `src/lib/pages.ts`
    // says what the order means: what the dance is, then what is on, then what it costs.
    // An explainer listed after the timetable is an explainer for somebody who has
    // already decided.
    const order = ROUTES.map((entry) => entry.route);
    expect(order.indexOf(ROUTE)).toBeGreaterThan(order.indexOf('/'));
    expect(order.indexOf(ROUTE)).toBeLessThan(order.indexOf('/schedule'));
  });

  it('puts BaseLayout first in each wrapper, because import position is the cascade', () => {
    // There is no config for stylesheet order in Astro; the import position is the only
    // lever, and `test/cascade.test.ts` asserts the resulting `<head>` against `dist`.
    // Said here too, because a page wrapper is where somebody reorders imports to be
    // tidy — it happened twice in one afternoon (MUSE-35, MUSE-20).
    for (const file of WRAPPERS) {
      const imports = [...readFileSync(join(ROOT, file), 'utf8').matchAll(/^import .*$/gm)];
      expect(imports.length, file).toBeGreaterThan(1);
      expect(imports[0]![0], file).toMatch(/BaseLayout/);
    }
  });

  it('is in the nav, so the entry resolves rather than 404ing, in both locales', () => {
    // MUSE-13's rule: each page ticket re-adds its own entry as part of being done.
    // `test/nav.test.ts` follows every link in the built output and is what makes that a
    // test rather than a convention — in both directions, since MUSE-37.
    const entry = [...PRIMARY_NAV, ...MORE_NAV].find((item) => item.route === ROUTE);
    expect(entry, `${ROUTE} is not in src/lib/nav.ts`).toBeDefined();
    expect(entry!.label.hr).toBeTruthy();
    expect(entry!.label.en).toBeTruthy();

    for (const locale of LOCALES) {
      const href = `${basePath(page)}${locale === 'hr' ? '' : 'en/'}whatisbachata/`;
      expect(
        page.read(PAGE_FILE[locale]).includes(`href="${href}"`),
        `${locale} page carries no link to ${href}`,
      ).toBe(true);
    }
  });
});

/* ------------------------------------------------- the content model, built for four */

/**
 * **One document type, designed for four pages and used for one.**
 *
 * `/faq`, `/firstclass` and `/etiquette` want the same shape — a heading, a line of
 * lede, then a few sections of paragraphs — so the type is `prosePage` rather than
 * `whatIsBachata`, and it is keyed by **route**, exactly as `page` is: the Studio builds
 * its dropdown from `ROUTES` (`sanity/schemaTypes/enums.ts`), so a document cannot
 * describe a page the site does not serve.
 *
 * **The body is an array of bilingual paragraphs, not `localeRichText`**, and that is a
 * decision rather than the easier option. `localeRichText` already exists and is Portable
 * Text; nothing in this repository renders it — `post.body` is deliberately typed as
 * opaque `unknown[]` until a blog ticket picks a renderer — so the first consumer would
 * have to build one, and Mina would get headings, bold and links inside a paragraph where
 * the design system fixes the type scale anyway (§4). `studioStory.story` made the same
 * call for the same reasons and the argument is written out there.
 */
describe('AC: the document type is designed for the other three trust pages', () => {
  const prosePage = () => {
    const found = (schemaTypes as unknown as { name: string }[]).find(
      (type) => type.name === 'prosePage',
    );
    expect(found, 'there is no `prosePage` type in the schema').toBeDefined();
    return found as unknown as {
      name: string;
      type: string;
      title?: string;
      fields?: {
        name: string;
        title?: string;
        description?: string;
        type: string;
        of?: { fields?: { name: string; type: string }[] }[];
      }[];
    };
  };

  it('is a document type, not a singleton, so a second page is a second document', () => {
    expect(prosePage().type).toBe('document');
    // A singleton is pinned to a fixed `_id` and would hold exactly one page's prose.
    expect([...SINGLETON_TYPES]).not.toContain('prosePage');
  });

  it('is keyed by route, so the Studio cannot describe a page the site does not serve', () => {
    const route = prosePage().fields?.find((field) => field.name === 'route');
    expect(route, '`prosePage` has no `route` field').toBeDefined();
    expect(route!.type).toBe('string');
  });

  it('carries a heading, a lede and sections of paragraphs — the shape all four want', () => {
    const fields = prosePage().fields ?? [];
    const byName = new Map(fields.map((field) => [field.name, field]));
    expect([...byName.keys()].sort()).toEqual(['heading', 'lede', 'route', 'sections']);
    expect(byName.get('heading')!.type).toBe('localeString');
    expect(byName.get('lede')!.type).toBe('localeText');
    expect(byName.get('sections')!.type).toBe('array');

    const member = byName.get('sections')!.of?.[0];
    expect(member?.fields?.map((field) => field.name)).toEqual(['heading', 'body']);
    expect(member?.fields?.find((f) => f.name === 'heading')?.type).toBe('localeString');
    expect(member?.fields?.find((f) => f.name === 'body')?.type).toBe('array');
  });

  it('uses no Portable Text, because nothing in this repo renders it', () => {
    // `localeRichText` exists (`post.body`) and is deliberately opaque `unknown[]`. A
    // prose page that used it would be the first consumer, and would need a renderer
    // before it could render a sentence. The paragraph array is what the page actually
    // renders — the same decision `studioStory.story` took.
    const member = prosePage().fields?.find((field) => field.name === 'sections')?.of?.[0];
    const body = member?.fields?.find((field) => field.name === 'body');
    expect(body?.type).toBe('array');
    expect(JSON.stringify(prosePage())).not.toContain('localeRichText');
  });

  it('adds no image field, because there is no photography of this studio', () => {
    // The optional-field argument (MUSE-23, MUSE-36): a field with no real value can only
    // be filled with fiction. `imageField()` is the only way to add one when there is a
    // photograph — see `sanity/schemaTypes/objects/image.ts`.
    expect(JSON.stringify(prosePage())).not.toContain('"image"');
  });

  it('gives every field Mina types into a label and an explanation', () => {
    // `test/sanity.test.ts` holds this across the whole schema; said here because a new
    // type is where it is forgotten, and a field description is her only instruction.
    const walk = (fields: typeof prosePage extends never ? never : NonNullable<ReturnType<typeof prosePage>['fields']>): string[] =>
      fields.flatMap((field) => [
        ...(field.title ? [] : [`${field.name} has no title`]),
        ...(field.description ? [] : [`${field.name} has no description`]),
      ]);
    expect(walk(prosePage().fields ?? [])).toEqual([]);
  });
});

/* --------------------------------------------------------- the prose, from the CMS */

describe('AC2: every word of the prose comes from the dataset', () => {
  it('renders the seeded heading as the page’s one h1, in both locales', () => {
    const doc = seededProse();
    for (const locale of LOCALES) {
      const html = page.read(PAGE_FILE[locale]);
      const h1 = headings(html).filter(([level]) => level === 1);
      expect(h1, `${locale} h1 count`).toHaveLength(1);
      expect(h1[0]![1]).toBe((doc.heading as Record<Locale, string>)[locale]);
    }
  });

  it('renders the lede, every section heading and every paragraph', () => {
    const doc = seededProse();
    expect(seededSections(doc).length, 'the seeded page has no sections').toBeGreaterThan(2);

    for (const locale of LOCALES) {
      const html = main(page.read(PAGE_FILE[locale]));
      expect(html, `${locale} lede`).toContain((doc.lede as Record<Locale, string>)[locale]);
      for (const section of seededSections(doc)) {
        expect(html, `${locale}: ${section.heading[locale]}`).toContain(
          section.heading[locale],
        );
        expect(section.body.length).toBeGreaterThan(0);
        for (const paragraph of section.body) {
          expect(html, `${locale}: ${paragraph[locale]}`).toContain(paragraph[locale]);
        }
      }
    }
  });

  it('keeps the sections and the paragraphs in the order the dataset lists them', () => {
    // An array that lost its order is an explanation given backwards, and no decoder can
    // see it: every paragraph is present and every one is well-formed.
    const sections = seededSections();
    const html = main(page.read(PAGE_FILE.hr));
    const positions = sections.map((section) => html.indexOf(section.heading.hr));
    expect(positions.every((at) => at >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    for (const section of sections) {
      const at = section.body.map((paragraph) => html.indexOf(paragraph.hr));
      expect([...at].sort((a, b) => a - b)).toEqual(at);
    }
  });

  it('skips no heading level: h1, then h2 sections, and nothing deeper unannounced', () => {
    for (const locale of LOCALES) {
      const levels = headings(page.read(PAGE_FILE[locale])).map(([level]) => level);
      expect(levels[0], `${locale} starts below h1`).toBe(1);
      for (let i = 1; i < levels.length; i += 1) {
        expect(
          levels[i]! - levels[i - 1]!,
          `${locale} jumps from h${levels[i - 1]} to h${levels[i]}`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('holds no prose of its own in the component — only interface chrome', () => {
    /**
     * The MUSE-36 rule, applied to the file somebody would reach for. A paragraph of
     * placeholder prose in a component looks finished and is one deploy away from being
     * published as fact; prose in `content/seed.ndjson` is a sentence Mina types over.
     *
     * Checked as a length ceiling on the component's own strings rather than as a list of
     * allowed words: a label is short and a sentence is not, and this catches the next
     * paragraph rather than the ones written today.
     */
    const frontmatter = componentSource().split('---')[1] ?? '';
    const strings = [...frontmatter.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]!);
    const sentences = strings.filter((value) => value.trim().split(/\s+/).length > 4);
    expect(sentences, 'the component writes prose — put it in the seed').toEqual([]);
  });
});

/* ------------------------------------------------------------------ the style trap */

/**
 * **MUSE-36's deleted `STYLES` enum, and the four ways it could come back.**
 *
 * The page is allowed to say that the traditional Dominican, modern and sensual styles
 * exist and differ — that is a fact about the dance, verifiable, and owned by nobody. It
 * is not allowed to say or imply which of them this studio teaches, and it must not put a
 * style back into the *structure* of the site.
 */
describe('AC3: the page explains the styles and claims none of them', () => {
  it('models no style anywhere in the schema, this type included', () => {
    // The same absence `test/sanity.test.ts` asserts, restated against the type this
    // ticket adds — because that suite's version would pass a `prosePage` with a
    // `styles` array on it only by having been written before this type existed.
    const stylish = JSON.stringify(schemaTypes).match(/"name":"[^"]*style[^"]*"/gi) ?? [];
    expect(stylish).toEqual([]);
  });

  it('routes no per-style page and offers no style filter', () => {
    // A `/sensual` route, or a filter over styles, is the invented dimension back as
    // structure rather than as a sentence.
    for (const { route } of ROUTES) {
      expect(route).not.toMatch(/traditional|moderna|sensual/i);
    }
    expect(componentSource()).not.toMatch(/data-(?:style|filter)/);
  });

  it('says the styles exist, as one paragraph rather than a section each', () => {
    /**
     * A section per style reads as a curriculum whatever its words say — three headings,
     * three blocks, in the shape a course outline has. So the three names have to appear
     * **together, in one paragraph**, and no section heading may be a style name.
     *
     * `sensual` is the needle rather than all three names at once, because „Dominikanska
     * Republika" is also where the dance comes from: the origin paragraph names the
     * country and is not naming a style. `sensual` and `moderna` are the two words that
     * can only be style names here, and the paragraph they are in has to name the third.
     */
    const sections = seededSections();
    for (const section of sections) {
      for (const locale of LOCALES) {
        expect(
          section.heading[locale],
          `a section heading is a style name: ${section.heading[locale]}`,
        ).not.toMatch(/\b(?:traditional|tradicionaln\w*|moderna|modern|sensual)\b/i);
      }
    }

    const paragraphs = sections.flatMap((section) => section.body);
    for (const needle of [/\bsensual\b/i, /\bmoderna?\b/i]) {
      const naming = paragraphs.filter((paragraph) =>
        LOCALES.some((locale) => needle.test(paragraph[locale])),
      );
      expect(naming.length, `${needle} is named in ${naming.length} paragraphs, not 1`).toBe(1);
      // All three together, so "the styles exist and they differ" is actually said rather
      // than one style being singled out — which is the shape a curriculum claim has.
      for (const locale of LOCALES) {
        expect(naming[0]![locale], locale).toMatch(/dominikansk|dominican/i);
        expect(naming[0]![locale], locale).toMatch(/\bmoderna?\b/i);
        expect(naming[0]![locale], locale).toMatch(/\bsensual\b/i);
      }
    }
  });

  it('never says the studio teaches one, and points at the schedule instead', () => {
    /**
     * The sentence that makes the rule legible to a reader rather than only to this test:
     * the page says in its own words that it describes the dance and that what is taught
     * is on the schedule. Asserted as a link, because a claim with nowhere to check it is
     * the shape MUSE-36 shipped in.
     */
    for (const locale of LOCALES) {
      const html = main(page.read(PAGE_FILE[locale]));
      const href = `${basePath(page)}${locale === 'hr' ? '' : 'en/'}schedule/`;
      expect(html, `${locale} does not link the schedule`).toContain(`href="${href}"`);
    }
  });
});

/* --------------------------------------------------- the studio facts, read not typed */

/**
 * **What the page may say about the classes, and where it has to get it.**
 *
 * Only what is already published: four levels in dancer order, two evenings a week,
 * 90 minutes, Mina and Antonio. Every one of those is read off `getSchedule()` rather
 * than retyped — MUSE-50 is the ticket about a literal that happened to match, and the
 * assertion a literal survives is every equality assertion there is.
 */
describe('AC4: the published facts about the classes are read from the dataset', () => {
  const rows = () => seededSchedule();

  it('names the levels the timetable actually has, in dancer order', () => {
    const levels = LEVELS.filter((level) => rows().some((row) => row.level === level));
    expect(levels.length, 'the seeded timetable has no levels').toBeGreaterThan(0);

    for (const locale of LOCALES) {
      const html = main(page.read(PAGE_FILE[locale]));
      let at = -1;
      for (const level of levels) {
        const next = html.indexOf(LEVEL_NAME[locale][level], at + 1);
        expect(next, `${locale} does not name ${level} after the previous one`).toBeGreaterThan(at);
        at = next;
      }
    }
  });

  it('names the evenings the timetable runs on, in week order', () => {
    const days = [...new Set(rows().map((row) => row.day))];
    expect(days.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const html = main(page.read(PAGE_FILE[locale]));
      for (const day of days) {
        expect(html, `${locale} does not name ${day}`).toContain(
          WEEKDAY_NAME[locale][day as keyof (typeof WEEKDAY_NAME)['hr']],
        );
      }
    }
  });

  it('states the class length as the data says it, pluralised per locale', () => {
    const lengths = [...new Set(rows().map((row) => row.durationMin))];
    expect(lengths, 'the seeded classes differ in length — the page claims one').toHaveLength(1);
    for (const locale of LOCALES) {
      expect(main(page.read(PAGE_FILE[locale])), locale).toContain(
        minutesPhrase(lengths[0]!, locale),
      );
    }
  });

  it('names who teaches, joined the way the rest of the site joins names', () => {
    const teachers = [...new Set(rows().flatMap((row) => row.instructors))];
    expect(teachers.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      expect(main(page.read(PAGE_FILE[locale])), locale).toContain(
        formatNames(teachers, locale),
      );
    }
  });

  it('claims nothing checkable that the dataset does not say', () => {
    /**
     * A founding date, a student count, an award, a claim about anybody's training. A
     * fabricated `foundedOn: "2025-01-01"` sat in the live dataset for most of one day
     * because a `required()` field could only be satisfied by inventing one (MUSE-60);
     * MUSE-36 is the larger version of the same move.
     *
     * Read off the **built page**, which is the text a visitor is actually shown, plus
     * the seeded prose, which is the text a reviewer reads in the dataset. Deliberately
     * *not* over `componentSource()`: the paragraph above this assertion in
     * `WhatIsBachata.astro` lists the four forbidden claims by name, so a scan of the
     * source matches the rule's own statement of itself — the trap `test/contentdrift
     * .test.ts` names as "prose in a comment is believed rather than noticed", with the
     * sign reversed. "The component writes no prose" is the assertion above, and it is
     * the one that reaches this file.
     *
     * A *decade* is allowed — "the 1980s and 1990s" is when the dance spread, which is
     * exactly the general knowledge the page is for. A **year** is not: that is the shape
     * a founding date has.
     */
    const text = [...seededWords(), ...LOCALES.map((l) => main(page.read(PAGE_FILE[l])))].join(
      '\n',
    );
    expect(text, 'a year is claimed').not.toMatch(
      /\b(?:19|20)\d{2}\.?(?=\s*(?:godine|year|\.|,|<|$))/m,
    );
    expect(text, 'a student count is claimed').not.toMatch(
      /\b\d{2,}\s*(?:polaznik\w*|učenik\w*|students?|dancers?|members?)/i,
    );
    expect(text, 'an award is claimed').not.toMatch(
      /\b(?:nagrad\w*|award|champion\w*|prvak\w*|certified|certificir\w*)/i,
    );
    expect(text, "somebody's training is claimed").not.toMatch(
      /\b(?:diplom\w*|škol(?:a|ovan)\w*|trained|studied under|godina iskustva|years of experience)\b/i,
    );
  });
});

/* ------------------------------------------------- design-system rules, silently broken */

describe('design-system rules this component could break silently', () => {
  it('never sets Cormorant below its 26px floor', () => {
    // §4: below ~24px the `đ` crossbar disappears and *Dođi* renders as "Dodi".
    // 1.625rem is 26px, and `clamp()`'s first argument is the floor.
    const style = componentStyle();
    const displayRules = [...style.matchAll(/font-family:\s*var\(--font-display\)/g)];
    expect(displayRules.length, 'nothing uses the display face').toBeGreaterThan(0);

    for (const m of style.matchAll(/font-size:\s*clamp\(\s*([\d.]+)rem/g)) {
      expect(Number(m[1]), `clamp floor ${m[1]}rem is below Cormorant's 26px`).toBeGreaterThanOrEqual(
        1.625,
      );
    }
  });

  it('renders Croatian diacritics as characters rather than as entities', () => {
    // `đ`, `č`, `ć`, `ž`, `š` have to reach the page as themselves for the font to be
    // able to draw them at all — and the h1 is where a missing crossbar is most visible.
    for (const locale of LOCALES) {
      const html = page.read(PAGE_FILE[locale]);
      expect(html).not.toMatch(/&#(?:273|269|263|382|353);/);
    }
    expect(main(page.read(PAGE_FILE.hr))).toMatch(/[čćžšđ]/);
  });

  it('adds no drop shadow, in either theme', () => {
    expect(componentStyle()).not.toMatch(/box-shadow|drop-shadow/);
  });

  it('never redeclares the document’s numerals', () => {
    // `font-variant-numeric` is one inherited value, set once in `src/styles/base.css`.
    // A component that declares it *replaces* `lining-nums tabular-nums` and brings back
    // MUSE-14's `I9:OO` with the column still neatly aligned. `npm run ds` is the gate.
    expect(componentStyle()).not.toMatch(/font-variant-numeric|font-feature-settings/);
  });

  it('references a role token and never a brand colour', () => {
    expect(componentStyle()).not.toMatch(/var\(\s*--(?:plum|gold|cream|red|green)[a-z-]*\s*[,)]/);
    expect(componentStyle()).not.toMatch(/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/);
  });

  it('measures the prose rather than letting it run the full width', () => {
    // §5: prose measures around 68ch, as a `max-width` so Croatian — 20–25% longer than
    // English (§10) — reflows instead of being clipped.
    expect(componentStyle()).toMatch(/max-width:\s*\d+ch/);
  });

  it('sizes nothing that holds Croatian to a fixed pixel width', () => {
    const fixed = [...componentStyle().matchAll(/^\s*(?:width|min-width):\s*(\d+)px/gm)];
    expect(fixed.map((m) => m[0]!.trim())).toEqual([]);
  });
});

/* ------------------------------------------------- the teeth: an edited dataset moves it */

/**
 * **The assertion a hardcoded copy fails while every equality test passes** (MUSE-50).
 *
 * Comparing the built page to the seed it just read proves the two agree; it does not
 * prove the page read anything. So the site is rebuilt from an *edited* dataset and the
 * edited words have to be on the page — and the seeded words have to be gone from the
 * output, every byte of it.
 */
/**
 * The `page` document is edited alongside the `prosePage` one, and only because **the
 * `<title>` legitimately repeats the heading**: the seeded `<h1>` is „Što je bachata?" and
 * the seeded `<title>` is „Što je bachata? — Muse by Mina", so the heading is a substring
 * of a *different field of a different document* that this edit does not otherwise touch.
 *
 * That is a copy in the **dataset**, which is where a copy is allowed to be — Mina wrote
 * both strings and she would reword both together. The fixture does the rewording so that
 * "the seeded prose appears nowhere in the output" can be the flat claim it ought to be
 * rather than an assertion with a carve-out a real literal could hide inside. Exactly the
 * move `test/contentdrift.test.ts` makes with `siteSettings.summary`, and the test below
 * that fixture asserts the reason is still true.
 */
const EDITED_META = {
  title: { hr: 'HR uređeni naslov kartice', en: 'EN edited tab title' },
  description: { hr: 'HR uređeni opis stranice.', en: 'EN edited page description.' },
};

const EDITED = {
  heading: { hr: 'HR uređeni naslov stranice', en: 'EN edited page heading' },
  lede: { hr: 'HR uređeni uvodni odlomak.', en: 'EN edited lede paragraph.' },
  sections: [
    {
      heading: { hr: 'HR uređeni naslov odjeljka', en: 'EN edited section heading' },
      body: [
        { hr: 'HR uređeni prvi odlomak.', en: 'EN edited first paragraph.' },
        { hr: 'HR uređeni drugi odlomak.', en: 'EN edited second paragraph.' },
      ],
    },
    {
      heading: { hr: 'HR drugi uređeni naslov', en: 'EN second edited heading' },
      body: [{ hr: 'HR uređeni treći odlomak.', en: 'EN edited third paragraph.' }],
    },
  ],
};

let edited: Build;

beforeAll(() => {
  const prose = seededProse();
  const meta = seedDocs().find((doc) => doc._type === 'page' && doc.route === ROUTE)!;
  edited = buildSite(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf(
      [
        ...seedDocs().filter((doc) => doc._id !== prose._id && doc._id !== meta._id),
        {
          ...meta,
          title: { _type: 'localeString', ...EDITED_META.title },
          description: { _type: 'localeString', ...EDITED_META.description },
        },
        {
          ...prose,
          heading: { _type: 'localeString', ...EDITED.heading },
          lede: { _type: 'localeText', ...EDITED.lede },
          sections: EDITED.sections.map((section, index) => ({
            _key: `edited-${index}`,
            _type: 'prosePageSection',
            heading: { _type: 'localeString', ...section.heading },
            body: section.body.map((paragraph, at) => ({
              _key: `edited-${index}-${at}`,
              _type: 'localeText',
              ...paragraph,
            })),
          })),
        },
      ] as FixtureDoc[],
      'whatisbachata-edited',
    ),
  });
}, 240_000);

describe('AC5: the prose is in the dataset, and an edit moves the page', () => {
  it('edits to something that really differs from the seed', () => {
    // Otherwise every assertion below is satisfied by a literal in the component.
    const seeded = seededWords();
    const words = [
      EDITED.heading,
      EDITED.lede,
      ...EDITED.sections.flatMap((section) => [section.heading, ...section.body]),
    ].flatMap((field) => LOCALES.map((locale) => field[locale]));
    expect(words.some((word) => seeded.includes(word))).toBe(false);
  });

  it('publishes the edited heading, lede, section headings and paragraphs', () => {
    for (const locale of LOCALES) {
      const html = edited.read(PAGE_FILE[locale]);
      expect(html, `${locale} heading`).toContain(EDITED.heading[locale]);
      expect(html, `${locale} lede`).toContain(EDITED.lede[locale]);
      for (const section of EDITED.sections) {
        expect(html, `${locale}: ${section.heading[locale]}`).toContain(
          section.heading[locale],
        );
        for (const paragraph of section.body) {
          expect(html, `${locale}: ${paragraph[locale]}`).toContain(paragraph[locale]);
        }
      }
    }
  });

  it('moves the heading inside the <title> too, or the claim below is not flat', () => {
    // A guard against this fixture going subtly wrong. If the seeded `<title>` ever stops
    // repeating the heading, the `page`-document edit above is a no-op and the next test
    // is weaker than it looks — so say that out loud rather than letting it drift.
    const meta = seedDocs().find((doc) => doc._type === 'page' && doc.route === ROUTE)!;
    const heading = seededProse().heading as Record<Locale, string>;
    const titles = meta.title as Record<Locale, string>;
    const repeats = LOCALES.filter((locale) => titles[locale].includes(heading[locale]));
    expect(
      repeats,
      'the seeded <title> no longer repeats the <h1> — drop the `page` edit above',
    ).toEqual([...LOCALES]);
  });

  it('leaves the seeded prose nowhere in the output — not one byte', () => {
    const words = seededWords();
    const stale = edited
      .allFiles()
      .filter((file) =>
        words.some((word) => readFileSync(join(edited.outDir, file)).includes(word)),
      );
    expect(stale).toEqual([]);
  });

  it('still renders exactly one h1, whatever the dataset says', () => {
    for (const locale of LOCALES) {
      const h1 = headings(edited.read(PAGE_FILE[locale])).filter(([level]) => level === 1);
      expect(h1.map(([, text]) => text), locale).toEqual([EDITED.heading[locale]]);
    }
  });
});

/* ------------------------------------------- the ordering trap, as a build that must fail */

describe('AC6: a missing or duplicated document fails the build, naming itself', () => {
  /**
   * **Why this ticket is two steps.** `npm run build` fetches the live dataset and the
   * route exists now, so a dataset with no `prosePage` for this route stops the site
   * building: every pull request, every deploy, MUSE-21's scheduled rebuild.
   *
   * That is the correct behaviour — `src/lib/sanity/decode.ts` exists to refuse
   * publishing a heading above nothing — and it is *also* why the pull request may not be
   * merged before `npm run sanity:seed` has run. Asserted against a real build rather
   * than a decoder called in isolation: the decoder existing says nothing about whether
   * the build calls it.
   */
  it('names the type and the route when the document is absent', () => {
    const without = fixtureOf(
      seedDocs().filter((doc) => doc._id !== PROSE_ID) as FixtureDoc[],
      'whatisbachata-no-prose',
    );
    const output = buildFailure(PAGES_DEPLOY, { [FIXTURE_ENV]: without });
    expect(output).toContain('prosePage');
    expect(output).toContain(ROUTE);
  });

  it('does not call it transient, because a dataset will not seed itself', () => {
    // MUSE-21's retry greps the failed build for `TRANSIENT_BUILD_FAILURE` and runs it
    // three times. A missing document will not be there on the third attempt, so this
    // failure must not carry that word (the trap `test/pricing.test.ts` names).
    const without = fixtureOf(
      seedDocs().filter((doc) => doc._id !== PROSE_ID) as FixtureDoc[],
      'whatisbachata-no-prose-transient',
    );
    expect(buildFailure(PAGES_DEPLOY, { [FIXTURE_ENV]: without })).not.toContain(
      'TRANSIENT_BUILD_FAILURE',
    );
  });

  it('names the route when two documents describe it', () => {
    // Which heading the page got would otherwise depend on query order — the same reason
    // two `page` documents for one route is an error (`pagesByRoute`).
    const twice = fixtureOf(
      [...seedDocs(), { ...seededProse(), _id: `${PROSE_ID}-copy` }] as FixtureDoc[],
      'whatisbachata-two-prose',
    );
    const output = buildFailure(PAGES_DEPLOY, { [FIXTURE_ENV]: twice });
    expect(output).toContain(ROUTE);
    expect(output).toContain(`${PROSE_ID}-copy`);
  });
});

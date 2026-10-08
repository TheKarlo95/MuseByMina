import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The build gate itself, so `npm test` asserts properties of the gate rather than
// restating them. `SOURCE_GLOBS` is the list `.github/workflows/studio.yml` has to match.
import { fingerprint, SOURCE_GLOBS } from '../scripts/check-sanity.mjs';
import { schemaTypes, SINGLETON_TYPES } from '../sanity/schemaTypes';
import { SOCIAL_PLATFORMS, SOCIAL_PLATFORM_NAME } from '../sanity/schemaTypes/enums';
import { LEVELS, LEVEL_NAME, WEEKDAYS, WEEKDAY_NAME } from '../src/lib/schedule';
import { ROUTES } from '../src/lib/pages';
import { LOCALES } from '../src/lib/i18n';
import {
  decodeFaq,
  decodeInstructor,
  decodeScheduleEntry,
  requireDocument,
  requireDocuments,
  SanityContentError,
  SanityUnavailableError,
} from '../src/lib/sanity/decode';
// Imported for its side effect on the type checker: the module is nothing but
// compile-time assertions binding the generated types to the site's own types, and this
// import is what guarantees `astro check` and `vitest` both evaluate them.
import { SCHEMA_ASSERTIONS } from '../src/lib/sanity/shape';

/**
 * MUSE-19 — the Sanity schema and the typed read path.
 *
 * Five things are asserted here, each for a different failure:
 *
 *   1. **The Studio Mina opens.** Every document type exists, every field she types into
 *      has a label and an explanation in Croatian, every required field is marked, and
 *      every image field has a hotspot. These are read off the schema *definitions*, so
 *      they cannot drift from what the Studio renders.
 *   2. **The closed sets stay closed.** The level and weekday options the Studio offers
 *      are the same constants `src/lib/schedule.ts` renders from — not copies of them.
 *      This is MUSE-11's guarantee carried across the CMS boundary, and MUSE-36's fourth
 *      level is the first time it has had to move. The *style* set is asserted as an
 *      absence now, which is the same mechanism pointed the other way.
 *   3. **One typed client.** No GROQ, and no Sanity client, anywhere under `src/` except
 *      `src/lib/sanity/`. Read off the source tree, like `test/isolation.test.ts`.
 *   4. **A missing or malformed document fails, naming itself.** The decoders are run
 *      against hand-written documents, broken in the ways a CMS actually breaks them,
 *      and the error messages are asserted to contain the document id and the field path.
 *   5. **Empty is not broken.** The three outcomes — unreachable, empty, malformed — are
 *      distinguishable by type, because most of the dataset is legitimately empty and
 *      "nothing came back" has to be readable as which of the three it was.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Every file under `dir`, recursively, with no extension filter. */
function walkTree(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walkTree(full) : [full];
    })
    .sort();
}

/** Document types the ticket requires. Spelled out, so dropping one is a failure. */
const REQUIRED_DOCUMENT_TYPES = [
  'class',
  'scheduleSlot',
  'instructor',
  'pricingTier',
  'event',
  'galleryImage',
  'post',
  'faq',
  'page',
  'siteSettings',
  'studioStory',
] as const;

/** A field definition as the schema modules write them, loosely enough to walk. */
interface FieldLike {
  name: string;
  title?: string;
  description?: string;
  type: string;
  options?: Record<string, unknown>;
  fields?: FieldLike[];
  of?: FieldLike[];
  validation?: unknown;
}

interface TypeLike {
  name: string;
  title?: string;
  type: string;
  fields?: FieldLike[];
}

const types = schemaTypes as unknown as TypeLike[];

function typeNamed(name: string): TypeLike {
  const found = types.find((type) => type.name === name);
  if (!found) throw new Error(`No schema type named \`${name}\`.`);
  return found;
}

/** Every field in the schema, with the path it sits at — nested fields included. */
function allFields(): { path: string; field: FieldLike }[] {
  const out: { path: string; field: FieldLike }[] = [];
  const visit = (prefix: string, fields: FieldLike[] | undefined): void => {
    for (const field of fields ?? []) {
      const path = `${prefix}.${field.name}`;
      out.push({ path, field });
      visit(path, field.fields);
      for (const member of field.of ?? []) visit(`${path}[]`, member.fields);
    }
  };
  for (const type of types) visit(type.name, type.fields);
  return out;
}

/**
 * Does a field require a value?
 *
 * `validation` is a function, so it cannot be inspected without calling it. The extracted
 * schema is the right place to read this from instead — `sanity schema extract
 * --enforce-required-fields` writes `optional: false` for exactly the fields whose
 * validation requires a value, and it is the same file `sanity typegen` reads, so the
 * answer here and the generated types can never disagree.
 */
interface ExtractedAttributes {
  [field: string]: { optional?: boolean };
}

/**
 * A document type carries its `attributes` at the top level; a named object type carries
 * them under `value`, because it is a *type* alias rather than a document. Both are read
 * here so the required-field assertions can cover `localeString` as well as `faq`.
 */
interface Extracted {
  name: string;
  type: string;
  attributes?: ExtractedAttributes;
  value?: { type: string; attributes?: ExtractedAttributes };
}

const extracted: Extracted[] = JSON.parse(
  readFileSync(join(ROOT, 'sanity/schema.json'), 'utf8'),
);

function extractedType(name: string): Extracted {
  const found = extracted.find((type) => type.name === name);
  if (!found) throw new Error(`\`${name}\` is not in sanity/schema.json.`);
  return found;
}

function requiredFieldsOf(name: string): string[] {
  const type = extractedType(name);
  const attributes = type.attributes ?? type.value?.attributes ?? {};
  return Object.entries(attributes)
    .filter(([key, value]) => !key.startsWith('_') && value.optional === false)
    .map(([key]) => key)
    .sort();
}

/* ------------------------------------------------------------------ 1. the Studio */

describe('the Studio Mina opens', () => {
  it('has every document type the site needs', () => {
    const documents = types.filter((type) => type.type === 'document').map((type) => type.name);
    expect(documents.sort()).toEqual([...REQUIRED_DOCUMENT_TYPES].sort());
  });

  it('is also what the extracted schema says, so the generated types agree', () => {
    const documents = extracted
      .filter((type) => type.type === 'document' && !type.name.startsWith('sanity.'))
      .map((type) => type.name);
    expect(documents.sort()).toEqual([...REQUIRED_DOCUMENT_TYPES].sort());
  });

  it('names every document type in a language Mina reads', () => {
    for (const name of REQUIRED_DOCUMENT_TYPES) {
      // Schema names are English because code reads them; titles are what she reads.
      expect(typeNamed(name).title, name).toBeTruthy();
    }
  });

  it('gives every field she types into a label', () => {
    const unlabelled = allFields()
      .filter(({ field }) => !field.title)
      .map(({ path }) => path);
    expect(unlabelled).toEqual([]);
  });

  it('explains every field that is not self-evident', () => {
    /**
     * Field descriptions are Mina's only instructions — there is no onboarding document
     * she will keep open while editing — so a field without one is a field she has to
     * guess at.
     *
     * The exemptions are the fields whose label already says everything: a locale leaf
     * inside a bilingual object (its parent carries the explanation), and the handful
     * where "Naziv" or "Kraj" is the whole story.
     */
    const SELF_EVIDENT = [
      'event.title',
      'event.endsAt',
      'event.description',
      'post.title',
      'post.body',
      'pricingTier.name',
      'faq.question',
      'faq.answer',
      'instructor.role',
      'scheduleSlot.day',
      'class.description',
      'siteSettings.tagline',
      'siteSettings.address',
      'siteSettings.phone',
    ];

    const selfEvident = (path: string): boolean =>
      // A locale leaf inside a bilingual object: the parent object carries the
      // explanation, and repeating it on `hr` and `en` would be noise on every field.
      /\.(hr|en)$/.test(path) || SELF_EVIDENT.includes(path);

    const unexplained = allFields()
      .filter(({ path, field }) => !field.description && !selfEvident(path))
      .map(({ path }) => path);
    expect(unexplained).toEqual([]);
  });

  it('marks the fields a page cannot render without', () => {
    // Read off the extracted schema, which records `optional: false` for exactly the
    // fields whose validation requires a value — so this asserts what the Studio shows
    // *and* what `sanity typegen` believes, in one go.
    expect(requiredFieldsOf('faq')).toEqual(['answer', 'question']);
    /**
     * `portrait` and `instagram` are deliberately absent (MUSE-23), on the same argument
     * that took `phone` off the `siteSettings` list in MUSE-20.
     *
     * No photography of this studio exists — §9's shoot direction describes a session
     * nobody has booked — so a `required()` portrait can only be satisfied by uploading
     * something that is not a portrait of that person, and inventing content to satisfy a
     * validator is how the fabricated schedule (MUSE-36) reached production. The page pays
     * for it with a placeholder frame that reserves the real 3:4 box, so nothing shifts on
     * the day a photograph lands; `test/aboutus.test.ts` is what holds that.
     *
     * `instagram` is optional because an instructor may not have a public profile, and a
     * name linking to nothing is worse than a name.
     */
    /**
     * `bio` came off this list in MUSE-36, and that is the assertion working.
     *
     * Mina and Antonio are the first two real `instructor` documents and nobody has
     * written a paragraph about either of them. A required bio could only be satisfied by
     * writing one — a claim about how long a named real person has danced, invented to
     * get past a validator, which is precisely how thirteen invented classes reached
     * production. `role` stays required because it is one short line that is simply true
     * of anyone on the roster.
     */
    expect(requiredFieldsOf('instructor')).toEqual(['name', 'role', 'slug']);
    expect(requiredFieldsOf('studioStory')).toEqual(['foundedOn', 'heading', 'story']);
    expect(requiredFieldsOf('scheduleSlot')).toEqual(['active', 'class', 'day', 'start']);
    expect(requiredFieldsOf('page')).toEqual(['description', 'name', 'route', 'title']);
    /**
     * `phone` and `openingHours` are deliberately absent (MUSE-20).
     *
     * Both were `required()`, the site renders neither, and no real value exists for
     * either — so the only way to satisfy them was to invent one, which is exactly how
     * the invented schedule (MUSE-36) reached production. A required field with no
     * consumer is a required field that can only be filled with fiction; whichever page
     * first displays them can require them then.
     */
    expect(requiredFieldsOf('siteSettings')).toEqual([
      'address',
      'email',
      'studioName',
      'summary',
      'tagline',
    ]);
    /**
     * `style` is gone and `description` and `image` came off the list (MUSE-36).
     *
     * `style` was never a thing the studio taught by. The other two had exactly one
     * consumer between them — the homepage style cards — which went with the styles, so
     * both became required fields with nothing rendering them and no real value to put
     * in: four invented paragraphs and four photographs that do not exist. Same rule as
     * `siteSettings.phone` (MUSE-20) and `instructor.portrait` (MUSE-23).
     */
    expect(requiredFieldsOf('class')).toEqual([
      'durationMin',
      'instructors',
      'level',
      'name',
      'slug',
    ]);
  });

  it('requires both locales of every bilingual value, not just one', () => {
    // The whole point of two named fields over a plugin's array: `required()` can say
    // this, and an array of `{_key, value}` cannot.
    for (const type of ['localeString', 'localeText', 'localeRichText']) {
      expect(requiredFieldsOf(type), type).toEqual([...LOCALES].sort());
    }
  });

  it('turns the hotspot on for every image, with no exceptions', () => {
    /**
     * Design system §9 rule 4: the same upload is cropped to 16:9, 4:5, 3:4 and 1:1.
     * Without a hotspot Sanity crops from the centre, so a 1:1 of a wide frame of two
     * dancers' hands cuts the hands out — and the alternative is Mina re-uploading per
     * ratio, which she will not do.
     */
    const images = allFields().filter(({ field }) => field.type === 'image');
    expect(images.length).toBeGreaterThan(0);

    const withoutHotspot = images
      .filter(({ field }) => field.options?.hotspot !== true)
      .map(({ path }) => path);
    expect(withoutHotspot).toEqual([]);
  });

  it('asks for alt text on every image, in both languages', () => {
    for (const { path, field } of allFields().filter((f) => f.field.type === 'image')) {
      const alt = field.fields?.find((nested) => nested.name === 'alt');
      expect(alt, `${path} has no alt field`).toBeDefined();
      expect(alt?.type, path).toBe('localeString');
    }
  });

  it("puts the design system's shoot direction where she will read it", () => {
    // §9: connection and motion, warm low light, never a single dancer posing. It is in
    // the field description because that is the only instruction she actually sees.
    for (const { path, field } of allFields().filter((f) => f.field.type === 'image')) {
      const description = field.description ?? '';
      expect(description, path).toContain('povezanost i pokret');
      expect(description, path).toContain('žarišnu točku');
      // The exception is spelled out rather than implied: instructor portraits are the
      // one place a single subject alone in frame is correct.
      expect(description, path).toContain('pozira sama');
    }
  });

  it('keeps the singletons singletons', () => {
    /**
     * Two of them now (MUSE-23). A studio has one origin story, and a second
     * „Priča studija" would be a story the site never reads: `STUDIO_STORY_QUERY` pins
     * `_id == "studioStory"`, so the spare is invisible rather than wrong — which is the
     * failure the fixed id exists to prevent, and the reason it is blocked in the same
     * three places `siteSettings` is.
     */
    expect([...SINGLETON_TYPES]).toEqual(['siteSettings', 'studioStory']);
    const config = readFileSync(join(ROOT, 'sanity.config.ts'), 'utf8');
    // A second "Postavke stranice" is a change that silently never reaches the site,
    // so it is blocked in three places: the fixed document id, the template list and
    // the new-document menu.
    expect(config).toContain('newDocumentOptions');
    const structure = readFileSync(join(ROOT, 'sanity/structure.ts'), 'utf8');
    for (const type of SINGLETON_TYPES) {
      expect(structure, type).toContain(`documentId('${type}')`);
    }
  });
});

/* ------------------------------------------------------- 2. structure vs content */

describe('the closed sets stay in code, not in the CMS', () => {
  it('offers exactly the levels the site renders, labelled the way it renders them', () => {
    const level = typeNamed('class').fields?.find((field) => field.name === 'level');
    expect(level?.options?.list).toEqual(
      LEVELS.map((value) => ({ title: LEVEL_NAME.hr[value], value })),
    );
  });

  it('models no style at all, on any type', () => {
    /**
     * MUSE-36, asserted as an absence — the replacement for "offers exactly the styles
     * the site renders", which was a test that the Studio offered three values nobody
     * had ever asked the studio about.
     *
     * `['traditional', 'moderna', 'sensual']` was invented in the foundation commit
     * alongside the thirteen invented classes, and a fixed list in the Studio made it
     * look like a decision somebody had taken: a required radio button Mina had to pick
     * from before she could save a class. The real timetable splits by level only.
     *
     * Checked across every field in the schema rather than on `class` alone, because the
     * way this comes back is on a different type — a `style` on `event`, or on a future
     * `course`. If the studio ever does teach by style, that is a product decision and a
     * schema change, not a constant restored from git history.
     */
    const stylish = allFields()
      .filter(({ field }) => field.name.toLowerCase().includes('style'))
      .map(({ path }) => path);
    expect(
      stylish,
      'MUSE-36 deleted the style dimension: it was invented with the invented ' +
        'schedule and the studio teaches by level. Read the note on this assertion ' +
        'before adding it back.',
    ).toEqual([]);
  });

  it('offers exactly the weekdays the schedule grid knows, Monday first', () => {
    const day = typeNamed('scheduleSlot').fields?.find((field) => field.name === 'day');
    expect(day?.options?.list).toEqual(
      WEEKDAYS.map((value) => ({ title: WEEKDAY_NAME.hr[value], value })),
    );
  });

  it('offers exactly the social platforms the footer can render', () => {
    /**
     * `SOCIAL_PLATFORMS` was a tuple with no consumers sitting next to a hand-written
     * option list, so adding `linktree` for MUSE-20 meant adding it twice in one file —
     * in the file whose own opening rule is that an option list is derived from the
     * constant that owns it. Adding it once would have been a platform the Studio offers
     * and nothing renders, or renders and nothing offers. Derived now, and pinned here
     * the same way the levels are.
     */
    const social = typeNamed('siteSettings').fields?.find((field) => field.name === 'social');
    const platform = social?.of?.[0]?.fields?.find((field) => field.name === 'platform');
    expect(platform?.options?.list).toEqual(
      SOCIAL_PLATFORMS.map((value) => ({ title: SOCIAL_PLATFORM_NAME[value], value })),
    );
  });

  it('lets a page document describe only a route the site actually serves', () => {
    // Which pages exist is decided by `src/pages/` and registered in `src/lib/pages.ts`;
    // Sanity owns a page's words, never its existence. After MUSE-20 the registry holds
    // *only* that — the route list — because the words moved into the `page` documents.
    const route = typeNamed('page').fields?.find((field) => field.name === 'route');
    const values = (route?.options?.list as { value: string }[]).map((o) => o.value);
    expect(values).toEqual(ROUTES.map((entry) => entry.route));
  });

  it('keeps a level out of free text, so a typo cannot reach a badge', () => {
    for (const [type, field] of [
      ['class', 'level'],
      ['scheduleSlot', 'day'],
    ] as const) {
      const definition = typeNamed(type).fields?.find((f) => f.name === field);
      expect(definition?.options?.list, `${type}.${field}`).toBeDefined();
    }
  });

  it('leaves the rules that are not words alone', () => {
    /**
     * The other half of the content/structure decision, asserted as absence. None of
     * these may become a CMS field:
     *
     *   - level prerequisites — MUSE-6 encoded a rule in them (time danced, never step
     *     names), and a text field invites the first edit that breaks it;
     *   - the trial form's copy — the browser needs the validation messages at runtime;
     *   - time and currency formatting — a field for one is a way to publish `25:00`.
     *
     * Matched as **substrings of the field name**, not as whole names. It used to be
     * `expect(fieldNames).not.toContain('prerequisite')`, which is an equality test
     * dressed as a containment test: a field literally named `prerequisite` failed, and
     * `levelPrerequisite` — the plain camelCase of `LEVEL_PREREQUISITE`, the constant this
     * rule exists to protect — passed, as did `prerequisites`, `prerequisiteNote`,
     * `formCopyText`, `currencyFormat` and `startTimeFormat`. Nobody would have been
     * evading it; they would have named the field the obvious thing and the guard would
     * have waved it through.
     *
     * Substring rather than regex-with-word-boundaries on purpose: these are forbidden
     * *concepts*, and any field whose name contains one is a field that is about one.
     * A false positive here is a conversation about whether the concept belongs in the
     * CMS, which is exactly the conversation this test is for.
     */
    const fieldNames = allFields().map(({ path, field }) => ({
      path,
      lowered: field.name.toLowerCase(),
    }));
    for (const forbidden of ['prerequisite', 'prereq', 'formcopy', 'timeformat', 'currency']) {
      const offenders = fieldNames
        .filter(({ lowered }) => lowered.includes(forbidden))
        .map(({ path }) => path);
      expect(
        offenders,
        `\`${forbidden}\` is a rule in code, not a CMS field — but ${offenders.join(', ')} ` +
          `${offenders.length === 1 ? 'is' : 'are'} named after it. See the comment above ` +
          `this assertion for why each of these stays out of Sanity.`,
      ).toEqual([]);
    }
    // The price is a number; the `25 €` / `€25` split of design system §10 is the page's.
    const price = typeNamed('pricingTier').fields?.find((f) => f.name === 'priceEur');
    expect(price?.type).toBe('number');
  });
});

/* ------------------------------------------------------------ 3. one typed client */

/**
 * The half of an `.astro` file that Astro ships: everything below the frontmatter fence.
 *
 * Frontmatter is the leading `---` … `---` block and only that; it runs in Node during
 * the build and is never bundled. A file without the fence is all markup, so it is
 * returned whole — the strict reading, deliberately, because that is the case where a
 * `<script>` is the only thing the file can be.
 */
function markupHalf(source: string): string {
  if (!source.startsWith('---')) return source;
  const close = source.indexOf('\n---', 3);
  return close === -1 ? source : source.slice(close + '\n---'.length);
}

describe('every query goes through one module', () => {
  /** Every `.ts`/`.astro` file under `src/`, as repo-relative paths. */
  function sources(): string[] {
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) return walk(full);
        return /\.(ts|astro)$/.test(entry.name) ? [full] : [];
      });
    return walk(join(ROOT, 'src'))
      .map((file) => relative(ROOT, file).replace(/\\/g, '/'))
      .sort();
  }

  /**
   * Files that mention `needle` from **outside** the read path.
   *
   * Scoped by directory rather than by an allow-list of filenames: the rule is "GROQ and
   * the client live under `src/lib/sanity/`", so a new module there is covered by the
   * rule rather than needing to be added to an exemption list. That is also what keeps
   * the modules inside the directory free to *document* a query in a comment, which they
   * have to, because the whole reason these guards exist is explained there.
   */
  function outsideReadPath(needle: string): string[] {
    return sources().filter(
      (file) =>
        !file.startsWith('src/lib/sanity/') &&
        readFileSync(join(ROOT, file), 'utf8').includes(needle),
    );
  }

  it('keeps GROQ out of components and pages', () => {
    // Needles assembled from fragments so this file does not report itself.
    expect(outsideReadPath(`_type ${'=='}`)).toEqual([]);
    expect(outsideReadPath(`define${'Query'}(`)).toEqual([]);
    expect(outsideReadPath('*[')).toEqual([]);
  });

  it('lets one module hold the Sanity client', () => {
    expect(outsideReadPath(`@sanity/${'client'}`)).toEqual([]);
    // And inside the read path, exactly one module imports it.
    const importers = sources().filter((file) =>
      /^import .*from '@sanity\/client'/m.test(readFileSync(join(ROOT, file), 'utf8')),
    );
    expect(importers).toEqual(['src/lib/sanity/client.ts']);
  });

  it('never puts the client where a browser could reach it', () => {
    /**
     * A `<script>` in an Astro component is bundled and shipped. Frontmatter is not.
     *
     * MUSE-19 forbade the string `lib/sanity` anywhere in a `.astro` file, which was
     * correct only while no page read Sanity. MUSE-20 is where pages arrive, so the
     * assertion is **replaced rather than deleted**, in the shape MUSE-19 recorded:
     *
     *   **Split the file at the frontmatter fence and assert on the halves separately.**
     *   Everything above the closing `---` is frontmatter, which Astro evaluates in Node
     *   at build time and never ships — `lib/sanity` is allowed there, and that is the
     *   MUSE-20 pattern. Everything below is markup, and `lib/sanity` in a `<script>`
     *   region there is a failure that names the file. A component with no frontmatter
     *   fence is all markup, so the whole file is held to the strict rule.
     *
     * Deleting it would remove the only *source-level* guard against the one mistake
     * that actually ships a CMS client to a browser — and that mistake is invisible to a
     * file count: a `<script>` importing the client gets **inlined into the HTML**, so
     * `dist` still has zero `.js` files. Three layers stand here, failing at different
     * times: this one at `npm test` naming the component, `test/nojs.test.ts`'s `.js`
     * file count on the built output, and `test/nojs.test.ts`'s CMS marker strings in the
     * markup — which is the only one that catches the inlined case.
     */
    for (const file of sources().filter((f) => f.endsWith('.astro'))) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      const markup = markupHalf(source);
      expect(markup, `${file} reaches the read path from its markup`).not.toContain(
        'lib/sanity',
      );
      // And the guard must still be looking at something: a component whose fence this
      // mis-parses would pass vacuously.
      expect(markup.length, `${file} parsed to no markup at all`).toBeGreaterThan(0);
    }
  });

  it('lets a page import the read path, but not the modules inside it', () => {
    /**
     * The hole MUSE-19 wrote down and left open, closed here now that there is something
     * to protect.
     *
     * `import { runQuery } from '../lib/sanity/client'` plus `import { FAQS_QUERY } from
     * '../lib/sanity/queries'` is two ordinary imports of two sibling modules, and it
     * yields raw rows with no decoding at all — so a renamed field arrives as `undefined`
     * and renders as nothing, which is the exact failure the decoders exist to turn into
     * a named build error. Nothing else notices: no GROQ text, no `@sanity/client`, and
     * `astro check` is perfectly happy.
     *
     * So, as decided in `src/lib/sanity/index.ts`: from outside `src/lib/sanity/`, an
     * import specifier ending in `lib/sanity` is allowed and one containing
     * `lib/sanity/` is a failure. The modules inside the directory go on importing each
     * other freely — the rule is about crossing the boundary, not about the modules.
     */
    const offenders: string[] = [];
    for (const file of sources().filter((f) => !f.startsWith('src/lib/sanity/'))) {
      const source = readFileSync(join(ROOT, file), 'utf8');
      for (const [, specifier] of source.matchAll(/from\s+'([^']+)'/g)) {
        if (/lib\/sanity\/./.test(specifier)) offenders.push(`${file} → ${specifier}`);
      }
    }
    expect(
      offenders,
      'Import `../lib/sanity` and nothing deeper: the index is what decodes, and a ' +
        'module from inside the read path hands back raw rows with silent nulls.',
    ).toEqual([]);
  });

  it('reads its configuration in a way Vite cannot inline into a client bundle', () => {
    /**
     * `import.meta.env.PUBLIC_*` is substituted into client bundles; `process.env` is
     * not, and `process` does not exist in a browser. So reading the project id off
     * `process.env` means a future mistake that pulls this module into a client bundle
     * throws on load instead of quietly working — and quietly working is what would ship
     * a CMS client to a static marketing site.
     */
    const readPath = sources().filter((file) => file.startsWith('src/lib/sanity/'));
    expect(readPath).toContain('src/lib/sanity/client.ts');

    const client = readFileSync(join(ROOT, 'src/lib/sanity/client.ts'), 'utf8');
    expect(client).toContain('process.env.SANITY_PROJECT_ID');

    // No module in the read path may read its configuration off `import.meta.env`, which
    // is the form Vite substitutes. Matched as a property access so the comment in
    // `client.ts` explaining *why* does not trip it.
    for (const file of readPath) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(
        /import\.meta\.env\.[A-Za-z_]/,
      );
    }
  });

  it('carries no read token, anywhere', () => {
    // The dataset is publicly readable and writes are rejected unauthenticated, so a
    // read token would be a secret to rotate and leak without protecting anything.
    //
    // The workflows are read off the directory rather than named. They used to be a list
    // of the three that existed, which meant "anywhere" was a claim this test could not
    // make: a fourth workflow was free to introduce the token nobody is supposed to add,
    // and MUSE-21 is the change that would have added one. `test/content.test.ts` had
    // already learned this for `MUSE_CONTENT_FIXTURE` and this copy had not.
    const workflows = readdirSync(join(ROOT, '.github/workflows')).map((file) =>
      join('.github/workflows', file),
    );
    expect(workflows.length).toBeGreaterThan(2);

    const everywhere = [
      ...sources(),
      'sanity.config.ts',
      'sanity.cli.ts',
      'package.json',
      ...workflows,
    ];
    for (const file of everywhere) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, file).not.toContain(`SANITY_${'READ'}_TOKEN`);
      expect(text, file).not.toContain(`SANITY_${'API'}_TOKEN`);
    }
  });

  it('ships the Studio from its own host, not from this app', () => {
    // Design decision, asserted as absence: a `/studio` route would put React and the
    // whole editor into the same build as a site that emits zero JavaScript files.
    const pages = readdirSync(join(ROOT, 'src/pages'), { withFileTypes: true }).map(
      (entry) => entry.name,
    );
    expect(pages).not.toContain('studio');
    expect(pages.some((name) => name.startsWith('studio'))).toBe(false);
  });
});

/* ------------------------------------------- 4. a broken document names itself */

describe('a missing or malformed document fails the build, naming itself', () => {
  const goodFaq = {
    _id: 'faq-partner',
    question: { hr: 'Trebam li partnera?', en: 'Do I need a partner?' },
    answer: { hr: 'Ne trebaš.', en: 'You do not.' },
  };

  it('decodes a complete document', () => {
    expect(decodeFaq(goodFaq)).toEqual({
      id: 'faq-partner',
      question: goodFaq.question,
      answer: goodFaq.answer,
    });
  });

  it('names the document and the field path when a translation is missing', () => {
    // The failure the two-named-fields shape is chosen to make visible: a half
    // translated string is a missing *field*, which can be named.
    const halfTranslated = { ...goodFaq, answer: { hr: 'Ne trebaš.' } };
    expect(() => decodeFaq(halfTranslated)).toThrow(SanityContentError);
    expect(() => decodeFaq(halfTranslated)).toThrow(/faq-partner/);
    expect(() => decodeFaq(halfTranslated)).toThrow(/answer\.en/);
  });

  it('names the document when a required field was renamed in the schema', () => {
    /**
     * This is the exact shape of a silent failure. GROQ does not error on an attribute
     * that does not exist — it returns `null` — so a renamed field arrives as a row
     * that is present, non-empty, and useless.
     */
    const renamed = { ...goodFaq, question: null };
    expect(() => decodeFaq(renamed)).toThrow(/faq-partner/);
    expect(() => decodeFaq(renamed)).toThrow(/`question`/);
    expect(() => decodeFaq(renamed)).toThrow(/absent/);
  });

  it('names the type when a projection loses the _id', () => {
    // Without an `_id` nothing downstream can name the document, so this is reported as
    // what it is — a query bug, not a content bug.
    expect(() => decodeFaq({ question: goodFaq.question })).toThrow(/`faq`/);
    expect(() => decodeFaq({ question: goodFaq.question })).toThrow(/no `_id`/);
  });

  it('rejects a time the schedule page could not render', () => {
    const slot = {
      _id: 'slot-mon-1930',
      classId: 'class-a',
      classRef: 'class-a',
      name: { hr: 'HR class', en: 'EN class' },
      day: 'mon',
      start: '19:30',
      durationMin: 90,
      level: 'beginner',
      instructors: ['Instructor A', 'Instructor B'],
      instructorRefs: ['instructor-a', 'instructor-b'],
    };
    // A half-hour start, which is what the real timetable turned out to be (MUSE-36) and
    // what nothing had ever handed the decoder before.
    expect(decodeScheduleEntry(slot).start).toBe('19:30');

    // `formatTime` throws on anything but 24-hour HH:MM, so the decoder refuses it first
    // and the error names the document rather than the formatter.
    expect(() => decodeScheduleEntry({ ...slot, start: '7:30 PM' })).toThrow(/slot-mon-1930/);
    expect(() => decodeScheduleEntry({ ...slot, start: '25:00' })).toThrow(/24-hour/);
    expect(() => decodeScheduleEntry({ ...slot, start: '19:3' })).toThrow(/24-hour/);
  });

  it('refuses a class with nobody teaching it', () => {
    /**
     * The three shapes GROQ answers `instructors[]->name` with when the content is
     * broken, all of which a template rendering a joined phrase turns into the same
     * thing — a published class with no teacher (MUSE-36).
     */
    const slot = {
      _id: 'slot-no-teacher',
      classId: 'class-a',
      classRef: 'class-a',
      name: { hr: 'HR class', en: 'EN class' },
      day: 'mon',
      start: '19:30',
      durationMin: 90,
      level: 'beginner',
      instructors: ['Instructor A'],
      instructorRefs: ['instructor-a'],
    };
    expect(decodeScheduleEntry(slot).instructors).toEqual(['Instructor A']);

    // The field is absent, or was renamed in the schema.
    expect(() => decodeScheduleEntry({ ...slot, instructors: null })).toThrow(
      /slot-no-teacher/,
    );
    // The array is there and empty — a slot saved mid-edit.
    expect(() => decodeScheduleEntry({ ...slot, instructors: [] })).toThrow(/instructors/);
    // A member points at an instructor document that has been deleted. The `_ref` is
    // still there — Sanity does not clear it — so the message names *which* instructor,
    // rather than describing an instructor whose `name` field is blank (MUSE-49).
    expect(() => decodeScheduleEntry({ ...slot, instructors: [null] })).toThrow(
      /instructors\[0\]/,
    );
    expect(() => decodeScheduleEntry({ ...slot, instructors: [null] })).toThrow(
      /points at nothing/,
    );
    expect(() => decodeScheduleEntry({ ...slot, instructors: [null] })).toThrow(
      /instructor-a/,
    );
    // And a single name where a list belongs — the shape before MUSE-36.
    expect(() => decodeScheduleEntry({ ...slot, instructors: 'Instructor A' })).toThrow(
      /a list with at least one entry/,
    );
  });

  it('reads a dereference and its `_ref` as a pair, or says the query is broken', () => {
    /**
     * MUSE-49's runtime half, and the reason the fix cannot be deleted for free.
     *
     * `src/lib/sanity/queries.ts` projects every `x->field` beside `x._ref`, because that
     * pair is the only thing that distinguishes "the target was deleted" from "this
     * optional field is empty". A projection with nothing watching it is a projection that
     * can be dropped silently — and dropping *this* one restores the original defect
     * rather than producing a visible error. `./shape.ts` asserts it at compile time, but
     * only once the types have been regenerated, so the decoder also checks every row.
     *
     * Three ways the pair can come apart, all of them impossible in GROQ — which is why
     * each is reported as a bug in the query rather than something to fix in the Studio.
     */
    const slot = {
      _id: 'slot-unpaired',
      classId: 'class-a',
      classRef: 'class-a',
      name: { hr: 'HR class', en: 'EN class' },
      day: 'mon',
      start: '19:30',
      durationMin: 90,
      level: 'beginner',
      instructors: ['Instructor A'],
      instructorRefs: ['instructor-a'],
    };
    expect(decodeScheduleEntry(slot).classId).toBe('class-a');

    // The scalar `_ref` is gone: `classId` resolved out of thin air.
    const noClassRef = { ...slot, classRef: null };
    expect(() => decodeScheduleEntry(noClassRef)).toThrow(SanityContentError);
    expect(() => decodeScheduleEntry(noClassRef)).toThrow(/slot-unpaired/);
    expect(() => decodeScheduleEntry(noClassRef)).toThrow(/classRef/);
    expect(() => decodeScheduleEntry(noClassRef)).toThrow(/queries\.ts/);

    // The list's `_ref`s are gone entirely.
    expect(() => decodeScheduleEntry({ ...slot, instructorRefs: null })).toThrow(
      /instructorRefs/,
    );

    /**
     * And the one that matters most: the lists are both there and **disagree in length**.
     *
     * A dangling member keeps its position in `groq-js` and in the API, so the names and
     * the `_ref`s line up member for member. This is the guard against that ceasing to be
     * true — a *compacted* list drops the teacher who is gone rather than blanking her,
     * which publishes „Instructor A" for a class two people teach: true, incomplete, and
     * indistinguishable on the page from a class she teaches alone. Nothing would be blank
     * and nothing would look wrong, which is why it is checked rather than reasoned about.
     */
    const compacted = { ...slot, instructorRefs: ['instructor-a', 'instructor-b'] };
    expect(() => decodeScheduleEntry(compacted)).toThrow(/instructorRefs/);
  });

  it('rejects a level outside the closed set', () => {
    const slot = {
      _id: 'slot-bad-level',
      classId: 'c1',
      classRef: 'c1',
      name: { hr: 'x', en: 'x' },
      day: 'mon',
      start: '19:00',
      durationMin: 90,
      level: 'Beginer',
      instructors: ['Instructor A'],
      instructorRefs: ['instructor-a'],
    };
    expect(() => decodeScheduleEntry(slot)).toThrow(/slot-bad-level/);
    expect(() => decodeScheduleEntry(slot)).toThrow(/`beginner`/);
    // All four of them are named in the message, so the fix is readable from the log.
    expect(() => decodeScheduleEntry(slot)).toThrow(/`improver`/);
  });

  it('names the image field when alt text is missing', () => {
    const instructor = {
      _id: 'instructor-mina',
      name: 'Mina',
      slug: 'mina',
      role: { hr: 'Voditeljica', en: 'Lead instructor' },
      bio: { hr: 'Pleše deset godina.', en: 'Ten years of dancing.' },
      portrait: { assetId: 'image-abc-800x1066-jpg', alt: { hr: 'Mina u studiju' } },
    };
    expect(() => decodeInstructor(instructor)).toThrow(/instructor-mina/);
    expect(() => decodeInstructor(instructor)).toThrow(/portrait\.alt\.en/);
  });

  it('accepts an instructor with no portrait, and still names a malformed one', () => {
    /**
     * MUSE-23. Structural values, not plausible ones — `test/helpers/structural-content.ts`
     * explains why, and the rule holds in a hand-written row just as much as in a fixture.
     */
    const base = {
      _id: 'instructor-a',
      name: 'Instructor A',
      slug: 'instructor-a',
      role: { hr: 'HR role', en: 'EN role' },
      bio: { hr: 'HR bio.', en: 'EN bio.' },
    };

    // "No photograph" is the ordinary state of every instructor today, so it decodes
    // rather than failing the build, and `/aboutus` renders a placeholder frame.
    expect(decodeInstructor(base).portrait).toBeUndefined();
    expect(decodeInstructor(base).instagram).toBeUndefined();

    // And so is "no bio" (MUSE-36): Mina and Antonio are real and nothing is written
    // about either of them. The card is the name and the role until something is.
    expect(decodeInstructor({ ...base, bio: undefined }).bio).toBeUndefined();
    // Optional is not unchecked here either — a half-translated bio is still named.
    expect(() => decodeInstructor({ ...base, bio: { hr: 'HR bio.' } })).toThrow(
      /bio\.en/,
    );

    // Optional is not unchecked. A portrait that *is* there has to be a whole one — this
    // is the MUSE-49 shape, an image object whose asset reference has gone — and the
    // field is named rather than rendering an empty frame.
    const assetGone = { ...base, portrait: { alt: { hr: 'HR alt', en: 'EN alt' } } };
    expect(() => decodeInstructor(assetGone)).toThrow(SanityContentError);
    expect(() => decodeInstructor(assetGone)).toThrow(/portrait\.assetId/);

    // An empty Instagram URL is a name linking to nowhere, which is worse than a name.
    expect(() => decodeInstructor({ ...base, instagram: '' })).toThrow(/`instagram`/);
  });
});

/* ------------------------------------------------- 5. empty is not the same as broken */

describe('an empty dataset is distinguishable from a broken query', () => {
  it('reports an empty result as content, naming the type and the count', () => {
    let thrown: unknown;
    try {
      requireDocuments([], 'instructor', decodeInstructor);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SanityContentError);
    const message = (thrown as Error).message;
    expect(message).toContain('`instructor`');
    expect(message).toContain('0');
    // The sentence that stops the next reader guessing: most of the dataset is still
    // empty, so "nothing on the page" is true for good reasons.
    expect(message).toContain('The query ran');
  });

  it('reports a non-list result as transport, not as missing content', () => {
    // A GROQ projection over a filter always returns an array. Anything else means the
    // answer did not come from the query.
    expect(() => requireDocuments(null, 'faq', decodeFaq)).toThrow(SanityUnavailableError);
    expect(() => requireDocuments('nope', 'faq', decodeFaq)).toThrow(/transport/);
  });

  it('lets a page say that having none is a legitimate state', () => {
    // An events page with no events is a correct page; an instructors page with no
    // instructors is a broken one. Only the page can know which, so it passes a minimum.
    expect(requireDocuments([], 'event', decodeFaq, 0)).toEqual([]);
  });

  it('defaults the minimum to one, so forgetting to think about it fails loudly', () => {
    expect(() => requireDocuments([], 'event', decodeFaq)).toThrow(SanityContentError);
  });

  it('reports a missing singleton as never created, not as a broken query', () => {
    expect(() => requireDocument(null, 'siteSettings', decodeFaq)).toThrow(
      /never been created/,
    );
    expect(() => requireDocument(null, 'siteSettings', decodeFaq)).toThrow(/siteSettings/);
  });
});

/* ------------------------------------------ the generated artefacts stay current */

describe('the generated types cannot go stale unnoticed', () => {
  it('still binds the generated query types to the site types', () => {
    // `SCHEMA_ASSERTIONS` is pure type-level work; importing it is what makes the
    // compiler evaluate it. If a schema field were renamed and the types regenerated,
    // `src/lib/sanity/shape.ts` would stop compiling and `npm run typecheck` would fail.
    expect(SCHEMA_ASSERTIONS.levels).toBe(true);
    expect(SCHEMA_ASSERTIONS.scheduleEntryIsClassEntry).toBe(true);
    expect(Object.keys(SCHEMA_ASSERTIONS.fields).sort()).toEqual([
      'class',
      'faq',
      'instructor',
      'page',
      // `post` joined the list in MUSE-49. `POSTS_QUERY` had no compile-time assertions at
      // all, which is part of why a dangling `author` went unnoticed: nothing in the type
      // layer was looking at the one optional *dereference* on the site.
      'post',
      'pricingTier',
      'scheduleSlot',
      'siteSettings',
      'studioStory',
    ]);
  });

  it('asserts every dereference is still projected beside its `_ref`', () => {
    /**
     * MUSE-49's compile-time half. `OptionalIn` (below) catches an optional field losing
     * its projection; it cannot catch the *second* projection — the `_ref` — disappearing,
     * because nothing in the generated type says the two belong together.
     *
     * `RefProjected` in `src/lib/sanity/shape.ts` does: deleting `"authorRef":
     * author._ref` from the query makes the key vanish and the `keyof` constraint fail,
     * and changing its shape fails with a message naming the field. Without it, dropping
     * one line of GROQ silently reverts `post.author` to publishing unsigned.
     */
    expect(SCHEMA_ASSERTIONS.postAuthorRef).toBe(true);
    expect(SCHEMA_ASSERTIONS.postAuthorOptional).toBe(true);
    expect(SCHEMA_ASSERTIONS.slotClassRef).toBe(true);
    expect(SCHEMA_ASSERTIONS.slotInstructorRefs).toBe(true);
    expect(SCHEMA_ASSERTIONS.classInstructorRefs).toBe(true);
  });

  it('watches the optional fields too, which no `Guaranteed` line can', () => {
    /**
     * MUSE-23. `portrait` and `instagram` had to come off the `Guaranteed` list when they
     * became optional — that is the assertion working — but a field with no line is a
     * field nothing watches: delete `instagram` from the projection and the generated type
     * simply stops having the key.
     *
     * `OptionalIn` in `src/lib/sanity/shape.ts` closes that: it says the key is present
     * *and* nullable, so a deleted projection, a renamed one and a `required()` quietly
     * returning all stop the compile naming the field.
     */
    expect(SCHEMA_ASSERTIONS.portraitOptional).toBe(true);
    expect(SCHEMA_ASSERTIONS.instagramOptional).toBe(true);
    // And the origin story's paragraphs are still an array of bilingual values, which
    // `Guaranteed` alone would not notice collapsing to a single object.
    expect(SCHEMA_ASSERTIONS.storyParagraphs).toBe(true);
  });

  it('is gated by the build, not by remembering to regenerate', () => {
    // `npm run build` runs `scripts/check-sanity.mjs` first, which fails if any schema
    // source has changed since the artefacts were generated. Without that gate every
    // other check in this file is judging a schema that no longer exists.
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toContain('check-sanity');
    expect(pkg.scripts['sanity:types']).toContain('schema extract');
    expect(pkg.scripts['sanity:types']).toContain('typegen generate');
    expect(pkg.scripts['sanity:types']).toContain('stamp-sanity');
  });

  it('has a current stamp in the working tree', () => {
    // The same check the build runs, so `npm test` says so too.
    const stamp = JSON.parse(readFileSync(join(ROOT, 'sanity/schema.stamp.json'), 'utf8'));
    expect(Object.keys(stamp.sources).length).toBeGreaterThan(5);
    for (const [file, hash] of Object.entries(stamp.sources)) {
      expect(statSync(join(ROOT, file)).isFile(), file).toBe(true);
      expect(typeof hash, file).toBe('string');
    }
  });

  it('fingerprints every file under `sanity/`, whatever it is called', () => {
    /**
     * The gate used to walk `sanity/schemaTypes` filtering `.endsWith('.ts')`, and both
     * halves of that leaked: `sanity/schemaTypes/fields.tsx` sat in the covered directory
     * and was invisible, and `sanity/fields.ts` was outside the covered directory and was
     * invisible. The second one mattered — `FAQS_QUERY` orders by `coalesce(order, 999)`,
     * so renaming `order` in an unfingerprinted helper reorders the FAQ page silently.
     *
     * Asserted as a property of the walk rather than by listing the two filenames: what
     * is wrong with an extension allow-list is that it is a list, so the fix cannot be a
     * longer list. Every file under `sanity/` is hashed except the stamp itself.
     */
    const hashed = new Set(Object.keys(fingerprint()));
    const onDisk = walkTree(join(ROOT, 'sanity'))
      .map((file) => relative(ROOT, file).replace(/\\/g, '/'))
      .filter((file) => file !== 'sanity/schema.stamp.json');

    expect(onDisk.length).toBeGreaterThan(5);
    for (const file of onDisk) expect(hashed, file).toContain(file);

    // And the extensions present are not all `.ts` — if they ever were, this test would
    // be passing for the wrong reason and would stop proving anything.
    expect(new Set(onDisk.map((file) => file.replace(/^.*\./, ''))).size).toBeGreaterThan(1);
  });

  it('redeploys the Studio when the schema changes', () => {
    // A Studio one schema behind the dataset shows Mina fields that no longer exist and
    // hides ones that do, which is worse than a Studio that is briefly unavailable.
    const workflow = readFileSync(join(ROOT, '.github/workflows/studio.yml'), 'utf8');
    expect(workflow).toContain('sanity:deploy');
  });

  it('triggers that redeploy on exactly the files the fingerprint covers', () => {
    /**
     * `studio.yml`'s `paths:` filter and the gate's `SOURCES` are meant to be the same
     * list, and a comment in each said so while they had already drifted in both
     * directions. Drift is the expensive kind of bug here: a schema source the workflow
     * does not watch leaves Mina's Studio a schema behind the dataset, showing her fields
     * that no longer exist and hiding ones that do, with nothing red anywhere.
     *
     * So the comment is replaced by this. `SOURCE_GLOBS` is derived from `SOURCES`, and
     * the workflow may add paths that affect the *deploy* without affecting the schema
     * fingerprint — the manifests that decide which `sanity` and which
     * `styled-components` get bundled, and the workflow file itself — but nothing else,
     * and it may not omit anything.
     */
    const STUDIO_ONLY = [
      'package.json',
      'package-lock.json',
      '.github/workflows/studio.yml',
      // MUSE-21: the rebuild cadence. `sanity/badges.ts` turns it into the sentence Mina
      // reads beside the Publish button, so the Studio has to be redeployed when it moves
      // — but it defines no field and changes no generated type, so it is deliberately
      // *not* in the fingerprint. This list is exactly the difference between "the Studio
      // bundle depends on it" and "the schema is derived from it".
      'src/lib/rebuild.ts',
    ];

    const workflow = readFileSync(join(ROOT, '.github/workflows/studio.yml'), 'utf8');
    const filter = workflow.slice(
      workflow.indexOf('    paths:'),
      workflow.indexOf('  workflow_dispatch:'),
    );
    const listed = [...filter.matchAll(/^\s+- '(.+)'$/gm)].map(([, path]) => path);

    expect(listed).toEqual([...SOURCE_GLOBS, ...STUDIO_ONLY]);
  });

  it('runs the type checker inside the build, not only beside it in CI', () => {
    /**
     * A field *type* change (`localeString` → `string`) and a typo in a GROQ projection
     * are both invisible to `scripts/check-sanity.mjs` — the schema still has the field,
     * and the stamp is current because the source really was regenerated. `astro check`
     * is the layer that sees them, through `src/lib/sanity/shape.ts`.
     *
     * It therefore has to be in `npm run build`, because `.github/workflows/deploy.yml`
     * runs `npm run build` and nothing else and does not depend on CI. A check that lives
     * only in CI is not on the path to production.
     */
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.scripts.build).toContain('astro check');

    const deploy = readFileSync(join(ROOT, '.github/workflows/deploy.yml'), 'utf8');
    expect(deploy).toContain('npm run build');
  });

  it('can actually bundle the Studio, and says so in CI', () => {
    /**
     * `styled-components` is a peer dependency of `sanity`, so it is in `node_modules`
     * whether or not this project declares it — and `sanity build` preflights
     * *declarations*, not resolution. Undeclared, the Studio could not be bundled at all
     * while `sanity schema extract`, `sanity schema validate`, `astro check` and this
     * whole suite stayed green, because none of them bundle it. Mina would have got no
     * Studio and the only red would have been on `main`, after merge.
     *
     * Two assertions, because the declaration alone is a thing that can be dropped again:
     * the dependency is declared, and CI runs a real `sanity build` on every pull request.
     */
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    expect(
      pkg.devDependencies['styled-components'],
      '`sanity build` fails its declaration preflight without this, even though the ' +
        'package is installed as a peer dependency of `sanity`.',
    ).toBeTruthy();
    expect(pkg.scripts['sanity:build']).toContain('.sanity/studio');

    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    expect(ci, 'CI must bundle the Studio, not just evaluate its schema.').toContain(
      'npm run sanity:build',
    );
  });
});

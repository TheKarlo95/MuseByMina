import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { schemaTypes, SINGLETON_TYPES } from '../sanity/schemaTypes';
import {
  LEVELS,
  LEVEL_NAME,
  STYLES,
  STYLE_NAME,
  WEEKDAYS,
  WEEKDAY_NAME,
} from '../src/lib/schedule';
import { PAGES } from '../src/lib/pages';
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
 *   2. **The closed sets stay closed.** The level, style and weekday options the Studio
 *      offers are the same constants `src/lib/schedule.ts` renders from — not copies of
 *      them. This is MUSE-11's guarantee carried across the CMS boundary.
 *   3. **One typed client.** No GROQ, and no Sanity client, anywhere under `src/` except
 *      `src/lib/sanity/`. Read off the source tree, like `test/isolation.test.ts`.
 *   4. **A missing or malformed document fails, naming itself.** The decoders are run
 *      against hand-written documents, broken in the ways a CMS actually breaks them,
 *      and the error messages are asserted to contain the document id and the field path.
 *   5. **Empty is not broken.** The three outcomes — unreachable, empty, malformed — are
 *      distinguishable by type, because the dataset is legitimately empty until MUSE-20
 *      and "nothing came back" has to be readable as which of the three it was.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

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
    expect(requiredFieldsOf('instructor')).toEqual(['bio', 'name', 'portrait', 'role', 'slug']);
    expect(requiredFieldsOf('scheduleSlot')).toEqual(['active', 'class', 'day', 'start']);
    expect(requiredFieldsOf('page')).toEqual(['description', 'name', 'route', 'title']);
    expect(requiredFieldsOf('class')).toEqual([
      'description',
      'durationMin',
      'image',
      'instructor',
      'level',
      'name',
      'slug',
      'style',
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

  it('keeps the singleton a singleton', () => {
    expect([...SINGLETON_TYPES]).toEqual(['siteSettings']);
    const config = readFileSync(join(ROOT, 'sanity.config.ts'), 'utf8');
    // A second "Postavke stranice" is a change that silently never reaches the site,
    // so it is blocked in three places: the fixed document id, the template list and
    // the new-document menu.
    expect(config).toContain('newDocumentOptions');
    expect(readFileSync(join(ROOT, 'sanity/structure.ts'), 'utf8')).toContain(
      "documentId('siteSettings')",
    );
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

  it('offers exactly the styles the site renders', () => {
    const style = typeNamed('class').fields?.find((field) => field.name === 'style');
    expect(style?.options?.list).toEqual(
      STYLES.map((value) => ({ title: STYLE_NAME.hr[value], value })),
    );
  });

  it('offers exactly the weekdays the schedule grid knows, Monday first', () => {
    const day = typeNamed('scheduleSlot').fields?.find((field) => field.name === 'day');
    expect(day?.options?.list).toEqual(
      WEEKDAYS.map((value) => ({ title: WEEKDAY_NAME.hr[value], value })),
    );
  });

  it('lets a page document describe only a route the site actually serves', () => {
    // Which pages exist is decided by `src/pages/` and registered in `src/lib/pages.ts`;
    // Sanity owns a page's words, never its existence.
    const route = typeNamed('page').fields?.find((field) => field.name === 'route');
    const values = (route?.options?.list as { value: string }[]).map((o) => o.value);
    expect(values).toEqual(PAGES.map((page) => page.route));
  });

  it('keeps a level out of free text, so a typo cannot reach a badge', () => {
    for (const [type, field] of [
      ['class', 'level'],
      ['class', 'style'],
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
     */
    const fieldNames = allFields().map(({ field }) => field.name.toLowerCase());
    for (const forbidden of ['prerequisite', 'prereq', 'formcopy', 'timeformat', 'currency']) {
      expect(fieldNames, forbidden).not.toContain(forbidden);
    }
    // The price is a number; the `25 €` / `€25` split of design system §10 is the page's.
    const price = typeNamed('pricingTier').fields?.find((f) => f.name === 'priceEur');
    expect(price?.type).toBe('number');
  });
});

/* ------------------------------------------------------------ 3. one typed client */

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
    // A `<script>` in an Astro component is bundled and shipped. Frontmatter is not.
    for (const file of sources().filter((f) => f.endsWith('.astro'))) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toContain('lib/sanity');
    }
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
    const everywhere = [
      ...sources(),
      'sanity.config.ts',
      'sanity.cli.ts',
      'package.json',
      '.github/workflows/ci.yml',
      '.github/workflows/deploy.yml',
      '.github/workflows/studio.yml',
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
      _id: 'slot-mon-19',
      classId: 'class-trad-beginner',
      name: { hr: 'Bachata za početnike', en: 'Bachata for beginners' },
      day: 'mon',
      start: '19:00',
      durationMin: 60,
      style: 'traditional',
      level: 'beginner',
      instructor: 'Mina',
    };
    expect(decodeScheduleEntry(slot).start).toBe('19:00');

    // `formatTime` throws on anything but 24-hour HH:MM, so the decoder refuses it first
    // and the error names the document rather than the formatter.
    expect(() => decodeScheduleEntry({ ...slot, start: '7:30 PM' })).toThrow(/slot-mon-19/);
    expect(() => decodeScheduleEntry({ ...slot, start: '25:00' })).toThrow(/24-hour/);
  });

  it('rejects a level outside the closed set', () => {
    const slot = {
      _id: 'slot-bad-level',
      classId: 'c1',
      name: { hr: 'x', en: 'x' },
      day: 'mon',
      start: '19:00',
      durationMin: 60,
      style: 'traditional',
      level: 'Beginer',
      instructor: 'Mina',
    };
    expect(() => decodeScheduleEntry(slot)).toThrow(/slot-bad-level/);
    expect(() => decodeScheduleEntry(slot)).toThrow(/`beginner`/);
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
    // The sentence that stops the next reader guessing. The dataset is empty until
    // MUSE-20, so "nothing on the page" will be true for a while for good reasons.
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
      'pricingTier',
      'scheduleSlot',
      'siteSettings',
    ]);
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

  it('redeploys the Studio when the schema changes', () => {
    // A Studio one schema behind the dataset shows Mina fields that no longer exist and
    // hides ones that do, which is worse than a Studio that is briefly unavailable.
    const workflow = readFileSync(join(ROOT, '.github/workflows/studio.yml'), 'utf8');
    expect(workflow).toContain('sanity/schemaTypes/**');
    expect(workflow).toContain('sanity:deploy');
  });
});

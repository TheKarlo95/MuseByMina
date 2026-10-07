/**
 * The build's Sanity gate. Runs before `astro build` (see `package.json`).
 *
 * It answers one question — *are the generated artefacts still telling the truth about
 * the schema?* — and it answers it in milliseconds, which is why it can be in the build
 * at all. `sanity schema extract` takes the better part of half a minute because it
 * bundles the whole Studio config to evaluate it; putting that in every build would be
 * paid on every deploy and every local `npm run build`.
 *
 * So instead of re-deriving the schema, this compares a fingerprint. Every source file
 * the schema is built from is hashed; `npm run sanity:types` records those hashes in
 * `sanity/schema.stamp.json` alongside the artefacts it generates. If a hash has moved,
 * the artefacts are stale and the build stops, naming the files.
 *
 * Why that is the right gate, rather than trusting review:
 *
 *   GROQ returns `null` for an attribute that does not exist — it does not error. So
 *   renaming a schema field and *not* regenerating leaves a build that compiles, type
 *   checks, exits 0, and publishes pages with empty slots where the content used to be.
 *   Every other layer in the read path (`src/lib/sanity/shape.ts`'s compile-time
 *   assertions, `test/sanity.test.ts`'s schema assertions, `decode.ts`'s runtime
 *   checks) is derived from `sanity/schema.json`, so all three are blind while that file
 *   is stale. This is the only check that can see it.
 *
 * It then does the cheap structural pass over the extracted schema itself: that the
 * document types the read path reads still exist, and still have the fields it projects.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const SCHEMA_JSON = 'sanity/schema.json';
const STAMP_JSON = 'sanity/schema.stamp.json';
const GENERATED_TYPES = 'src/lib/sanity/sanity.types.ts';

/**
 * Everything the generated artefacts are derived from.
 *
 * `src/lib/schedule.ts` and `src/lib/pages.ts` are in here because the schema imports
 * its option lists from them — levels, styles, weekdays, the route list. That is the
 * content-versus-structure decision made mechanical: a fourth level added in
 * `schedule.ts` changes the Studio's dropdown and the generated string union, so it has
 * to invalidate the artefacts too.
 */
const SOURCES = [
  { dir: 'sanity/schemaTypes' },
  { file: 'sanity/structure.ts' },
  { file: 'sanity.config.ts' },
  { file: 'sanity.cli.ts' },
  { file: 'src/lib/schedule.ts' },
  { file: 'src/lib/pages.ts' },
  { file: 'src/lib/sanity/queries.ts' },
];

/** The document types and fields the read path cannot work without. */
const READ_CONTRACT = {
  siteSettings: [
    'studioName',
    'tagline',
    'summary',
    'address',
    'email',
    'phone',
    'openingHours',
    'social',
    'shareImage',
  ],
  page: ['route', 'name', 'title', 'description'],
  class: [
    'name',
    'slug',
    'style',
    'level',
    'description',
    'durationMin',
    'instructor',
    'image',
  ],
  scheduleSlot: ['class', 'day', 'start', 'instructor', 'active'],
  instructor: ['name', 'slug', 'role', 'bio', 'portrait'],
  pricingTier: ['name', 'priceEur', 'period', 'features', 'featured'],
  event: [
    'title',
    'slug',
    'eventType',
    'startsAt',
    'endsAt',
    'venue',
    'description',
    'image',
    'lineup',
    'ticketUrl',
  ],
  galleryImage: ['image', 'caption', 'takenAt'],
  post: ['title', 'slug', 'publishedAt', 'excerpt', 'coverImage', 'body', 'author'],
  faq: ['question', 'answer'],
};

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : full.endsWith('.ts') ? [full] : [];
    })
    .sort();
}

/** `{ 'sanity/schemaTypes/index.ts': '<sha256>', … }` — sorted, so it is comparable. */
export function fingerprint() {
  const files = SOURCES.flatMap(({ dir, file }) => {
    const target = join(ROOT, dir ?? file);
    if (!existsSync(target)) return [];
    return statSync(target).isDirectory() ? walk(target) : [target];
  }).sort();

  const hashes = {};
  for (const file of files) {
    const key = relative(ROOT, file).replace(/\\/g, '/');
    hashes[key] = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 16);
  }
  return hashes;
}

function problems() {
  const found = [];

  for (const artefact of [SCHEMA_JSON, GENERATED_TYPES, STAMP_JSON]) {
    if (!existsSync(join(ROOT, artefact))) {
      found.push(`\`${artefact}\` is missing. Run \`npm run sanity:types\`.`);
    }
  }
  if (found.length > 0) return found;

  const stamp = JSON.parse(readFileSync(join(ROOT, STAMP_JSON), 'utf8'));
  const current = fingerprint();

  const drifted = [];
  for (const [file, hash] of Object.entries(current)) {
    if (stamp.sources[file] !== hash) drifted.push(file);
  }
  for (const file of Object.keys(stamp.sources)) {
    if (!(file in current)) drifted.push(`${file} (deleted)`);
  }

  if (drifted.length > 0) {
    found.push(
      [
        'The Sanity schema sources have changed since the generated artefacts were built:',
        ...drifted.map((file) => `    ${file}`),
        '',
        `  So \`${SCHEMA_JSON}\` and \`${GENERATED_TYPES}\` no longer describe the schema,`,
        '  and every check that reads them — the compile-time assertions in',
        '  `src/lib/sanity/shape.ts`, the schema assertions in `test/sanity.test.ts` —',
        '  is checking a schema that no longer exists.',
        '',
        '  This matters because GROQ does not fail on a field that is not there: it',
        '  returns null. A renamed field with stale artefacts builds clean and publishes',
        '  pages with the content silently missing.',
        '',
        '    npm run sanity:types     # regenerate, then commit both files',
      ].join('\n'),
    );
    // Stop here: the structural pass below would be judging the stale schema.
    return found;
  }

  const schema = JSON.parse(readFileSync(join(ROOT, SCHEMA_JSON), 'utf8'));
  const byName = new Map(schema.map((type) => [type.name, type]));

  for (const [type, fields] of Object.entries(READ_CONTRACT)) {
    const definition = byName.get(type);
    if (!definition) {
      found.push(
        `The read path reads \`${type}\` documents, and the schema has no such type. ` +
          `Either restore it in \`sanity/schemaTypes/\` or remove its reader from ` +
          `\`src/lib/sanity/index.ts\`.`,
      );
      continue;
    }
    // `sanity schema extract` writes a type-level view: an `attributes` map keyed by
    // field name, with `optional: false` where validation requires a value. It is the
    // same JSON `sanity typegen` reads, which is why the gate and the generated types
    // can never disagree about what the schema says.
    const present = new Set(Object.keys(definition.attributes ?? {}));
    const missing = fields.filter((field) => !present.has(field));
    if (missing.length > 0) {
      found.push(
        `\`${type}\` is missing field(s) the read path projects: ` +
          `${missing.map((f) => `\`${f}\``).join(', ')}. ` +
          `GROQ would return null for ${missing.length === 1 ? 'it' : 'them'} rather ` +
          `than failing, so the page would render with the content missing. Fields the ` +
          `schema does have: ${[...present].join(', ')}.`,
      );
    }
  }

  return found;
}

// Importable for the test suite; only the direct run reports and exits.
if (import.meta.url === `file://${process.argv[1]}`) {
  const found = problems();
  if (found.length === 0) {
    process.exit(0);
  }
  console.error('\nSanity schema gate failed.\n');
  for (const problem of found) console.error(`  ${problem}\n`);
  process.exit(1);
}

export { problems, READ_CONTRACT, SCHEMA_JSON, STAMP_JSON, GENERATED_TYPES };

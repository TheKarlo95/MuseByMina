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
 * its option lists from them — levels, weekdays, the route list. That is the
 * content-versus-structure decision made mechanical: the fourth level MUSE-36 added in
 * `schedule.ts` changed the Studio's dropdown and the generated string union, and this is
 * what made it invalidate the artefacts too.
 *
 * The first entry is the whole `sanity/` tree, deliberately coarse. It used to be
 * `sanity/schemaTypes` walked with an `.endsWith('.ts')` filter, and both halves of that
 * were holes:
 *
 *   - a schema helper at `sanity/schemaTypes/fields.tsx` was invisible to the gate, even
 *     though it sat in the directory the gate claimed to cover. `.tsx` is an ordinary
 *     extension for a Sanity schema with a custom input component. This is MUSE-17
 *     recurring — a guard whose extension allow-list misses a file in its own
 *     directory — so the allow-list is gone rather than extended;
 *   - a helper at `sanity/fields.ts` was outside the walked directory entirely. That one
 *     had teeth: `FAQS_QUERY` orders by `coalesce(order, 999)`, so renaming `order` in an
 *     unfingerprinted helper silently reorders the whole FAQ page with every check green.
 *
 * So: every file under `sanity/`, whatever it is called. A file that is not schema source
 * costs one spurious regeneration; a file the gate cannot see costs silent data loss.
 *
 * That sweep now also picks up `sanity/schema.json`, which is an artefact rather than a
 * source. Kept deliberately: it means a hand-edited or truncated `schema.json` fails this
 * gate — the one that `npm run build`, and therefore `deploy.yml`, actually runs — rather
 * than waiting for CI's slower regenerate-and-diff, which `deploy.yml` does not depend on.
 * `sanity/schema.stamp.json` is the single exclusion, because it is where the answer is
 * written (see `STAMP_EXCLUDED`).
 *
 * **The content seed is not in here, and `sanity/` is why** (MUSE-45). The seed lived at
 * `sanity/seed/content.ndjson` from MUSE-20 until MUSE-45, so the coarse sweep hashed it
 * and three consumers of this fingerprint read a content edit as a schema change:
 * rewording a page title failed the build until the types were regenerated, CI's
 * regenerate-and-diff printed "The Sanity schema changed" at somebody who had not been
 * near the schema, and `studio.yml` — which takes its `paths:` from `SOURCE_GLOBS` —
 * republished Mina's Studio using `SANITY_DEPLOY_TOKEN`, the project's only write
 * credential.
 *
 * The seed moved to `content/seed.ndjson` rather than being excluded here, because an
 * exclusion is the MUSE-19 mistake pointed the other way: the sweep's whole value is that
 * it has no exceptions, and anything "the walk knows to skip" is a list that the next file
 * is missing from. Moving the file instead makes the sentence *"every file under `sanity/`
 * is schema source"* true rather than nearly true, and leaves nothing for a future reader
 * to get wrong. The cost — the seed no longer sits beside the schema it instantiates — is
 * paid in these two paragraphs, and it is cheap: the seed's consumers were already
 * `package.json`, `vitest.config.ts`, `scripts/sanity-seed-check.mjs` and two test
 * helpers, so nothing ever found it by looking next to the schema.
 *
 * `test/sanity.test.ts`, "keeps the content seed outside the schema fingerprint", asserts
 * it — against `MUSE_CONTENT_FIXTURE`, the path the suite is actually reading, so moving
 * the seed back under `sanity/` is red however it is spelled.
 */
const SOURCES = [
  { dir: 'sanity' },
  { file: 'sanity.config.ts' },
  { file: 'sanity.cli.ts' },
  { file: 'src/lib/schedule.ts' },
  { file: 'src/lib/pages.ts' },
  { file: 'src/lib/sanity/queries.ts' },
];

/**
 * The paths `SOURCES` covers, as the globs a GitHub Actions `paths:` filter speaks.
 *
 * `.github/workflows/studio.yml` has to list the same set — it redeploys Mina's Studio
 * when a schema file lands on `main`, and a schema change that does not trigger it leaves
 * her Studio a schema behind the dataset. The two lists had already drifted while a
 * comment in each claimed they were the same list, so `test/sanity.test.ts` now asserts
 * the workflow's filter equals this, plus the studio-only paths named there.
 */
export const SOURCE_GLOBS = SOURCES.map(({ dir, file }) => (dir ? `${dir}/**` : file));

/**
 * The one file under `sanity/` that cannot be fingerprinted: it is where the fingerprint
 * is written, so hashing it would be hashing the previous run's answer.
 */
const STAMP_EXCLUDED = new Set([STAMP_JSON]);

/**
 * The document types and fields the read path cannot work without.
 *
 * **Every key is checked for completeness against the schema** (`contractProblems`), and
 * every field list is checked against the real queries by `test/sanity.test.ts`, which
 * parses them with `groq-js`. Neither half is a convention: MUSE-66 found `studioStory`
 * had never been a key at all, so the entire body of `/aboutus` — live, and the only thing
 * on that page — sat outside the one check that can see a renamed field. A hand-written
 * list beside a schema that enumerates the same types is a second copy of a fact, and this
 * repository has now paid for that shape three times (MUSE-19's extension allow-list,
 * MUSE-50's field registry, MUSE-46's route list).
 *
 * So the list stays hand-written — the *fields* are the projected subset of each type,
 * which the schema cannot supply without asserting itself — and it is pinned from both
 * sides instead: the schema says which keys must exist, the queries say what each list
 * must contain.
 *
 * `order` and `instructor.instagram` joined in MUSE-66 for the second reason. `order` is
 * projected by nothing and sorted by everything — `| order(coalesce(order, 999) asc)` on
 * five types — so a rename of it reorders a page with no slot left blank to notice, which
 * is the failure the note on `sanity/fields.ts` in `SOURCES` already warned about.
 */
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
  prosePage: ['route', 'heading', 'lede', 'sections'],
  // The whole of `/aboutus`'s body, and absent from this list until MUSE-66.
  studioStory: ['heading', 'foundedOn', 'story'],
  class: [
    'name',
    'slug',
    'level',
    'description',
    'durationMin',
    'instructors',
    'image',
    'order',
  ],
  scheduleSlot: ['class', 'day', 'start', 'instructors', 'active'],
  instructor: ['name', 'slug', 'role', 'bio', 'portrait', 'instagram', 'order'],
  pricingTier: ['name', 'priceEur', 'period', 'features', 'featured', 'order'],
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
  galleryImage: ['image', 'caption', 'takenAt', 'order'],
  post: ['title', 'slug', 'publishedAt', 'excerpt', 'coverImage', 'body', 'author'],
  faq: ['question', 'answer', 'order'],
};

/**
 * Document types the read path deliberately does not read, each carrying the reason.
 *
 * The completeness check below has no third answer: a document type in the schema is
 * either in `READ_CONTRACT` or in here, and silence is a build failure. That is the
 * `test/contentdrift.test.ts` pattern — an exemption is a decision, so it is written down
 * with its justification and asserted still necessary, rather than being the absence of
 * a line nobody notices.
 *
 * Both entries are Sanity's own asset records, which exist in every dataset whether or
 * not this project uploads anything. Nothing here reads them: every image projection in
 * `queries.ts` takes `asset._ref` and the crop, and the URL is built from the id, so the
 * asset document itself is never selected on. `test/sanity.test.ts` asserts that against
 * the real parser, so an exemption that stops being true is red rather than quiet.
 *
 * A *project* type arriving in here is the case this list exists to make visible — it
 * would mean somebody decided a type Mina fills in is read by nothing, which is either a
 * page that was never built or a field that renders nowhere.
 */
const NOT_READ = {
  'sanity.imageAsset':
    "Sanity's own upload record. The queries project `asset._ref`, `hotspot` and " +
    '`crop` off the referring document and build the URL from the id, so no query ' +
    'selects on the asset document itself.',
  'sanity.fileAsset':
    "Sanity's own upload record for non-image files. The site uploads none today, and " +
    'no query selects on it; it exists in the extracted schema because the Studio ' +
    'declares the asset types regardless.',
};

/**
 * Every file under `dir`, recursively, with no extension filter — see `SOURCES`.
 *
 * Dot-entries are skipped, and that is the only exclusion. It is a deny-list of OS and
 * editor droppings (`.DS_Store`, `.vscode/`), not an allow-list of source extensions: the
 * failure mode of a deny-list is a build that stops on a file it should have ignored,
 * which is loud and takes a second to fix. The failure mode of an allow-list is a schema
 * file nobody is watching, which is what put this comment here.
 */
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
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
    if (STAMP_EXCLUDED.has(key)) continue;
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
  return contractProblems(schema);
}

/**
 * The structural pass, over an extracted schema: does it still say what the read path
 * assumes, and is every document type in it accounted for?
 *
 * Takes the schema as an argument rather than reading it, so `test/sanity.test.ts` can
 * hand it a schema with one type removed, one field dropped or one type added and assert
 * that the gate goes red — which is the only way to know a guard can still fail. The
 * contract and the exemptions are parameters for the same reason and default to the real
 * ones, which is what the build runs.
 */
function contractProblems(schema, contract = READ_CONTRACT, exempt = NOT_READ) {
  const found = [];
  const byName = new Map(schema.map((type) => [type.name, type]));

  for (const [type, fields] of Object.entries(contract)) {
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
        `\`${type}\` is missing field(s) the read path names: ` +
          `${missing.map((f) => `\`${f}\``).join(', ')}. ` +
          `GROQ would return null for ${missing.length === 1 ? 'it' : 'them'} rather ` +
          `than failing, so the page would render with the content missing — or, for a ` +
          `field the queries sort by rather than project, in an order nobody chose. ` +
          `Fields the schema does have: ${[...present].join(', ')}.`,
      );
    }
  }

  /**
   * And the half MUSE-66 is about: the list above is hand-written, so the check that
   * matters is whether it is *complete*. Every document type the schema declares is
   * either read — and therefore checked, field by field — or exempt with a reason.
   * There is no third state, because the third state is what `studioStory` was in from
   * MUSE-23 until MUSE-66: a live document type whose fields nothing compared with
   * anything, on a page that is nothing but that type.
   */
  for (const type of schema) {
    if (type.type !== 'document') continue;
    if (type.name in contract || type.name in exempt) continue;
    found.push(
      `\`${type.name}\` is a document type in \`${SCHEMA_JSON}\` that the read ` +
        `contract does not mention.\n` +
        `  Add it to \`READ_CONTRACT\` in \`scripts/check-sanity.mjs\` with the ` +
        `fields its reader projects, or to \`NOT_READ\` with the reason nothing reads ` +
        `it.\n` +
        `  A type on neither list is a type whose fields can be renamed with every ` +
        `check green: GROQ answers null for a field that is not there, so the page ` +
        `publishes with the content gone. That is MUSE-66 — \`studioStory\` was ` +
        `absent from this list for its whole life, and it is the entire body of ` +
        `/aboutus.`,
    );
  }

  /** An exemption outliving its subject is an exemption nobody will re-examine. */
  for (const type of Object.keys(exempt)) {
    if (byName.has(type)) continue;
    found.push(
      `\`${type}\` is exempt from the read contract in \`NOT_READ\` and is no ` +
        `longer a document type in \`${SCHEMA_JSON}\`. Delete the exemption, or ` +
        `restore the type — a reason for not reading something that does not exist is ` +
        `one nobody will question when it starts mattering again.`,
    );
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

export {
  problems,
  contractProblems,
  READ_CONTRACT,
  NOT_READ,
  SCHEMA_JSON,
  STAMP_JSON,
  GENERATED_TYPES,
};

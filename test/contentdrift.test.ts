import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildSite, PAGES_DEPLOY, type Build } from './helpers/build';
import { claimOutDir } from './helpers/scratch';
import { seedDocs, type SeedDoc } from './helpers/seed';

/**
 * **MUSE-50 — no string under `src/` may duplicate a value the CMS owns.**
 *
 * MUSE-20 moved the studio's details into `siteSettings` and rewired the surfaces that
 * render them. The review that scoped it found those surfaces by grepping for the
 * identifier `STUDIO.street`, which found four of five: `/schedule`'s hero eyebrow spelled
 * the street as a literal *inside a longer composed label*, and an identifier search
 * cannot see that. So four surfaces followed the Studio and a fifth did not, and the day
 * that becomes visible is the day the studio moves — the one day anybody is relying on the
 * CMS to fix it everywhere at once.
 *
 * It passed MUSE-20's acceptance criteria by luck. The criterion was byte-identical
 * output, and the output *was* byte-identical, because the hardcoded string happened to
 * equal the CMS value. Every equality assertion in the suite passed for the same reason.
 *
 * **And a guard for exactly this already existed and was green.** `test/content.test.ts`
 * held "carries the content, so no copy of it is left under `src/`", scanning the whole of
 * `src/` for the seeded values — and it never saw the straggler, for two reasons that are
 * the design of this file:
 *
 *   1. Its needle list was **written by hand**. Seven fields were named. `class.slug` and
 *      `scheduleSlot.start` arrived with MUSE-36 and nobody added them, because a hand
 *      list does not ask to be extended.
 *   2. Its address needle was the **whole field**, „Ilica 209, Zagreb". The copy in the
 *      code was the **street half**, because `addressLines` splits that field for the
 *      footer's two-line `<address>` — so the value a page renders and the value the
 *      dataset stores are not the same string, and a needle that is a superstring of the
 *      copy matches nothing.
 *
 * That is the shape this file is about: **a check whose matching rule cannot reach the
 * case it exists for** (MUSE-17, MUSE-37, MUSE-42, MUSE-46) — and here the check that
 * could not reach it was the very check for this value. The old assertion is gone rather
 * than kept beside this one; two lists of forbidden values are two answers to one
 * question, and `test/content.test.ts` says so where it used to be.
 *
 * So this guard searches for neither an identifier nor a street. It takes the **values**
 * out of the committed seed, adds what the read path *derives* from them, and fails on any
 * copy under `src/`, naming the file and the line. Two edits would have closed the ticket;
 * they would not have stopped the sixth copy.
 *
 * ## Why the seed, and why `src/` only
 *
 * `sanity/seed/content.ndjson` is both the artefact `npm run sanity:seed` imports into the
 * dataset and the fixture every build in this suite reads (`vitest.config.ts`), so "what
 * the Studio publishes" is available as a file and the comparison needs no network call.
 *
 * The scan is scoped to `src/` because that is where a literal becomes a *published* page,
 * and because three other trees hold the same strings **on purpose**: `sanity/` states the
 * field's format and `initialValue` in the Studio's own help text, `test/content.test.ts`
 * freezes what the site published before the migration as a receipt, and this suite reads
 * the seed. A repo-wide scan would have to exempt all three, and an exemption list that
 * swallows the places the value legitimately lives is the defect, not the fix.
 *
 * The prose inside `src/` is **not** exempt, which is the MUSE-42 ruling applied: a stale
 * copy in a comment is believed rather than noticed. Two comments were reworded rather
 * than exempted while this landed — `src/lib/structured-data.ts`'s note about this very
 * ticket, and `src/components/Schedule.astro`'s note about its own fix — because a rule
 * that exempts its own first counter-example is not a rule.
 *
 * ## What it can and cannot see
 *
 * Only **string** leaves. `class.durationMin` is a number and `90` has no distinctive
 * spelling — it collides with a line-height, a padding and a percentage — so a textual
 * scan cannot tell a copy from a coincidence. That field is pinned a different way:
 * `uniformDuration` derives the lede's „90 minuta" off the rows and `test/schedule.test.ts`
 * holds the rendered timetable against the seed.
 *
 * Keys beginning with `_` are skipped by **rule**, not by a list: `_id`, `_type`, `_key`
 * and `_ref` are Sanity's own plumbing, they are what the queries are written against, and
 * a document type's name appearing in the module that reads it is not a duplicated value.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');

/* ------------------------------------------------------- the seed, as field paths */

/** One string value in the seed, and the field path it came from. */
interface Leaf {
  /** `siteSettings.address`, `page.title.hr`, `siteSettings.social[].url`. */
  path: string;
  value: string;
}

/**
 * Every string leaf in the seed, as `type.field…` paths.
 *
 * Keyed by document `_type` rather than `_id` so the registry below talks about *fields* —
 * a fifth `page` document introduces no new path and needs no decision, while a new field
 * on `siteSettings` does.
 */
function seedLeaves(): Leaf[] {
  const found: Leaf[] = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      if (value !== '') found.push({ path, value });
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry, `${path}[]`);
      return;
    }
    if (value !== null && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        // Sanity's plumbing, by rule rather than by name — see the note at the top.
        if (key.startsWith('_')) continue;
        walk(child, path === '' ? key : `${path}.${key}`);
      }
    }
  };
  for (const doc of seedDocs()) walk(doc, doc._type);
  return found;
}

/** Does `path` fall under `entry` — the same field, or a leaf of it? */
function under(path: string, entry: string): boolean {
  return path === entry || path.startsWith(`${entry}.`);
}

/* ------------------------------------------------------------------ the registry */

/**
 * **The fields whose values may not appear under `src/`, and why each one is a fact rather
 * than a word.**
 *
 * A path covers its leaves, so `siteSettings.tagline` covers `.hr` and `.en`.
 *
 * The test immediately below asserts that every path in the seed is either here or in
 * `MAY_APPEAR_IN_CODE`, so a new CMS field cannot arrive without this decision being made
 * for it. That is the half an exemption list cannot provide on its own: the risk is not a
 * wrong entry, it is a field nobody classified.
 */
const CMS_OWNS: { path: string; why: string }[] = [
  {
    path: 'siteSettings.address',
    why:
      'the ticket. One field, five surfaces — the footer on every page, `/`, `/contact`, ' +
      "the privacy notice's controller line and `/schedule`'s eyebrow. The street half is " +
      'a needle too; see `addressNeedles` for why the city half is not.',
  },
  {
    path: 'siteSettings.email',
    why:
      'the address the trial form and the privacy notice tell people to write to. A second ' +
      'copy is an inbox nobody reads, and it looks exactly like an inbox somebody does.',
  },
  {
    path: 'siteSettings.social[].url',
    why:
      'a mistyped or stale profile URL still looks like a link, which is why `socialUrl` ' +
      'fails the build rather than rendering an empty `href`. A literal defeats that.',
  },
  {
    path: 'siteSettings.tagline',
    why: "the footer blurb and the `og:description` fallback. Mina's words, both locales.",
  },
  {
    path: 'siteSettings.summary',
    why: "`llms.txt`'s description of the site. Mina's words.",
  },
  {
    path: 'page.title',
    why:
      "a page's `<title>`, which used to live in `src/lib/pages.ts` and is a `page` " +
      'document now (MUSE-20). The registry keeps the half that is structure; a title ' +
      'drifting back into it is the migration coming undone one string at a time.',
  },
  {
    path: 'page.description',
    why:
      'the same string twice over — `<meta name="description">` and the line `llms.txt` ' +
      'publishes — which is the whole reason there is one document per route.',
  },
  {
    path: 'class.slug',
    why:
      'authored in the Studio and nowhere else. Nothing under `src/` spells one today, ' +
      'and a slug typed into code is a join that silently stops matching when Mina ' +
      'renames the class.',
  },
  {
    path: 'scheduleSlot.start',
    why:
      'when a class actually runs. The shortest value covered here, and covered anyway: ' +
      '`src/data/schedule.ts` held thirteen invented rows naming two instructors who do ' +
      'not exist and it was live for the life of the project (MUSE-36). A clock time ' +
      'reappearing under `src/` is that bug restarting.',
  },
  {
    path: 'pricingTier.name',
    why:
      'what Mina calls a package — the `<h3>` on each card and the value the enrolment ' +
      "form submits (`packageValue`). The component's own copy table holds four " +
      'structural words and no package name, which is the shape MUSE-22 shipped on ' +
      'purpose; a name reappearing in code is that decision being undone.',
  },
  {
    path: 'pricingTier.features[]',
    why:
      'what a package includes, and in the two-month tier’s case the sentence that says ' +
      'the price is a discount. The one place on the site a „what you get" line may live, ' +
      'because it is a claim about what the studio sells — and the field MUSE-36 would ' +
      'have been filled with fiction if it had been written in code.',
  },
];

/**
 * **The fields a string under `src/` may legitimately equal, and why.**
 *
 * Every entry is asserted *live* below — the path must still exist in the seed, and at
 * least one of its values must still be found under `src/`. Each reason here is a form of
 * "the code already contains this string for its own reasons"; if no copy is left, there
 * is nothing to exempt and the field belongs in `CMS_OWNS`. A dead exemption fails
 * (MUSE-42) rather than quietly widening the hole.
 *
 * `class.slug` was drafted as an entry here and moved to `CMS_OWNS` by exactly that test:
 * no class slug appears under `src/`, so the exemption was already dead on arrival.
 */
const MAY_APPEAR_IN_CODE: { path: string; why: string }[] = [
  {
    path: 'siteSettings.studioName',
    why:
      'the brand. It is the header wordmark, the logo `alt`, the font-stack comments and ' +
      'half the prose in this repository — and it is not a fact that drifts: renaming the ' +
      'studio is a rebrand, not a Studio edit. Covering it would fail on four files that ' +
      'are all correct.',
  },
  {
    path: 'siteSettings.social[].platform',
    why:
      'the key the code asks *by*, not content: `socialUrl(settings, "instagram")` names ' +
      'the network because the link text is markup while the address is content. An ' +
      'identifier is supposed to be written down.',
  },
  {
    path: 'page.name',
    why:
      "ordinary words for ordinary pages. „Raspored\" is in `PRIMARY_NAV`'s label, in " +
      "`ROUTES[].studioLabel`, and in `/schedule`'s own eyebrow beside the street this " +
      'ticket just moved into the CMS — three correct spellings. The genuine duplication ' +
      'here is `studioLabel` against `page.name.hr` and it needs a *different* guard: ' +
      'equality pinning, not absence. See the note under "one guard, or two" below.',
  },
  {
    path: 'page.route',
    why:
      'code is its source. `ROUTES` in `src/lib/pages.ts` decides which pages exist and ' +
      "`sanity/schemaTypes/enums.ts` builds the Studio's dropdown from it, so the arrow " +
      'runs from here into the dataset. A route under `src/` is the original.',
  },
  {
    path: 'class.level',
    why:
      'a closed set the site *branches* on, so it stays in code (CLAUDE.md) and is ' +
      'imported into the schema. `LEVELS` is the source; `LEVEL_NAME` and ' +
      '`LEVEL_PREREQUISITE` are keyed by it.',
  },
  {
    path: 'scheduleSlot.day',
    why: 'the same, for `WEEKDAYS`.',
  },
  {
    path: 'pricingTier.period',
    why:
      'a closed set, like the levels and the weekdays — `PRICE_PERIODS` is the Studio’s ' +
      'half and `PERIOD_NAME` in `src/lib/pricing.ts` is the page’s, keyed by the same ' +
      'identifiers. The stored value is `month`, and the *word* („mjesečno" / "per ' +
      'month") is formatting, which CLAUDE.md keeps in code for the same reason ' +
      '`formatTime` is there. The identifier is supposed to be written down.',
  },
  {
    path: 'class.name',
    why:
      'what the studio teaches. „Bachata" is the subject of most sentences on the site ' +
      'and a word in the page copy, not a label rendered from this field.',
  },
  {
    path: 'instructor.name',
    why:
      'two first names, one of which is a substring of the studio name, the deploy host ' +
      'and this repository. A textual scan cannot tell a copy from the brand.',
  },
  {
    path: 'instructor.role',
    why:
      '„Instruktor" / "Instructor" — a job title, and a substring of the document type ' +
      'name that every module in the read path spells.',
  },
  {
    path: 'instructor.slug',
    why:
      'four characters that occur inside ordinary Croatian words — „termina" contains ' +
      '„mina" — so a substring scan would report the session-count copy on `/schedule` as ' +
      'a duplicated instructor slug.',
  },
];

/* ---------------------------------------------------------------- the needle set */

/**
 * The street, and only the street, out of the one `address` field.
 *
 * `addressLines` splits it on its one comma for the footer's two-line `<address>`, so the
 * street and the city are renderable values in their own right and a literal copy of
 * either is the same drift as a copy of the whole. The split is reproduced here rather
 * than imported because importing it would need a whole `SiteSettings`; the comma is the
 * contract either way and `ADDRESS_PATTERN` makes the Studio refuse anything else.
 *
 * **The city half is deliberately not a needle.** „Zagreb" is an ordinary word in both
 * languages and every occurrence under `src/` is correct: the homepage h1 declines it
 * („Nauči bachatu u Zagrebu" — a CMS value cannot supply a case ending), the privacy
 * notice prints the *regulator's* address in Zagreb, `src/lib/rebuild.ts` reasons about
 * the timezone, and `src/lib/structured-data.ts` quotes the search phrase the studio
 * competes on. Banning it would ban the sentences the site is made of. The exemption is
 * asserted live below, the same way the entries in `MAY_APPEAR_IN_CODE` are.
 */
function addressNeedles(address: string): string[] {
  const parts = address.split(',').map((part) => part.trim());
  const street = parts[0];
  expect(parts.length, `the seed's address should be street, comma, city: ${address}`).toBe(2);
  expect(street, 'the seed address has a street half').toBeTruthy();
  return [address, street!];
}

function seedAddress(): string {
  const settings = seedDocs().find((doc) => doc._type === 'siteSettings');
  if (!settings) throw new Error('The seed has no `siteSettings` document.');
  const address = settings.address;
  if (typeof address !== 'string') throw new Error('`siteSettings.address` is not a string.');
  return address;
}

/** Every string that may not appear under `src/`, with the field it belongs to. */
function needles(): Leaf[] {
  const fromRegistry = seedLeaves().filter((leaf) =>
    CMS_OWNS.some(({ path }) => under(leaf.path, path)),
  );
  const derived = addressNeedles(seedAddress()).map((value) => ({
    path: 'siteSettings.address',
    value,
  }));
  const seen = new Set<string>();
  return [...fromRegistry, ...derived].filter((leaf) => {
    const key = `${leaf.path} ${leaf.value}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* --------------------------------------------------------------------- the scan */

/** Every file under `dir`, recursively, as paths relative to `base` (`dir` by default). */
function filesUnder(dir: string, base: string = dir): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? filesUnder(full, base) : [full];
    })
    .map((file) => relative(base, file).replace(/\\/g, '/'))
    .sort();
}

/** The scan, as the real check runs it: every file under `src/`, named from the repo root. */
function sourceFiles(): string[] {
  return filesUnder(SRC, ROOT);
}

/** One duplicated value, located well enough to go and delete. */
interface Copy {
  file: string;
  line: number;
  path: string;
  value: string;
}

/**
 * Every copy of a needle in `files`, as `file:line`.
 *
 * Read as bytes first so a font or an image in `src/assets/` costs one `includes` rather
 * than a UTF-8 decode, and so no extension allow-list decides what gets scanned — an
 * extension filter is what made `fields.tsx` invisible to the schema gate.
 */
function copiesIn(files: string[], root: string, wanted: Leaf[]): Copy[] {
  const found: Copy[] = [];
  for (const file of files) {
    const bytes = readFileSync(join(root, file));
    const hits = wanted.filter((leaf) => bytes.includes(leaf.value));
    if (hits.length === 0) continue;
    const lines = bytes.toString('utf8').split('\n');
    for (const leaf of hits) {
      lines.forEach((text, index) => {
        if (text.includes(leaf.value)) {
          found.push({ file, line: index + 1, path: leaf.path, value: leaf.value });
        }
      });
    }
  }
  return found;
}

/** A failure a human can act on without opening this file. */
function report(copies: Copy[]): string[] {
  return copies.map(
    ({ file, line, path, value }) =>
      `${file}:${line} duplicates \`${path}\` = ${JSON.stringify(value)} — ` +
      `read it from the CMS instead`,
  );
}

describe('MUSE-50: the CMS owns these values, and `src/` holds no copy', () => {
  it('classifies every field in the seed, so a new one cannot slip through unjudged', () => {
    // The anti-narrowing assertion. A field added to `siteSettings` next month is either
    // a fact the pages must read or a word the code may spell, and this is where somebody
    // has to say which — not six months later in a ticket like this one.
    const unjudged = [...new Set(seedLeaves().map((leaf) => leaf.path))]
      .filter(
        (path) =>
          !CMS_OWNS.some((entry) => under(path, entry.path)) &&
          !MAY_APPEAR_IN_CODE.some((entry) => under(path, entry.path)),
      )
      .sort();
    expect(unjudged).toEqual([]);
  });

  it('puts no field in both lists', () => {
    const both = CMS_OWNS.filter(({ path }) =>
      MAY_APPEAR_IN_CODE.some((entry) => under(path, entry.path) || under(entry.path, path)),
    ).map(({ path }) => path);
    expect(both).toEqual([]);
  });

  it('has a needle for every covered field, and none of them empty', () => {
    const paths = new Set(needles().map((leaf) => leaf.path));
    const silent = CMS_OWNS.filter(
      ({ path }) => ![...paths].some((found) => under(found, path)),
    ).map(({ path, why }) => `${path} is covered and matches nothing in the seed (${why})`);
    expect(silent).toEqual([]);
    expect(needles().filter((leaf) => leaf.value.trim() === '')).toEqual([]);
  });

  /** The criterion that matters. */
  it('finds no copy of a CMS-owned value anywhere under src/', () => {
    expect(report(copiesIn(sourceFiles(), ROOT, needles()))).toEqual([]);
  });

  it('scans every directory src/ actually has, naming none of them', () => {
    // Derived from disk, so a new directory under `src/` is swept the day it lands with
    // nobody editing this file. The old MUSE-20 review failed by searching the wrong
    // *thing*; a hardcoded tree list is how the same review fails by searching the wrong
    // *place*.
    const scanned = new Set(sourceFiles().map((file) => file.split('/').slice(0, 2).join('/')));
    for (const entry of readdirSync(SRC, { withFileTypes: true })) {
      if (entry.isDirectory() && readdirSync(join(SRC, entry.name)).length === 0) continue;
      expect(scanned.has(`src/${entry.name}`), `src/${entry.name} is unscanned`).toBe(true);
    }
    // And the trees the straggler and its four siblings live in, named because they are
    // the ones this ticket is about.
    for (const tree of ['src/components/', 'src/pages/', 'src/lib/', 'src/layouts/']) {
      expect(
        sourceFiles().filter((file) => file.startsWith(tree)).length,
        `${tree} is unscanned`,
      ).toBeGreaterThan(0);
    }
  });

  it('keeps every exemption live, so the list cannot rot into a blanket', () => {
    const text = sourceFiles().map((file) => readFileSync(join(ROOT, file)));
    const leaves = seedLeaves();
    for (const { path, why } of MAY_APPEAR_IN_CODE) {
      const values = leaves.filter((leaf) => under(leaf.path, path)).map((leaf) => leaf.value);
      expect(values.length, `${path} is exempt and is not a field in the seed`)
        .toBeGreaterThan(0);
      const spelled = values.some((value) => text.some((bytes) => bytes.includes(value)));
      expect(
        spelled,
        `nothing under src/ spells ${path} any more, so the exemption ("${why}") is ` +
          'dead — move it to CMS_OWNS',
      ).toBe(true);
    }
  });

  it('keeps the city half of the address exempt for a reason that is still true', () => {
    const [, street] = addressNeedles(seedAddress());
    const city = seedAddress()
      .split(',')
      .map((part) => part.trim())[1]!;
    // Not a needle, and the counter-examples are what makes that a decision rather than a
    // convenience: if the city ever stops appearing under `src/`, it should be covered.
    const spelling = sourceFiles().filter((file) =>
      readFileSync(join(ROOT, file)).includes(city),
    );
    expect(
      spelling.length,
      `nothing under src/ spells ${JSON.stringify(city)} any more — cover it`,
    ).toBeGreaterThan(0);
    expect(needles().map((leaf) => leaf.value)).toContain(street);
    expect(needles().map((leaf) => leaf.value)).not.toContain(city);
  });

  /**
   * **The teeth, in the suite rather than in a ticket's verification steps.**
   *
   * The whole point of MUSE-50 is that a check can be green while unable to see the thing
   * it is for. So the scanner is run over a tree built to contain a copy, and has to
   * report it with the file and the line — the same two facts a `STUDIO.street` grep would
   * have given the MUSE-20 reviewer, and the reason a `dist`-only assertion is not enough.
   */
  it('reports a copy with its file and its line when there is one', () => {
    const planted = claimOutDir('contentdrift-teeth');
    const [address, street] = addressNeedles(seedAddress());
    writeFileSync(
      join(planted, 'Straggler.astro'),
      [
        '---',
        'const t = {',
        `  hr: { eyebrow: 'Raspored · ${street}' },`,
        '};',
        '---',
        `<p>${address}</p>`,
        '',
      ].join('\n'),
    );
    const copies = copiesIn(filesUnder(planted), planted, needles());

    // The composed label, at the line it is on — the exact case the identifier grep missed.
    expect(copies).toContainEqual({
      file: 'Straggler.astro',
      line: 3,
      path: 'siteSettings.address',
      value: street!,
    });
    // And the whole field, so the needle set is not only its derived half.
    expect(copies.map(({ value }) => value)).toContain(address);
    const printed = report(copies).join('\n');
    expect(printed).toContain('Straggler.astro:3');
    expect(printed).toContain('siteSettings.address');
  });

  it('does not fire on a value only an exempt field has', () => {
    // The other direction, so the scan's silence on the exemptions is a property of the
    // scan rather than of the files that happen to be in `src/` today.
    const planted = claimOutDir('contentdrift-exempt');
    const leaves = seedLeaves();
    const exemptValues = MAY_APPEAR_IN_CODE.flatMap(({ path }) =>
      leaves.filter((leaf) => under(leaf.path, path)).map((leaf) => leaf.value),
    );
    writeFileSync(join(planted, 'Innocent.astro'), exemptValues.join('\n') + '\n');
    expect(report(copiesIn(filesUnder(planted), planted, needles()))).toEqual([]);
  });
});

/* ------------------------------------------------- five of five, against a build */

/**
 * **AC1 and AC2: the street on `/schedule` comes from the dataset, and all five surfaces
 * move together.**
 *
 * Asserted against a real build of an *edited* dataset, because that is the only assertion
 * a hardcoded copy fails — every equality test against today's output passes while the
 * literal still happens to match the CMS, which is exactly how this shipped. One build,
 * not two: the edited street has to appear on all five surfaces *and* the seeded street
 * has to appear nowhere, which is a complete claim about one output tree.
 *
 * The edit is deliberately a different street *and* a different city, so a surface that
 * renders the whole field and one that renders only the street half are told apart.
 *
 * `summary` is edited too, and only because **Mina's own prose mentions the street** — the
 * one-line description `llms.txt` publishes reads "a dance studio in Zagreb (…)". That is a
 * copy in the *dataset*, which is where a copy is allowed to be: she wrote the sentence and
 * she would reword it the day the studio moved. The fixture does the rewording so that
 * "the seeded street appears nowhere in the output" can be the flat claim it ought to be,
 * rather than an assertion with a carve-out that a real literal could hide inside.
 */
const EDITED_ADDRESS = 'Nova ulica 7, Split';

let edited: Build;
let editedStreet = '';
let editedCity = '';
let seededStreet = '';

function fixtureOf(docs: unknown[]): string {
  const path = join(claimOutDir('contentdrift-fixture'), 'content.ndjson');
  writeFileSync(path, docs.map((doc) => JSON.stringify(doc)).join('\n') + '\n');
  return path;
}

beforeAll(() => {
  const settings = seedDocs().find((doc) => doc._type === 'siteSettings') as SeedDoc;
  [editedStreet, editedCity] = EDITED_ADDRESS.split(',').map((part) => part.trim()) as [
    string,
    string,
  ];
  seededStreet = addressNeedles(seedAddress())[1]!;
  const summary = settings.summary as Record<string, unknown>;
  edited = buildSite(PAGES_DEPLOY, {
    MUSE_CONTENT_FIXTURE: fixtureOf([
      ...seedDocs().filter((doc) => doc._id !== settings._id),
      {
        ...settings,
        address: EDITED_ADDRESS,
        summary: Object.fromEntries(
          Object.entries(summary).map(([key, text]) => [
            key,
            typeof text === 'string' ? text.split(seededStreet).join(editedStreet) : text,
          ]),
        ),
      },
    ]),
  });
}, 240_000);

describe('AC1/AC2: one address field, five surfaces, all of them following it', () => {
  it('edits to something that really differs from the seed', () => {
    // Otherwise every assertion below is satisfied by the literal this ticket removed.
    expect(EDITED_ADDRESS).not.toBe(seedAddress());
    expect(editedStreet).not.toBe(seededStreet);
    expect(seededStreet).toBeTruthy();
  });

  it('moves the street inside the summary too, or the claim below is not flat', () => {
    // A guard against this fixture going subtly wrong: if the seed's summary ever stops
    // mentioning the street, the edit above is a no-op and the next test is weaker than it
    // looks — so say that out loud rather than letting it drift.
    const summary = seedDocs().find((doc) => doc._type === 'siteSettings')!.summary as Record<
      string,
      unknown
    >;
    const mentions = Object.values(summary).filter(
      (text) => typeof text === 'string' && text.includes(seededStreet),
    );
    expect(
      mentions.length,
      "the seed's summary no longer names the street — drop the summary edit above",
    ).toBeGreaterThan(0);
  });

  it('leaves the seeded street nowhere in the output — not one byte', () => {
    const stale = edited
      .allFiles()
      .filter((file) => readFileSync(join(edited.outDir, file)).includes(seededStreet));
    expect(stale).toEqual([]);
  });

  it('surface 1 — the footer, on every page, in two lines', () => {
    const missing = edited
      .htmlFiles()
      .filter(
        (file) =>
          !new RegExp(`<address[^>]*>${editedStreet}<br[^>]*>${editedCity},`).test(
            edited.read(file),
          ),
      );
    expect(missing).toEqual([]);
  });

  it('surface 2 — the homepage, whole', () => {
    for (const file of ['index.html', 'en/index.html']) {
      expect(edited.read(file), file).toContain(EDITED_ADDRESS);
    }
  });

  it('surface 3 — /contact, whole', () => {
    for (const file of ['contact/index.html', 'en/contact/index.html']) {
      expect(edited.read(file), file).toContain(EDITED_ADDRESS);
    }
  });

  it('surface 4 — the privacy notice, in the controller line', () => {
    for (const file of ['privacy/index.html', 'en/privacy/index.html']) {
      expect(edited.read(file), file).toContain(EDITED_ADDRESS);
    }
  });

  /**
   * **AC4: a composition change, not a copy change.**
   *
   * The `·` separator and the locale's own word for the page are unchanged — only the
   * street moved behind them. Pinned per locale and with the separator in the needle, so
   * reading the street from the CMS and then dropping the label, or joining with a hyphen,
   * fails here rather than being noticed on the deployed page.
   */
  it('surface 5 — /schedule, the eyebrow this ticket was filed about', () => {
    for (const [file, label] of [
      ['schedule/index.html', 'Raspored'],
      ['en/schedule/index.html', 'Schedule'],
    ] as const) {
      expect(edited.read(file), file).toContain(`${label} · ${editedStreet}`);
      // The street alone, never the whole field: „Raspored · Nova ulica 7, Split" would be
      // a different label.
      expect(edited.read(file), file).not.toContain(`${label} · ${EDITED_ADDRESS}`);
    }
  });

  it('and the JSON-LD block beside them, which is the same claim in another syntax', () => {
    for (const file of edited.htmlFiles().filter((f) => !f.endsWith('404.html'))) {
      const html = edited.read(file);
      expect(html, file).toContain(`"streetAddress":"${editedStreet}"`);
      expect(html, file).toContain(`"addressLocality":"${editedCity}"`);
    }
  });
});

/* --------------------------------------------------------------- one guard, or two */

/**
 * **`ROUTES[].studioLabel` against `page.name.hr`: the same family, and not this guard.**
 *
 * MUSE-50 asked whether one guard covers both. It does not, and the reason is the shape of
 * the duplication rather than a question of effort.
 *
 * `studioLabel` is *supposed* to be in code. It is what the Studio's route dropdown calls
 * a page, it has to exist for a route that has no `page` document yet, and the dropdown is
 * built from `ROUTES` precisely so a document cannot invent a route. So the claim is not
 * "this string must not appear under `src/`" — absence is what the scan above tests — it is
 * "where both exist, they must agree". That is equality pinning, and it needs the *routes*
 * as its key rather than the values as needles.
 *
 * It is also the weaker of the two claims, which is why it is asserted here and not left
 * to MUSE-46: comparing code to the seed catches a rename made in code, and cannot catch
 * one Mina makes in the Studio — the seed ages against the dataset, and
 * `npm run sanity:seed:check` is the thing that reports that. Named so the limit is on the
 * record rather than discovered later.
 */
describe('MUSE-46, noted here: a route labelled in code agrees with its document', () => {
  it('matches each studioLabel to its page document name', async () => {
    const { ROUTES } = await import('../src/lib/pages');
    const documented = new Map(
      seedDocs()
        .filter((doc) => doc._type === 'page')
        .map((doc) => [doc.route as string, (doc.name as Record<string, string>).hr]),
    );
    // Only the routes that have a document: a label for a page the CMS does not describe
    // yet is the case `studioLabel` exists for.
    const disagree = ROUTES.filter((route) => documented.has(route.route))
      .filter((route) => documented.get(route.route) !== route.studioLabel)
      .map(
        (route) =>
          `${route.route}: ROUTES says ${JSON.stringify(route.studioLabel)}, the ` +
          `document says ${JSON.stringify(documented.get(route.route))}`,
      );
    expect(disagree).toEqual([]);
    // And the comparison is not vacuous.
    expect(ROUTES.filter((route) => documented.has(route.route)).length).toBeGreaterThan(0);
  });
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONTENT_TYPES,
  seedAdvice,
  seedReport,
  seedVerdict,
  UNSEEDED_QUERY,
} from '../scripts/sanity-seed-check.mjs';
import { parseSeed, readSeed } from '../scripts/seed-compare.mjs';
import { frag } from './helpers/source-guard';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/**
 * MUSE-123 — **a document in the dataset and in neither seed, which both comparisons
 * were structurally unable to see.**
 *
 * `npm run sanity:seed:check` and `npm run sanity:seed:release` both fetch the dataset
 * **by `_id`, taken from the seed**: `*[_id in $ids]`. MUSE-83 widened the release
 * gate's ids to the union of the base and head seeds, which is what makes a *dropped*
 * document visible — but a document whose `_id` appears in no seed at all is outside
 * both queries, so neither check could report it however carefully it was read.
 *
 * Two ways that happens, and one has already happened:
 *
 *   - **Created in the Studio and never seeded.** MUSE-60 found the live dataset holding
 *     a `studioStory` carrying `foundedOn: "2025-01-01"` — a founding date nobody has
 *     confirmed — and paragraphs reading „PLACEHOLDER … nije istinit". It published
 *     nothing only because `/aboutus` was not yet a route. Had the route landed without
 *     the seed import, the build would not have *failed* on that document; it would have
 *     rendered it.
 *   - **Dropped by an older branch and never deleted.** `npm run sanity:seed` is
 *     `--replace` and never deletes, so a document retired from the seed in a past
 *     branch is still live — and the branch that retired it is long merged, so its diff
 *     against the merge base no longer mentions it.
 *
 * It belongs in **`sanity:seed:check`, not in `sanity:seed:release`**. The release gate
 * blocks, and a document Mina created legitimately is precisely the case that must not
 * fail a pull request (MUSE-45). This check reports without blocking, which is the right
 * register for „the dataset holds something the seed does not describe".
 *
 * **It cannot be exercised by writing to the dataset** — no script here holds a
 * credential and none should — so the comparison is a pure function of the seed, the
 * dataset's reply and the type scope, and this file drives it against fixtures.
 * `test/seedrelease.test.ts` does the same for the release gate's verdict, and that is
 * the shape copied here deliberately: no build, no dev server, no browser, because
 * MUSE-68's heavyweight total is at 84 with zero headroom.
 */

/* ------------------------------------------------------------------ fixtures */

type Doc = Record<string, unknown> & { _id: string; _type: string };

/** A `page` document in the shape the seed holds one. */
const page = (id: string, hr = 'Muse by Mina'): Doc => ({
  _id: id,
  _type: 'page',
  route: id === 'page-home' ? '/' : `/${id.replace('page-', '')}`,
  title: { _type: 'localeString', hr: 'Muse by Mina', en: 'Muse by Mina' },
  description: { _type: 'localeString', hr, en: 'A dance studio in Zagreb.' },
});

/** The row shape the dataset answers the index query with: an id and a type, no fields. */
const row = (id: string, type: string): { _id: string; _type: string } => ({
  _id: id,
  _type: type,
});

/** The index the dataset would answer with for a set of documents. */
const indexOf = (docs: Doc[]): { _id: string; _type: string }[] =>
  docs.map((doc) => row(doc._id, doc._type));

/** MUSE-60's document, as it actually stood in the dataset. */
const UNSEEDED_STORY: Doc = {
  _id: 'studioStory',
  _type: 'studioStory',
  heading: { _type: 'localeString', hr: 'Naša priča', en: 'Our story' },
  foundedOn: '2025-01-01',
};

const SEEDED = [page('page-home'), page('page-contact')];

const lines = (verdict: ReturnType<typeof seedVerdict>): string =>
  [...seedReport(verdict), ...seedAdvice(verdict)].join('\n');

/* ------------------------------------------------------------------ 1. the gap */

describe('a document in the dataset and in neither seed', () => {
  /**
   * AC1. The dataset holds three documents, the seed describes two, and the third is
   * reported with both the things that identify it: a human needs the `_id` to delete it
   * or to seed it, and the `_type` to know what it is before doing either.
   */
  it('is named, with its `_id` and its `_type`', () => {
    const verdict = seedVerdict({
      seeded: SEEDED,
      live: SEEDED,
      index: indexOf([...SEEDED, UNSEEDED_STORY]),
    });

    expect(verdict.unseeded).toEqual([{ _id: 'studioStory', _type: 'studioStory' }]);
    expect(lines(verdict)).toContain('studioStory (studioStory)');
  });

  /**
   * The same case stated as MUSE-60's rather than as a hypothetical, because the point of
   * the ticket is that this has happened once already and was found by hand. The
   * document is not drift and not a missing document — the two words this check had — so
   * the verdict has to carry a third list or the report cannot mention it at all.
   */
  it('is not reported as drift and not as missing, because it is neither', () => {
    const verdict = seedVerdict({
      seeded: SEEDED,
      live: SEEDED,
      index: indexOf([...SEEDED, UNSEEDED_STORY]),
    });

    expect(verdict.drifted).toEqual([]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.unseeded).toHaveLength(1);
    expect(verdict.disagrees, 'it is still something to report').toBe(true);
  });

  /**
   * The second way it happens, which has no document of its own to point at yet.
   * `npm run sanity:seed` is `sanity dataset import --replace`: it replaces by `_id` and
   * **never deletes**. So a document a past branch retired from the seed is still live,
   * and MUSE-83's union of the base and head seeds cannot see it either — that union is
   * taken against the merge base, and the branch that dropped it merged months ago.
   */
  it('reports a document an older branch dropped from the seed and nobody deleted', () => {
    const verdict = seedVerdict({
      seeded: SEEDED,
      live: SEEDED,
      index: [...indexOf(SEEDED), row('pricing-dropin', 'pricingTier')],
    });

    expect(verdict.unseeded).toEqual([{ _id: 'pricing-dropin', _type: 'pricingTier' }]);
    expect(lines(verdict)).toContain('pricing-dropin (pricingTier)');
  });

  /** More than one, in a stable order, because a set of them is a list somebody reads. */
  it('reports every one of them, sorted by `_id`', () => {
    const verdict = seedVerdict({
      seeded: SEEDED,
      live: SEEDED,
      index: [
        ...indexOf(SEEDED),
        row('zzz-last', 'faq'),
        row('aaa-first', 'event'),
        row('mmm-middle', 'galleryImage'),
      ],
    });

    expect(verdict.unseeded.map((doc) => doc._id)).toEqual([
      'aaa-first',
      'mmm-middle',
      'zzz-last',
    ]);
  });
});

/* ------------------------------------------------------------------ 2. the scope */

describe('Sanity’s own asset documents are in the dataset legitimately', () => {
  /**
   * AC5. Every dataset holds `sanity.imageAsset` and `sanity.fileAsset` records whether
   * or not this project uploads anything, and no seed line will ever describe one: the
   * queries project `asset._ref` off the *referring* document and build the URL from the
   * id, so the asset document itself is read by nothing. Reported as drift they would be
   * the whole output, and the one real finding would be a line in the middle of it.
   */
  it('are not reported, however many of them there are', () => {
    const verdict = seedVerdict({
      seeded: SEEDED,
      live: SEEDED,
      index: [
        ...indexOf(SEEDED),
        row('image-abc123-1200x800-jpg', 'sanity.imageAsset'),
        row('file-def456-pdf', 'sanity.fileAsset'),
      ],
    });

    expect(verdict.unseeded).toEqual([]);
    expect(verdict.disagrees).toBe(false);
  });

  /**
   * And the scope is not a hand-written list of types to ignore: it is the document types
   * the read path reads, which `scripts/check-sanity.mjs` already keeps exhaustive — the
   * schema gate fails on a document type that is in neither `READ_CONTRACT` nor
   * `NOT_READ` (MUSE-66). So a new document type Mina fills in joins this scope by
   * joining that contract, and the two `sanity.*` records are excluded because somebody
   * wrote down *why* they are not content rather than because a filter mentions them.
   */
  it('take their exclusion from the read contract, not from a list kept here', () => {
    expect(CONTENT_TYPES).toContain('studioStory');
    expect(CONTENT_TYPES).toContain('pricingTier');
    expect(CONTENT_TYPES.filter((type) => type.startsWith('sanity.'))).toEqual([]);

    // The scope has to cover everything the seed describes, or an unseeded document of a
    // seeded type would be invisible for the opposite reason.
    const seedTypes = [...new Set(parseSeed(readSeed()).map((doc) => doc._type))].sort();
    expect(seedTypes.length).toBeGreaterThan(5);
    for (const type of seedTypes) expect(CONTENT_TYPES, type).toContain(type);
  });

  /**
   * The rule is in the function, not only in the query. The GROQ narrows the reply so the
   * payload is the dataset's content rather than its asset table, but a reply that
   * arrived unnarrowed — a hand-run query, a future caller — must still produce the same
   * verdict, so the type scope is applied to the rows as well.
   */
  it('is a property of the comparison, not only of the query', () => {
    expect(UNSEEDED_QUERY).toContain('$types');
    const verdict = seedVerdict({
      seeded: SEEDED,
      live: SEEDED,
      index: [...indexOf(SEEDED), row('image-abc123-1200x800-jpg', 'sanity.imageAsset')],
      types: CONTENT_TYPES,
    });
    expect(verdict.unseeded).toEqual([]);
  });
});

/* ------------------------------------------------------------------ 3. agreement */

describe('a dataset that matches the seed exactly', () => {
  /** AC3. Nothing to report, and the report says so rather than being silent. */
  it('reports nothing, and says there was nothing to report', () => {
    const verdict = seedVerdict({ seeded: SEEDED, live: SEEDED, index: indexOf(SEEDED) });

    expect(verdict.unseeded).toEqual([]);
    expect(verdict.missing).toEqual([]);
    expect(verdict.drifted).toEqual([]);
    expect(verdict.disagrees).toBe(false);
    expect(seedAdvice(verdict)).toEqual([]);
    expect(seedReport(verdict).join('\n')).toContain('0 unseeded');
  });

  /**
   * Against the seed that is actually committed, as `test/seedrelease.test.ts` does it:
   * if the index comparison disagreed with itself about `_id`s the check would report
   * twenty-odd findings on a dataset that is exactly right, and the first person to see
   * that would stop reading the output.
   */
  it('finds nothing unseeded when the dataset is the committed seed', () => {
    const seed = parseSeed(readSeed()) as Doc[];
    expect(seed.length).toBeGreaterThan(10);

    const verdict = seedVerdict({ seeded: seed, live: seed, index: indexOf(seed) });
    expect(verdict.unseeded).toEqual([]);
    expect(verdict.disagrees).toBe(false);
  });

  /**
   * The two findings this check already had, kept working. The unseeded list is a third
   * list beside them, not a replacement for either, and a refactor that quietly lost the
   * drift report would be a worse defect than the one being fixed.
   */
  it('still reports a missing document and a drifted field', () => {
    const edited = page('page-contact', 'Nešto drugo.');
    const verdict = seedVerdict({
      seeded: SEEDED,
      live: [edited],
      index: indexOf([edited]),
    });

    expect(verdict.missing).toEqual([{ _id: 'page-home', _type: 'page' }]);
    expect(verdict.drifted.map((doc) => doc._id)).toEqual(['page-contact']);
    expect(verdict.drifted[0].changed.map((change) => change.path)).toEqual([
      'description.hr',
    ]);

    const printed = lines(verdict);
    expect(printed).toContain('MISSING');
    expect(printed).toContain('DRIFTED');
    expect(printed).toContain('Nešto drugo.');
    expect(verdict.disagrees).toBe(true);
  });
});

/* ------------------------------------------------------------------ 4. failing open */

describe('an unreachable API', () => {
  /**
   * AC4, and the release gate's reasoning verbatim: „we could not tell" must not be a
   * finding. Since MUSE-20 `npm run build` fetches the dataset and hard-fails if Sanity
   * does not answer — in two `ci.yml` jobs and in `deploy.yml` — so an outage is already
   * red everywhere it matters. A second red for the same outage only teaches people to
   * ignore this one.
   */
  it('is not a disagreement, and the report says why not', () => {
    const verdict = seedVerdict({ seeded: SEEDED, live: null, index: null });

    expect(verdict.unreadable).toBe(true);
    expect(verdict.disagrees, 'the exit code is this flag').toBe(false);
    expect(seedAdvice(verdict)).toEqual([]);
    expect(seedReport(verdict).join('\n')).toContain('could not be read');
  });

  /**
   * Either read failing is the same answer. The check makes two requests now — the
   * documents the seed names, and what the dataset holds — and a verdict assembled from
   * one of them would report every unseeded document as absent, or every seeded document
   * as missing, on a half-answered outage.
   */
  it('fails open when either of the two reads is the one that failed', () => {
    expect(seedVerdict({ seeded: SEEDED, live: SEEDED, index: null }).unreadable).toBe(true);
    expect(seedVerdict({ seeded: SEEDED, live: null, index: indexOf(SEEDED) }).unreadable).toBe(
      true,
    );
    expect(seedVerdict({ seeded: SEEDED, live: null, index: null }).unseeded).toEqual([]);
  });
});

/* ------------------------------------------------------------------ 5. the wiring */

describe('it reports, and nothing fails because of it', () => {
  /**
   * AC2, and MUSE-45's property: a document Mina created in the Studio is the case this
   * must never block on. Three things keep that true and all three are checked, because
   * the one that is easy to undo is the workflow step.
   */
  it('stays out of the build and out of the blocking gate', () => {
    const scripts = JSON.parse(read('package.json')).scripts as Record<string, string>;
    expect(scripts.build).not.toContain('seed:check');
    expect(scripts['sanity:check']).not.toContain('seed:check');
    expect(scripts['sanity:seed:check']).toContain('sanity-seed-check.mjs');

    // The blocking gate does not acquire the question. `test/seedrelease.test.ts` owns
    // the direction argument; this is the half of it that says where the new check went.
    const release = read('scripts/sanity-seed-release.mjs');
    expect(release).not.toContain('sanity-seed-check');
    expect(release).not.toContain('$types');
  });

  it('is the `continue-on-error` step in ci.yml, and stays it', () => {
    const steps = read('.github/workflows/ci.yml').split(/^      - name: /m).slice(1);
    const named = (fragment: string): string => {
      const found = steps.filter((step) => step.includes(fragment));
      expect(found, `exactly one step runs ${fragment}`).toHaveLength(1);
      return found[0];
    };

    expect(named('npm run sanity:seed:check')).toContain('continue-on-error: true');
    expect(named('npm run sanity:seed:release')).not.toContain('continue-on-error');
  });

  /**
   * Read-only, stated against what the file does rather than against words in it — the
   * script's own prose has to name `sanity documents delete` and `npm run sanity:seed`,
   * because telling somebody what to do about an unseeded document is the whole output,
   * and a scan for those phrases would fail on the instruction (MUSE-34, MUSE-76).
   *
   * So: the only Sanity endpoint it reaches is the query one, it spawns no program at
   * all, and it reads no environment of its own — the project, dataset and API version
   * come from `target()` in `scripts/seed-compare.mjs`, whose five names
   * `test/seedrelease.test.ts` already pins. A credential has nowhere to enter.
   */
  it('can report a write, never perform one', () => {
    const source = read('scripts/sanity-seed-check.mjs');

    expect(source).not.toContain('data/mutate');
    expect(source).toContain('queryUrl');
    expect([...source.matchAll(new RegExp(`${frag('exec', 'File')}`, 'g'))]).toEqual([]);
    expect([...source.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)].map(([, name]) => name)).toEqual(
      [],
    );
  });
});

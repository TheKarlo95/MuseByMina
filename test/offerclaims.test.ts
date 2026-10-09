import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  claimsIn,
  INNOCENT,
  report,
  RETIRED_CLAIMS,
  WAS_PUBLISHED,
  type Offence,
} from './helpers/offer-claims';

/**
 * **MUSE-71 — the site offered a free first class and the studio does not.**
 *
 * The claim and the evidence against it are written out in `test/helpers/offer-claims.ts`,
 * which holds the rule because two suites apply it: this one reads the *sources* a claim
 * could come back from, and `test/content.test.ts` reads the **built output**, using the
 * build it already performs. Splitting it that way is not tidiness — `npm test`'s
 * heavyweight budget has zero headroom by construction (`test/helpers/concurrency.ts`), so
 * a guard that wanted its own `astro build` would have to spend somebody else's, and the
 * two halves answer different questions anyway:
 *
 *   - **here**, which *file and line* to go and fix, which `dist` can never say;
 *   - **there**, whether a visitor can read it — the only level at which a claim *composed*
 *     at render time out of innocent fragments shows up at all. That is MUSE-50's lesson
 *     and the reason the output half is not optional.
 *
 * ## What is scanned, and why those three trees
 *
 *   - `src/` — where a literal becomes a published page. This is where five of the six
 *     live strings were.
 *   - `content/seed.ndjson` — the sixth and seventh: `page-home.description` and
 *     `page-contact.description`, which are also the two `<meta name="description">` tags
 *     and two `llms.txt` lines. It is scanned as **text**, not as parsed documents, so a
 *     claim in a field nobody has written a reader for yet is still found.
 *   - `sanity/` — the Studio. A claim in a field `description` or an `initialValue` is a
 *     claim the Studio *proposes to Mina*, which is how it would come back without anybody
 *     deciding to bring it back.
 *
 * **`test/` and the repository's prose are deliberately not scanned**, which is where this
 * parts company with MUSE-42's host guard. That rule fails a host named anywhere, prose
 * included, because a stale host in a README reaches nobody and is still believed. A
 * *retired claim* is the opposite: the wording has to be quotable or the guard cannot be
 * reviewed and the history cannot be written down. It is quoted in the helper, in
 * `test/content.test.ts`'s `PUBLISHED_BEFORE_THE_MIGRATION` receipt, and in `CLAUDE.md`.
 * What is scanned is every tree from which a string can reach a page.
 *
 * ## What this is not
 *
 * The ticket's fourth criterion asks that "reintroducing an unconfirmed price or offer
 * claim" fails. Only half of that is checkable. `test/contentdrift.test.ts` classifies
 * every string field in the seed as CMS-owned or in-code and asserts that classification
 * is complete — and it could not have caught this, because `page.description` *was*
 * CMS-owned and the string *was* in the CMS. A registry can ask where a value lives; **it
 * cannot ask whether a human said it**, and neither can this file. So the claim is pinned
 * by name rather than by category, and prices are left alone: 55 € and 100 € are confirmed,
 * `/pricing` publishes them on purpose (`test/pricing.test.ts`'s `CONFIRMED_TIERS` is the
 * receipt for those), and a needle that matched any price would fail on the page whose job
 * is to show them.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEED = 'content/seed.ndjson';

/** Every file under `dir`, recursively, named from the repository root. */
function filesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true })
    .flatMap((entry) => {
      const child = `${dir}/${entry.name}`;
      return entry.isDirectory() ? filesUnder(child) : [child];
    })
    .sort();
}

/**
 * Every scanned file, with its text.
 *
 * **No extension allow-list** — that is what made `fields.tsx` invisible to the schema
 * gate (MUSE-19), and a claim can live in a `.json`, an `.mjs` or a file type nobody has
 * added yet. Binary files are skipped **by content**: a `woff2` or a `png` decoded as UTF-8
 * is noise that could match anything, and "has a NUL byte in the first 8 KB" is a property
 * of the bytes rather than a list to keep current.
 */
function scanned(): { file: string; text: string }[] {
  const files = [...filesUnder('src'), ...filesUnder('sanity'), SEED];
  const readable: { file: string; text: string }[] = [];
  for (const file of files) {
    const bytes = readFileSync(join(ROOT, file));
    if (bytes.subarray(0, 8192).includes(0)) continue;
    readable.push({ file, text: bytes.toString('utf8') });
  }
  return readable;
}

function offencesIn(files: { file: string; text: string }[]): Offence[] {
  return files.flatMap(({ file, text }) => claimsIn(text, file));
}

describe('MUSE-71: the retired claim, as a rule with teeth', () => {
  it('catches every string the site actually published', () => {
    // The teeth. Without this the needles could be anything at all — including nothing,
    // which is how an empty guard passes for ever.
    for (const published of WAS_PUBLISHED) {
      expect(
        claimsIn(published, 'was-published'),
        `no needle in RETIRED_CLAIMS catches ${JSON.stringify(published)}, which the ` +
          'site published at 6a67da9',
      ).not.toEqual([]);
    }
  });

  it('catches the examples beside each needle, so one cannot be quietly disarmed', () => {
    for (const claim of RETIRED_CLAIMS) {
      expect(claim.examples.length, `${claim.what} needs examples`).toBeGreaterThan(0);
      expect(claim.why.length, `${claim.what} needs a reason`).toBeGreaterThan(30);
      for (const example of claim.examples) {
        expect(
          claim.pattern.test(example),
          `${claim.what}: ${JSON.stringify(claim.pattern.source)} does not match its own ` +
            `example ${JSON.stringify(example)}`,
        ).toBe(true);
      }
    }
  });

  it('leaves alone the prose under `src/` that says "free" about something else', () => {
    // The other direction, and the reason the English needles test adjacency rather than
    // the word. Seven lines under `src/` use "free" about a URL fragment, Actions minutes,
    // a wire format, a projection, JPEG quality and a layout — and a needle that read any
    // of them as a price promise would be deleted rather than narrowed.
    const src = scanned()
      .filter(({ file }) => file.startsWith('src/'))
      .map(({ text }) => text)
      .join('\n');

    for (const line of INNOCENT) {
      // Asserted *still there*, so this list is a record of real prose rather than a set of
      // hypotheticals that drifts into fiction — the shape `test/contentdrift.test.ts` uses
      // for its exemptions.
      expect(src.includes(line), `INNOCENT names prose no longer under src/: ${line}`).toBe(
        true,
      );
      expect(report(claimsIn(line, 'innocent'))).toEqual([]);
    }
  });
});

describe('MUSE-71: nothing claims a class at no cost', () => {
  const files = scanned();

  it('reads the whole of `src/`, `sanity/` and the seed', () => {
    // Anti-vacuous. A walker that threw, returned nothing, or quietly stopped reading a
    // tree would make every assertion below pass, which is the failure mode this
    // repository keeps re-filing (MUSE-42, MUSE-46, MUSE-60).
    expect(files.length, 'files scanned').toBeGreaterThan(40);
    for (const tree of ['src/components/', 'src/lib/', 'sanity/schemaTypes/']) {
      expect(
        files.some(({ file }) => file.startsWith(tree)),
        `nothing under ${tree} was scanned`,
      ).toBe(true);
    }
    expect(files.map(({ file }) => file)).toContain(SEED);
  });

  it('holds no retired offer claim anywhere it is scanned', () => {
    expect(report(offencesIn(files))).toEqual([]);
  });
});

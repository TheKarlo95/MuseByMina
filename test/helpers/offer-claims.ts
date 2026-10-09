/**
 * **MUSE-71 — the retired claim, as a rule two suites can apply.**
 *
 * „Besplatni probni sat" / "Free trial class" was the site's primary call to action from
 * the foundation commit until MUSE-71: the header button on all fourteen pages in both
 * locales, repeated in the homepage `#trial` band, `/contact`'s hero eyebrow,
 * `/schedule`'s CTA band and both `page` descriptions — so also in the two
 * `<meta name="description">` tags Google shows and in `llms.txt`. The studio offers no
 * such thing. Its own „DANCE STUDIO MUSE BY MINA – UPISI | SEZONA 2026/2027" form lists
 * 55 € regular, 40 € student and 20 € drop-in and no free or trial rate, and its timetable
 * matches the published schedule minute for minute, so the document is current rather than
 * stale. The claim came from the same commit as MUSE-36's thirteen invented classes.
 *
 * ## What this can and cannot be
 *
 * `test/contentdrift.test.ts` classifies every string field in the seed as CMS-owned or
 * legitimately-in-code, and that registry is why a *new* field cannot arrive unjudged. It
 * could never have caught this one: `page.description` was correctly classified as
 * CMS-owned and the string was correctly in the CMS. **A registry can ask where a value
 * lives; it cannot ask whether a human said it.** That is the hole, and no test closes it
 * — a test has no access to Mina.
 *
 * So this is deliberately not a general truthfulness check. It is the narrow, checkable
 * half: **one specific retired commercial promise stays retired**, in either language,
 * wherever it could come back from. Prices are not in it — 55 € and 100 € are confirmed,
 * are CMS-owned, and `/pricing` publishes them on purpose.
 *
 * ## Why it reads plain text, prose included
 *
 * The MUSE-42 ruling, as `test/contentdrift.test.ts` applies it: a stale copy in a comment
 * is believed rather than noticed, and a rule that exempts its own first counter-example is
 * not a rule. There is therefore **no exemption list** and nothing under `src/` may spell
 * the claim, not even to explain its removal. Four comments were written around that
 * constraint while this landed rather than being exempted; they name MUSE-71 and say „a
 * first class priced at nothing", which is the same sentence without the needle in it.
 *
 * The retired wording is quoted *here*, where it belongs: `test/` is not scanned, and a
 * guard that cannot state what it is looking for cannot be reviewed.
 *
 * `INNOCENT` is the other side of the same coin. Seven lines under `src/` use the word
 * "free" about something that is not a class, in six distinct phrasings, and each is
 * asserted to still be there — so the needles are shaped around real prose rather than
 * around prose somebody imagined, and a later widening that breaks one of them fails here
 * instead of in a reviewer's patience.
 */

export interface RetiredClaim {
  /** Short name, used in the failure. */
  what: string;
  /**
   * The needle. No `g` flag on purpose — these are tested line by line in two suites and
   * a shared `lastIndex` is a guard that passes every other call.
   */
  pattern: RegExp;
  /** Strings this pattern must match. The teeth, asserted in `test/offerclaims.test.ts`. */
  examples: string[];
  why: string;
}

/**
 * A gap of up to `n` whole words, for a claim that is a phrase rather than a token.
 *
 * Bounded, and bounded *tightly*: „free bachata trial class" needs two words of slack and
 * „was free to reinterpret" (`src/lib/lang.ts`, about a URL fragment) is four away from a
 * false positive. Anything looser reads English prose as a price promise, which is how a
 * guard gets deleted rather than fixed.
 */
const gap = (n: number) => String.raw`(?:[\s -]+[\p{L}']+){0,${n}}?`;

/** The words that make "free" a claim about a class rather than about anything else. */
const UNIT = String.raw`(?:class(?:es)?|lesson(?:s)?|session(?:s)?|trial|visit)`;

export const RETIRED_CLAIMS: RetiredClaim[] = [
  {
    what: 'a class priced at nothing, in Croatian („besplat…")',
    // The root covers besplatan / besplatna / besplatni / besplatno / besplatnog. There is
    // no innocent use of it in this repository and no innocent use available: Croatian has
    // no second sense of the word, so no adjacency test is needed or wanted here.
    pattern: /besplat/iu,
    examples: [
      'Besplatni probni sat',
      'Prvi sat je besplatan.',
      'Plesni studio u Zagrebu. Bachata za odrasle — bez partnera, bez iskustva. Dođi na besplatni probni sat.',
      'Prijavi se na besplatni probni sat bachate u Zagrebu.',
      'besplatna radionica',
    ],
    why:
      "the header CTA, the `#trial` band, `/contact`'s eyebrow and both `page` " +
      'descriptions all said it, and the studio does not offer it.',
  },
  {
    what: '"free" attached to a class, a lesson or a trial',
    pattern: new RegExp(String.raw`\bfree\b${gap(2)}[\s -]+${UNIT}\b`, 'iu'),
    examples: [
      'Free trial class',
      'A dance studio in Zagreb. Come to a free trial class.',
      'Sign up for a free bachata trial class in Zagreb.',
      'your free first lesson',
      'free taster session',
    ],
    why: 'the English half of the same promise, including the `llms.txt` line.',
  },
  {
    what: 'a class, lesson or visit said to be free',
    pattern: new RegExp(
      String.raw`\b${UNIT}\b${gap(2)}[\s -]+(?:is|are|'s|was|were)${gap(2)}[\s -]+free\b`,
      'iu',
    ),
    examples: [
      'The first class is free',
      'Your first class is free. Get in touch and we will find you a slot.',
      'the trial lesson is completely free',
      'first classes are free',
    ],
    why:
      'the other word order, which is what `/` and `/schedule` used. A needle for ' +
      '"free class" alone would have missed four of the six live strings.',
  },
  {
    what: 'a paraphrase of the same offer',
    // No `\b` around the Croatian alternatives: `\b` is defined on ASCII `\w` even under
    // `/u`, so a trailing boundary after „š" can never match and the needle would be dead.
    pattern:
      /\bgratis\b|\bfree of charge\b|\bno charge\b|\bon the house\b|bez naplate|ne plaćaš/iu,
    examples: [
      'prvi sat je gratis',
      'the first visit is free of charge',
      'no charge for the first class',
      'bez naplate',
    ],
    why:
      'the claim restated. These were never on the site, and that is the point — the ' +
      'thing to keep retired is the offer, not the four sentences that happened to carry ' +
      'it. Add a line here rather than widening a needle until it reads prose.',
  },
];

/**
 * **What the site actually published, verbatim.** Every one of these must be caught by at
 * least one needle above, which is the assertion that makes the list teeth rather than
 * decoration. Read off `src/lib/nav.ts`, `src/components/{Home,Contact,Schedule}.astro` and
 * `content/seed.ndjson` at `6a67da9`, the commit MUSE-71 was filed against.
 */
export const WAS_PUBLISHED: string[] = [
  // src/lib/nav.ts — the header CTA and the mobile panel, every page.
  'Besplatni probni sat',
  'Free trial class',
  // src/components/Home.astro — the `#trial` band's heading.
  'Prvi sat je besplatan. Javi nam se i dogovorit ćemo termin.',
  'Your first class is free. Get in touch and we will find you a slot.',
  // src/components/Contact.astro — the hero eyebrow.
  'Prvi sat je besplatan',
  'The first class is free',
  // src/components/Schedule.astro — the CTA band's heading.
  'Prvi sat je besplatan.',
  'Your first class is free.',
  // content/seed.ndjson — `page-home.description` and `page-contact.description`, which
  // are also the two `<meta name="description">` tags and two `llms.txt` lines.
  'Plesni studio u Zagrebu. Bachata za odrasle — bez partnera, bez iskustva. Dođi na besplatni probni sat.',
  'A dance studio in Zagreb. Bachata for adults — no partner, no experience needed. Come to a free trial class.',
  'Prijavi se na besplatni probni sat bachate u Zagrebu. Ispuni obrazac ili nam piši — javljamo se u roku od jednog radnog dana.',
  'Sign up for a free bachata trial class in Zagreb. Fill in the form or write to us — we answer within one working day.',
];

/**
 * **Prose under `src/` that says "free" about something that is not a class**, and may
 * not be caught. Each is asserted to still exist under `src/`, so this is a record of real
 * text rather than a list of hypotheticals that drifts into fiction.
 */
export const INNOCENT: string[] = [
  // src/lib/lang.ts — a URL fragment the redirect may reinterpret. The nearest miss in the
  // tree: `#trial` and "free" sit four words apart on one line, and the backtick closing the
  // fragment is what the needle's word-gap refuses to cross.
  '`/MuseByMina/#trial` that the homepage redirect was free to reinterpret.',
  // src/lib/rebuild.ts — GitHub Actions minutes.
  'Actions minutes are free on a public repository',
  // src/lib/forms.ts — the cost of changing a wire format.
  'this was the one moment it is free',
  // src/lib/sanity/decode.ts — a rule that comes for nothing once the `_ref` is projected.
  'deleted for free. Drop `"authorRef": author._ref`',
  // src/lib/sanity/images.ts — JPEG quality.
  'the saving stops being free on warm, low-lit photography',
  // src/components/AboutUs.astro and src/components/WhatIsBachata.astro — the same layout
  // note in two files, which is why seven lines are six strings.
  'what keeps 390px free of horizontal overflow whatever the Croatian strings do.',
];

/** One hit, located well enough to go and fix. */
export interface Offence {
  file: string;
  line: number;
  what: string;
  matched: string;
}

/** Every retired claim in `text`, as `file:line`. */
export function claimsIn(text: string, file: string): Offence[] {
  const found: Offence[] = [];
  text.split('\n').forEach((line, index) => {
    for (const claim of RETIRED_CLAIMS) {
      const hit = claim.pattern.exec(line);
      if (hit !== null) {
        found.push({ file, line: index + 1, what: claim.what, matched: hit[0] });
      }
    }
  });
  return found;
}

/** A failure a human can act on without opening this file. */
export function report(offences: Offence[]): string[] {
  return offences.map(
    ({ file, line, what, matched }) =>
      `${file}:${line} claims ${what} — ${JSON.stringify(matched)}. The studio does not ` +
      `offer a class at no cost (MUSE-71); nothing may say it does, prose included. If ` +
      `the studio has since said otherwise, that is a content change in the Studio and a ` +
      `line removed from RETIRED_CLAIMS in test/helpers/offer-claims.ts, with who said so.`,
  );
}

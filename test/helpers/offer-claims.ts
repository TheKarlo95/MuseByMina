/**
 * **The retired claims, as one rule two suites can apply.**
 *
 * Two unsupported promises have been taken off this site, both written by an agent, both
 * plausible, neither ever said by the studio. They are kept retired here together because
 * they fail the same way, are found by the same scan and would come back through the same
 * doors — and because a second mechanism for the second one would be two answers to one
 * question (MUSE-38's shape).
 *
 * ## MUSE-71 — a free first class
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
 * ## MUSE-80 — a reply within one working day
 *
 * „Javljamo se u roku od jednog radnog dana…" / "We reply within one working day…" was in
 * `src/lib/forms.ts` twice per locale — the sent-confirmation body and the `<noscript>`
 * ask — and in `page-contact.description`, so also in `/contact`'s
 * `<meta name="description">` and its two `llms.txt` lines. It traces to `92f3554`,
 * MUSE-7's implementation commit, whose description never mentions a response time; it is
 * in no ticket and not in the brief.
 *
 * It is worse than the first claim in two ways. A **service level** is a stronger thing
 * than marketing copy — somebody who writes on a Friday and hears nothing by Tuesday has
 * been told something untrue by the business, and it is the kind of statement that is
 * enforceable against the studio. And it was made beside a form that **has never
 * delivered a message**: `PUBLIC_FORM_ENDPOINT` is unset (MUSE-12), so the clock was
 * promised to start on a submission that was never transmitted. MUSE-72 corrected the
 * privacy notice for exactly this reason; this is the same false present tense in the
 * copy rather than in the notice.
 *
 * Nothing replaced it, and the needles below are the reason nothing can: "within a few
 * days" and "as soon as we can" are the same defect with a different value. If Mina sets
 * a response time it is hers to set, it belongs in the CMS where she can change it, and
 * the line comes out of `RETIRED_CLAIMS` with her name beside it.
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
 * `INNOCENT` is the other side of the same coin. Seven lines use the word "free" about
 * something that is not a class, in six distinct phrasings, and five more state a period
 * of time that is not a reply promise — and each is asserted to still be there, so the
 * needles are shaped around real prose rather than around prose somebody imagined, and a
 * later widening that breaks one of them fails here instead of in a reviewer's patience.
 *
 * **The five are what shaped the MUSE-80 needles, and one of them decided their scope.**
 * `/privacy` says „odgovaramo u roku od mjesec dana" / "we answer within one month" in
 * both locales — a reply verb and a stated period, which no amount of adjacency can tell
 * apart from the retired claim. It is the GDPR's own deadline for a data-subject request
 * (Art. 12(3)), so it is law rather than a promise, it is true, and it has to stay on the
 * page. The needles therefore match a period measured in **hours, days or weeks and not
 * in months**: a reply time in those units is a service level the studio has never set,
 * and a month is the statutory ceiling. That is a boundary rather than an exemption — the
 * two `/privacy` lines are pinned below and asserted *not* to match, so the boundary is
 * tested in both directions and cannot be moved quietly. The other four — „working day"
 * about the cron spacing, two "within six hours" about the rebuild cadence, and „the
 * same day" about a nav disclosure — are why a bare period is not a needle and a reply verb is
 * required beside it.
 */

export interface RetiredClaim {
  /** Short name, used in the failure. */
  what: string;
  /**
   * The ticket that retired it, named in the failure.
   *
   * There are two of them now, which is why this is a field rather than a sentence in
   * `report`. A failure that cited MUSE-71 for a response-time promise would send the
   * next author to read the wrong argument and find it did not apply.
   */
  ticket: string;
  /**
   * **What is not true**, as the sentence the failure states. One clause, present tense,
   * about the studio rather than about the needle — this is the half a reader has to
   * believe before they will go and delete their line.
   */
  untrue: string;
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

/**
 * **MUSE-80's vocabulary: a verb that means "we will get back to you".**
 *
 * The needles below are a reply verb *and* a stated period, on one line, within sixty
 * characters of each other. Neither half is a needle alone and both halves have innocent
 * uses in this repository: „na nju ti odgovaramo" / "an email address to reply to" is a
 * reply verb with no period, and „working day" and two "within six hours" are periods
 * with no reply — they are about the rebuild cron, and `INNOCENT` pins all of them.
 *
 * Croatian takes a `\p{L}*` tail rather than a list of endings: „javit ćemo se",
 * „odgovorit ćemo", „odgovorimo". A `\b` is no use after one — it is defined on ASCII
 * `\w` even under `/u`, so a boundary after „ć" can never match and the needle would be
 * dead (the same trap the paraphrase needle above is commented for).
 */
const REPLY_HR = String.raw`(?:javljamo|javit[\p{L}]*|javimo|odgovaramo|odgovorit[\p{L}]*|odgovorimo|odgovor)`;
const REPLY_EN = String.raw`(?:repl(?:y|ies|ying)|answer(?:s|ed|ing)?|respond(?:s|ing)?|response|get(?:s|ting)? back to you|hear from us|be in touch)`;

/**
 * **The period, in hours, days or weeks — and deliberately not in months.**
 *
 * The boundary is argued in the header: `/privacy` promises an answer „u roku od mjesec
 * dana" / "within one month" in both locales, which is the GDPR's statutory deadline for
 * a data-subject request and has to stay. A reply time of hours, days or weeks is a
 * service level the studio has never set; a month is the law's. So the Croatian needle
 * refuses „mjesec" at the one position it can appear (Croatian spells a month as „mjesec
 * dana", so the unit alone cannot carry the distinction) and the English list simply has
 * no month in it.
 *
 * A number is optional, because „u roku od jednog radnog dana" has a word there and
 * „within hours" has nothing.
 */
const PERIOD_HR = String.raw`(?:radn[\p{L}]*\s+)?(?:dan|dana|danu|sat|sata|sati|tjedan|tjedna|tjedne)(?![\p{L}])`;
const PERIOD_EN = String.raw`(?:working|business)?\s*(?:hour|day|week)s?\b`;
const COUNT_HR = String.raw`(?:[\p{L}\d]+\s+){0,2}`;
const COUNT_EN = String.raw`(?:[\p{L}\d]+[\s-]+){0,2}`;

export const RETIRED_CLAIMS: RetiredClaim[] = [
  {
    what: 'a class priced at nothing, in Croatian („besplat…")',
    ticket: 'MUSE-71',
    untrue: 'The studio does not offer a class at no cost',
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
    ticket: 'MUSE-71',
    untrue: 'The studio does not offer a class at no cost',
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
    ticket: 'MUSE-71',
    untrue: 'The studio does not offer a class at no cost',
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
    ticket: 'MUSE-71',
    untrue: 'The studio does not offer a class at no cost',
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
  {
    what: 'a reply promised inside a stated period, in Croatian',
    ticket: 'MUSE-80',
    untrue:
      'The studio has set no response time, and the form the clock would start on has ' +
      'never delivered a message',
    pattern: new RegExp(
      String.raw`${REPLY_HR}[^\n]{0,60}?\b(?:u roku od|unutar)\s+(?!mjesec)${COUNT_HR}${PERIOD_HR}`,
      'iu',
    ),
    examples: [
      'Javljamo se u roku od jednog radnog dana s terminom za probni sat.',
      'Napiši ime, razinu ako je već znaš i kad ti otprilike odgovara. Odgovaramo u roku od jednog radnog dana.',
      'Prijavi se na probni sat bachate u Zagrebu. Ispuni obrazac ili nam piši — javljamo se u roku od jednog radnog dana.',
      'Odgovaramo u roku od 24 sata.',
      'Javljamo se unutar dva radna dana.',
      'Odgovor šaljemo u roku od tjedan dana.',
    ],
    why:
      'the sent-confirmation body and the `<noscript>` ask in `src/lib/forms.ts`, and ' +
      '`page-contact.description` — so also the `<meta name="description">` of ' +
      '`/contact` and one of its `llms.txt` lines. „u roku od" is the live wording and ' +
      '„unutar" is the other idiom; „za" is not in the preposition list because „za" is ' +
      'the commonest preposition in Croatian („bachata za odrasle") and a needle that ' +
      'read it would match prose rather than a promise.',
  },
  {
    what: 'a reply promised inside a stated period, in English',
    ticket: 'MUSE-80',
    untrue:
      'The studio has set no response time, and the form the clock would start on has ' +
      'never delivered a message',
    pattern: new RegExp(
      String.raw`\b${REPLY_EN}\b[^\n]{0,60}?\b(?:with)?in\s+${COUNT_EN}${PERIOD_EN}`,
      'iu',
    ),
    examples: [
      'We reply within one working day with a slot for your trial class.',
      'Tell us your name, your level if you already know it, and roughly when suits you. We reply within one working day.',
      'Sign up for a bachata trial class in Zagreb. Fill in the form or write to us — we answer within one working day.',
      'We reply within 48 hours.',
      'We will get back to you within two business days.',
      'you will hear from us in a day or two',
    ],
    why:
      'the English half of the same promise, in the same four places. „within" and a ' +
      'bare "in" are both in, because "we answer in two days" is the same commitment ' +
      'with one word changed.',
  },
  {
    what: 'a reply promised for the same day, or for no time at all',
    ticket: 'MUSE-80',
    untrue:
      'The studio has set no response time, and the form the clock would start on has ' +
      'never delivered a message',
    // "Immediately" is a response time of zero, which is the strongest version of the
    // claim rather than an exception to it. The needle needs its own line because these
    // phrasings carry no period for the two needles above to find.
    //
    // **Both word orders.** The second alternative is not redundant: "same-day response"
    // puts the period in front of the verb, and the verb-first branch misses it. The
    // examples list is what found that — the needle was written with one branch and the
    // suite refused it.
    pattern:
      /\b(?:repl(?:y|ies)|answer|respond|response)\b[^\n]{0,40}?\b(?:the same day|by the end of the day|straight away|right away|immediately|within hours)\b|\bsame-day\s+(?:repl(?:y|ies)|answer|respond|response)\b|\b(?:istog dana|isti dan|do kraja dana|u najkra[\p{L}]+ roku|odmah ti se javljamo)\b/iu,
    examples: [
      'Odgovaramo istog dana.',
      'We reply the same day.',
      'We answer straight away.',
      'Javi nam se i odgovorit ćemo do kraja dana.',
      'Pišemo ti u najkraćem roku.',
      'same-day response',
    ],
    why:
      'the promise without a number, which is the first thing somebody reaches for when ' +
      'told not to write one — and it is still a commitment. „the same day" is pinned as ' +
      'innocent prose in `src/lib/nav.ts`, which is why this half of the needle also ' +
      'requires a reply verb; "comes back with its first entry" is not one.',
  },
];

/**
 * **What the site actually published, verbatim.** Every one of these must be caught by at
 * least one needle above, which is the assertion that makes the list teeth rather than
 * decoration.
 *
 * Grouped by the claim and by the commit it was read off, because there are two claims
 * now and a string proves nothing unless it is known to have been live. MUSE-71's are
 * read off `src/lib/nav.ts`, `src/components/{Home,Contact,Schedule}.astro` and
 * `content/seed.ndjson` at `6a67da9`; MUSE-80's off `src/lib/forms.ts` and
 * `content/seed.ndjson` at `ea55858`.
 *
 * `/contact`'s description appears **twice**, which is not a duplicate. The MUSE-71
 * group's last pair is how it read at `6a67da9`, carrying *both* claims in one sentence —
 * „besplatni probni sat" and „u roku od jednog radnog dana". The MUSE-80 group's last
 * pair is the same sentence after MUSE-71 took the first word out, which is the string
 * MUSE-80 was filed against. Both were live, so both are teeth.
 */
export const WAS_PUBLISHED: string[] = [
  /* MUSE-71 — a free first class. */
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

  /* MUSE-80 — a reply within one working day. */
  // src/lib/forms.ts — `sentBody`, the confirmation shown after a submission the site
  // could not transmit, because `PUBLIC_FORM_ENDPOINT` is unset (MUSE-12).
  'Javljamo se u roku od jednog radnog dana s terminom za probni sat. Ako ne vidiš naš odgovor, provjeri spam mapu.',
  'We reply within one working day with a slot for your trial class. If you do not see our answer, check your spam folder.',
  // src/lib/forms.ts — `noscriptAsk`, where the form is not rendered at all and the
  // reply was promised on an email the visitor sends by hand.
  'Napiši ime, razinu ako je već znaš i kad ti otprilike odgovara. Odgovaramo u roku od jednog radnog dana.',
  'Tell us your name, your level if you already know it, and roughly when suits you. We reply within one working day.',
  // content/seed.ndjson — `page-contact.description` as MUSE-71 left it: the free class
  // gone and the working day still there, which is the string this ticket exists for.
  'Prijavi se na probni sat bachate u Zagrebu. Ispuni obrazac ili nam piši — javljamo se u roku od jednog radnog dana.',
  'Sign up for a bachata trial class in Zagreb. Fill in the form or write to us — we answer within one working day.',
];

/**
 * **Prose in the scanned trees that must not be caught**, and the reason the needles test
 * adjacency rather than words. Each is asserted to still exist, so this is a record of
 * real text rather than a list of hypotheticals that drifts into fiction.
 *
 * It spans `src/` **and** `sanity/`. MUSE-71's entries were all under `src/` and the
 * check read only that tree; the nearest miss for MUSE-80's English needle is in
 * `sanity/badges.ts`, so a list that could not reach it would have left the needles
 * shaped around half the corpus they are run over.
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

  /* MUSE-80 — a period of time that is not a reply promise. */
  // src/components/Privacy.astro — the GDPR's own deadline for a data-subject request
  // (Art. 12(3)), in both locales. A reply verb and a stated period, and it has to stay:
  // this is the line the needles are bounded against, and the boundary is the unit. See
  // the header.
  'i odgovaramo u roku od mjesec dana.',
  'is enough, and we answer within one month.',
  // src/lib/rebuild.ts — the rebuild cadence promised to Mina, and the cron spacing that
  // sets it. A duration with nobody replying at the end of it.
  'duration ("within six hours"), never a clock time',
  'Bunch the runs into the working day and',
  // sanity/badges.ts — the same cadence, as the sentence the Studio badge improves on.
  'a static "changes appear within six hours" could not.',
  // src/lib/nav.ts — the "More" disclosure's own criteria, not a reply. „comes back" is
  // deliberately not a reply verb in the needle above, and this line is why.
  'comes back with its first entry and is held to its own criteria the same day.',
];

/** One hit, located well enough to go and fix. */
export interface Offence {
  file: string;
  line: number;
  what: string;
  matched: string;
  /** `untrue` and `ticket` of the claim that fired, so `report` does not have to guess. */
  untrue: string;
  ticket: string;
}

/** Every retired claim in `text`, as `file:line`. */
export function claimsIn(text: string, file: string): Offence[] {
  const found: Offence[] = [];
  text.split('\n').forEach((line, index) => {
    for (const claim of RETIRED_CLAIMS) {
      const hit = claim.pattern.exec(line);
      if (hit !== null) {
        found.push({
          file,
          line: index + 1,
          what: claim.what,
          matched: hit[0],
          untrue: claim.untrue,
          ticket: claim.ticket,
        });
      }
    }
  });
  return found;
}

/** A failure a human can act on without opening this file. */
export function report(offences: Offence[]): string[] {
  return offences.map(
    ({ file, line, what, matched, untrue, ticket }) =>
      `${file}:${line} claims ${what} — ${JSON.stringify(matched)}. ${untrue} ` +
      `(${ticket}); nothing may say otherwise, prose included. If the studio has since ` +
      `said otherwise, that is a content change in the Studio and a line removed from ` +
      `RETIRED_CLAIMS in test/helpers/offer-claims.ts, with who said so.`,
  );
}

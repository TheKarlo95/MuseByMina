import type { Locale } from './i18n';

/**
 * **Prices: how a number becomes the thing a visitor reads, and what the period is
 * called.**
 *
 * The companion to `formatTime` in `./schedule.ts`, and here for the same reason that
 * one is: `sanity/schemaTypes/documents/offering.ts` stores `priceEur` as a bare number
 * and says so in the field description — *„Samo broj, bez znaka €. Stranica sama piše
 * ‚25 €' na hrvatskom i ‚€25' na engleskom — to je pravilo oblikovanja, ne tekst koji se
 * upisuje."* CLAUDE.md states the rule in the other direction: currency formatting is
 * **code, never a CMS field**, and `test/sanity.test.ts` fails on a schema field whose
 * name contains `currency` precisely so that it stays that way. A field for it is a way
 * to publish `25€`, `25 EUR`, `25,00 €` and `€25` on four cards of one page.
 *
 * Nothing in here is content. The amounts are Mina's; the punctuation around them is the
 * design system's (§10, *Currency: HR `25 €` · EN `€25`*).
 */

/**
 * **The space between the Croatian number and its symbol: U+00A0 NO-BREAK SPACE.**
 *
 * Three candidates, and the choice is not cosmetic:
 *
 *   - **U+0020 SPACE** is a line-break opportunity. `25 €` at the end of a line in a
 *     390px column can break after the `25`, and a price whose symbol has moved to the
 *     next line reads as a bare number. That is the failure this constant exists to
 *     prevent, so the ordinary space is out on function alone.
 *   - **U+202F NARROW NO-BREAK SPACE** is what CLDR uses for French, not for Croatian,
 *     and it is the space a display face is most likely not to draw: the price is set in
 *     Cormorant Garamond, and a missing glyph there is a fallback-font substitution or a
 *     tofu box in the middle of the number.
 *   - **U+00A0 NO-BREAK SPACE** is what CLDR itself specifies for `hr`
 *     (`Intl.NumberFormat('hr-HR', {style: 'currency', currency: 'EUR'})` emits exactly
 *     `25 €`), it cannot break, and every font in the stack has it.
 *
 * So: the correct one is also the one that does the job. `test/pricing.test.ts` asserts
 * the codepoint rather than that there is whitespace, because every one of the three
 * above satisfies "there is a space" and only one satisfies the requirement.
 */
export const HR_CURRENCY_SPACE = '\u00A0';

/** How each language punctuates a number, and where the € goes. */
const CURRENCY: Record<Locale, { group: string; decimal: string; wrap(n: string): string }> = {
  hr: { group: '.', decimal: ',', wrap: (n) => `${n}${HR_CURRENCY_SPACE}€` },
  en: { group: ',', decimal: '.', wrap: (n) => `€${n}` },
};

/** Float noise, in cents. `0.07 * 100` is `7.000000000000001`; `1/3 * 100` is not close. */
const CENT_EPSILON = 1e-9;

/**
 * A price in euros as the page prints it: `25 €` in Croatian, `€25` in English.
 *
 * Hand-rolled rather than handed to `Intl.NumberFormat`, deliberately. `Intl` agrees
 * with every expectation in `test/pricing.test.ts` today — there is a test that says so —
 * but its output is a property of whichever ICU the running Node was built against, and
 * the bytes of a price on a static page should not be able to change because a runner
 * image was updated. The rule is four characters of punctuation; owning it is cheaper
 * than depending on it.
 *
 * **Whole euros carry no decimals and a fractional amount carries exactly two**, with
 * the language's own decimal mark. `priceEur` is a Sanity `number` with `min(0).max(10000)`
 * and no `.integer()` rule, so `24.5` is a value Mina can save — and `24,5 €` is a
 * malformed price while `24.5 €` is the wrong language.
 *
 * **Throws rather than coercing**, the same call `formatTime` makes for `25:00`. A
 * price is the one number on this site a visitor acts on: failing the build beats
 * publishing `NaN €` or `-20 €`, and it beats it by more than a schedule time does.
 */
export function formatPrice(amountEur: number, locale: Locale): string {
  if (!Number.isFinite(amountEur) || amountEur < 0) {
    throw new Error(
      `A price must be a finite, non-negative number of euros; got ${amountEur}.`,
    );
  }

  const cents = amountEur * 100;
  if (Math.abs(cents - Math.round(cents)) > CENT_EPSILON) {
    throw new Error(
      `A price must be a whole number of cents; ${amountEur} € cannot be written ` +
        `without rounding it, and a rounded price is a different price.`,
    );
  }

  const { group, decimal, wrap } = CURRENCY[locale];
  const total = Math.round(cents);
  const whole = Math.floor(total / 100);
  const fraction = total % 100;

  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, group);
  const number =
    fraction === 0 ? grouped : `${grouped}${decimal}${String(fraction).padStart(2, '0')}`;

  return wrap(number);
}

/**
 * What the price is *for*, in each language.
 *
 * The key set of this map **is** the closed set of periods. `PRICE_PERIODS` in
 * `sanity/schemaTypes/enums.ts` is the Studio's half of the same list, and
 * `test/pricing.test.ts` asserts the two agree — so a period Mina can pick is always a
 * period the page can name, in both languages, without a second copy of the list living
 * here. (The dependency points the wrong way round compared with `LEVELS` and
 * `WEEKDAYS`, which the schema imports *from* `src/lib/`. MUSE-59 shipped the page and
 * left it inverted: it would mean editing `sanity/` and regenerating three artefacts for
 * no behavioural difference, and the agreement is asserted either way round.)
 *
 * Wording, not content: this is the site saying "per class" in the page's language, the
 * same way `STUDIO.country` says „Hrvatska"/"Croatia". What a package costs and what it
 * includes are Mina's and come from the CMS.
 */
export const PERIOD_NAME: Record<Locale, Record<string, string>> = {
  hr: {
    class: 'po satu',
    course: 'po ciklusu',
    month: 'mjesečno',
    package: 'paket',
  },
  en: {
    class: 'per class',
    course: 'per course',
    month: 'per month',
    package: 'one-off package',
  },
};

/**
 * The period as a word, or a failure naming the value.
 *
 * `decodePricingTier` types `period` as a plain `string`, because the projection cannot
 * narrow it — so a period the page has no word for is reachable, and the honest answer
 * is the one `formatTime` gives a malformed time. A card reading „— " under its price
 * is worse than a build that stops and says which value it could not name.
 */
export function periodName(period: string, locale: Locale): string {
  const word = PERIOD_NAME[locale][period];
  if (word === undefined) {
    throw new Error(
      `A pricing tier has period "${period}", which the page has no word for in ` +
        `${locale}. Known periods: ${Object.keys(PERIOD_NAME[locale]).join(', ')}.`,
    );
  }
  return word;
}

/**
 * **The id of the enrolment block, and the only place it is spelled.**
 *
 * Every tier's button is an `<a href="#…">` at it, which is what makes the decision and
 * the action one page rather than two (the ticket's reading of axcentdance.com, against
 * Faith Connect's site where every pricing question becomes a DM). A constant because
 * the component writes it twice — once as the target's `id`, once in each href — and a
 * fragment that does not resolve is a link that silently does nothing.
 */
export const ENROL_ANCHOR = 'enrol';

/**
 * The value a chosen package is **submitted** as: the Croatian name, in both locales.
 *
 * A wire format, not a display name, on the same reasoning as `LEVEL_VALUE` in
 * `./forms.ts`: the studio inbox should read the same whichever site the enquiry came
 * from, and Mina should not have to map an English package name back onto her own.
 *
 * Not the document `_id`, which is the other obvious candidate and is worse where it
 * counts — `pricing-tier-a8f3e1` in an email tells the person reading it nothing, and
 * the thing this value has to survive is being read by a human, not being joined on.
 */
export function packageValue(tier: { name: Record<Locale, string> }): string {
  return tier.name.hr;
}

/**
 * **Every word the pricing page says that is not a price.**
 *
 * Four strings. Deliberately four: MUSE-22 landed with the dataset empty and no prices
 * agreed, so the component had to be built without inventing any content for it — no
 * package names, no "what's included" lines, no "most popular" claim, no lede. MUSE-59
 * then filled the dataset and routed the page **without adding a fifth**, which is the
 * half worth noticing: the page a visitor reads says „Cjenik", two package names, two
 * prices, two periods and one line each, and every one of those but the first came out
 * of `pricingTier`. All of it is Mina's. What is left here is chrome, and each of the
 * four is a word for something structural rather than a claim about anything:
 *
 *   - `title` is the page's own name.
 *   - `featuredTab` says what the tab *is* — the Studio's checkbox is „Istaknuti paket",
 *     so the tab reads „Istaknuto". Not „Najpopularnije"/"Most popular", which is a
 *     claim about other people's behaviour that nobody here can support.
 *   - `choose` is the button on a card.
 *   - `enrolHeading` is the heading over the form.
 *
 * In this module rather than inside the component for the reason `FORM_COPY` is in
 * `./forms.ts`: HR and EN sit side by side so a missing translation is visible, and
 * `test/pricing.test.ts` can subtract the whole table from the rendered page and fail on
 * anything left over — which is the assertion that a price invented in code would break.
 */
export interface PricingCopy {
  /** The page's `<h1>`. */
  title: string;
  /** The overlapping tab on the featured card (§7.2). */
  featuredTab: string;
  /** The button on each card. Its accessible name adds the package (WCAG 2.5.3). */
  choose: string;
  /** The heading over the enrolment form. */
  enrolHeading: string;
}

export const PRICING_COPY: Record<Locale, PricingCopy> = {
  hr: {
    title: 'Cjenik',
    featuredTab: 'Istaknuto',
    choose: 'Odaberi',
    enrolHeading: 'Prijavi se',
  },
  en: {
    title: 'Pricing',
    featuredTab: 'Featured',
    choose: 'Choose',
    enrolHeading: 'Sign up',
  },
};

/** The subset of a `PricingTier` this module needs: enough to rank and to warn. */
export interface FeaturableTier {
  id: string;
  featured: boolean;
}

export interface FeaturedChoice<T extends FeaturableTier> {
  /** Every tier, in the order given, with `featured` resolved to at most one `true`. */
  tiers: (T & { featured: boolean })[];
  /**
   * What is wrong with the dataset, in one line naming the documents — or `undefined`.
   *
   * A string rather than a thrown error, because the page still renders. See below.
   */
  warning?: string;
}

/**
 * **Reduce "featured" to at most one tier, deterministically, and never fail.**
 *
 * `featured` is a per-tier boolean, so "exactly one tier is featured" is a constraint
 * across documents that the schema cannot express: nothing stops Mina ticking two boxes
 * or none. The three available answers, and why this is the one:
 *
 *   - **Fail the build.** Rejected. It hands a content editor a checkbox that takes the
 *     whole site offline — and since MUSE-21 it would also stop the scheduled rebuild,
 *     so the site would stay stale until a developer noticed. The marker on a price card
 *     is not worth that, and "two boxes ticked" is not a broken document in the sense
 *     `decode.ts` fails on: every field is present, valid and renderable.
 *   - **Render both as featured.** Rejected, and it is the quiet one. The page still
 *     looks deliberate and the word "featured" now means nothing, which is precisely the
 *     failure nobody files a ticket about.
 *   - **Render deterministically and say so where someone will read it.** This. The
 *     first featured tier in the page's own order keeps the treatment; the rest render as
 *     ordinary cards. The order is the query's — `coalesce(order, 999) asc, priceEur asc`
 *     — so two builds of one commit agree, and the one that wins is the one Mina ranked
 *     first rather than whichever document the API happened to return first.
 *
 * **Zero featured tiers is a legitimate page, not a degraded one.** A price list where
 * nothing is singled out is a price list; highlighting is an editorial choice. So it
 * produces no warning and no tab.
 *
 * The warning names every `_id` involved, because the fix is one click in the Studio and
 * the only hard part is knowing which document to open. It is surfaced by the caller —
 * `Pricing.astro` logs it during the build. The place it *should* also appear is the
 * Studio itself, as an async `Rule.custom` on `pricingTier.featured` that counts the
 * others; that is a schema change, and MUSE-59 shipped the page without it on purpose —
 * see the note beside the `console.warn` in `Pricing.astro` for the trade.
 */
export function resolveFeatured<T extends FeaturableTier>(
  tiers: readonly T[],
): FeaturedChoice<T> {
  const featured = tiers.filter((tier) => tier.featured);
  const winner = featured[0];

  return {
    tiers: tiers.map((tier) => ({ ...tier, featured: tier.id === winner?.id })),
    warning:
      featured.length > 1
        ? `${featured.length} pricing tiers are marked as the featured one: ` +
          `${featured.map((tier) => tier.id).join(', ')}. Only one can be, so ` +
          `"${winner!.id}" keeps the border and the tab and the others render as ` +
          `ordinary cards. Open „Cjenik — paket" in the Studio and untick the spares.`
        : undefined,
  };
}

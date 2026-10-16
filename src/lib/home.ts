import type { Locale } from './i18n';
import { formatPrice, periodName } from './pricing';
import type { getInstructors, getPricingTiers, getStudioStory } from './sanity';

/**
 * **What the homepage's three CMS-backed sections need, resolved to one locale**
 * (MUSE-133).
 *
 * This exists because of a constraint written at length in `src/components/Home.astro`:
 * that component's import list cannot grow — adding any import to it moves its inlined
 * `<style>` past `TrialForm`'s `<link>` in `<head>`, which `test/cascade.test.ts` watches.
 * So the locale pick and the price formatting happen before the component is reached, and
 * it is handed strings.
 *
 * The alternative was the same ten lines in `src/pages/index.astro` and again in
 * `src/pages/en/index.astro`, which is the shape a drift starts in: the two homepages
 * would be free to format a price differently and nothing would say so.
 *
 * **Formatting is code and stays code** — `formatPrice` and `periodName` live in
 * `src/lib/pricing.ts` and are the same functions `/pricing` renders with, so a rate reads
 * the same on both pages. Nothing here writes a price, a name or a sentence: every value
 * below comes out of a document.
 */
export interface HomeContent {
  /** `studioStory`, in this locale: the heading and the paragraphs, in order. */
  story: { heading: string; paragraphs: string[] };
  /** Every `pricingTier`, formatted — the same three the rate card publishes (MUSE-73). */
  rates: { name: string; price: string; period: string }[];
  /** Every `instructor`: name and role, which is all either document holds (MUSE-36). */
  people: { name: string; role: string }[];
}

/** The documents this reads, named by the readers that fetch them. */
export interface HomeSources {
  story: Awaited<ReturnType<typeof getStudioStory>>;
  tiers: Awaited<ReturnType<typeof getPricingTiers>>;
  instructors: Awaited<ReturnType<typeof getInstructors>>;
}

export function homeContent(locale: Locale, sources: HomeSources): HomeContent {
  const { story, tiers, instructors } = sources;
  return {
    story: {
      heading: story.heading[locale],
      paragraphs: story.story.map((paragraph) => paragraph[locale]),
    },
    rates: tiers.map((tier) => ({
      name: tier.name[locale],
      price: formatPrice(tier.priceEur, locale),
      period: periodName(tier.period, locale),
    })),
    people: instructors.map((person) => ({
      name: person.name,
      role: person.role[locale],
    })),
  };
}

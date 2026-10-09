import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Pricing from '../src/components/Pricing.astro';
import TrialForm from '../src/components/TrialForm.astro';
import { FORM_COPY, FORM_FIELDS } from '../src/lib/forms';
import { LOCALES, type Locale } from '../src/lib/i18n';
import {
  ENROL_ANCHOR,
  HR_CURRENCY_SPACE,
  PERIOD_NAME,
  PRICING_COPY,
  formatPrice,
  packageValue,
  periodName,
  resolveFeatured,
} from '../src/lib/pricing';
import { PRIMARY_NAV } from '../src/lib/nav';
import { ROUTES } from '../src/lib/pages';
import { FIXTURE_ENV } from '../src/lib/sanity/fixture';
import { PRICE_PERIODS, PRICE_PERIOD_OPTIONS } from '../sanity/schemaTypes/enums';
import { PAGES_DEPLOY, buildFailure, buildSite, type Build } from './helpers/build';
import { seedDocs, seedDocsOfType, type SeedDoc } from './helpers/seed';
import {
  PRICING_NONE_FEATURED,
  PRICING_ONE_FEATURED,
  PRICING_TIER_A,
  PRICING_TIER_B,
  PRICING_TIER_C,
  PRICING_TWO_FEATURED,
  SITE_SETTINGS_DOC,
  fixtureOf,
  type FixtureDoc,
} from './helpers/structural-content';

/**
 * MUSE-22 — the price a visitor reads.
 *
 * A price is the one number on this site somebody may act on: they budget around it,
 * and advertising the wrong one is a commercial claim, not a typo. So the formatting is
 * pinned codepoint by codepoint rather than "contains a space".
 */

describe('AC3: a price is formatted per locale', () => {
  it('writes the Croatian price as number, space, symbol', () => {
    expect(formatPrice(25, 'hr')).toBe(`25${HR_CURRENCY_SPACE}€`);
  });

  it('writes the English price as symbol then number, with nothing between', () => {
    expect(formatPrice(25, 'en')).toBe('€25');
  });

  /**
   * **The space is U+00A0, and the test says so in codepoints.**
   *
   * `25 €` with a plain U+0020 is a line-break opportunity: at 390px, in Croatian, a
   * card whose name has just wrapped can put `25` at the end of one line and `€` at the
   * start of the next — a price that reads as a bare number. "There is a space" is not
   * an assertion when the entire reason the space is there is that the number must not
   * leave its symbol behind.
   */
  it('separates the Croatian number from the symbol with a NO-BREAK SPACE', () => {
    const points = [...formatPrice(25, 'hr')].map((c) => c.codePointAt(0));
    // 2, 5, NO-BREAK SPACE, EURO SIGN — spelled out, so the separator is pinned by
    // codepoint and by position rather than by "this string has whitespace in it".
    expect(points).toEqual([0x0032, 0x0035, 0x00a0, 0x20ac]);
    expect(HR_CURRENCY_SPACE).toHaveLength(1);
    expect(HR_CURRENCY_SPACE.codePointAt(0)).toBe(0x00a0);
  });

  it('puts no space of any kind in the English price', () => {
    expect(formatPrice(25, 'en')).not.toMatch(/\s| | /u);
  });

  it('never lets a plain space into either rendering', () => {
    for (const locale of LOCALES) {
      for (const amount of [0, 7, 25, 1200, 10_000]) {
        expect(formatPrice(amount, locale), `${locale} ${amount}`).not.toContain(' ');
      }
    }
  });
});

describe('a price that is not two digits', () => {
  it('groups thousands the way each language writes them', () => {
    expect(formatPrice(1200, 'hr')).toBe(`1.200${HR_CURRENCY_SPACE}€`);
    expect(formatPrice(1200, 'en')).toBe('€1,200');
    expect(formatPrice(10_000, 'hr')).toBe(`10.000${HR_CURRENCY_SPACE}€`);
    expect(formatPrice(10_000, 'en')).toBe('€10,000');
  });

  it('shows no decimals on a whole number of euros', () => {
    expect(formatPrice(25, 'hr')).not.toContain(',');
    expect(formatPrice(25, 'en')).not.toContain('.');
  });

  it('writes a half euro with the language’s own decimal mark, and two places', () => {
    // `priceEur` is a Sanity `number` with no `.integer()` rule, so 24.5 is a value Mina
    // can save. `24,5 €` is a malformed price; `24.5 €` is the wrong language.
    expect(formatPrice(24.5, 'hr')).toBe(`24,50${HR_CURRENCY_SPACE}€`);
    expect(formatPrice(24.5, 'en')).toBe('€24.50');
  });

  it('renders a free tier as zero rather than as nothing', () => {
    expect(formatPrice(0, 'hr')).toBe(`0${HR_CURRENCY_SPACE}€`);
    expect(formatPrice(0, 'en')).toBe('€0');
  });

  it('refuses a price it cannot render honestly', () => {
    // Failing beats publishing `NaN €` or a negative price on the page that decides
    // whether somebody turns up — the same call `formatTime` makes for `25:00`.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1 / 3]) {
      expect(() => formatPrice(bad, 'hr'), String(bad)).toThrow(/price/i);
    }
  });
});

describe('the formatting agrees with CLDR, which is where the rule comes from', () => {
  /**
   * A canary, not the specification. The assertions above are the specification —
   * hand-rolled so that the bytes of a price cannot change because a Node upgrade
   * shipped a new ICU. This one says that what we hand-rolled is still what Croatian
   * and English actually do, and if ICU ever disagrees the right response is to read
   * the diff and decide, not to change the expectation.
   */
  const icu = (amount: number, locale: Locale): string =>
    new Intl.NumberFormat(locale === 'hr' ? 'hr-HR' : 'en', {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: Number.isInteger(amount) ? 0 : 2,
    }).format(amount);

  for (const amount of [0, 7, 25, 1200, 10_000, 24.5]) {
    for (const locale of LOCALES) {
      it(`matches Intl for ${amount} in ${locale}`, () => {
        expect(formatPrice(amount, locale)).toBe(icu(amount, locale));
      });
    }
  }
});

describe('the period a price is for', () => {
  it('names every period the Studio can offer, in both languages', () => {
    /**
     * `PRICE_PERIODS` is the Studio's half of this closed set and `PERIOD_NAME`'s key
     * set is the page's. Pinned against each other rather than copied, so a period Mina
     * can tick is always one the page has a word for — the hole `test/sanity.test.ts`
     * closes for levels, styles, weekdays and social platforms, and the one `period`
     * never had: its option list in `sanity/schemaTypes/enums.ts` is hand-written, and
     * `PRICE_PERIODS` had no consumer anywhere before this.
     */
    for (const locale of LOCALES) {
      expect(Object.keys(PERIOD_NAME[locale]).sort()).toEqual([...PRICE_PERIODS].sort());
    }
  });

  it('offers the Studio exactly those periods and no others', () => {
    expect(PRICE_PERIOD_OPTIONS.map((option) => option.value)).toEqual([...PRICE_PERIODS]);
  });

  it('actually translates them rather than reusing the Croatian', () => {
    for (const period of PRICE_PERIODS) {
      expect(periodName(period, 'en'), period).not.toBe(periodName(period, 'hr'));
    }
  });

  /**
   * **MUSE-73, MUSE-80: a period is named, never characterised.**
   *
   * `package` read "one-off package" in English against „paket" in Croatian. „Paket" says
   * *what the price covers*; "one-off" says *how it is paid* — a payment-terms claim the
   * Croatian does not make, that no `pricingTier` field contains and that nobody at the
   * studio has stated. It is MUSE-80's defect one layer down, inside the formatting table
   * rather than inside copy, and it was reachable because this map is the one place on the
   * page where a word is chosen in code rather than read from the CMS.
   *
   * Stated over every period and not only the one that was wrong: the rule is that the two
   * languages name the same thing, so the needles are the kinds of thing a *translation*
   * cannot add. A drop-in is now `class` — „po satu" / "per class" — which is the honest
   * shape and needed no new period to exist.
   */
  it('names each period without characterising how it is paid', () => {
    const claims = /one-?off|single payment|up-?front|no commitment|lifetime|unlimited/i;
    for (const locale of LOCALES) {
      for (const period of PRICE_PERIODS) {
        expect(periodName(period, locale), `${locale}.${period}`).not.toMatch(claims);
      }
    }
    expect(PERIOD_NAME.en['package']).toBe('package');
    expect(PERIOD_NAME.hr['class']).toBe('po satu');
    expect(PERIOD_NAME.en['class']).toBe('per class');
  });

  it('leaves none of them blank', () => {
    for (const locale of LOCALES) {
      for (const period of PRICE_PERIODS) {
        expect(periodName(period, locale).trim(), `${locale}.${period}`).not.toBe('');
      }
    }
  });

  it('refuses a period it has no word for, naming the value', () => {
    // `decodePricingTier` types `period` as a plain string, so this is reachable.
    expect(() => periodName('fortnightly', 'hr')).toThrow(/fortnightly/);
  });
});

describe('AC2: exactly one tier is featured — which the schema cannot enforce', () => {
  const tier = (id: string, featured: boolean): { id: string; featured: boolean } => ({
    id,
    featured,
  });

  it('keeps the one featured tier featured', () => {
    const { tiers, warning } = resolveFeatured([
      tier('a', false),
      tier('b', true),
      tier('c', false),
    ]);
    expect(tiers.map((t) => t.featured)).toEqual([false, true, false]);
    expect(warning).toBeUndefined();
  });

  it('features nothing when nothing is ticked, and does not complain', () => {
    // A price list with nothing singled out is still a price list. Highlighting is an
    // editorial choice, so its absence is a state and not a fault.
    const { tiers, warning } = resolveFeatured([tier('a', false), tier('b', false)]);
    expect(tiers.map((t) => t.featured)).toEqual([false, false]);
    expect(warning).toBeUndefined();
  });

  it('features the first of several, in the page’s own order', () => {
    const { tiers } = resolveFeatured([
      tier('a', false),
      tier('b', true),
      tier('c', true),
      tier('d', true),
    ]);
    expect(tiers.map((t) => t.featured)).toEqual([false, true, false, false]);
  });

  it('says which documents are wrong, and which one won', () => {
    const { warning } = resolveFeatured([tier('b', true), tier('c', true)]);
    expect(warning).toBeDefined();
    expect(warning).toContain('b');
    expect(warning).toContain('c');
    expect(warning).toMatch(/2 pricing tiers/);
  });

  it('never fails, however many boxes are ticked', () => {
    // Deliberate: failing the build would hand a content editor a checkbox that takes
    // the site offline, and since MUSE-21 would also stop the scheduled rebuild.
    for (const count of [0, 1, 2, 7]) {
      const all = Array.from({ length: 7 }, (_, i) => tier(`t${i}`, i < count));
      expect(() => resolveFeatured(all), String(count)).not.toThrow();
      expect(
        resolveFeatured(all).tiers.filter((t) => t.featured).length,
        String(count),
      ).toBeLessThanOrEqual(1);
    }
  });

  it('leaves the order and the identity of every tier alone', () => {
    const given = [tier('a', true), tier('b', false), tier('c', true)];
    expect(resolveFeatured(given).tiers.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });
});

/* ======================================================= the rendered component */

/**
 * **The component, rendered on its own — for the datasets one seed cannot hold at once.**
 *
 * MUSE-22 wrote this half because there was no route: no real prices, no `pricingTier`
 * document, and `getPricingTiers()` fails the build naming the type when there are none,
 * which on `main` would have stopped every deploy and the scheduled rebuild MUSE-21
 * added. MUSE-59 routed the page, and the `dist` assertions at the end of this file are
 * the half that was missing.
 *
 * **This half stays, and not out of sentiment.** Four of its subjects cannot exist in
 * `content/seed.ndjson`, because that file is imported into Mina's dataset: two tiers
 * ticked as featured, no tier ticked, a third tier, and a `drafts.`-prefixed document
 * that must not reach the page. Those are properties of *the component under a dataset*,
 * and the only way to have one is to render it against a fixture.
 *
 * The two ways to do that, and why this is the one:
 *
 *   - **A throwaway route inside the test's own build.** Rejected. A suite cannot start
 *     its own build (`test/isolation.test.ts`, rule 4) and `astroBuild` runs in the
 *     repository root, so the route would have to be a real file under `src/pages/` for
 *     the duration — a mutation of the tree that ten parallel builds share. The only
 *     version that does not race is an env-gated `injectRoute` in `astro.config.mjs`,
 *     i.e. a test backdoor in the production config of a site whose last two incidents
 *     were both "placeholder content reached production".
 *   - **Astro's container API.** This. It compiles and runs the real component — real
 *     frontmatter, real `getPricingTiers()` against a real GROQ evaluation of
 *     `PRICING_QUERY`, real markup — and hands back the HTML. `vitest.config.ts` uses
 *     `getViteConfig` so that the `.astro` compiler is in the pipeline.
 *
 * **What it cannot see, stated plainly rather than quietly skipped.** The container runs
 * no asset pipeline, so the component's scoped `<style>` is not in the output: nothing
 * below measures a colour, a border, a computed style or a layout. Those are checked
 * three other ways — `npm run ds` on the source, the two assertions on the style block
 * further down this file, and, now that `/pricing` is a route (MUSE-59), the browser:
 * `npm run a11y` audits it in both locales and both themes, and `test/numerals.test.ts`
 * screenshots its prices against the same element with old-style figures forced, which
 * is the one rule here no source scan can settle.
 *
 * Every assertion is on the HTML a visitor's browser would receive, not on a value the
 * component returned.
 */

/** Rendered once per (dataset, locale): the container is slow enough to matter. */
const container = await AstroContainer.create();

/**
 * Point the read path at `docs` and render `Pricing` for `locale`.
 *
 * `MUSE_CONTENT_FIXTURE` is read per query (`src/lib/sanity/fixture.ts`), so swapping it
 * between renders swaps the dataset — which is what makes "two tiers are ticked" a
 * property of content rather than of a mock. Every dataset carries `siteSettings`,
 * because `getSiteSettings()` memoises for the life of the process and the form inside
 * the component reads the studio inbox from it.
 */
async function render(docs: readonly FixtureDoc[], locale: Locale): Promise<string> {
  process.env[FIXTURE_ENV] = fixtureOf(docs, 'pricing');
  return container.renderToString(Pricing, { props: { locale } });
}

const SEED_FIXTURE = process.env[FIXTURE_ENV];
afterAll(() => {
  process.env[FIXTURE_ENV] = SEED_FIXTURE;
});

/**
 * Enough entity decoding for what Astro escapes on output.
 *
 * **`&nbsp;` is deliberately not in here.** Decoding it would make `42&nbsp;€` and
 * `42 €` the same string, and telling those two apart is a thing this file asserts:
 * the rule is that the no-break space reaches the page as the character. An undecoded
 * entity survives as the literal text `&nbsp;` and fails the price equality by name.
 */
const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

function decode(text: string): string {
  return text.replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole);
}

/**
 * The words a visitor reads, with the markup taken out.
 *
 * **Collapses the ASCII whitespace and nothing else.** The obvious `\s+` → `' '` turns
 * the U+00A0 in `25 €` into a plain space, which is the one character in this file that
 * has to survive intact — the assertion that the Croatian price cannot wrap would then
 * pass against a price that can. `String#trim` has the same problem, so the ends are
 * trimmed by hand.
 */
function textOf(html: string): string {
  return decode(html.replace(/<[^>]*>/g, ' '))
    .normalize('NFC')
    .replace(/[\t\n\r\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/^ +| +$/g, '');
}

/** The attributes on one opening tag, as a map. Bare attributes map to `''`. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.slice(1, -1).matchAll(/([A-Za-z_:][-\w:.]*)(?:="([^"]*)")?/g)) {
    if (m[1] && m[1] !== tag.slice(1).split(/[\s>]/)[0]) out[m[1]] = decode(m[2] ?? '');
  }
  return out;
}

interface Card {
  attrs: Record<string, string>;
  html: string;
  text: string;
}

/**
 * One entry per tier card.
 *
 * `<article>` because it is the one element in the component that cannot nest — the
 * feature list is `<li>`s and the grid is a `<ul>`, so a non-greedy match is exact
 * rather than approximately exact.
 */
function cards(html: string): Card[] {
  return [...html.matchAll(/(<article\b[^>]*>)([\s\S]*?)<\/article>/g)].map((m) => ({
    attrs: attrsOf(m[1]!),
    html: m[2]!,
    text: textOf(m[2]!),
  }));
}

/** The text of the one element carrying `attribute`, inside `html`. */
function valueOf(html: string, attribute: string): string | undefined {
  const m = new RegExp(`<([a-z]+)\\b[^>]*\\b${attribute}\\b[^>]*>([\\s\\S]*?)</\\1>`).exec(
    html,
  );
  return m === null ? undefined : textOf(m[2]!);
}

/**
 * `value` → label for every `<option>` in `html`, in document order.
 *
 * The opening tag is matched first and the value picked out of it, rather than matched
 * in one pattern: Astro emits `value=""` as the bare attribute `value`, and the blank
 * "no package chosen" option is the first one in the list.
 */
function options(html: string): [string, string][] {
  return [...html.matchAll(/(<option\b[^>]*>)([\s\S]*?)<\/option>/g)].map((m) => [
    decode(/\bvalue="([^"]*)"/.exec(m[1]!)?.[1] ?? ''),
    textOf(m[2]!),
  ]);
}

/** What the fixture says a tier's name, features and rendered price are. */
function expected(doc: FixtureDoc, locale: Locale) {
  const name = (doc.name as Record<Locale, string>)[locale];
  const features = (doc.features as Record<Locale, string>[]).map((f) => f[locale]);
  return {
    id: doc._id,
    name,
    features,
    price: formatPrice(doc.priceEur as number, locale),
    period: periodName(doc.period as string, locale),
  };
}

const TIERS = [PRICING_TIER_A, PRICING_TIER_B, PRICING_TIER_C];

/** One render per locale of the dataset the acceptance criteria describe. */
const normal: Record<Locale, string> = { hr: '', en: '' };
beforeAll(async () => {
  for (const locale of LOCALES) normal[locale] = await render(PRICING_ONE_FEATURED, locale);
});

describe('AC1: what a class costs, what packages exist, and what each includes', () => {
  for (const locale of LOCALES) {
    it(`${locale}: every tier in the CMS is on the page, once`, () => {
      const rendered = cards(normal[locale]);
      expect(rendered.map((card) => card.attrs['data-tier'])).toEqual(
        TIERS.map((doc) => doc._id),
      );
    });

    it(`${locale}: each card names its package, its price, its period and what it includes`, () => {
      const rendered = cards(normal[locale]);
      for (const [index, doc] of TIERS.entries()) {
        const want = expected(doc, locale);
        const card = rendered[index]!;
        expect(card.text, want.id).toContain(want.name);
        expect(card.text, want.id).toContain(want.price);
        expect(card.text, want.id).toContain(want.period);
        for (const feature of want.features) expect(card.text, want.id).toContain(feature);
      }
    });

    it(`${locale}: the package name is a heading, so the cards are navigable`, () => {
      // `h2` since MUSE-75: the page's only other heading below the `h1` is the form's,
      // so an `h3` here was a skipped level in both locales. The whole outline is pinned
      // against `dist` further down — this one keeps the level pinned per rendered card,
      // including the dataset shapes a seed cannot hold at once.
      for (const [index, doc] of TIERS.entries()) {
        const card = cards(normal[locale])[index]!;
        expect(card.html).toMatch(
          new RegExp(`<h2\\b[^>]*>\\s*${expected(doc, locale).name}\\s*</h2>`),
        );
      }
    });

    it(`${locale}: a tier nobody published is not on the page`, () => {
      // `DRAFT_TIER` carries `order: -1`, so a leak would be the first card and the
      // cheapest one to spot — which is why it is in the dataset at all.
      expect(normal[locale]).not.toContain('tier draft');
      expect(cards(normal[locale])).toHaveLength(TIERS.length);
    });
  }

  it('renders the Croatian names on the Croatian page and the English ones on the English', () => {
    // On the *text*, not the markup: the English page legitimately carries the Croatian
    // name inside `value="…"`, because what the studio inbox receives is language
    // independent (`packageValue`). Nobody reads an attribute.
    expect(textOf(normal.hr)).toContain('Tier A HR');
    expect(textOf(normal.hr)).not.toContain('Tier A EN');
    expect(textOf(normal.en)).toContain('Tier A EN');
    expect(textOf(normal.en)).not.toContain('Tier A HR');
  });
});

describe('AC3: the price on the page is the price in the CMS', () => {
  /**
   * The ticket's own suggestion, and the sharpest assertion in this file: not "the page
   * mentions 42 somewhere" but "the price element's text is exactly what `priceEur`
   * formats to". A card that rendered the wrong tier's price, or the English form on the
   * Croatian page, or a stale number, fails on an equality rather than on a `toContain`
   * that a second number elsewhere on the page could satisfy.
   *
   * The expectation is derived from the fixture document, never retyped.
   */
  for (const locale of LOCALES) {
    for (const [index, doc] of TIERS.entries()) {
      it(`${locale}: ${doc._id} renders ${formatPrice(doc.priceEur as number, locale)}`, () => {
        const card = cards(normal[locale])[index]!;
        expect(valueOf(card.html, 'data-price')).toBe(expected(doc, locale).price);
      });
    }

    it(`${locale}: no price is printed as a bare number`, () => {
      // A number with no currency mark beside it is the failure a visitor cannot see:
      // `42` reads as a price in whatever currency they assume.
      for (const card of cards(normal[locale])) {
        expect(valueOf(card.html, 'data-price')).toContain('€');
      }
    });
  }

  it('writes the Croatian prices with a no-break space and the English ones without', () => {
    for (const card of cards(normal.hr)) {
      expect(valueOf(card.html, 'data-price')).toMatch(/^[\d.,]+ €$/);
    }
    for (const card of cards(normal.en)) {
      expect(valueOf(card.html, 'data-price')).toMatch(/^€[\d.,]+$/);
    }
  });

  it('puts the no-break space into the HTML as the character, not as an entity', () => {
    // `&nbsp;` renders identically, and a test that accepted either could not tell a
    // U+00A0 in the output from a U+0020. The byte is the assertion.
    expect(normal.hr).toContain(`42${HR_CURRENCY_SPACE}€`);
    expect(normal.hr).not.toContain('42&nbsp;');
    expect(normal.hr).not.toContain('42 €');
  });
});

describe('AC2: exactly one tier is featured, on the page', () => {
  const featuredIds = (html: string): string[] =>
    cards(html)
      .filter((card) => 'data-featured' in card.attrs)
      .map((card) => card.attrs['data-tier']!);

  for (const locale of LOCALES) {
    it(`${locale}: the ticked tier gets the treatment and a tab that says so`, async () => {
      const html = await render(PRICING_ONE_FEATURED, locale);
      expect(featuredIds(html)).toEqual([PRICING_TIER_A._id]);
      const card = cards(html).find((c) => c.attrs['data-tier'] === PRICING_TIER_A._id)!;
      expect(valueOf(card.html, 'data-tab')).toBe(PRICING_COPY[locale].featuredTab);
    });

    it(`${locale}: two ticked tiers still produce one featured card, the first`, async () => {
      const html = await render(PRICING_TWO_FEATURED, locale);
      expect(featuredIds(html)).toEqual([PRICING_TIER_A._id]);
      // And the loser is a complete, ordinary card rather than a hole.
      const b = cards(html).find((c) => c.attrs['data-tier'] === PRICING_TIER_B._id)!;
      expect(b.text).toContain(expected(PRICING_TIER_B, locale).price);
      expect(valueOf(b.html, 'data-tab')).toBeUndefined();
    });

    it(`${locale}: no ticked tier is a complete page with no tab on it`, async () => {
      const html = await render(PRICING_NONE_FEATURED, locale);
      expect(featuredIds(html)).toEqual([]);
      expect(html).not.toContain(PRICING_COPY[locale].featuredTab);
      expect(cards(html)).toHaveLength(TIERS.length);
      for (const [index, doc] of TIERS.entries()) {
        expect(cards(html)[index]!.text).toContain(expected(doc, locale).price);
      }
    });
  }

  it('renders the same page whichever of the two anomalies the dataset has', async () => {
    // The tab is the only difference `featured` may make. If two ticks changed anything
    // else — an order, a missing card, a second tab — this is where it shows.
    const two = await render(PRICING_TWO_FEATURED, 'hr');
    const one = await render(PRICING_ONE_FEATURED, 'hr');
    expect(cards(two).map((c) => c.attrs['data-tier'])).toEqual(
      cards(one).map((c) => c.attrs['data-tier']),
    );
    expect(two.match(/data-tab/g) ?? []).toHaveLength(1);
  });
});

describe('AC4: a chosen package can be acted on, on the same page', () => {
  for (const locale of LOCALES) {
    it(`${locale}: the enrolment form is on this page, not behind a link`, async () => {
      const html = await render(PRICING_ONE_FEATURED, locale);
      // The same component `/` and `/contact` render — not a second form (MUSE-7).
      expect(html).toContain('data-trial-form');
      expect(html).toContain(`id="${ENROL_ANCHOR}"`);
      expect(html).toContain(FORM_COPY[locale].submit);
    });

    it(`${locale}: every tier offers a way into it, naming the package`, async () => {
      const html = await render(PRICING_ONE_FEATURED, locale);
      for (const [index, doc] of TIERS.entries()) {
        const card = cards(html)[index]!;
        const link = /<a\b[^>]*\bdata-choose\b[^>]*>/.exec(card.html);
        expect(link, doc._id).not.toBeNull();
        const attrs = attrsOf(link![0]);
        expect(attrs['href'], doc._id).toBe(`#${ENROL_ANCHOR}`);
        expect(attrs['data-choose'], doc._id).toBe(packageValue(doc as never));
        // WCAG 2.5.3: the accessible name contains the visible one.
        expect(attrs['aria-label'], doc._id).toContain(PRICING_COPY[locale].choose);
        expect(attrs['aria-label'], doc._id).toContain(expected(doc, locale).name);
      }
    });

    it(`${locale}: the form asks which package, offering exactly the ones on the page`, async () => {
      const html = await render(PRICING_ONE_FEATURED, locale);
      const select = /<select\b[^>]*\bname="package"[^>]*>([\s\S]*?)<\/select>/.exec(html);
      expect(select).not.toBeNull();
      expect(options(select![1]!)).toEqual([
        ['', FORM_COPY[locale].package.any],
        ...TIERS.map((doc) => [packageValue(doc as never), expected(doc, locale).name]),
      ]);
    });

    it(`${locale}: the package a tier hands over is the same in both languages`, async () => {
      // A wire value, like `LEVEL_VALUE`: the studio inbox reads the same whichever
      // site the enquiry came from.
      const html = await render(PRICING_ONE_FEATURED, locale);
      const chosen = [...html.matchAll(/data-choose="([^"]*)"/g)].map((m) => m[1]);
      expect(chosen).toEqual(TIERS.map((doc) => packageValue(doc as never)));
    });
  }

  it('leaves the form exactly as it was on every page that has no packages', async () => {
    /**
     * `/` and `/contact` render `TrialForm` with no `packages` at all, and this ticket
     * must be invisible there: a `<select>` whose only option is "no package chosen" is
     * a question the visitor cannot answer.
     *
     * Worth having as its own assertion, because `test/trialform.test.ts` does **not**
     * catch it. Its residue check subtracts every string in `FORM_COPY`, and the
     * package strings are among them — so a package field leaking onto `/contact` is
     * subtracted away and the suite stays green. Measured, not assumed: concatenating
     * the two field lists unconditionally failed only this test out of all 117.
     *
     * **And that is why this is no longer the only thing watching** (MUSE-53). This
     * assertion is specific to this field and gave the next shared copy string no
     * cover at all. `test/formcopy.test.ts` now renders this component under every
     * prop shape and checks `GATED_COPY` against what moved, so a gated string is
     * covered by existing rather than by somebody writing a test like this one. Kept
     * anyway: it reads as the acceptance criterion it came from, and it is the one that
     * also pins the field *order* and the absence of the `name="package"` control.
     */
    for (const locale of LOCALES) {
      const bare = await container.renderToString(TrialForm, { props: { locale } });
      expect(bare, locale).not.toContain('name="package"');
      for (const string of Object.values(FORM_COPY[locale].package)) {
        expect(bare, `${locale}: ${string}`).not.toContain(string);
      }
      for (const field of FORM_FIELDS) {
        expect(bare, `${locale} ${field.name}`).toContain(`name="${field.name}"`);
      }
    }
  });
});

describe('the page says only things the site wrote or Mina typed', () => {
  /**
   * The shape `test/trialform.test.ts` arrived at for MUSE-15, applied to this page:
   * subtract every string the copy tables declare and every value the CMS supplied, and
   * whatever is left is something nobody wrote on purpose. A string allow-list would
   * pass the moment the next leak is worded differently; this fails by the leak existing.
   *
   * It is also the guard against the thing this commit is most at risk of: a price, a
   * package name or a "what's included" line invented in code rather than read from the
   * dataset. Anything of that kind is residue.
   *
   * ---
   *
   * **What this answers: provenance, not placement** (MUSE-53).
   *
   * The question is *did we write this?* — is every character the visitor can read
   * either copy from a table in `src/lib/` or a value out of the dataset. A leaked
   * diagnostic, an invented price, an untranslated string, a provider's error body: all
   * survive the subtraction and fail by existing, however they are worded.
   *
   * The question it does **not** answer is *should this be here?* A string in
   * `PRICING_COPY` or `FORM_COPY` is "ours" by definition, so it is subtracted on every
   * page this guard runs against — including the pages it must never appear on. The
   * subtraction set is therefore everything we ever wrote, not everything this page is
   * allowed to say, and it widens with every string anybody adds. **Misplaced copy is
   * invisible here and always will be.** That is covered by `GATED_COPY` in
   * `src/lib/forms.ts` and the placement suite in `test/formcopy.test.ts`; do not read
   * a green run of this file as evidence that a field is on the right page.
   */
  const phrases = (value: unknown, out: string[] = []): string[] => {
    if (typeof value === 'string') out.push(value.normalize('NFC'));
    else if (Array.isArray(value)) value.forEach((item) => phrases(item, out));
    else if (value && typeof value === 'object') {
      Object.values(value).forEach((item) => phrases(item, out));
    }
    return out;
  };

  for (const locale of LOCALES) {
    it(`${locale}: nothing is rendered that is not copy or content`, () => {
      const ours = [
        ...phrases(PRICING_COPY[locale]),
        ...phrases(FORM_COPY[locale]),
        ...phrases(PERIOD_NAME[locale]),
      ];
      const theirs = [
        ...TIERS.flatMap((doc) => {
          const want = expected(doc, locale);
          return [want.name, want.price, ...want.features];
        }),
        SITE_SETTINGS_DOC.email as string,
      ];

      // Short phrases are dropped before subtraction so they cannot chew into the text
      // around them — except the prices, which are the point and carry a € that makes
      // them distinctive at any length (`€7` is two characters).
      const subtractable = [
        ...[...ours, ...theirs].filter((phrase) => phrase.length >= 3),
        ...TIERS.map((doc) => expected(doc, locale).price),
      ].sort((a, b) => b.length - a.length);

      let left = textOf(normal[locale]).toLowerCase();
      for (const phrase of subtractable) left = left.split(phrase.toLowerCase()).join(' ');
      expect(left.replace(/[^\p{L}\p{N}_]+/gu, ''), `leftover: ${left}`).toBe('');
    });
  }

  it('invents no price of its own, in the one table that could hold one', () => {
    /**
     * Every number and every package name a visitor reads comes from `pricingTier`.
     * `PRICING_COPY` is the only place a hard-coded one could hide and still pass the
     * subtraction above — it is "ours", so it would be subtracted — so it is checked
     * directly: four structural words, no digits, no currency, no „od"/"from".
     *
     * This is the rule MUSE-36 is open for, on the one field where getting it wrong is
     * also a commercial claim.
     */
    for (const copy of Object.values(PRICING_COPY)) {
      for (const [key, value] of Object.entries(copy)) {
        expect(value, key).not.toMatch(/\d/);
        expect(value, key).not.toMatch(/[€$£]|eur/i);
      }
    }
  });
});

const SRC = fileURLToPath(new URL('../src', import.meta.url));
const SOURCE = readFileSync(join(SRC, 'components/Pricing.astro'), 'utf8');

/**
 * The component's scoped stylesheet, **with the comments taken out**.
 *
 * `scripts/check-tokens.mjs` strips them for the same reason: the rules below are about
 * declarations, and a comment that explains why a declaration is absent names the
 * property it is about. A checker that reads comments reports the explanation of the bug
 * as the bug — which is the mistake the deploy-host guard made and MUSE-35's font rule
 * had written out verbatim above it.
 */
const STYLE = SOURCE.slice(SOURCE.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');

describe('§7.2: the featured treatment is a hairline and a tab, never a fill', () => {
  /**
   * Read off the source, and said out loud rather than implied: the container API
   * renders no stylesheet, so this is the only automated check on the rule, and the
   * screenshot in the pull request is the other half. `npm run ds` covers the adjacent
   * rule — a component may not name a brand colour — and would not notice
   * `background: var(--accent)`, which is a role token and still the thing §7.2 forbids.
   */
  it('gives the featured card an accent border', () => {
    expect(STYLE).toMatch(/\.featured\b[^}]*border:\s*1px solid var\(--accent\)/);
  });

  it('fills nothing with the accent', () => {
    // "never an accent fill, which would overpower the row in either theme" (§7.2).
    for (const declaration of STYLE.match(/\bbackground(?:-color)?:[^;]+;/g) ?? []) {
      expect(declaration).not.toMatch(/--accent(?!-)/);
      expect(declaration).not.toMatch(/--accent-fill/);
    }
  });

  it('casts no shadow, in either theme', () => {
    // §5: "There are no drop shadows in this system, in either theme."
    expect(STYLE).not.toMatch(/box-shadow\s*:(?!\s*none)/);
  });

  it('has no opinion about numerals', () => {
    // MUSE-14: `font-variant-numeric` is one inherited value, set on the document in
    // `src/styles/base.css`. Declaring it here replaces `lining-nums` and `42 €`
    // becomes `4² €` with the column still neatly aligned. `npm run ds` fails on this
    // too; it is here because a price in Cormorant is the exact case that bug was about.
    expect(STYLE).not.toMatch(/font-variant-numeric|font-feature-settings/);
  });

  it('sizes nothing to a fixed width (§10: Croatian runs 20–25% longer)', () => {
    // `min-width` and `max-width` are fine — a floor and a ceiling are not a width.
    for (const declaration of STYLE.match(/(?<![-\w])width:[^;]+;/g) ?? []) {
      expect(declaration, declaration).toMatch(/100%|auto|fit-content|max-content/);
    }
  });

  /**
   * **§7.2 is „three cards", and whether three fit is arithmetic nobody had done**
   * (MUSE-73).
   *
   * The row was `repeat(auto-fit, minmax(15rem, 24rem))` inside a 1280px container with
   * 48px of section padding and a 32px gap. Three 384px cards plus two gaps is 1216
   * against a row of 1184, so the moment a third rate was seeded the page wrapped 2 + 1
   * **at the exact width this design is drawn at** — and `auto-fit` centres the *track
   * set*, so the orphan sat in track 1, under the left-hand card, reading as a card that
   * had failed to load. Every number was individually defensible and no two of them had
   * ever been multiplied together.
   *
   * So this is the multiplication, read out of the source and out of `tokens.css` rather
   * than retyped: **the seeded rates fit on one line at the container's own width.** The
   * count comes from the seed, so a fourth rate makes this a decision again rather than a
   * surprise in a screenshot; the ceiling, the gap, the padding and the container all
   * come from the files that set them, so moving any one of them fails here naming the
   * sum. It costs no build and no browser — the census has zero headroom (MUSE-68) — and
   * a layout is otherwise only visible in `npm run shots`, which is a human looking.
   */
  it('fits every seeded rate on one row at the container’s own width', () => {
    const SPACE = readFileSync(join(SRC, 'styles/tokens.css'), 'utf8');

    /** A length in CSS pixels: a `var(--space-n)` resolved against the token file, or a literal. */
    const px = (value: string): number => {
      const token = /var\(--([\w-]+)\)/.exec(value)?.[1];
      if (token !== undefined) {
        const declared = new RegExp(`--${token}:\\s*([\\d.]+)px`).exec(SPACE)?.[1];
        expect(declared, `${token} is not a px token in tokens.css`).toBeDefined();
        return Number(declared);
      }
      const rem = /^([\d.]+)rem$/.exec(value.trim())?.[1];
      if (rem !== undefined) return Number(rem) * 16;
      const absolute = /^([\d.]+)px$/.exec(value.trim())?.[1];
      expect(absolute, `${value} is neither a token, a rem nor a px`).toBeDefined();
      return Number(absolute);
    };

    /** Every declaration block for `selector`, in source order. */
    const blocks = (selector: string): string[] =>
      [...STYLE.matchAll(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]!);

    /** One declaration out of a block, by property name. */
    const declared = (block: string, property: string): string => {
      const found = new RegExp(`(?<![-\\w])${property}\\s*:\\s*([^;]+)`).exec(block)?.[1];
      expect(found, `no \`${property}\` in ${JSON.stringify(block.trim())}`).toBeDefined();
      return found!.trim();
    };

    const tiers = blocks('.tiers');
    const sections = blocks('.section');
    const cells = blocks('.cell');
    expect(tiers.length, 'no .tiers rule').toBeGreaterThan(0);
    expect(sections.length, 'no .section rule').toBeGreaterThan(0);

    // The desktop values are the last rule for each selector: the media query is at the
    // end of the stylesheet, which `test/cascade.test.ts`'s argument makes load-bearing.
    const container = px(declared(tiers[0]!, 'max-width'));
    const gap = px(declared(tiers.at(-1)!, 'gap'));
    const padding = px(declared(sections.at(-1)!, 'padding').split(/\s+/).at(-1)!);
    const sized = cells.find((block) => /flex\s*:/.test(block));
    expect(sized, 'no .cell rule sizes the card').toBeDefined();
    const ceiling = px(declared(sized!, 'flex').split(/\s+/).at(-1)!);
    const floor = px(declared(sized!, 'min-width'));

    const count = seededTiers().length;
    const row = container - 2 * padding;
    const needed = count * ceiling + (count - 1) * gap;

    expect(count, 'one card always fits; this test needs a row').toBeGreaterThan(1);
    expect(floor, 'the ceiling is below the floor').toBeLessThanOrEqual(ceiling);
    expect(
      needed,
      `${count} cards of ${ceiling}px with ${gap}px gaps need ${needed}px, and the row ` +
        `is ${container}px less 2 × ${padding}px of section padding = ${row}px. §7.2 is ` +
        'three cards; lower the ceiling, or say in the component why the row may wrap.',
    ).toBeLessThanOrEqual(row);
  });

  it('centres a line that does wrap, rather than hanging it off the left', () => {
    // The other half of the same defect, and the half that outlives today's three: a
    // wrapped flex line centres itself, where `auto-fit`'s wrapped card lands in the
    // first track of a centred track set. Stated against the desktop rule so a fourth
    // rate is a tidy 3 + 1 rather than a card that looks like it failed to load.
    const desktop = [...STYLE.matchAll(/\.tiers\s*\{([^}]*)\}/g)].at(-1)![1]!;
    expect(desktop).toMatch(/display:\s*flex/);
    expect(desktop).toMatch(/flex-wrap:\s*wrap/);
    expect(desktop).toMatch(/justify-content:\s*center/);
  });

  it('keeps the price above Cormorant’s 26px floor', () => {
    // Below it the `đ` crossbar vanishes; the scale's own floor is `display-s` at
    // 1.625rem. The price is `display-m`, whose clamp minimum is 2.125rem.
    const price = /\.price\s*\{[^}]*\}/.exec(STYLE)?.[0] ?? '';
    const min = /font-size:\s*clamp\(\s*([\d.]+)rem/.exec(price)?.[1];
    expect(min, price).toBeDefined();
    expect(Number(min)).toBeGreaterThanOrEqual(1.625);
  });
});

describe('the component copy table', () => {
  it('has an entry for every locale the site declares', () => {
    expect(Object.keys(PRICING_COPY).sort()).toEqual([...LOCALES].sort());
  });

  it('declares the same keys in both languages, and translates each one', () => {
    const [hr, en] = [PRICING_COPY.hr, PRICING_COPY.en];
    expect(Object.keys(en).sort()).toEqual(Object.keys(hr).sort());
    for (const key of Object.keys(hr) as (keyof typeof hr)[]) {
      expect(hr[key].trim(), key).not.toBe('');
      expect(en[key], key).not.toBe(hr[key]);
    }
  });
});


/* ====================================================== MUSE-59: the published page */

/**
 * **MUSE-59 — the route, and the prices that made it safe to add.**
 *
 * Everything above renders the component through the container API, because when MUSE-22
 * landed there was no `/pricing` to build: no prices had been agreed, the dataset held no
 * `pricingTier` document, and `getPricingTiers()` fails the build naming the type when
 * there are none. A route on `main` in that state stops every pull request, every deploy
 * and MUSE-21's scheduled rebuild.
 *
 * This section is the other half, and it asserts against `dist` rather than against a
 * returned string, because three of the claims cannot be made any other way:
 *
 *   - the page is **served** — a component that renders is not a route (MUSE-46);
 *   - every price on it came from the **committed seed**, which is the dataset the deploy
 *     will read once it is imported;
 *   - an **edited** price moves the number on the page. That is the only assertion a
 *     hardcoded literal fails while every equality test still passes — MUSE-50's whole
 *     subject, and here it is also the difference between a CMS field and a price list
 *     somebody would have to open a pull request to correct.
 *
 * Canonical, hreflang, the sitemap, `llms.txt` and the 200 through the model of GitHub
 * Pages are deliberately **not** re-asserted here. They are derived from `src/pages/` by
 * `test/seo.test.ts`, `test/urls.test.ts` and `test/nav.test.ts`, so `/pricing` joined
 * those the moment its two files existed; a copy of them keyed on this one route is a
 * second list to keep exhaustive. Two cheap presence checks stay, because this suite has
 * the build in hand and "the page exists but nothing links to it" is the shape MUSE-13
 * and MUSE-37 are about.
 */

/**
 * **What the studio confirmed, frozen — the receipt, not the source.**
 *
 * The seed is the source and the page reads it; this is the second copy that makes
 * „somebody invented a tier" a red test rather than a thing a reviewer has to notice.
 * `src/data/schedule.ts` is why: thirteen invented classes passed every test in the
 * repository for the life of the project, because the suite compared the page to the file
 * the page was rendered from (MUSE-36).
 *
 * It follows `PUBLISHED_BEFORE_THE_MIGRATION` in `test/content.test.ts` exactly: when Mina
 * legitimately changes a price or adds a rate, **edit this list in the same commit with a
 * sentence saying who decided it** — do not quietly make it match.
 *
 * **The edit of record (MUSE-73).** It read „two periods and no others: 55 € for one month,
 * 100 € for two" — relayed in good faith and *incomplete*. The owner was asked directly for
 * the complete rate card on 2026-10-09 and gave three rates: a regular monthly 55 €, a
 * student monthly 40 € and a 20 € drop-in; asked about the fourth price the site was
 * publishing, 100 € for two months, the owner removed it. It is on neither the rate card
 * nor the studio's own enrolment form, so it goes for MUSE-71's reason — a published price
 * nobody offers is an invented commercial claim whichever direction the invention ran.
 *
 * Worth keeping in view, because it is the first of its kind on this board: every guard
 * here was built to stop the site saying **more** than is true, and this receipt was what
 * made the site saying **less** a green test. A reader on `/pricing` concluded there was no
 * student rate. Freezing a list closes one hole and opens the other; the only thing that
 * closes both is asking the owner, which is what the entry above records.
 *
 * `featured` is in here for the same reason the prices are. Nobody has asked the studio
 * which rate to single out, so none of the three is featured — three cards is exactly the
 * arrangement a „most popular" tab is written for, and inventing that emphasis is
 * inventing a claim about other people's behaviour. „An empty optional field is a
 * decision" is only a decision if undoing it is visible.
 */
const CONFIRMED_TIERS = [
  { id: 'pricing-one-month', priceEur: 55, period: 'month', featured: false },
  { id: 'pricing-student', priceEur: 40, period: 'month', featured: false },
  { id: 'pricing-dropin', priceEur: 20, period: 'class', featured: false },
] as const;

/**
 * **The rate the studio no longer publishes, kept by `_id` so its return is a red test.**
 *
 * `pricing-two-months` is deleted from the seed, and a seed deletion is *not* a dataset
 * deletion: `npm run sanity:seed` is `sanity dataset import --replace`, which replaces by
 * `_id` and leaves everything it was not given alone. So removing the line is the half this
 * repository can hold, and the other half is a write nobody here performs — see the pull
 * request. What this constant is for is the half that *is* testable: the document must not
 * come back into the seed, and no rate on the page may be the one it carried.
 */
const RETIRED_TIER = { id: 'pricing-two-months', priceEur: 100, period: 'package' } as const;

/**
 * The prices the edited dataset states instead, for the MUSE-50 build.
 *
 * Deliberately unlike anything else a page of this site prints, and no one of them a
 * substring of another or of the seeded three — the absence claim below is a byte search
 * over every file in the output, so `€15` inside `€150` would make it pass for the wrong
 * reason, and `20 €` inside `120 €` is the same trap with the seeded value on the inside.
 */
const EDITED_PRICES: Record<string, number> = {
  'pricing-one-month': 73,
  'pricing-student': 86,
  'pricing-dropin': 91,
};

/** Where each locale's pricing page lands in the output. */
const PRICING_PAGE: Record<Locale, string> = {
  hr: 'pricing/index.html',
  en: 'en/pricing/index.html',
};

/**
 * The seed's tiers in the order `PRICING_QUERY` returns them.
 *
 * `order` ascending with `priceEur` as the tie-break, which is `coalesce(order, 999) asc,
 * priceEur asc` — reproduced rather than imported, because importing the query would make
 * the assertion "the query agrees with itself" (the reason `seededSchedule` joins by hand).
 */
function seededTiers(): SeedDoc[] {
  return seedDocsOfType('pricingTier').sort((a, b) => {
    const rank = (doc: SeedDoc): number =>
      typeof doc.order === 'number' ? doc.order : 999;
    return rank(a) - rank(b) || (a.priceEur as number) - (b.priceEur as number);
  });
}

/** The text of every `data-price` element on a page, in document order. */
function pricesIn(html: string): string[] {
  return [...html.matchAll(/<p\b[^>]*\bdata-price\b[^>]*>([\s\S]*?)<\/p>/g)].map((m) =>
    textOf(m[1]!),
  );
}

/** Every formatted price the committed seed produces, in both locales. */
function seededPriceStrings(): string[] {
  return seededTiers().flatMap((tier) =>
    LOCALES.map((locale) => formatPrice(tier.priceEur as number, locale)),
  );
}

let published: Build;
let repriced: Build;
let withoutTiers = '';

beforeAll(() => {
  if (SEED_FIXTURE === undefined) {
    throw new Error(
      `${FIXTURE_ENV} is unset, so these builds would fetch the live dataset. ` +
        'vitest.config.ts points it at content/seed.ndjson.',
    );
  }
  published = buildSite(PAGES_DEPLOY, { [FIXTURE_ENV]: SEED_FIXTURE });

  repriced = buildSite(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf(
      seedDocs().map((doc) =>
        doc._type === 'pricingTier' && doc._id in EDITED_PRICES
          ? { ...doc, priceEur: EDITED_PRICES[doc._id]! }
          : doc,
      ),
      'pricing-repriced',
    ),
  });

  // The ordering trap in the ticket, as a test: this is the state `main` is in until the
  // dataset is seeded, and it has to be loud.
  withoutTiers = buildFailure(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf(
      seedDocs().filter((doc) => doc._type !== 'pricingTier'),
      'pricing-unseeded',
    ),
  });
}, 600_000);

describe('MUSE-73: three rates, confirmed by the owner, and no others', () => {
  it('seeds exactly the confirmed rates, at the confirmed prices', () => {
    expect(
      seededTiers().map((tier) => ({
        id: tier._id,
        priceEur: tier.priceEur,
        period: tier.period,
        featured: tier.featured,
      })),
    ).toEqual(CONFIRMED_TIERS.map((tier) => ({ ...tier })));
  });

  it('publishes every rate the studio charges, which is the half MUSE-59 missed', () => {
    // The direction nothing on this board was watching. MUSE-59's guard made „a fourth
    // document is content nobody confirmed" a red test and left „a rate nobody published"
    // green — and the site charged three rates while publishing one of them.
    expect(seededTiers().map((tier) => tier.priceEur).sort()).toEqual(
      CONFIRMED_TIERS.map((tier) => tier.priceEur).sort(),
    );
  });

  it('invents no fourth rate, no package and no course price', () => {
    // The assertion MUSE-36 did not have. A fourth document in the seed is content nobody
    // confirmed, and a price is a commercial claim as well as a string.
    expect(seededTiers()).toHaveLength(CONFIRMED_TIERS.length);
  });

  it('no longer seeds the two-month package, by id, by price and by period', () => {
    /**
     * Three claims because there are three ways for it to come back: the same document, a
     * new document carrying the same rate, and a rate the page would describe as a
     * package. The owner removed this price on 2026-10-09; the dataset half of the
     * removal is a write this repository cannot perform (see the pull request).
     */
    expect(seedDocs().map((doc) => doc._id)).not.toContain(RETIRED_TIER.id);
    expect(seededTiers().map((tier) => tier.priceEur)).not.toContain(RETIRED_TIER.priceEur);
    expect(seededTiers().map((tier) => tier.period)).not.toContain(RETIRED_TIER.period);
  });

  it('leaves the retired price nowhere on the built page, in either locale', () => {
    // The output half: the number, formatted the way the page would have printed it.
    for (const locale of LOCALES) {
      expect(
        published.read(PRICING_PAGE[locale]),
        `${locale} still prints the retired rate`,
      ).not.toContain(formatPrice(RETIRED_TIER.priceEur, locale));
    }
  });

  it('charges students less than the regular monthly rate, as the card says', () => {
    const regular = CONFIRMED_TIERS.find((tier) => tier.id === 'pricing-one-month')!;
    const student = CONFIRMED_TIERS.find((tier) => tier.id === 'pricing-student')!;
    expect(student.period, 'the student rate is monthly too').toBe(regular.period);
    expect(student.priceEur).toBeLessThan(regular.priceEur);
  });

  it('prices the drop-in per class rather than per month', () => {
    // „po satu" / "per class", not „paket" / "one-off package" — the wording MUSE-80
    // found makes a payment-terms claim the Croatian does not. The period is the whole
    // of the fix: a drop-in is one class, and `class` is the value that says so.
    const dropIn = seededTiers().find((tier) => tier._id === 'pricing-dropin')!;
    expect(dropIn.period).toBe('class');
    const monthly = seededTiers().filter((tier) => tier.period === 'month');
    expect(monthly).toHaveLength(2);
    for (const locale of LOCALES) {
      const card = cards(published.read(PRICING_PAGE[locale])).find(
        (c) => c.attrs['data-tier'] === dropIn._id,
      )!;
      expect(card, locale).toBeDefined();
      expect(card.text, locale).toContain(PERIOD_NAME[locale]['class']);
      expect(card.text, locale).not.toContain(PERIOD_NAME[locale]['month']);
    }
  });

  it('says of each rate only what its own document says', () => {
    // Every tier's `features`, rendered — which is where a line about what a rate is for
    // belongs. Not a sentence composed in the component, which would be a second place a
    // claim about a price lives and would go stale on the next Studio edit. Stated over
    // every tier rather than over the one that had a discount line, so the next rate is
    // covered the day it is seeded.
    for (const tier of seededTiers()) {
      const features = tier.features as Record<Locale, string>[];
      expect(features.length, tier._id).toBeGreaterThan(0);
      for (const locale of LOCALES) {
        for (const feature of features) {
          expect(feature[locale]?.trim(), `${tier._id} ${locale}`).toBeTruthy();
          expect(
            published.read(PRICING_PAGE[locale]),
            `${tier._id} ${locale}`,
          ).toContain(feature[locale]);
        }
      }
    }
  });

  it('singles out none of the three, so no card claims to be the popular one', () => {
    // Three cards is the arrangement a „most popular" tab is written for, and nobody has
    // said which rate that would be. `resolveFeatured` treats zero as a complete page.
    expect(seededTiers().filter((tier) => tier.featured === true)).toEqual([]);
    for (const locale of LOCALES) {
      expect(published.read(PRICING_PAGE[locale]), locale).not.toContain('data-tab');
      expect(published.read(PRICING_PAGE[locale]), locale).not.toContain(
        PRICING_COPY[locale].featuredTab,
      );
    }
  });

  it('fills both locales of every string on every tier', () => {
    // `decodePricingTier` fails the build on a half-translated tier, so this is the same
    // claim stated against the artefact the orchestrator is about to import.
    for (const tier of seededTiers()) {
      for (const locale of LOCALES) {
        expect((tier.name as Record<Locale, string>)[locale], tier._id).toBeTruthy();
      }
    }
  });
});

describe('MUSE-59: /pricing is a route this site serves', () => {
  it('declares the route where a reader meets it, not at the end', () => {
    // Between the timetable and the contact page: what is on, what it costs, how to come.
    //
    // „Immediately after `/schedule`" until MUSE-24, which put `/events` and its archive
    // between them — also „what is on", in its one-off shape. The adjacency was an
    // accident of a seven-route list; what this test is for is the sentence above it, and
    // that is what it now says.
    const order = ROUTES.map(({ route }) => route);
    expect(order).toContain('/pricing');
    expect(order.indexOf('/pricing')).toBeGreaterThan(order.indexOf('/schedule'));
    expect(order.indexOf('/pricing')).toBeLessThan(order.indexOf('/contact'));
  });

  it('gives the route a Studio label', () => {
    const entry = ROUTES.find(({ route }) => route === '/pricing');
    expect(entry?.studioLabel?.trim()).toBeTruthy();
  });

  it('puts it in the navigation, in both languages', () => {
    // MUSE-13's twelve dead links are what this is: the entry existed and the page did
    // not. `test/nav.test.ts` follows every link in the built output, so the 404 half is
    // covered there; this is the half that says the entry is there at all.
    const entry = PRIMARY_NAV.find(({ route }) => route === '/pricing');
    expect(entry, '/pricing is not in PRIMARY_NAV').toBeDefined();
    for (const locale of LOCALES) expect(entry!.label[locale]?.trim(), locale).toBeTruthy();
  });

  it('builds a page in each locale', () => {
    for (const locale of LOCALES) {
      expect(published.htmlFiles(), locale).toContain(PRICING_PAGE[locale]);
    }
  });

  it('is advertised to machines and to crawlers', () => {
    // Cheap, and both derived from the registry rather than written here: the full
    // non-redirecting/canonical/hreflang claims are `test/seo.test.ts` and
    // `test/urls.test.ts`, which read their page list off `src/pages/`.
    expect(published.read('llms.txt')).toContain('/pricing/');
    const sitemaps = published.files().filter((file) => /^sitemap-\d+\.xml$/.test(file));
    expect(sitemaps.length, 'the build emitted no numbered sitemap').toBeGreaterThan(0);
    expect(sitemaps.map((file) => published.read(file)).join('')).toContain('/pricing/');
  });
});

/**
 * **MUSE-75 — the heading outline, against `dist`, because the a11y gate could not see it.**
 *
 * The page shipped `h1 Cjenik` → `h3 Jedan mjesec`, with its only `h2` („Prijavi se")
 * *below* the cards: a skipped level in both locales, which design system §11.8 forbids
 * by name and which axe reports as `heading-order`. The interesting half is that
 * `npm run a11y` **could not fail on it** — it filtered to `wcag2a`/`wcag2aa`/`wcag21a`/
 * `wcag21aa` and `heading-order` is tagged `best-practice`, so a real axe-detected defect
 * on a shipped page was invisible to the gate that exists to catch it. That filter is gone
 * (`scripts/a11y.mjs`), which makes the browser gate the general guard.
 *
 * This is the specific one, and it is worth having beside it for two reasons: it runs in
 * `npm test` with no browser, on the build this file already performs, and it names the
 * page and the two levels rather than a CSS selector. The rule is stated over *every*
 * built page rather than over `/pricing`, because a guard that only looks where the bug
 * was is the shape this board keeps re-filing — and it costs nothing extra, since
 * `published` is the whole site.
 */
describe('MUSE-75: no built page skips a heading level', () => {
  /** `[level, text]` for every heading in a built page, in document order. */
  function headings(html: string): [number, string][] {
    return [...html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/g)].map((m) => [
      Number(m[1]),
      m[2]!.replace(/<[^>]*>/g, '').trim(),
    ]);
  }

  it('finds headings on every page, so the rule below cannot pass vacuously', () => {
    const bare = published
      .htmlFiles()
      .filter((page) => headings(published.read(page)).length === 0);
    expect(bare).toEqual([]);
  });

  it('increases a level by one at a time, on every page of the site', () => {
    const skips = published.htmlFiles().flatMap((page) => {
      const found = headings(published.read(page));
      const out: string[] = [];
      let previous = 0;
      for (const [level, text] of found) {
        if (previous !== 0 && level > previous + 1) {
          out.push(`${page}: h${previous} → h${level} at “${text}”`);
        }
        previous = level;
      }
      return out;
    });
    expect(
      skips,
      'design system §11.8: no skipped heading levels. axe calls this `heading-order` ' +
        'and tags it best-practice, which is why the gate stayed green while /pricing ' +
        'went h1 → h3 in both locales.',
    ).toEqual([]);
  });

  /** The specific outline this ticket is about, named so a regression says which page. */
  for (const locale of LOCALES) {
    it(`${locale}: the price list sits at h2, between the page’s h1 and the form’s`, () => {
      const found = headings(published.read(PRICING_PAGE[locale]));
      const main = found.filter(([, text]) => text !== '');
      expect(main[0]?.[0], 'the page’s own title is the h1').toBe(1);
      for (const tier of seededTiers()) {
        const name = (tier.name as Record<Locale, string>)[locale];
        expect(
          found.find(([, text]) => text === name)?.[0],
          `${name} is a tier card’s heading`,
        ).toBe(2);
      }
    });
  }
});

describe('MUSE-59: every price on the page came out of the dataset', () => {
  for (const locale of LOCALES) {
    it(`${locale}: each card's price is exactly what its document formats to`, () => {
      const html = published.read(PRICING_PAGE[locale]);
      expect(pricesIn(html)).toEqual(
        seededTiers().map((tier) => formatPrice(tier.priceEur as number, locale)),
      );
    });

    it(`${locale}: each card pairs its price with its own period`, () => {
      // The pairing is the acceptance criterion — „55 € for one month" — and a per-card
      // assertion is what tells it from a page that happens to contain both numbers.
      const rendered = cards(published.read(PRICING_PAGE[locale]));
      expect(rendered.map((card) => card.attrs['data-tier'])).toEqual(
        seededTiers().map((tier) => tier._id),
      );
      for (const [index, tier] of seededTiers().entries()) {
        const card = rendered[index]!;
        expect(valueOf(card.html, 'data-price'), tier._id).toBe(
          formatPrice(tier.priceEur as number, locale),
        );
        expect(card.text, tier._id).toContain(periodName(tier.period as string, locale));
        expect(card.text, tier._id).toContain((tier.name as Record<Locale, string>)[locale]);
      }
    });
  }

  it('writes the Croatian price with its no-break space and the English one without', () => {
    for (const price of pricesIn(published.read(PRICING_PAGE.hr))) {
      expect(price).toMatch(/^[\d.,]+ €$/);
    }
    for (const price of pricesIn(published.read(PRICING_PAGE.en))) {
      expect(price).toMatch(/^€[\d.,]+$/);
    }
  });
});

describe('MUSE-50: an edited price moves the number on the page', () => {
  it('edits to prices that really differ from the seed', () => {
    // Otherwise everything below is satisfied by the literal this suite exists to forbid.
    for (const tier of seededTiers()) {
      expect(EDITED_PRICES[tier._id], tier._id).toBeDefined();
      expect(EDITED_PRICES[tier._id]).not.toBe(tier.priceEur);
    }
  });

  for (const locale of LOCALES) {
    it(`${locale}: the rebuilt page prints the edited prices`, () => {
      expect(pricesIn(repriced.read(PRICING_PAGE[locale]))).toEqual(
        seededTiers().map((tier) => formatPrice(EDITED_PRICES[tier._id]!, locale)),
      );
    });
  }

  it('leaves the seeded prices nowhere in the rebuilt output — not one byte', () => {
    const stale = published
      .htmlFiles()
      .flatMap((file) =>
        seededPriceStrings()
          .filter((price) => repriced.read(file).includes(price))
          .map((price) => `${file} still prints ${price}`),
      );
    expect(stale).toEqual([]);
  });

  it('and the control: the committed seed really does publish them', () => {
    // The other direction, so the absence above is a consequence of the edit rather than
    // of the prices never having been on the page.
    const found = seededPriceStrings().filter((price) =>
      LOCALES.some((locale) => published.read(PRICING_PAGE[locale]).includes(price)),
    );
    expect(found.sort()).toEqual([...seededPriceStrings()].sort());
  });
});

describe('MUSE-59: the ordering trap — the route without the documents', () => {
  /**
   * **Why this test is the one that justifies the pull request's warning.**
   *
   * `getPricingTiers()` leaves `minimum` at 1, so until the `pricingTier` documents are in
   * the live dataset the route fails `npm run build` — and the build is what every pull
   * request, the deploy and the scheduled rebuild run. The failure has to name the type,
   * because "a page is blank" and "the dataset has not been seeded" are not the same
   * problem and only one of them is fixed by an import.
   */
  it('fails the build, naming `pricingTier` and what it needed', () => {
    expect(withoutTiers).toContain('pricingTier');
    expect(withoutTiers).toContain('at least 1');
  });

  it('fails as a content error rather than as a transport one', () => {
    // `TRANSIENT_BUILD_FAILURE` is what `deploy.yml` retries on (MUSE-21). An unseeded
    // dataset will not seed itself on the third attempt, so it must not look transient.
    expect(withoutTiers).not.toContain('TRANSIENT_BUILD_FAILURE');
  });
});

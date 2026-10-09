import { LOCALE_HTML_LANG, localeUrl, type Locale } from './i18n';
import { STUDIO } from './nav';
import { addressLines, socialUrl, type SiteSettings } from './sanity';

/**
 * **The site's structured data. One module, one emission site (MUSE-31).**
 *
 * The site had none: `validator.schema.org` answered `"numObjects": 0` for every URL on
 * the live deploy. For a studio competing on „bachata Zagreb" this is the block that
 * produces the address panel in search results, so it is the one that landed first.
 *
 * ## Why this is a function of `SiteSettings` and not a reader of it
 *
 * The failure mode for structured data is not absence, it is **disagreement**: a block
 * that says one thing to a crawler while the page shows a reader another. Google reads
 * that as an attempt to game it, and the way it happens is never malice — it is a second
 * copy of the content, assembled by hand, drifting one field at a time. This repository
 * has two live examples: MUSE-11, where the homepage's level names disagreed with
 * `/schedule`, and MUSE-50, where one of the five address surfaces spelled the street as
 * a literal inside a longer label and would have kept the old one the day the studio
 * moved. The street is deliberately not written out here: `test/contentdrift.test.ts`
 * fails on any copy of a CMS-owned value under `src/`, prose included, because a stale
 * copy in a comment is believed rather than noticed.
 *
 * So this module holds no studio details at all. It takes the `SiteSettings` the page
 * already rendered from — the same memoised `getSiteSettings()` promise the footer reads,
 * one read per build — and projects it into JSON-LD. There is nothing here for a value to
 * drift *from*: `name`, `address`, `email` and the three profile URLs have exactly one
 * source, and it is the dataset that deploys. `test/structured-data.test.ts` holds the
 * block and the rendered page equal field by field, and then rebuilds the whole site from
 * an edited dataset and demands both moved — which is the assertion a literal fails and
 * every other assertion in that suite would pass.
 *
 * `addressLines` and `socialUrl` are the same two helpers the footer uses, for the same
 * reason it uses them: a street without a city or a profile without a URL fails the build
 * naming the document rather than publishing half a statement.
 *
 * ## Why `LocalBusiness` and not `DanceSchool`
 *
 * The ticket asks for „a `DanceSchool` (or `LocalBusiness`) block". **`DanceSchool` is
 * not a schema.org type** — `https://schema.org/DanceSchool` is a 404, there is no dance
 * type among `LocalBusiness`'s 33 direct subtypes, and none under
 * `EducationalOrganization`. An unknown `@type` does not fail loudly: the validator
 * reports a node with no recognised type and every property on it unrecognised, so the
 * page would carry structured data that says nothing while looking right in the source.
 *
 * The studio is therefore multi-typed as what it actually is — a local business that is
 * also an educational organisation. Both are real types, both are things the studio is,
 * and multi-typing is ordinary JSON-LD. `test/structured-data.test.ts` pins the type
 * names so the ticket's wording cannot talk a later reader into putting the 404 back.
 *
 * ## What is deliberately not here
 *
 * **Nothing derived from the class schedule.** `openingHours` is the obvious candidate —
 * the studio's hours are when classes run — and the ticket floats it. It is a good
 * follow-up and it was not done here: deriving it is only as true as the timetable, and
 * the timetable had just been replaced (MUSE-36) after thirteen invented classes reached
 * production. Publishing hours in machine-readable form is publishing them somewhere a
 * crawler caches and a human never looks, so it is the last place fiction should reach,
 * not the first.
 *
 * `FAQPage` and `Event` are the ticket's other types and wait on `/faq` and `/events`
 * (MUSE-24) existing. `BreadcrumbList`, review and rating markup, and `Course` are out of
 * scope in the ticket itself.
 *
 * `Article` arrived with `/blog` (MUSE-26) and is below as `BlogPosting`. It is here
 * rather than in `PostPage.astro` because `test/structured-data.test.ts` fails if a second
 * `.astro` file writes an `application/ld+json` tag at all: two emission sites are two
 * answers to „does the markup agree with the page", which is the failure this whole module
 * is shaped around. So a post hands its facts *up* through `BaseLayout`'s `article` prop
 * and the one `<script>` carries three nodes instead of two.
 */

/** The vocabulary every block is written in. */
export const SCHEMA_CONTEXT = 'https://schema.org';

/**
 * The studio's type, as schema.org spells it.
 *
 * Two types rather than one because no single type says „dance school": it is a business
 * with a street address *and* a place that teaches. See the note above for why the
 * ticket's `DanceSchool` is not an option.
 */
export const STUDIO_TYPE = ['LocalBusiness', 'EducationalOrganization'] as const;

/**
 * Which profiles the block publishes as `sameAs`, and in which order.
 *
 * The same three the footer links with `rel="me"`, named here rather than mapped off
 * `settings.social`, for the reason the footer gives: which networks are linked is the
 * design's decision and the URLs are content. Asking by name also means a platform
 * missing from the dataset fails the build naming the document (`socialUrl`) instead of
 * silently shortening the list — and a `sameAs` that quietly drops a profile is exactly
 * the kind of nothing nobody notices.
 *
 * `sameAs` and `rel="me"` are the same claim in two syntaxes — "another profile of this
 * same entity" — which is why the suite can hold them equal without knowing the networks.
 */
export const PROFILE_PLATFORMS = ['instagram', 'facebook', 'linktree'] as const;

/**
 * **`BlogPosting`, not `Article` — and both are real, which is the difference from
 * `DanceSchool`** (MUSE-26).
 *
 * The ticket says „article structured data". `Article` would validate; `BlogPosting` is a
 * subtype of it and is what a post on a studio's blog actually is, so it is the more
 * specific true statement and consumers that understand only `Article` still understand
 * it. The reason to say this out loud is the note above: `DanceSchool` *looked* like the
 * obvious type too, and an unknown `@type` fails silently — the validator reports a node
 * with nothing recognised on it. `BlogPosting` resolves at `https://schema.org/
 * BlogPosting`; `test/blog.test.ts` pins the name so a later reader cannot talk themselves
 * into a plausible-looking one.
 */
export const ARTICLE_TYPE = 'BlogPosting';

/** A JSON-LD node: a `@type` and whatever properties that type carries. */
type Node = Record<string, unknown>;

/**
 * One post, as the facts a `BlogPosting` node needs — assembled by the page that *is* the
 * post and passed up, never read here.
 *
 * Every field is already on the page a reader sees: the headline is the `<h1>`, the
 * description is the `<meta name="description">` the same `excerpt` produced, the date is
 * the `<time>`, the byline is the byline. That is the construction `structuredData`'s own
 * note argues for — there is nothing here for a value to drift *from*, because the page
 * and the block are two renderings of one set of strings.
 */
export interface ArticleInput {
  /** The post's title, in this page's locale. */
  headline: string;
  /** The same string the page's `<meta name="description">` carries. */
  description: string;
  /** `publishedAt`, a UTC ISO instant. */
  datePublished: string;
  /**
   * The instructor who wrote it, or `undefined` for a post the studio signs.
   *
   * `undefined` means exactly one thing (MUSE-49): nobody was named. A *deleted* author is
   * a build failure long before this, in `decode.ts`, so the unsigned case cannot arrive
   * here by accident — which is what makes falling back to the studio safe rather than a
   * guess. `author` is a required property of `BlogPosting` for Google's article
   * treatment, and the studio is the honest answer when the field is empty: it is what the
   * visible byline says, off the same `studioName`.
   */
  authorName?: string;
  /** Absolute URL of the cover image, if the post has one. */
  image?: string;
}

export interface StructuredDataInput {
  /** The singleton the page already rendered from. Not re-read here — see the note. */
  settings: SiteSettings;
  locale: Locale;
  /** The page's own canonical, absolute, as `BaseLayout` computed it. */
  canonical: string;
  /** `Astro.site` — the deploy's origin, so nothing here names a host (MUSE-8). */
  site: URL;
  /** Set only on a page that *is* an article. See {@link ArticleInput}. */
  article?: ArticleInput;
}

/**
 * The JSON-LD document one page publishes: the studio, and the page itself.
 *
 * Two nodes in a `@graph` rather than one bare node, because the ticket wants two things
 * at once that a single node cannot honestly carry: a stable identity for the studio, and
 * a reference to *this* page's canonical. A lone node would have to put the current
 * page's URL in `url` and so claim a different `url` for the same organisation on every
 * page — a graph that contradicts itself for any consumer that merges nodes by `@id`.
 * Split, each node says one true thing: the studio is at its own URL, the page is at
 * its own URL, and the page is `about` the studio.
 *
 * **Per locale, including the identity.** HR and EN share slugs, so the two documents
 * differ only in language and URL — which is precisely the shape that gets copy-pasted
 * and then drifts. Nothing is spelled twice: the locale picks the homepage through
 * `localeUrl`, the summary through `settings.summary[locale]`, and the language tag
 * through the same `LOCALE_HTML_LANG` the `<html lang>` attribute uses. The studio's
 * `@id` is locale-scoped too, because one `@id` carrying a Croatian description on one
 * page and an English one on the next is a self-contradicting graph.
 *
 * Every URL comes from `localeUrl` or from the canonical `BaseLayout` built with it —
 * never from string concatenation. Every page URL on this site ends in a slash and the
 * unslashed spelling is a 301, so a hand-built URL inside a block is the MUSE-9 bug in a
 * second syntax: a crawler following it is redirected away from the page that claimed it.
 */
export function structuredData({
  settings,
  locale,
  canonical,
  site,
  article,
}: StructuredDataInput): Node {
  const address = addressLines(settings);
  const home = new URL(localeUrl('/', locale), site).href;
  const studioId = `${home}#studio`;

  const studio: Node = {
    '@type': [...STUDIO_TYPE],
    '@id': studioId,
    name: settings.studioName,
    description: settings.summary[locale],
    url: home,
    email: settings.email,
    address: {
      '@type': 'PostalAddress',
      streetAddress: address.street,
      addressLocality: address.city,
      /**
       * The ISO 3166-1 alpha-2 code, which is what schema.org asks for and a different
       * thing from the country *name* the footer prints — that one is translated, and
       * „Hrvatska"/"Croatia" is the site saying it in the page's language. Both live
       * beside each other in `STUDIO`; see the note there.
       */
      addressCountry: STUDIO.countryCode,
    },
    sameAs: PROFILE_PLATFORMS.map((platform) => socialUrl(settings, platform)),
  };

  const page: Node = {
    '@type': 'WebPage',
    '@id': canonical,
    url: canonical,
    inLanguage: LOCALE_HTML_LANG[locale],
    about: { '@id': studioId },
  };

  /**
   * The post, as a third node in the same graph (MUSE-26).
   *
   * A node rather than a replacement for `WebPage`, for the reason the graph is two nodes
   * in the first place: the page and the thing on it are different entities, and merging
   * them would make one `@id` claim both „this is a web page at this URL" and „this is an
   * article published on a date", which a consumer merging by `@id` reads as one
   * self-contradicting object. `mainEntityOfPage` is the edge between them, in the
   * direction schema.org defines it — the article is *of* the page — and the page's own
   * `about` edge to the studio is untouched.
   *
   * `datePublished` and no `dateModified`: Sanity has `_updatedAt` on every document, and
   * publishing it would claim the article's *text* changed when what changed may have been
   * a typo in the author reference. Nobody has asked for it, and a date that moves for the
   * wrong reason is the kind of fact MUSE-36 is about. No `wordCount` either, for the
   * `openingHours` reason the note above gives: a derived number in a machine-readable
   * surface that no human ever checks.
   */
  const nodes: Node[] = [studio, page];
  if (article !== undefined) {
    nodes.push({
      '@type': ARTICLE_TYPE,
      '@id': `${canonical}#post`,
      url: canonical,
      headline: article.headline,
      description: article.description,
      datePublished: article.datePublished,
      inLanguage: LOCALE_HTML_LANG[locale],
      mainEntityOfPage: { '@id': canonical },
      author:
        article.authorName === undefined
          ? { '@id': studioId }
          : { '@type': 'Person', name: article.authorName },
      publisher: { '@id': studioId },
      ...(article.image === undefined ? {} : { image: article.image }),
    });
  }

  return { '@context': SCHEMA_CONTEXT, '@graph': nodes };
}

/**
 * One JSON-LD document, serialised for a `<script type="application/ld+json">`.
 *
 * `<` is escaped rather than left alone. JSON knows nothing about HTML, so a value
 * containing `</script>` would close the element early and spill the rest of the block
 * into the document as text — and the values here are CMS fields, which is to say
 * arbitrary text somebody types in a Studio. `<` is a plain JSON string escape, so
 * the block still parses to exactly the same object; `test/structured-data.test.ts`
 * asserts the emitted payload carries no raw `<` and that it parses.
 *
 * Serialising here, next to the thing being serialised, is also what keeps the emission
 * one line of markup in `BaseLayout` rather than a template with an expression in it.
 */
export function jsonLd(document: Node): string {
  return JSON.stringify(document).replace(/</g, '\\u003c');
}

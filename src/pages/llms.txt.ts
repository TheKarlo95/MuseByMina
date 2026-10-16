import type { APIRoute } from 'astro';
import { publishedLocales } from '../lib/blog';
import { LOCALES, localeUrl, type Locale } from '../lib/i18n';
import {
  getPageMeta,
  getPosts,
  getSiteSettings,
  socialUrl,
  type PageMetaDoc,
  type Post,
} from '../lib/sanity';
import { rootUrl } from '../lib/site';

/**
 * A machine-readable index, in the llms.txt convention: an H1, a blockquote summary,
 * then `## ` sections of `- [Name](url): one-line description` links.
 *
 * Same reason as `robots.txt` for generating it: every URL is absolute and the origin
 * comes from `SITE`/`BASE`. The words come from Sanity — the `page` documents and the
 * `siteSettings` singleton (MUSE-20) — which is also where the pages themselves get
 * them, so this index cannot drift from the site. `test/seo.test.ts` holds that to
 * account by comparing each line below against the `<meta name="description">` in that
 * route's built HTML, rather than against the CMS they both read.
 *
 * The *order* is `src/lib/pages.ts`'s, not the query's: a reader should meet the
 * homepage first, which is not where `order(route asc)` puts it.
 */
const LOCALE_HEADING: Record<Locale, string> = {
  hr: 'Hrvatski (hr)',
  en: 'English (en)',
};

/**
 * **What this file may say about locale coverage — read off the build, never written
 * down** (MUSE-87).
 *
 * Line 6 used to read „Every page exists in both locales with the same slug.", and the
 * sitemap index's own description used to read „every page in both locales, with hreflang
 * alternates." Both were written by MUSE-5 (`git log -S` names `07fe496` for each), both
 * were true that day, and **MUSE-26 made them false on purpose**: a `post` carries up to
 * two `postTranslation` objects, „published in Croatian" is „`post.hr` exists", and a
 * one-locale post gets no URL, no `hreflang` cluster and no switcher in the other
 * language. So the site published a universal to machines — crawlers, and this project's
 * own QA agents, which read this file — that its own content model contradicts, and
 * nothing could notice, because a sentence is compared against nothing.
 *
 * Both sentences are now picked by {@link localeClaims} from the posts the build is
 * publishing, so the file cannot say more than the build did. Three things about the
 * shape, each of which was the alternative:
 *
 *   - **The claim is derived rather than narrowed.** Scoping line 6 to „the pages listed
 *     below" would also have been true — the *pages* are mirrored by construction, since
 *     `localeUrl` builds both and `test/routes.test.ts` holds it in both directions — but
 *     it answers a crawler's question with silence about exactly the URLs that vary, and
 *     it is still a hand-maintained sentence about locale coverage: the second copy of a
 *     fact the build already knows, which is MUSE-46's route list and MUSE-50's address
 *     registry.
 *   - **It is not deleted.** The convention line above it describes the URL *shape* and
 *     says nothing about coverage, and a crawler cannot infer „a post may exist in one
 *     language" from two sections of page links that contain no posts. A file whose whole
 *     purpose is to describe the site accurately should answer the question.
 *   - **Neither wording hedges.** „Most pages" is this defect with less information in it.
 *
 * **Only `post` is read, and the reason is a fact about the schema rather than an
 * assumption.** Every other bilingual value on the site is a `localeString` or
 * `localeText` with both locales separately `required()`, so an `event`, a `page` and a
 * `pricingTier` cannot exist in one language; `postTranslation` is the one inverse
 * grouping (`sanity/schemaTypes/objects/locale.ts`). If a second type ever gains
 * per-locale publication it belongs in the argument to {@link localeClaims} — and
 * forgetting to put it there is a red test rather than a silent lie, because
 * `test/seo.test.ts` compares what this file printed against the locale coverage of
 * `dist`, read off the sitemap, which holds every page the build emitted.
 */
export const LOCALE_CLAIMS = {
  /** Every page this build published has a twin. */
  mirrored: {
    index: 'Every page this build publishes exists in both locales with the same slug.',
    sitemap: 'every page this build publishes, in both locales, with hreflang alternates.',
  },
  /** At least one does not, so the file states the rule instead of a universal. */
  perLanguage: {
    index:
      'Every page listed below exists in both locales with the same slug. A blog post is ' +
      'published only in the languages it is written in, so some pages this build ' +
      'publishes have no twin in the other locale.',
    sitemap:
      'every page this build publishes, with hreflang alternates where a page has a twin.',
  },
} as const;

/** One of the two wordings above — the index's line 6 and the sitemap link's description. */
export type LocaleClaim = (typeof LOCALE_CLAIMS)[keyof typeof LOCALE_CLAIMS];

/**
 * Which claim this build is entitled to make.
 *
 * Handed the decoded posts rather than a flag, so „is anything published in one language"
 * is answered by {@link publishedLocales} — the single fact `/blog`'s index, the locale
 * templates' `getStaticPaths`, `localeTwins` and therefore the `hreflang` cluster and the
 * switcher all already read (MUSE-26). One more reader of that fact cannot disagree with
 * them; a second predicate written here could.
 */
export function localeClaims(posts: readonly Post[]): LocaleClaim {
  const mirrored = posts.every((post) => publishedLocales(post).length === LOCALES.length);
  return mirrored ? LOCALE_CLAIMS.mirrored : LOCALE_CLAIMS.perLanguage;
}

/** Each page gets its own locale's wording — an index in one language is half an index. */
function section(locale: Locale, site: URL | undefined, pages: PageMetaDoc[]): string[] {
  const lines = [`## ${LOCALE_HEADING[locale]}`, ''];

  for (const page of pages) {
    const url = new URL(localeUrl(page.route, locale), site).href;
    lines.push(`- [${page.name[locale]}](${url}): ${page.description[locale]}`);
  }

  return [...lines, ''];
}

export const GET: APIRoute = async ({ site }) => {
  if (!site) throw new Error('`site` is not configured — cannot build absolute URLs.');

  // `minimum: 0` is what `/blog` and both locale templates pass: no post is a real state
  // of this studio, and the strict default would make an ordinary Tuesday a failed build.
  // The posts are read for one fact — which languages they are published in — so this
  // file's claim about locale coverage is the build's own answer rather than a sentence
  // somebody kept up to date.
  const [settings, pages, posts] = await Promise.all([
    getSiteSettings(),
    getPageMeta(),
    getPosts({ minimum: 0 }),
  ]);

  const locales = localeClaims(posts);

  const body = [
    `# ${settings.studioName}`,
    '',
    `> ${settings.summary.hr} / ${settings.summary.en}`,
    '',
    `Croatian is the primary language and is served unprefixed; English mirrors it under \`/en/\`.`,
    locales.index,
    '',
    ...LOCALES.flatMap((locale) => section(locale, site, pages)),
    '## Machine-readable',
    '',
    `- [Sitemap index](${rootUrl('sitemap-index.xml', site)}): ${locales.sitemap}`,
    `- [robots.txt](${rootUrl('robots.txt', site)}): crawl policy.`,
    '',
    '## Contact',
    '',
    `- Studio: ${settings.studioName}, ${settings.address}`,
    `- Email: ${settings.email}`,
    `- Instagram: ${socialUrl(settings, 'instagram')}`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};

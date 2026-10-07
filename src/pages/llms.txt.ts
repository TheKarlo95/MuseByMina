import type { APIRoute } from 'astro';
import { LOCALES, localeUrl, type Locale } from '../lib/i18n';
import { getPageMeta, getSiteSettings, socialUrl, type PageMetaDoc } from '../lib/sanity';
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

  const [settings, pages] = await Promise.all([getSiteSettings(), getPageMeta()]);

  const body = [
    `# ${settings.studioName}`,
    '',
    `> ${settings.summary.hr} / ${settings.summary.en}`,
    '',
    `Croatian is the primary language and is served unprefixed; English mirrors it under \`/en/\`.`,
    `Every page exists in both locales with the same slug.`,
    '',
    ...LOCALES.flatMap((locale) => section(locale, site, pages)),
    '## Machine-readable',
    '',
    `- [Sitemap index](${rootUrl('sitemap-index.xml', site)}): every page in both locales, with hreflang alternates.`,
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

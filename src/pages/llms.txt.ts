import type { APIRoute } from 'astro';
import { LOCALES, localeUrl, type Locale } from '../lib/i18n';
import { PAGES, SITE_SUMMARY } from '../lib/pages';
import { rootUrl } from '../lib/site';
import { STUDIO } from '../lib/nav';

/**
 * A machine-readable index, in the llms.txt convention: an H1, a blockquote summary,
 * then `## ` sections of `- [Name](url): one-line description` links.
 *
 * Same reason as `robots.txt` for generating it: every URL is absolute and the origin
 * comes from `SITE`/`BASE`. Descriptions come from `src/lib/pages.ts`, which is also
 * what the pages themselves render, so this index cannot drift from the site — and
 * `test/seo.test.ts` holds that to account by comparing each line below against the
 * `<meta name="description">` in that route's built HTML, not against the registry.
 */
const LOCALE_HEADING: Record<Locale, string> = {
  hr: 'Hrvatski (hr)',
  en: 'English (en)',
};

/** Each page gets its own locale's wording — an index in one language is half an index. */
function section(locale: Locale, site: URL | undefined): string[] {
  const lines = [`## ${LOCALE_HEADING[locale]}`, ''];

  for (const page of PAGES) {
    const url = new URL(localeUrl(page.route, locale), site).href;
    lines.push(`- [${page.name[locale]}](${url}): ${page.description[locale]}`);
  }

  return [...lines, ''];
}

export const GET: APIRoute = ({ site }) => {
  if (!site) throw new Error('`site` is not configured — cannot build absolute URLs.');

  const body = [
    `# ${STUDIO.name}`,
    '',
    `> ${SITE_SUMMARY.hr} / ${SITE_SUMMARY.en}`,
    '',
    `Croatian is the primary language and is served unprefixed; English mirrors it under \`/en/\`.`,
    `Every page exists in both locales with the same slug.`,
    '',
    ...LOCALES.flatMap((locale) => section(locale, site)),
    '## Machine-readable',
    '',
    `- [Sitemap index](${rootUrl('sitemap-index.xml', site)}): every page in both locales, with hreflang alternates.`,
    `- [robots.txt](${rootUrl('robots.txt', site)}): crawl policy.`,
    '',
    '## Contact',
    '',
    `- Studio: ${STUDIO.name}, ${STUDIO.street}, ${STUDIO.city}`,
    `- Email: ${STUDIO.email}`,
    `- Instagram: ${STUDIO.instagram}`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};

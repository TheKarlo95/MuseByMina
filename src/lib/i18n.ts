export const LOCALES = ['hr', 'en'] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'hr';

export const LOCALE_LABEL: Record<Locale, string> = { hr: 'HR', en: 'EN' };
export const LOCALE_HTML_LANG: Record<Locale, string> = { hr: 'hr-HR', en: 'en' };

export function isLocale(v: string | undefined): v is Locale {
  return LOCALES.includes(v as Locale);
}

/** The locale a URL resolves to. `/en/schedule` → en; everything else → hr. */
export function localeFromPath(pathname: string): Locale {
  const seg = stripBase(pathname).split('/').filter(Boolean)[0];
  return isLocale(seg) ? seg : DEFAULT_LOCALE;
}

const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

function stripBase(pathname: string): string {
  if (BASE && pathname.startsWith(BASE)) return pathname.slice(BASE.length) || '/';
  return pathname;
}

/**
 * The route without base or locale prefix — `/MuseByMina/en/schedule` → `/schedule`.
 * This is what makes the language switcher land on the *equivalent* page rather than
 * bouncing to the homepage (design system §10).
 */
export function routeKey(pathname: string): string {
  const parts = stripBase(pathname).split('/').filter(Boolean);
  if (isLocale(parts[0])) parts.shift();
  return '/' + parts.join('/');
}

/**
 * Build an href for `route` in `locale`, including the deploy base path.
 *
 * Every page URL ends in a slash. The build writes `dist/en/index.html`, which a static
 * host serves at `/en/` and 301s to from `/en`, so the slashed spelling is the only one
 * that can be a canonical — and this function is where canonical, hreflang, `llms.txt`
 * and every nav link get theirs (MUSE-9). `trailingSlash: 'always'` in
 * `astro.config.mjs` is the other half; changing one without the other reopens the bug.
 *
 * A `#fragment` or `?query` is kept after the slash, not appended to it: `/#trial` is
 * `/MuseByMina/#trial`, never `/MuseByMina/#trial/`.
 */
export function localeUrl(route: string, locale: Locale): string {
  const mark = route.search(/[#?]/);
  const path = mark === -1 ? route : route.slice(0, mark);
  const suffix = mark === -1 ? '' : route.slice(mark);

  const segments = [
    ...(locale === DEFAULT_LOCALE ? [] : [locale]),
    ...path.split('/').filter(Boolean),
  ];

  return `${BASE}/${segments.map((segment) => `${segment}/`).join('')}${suffix}`;
}

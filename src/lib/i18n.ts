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

/** Build an href for `route` in `locale`, including the deploy base path. */
export function localeUrl(route: string, locale: Locale): string {
  const clean = '/' + route.split('/').filter(Boolean).join('/');
  const prefix = locale === DEFAULT_LOCALE ? '' : `/${locale}`;
  const path = `${prefix}${clean === '/' ? '' : clean}`;
  return `${BASE}${path}` || '/';
}

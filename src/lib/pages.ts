import type { Locale } from './i18n';

/**
 * Per-page metadata, one entry per route — not per locale page, because HR and EN
 * share slugs (see CLAUDE.md).
 *
 * This exists so the `<title>`/`<meta description>` a visitor gets and the one-line
 * description `llms.txt` publishes are the same string. Two copies would drift, and a
 * machine-readable index that disagrees with the page is worse than none.
 */
export interface PageMeta {
  /** Route without locale prefix or deploy base — `/`, `/schedule`. */
  route: string;
  /** Short label, used as link text in indexes. */
  name: Record<Locale, string>;
  /** The `<title>`. */
  title: Record<Locale, string>;
  /** One line. Serves as both `<meta name="description">` and the `llms.txt` entry. */
  description: Record<Locale, string>;
}

/** Indexable pages, in the order they should be listed. Error routes are not here. */
export const PAGES: PageMeta[] = [
  {
    route: '/',
    name: { hr: 'Početna', en: 'Home' },
    title: {
      hr: 'Muse by Mina — Plesni studio, Zagreb',
      en: 'Muse by Mina — Dance studio, Zagreb',
    },
    description: {
      hr: 'Plesni studio u Zagrebu. Bachata za odrasle — bez partnera, bez iskustva. Dođi na besplatni probni sat.',
      en: 'A dance studio in Zagreb. Bachata for adults — no partner, no experience needed. Come to a free trial class.',
    },
  },
  {
    route: '/schedule',
    name: { hr: 'Raspored', en: 'Schedule' },
    title: {
      hr: 'Raspored — Muse by Mina',
      en: 'Schedule — Muse by Mina',
    },
    description: {
      hr: 'Tjedni raspored bachata satova u Zagrebu — dan, vrijeme, razina i instruktor za tradicionalnu, modernu i sensual bachatu.',
      en: 'The weekly bachata class schedule in Zagreb — day, time, level and instructor for traditional, moderna and sensual bachata.',
    },
  },
];

export function pageMeta(route: string): PageMeta {
  const page = PAGES.find((p) => p.route === route);
  if (!page) throw new Error(`No page metadata for route "${route}".`);
  return page;
}

/** One-line summary of the studio, for the top of `llms.txt`. */
export const SITE_SUMMARY: Record<Locale, string> = {
  hr: 'Plesni studio u Zagrebu (Ilica 209) — bachata za odrasle, bez partnera i bez iskustva.',
  en: 'A dance studio in Zagreb, Croatia (Ilica 209) — bachata for adults, no partner and no experience needed.',
};

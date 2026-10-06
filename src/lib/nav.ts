import type { Locale } from './i18n';

export interface NavItem {
  /** Route without locale prefix, e.g. `/schedule`. */
  route: string;
  label: Record<Locale, string>;
  /** Shown only in the mobile panel — the desktop bar stays short. */
  mobileOnly?: boolean;
}

/**
 * One list, two information architectures.
 *
 * axcentdance.com's best idea: a single DOM list where CSS hides a few entries on
 * desktop and reveals them in the mobile panel. The desktop bar stays at four items;
 * the mobile panel is a complete index. No second menu to keep in sync.
 */
export const PRIMARY_NAV: NavItem[] = [
  { route: '/', label: { hr: 'Početna', en: 'Home' }, mobileOnly: true },
  { route: '/schedule', label: { hr: 'Raspored', en: 'Schedule' } },
  { route: '/pricing', label: { hr: 'Cijene', en: 'Pricing' } },
  { route: '/events', label: { hr: 'Događaji', en: 'Events' } },
  { route: '/aboutus', label: { hr: 'O nama', en: 'About' } },
  { route: '/contact', label: { hr: 'Kontakt', en: 'Contact' }, mobileOnly: true },
];

/** The single "More" disclosure. Trust content first, then services. */
export const MORE_NAV: NavItem[] = [
  { route: '/firstclass', label: { hr: 'Prvi sat', en: 'First class' } },
  { route: '/whatisbachata', label: { hr: 'Što je bachata', en: 'What is bachata' } },
  { route: '/etiquette', label: { hr: 'Bonton', en: 'Etiquette' } },
  { route: '/faq', label: { hr: 'Česta pitanja', en: 'FAQ' } },
  { route: '/gallery', label: { hr: 'Galerija', en: 'Gallery' } },
  { route: '/blog', label: { hr: 'Blog', en: 'Blog' } },
  { route: '/privatelessons', label: { hr: 'Privatni satovi', en: 'Private lessons' } },
  { route: '/weddingdance', label: { hr: 'Svadbeni ples', en: 'Wedding dance' } },
  { route: '/roomrental', label: { hr: 'Najam sale', en: 'Room rental' } },
];

export const CTA = {
  route: '/#trial',
  label: { hr: 'Besplatni probni sat', en: 'Free trial class' },
} as const;

export const STUDIO = {
  name: 'Muse by Mina',
  street: 'Ilica 209',
  city: 'Zagreb',
  country: { hr: 'Hrvatska', en: 'Croatia' },
  email: 'dancestudio.muse@gmail.com',
  maps: 'https://maps.app.goo.gl/PK2hgiB5ALUi93Er7',
  instagram: 'https://www.instagram.com/dancestudio.muse',
  facebook: 'https://www.facebook.com/profile.php?id=61592250952126',
  linktree: 'https://linktr.ee/dancestudio.muse',
} as const;

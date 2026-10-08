import type { StructureResolver } from 'sanity/structure';

import { SINGLETON_TYPES } from './schemaTypes';

/**
 * The Studio sidebar, written out rather than left to the default.
 *
 * The default lists every document type alphabetically by its schema name, which for
 * this project would open with "class" and bury "Postavke stranice" in the middle. Mina
 * is the only editor; the order she sees should be the order she works in — the weekly
 * schedule first, because that is the thing that actually changes, then the people and
 * the prices, then the occasional stuff, then the settings she will touch twice a year.
 */
export const structure: StructureResolver = (S) =>
  S.list()
    .title('Muse by Mina')
    .items([
      S.listItem()
        .title('Raspored')
        .child(
          S.documentTypeList('scheduleSlot')
            .title('Termini u rasporedu')
            .defaultOrdering([
              { field: 'day', direction: 'asc' },
              { field: 'start', direction: 'asc' },
            ]),
        ),
      S.documentTypeListItem('class').title('Satovi'),
      S.documentTypeListItem('instructor').title('Instruktori'),

      // The second singleton (MUSE-23). Same treatment as „Postavke stranice" below: a
      // fixed document id and no list in front of it, because a second „Priča studija"
      // would be a story the site never reads — `STUDIO_STORY_QUERY` pins this id.
      S.listItem()
        .title('Priča studija')
        .id('studioStory')
        .child(
          S.document()
            .schemaType('studioStory')
            .documentId('studioStory')
            .title('Priča studija'),
        ),
      S.divider(),
      S.documentTypeListItem('pricingTier').title('Cjenik'),
      S.documentTypeListItem('event').title('Događaji'),
      S.divider(),
      S.documentTypeListItem('galleryImage').title('Galerija'),
      S.documentTypeListItem('post').title('Objave'),
      S.documentTypeListItem('faq').title('Česta pitanja'),
      S.divider(),
      S.documentTypeListItem('page').title('Naslovi i opisi stranica'),

      // The singleton: one document, a fixed id, and no list in front of it. Without
      // this it is a document *type* with a "create new" button, and a second
      // "Postavke stranice" is a change that silently never reaches the site.
      S.listItem()
        .title('Postavke stranice')
        .id('siteSettings')
        .child(
          S.document()
            .schemaType('siteSettings')
            .documentId('siteSettings')
            .title('Postavke stranice'),
        ),
    ]);

/**
 * Keep the singleton out of the global "create new document" menu.
 *
 * Belt and braces with the fixed `documentId` above: the id makes a second copy
 * impossible to *reach*, this makes it impossible to *start*.
 */
export const singletonTypes: ReadonlySet<string> = new Set(SINGLETON_TYPES);

import type { SchemaTypeDefinition } from 'sanity';

import { danceClass, instructor, scheduleSlot, studioStory } from './documents/studio';
import { event, pricingTier } from './documents/offering';
import { faq, galleryImage, post } from './documents/media';
import { page, siteSettings } from './documents/site';
import { localeRichText, localeString, localeText } from './objects/locale';

/**
 * Every type the Studio knows about, in one array.
 *
 * `sanity schema extract` walks this, `sanity typegen generate` turns the result into
 * `src/lib/sanity/sanity.types.ts`, and `test/sanity.test.ts` asserts on the extracted
 * JSON — so adding a type here is the only step needed to make it real everywhere.
 */
export const schemaTypes: SchemaTypeDefinition[] = [
  // Shared objects first; documents reference them by name.
  localeString,
  localeText,
  localeRichText,

  // The studio
  studioStory,
  instructor,
  danceClass,
  scheduleSlot,

  // What it sells and when
  pricingTier,
  event,

  // Words and pictures
  galleryImage,
  post,
  faq,

  // Site-wide
  page,
  siteSettings,
];

/**
 * The singleton document types: one instance each, with a fixed id.
 *
 * `sanity.config.ts` reads this list to keep every one of them out of the "create new"
 * menu and out of the delete/duplicate actions, and `sanity/structure.ts` gives each one a
 * sidebar entry pinned to its own document id. Adding a name here is what makes a type a
 * singleton; the queries in `src/lib/sanity/queries.ts` then pin the same id, so a second
 * copy is a document the site never reads rather than a document it reads at random.
 */
export const SINGLETON_TYPES = ['siteSettings', 'studioStory'] as const;

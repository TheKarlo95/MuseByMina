import type { SchemaTypeDefinition } from 'sanity';

import { danceClass, instructor, scheduleSlot } from './documents/studio';
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

/** The singleton document types: one instance each, with a fixed id. */
export const SINGLETON_TYPES = ['siteSettings'] as const;

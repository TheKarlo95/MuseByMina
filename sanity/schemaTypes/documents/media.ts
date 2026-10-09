import { defineField, defineType } from 'sanity';

import { imageField } from '../objects/image';

export const galleryImage = defineType({
  name: 'galleryImage',
  title: 'Slika u galeriji',
  type: 'document',
  fields: [
    imageField({
      name: 'image',
      title: 'Slika',
      ratio: '1:1',
      purpose: 'Slika u galeriji i u Instagram traci.',
    }),
    defineField({
      name: 'caption',
      title: 'Potpis',
      type: 'localeString',
      description:
        'Neobavezno. Prikazuje se u povećanom prikazu, ne na mreži slika. Opis za ' +
        'čitače ekrana upisuje se iznad, u „Opis slike (alt)”.',
    }),
    defineField({
      name: 'takenAt',
      title: 'Datum snimanja',
      type: 'date',
      description: 'Neobavezno. Služi samo za redoslijed — najnovije ide prvo.',
    }),
    defineField({
      name: 'order',
      title: 'Redoslijed',
      type: 'number',
      description: 'Manji broj je gore. Ostavi prazno i slike idu po datumu snimanja.',
      validation: (Rule) => Rule.min(0).integer(),
    }),
  ],
  orderings: [
    {
      name: 'manual',
      title: 'Redoslijed na stranici',
      by: [
        { field: 'order', direction: 'asc' },
        { field: 'takenAt', direction: 'desc' },
      ],
    },
  ],
  preview: { select: { title: 'caption.hr', media: 'image', subtitle: 'takenAt' } },
});

/**
 * **A blog post: one document, one slug, one date — and one translation per language it
 * is written in** (MUSE-26).
 *
 * The per-locale grouping is argued at length beside `postTranslation` in
 * `sanity/schemaTypes/objects/locale.ts`; read that before changing the shape. The short
 * version: a post is the first content type on this site that will not exist in both
 * languages in practice, so the text is grouped per locale and a language left empty is a
 * language the post is not published in.
 *
 * Everything that is **not** text stays one value for the whole post, because it is one
 * post: the slug (so the two renderings share a URL shape, CLAUDE.md), `publishedAt` (so
 * the two indexes order identically), the cover image and the author.
 */
export const post = defineType({
  name: 'post',
  title: 'Objava',
  type: 'document',
  description:
    'Tekst na blogu — najave, osvrti, savjeti. Ispuni jezike na kojima je napisan; ' +
    'prazan jezik se ne objavljuje.',
  fields: [
    defineField({
      name: 'slug',
      title: 'Adresa (slug)',
      type: 'slug',
      description:
        'Zadnji dio adrese, npr. /blog/sto-obuci-na-prvi-sat. Oba jezika dijele isti ' +
        'slug. Adresa je trajna — nemoj je mijenjati nakon što je objava podijeljena.',
      options: {
        /**
         * The Croatian title, or the English one if there is no Croatian text.
         *
         * A function rather than `'hr.title'`, for the reason PR-shaped experience with
         * `event` found: a post written only in English has no `hr.title`, and a string
         * source would silently suggest nothing — leaving Mina to type a slug by hand on
         * the one field whose value is permanent. The fallback keeps the generated slug
         * available in both directions.
         */
        source: (doc) => {
          const text = doc as {
            hr?: { title?: unknown };
            en?: { title?: unknown };
          };
          const hr = text.hr?.title;
          const en = text.en?.title;
          return String((typeof hr === 'string' && hr) || (typeof en === 'string' && en) || '');
        },
        maxLength: 96,
      },
      validation: (Rule) => Rule.required().error('Slug je obavezan.'),
    }),
    defineField({
      name: 'publishedAt',
      title: 'Datum objave',
      type: 'datetime',
      description:
        'Objave s datumom u budućnosti se ne prikazuju — tako se tekst može pripremiti ' +
        'unaprijed. Stranica se gradi po rasporedu, pa se objava pojavi na prvoj ' +
        'izgradnji nakon tog datuma, ne u tu minutu.',
      validation: (Rule) => Rule.required().error('Datum objave je obavezan.'),
    }),
    /**
     * **Optional, which is a decision** (MUSE-26, and the same one as
     * `instructor.portrait`). No photography of this studio exists, so a required cover
     * image means the first post Mina writes cannot be published without a stock
     * photograph — a `required()` field satisfiable only by fiction, which is MUSE-36.
     * `PostPage.astro` and the index card both read "no cover" as a layout rather than a
     * gap.
     */
    imageField({
      name: 'coverImage',
      title: 'Naslovna slika',
      ratio: '16:9',
      purpose:
        'Neobavezno. Slika na popisu objava i na vrhu teksta. Bez nje objava izgleda ' +
        'kao tekst, što je u redu.',
      required: false,
    }),
    defineField({
      name: 'author',
      title: 'Autor',
      type: 'reference',
      to: [{ type: 'instructor' }],
      description: 'Ostavi prazno i objava je potpisana studijem.',
    }),
    // Croatian first, because Croatian sets the layout (design system §10).
    defineField({
      name: 'hr',
      title: 'Hrvatski',
      type: 'postTranslation',
      description: 'Ostavi prazno ako objava nije napisana na hrvatskom.',
    }),
    defineField({
      name: 'en',
      title: 'Engleski',
      type: 'postTranslation',
      description: 'Ostavi prazno ako objava nije napisana na engleskom.',
    }),
  ],
  orderings: [
    {
      name: 'newest',
      title: 'Najnovije prvo',
      by: [{ field: 'publishedAt', direction: 'desc' }],
    },
  ],
  /**
   * The list row, and the one place the "at least one language" rule reaches Mina before
   * the build does.
   *
   * Sanity cannot express "one of these two objects is required" — `required()` has no
   * one-of form and `Rule.custom` is unobservable in a test (`enums.ts`) — so
   * `decodePost` is what refuses it. A post with neither language filled in would
   * otherwise look like an ordinary row here; `BEZ TEKSTA` is in capitals for the reason
   * the build log's `FIXTURE` is.
   */
  preview: {
    select: {
      hrTitle: 'hr.title',
      enTitle: 'en.title',
      date: 'publishedAt',
      media: 'coverImage',
    },
    prepare: ({ hrTitle, enTitle, date, media }) => {
      const languages = [
        typeof hrTitle === 'string' && hrTitle.trim() !== '' ? 'HR' : undefined,
        typeof enTitle === 'string' && enTitle.trim() !== '' ? 'EN' : undefined,
      ].filter((tag): tag is string => tag !== undefined);
      const title =
        (typeof hrTitle === 'string' && hrTitle) ||
        (typeof enTitle === 'string' && enTitle) ||
        'Objava bez naslova';
      const when = typeof date === 'string' ? date.slice(0, 10) : 'bez datuma';

      return {
        title: String(title),
        subtitle:
          languages.length === 0 ? `${when} · BEZ TEKSTA` : `${when} · ${languages.join(' · ')}`,
        media,
      };
    },
  },
});

export const faq = defineType({
  name: 'faq',
  title: 'Često pitanje',
  type: 'document',
  fields: [
    defineField({
      name: 'question',
      title: 'Pitanje',
      type: 'localeString',
      description:
        'Napiši ga kako ga ljudi stvarno pitaju, npr. „Trebam li partnera?” — ne „Partnerstvo”.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'answer',
      title: 'Odgovor',
      type: 'localeText',
      description:
        'Kratko i konkretno. Prvi red mora sam odgovoriti na pitanje — ostatak je razrada.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'order',
      title: 'Redoslijed',
      type: 'number',
      description: 'Manji broj je gore. Najčešće pitanje ide prvo.',
      validation: (Rule) => Rule.min(0).integer(),
    }),
  ],
  orderings: [
    {
      name: 'manual',
      title: 'Redoslijed na stranici',
      by: [
        { field: 'order', direction: 'asc' },
        { field: 'question.hr', direction: 'asc' },
      ],
    },
  ],
  preview: { select: { title: 'question.hr', subtitle: 'answer.hr' } },
});

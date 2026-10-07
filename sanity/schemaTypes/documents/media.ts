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

export const post = defineType({
  name: 'post',
  title: 'Objava',
  type: 'document',
  description: 'Tekst na blogu — najave, osvrti, savjeti.',
  fields: [
    defineField({
      name: 'title',
      title: 'Naslov',
      type: 'localeString',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Adresa (slug)',
      type: 'slug',
      description: 'Zadnji dio adrese. Oba jezika dijele isti slug.',
      options: { source: 'title.hr', maxLength: 96 },
      validation: (Rule) => Rule.required().error('Slug je obavezan.'),
    }),
    defineField({
      name: 'publishedAt',
      title: 'Datum objave',
      type: 'datetime',
      description:
        'Objave s datumom u budućnosti se ne prikazuju — tako se tekst može pripremiti unaprijed.',
      validation: (Rule) => Rule.required().error('Datum objave je obavezan.'),
    }),
    defineField({
      name: 'excerpt',
      title: 'Kratki uvod',
      type: 'localeText',
      description:
        'Jedna do dvije rečenice. Prikazuje se na popisu objava i kao opis stranice ' +
        'kad se link dijeli.',
      validation: (Rule) => Rule.required(),
    }),
    imageField({
      name: 'coverImage',
      title: 'Naslovna slika',
      ratio: '16:9',
      purpose: 'Slika na popisu objava i na vrhu teksta.',
    }),
    defineField({
      name: 'body',
      title: 'Tekst',
      type: 'localeRichText',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'author',
      title: 'Autor',
      type: 'reference',
      to: [{ type: 'instructor' }],
      description: 'Ostavi prazno i objava je potpisana studijem.',
    }),
  ],
  orderings: [
    {
      name: 'newest',
      title: 'Najnovije prvo',
      by: [{ field: 'publishedAt', direction: 'desc' }],
    },
  ],
  preview: {
    select: { title: 'title.hr', date: 'publishedAt', media: 'coverImage' },
    prepare: ({ title, date, media }) => ({
      title: String(title ?? 'Objava bez naslova'),
      subtitle: typeof date === 'string' ? date.slice(0, 10) : 'bez datuma',
      media,
    }),
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

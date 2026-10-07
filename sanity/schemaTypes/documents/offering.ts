import { defineArrayMember, defineField, defineType } from 'sanity';

import { EVENT_TYPE_OPTIONS, PRICE_PERIOD_OPTIONS } from '../enums';
import { imageField } from '../objects/image';

export const pricingTier = defineType({
  name: 'pricingTier',
  title: 'Cjenik — paket',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Naziv paketa',
      type: 'localeString',
      description: 'Npr. „Jedan sat”, „Mjesečna karta”, „Paket od 10 satova”.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'priceEur',
      title: 'Cijena u eurima',
      type: 'number',
      description:
        'Samo broj, bez znaka €. Stranica sama piše „25 €” na hrvatskom i „€25” na ' +
        'engleskom — to je pravilo oblikovanja, ne tekst koji se upisuje.',
      validation: (Rule) =>
        Rule.required().min(0).max(10_000).error('Upiši cijenu kao broj, npr. 25.'),
    }),
    defineField({
      name: 'period',
      title: 'Na što se cijena odnosi',
      type: 'string',
      description:
        'Je li to cijena jednog sata, cijelog ciklusa, mjesečne karte ili paketa. ' +
        'Stranica sama ispisuje tu riječ na oba jezika.',
      options: { list: [...PRICE_PERIOD_OPTIONS], layout: 'radio' },
      validation: (Rule) => Rule.required().error('Odaberi na što se cijena odnosi.'),
    }),
    defineField({
      name: 'features',
      title: 'Što paket uključuje',
      type: 'array',
      of: [defineArrayMember({ type: 'localeString' })],
      description:
        'Po jedna stavka u redu, kratko. Prikazuju se kao popis s ✦ oznakama. ' +
        'Najmanje jedna stavka.',
      validation: (Rule) => Rule.required().min(1).error('Dodaj barem jednu stavku.'),
    }),
    defineField({
      name: 'featured',
      title: 'Istaknuti paket',
      type: 'boolean',
      description:
        'Označi najviše jedan. Istaknuti paket dobiva zlatni obrub i oznaku — ne zlatnu ' +
        'podlogu, koja bi preglasila cijeli red.',
      initialValue: false,
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'order',
      title: 'Redoslijed',
      type: 'number',
      description: 'Manji broj je lijevo. Obično od najjeftinijeg prema najskupljem.',
      validation: (Rule) => Rule.min(0).integer(),
    }),
  ],
  orderings: [
    {
      name: 'manual',
      title: 'Redoslijed na stranici',
      by: [
        { field: 'order', direction: 'asc' },
        { field: 'priceEur', direction: 'asc' },
      ],
    },
  ],
  preview: {
    select: { title: 'name.hr', price: 'priceEur', period: 'period' },
    prepare: ({ title, price, period }) => ({
      title: String(title ?? 'Paket bez naziva'),
      subtitle: `${String(price ?? '?')} € · ${String(period ?? '?')}`,
    }),
  },
});

export const event = defineType({
  name: 'event',
  title: 'Događaj',
  type: 'document',
  description: 'Party, workshop, bootcamp ili social — sve što nije redovni sat.',
  fields: [
    defineField({
      name: 'title',
      title: 'Naziv',
      type: 'localeString',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Adresa (slug)',
      type: 'slug',
      description: 'Zadnji dio adrese. Oba jezika dijele isti slug.',
      options: { source: 'title.hr', maxLength: 72 },
      validation: (Rule) => Rule.required().error('Slug je obavezan.'),
    }),
    defineField({
      name: 'eventType',
      title: 'Vrsta',
      type: 'string',
      description:
        'Određuje kako kartica izgleda i gdje se događaj prikazuje. Popis je fiksan.',
      options: { list: [...EVENT_TYPE_OPTIONS], layout: 'radio' },
      validation: (Rule) => Rule.required().error('Vrsta događaja je obavezna.'),
    }),
    defineField({
      name: 'startsAt',
      title: 'Početak',
      type: 'datetime',
      description:
        'Datum i vrijeme. Stranica sama piše „13. kolovoza 2026.” na hrvatskom i ' +
        '„13 August 2026” na engleskom.',
      validation: (Rule) => Rule.required().error('Početak je obavezan.'),
    }),
    defineField({
      name: 'endsAt',
      title: 'Kraj',
      type: 'datetime',
      description: 'Ostavi prazno ako kraj nije objavljen.',
    }),
    defineField({
      name: 'venue',
      title: 'Lokacija',
      type: 'string',
      description: 'Naziv i adresa, npr. „Muse by Mina, Ilica 209, Zagreb”.',
      validation: (Rule) => Rule.required().error('Lokacija je obavezna.'),
    }),
    defineField({
      name: 'description',
      title: 'Opis',
      type: 'localeText',
      validation: (Rule) => Rule.required(),
    }),
    imageField({
      name: 'image',
      title: 'Fotografija',
      ratio: '16:9',
      purpose: 'Slika na kartici događaja i na vrhu njegove stranice.',
    }),
    defineField({
      name: 'lineup',
      title: 'Gosti i DJ-evi',
      type: 'array',
      of: [defineArrayMember({ type: 'string' })],
      description: 'Imena, po jedno u redu. Imena se ne prevode, pa nisu dvojezična.',
    }),
    defineField({
      name: 'ticketUrl',
      title: 'Link za prijavu ili ulaznice',
      type: 'url',
      description:
        'Ostavi prazno i prikazuje se obrazac za kontakt umjesto gumba za ulaznice.',
      validation: (Rule) => Rule.uri({ scheme: ['http', 'https'] }),
    }),
  ],
  orderings: [
    { name: 'soonest', title: 'Najbliži prvi', by: [{ field: 'startsAt', direction: 'asc' }] },
    { name: 'newest', title: 'Najnoviji prvi', by: [{ field: 'startsAt', direction: 'desc' }] },
  ],
  preview: {
    select: { title: 'title.hr', startsAt: 'startsAt', media: 'image', kind: 'eventType' },
    prepare: ({ title, startsAt, media, kind }) => ({
      title: String(title ?? 'Događaj bez naziva'),
      subtitle: [kind, typeof startsAt === 'string' ? startsAt.slice(0, 10) : undefined]
        .filter(Boolean)
        .join(' · '),
      media,
    }),
  },
});

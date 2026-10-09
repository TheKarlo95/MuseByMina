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
    /**
     * **The slug is the event's permanent address, so the year is in it** (MUSE-24).
     *
     * `source: 'title.hr'` was the obvious thing and it has one failure, which is the
     * failure a studio actually hits: a party held every August produces the same slug
     * twice. Sanity's own uniqueness check then refuses the second one, and what Mina
     * reads is a complaint about a slug rather than about the year — so the way out is to
     * accept `noc-bachate-2`, which is then the URL of that edition for ever.
     *
     * So the source is a function that prefixes the year from `startsAt`:
     * `2026-noc-bachate`. Two editions differ without anybody thinking about it, and the
     * prefix reads as an edition rather than as a tie-break. The month and day are
     * deliberately not in it — an annual party that moves from August to September is the
     * same edition, and a slug carrying the day would look wrong the moment a date is
     * corrected.
     *
     * A slug is **generated once and then stored**, which is the whole reason it is this
     * and not a path derived at build time: `/events/<slug>/` has to keep resolving after
     * the event has passed (that is the archive's entire job), and a derived path would
     * move the moment Mina fixed a typo in the date. The year is therefore a *starting
     * suggestion* rather than a guarantee, and nothing downstream parses it — see the
     * slug section of `src/lib/events.ts`.
     *
     * The order matters in the Studio: this field sits above `startsAt`, so a new document
     * has no date when the title is typed. The `Generate` button is what Mina presses
     * after filling the form in, and the fallback keeps it useful before then rather than
     * producing `undefined-noc-bachate`.
     */
    defineField({
      name: 'slug',
      title: 'Adresa (slug)',
      type: 'slug',
      description:
        'Zadnji dio adrese, npr. „2026-noc-bachate”. Oba jezika dijele isti slug. ' +
        'Pritisni „Generate” nakon što upišeš naziv i datum i godina se doda sama — tako ' +
        'se isti party sljedeće godine ne tuče s ovogodišnjim. ' +
        'Adresa je trajna: stranica događaja ostaje na njoj i nakon što događaj prođe, pa ' +
        'je mijenjaj prije objave, ne poslije. ' +
        'Ne može biti „archive” — to je adresa arhive.',
      options: {
        maxLength: 72,
        // `doc` is Sanity's own `SanityDocument`, so every field is `unknown` and is read
        // as such. The alternative — a hand-written document type — would be a fourth
        // description of the `event` shape, and the one that nothing checks.
        source: (doc) => {
          const title = (doc.title as { hr?: string } | undefined)?.hr ?? '';
          const startsAt = typeof doc.startsAt === 'string' ? doc.startsAt : '';
          const year = startsAt.slice(0, 4);
          return /^\d{4}$/.test(year) ? `${year} ${title}` : title;
        },
      },
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

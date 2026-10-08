import { defineArrayMember, defineField, defineType } from 'sanity';

import {
  ADDRESS_PATTERN,
  ROUTE_OPTIONS,
  ROUTE_VALUES,
  SOCIAL_PLATFORM_OPTIONS,
  oneOf,
} from '../enums';
import { imageField } from '../objects/image';

/**
 * `page` holds the words `src/lib/pages.ts` used to hold, which is what made MUSE-20 a
 * copy rather than a redesign:
 *
 *     route       string, one of the routes the site serves
 *     name        Record<Locale, string>   → localeString
 *     title       Record<Locale, string>   → localeString
 *     description Record<Locale, string>   → localeString
 *
 * One document per *route*, not per locale page — HR and EN share slugs, and the whole
 * point of that registry is that the `<title>`/`<meta description>` a visitor gets and
 * the line `llms.txt` publishes are the same string. Two documents would reintroduce
 * the drift it exists to prevent.
 *
 * Which routes exist stays in code. `test/seo.test.ts` reads the page list off
 * `src/pages/` precisely so the index cannot claim a page the site does not serve, and
 * a CMS field is not allowed to undo that: `route` is a fixed list built from `ROUTES`,
 * offered as a dropdown **and** validated against the same list (MUSE-46). The two are
 * not the same thing — `options.list` is what Mina can pick from, `Rule.valid()` is what
 * the document is allowed to hold — and the gap between them is the shape this ticket
 * came from: a document can outlive the route it was written for, whatever the UI
 * offered on the day it was created. Sanity does infer a `valid()` rule from a `list`,
 * so the hole was narrower than it read; what it could not infer was a message that says
 * what is wrong, and `test/routes.test.ts` is what turns either into a tested claim.
 */
export const page = defineType({
  name: 'page',
  title: 'Stranica (naslov i opis)',
  type: 'document',
  description:
    'Naslov u kartici pretraživača i jedna linija opisa, po stranici. Ne uređuje sadržaj ' +
    'stranice — samo ono što Google i dijeljeni link pokazuju.',
  fields: [
    defineField({
      name: 'route',
      title: 'Stranica',
      type: 'string',
      description:
        'Koju stranicu ovaj zapis opisuje. Popis je fiksan: stranice postoje u kodu, ' +
        'a ovdje se upisuju samo njihove riječi.',
      options: { list: [...ROUTE_OPTIONS], layout: 'dropdown' },
      validation: (Rule) => [
        Rule.required().error('Odaberi stranicu.'),
        oneOf(Rule, ROUTE_VALUES).error(
          'Ova adresa nije među stranicama koje web objavljuje. Odaberi jednu s popisa — ' +
            'zapis za stranicu koja ne postoji ne prikazuje se nigdje.',
        ),
      ],
    }),
    defineField({
      name: 'name',
      title: 'Kratki naziv',
      type: 'localeString',
      description: 'Tekst linka u izborniku i u popisima, npr. „Raspored”.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'title',
      title: 'Naslov u kartici pretraživača',
      type: 'localeString',
      description:
        'Do oko 60 znakova, inače ga Google skrati. Konvencija na ovoj stranici je ' +
        '„Raspored — Muse by Mina”.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'description',
      title: 'Opis u jednoj liniji',
      type: 'localeString',
      description:
        'Jedna rečenica, 50–160 znakova. Ista ta rečenica ide i u `llms.txt`, pa mora ' +
        'opisivati stranicu, a ne studio općenito.',
      validation: (Rule) => Rule.required(),
    }),
  ],
  orderings: [{ name: 'route', title: 'Po adresi', by: [{ field: 'route', direction: 'asc' }] }],
  preview: { select: { title: 'name.hr', subtitle: 'route' } },
});

/**
 * The singleton. `sanity/structure.ts` gives it a fixed document id and a single entry
 * in the Studio sidebar, so there is no "new site settings" button to press twice.
 */
export const siteSettings = defineType({
  name: 'siteSettings',
  title: 'Postavke stranice',
  type: 'document',
  description: 'Podaci koji se ponavljaju na svakoj stranici — adresa, kontakt, društvene mreže.',
  fields: [
    defineField({
      name: 'studioName',
      title: 'Naziv studija',
      type: 'string',
      description: 'Nije dvojezično — ime studija je ime na oba jezika.',
      initialValue: 'Muse by Mina',
      validation: (Rule) => Rule.required().error('Naziv studija je obavezan.'),
    }),
    defineField({
      name: 'tagline',
      title: 'Slogan',
      type: 'localeString',
      description: 'Jedna linija ispod logotipa u podnožju.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'summary',
      title: 'Opis studija u jednoj rečenici',
      type: 'localeText',
      description:
        'Rečenica koja opisuje studio nekome tko o njemu ništa ne zna. Koristi se u ' +
        '`llms.txt` i kad se link dijeli.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'address',
      title: 'Adresa',
      type: 'string',
      description:
        'Ulica i broj, zarez, pa grad — „Ilica 209, Zagreb”. Podnožje je prikazuje u dva ' +
        'reda i samo dodaje državu, pa zarez mora biti točno jedan. Bez poštanskog broja.',
      initialValue: 'Ilica 209, Zagreb',
      validation: (Rule) =>
        Rule.required()
          .regex(ADDRESS_PATTERN, { name: 'ulica, grad' })
          .error('Upiši adresu kao „Ilica 209, Zagreb” — ulica, zarez, grad.'),
    }),
    defineField({
      name: 'email',
      title: 'E-mail studija',
      type: 'string',
      description: 'Adresa na koju stranica upućuje kad obrazac ne uspije poslati prijavu.',
      validation: (Rule) =>
        Rule.required().email().error('Upiši ispravnu e-mail adresu.'),
    }),
    /**
     * `phone` and `openingHours` are **optional**, decided in MUSE-20.
     *
     * Both were `required()`. Nothing on the site renders either one, and no real value
     * exists for either — so the only way to satisfy the Studio was to invent one, and
     * inventing content to satisfy a validator is exactly how the fabricated schedule
     * (MUSE-36) reached production. Whichever page first displays them can require them
     * then, with a real value in hand.
     */
    defineField({
      name: 'phone',
      title: 'Telefon',
      type: 'string',
      description:
        'U međunarodnom formatu, npr. „+385 1 234 5678”. Nije obavezno — ostavi prazno ' +
        'ako studio nema broj za javnost.',
    }),
    defineField({
      name: 'openingHours',
      title: 'Radno vrijeme',
      type: 'localeText',
      description:
        'Po jedan red po danu ili skupini dana. Raspored satova je zasebno. Nije ' +
        'obavezno — stranica ga trenutno ne prikazuje nigdje.',
    }),
    defineField({
      name: 'social',
      title: 'Društvene mreže',
      type: 'array',
      of: [
        defineArrayMember({
          type: 'object',
          name: 'socialLink',
          title: 'Profil',
          fields: [
            defineField({
              name: 'platform',
              title: 'Mreža',
              type: 'string',
              description: 'Određuje koja se ikona prikazuje u podnožju.',
              options: { list: [...SOCIAL_PLATFORM_OPTIONS], layout: 'dropdown' },
              validation: (Rule) => Rule.required().error('Odaberi mrežu.'),
            }),
            defineField({
              name: 'url',
              title: 'Link na profil',
              type: 'url',
              description:
                'Cijela adresa profila, s https:// na početku — kopiraj je iz adresne trake.',
              validation: (Rule) =>
                Rule.required()
                  .uri({ scheme: ['https'] })
                  .error('Upiši cijeli link, npr. https://instagram.com/musebymina.'),
            }),
          ],
          preview: { select: { title: 'platform', subtitle: 'url' } },
        }),
      ],
      description: 'Ikone u podnožju. Prikazuju se u redoslijedu u kojem su ovdje.',
    }),
    imageField({
      name: 'shareImage',
      title: 'Slika za dijeljenje linka',
      ratio: '16:9',
      /**
       * The second sentence is MUSE-69 and it is not decoration.
       *
       * The field now has a reader, and when it is empty the site publishes a composed
       * brand card — the logo on plum, laid out by design system §12. A fallback the
       * person filling the form does not know about is a fallback that reads as a bug:
       * she would upload a photograph, see the logo in a preview that had not refreshed,
       * and have no way to tell whether the field works. Saying it here is the only place
       * she will read it. See the long note in `src/lib/share-card.ts`.
       */
      purpose:
        'Slika koju pokazuju WhatsApp, Instagram i Facebook kad se link na stranicu podijeli. ' +
        'Ako je ostaviš praznu, prikazuje se logo studija na tamnoj podlozi — slika koju ovdje ' +
        'postaviš zamjenjuje ga svugdje.',
      required: false,
    }),
  ],
  preview: { select: { title: 'studioName', subtitle: 'address' } },
});

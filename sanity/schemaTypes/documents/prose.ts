import { defineArrayMember, defineField, defineType } from 'sanity';

import { ROUTE_OPTIONS, ROUTE_VALUES, oneOf } from '../enums';

/**
 * **A page that is prose: a heading, a line of lede, and sections of paragraphs.**
 *
 * Added for `/whatisbachata` (MUSE-65) and **designed for the other three trust pages**
 * MUSE-27 still holds — `/firstclass`, `/etiquette` and the written half of `/faq`. All
 * four are the same object: somebody arrives with a question, and the page answers it in
 * a few hundred words under subheadings. So this is one document type with a `route`,
 * not four singletons and not a `whatIsBachata`.
 *
 * Three decisions in here are worth not undoing.
 *
 * **It is keyed by `route`, exactly as `page` is.** The dropdown and its validation come
 * from `ROUTES` in `src/lib/pages.ts` (`../enums.ts`), so Mina can only describe a page
 * the site actually serves, and `src/lib/sanity/index.ts` fails the build naming the
 * route when the document for a routed prose page is missing. Which pages exist stays a
 * decision of `src/pages/`; Sanity owns a page's words and never its existence.
 *
 * **The body is an array of bilingual paragraphs, not `localeRichText`.** Portable Text
 * already exists in this schema — `post.body` — and nothing in the repository renders it:
 * it is deliberately typed as opaque `unknown[]` until a blog ticket picks a renderer. So
 * a prose page built on it would need a renderer written before it could show a sentence,
 * and would hand Mina headings, bold and links inside a paragraph where the design system
 * fixes the type scale and the frames anyway (§4, §9). An array of paragraphs is the
 * shape the page actually renders, and it makes a paragraph break a field rather than a
 * character inside a string — see the same argument, at length, on `studioStory.story`.
 *
 * **There is no image field, and that is the optional-field argument rather than an
 * omission.** No photography of this studio exists (§9's shoot direction describes a
 * session nobody has booked), so an image field here could only be filled by uploading
 * something that is not of this studio — which is how MUSE-36 happened, one validator at
 * a time. When a photograph exists, `imageField()` in `../objects/image.ts` is the only
 * way to add one: it is what carries `hotspot: true` and a required bilingual `alt`.
 *
 * One limit worth stating rather than discovering. A `prosePage` whose route is served but
 * whose page renders no prose publishes nothing and nothing says so — the mirror of
 * MUSE-46's inert `page` document, minus the half that can be detected. `getProsePage`
 * cannot see it (it is asked about one route at a time) and neither can the schema, since
 * "which routes have prose" is not written down anywhere and a fourth list of pages is
 * precisely what MUSE-46 argues against. The instrument that does reach it is the
 * dropdown, while Mina is typing. If the trust pages ever multiply enough for this to
 * matter, the honest fix is a reader that reads them all, not a fourth registry.
 */
export const prosePage = defineType({
  name: 'prosePage',
  title: 'Tekst stranice',
  type: 'document',
  description:
    'Tekst jedne stranice koja je samo tekst — npr. „Što je bachata”. Odaberi stranicu, ' +
    'upiši naslov, uvod i odjeljke. Sve što ovdje upišeš ide na stranicu bez objave koda.',
  fields: [
    defineField({
      name: 'route',
      title: 'Stranica',
      type: 'string',
      description:
        'Koja stranica dobiva ovaj tekst. Popis je zadan — stranice koje sajt stvarno ' +
        'ima. Jedna stranica, jedan zapis.',
      options: { list: [...ROUTE_OPTIONS], layout: 'dropdown' },
      validation: (Rule) => [
        Rule.required().error('Odaberi stranicu.'),
        oneOf(Rule, ROUTE_VALUES).error(
          'Ova adresa nije među stranicama koje web objavljuje, pa se tekst ne bi ' +
            'prikazao nigdje. Odaberi jednu s popisa.',
        ),
      ],
    }),
    defineField({
      name: 'heading',
      title: 'Naslov stranice',
      type: 'localeString',
      description:
        'Veliki naslov na vrhu stranice — ono što posjetitelj pročita prvo. Jedna linija. ' +
        'Pitanje smije ostati pitanje („Što je bachata?”).',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'lede',
      title: 'Uvod',
      type: 'localeText',
      description:
        'Jedan odlomak ispod naslova, dvije do tri rečenice. Ako netko pročita samo ' +
        'ovo i ode, to je ono što je saznao.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'sections',
      title: 'Odjeljci',
      type: 'array',
      description:
        'Stranica po odjeljcima: svaki ima svoj podnaslov i svoje odlomke. Dodaj novi ' +
        'odjeljak za svaku temu, ne nabijaj sve u jedan. Najmanje jedan odjeljak.',
      of: [
        defineArrayMember({
          name: 'prosePageSection',
          title: 'Odjeljak',
          type: 'object',
          description: 'Podnaslov i odlomci ispod njega.',
          fields: [
            defineField({
              name: 'heading',
              title: 'Podnaslov',
              type: 'localeString',
              description:
                'Kratak podnaslov, bez točke na kraju. Na stranici je to <h2> — ' +
                'čitači ekrana i tražilice njime listaju tekst.',
              validation: (Rule) => Rule.required(),
            }),
            defineField({
              name: 'body',
              title: 'Odlomci',
              type: 'array',
              description:
                'Po jedan odlomak u jednom polju — dodaj novi za svaki odlomak, ne ' +
                'stavljaj prazan red unutar jednog. Najmanje jedan.',
              of: [defineArrayMember({ type: 'localeText' })],
              validation: (Rule) => Rule.required().min(1).error('Dodaj barem jedan odlomak.'),
            }),
          ],
          preview: {
            select: { title: 'heading.hr' },
            prepare: ({ title }) => ({ title: String(title ?? 'Odjeljak bez naslova') }),
          },
        }),
      ],
      validation: (Rule) => Rule.required().min(1).error('Dodaj barem jedan odjeljak.'),
    }),
  ],
  preview: { select: { title: 'heading.hr', subtitle: 'route' } },
});

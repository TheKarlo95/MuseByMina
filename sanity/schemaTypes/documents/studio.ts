import { defineArrayMember, defineField, defineType } from 'sanity';

import {
  HH_MM_PATTERN,
  LEVEL_OPTIONS,
  STYLE_OPTIONS,
  WEEKDAY_OPTIONS,
} from '../enums';
import { imageField } from '../objects/image';

/**
 * The studio itself: how it started, who teaches, what is taught, and when.
 *
 * `class` and `scheduleSlot` are split because the existing `ClassEntry` in
 * `src/lib/schedule.ts` is a *rendering* of both: a class carries the style, level,
 * length, description and photograph; a slot carries a weekday and a start time. One
 * class usually runs on several days, and merging them would make Mina retype the
 * description once per weekly occurrence — which is how the Tuesday copy ends up
 * different from the Thursday copy.
 */

/**
 * **How the studio started. A singleton — one studio, one origin story** (MUSE-23).
 *
 * Three decisions in here are worth not undoing.
 *
 * **It is its own document, not fields on `siteSettings`.** `siteSettings` is the data
 * that repeats on every page — the address, the email, the social links — and all of it is
 * rendered by the footer. The origin story belongs to one page. Folding it in would put a
 * three-paragraph text field in the form Mina opens to fix a typo in the address.
 *
 * **`story` is an array of bilingual paragraphs, not one long text and not Portable
 * Text.** One `localeText` would make the paragraph breaks part of the string, which means
 * the page either renders them (`white-space: pre-line`, and a stray blank line becomes
 * layout) or silently loses them. Portable Text is the other direction and is worse here:
 * nothing in this repo renders it — `post.body` is deliberately typed as opaque
 * `unknown[]` until a blog ticket picks a renderer — so the first consumer would have to
 * build one, and Mina would get bold, headings and links she has no use for in a bio
 * paragraph. An array of paragraphs is the shape the page actually renders.
 *
 * **`foundedOn` is a date, and the site formats it.** World Bachata Meet Up's version of
 * this page works because the story is *dated*; a year in prose ages into „od 2019." being
 * retyped. It is stored as an ISO date because the rendering is per locale — HR
 * `13. kolovoza 2026.`, EN `13 August 2026` (design system §10) — and a formatting rule in
 * a CMS field is how you publish a date in the wrong language. Same argument as the time
 * format on `scheduleSlot.start` and the currency on `pricingTier.priceEur`.
 */
export const studioStory = defineType({
  name: 'studioStory',
  title: 'Priča studija',
  type: 'document',
  description:
    'Kako je studio počeo i tko ga vodi — tekst na stranici „O nama”. Jedan zapis, ne više njih.',
  fields: [
    defineField({
      name: 'heading',
      title: 'Naslov',
      type: 'localeString',
      description:
        'Naslov iznad priče, npr. „Kako je sve počelo”. Jedna linija, bez točke na kraju.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'foundedOn',
      title: 'Datum otvaranja studija',
      type: 'date',
      description:
        'Dan kad je studio počeo raditi. Stranica sama piše „13. kolovoza 2026.” na ' +
        'hrvatskom i „13 August 2026” na engleskom — format je pravilo oblikovanja, ne ' +
        'tekst koji se upisuje.',
      options: { dateFormat: 'DD.MM.YYYY.' },
      validation: (Rule) => Rule.required().error('Datum otvaranja je obavezan.'),
    }),
    defineField({
      name: 'story',
      title: 'Priča',
      type: 'array',
      of: [defineArrayMember({ type: 'localeText' })],
      description:
        'Po jedan odlomak u jednom polju — dodaj novi za svaki odlomak, ne stavljaj prazan ' +
        'red unutar jednog. Dvije do tri rečenice po odlomku. Piši kao da nekome ' +
        'objašnjavaš zašto si otvorila studio, bez nabrajanja titula. Najmanje jedan odlomak.',
      validation: (Rule) => Rule.required().min(1).error('Dodaj barem jedan odlomak.'),
    }),
  ],
  preview: { select: { title: 'heading.hr', subtitle: 'foundedOn' } },
});

export const instructor = defineType({
  name: 'instructor',
  title: 'Instruktor',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Ime',
      type: 'string',
      description:
        'Ime kako se piše na stranici. Nije dvojezično — ime je ime na oba jezika.',
      validation: (Rule) => Rule.required().error('Ime je obavezno.'),
    }),
    defineField({
      name: 'slug',
      title: 'Adresa (slug)',
      type: 'slug',
      description:
        'Zadnji dio adrese stranice, npr. „mina”. Hrvatska i engleska verzija dijele ' +
        'isti slug, pa prebacivanje jezika ostaje na istoj osobi. Klikni „Generate”.',
      options: { source: 'name', maxLength: 60 },
      validation: (Rule) => Rule.required().error('Slug je obavezan.'),
    }),
    defineField({
      name: 'role',
      title: 'Uloga',
      type: 'localeString',
      description: 'Jedna kratka linija ispod imena, npr. „Voditeljica studija”.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'bio',
      title: 'O instruktoru',
      type: 'localeText',
      description:
        'Nekoliko rečenica — koliko dugo pleše, što predaje, odakle je. Piši kao da ' +
        'odgovaraš nekome tko se tek upisuje, bez nabrajanja titula.',
      validation: (Rule) => Rule.required(),
    }),
    /**
     * **Optional, decided in MUSE-23, and the reason is the same one that made
     * `siteSettings.phone` optional in MUSE-20.**
     *
     * No photography of this studio exists. §9's shoot direction describes a session
     * nobody has booked, so the only way to satisfy a `required()` portrait is to upload
     * something that is not a portrait of that person — and inventing content to satisfy a
     * validator is exactly how the fabricated schedule (MUSE-36) reached production and
     * stayed there.
     *
     * `/aboutus` pays for this with a placeholder frame that reserves the real 3:4 box, so
     * the layout does not move on the day a photograph lands. Make it `required()` once
     * the photographs exist, not before.
     */
    imageField({
      name: 'portrait',
      title: 'Portret',
      ratio: '3:4',
      purpose:
        'Portret instruktora. Ovo je jedino mjesto na stranici gdje je jedna osoba sama u kadru ispravna. ' +
        'Nije obavezno — dok fotografije nema, stranica prikazuje prazan okvir iste veličine.',
      required: false,
    }),
    defineField({
      name: 'instagram',
      title: 'Instagram profil',
      type: 'url',
      description:
        'Cijela adresa profila, s https:// na početku — kopiraj je iz adresne trake. ' +
        'Ako je upišeš, ime instruktora na stranici „O nama” postaje link na profil. ' +
        'Ostavi prazno i ime je samo ime — link koji nikamo ne vodi je gori od imena.',
      validation: (Rule) =>
        Rule.uri({ scheme: ['https'] }).error(
          'Upiši cijeli link, npr. https://instagram.com/musebymina.',
        ),
    }),
    defineField({
      name: 'order',
      title: 'Redoslijed',
      type: 'number',
      description:
        'Manji broj je gore. Ostavi prazno i instruktor ide na kraj, abecedno.',
      validation: (Rule) => Rule.min(0).integer(),
    }),
  ],
  orderings: [
    {
      name: 'manual',
      title: 'Redoslijed na stranici',
      by: [
        { field: 'order', direction: 'asc' },
        { field: 'name', direction: 'asc' },
      ],
    },
  ],
  preview: { select: { title: 'name', subtitle: 'role.hr', media: 'portrait' } },
});

export const danceClass = defineType({
  // `class` is the name the site's own domain model uses (`ClassEntry`), and it is what
  // GROQ, the generated types and MUSE-20 will all read. Only the JS binding is renamed,
  // because `class` is a reserved word.
  name: 'class',
  title: 'Sat',
  type: 'document',
  fields: [
    defineField({
      name: 'name',
      title: 'Naziv sata',
      type: 'localeString',
      description:
        'Kako se sat zove na stranici, npr. „Bachata za početnike”. Razina i stil se ' +
        'prikazuju zasebno, pa ih ne treba ponavljati u nazivu.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'slug',
      title: 'Adresa (slug)',
      type: 'slug',
      description:
        'Zadnji dio adrese. Oba jezika dijele isti slug. Klikni „Generate” i ostavi kako ispadne.',
      options: { source: 'name.hr', maxLength: 72 },
      validation: (Rule) => Rule.required().error('Slug je obavezan.'),
    }),
    defineField({
      name: 'style',
      title: 'Stil',
      type: 'string',
      description:
        'Tradicionalna, moderna ili sensual. Popis je fiksan — stranica ima filtere i ' +
        'kartice vezane na te tri vrijednosti.',
      options: { list: [...STYLE_OPTIONS], layout: 'radio' },
      validation: (Rule) => Rule.required().error('Stil je obavezan.'),
    }),
    defineField({
      name: 'level',
      title: 'Razina',
      type: 'string',
      description:
        'Beginner, Intermediate ili Advanced. Namjerno engleski na oba jezika — tako ' +
        'piše i na rasporedu i na obrascu za probni sat.',
      options: { list: [...LEVEL_OPTIONS], layout: 'radio' },
      validation: (Rule) => Rule.required().error('Razina je obavezna.'),
    }),
    defineField({
      name: 'description',
      title: 'Opis',
      type: 'localeText',
      description:
        'Dvije do tri rečenice: što se na satu radi i za koga je. Ne piši imena figura — ' +
        'osobi koja se tek upisuje to ne znači ništa.',
      validation: (Rule) => Rule.required(),
    }),
    defineField({
      name: 'durationMin',
      title: 'Trajanje (minuta)',
      type: 'number',
      description: 'Redovni satovi su 60. Workshop može biti dulji.',
      initialValue: 60,
      validation: (Rule) =>
        Rule.required().integer().min(15).max(300).error('Trajanje je 15–300 minuta.'),
    }),
    defineField({
      name: 'instructor',
      title: 'Instruktor',
      type: 'reference',
      to: [{ type: 'instructor' }],
      description:
        'Tko redovno vodi ovaj sat. Pojedini termin može imati zamjenu — to se upisuje na terminu.',
      validation: (Rule) => Rule.required().error('Instruktor je obavezan.'),
    }),
    imageField({
      name: 'image',
      title: 'Fotografija sata',
      ratio: '4:5',
      purpose: 'Slika na kartici stila na početnoj stranici.',
    }),
    defineField({
      name: 'order',
      title: 'Redoslijed',
      type: 'number',
      description: 'Manji broj je gore.',
      validation: (Rule) => Rule.min(0).integer(),
    }),
  ],
  orderings: [
    {
      name: 'manual',
      title: 'Redoslijed na stranici',
      by: [
        { field: 'order', direction: 'asc' },
        { field: 'name.hr', direction: 'asc' },
      ],
    },
  ],
  preview: {
    select: { title: 'name.hr', style: 'style', level: 'level', media: 'image' },
    prepare: ({ title, style, level, media }) => ({
      title: String(title ?? 'Sat bez naziva'),
      subtitle: [style, level].filter(Boolean).join(' · '),
      media,
    }),
  },
});

export const scheduleSlot = defineType({
  name: 'scheduleSlot',
  title: 'Termin u rasporedu',
  type: 'document',
  description:
    'Jedan termin u tjednu: koji sat, koji dan, u koliko sati. Isti sat može imati više termina.',
  fields: [
    defineField({
      name: 'class',
      title: 'Sat',
      type: 'reference',
      to: [{ type: 'class' }],
      description: 'Odaberi sat. Stil, razina, trajanje i opis dolaze s njega.',
      validation: (Rule) => Rule.required().error('Termin mora pokazivati na sat.'),
    }),
    defineField({
      name: 'day',
      title: 'Dan',
      type: 'string',
      options: { list: [...WEEKDAY_OPTIONS], layout: 'dropdown' },
      validation: (Rule) => Rule.required().error('Dan je obavezan.'),
    }),
    defineField({
      name: 'start',
      title: 'Početak',
      type: 'string',
      description:
        'Vrijeme u 24-satnom formatu, npr. „19:00”. Tako piše i na hrvatskoj i na ' +
        'engleskoj stranici — raspored je stupac brojeva i mora se poravnati.',
      placeholder: '19:00',
      validation: (Rule) =>
        Rule.required()
          .regex(HH_MM_PATTERN, { name: 'HH:MM' })
          .error('Upiši vrijeme kao HH:MM u 24-satnom formatu, npr. 19:00 ili 09:30.'),
    }),
    defineField({
      name: 'instructor',
      title: 'Zamjena za instruktora',
      type: 'reference',
      to: [{ type: 'instructor' }],
      description:
        'Ostavi prazno i prikazuje se instruktor sa sata. Ispuni samo ako ovaj termin trajno vodi netko drugi.',
    }),
    defineField({
      name: 'active',
      title: 'Prikazuje se u rasporedu',
      type: 'boolean',
      description:
        'Isključi da termin privremeno skloniš s rasporeda bez brisanja — npr. za ljetnu pauzu.',
      initialValue: true,
      validation: (Rule) => Rule.required(),
    }),
  ],
  orderings: [
    {
      // Alphabetical on the day *key*, which is not week order — Monday-first ordering
      // is `groupByDay` in `src/lib/schedule.ts` and stays the page's job. This only
      // keeps the Studio list from being a shuffled pile.
      name: 'dayAndTime',
      title: 'Dan i vrijeme',
      by: [
        { field: 'day', direction: 'asc' },
        { field: 'start', direction: 'asc' },
      ],
    },
  ],
  preview: {
    select: { day: 'day', start: 'start', title: 'class.name.hr', active: 'active' },
    prepare: ({ day, start, title, active }) => ({
      title: `${String(day ?? '?')} ${String(start ?? '??:??')} — ${String(title ?? 'bez sata')}`,
      subtitle: active === false ? 'skriveno s rasporeda' : undefined,
    }),
  },
});

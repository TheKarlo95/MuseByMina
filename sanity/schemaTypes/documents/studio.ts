import { defineArrayMember, defineField, defineType } from 'sanity';

import { HH_MM_PATTERN, LEVEL_OPTIONS, WEEKDAY_OPTIONS } from '../enums';
import { imageField } from '../objects/image';

/**
 * The studio itself: how it started, who teaches, what is taught, and when.
 *
 * `class` and `scheduleSlot` are split because the existing `ClassEntry` in
 * `src/lib/schedule.ts` is a *rendering* of both: a class carries the level, length,
 * description, photograph and the people who teach it; a slot carries a weekday and a
 * start time. One class usually runs on several days, and merging them would make Mina
 * retype the description once per weekly occurrence — which is how the Tuesday copy ends
 * up different from the Thursday copy.
 *
 * MUSE-36 changed three things in here, all of them for the same reason: the real
 * timetable arrived and the invented one had shaped the schema.
 *
 *   - **`class.style` is gone.** The studio does not teach by style; the three values
 *     were invented with the thirteen invented rows.
 *   - **`instructors` is an array** on both `class` and `scheduleSlot`. Mina and Antonio
 *     teach every group class together, and lady styling — a class that is coming — is
 *     Mina alone. A single reference cannot say either thing.
 *   - **`description`, `image` and `bio` became optional.** A required field with no
 *     consumer and no real value can only be filled in with fiction, which is how the
 *     invented schedule got here; the same argument made `siteSettings.phone` optional
 *     in MUSE-20 and `instructor.portrait` optional in MUSE-23.
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
 *
 * **It stopped being `required()` in MUSE-60, and that is the optional-field argument
 * again rather than a relaxation.** MUSE-60 routed `/aboutus` with a placeholder story,
 * under one content rule: the placeholder may assert nothing checkable — no founding year,
 * no student count, no claim about anybody's training. No founding date for this studio is
 * written down anywhere, so a `required()` date could only have been satisfied by picking
 * one and publishing it as fact, which is exactly the move that made MUSE-36 Urgent. The
 * page omits the line when there is none, the way a card with no bio is a name and a role.
 * Put it back on the required list when Mina has said a date, not before.
 */
export const studioStory = defineType({
  name: 'studioStory',
  title: 'Priča studija',
  type: 'document',
  description:
    'Kako je studio počeo i tko ga vodi — tekst na stranici „O nama”. Jedan zapis, ne više ' +
    'njih. PRIVREMENI TEKST: naslov i odlomci koji su sada upisani su rezerva, napisani da ' +
    'stranica može izaći, i ne govore ništa o studiju što se može provjeriti. Prepiši ih ' +
    'svojim riječima kad budeš imala vremena — sve što tu upišeš ide na stranicu bez ' +
    'objave koda.',
  fields: [
    defineField({
      name: 'heading',
      title: 'Naslov',
      type: 'localeString',
      description:
        'Naslov iznad priče, npr. „Kako je sve počelo”. Jedna linija, bez točke na kraju. ' +
        'Ono što je sada upisano je privremeno — slobodno prepiši.',
      validation: (Rule) => Rule.required(),
    }),
    /**
     * **Optional as of MUSE-60.** See the long note above the type for why.
     *
     * In short: no founding date for this studio is recorded anywhere, and MUSE-60's
     * content rule is that the placeholder story asserts nothing checkable. A required
     * date could only be satisfied by inventing one.
     */
    defineField({
      name: 'foundedOn',
      title: 'Datum otvaranja studija',
      type: 'date',
      description:
        'Dan kad je studio počeo raditi. Stranica sama piše „13. kolovoza 2026.” na ' +
        'hrvatskom i „13 August 2026” na engleskom — format je pravilo oblikovanja, ne ' +
        'tekst koji se upisuje. Nije obavezno: dok datuma nema, stranica ga ne spominje. ' +
        'Nemoj upisivati približan datum — bolje prazno nego pogrešno.',
      options: { dateFormat: 'DD.MM.YYYY.' },
    }),
    defineField({
      name: 'story',
      title: 'Priča',
      type: 'array',
      of: [defineArrayMember({ type: 'localeText' })],
      description:
        'Po jedan odlomak u jednom polju — dodaj novi za svaki odlomak, ne stavljaj prazan ' +
        'red unutar jednog. Dvije do tri rečenice po odlomku. Piši kao da nekome ' +
        'objašnjavaš zašto si otvorila studio, bez nabrajanja titula. Najmanje jedan ' +
        'odlomak. PRIVREMENI TEKST: dva odlomka koja su sada upisana su rezerva — prepiši ' +
        'ih svojima.',
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
    /**
     * **Optional as of MUSE-36**, for the reason `portrait` below is.
     *
     * No bios exist. Mina and Antonio are real instructors with a real timetable and
     * nobody has written a paragraph about either of them, so a `required()` bio could
     * only be satisfied by writing one on their behalf — a sentence about how long a real
     * person has danced, invented to get past a validator. That is precisely the move
     * that put thirteen invented classes on the live site.
     *
     * `/aboutus` renders the paragraph when it is there and the name alone when it is
     * not. Make it `required()` once the bios exist, not before.
     */
    defineField({
      name: 'bio',
      title: 'O instruktoru',
      type: 'localeText',
      description:
        'Nekoliko rečenica — koliko dugo pleše, što predaje, odakle je. Piši kao da ' +
        'odgovaraš nekome tko se tek upisuje, bez nabrajanja titula. Nije obavezno — ' +
        'dok teksta nema, na stranici je samo ime i uloga.',
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
        'Kako se sat zove na stranici. Razina se prikazuje zasebno, pa je ne treba ' +
        'ponavljati u nazivu — redovni satovi se zovu samo „Bachata”, a nazivom se ' +
        'razlikuje ono što nije redovni sat, npr. „Lady styling”.',
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
      name: 'level',
      title: 'Razina',
      type: 'string',
      description:
        'Beginner, Improver, Intermediate ili Advanced. Namjerno engleski na oba ' +
        'jezika — tako piše i na rasporedu i na obrascu za probni sat.',
      options: { list: [...LEVEL_OPTIONS], layout: 'radio' },
      validation: (Rule) => Rule.required().error('Razina je obavezna.'),
    }),
    /**
     * **Optional as of MUSE-36.** Nothing renders it today.
     *
     * The three style cards on the homepage were its only consumer and they went with
     * `class.style`; the schedule row shows the name, the level, the teachers and the
     * length. So a `required()` description would be four paragraphs written to satisfy a
     * validator, about four classes whose only published facts are the ones above.
     * Whichever page first shows it — a class page, most likely — can require it then.
     */
    defineField({
      name: 'description',
      title: 'Opis',
      type: 'localeText',
      description:
        'Dvije do tri rečenice: što se na satu radi i za koga je. Ne piši imena figura — ' +
        'osobi koja se tek upisuje to ne znači ništa. Nije obavezno; raspored ga ne ' +
        'prikazuje.',
    }),
    defineField({
      name: 'durationMin',
      title: 'Trajanje (minuta)',
      type: 'number',
      description: 'Redovni satovi su 90. Workshop može biti dulji.',
      initialValue: 90,
      validation: (Rule) =>
        Rule.required().integer().min(15).max(300).error('Trajanje je 15–300 minuta.'),
    }),
    /**
     * **An array, because two people teach one class** (MUSE-36).
     *
     * Mina and Antonio lead every group class together, so a single reference could only
     * ever have published one of the two names — and the justification is not today's
     * data. Lady styling is a named, confirmed, coming class that Mina teaches alone, so
     * the number of instructors per class is already known to vary. A field whose shape
     * is known to be wrong is worth changing before it holds content, not after.
     *
     * Order matters: the page renders the names in the order they are listed here,
     * joined with „i" / "and" by `formatNames` in `src/lib/schedule.ts`.
     */
    defineField({
      name: 'instructors',
      title: 'Instruktori',
      type: 'array',
      of: [defineArrayMember({ type: 'reference', to: [{ type: 'instructor' }] })],
      description:
        'Tko redovno vodi ovaj sat. Dodaj sve koji ga vode — na stranici se ispisuju u ' +
        'ovom redoslijedu, npr. „Mina i Antonio”. Pojedini termin može imati zamjenu — ' +
        'to se upisuje na terminu.',
      validation: (Rule) =>
        Rule.required().min(1).error('Dodaj barem jednog instruktora.'),
    }),
    /**
     * **Optional as of MUSE-36**, for the reason `instructor.portrait` is: there is no
     * photography of this studio, and the one page that rendered a class photograph —
     * the homepage style cards — is gone with the styles.
     */
    imageField({
      name: 'image',
      title: 'Fotografija sata',
      ratio: '4:5',
      purpose:
        'Slika sata. Nije obavezno — dok fotografije nema, nijedna stranica je ne traži.',
      required: false,
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
    select: { title: 'name.hr', level: 'level', minutes: 'durationMin', media: 'image' },
    prepare: ({ title, level, minutes, media }) => ({
      title: String(title ?? 'Sat bez naziva'),
      // The level was one of two facts in the subtitle and the style was the other, so
      // with the style gone the length takes its place — otherwise four „Bachata” rows
      // would be told apart by one word.
      subtitle: [level, minutes ? `${String(minutes)} min` : undefined]
        .filter(Boolean)
        .join(' · '),
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
      description: 'Odaberi sat. Razina, trajanje i instruktori dolaze s njega.',
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
    /**
     * The override, an array for the same reason `class.instructors` is (MUSE-36).
     *
     * It replaces the class's list rather than adding to it — "this slot is taught by
     * these people" — because the case it exists for is one person standing in for two,
     * which an additive field could not express. Empty means "whoever teaches the class",
     * and `min(1)` keeps a half-finished edit from meaning "nobody".
     */
    defineField({
      name: 'instructors',
      title: 'Zamjena za instruktore',
      type: 'array',
      of: [defineArrayMember({ type: 'reference', to: [{ type: 'instructor' }] })],
      description:
        'Ostavi prazno i prikazuju se instruktori sa sata. Ispuni samo ako ovaj termin ' +
        'trajno vodi netko drugi — tada se prikazuju samo ovdje navedeni.',
      validation: (Rule) =>
        Rule.min(1).error('Ostavi prazno, ili dodaj barem jednog instruktora.'),
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

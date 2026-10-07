import { defineField } from 'sanity';

/**
 * Every image field in this Studio, built from one place.
 *
 * Two properties are load-bearing and neither is obvious from the Studio UI, which is
 * why no schema file is allowed to hand-roll an image field:
 *
 *   1. **`hotspot: true`, always.** The design system asks the same photograph for
 *      16:9 (hero, event), 4:5 (style card), 3:4 (instructor) and 1:1 (gallery,
 *      Instagram) — §9 rule 4 — and renders every one with `object-fit: cover`. Without
 *      a hotspot, Sanity centre-crops, so a 1:1 crop of a wide shot of two dancers'
 *      hands cuts the hands out. The alternative is Mina re-uploading and re-cropping
 *      per ratio, which she will not do, so the page gets whatever the centre of the
 *      frame happened to be. With a hotspot she marks the connection point once.
 *
 *   2. **`alt` is required and bilingual.** §9 rule 3 asks for descriptive Croatian alt
 *      text on meaningful imagery, and every image this schema models is meaningful —
 *      there is no decorative image field, so there is no case for an empty `alt`.
 *      Making it a `localeString` keeps the English page from narrating in Croatian.
 *
 * `test/sanity.test.ts` reads the extracted schema and fails if any image field anywhere
 * lacks either, so this helper is enforced rather than merely recommended.
 */

/** The ratios the design system crops from one upload (§9 rule 4). */
export type Ratio = '16:9' | '4:5' | '3:4' | '1:1';

/**
 * The art direction, in the one place Mina will actually read it.
 *
 * Field descriptions are her only instructions — there is no onboarding document she
 * will keep open while uploading — so the shoot direction from §9 lives here rather
 * than in a wiki.
 */
const DIRECTION = [
  'Što fotografirati: povezanost i pokret. Blizak kadar — ruke, točka kontakta,',
  'zajednička os. Topla, niska, usmjerena svjetlost. Zamućenje od pokreta je dobro,',
  'čita se kao ples, a ne kao greška.',
  'Što izbjegavati: osmijeh u objektiv, jednu osobu koja pozira sama (iznimka su',
  'portreti instruktora), jako ravno dnevno svjetlo, prazan studio, i sve gdje je tijelo',
  'tema umjesto plesa.',
].join(' ');

const HOTSPOT_NOTE = [
  'Nakon uploada klikni na sliku i povuci žarišnu točku na ono što se ne smije odrezati.',
  'Iz iste slike stranica reže više oblika, pa bez žarišne točke Sanity reže po sredini.',
].join(' ');

export interface ImageFieldOptions {
  name: string;
  title: string;
  /** Which crop this image is used at, so the note says what will be cut. */
  ratio: Ratio;
  /** What the picture is for, in one line. Prepended to the shared direction. */
  purpose: string;
  /** False only where the design system has a documented fallback. */
  required?: boolean;
}

export function imageField({
  name,
  title,
  ratio,
  purpose,
  required = true,
}: ImageFieldOptions) {
  return defineField({
    name,
    title,
    type: 'image',
    description: `${purpose} Prikazuje se u obliku ${ratio}. ${HOTSPOT_NOTE} ${DIRECTION}`,
    // The one setting this whole helper exists for. See the note above.
    options: { hotspot: true },
    fields: [
      defineField({
        name: 'alt',
        title: 'Opis slike (alt)',
        type: 'localeString',
        description:
          'Opiši što se na slici vidi, kratko, kao da je opisuješ nekome preko telefona. ' +
          'Čitači ekrana čitaju ovo naglas, a prikazuje se i kad se slika ne učita. ' +
          'Ne piši „fotografija” ni „slika” — to je već jasno.',
        validation: (Rule) => Rule.required().error('Opis slike je obavezan.'),
      }),
    ],
    validation: required
      ? (Rule) => Rule.required().error('Slika je obavezna.')
      : undefined,
  });
}

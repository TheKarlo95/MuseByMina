import { defineArrayMember, defineField, defineType } from 'sanity';

/**
 * Bilingual values: **two named fields, `hr` and `en`, inside one object.**
 *
 * This is the localisation decision of MUSE-19, and the one that is hard to reverse
 * once Mina has typed content into it. The two alternatives were considered and
 * rejected:
 *
 *   - **Document-level i18n** (`@sanity/document-internationalization`) makes one
 *     document per locale. The site's whole bilingual design is that HR and EN are two
 *     *renderings of one record*: they share slugs so the language switcher is a prefix
 *     swap (CLAUDE.md), and `/schedule` and `/en/schedule` are the same dataset twice
 *     (`src/lib/schedule.ts`). Two documents means two slugs that can drift, and
 *     "keep the slugs equal" becomes a rule a human has to remember rather than a
 *     shape the data cannot violate.
 *
 *   - **Field-level i18n** (`sanity-plugin-internationalized-array`) stores
 *     `[{_key: 'hr', value}, {_key: 'en', value}]`. A locale then becomes an array
 *     lookup — `title[_key == "hr"][0].value` in every projection — and a missing
 *     translation is an *absent array member*, which `required()` cannot express. So
 *     the Studio would let a half-translated string publish and the English page would
 *     render blank.
 *
 * Two named fields instead:
 *
 *   - they are exactly `Record<Locale, string>`, the shape this repo already uses for
 *     every bilingual value — `PageMeta.title`, `WEEKDAY_NAME`, `FORM_COPY`,
 *     `SITE_SUMMARY`. MUSE-20 is then a data move, not a reshape;
 *   - each locale is separately `required()`, so the Studio marks both and refuses to
 *     publish one without the other. A missing translation is caught by the person who
 *     can fix it, in the editor, rather than by a visitor;
 *   - the GROQ projection is the field name itself, and `sanity typegen` infers
 *     `{hr: string; en: string}` with no plugin-specific generics;
 *   - no plugin to version, and nothing extra in the Studio for Mina to understand.
 *
 * The cost is a third locale: that would be a schema change plus a content migration
 * rather than adding a string to a config array. Accepted deliberately — `LOCALES` in
 * `src/lib/i18n.ts` is a closed two-member set that routing, `hreflang`, the sitemap
 * and the language switcher are all built on, so a third language is a site-wide
 * project either way, not a content edit.
 */

/** Croatian is primary and sets the tone; English follows it (design system §10). */
const BOTH_REQUIRED =
  'Oba jezika su obavezna. Ako engleski izostane, build pada i promjena se ne objavi — ' +
  'bolje to nego engleska stranica s praznim mjestom.';

export const localeString = defineType({
  name: 'localeString',
  title: 'Tekst (HR / EN)',
  type: 'object',
  description: BOTH_REQUIRED,
  fields: [
    defineField({
      name: 'hr',
      title: 'Hrvatski',
      type: 'string',
      validation: (Rule) => Rule.required().error('Hrvatski tekst je obavezan.'),
    }),
    defineField({
      name: 'en',
      title: 'Engleski',
      type: 'string',
      validation: (Rule) => Rule.required().error('Engleski tekst je obavezan.'),
    }),
  ],
  // Croatian first, and shown expanded — a collapsed object hides the fact that there
  // is a second language to fill in, which is the whole failure this shape prevents.
  options: { collapsible: false, columns: 2 },
});

export const localeText = defineType({
  name: 'localeText',
  title: 'Dulji tekst (HR / EN)',
  type: 'object',
  description: BOTH_REQUIRED,
  fields: [
    defineField({
      name: 'hr',
      title: 'Hrvatski',
      type: 'text',
      rows: 4,
      validation: (Rule) => Rule.required().error('Hrvatski tekst je obavezan.'),
    }),
    defineField({
      name: 'en',
      title: 'Engleski',
      type: 'text',
      rows: 4,
      validation: (Rule) => Rule.required().error('Engleski tekst je obavezan.'),
    }),
  ],
  options: { collapsible: false },
});

/**
 * Formatted body copy, for the one place that needs paragraphs and links: a post.
 *
 * Deliberately short on options. No headings above H3, no image blocks, no custom
 * marks — the design system fixes type scale and image frames (§4, §9), and a
 * rich-text editor that can choose those is a way to break the page from the CMS.
 */
const blockMember = defineArrayMember({
  type: 'block',
  styles: [
    { title: 'Odlomak', value: 'normal' },
    { title: 'Podnaslov', value: 'h3' },
    { title: 'Citat', value: 'blockquote' },
  ],
  lists: [{ title: 'Lista', value: 'bullet' }],
  marks: {
    decorators: [
      { title: 'Podebljano', value: 'strong' },
      { title: 'Kurziv', value: 'em' },
    ],
    annotations: [
      {
        name: 'link',
        title: 'Link',
        type: 'object',
        fields: [
          defineField({
            name: 'href',
            title: 'Adresa (URL)',
            type: 'url',
            validation: (Rule) => Rule.required(),
          }),
        ],
      },
    ],
  },
});

export const localeRichText = defineType({
  name: 'localeRichText',
  title: 'Tekst s oblikovanjem (HR / EN)',
  type: 'object',
  description: BOTH_REQUIRED,
  fields: [
    defineField({
      name: 'hr',
      title: 'Hrvatski',
      type: 'array',
      of: [blockMember],
      validation: (Rule) => Rule.required().min(1).error('Hrvatski tekst je obavezan.'),
    }),
    defineField({
      name: 'en',
      title: 'Engleski',
      type: 'array',
      of: [blockMember],
      validation: (Rule) => Rule.required().min(1).error('Engleski tekst je obavezan.'),
    }),
  ],
  options: { collapsible: false },
});

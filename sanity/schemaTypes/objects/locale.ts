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
 *     every bilingual value — `WEEKDAY_NAME`, `LEVEL_NAME`, `FORM_COPY`. That is what
 *     made MUSE-20 a data move rather than a reshape;
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
 *
 * **Every member of this set is mapped explicitly by `src/lib/portable-text.ts`, and
 * anything outside it fails the build naming itself** (MUSE-26). That is the other half
 * of "deliberately short": the renderer is the closed set's enforcement, so widening
 * this list without widening the renderer is a red build rather than a block that
 * silently renders as a bare paragraph. Add a style here and the error tells you where
 * to add the rule.
 */
export const postBlockMember = defineArrayMember({
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

/**
 * **One post in one language — the shape that lets a post exist in only one** (MUSE-26).
 *
 * This is the one place on the site where the rule above is deliberately *not* applied,
 * and the inversion is the whole of MUSE-26's hardest question. Everything else here is
 * bilingual by construction because everything else is short: a page title, a class name,
 * a price's period, an instructor's role. A blog post is eight hundred words, and
 * **nobody writes eight hundred words twice.** A `localeRichText` whose two halves were
 * both `required()` — which is what `post.body` was until this ticket — makes a Croatian
 * post unpublishable until an English one exists, and the only way past a validator with
 * nothing to put in the field is to paste a machine translation. That is MUSE-36's shape:
 * a `required()` field with no real value can only be filled with fiction.
 *
 * So the grouping is inverted. Instead of three bilingual fields (`title`, `excerpt`,
 * `body`, each with an `hr` and an `en` half), a post carries **two optional
 * translations**, each one complete in itself. Three properties follow, and all three are
 * what the ticket asked for:
 *
 *   - **"Published in Croatian" is one fact, not three.** A locale is published iff its
 *     translation object exists, so the index, the detail page, the `hreflang` cluster,
 *     the sitemap and the language switcher all read the same thing. There is no state in
 *     which a post has an English title and no English body — see below.
 *   - **A half-translated post is refused by the Studio, naming the field.** `required()`
 *     inside this object fires only when the object is *present*, which was measured
 *     against Sanity's real validator rather than assumed: an absent `en` raises nothing,
 *     an `en` with a title and no body raises an error at `en.body`. That is exactly
 *     `localeString`'s rule one level up.
 *   - **Nothing renders nowhere.** Had `title` stayed a `localeString`, a Croatian-only
 *     post would carry an English title that no page on the site shows — a `required()`
 *     field whose value is unobservable, which is the condition under which a value nobody
 *     checks goes wrong. Here the title and the body are translated together or not at all.
 *
 * What this is **not** is document-level i18n, which the long note above rejects and
 * should go on rejecting. There is still exactly one `post` document per post: one slug,
 * one `publishedAt`, one cover image, one author. The two slugs that could drift do not
 * exist. What is per locale is only the text, which is the thing that genuinely is.
 *
 * The one rule Sanity cannot state is **"at least one of the two"** — `required()` has no
 * one-of form and `Rule.custom` is skipped unless the validation run is given a client
 * (see `sanity/schemaTypes/enums.ts`), which would make the guard real in the Studio and
 * unobservable in a test. So the build is the instrument: `decodePost` in
 * `src/lib/sanity/decode.ts` fails naming the document, and the post's own list preview
 * says „BEZ TEKSTA" so she can see it before publishing.
 */
export const postTranslation = defineType({
  name: 'postTranslation',
  title: 'Tekst objave (jedan jezik)',
  type: 'object',
  description:
    'Ispuni samo jezike na kojima objava postoji. Jezik koji ostaviš prazan se ne ' +
    'objavljuje: nema ga na popisu objava, nema svoju adresu i nije u sitemapu. ' +
    'Ako počneš jezik, moraš ga dovršiti — naslov, uvod i tekst.',
  fields: [
    defineField({
      name: 'title',
      title: 'Naslov',
      type: 'string',
      validation: (Rule) => Rule.required().error('Naslov je obavezan.'),
    }),
    defineField({
      name: 'excerpt',
      title: 'Kratki uvod',
      type: 'text',
      rows: 3,
      description:
        'Jedna do dvije rečenice. Prikazuje se na popisu objava i kao opis stranice ' +
        'kad se link dijeli.',
      validation: (Rule) => Rule.required().error('Kratki uvod je obavezan.'),
    }),
    defineField({
      name: 'body',
      title: 'Tekst',
      type: 'array',
      of: [postBlockMember],
      validation: (Rule) => Rule.required().min(1).error('Tekst je obavezan.'),
    }),
  ],
  options: { collapsible: true, collapsed: false },
});

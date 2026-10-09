/**
 * **Portable Text → HTML, at build time, with no construct left unmapped** (MUSE-26).
 *
 * `post.body` has been Portable Text since MUSE-19 and nothing rendered it. MUSE-65
 * checked, found no renderer, and deliberately built `prosePage` out of bilingual
 * paragraphs rather than becoming the first consumer. A blog cannot avoid it, so this is
 * that renderer, and it is the only one.
 *
 * ---------------------------------------------------------------------------------
 * ## Why this is not `@portabletext/to-html`
 *
 * It is in the lockfile — as a transitive dependency of `@portabletext/editor`, which is a
 * transitive dependency of `sanity`, which is a devDependency. So it resolves today and is
 * declared by nobody, which is the shape `styled-components` and `@sanity/validation` are
 * both declared to avoid: a *build-time* need met by a package a `sanity` minor bump may
 * stop installing. Taking it would mean a new `dependencies` entry, and that needs the
 * same kind of justification those two got. It does not have one, for two reasons, and the
 * second is the ticket's own acceptance criterion.
 *
 * **1. The mapping is a closed set of seven constructs.** `postBlockMember` in
 * `sanity/schemaTypes/objects/locale.ts` offers three block styles (`normal`, `h3`,
 * `blockquote`), one list (`bullet`), two decorators (`strong`, `em`) and one annotation
 * (`link`). That is what is below. 180 KB of library (72 + 84 + 24, measured in
 * `node_modules`) to map seven things is not a trade.
 *
 * **2. Its defaults publish the defect, and four of the five are silent.** Measured
 * against the installed 6.0.0 rather than read off the README:
 *
 *     unknown block `_type`   → renders `<div>Unknown block type "x", specify a …</div>`
 *     unknown block style     → renders `<p>` — silently
 *     unknown list            → renders `<ul>` — silently
 *     unknown list item       → renders `<li>` — silently
 *     unknown mark            → renders `<span class="unknown__pt__mark__x">` — silently
 *
 * So an `h1` style added to the schema becomes a paragraph, and an `image` block becomes a
 * sentence of English developer prose inside Mina's article. Getting a *failure* out of it
 * means overriding `unknownType`, `unknownBlockStyle`, `unknownList`, `unknownListItem`
 * and `unknownMark` — five slots you have to know exist, which is precisely the
 * "defence every future author has to remember to write" shape this repository has
 * watched fail three times (MUSE-48's `addInitScript`, MUSE-74's preload pair,
 * MUSE-35's hand-written font path).
 *
 * Here the unknown case is the **default**: every branch below is exhaustive and the
 * fall-through throws, naming the construct, the block and the document. The cost of the
 * decision is that the escaping is ours, which is why there is exactly one `escape` and
 * every text node and every attribute value goes through it.
 *
 * ## What it refuses, and why that is the answer to "a stray image or a wide code block"
 *
 * The ticket's third constraint is that nothing may break the 68ch measure or overflow at
 * 390px. An image block and a code block are the two things that would, and **neither can
 * reach a page**: the schema does not offer them, and if one arrives anyway — a hand-built
 * `sanity dataset import`, a widened schema, a copy-paste from another dataset — this
 * stops the build naming it. That is a stronger guarantee than a CSS rule, because a CSS
 * rule has to be right about a thing nobody has seen.
 *
 * What the CSS still has to handle is the content that *is* allowed and can still be
 * wide: a long unbroken URL as link text, a long Croatian compound. `PostPage.astro`
 * carries `overflow-wrap: anywhere` for exactly that, and `test/blog.test.ts` measures a
 * 200-character token at 390px.
 *
 * ## Determinism
 *
 * Two builds of one commit must be byte-identical (MUSE-20, `test/origin.test.ts`), so
 * nothing here may depend on iteration order of anything but the input: marks are sorted
 * into a fixed order before they are opened, and the sort is total.
 * ---------------------------------------------------------------------------------
 */

/** The three block styles `postBlockMember` offers, and the element each becomes. */
const BLOCK_STYLES: Readonly<Record<string, { open: string; close: string }>> = {
  normal: { open: '<p>', close: '</p>' },
  /**
   * **`h3` is the Portable Text *style name* and `<h2>` is the heading level** (§11.8:
   * "Display size never determines heading level").
   *
   * The schema offers one subheading, labelled „Podnaslov", and a post page's `<h1>` is
   * its title — so rendering the style's own name as an `<h3>` would skip a level on every
   * post with a subheading in it. `heading-order` is an axe rule and `npm run a11y` runs
   * with **no tag filter** since MUSE-75, so that is a red gate rather than a nicety; it
   * is also the exact defect MUSE-75 found on `/pricing`.
   *
   * Add an `h4` to the schema and this map has to grow an entry, which is a decision about
   * heading levels made in one place rather than inherited from a style name.
   */
  h3: { open: '<h2>', close: '</h2>' },
  /**
   * A paragraph inside the quote, because a `<blockquote>` takes flow content and a bare
   * run of text in one is not a paragraph as far as the document outline is concerned.
   */
  blockquote: { open: '<blockquote><p>', close: '</p></blockquote>' },
};

/** The one list `postBlockMember` offers. */
const LIST_STYLES: Readonly<Record<string, { open: string; close: string }>> = {
  bullet: { open: '<ul>', close: '</ul>' },
};

/** The two decorators `postBlockMember` offers. */
const DECORATORS: Readonly<Record<string, { open: string; close: string }>> = {
  strong: { open: '<strong>', close: '</strong>' },
  em: { open: '<em>', close: '</em>' },
};

/**
 * Every element this module can emit, so `test/blog.test.ts` can require the stylesheet to
 * have a rule for each one inside the prose container.
 *
 * Derived from the maps above rather than listed, because a list is exactly as current as
 * the last person who remembered it — and the failure it guards against is a block style
 * added here that the CSS then does not reach, which renders as unstyled browser default
 * inside an otherwise typeset article.
 */
export const PROSE_ELEMENTS: readonly string[] = [
  ...new Set(
    [
      ...Object.values(BLOCK_STYLES),
      ...Object.values(LIST_STYLES),
      ...Object.values(DECORATORS),
      { open: '<li>', close: '</li>' },
      { open: '<a>', close: '</a>' },
    ].flatMap(({ open }) => [...open.matchAll(/<(\w+)/g)].map(([, tag]) => tag!)),
  ),
].sort();

/**
 * The URL schemes a link may use.
 *
 * The Studio's `url` type already refuses everything else, and this is not redundant:
 * `npm run sanity:seed` imports NDJSON straight into the dataset without passing a single
 * Studio validator (MUSE-78), and the whole point of `decode.ts` is that the build does
 * not trust the dataset. A `javascript:` href rendered into a page is stored
 * cross-site-scripting, and it is the one failure here that is not merely ugly.
 *
 * A relative href is allowed and is not a scheme: an internal link is a legitimate thing
 * to write in a post, and `new URL(href, base)` is how one is told from a scheme.
 */
const LINK_SCHEMES: readonly string[] = ['http:', 'https:', 'mailto:', 'tel:'];

/**
 * The five characters that can change the meaning of markup, escaped once, here.
 *
 * `&` first, or the ampersands this introduces are escaped again. `'` and `"` are both
 * escaped even though only one of them ends an attribute, because the same function is
 * used for text and for attribute values and a function that is only safe in one position
 * is a function somebody will use in the other.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Where a failure happened, so the message reads like `decode.ts`'s. */
interface Frame {
  /** The document and field the blocks came from, e.g. `post-x` `body.hr`. */
  where: string;
  /** The block's `_key`, which is how it is found in the Studio. */
  key: string;
}

/**
 * The failure this module exists for: a construct with no rule.
 *
 * Three things in the message, for `decode.ts`'s reasons — what arrived, where it is, and
 * what the alternatives are — plus the one thing that is specific here: **where the rule
 * would go.** An unmapped block is not a content fault Mina can fix in the Studio; it is a
 * schema that grew an option the renderer does not know about, so the message names the
 * map rather than telling her to open the document.
 */
function unmapped(what: string, got: unknown, allowed: readonly string[], at: Frame): never {
  throw new Error(
    `Portable Text in "${at.where}" uses ${what} this site has no rule for: ` +
      `${JSON.stringify(got)} (block \`${at.key}\`). ` +
      `Mapped: ${allowed.map((name) => `\`${name}\``).join(', ')}. ` +
      `Every construct is mapped explicitly in \`src/lib/portable-text.ts\` and anything ` +
      `else stops the build here rather than rendering as an unstyled browser default or ` +
      `as a line of developer prose inside the article. If the schema gained this on ` +
      `purpose, add the rule — in \`src/lib/portable-text.ts\` and in the prose styles of ` +
      `\`src/components/PostPage.astro\` — and widen \`postBlockMember\` in ` +
      `\`sanity/schemaTypes/objects/locale.ts\` beside it.`,
  );
}

/** A field of an unknown object, or `undefined`. Mirrors `decode.ts`'s `read`. */
function read(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key] ?? undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** An annotation definition, keyed by the `_key` a span's `marks` entry names. */
type Annotations = ReadonlyMap<string, unknown>;

/**
 * One span's marks, as the tags to open and close around its text.
 *
 * **Annotations outermost, decorators inside, each group in a fixed order.** Portable Text
 * says nothing about nesting order — a span simply carries a set — so without a total
 * order the output of two builds could differ, which MUSE-20's byte-identical criterion
 * forbids. Rendering is unaffected either way: `<a><strong>x</strong></a>` and
 * `<strong><a>x</a></strong>` paint the same pixels.
 */
function marksOf(
  span: unknown,
  annotations: Annotations,
  at: Frame,
): { open: string; close: string } {
  const marks = read(span, 'marks');
  if (marks === undefined) return { open: '', close: '' };
  if (!Array.isArray(marks) || marks.some((mark) => typeof mark !== 'string')) {
    unmapped(
      'a `marks` list that is not a list of strings',
      marks,
      ['strong', 'em', 'link'],
      at,
    );
  }

  const annotated: { open: string; close: string }[] = [];
  const decorated: { open: string; close: string }[] = [];

  for (const mark of [...(marks as string[])].sort()) {
    const decorator = DECORATORS[mark];
    if (decorator !== undefined) {
      decorated.push(decorator);
      continue;
    }

    /**
     * Not a decorator, so it must name a `markDefs` entry. A mark that names nothing is
     * the Portable Text equivalent of MUSE-49's dangling reference — the annotation was
     * deleted and the span still points at it — and it is fatal for the same reason:
     * dropping the mark publishes the sentence without the link in it, which is true,
     * incomplete and invisible.
     */
    if (!annotations.has(mark)) {
      unmapped(
        'a mark naming an annotation that is not in `markDefs`',
        mark,
        [...Object.keys(DECORATORS), ...annotations.keys()],
        at,
      );
    }
    annotated.push(annotationTags(annotations.get(mark), at));
  }

  return {
    open: [...annotated, ...decorated].map(({ open }) => open).join(''),
    close: [...annotated, ...decorated]
      .map(({ close }) => close)
      .reverse()
      .join(''),
  };
}

/** The one annotation the schema offers: a link. */
function annotationTags(definition: unknown, at: Frame): { open: string; close: string } {
  const type = stringOf(read(definition, '_type'));
  if (type !== 'link') unmapped('an annotation type', type ?? definition, ['link'], at);

  const href = stringOf(read(definition, 'href'));
  if (href === undefined || href.trim() === '') {
    unmapped('a `link` annotation with no `href`', definition, ['link'], at);
  }

  return { open: `<a href="${escape(safeHref(href, at))}"${linkRel(href)}>`, close: '</a>' };
}

/**
 * The href, or a build failure naming the scheme.
 *
 * `new URL(href, base)` against a base that cannot appear in real content is how a scheme
 * is told from a relative path without parsing by hand: it resolves `/schedule/` and
 * `#section` against the base and leaves `mailto:` and `javascript:` as themselves.
 */
function safeHref(href: string, at: Frame): string {
  const trimmed = href.trim();
  let protocol: string;
  try {
    protocol = new URL(trimmed, 'https://relative.invalid/').protocol;
  } catch {
    unmapped('a `link` annotation whose `href` is not a URL', href, LINK_SCHEMES, at);
  }

  // A relative href resolves against the base, so its protocol is the base's. That is the
  // one case where the protocol being `https:` does not mean the author wrote a scheme —
  // and it is allowed either way, so the two need not be told apart.
  if (!LINK_SCHEMES.includes(protocol)) {
    unmapped(`a \`link\` annotation using the \`${protocol}\` scheme`, href, LINK_SCHEMES, at);
  }
  return trimmed;
}

/**
 * `rel`/`target` on an external link, and nothing on an internal one.
 *
 * `noopener` is the one that matters — a new tab can otherwise reach back through
 * `window.opener` — and `noreferrer` goes with it the way it does on `/events`' ticket
 * link. An internal link stays in the tab, because a site opening its own pages in new
 * tabs takes a decision away from the reader.
 */
function linkRel(href: string): string {
  const external = /^(?:https?:)?\/\//i.test(href.trim());
  return external ? ' target="_blank" rel="noopener noreferrer"' : '';
}

/** One block's text content, with its spans marked up. */
function inlineOf(block: unknown, at: Frame): string {
  const children = read(block, 'children');
  if (children === undefined) return '';
  if (!Array.isArray(children)) {
    unmapped('a `children` value that is not a list', children, ['span'], at);
  }

  return children
    .map((child) => {
      const type = stringOf(read(child, '_type'));
      /**
       * An inline object — a custom inline type — is the other thing Portable Text can
       * carry inside a block, and the schema offers none. It fails here rather than being
       * skipped: a skipped inline object is a sentence with a word missing.
       */
      if (type !== 'span') unmapped('an inline child type', type ?? child, ['span'], at);

      const text = stringOf(read(child, 'text')) ?? '';
      const { open, close } = marksOf(child, annotationsOf(block, at), at);
      return `${open}${escape(text)}${close}`;
    })
    .join('');
}

function annotationsOf(block: unknown, at: Frame): Annotations {
  const defs = read(block, 'markDefs');
  if (defs === undefined) return new Map();
  if (!Array.isArray(defs)) {
    unmapped('a `markDefs` value that is not a list', defs, ['link'], at);
  }
  return new Map(
    defs.map((definition) => [stringOf(read(definition, '_key')) ?? '', definition]),
  );
}

/** Is there anything for a reader to read in this block? */
function hasText(block: unknown): boolean {
  const children = read(block, 'children');
  if (!Array.isArray(children)) return false;
  return children.some((child) => (stringOf(read(child, 'text')) ?? '').trim() !== '');
}

/**
 * Render one locale's `post.body` to HTML.
 *
 * @param blocks Portable Text, as `decode.ts` hands it over — already proven to be a
 *   non-empty list of objects each carrying a `_type`.
 * @param where The document and field, e.g. ``post-abc `body.hr` ``, so a failure reads
 *   like one of `decode.ts`'s.
 */
export function renderPortableText(blocks: readonly unknown[], where: string): string {
  const out: string[] = [];
  /** The open `<ul>` nesting, as Portable Text's `level` — 1-based, absent means 1. */
  let openLists = 0;

  const closeListsTo = (depth: number): void => {
    while (openLists > depth) {
      out.push(LIST_STYLES.bullet!.close);
      openLists -= 1;
    }
  };

  for (const block of blocks) {
    const at: Frame = { where, key: stringOf(read(block, '_key')) ?? '(no _key)' };
    const type = stringOf(read(block, '_type'));

    /**
     * The guard the ticket is about. An `image` or a `code` block — the two things a post
     * is most likely to acquire and the two that would break the measure — lands here.
     */
    if (type !== 'block') {
      unmapped('a block type', type ?? block, ['block'], at);
    }

    const listItem = stringOf(read(block, 'listItem'));
    const list = listItem === undefined ? undefined : LIST_STYLES[listItem];
    if (listItem !== undefined && list === undefined) {
      unmapped('a list style', listItem, Object.keys(LIST_STYLES), at);
    }

    const style = stringOf(read(block, 'style')) ?? 'normal';
    const wrapper = listItem === undefined ? BLOCK_STYLES[style] : undefined;
    if (listItem === undefined && wrapper === undefined) {
      unmapped('a block style', style, Object.keys(BLOCK_STYLES), at);
    }

    /**
     * **Validation happens before the emptiness check, and the order is load-bearing.**
     *
     * The other way round — which is how this was first written — an unmapped construct
     * inside a block with no readable text is *skipped* rather than refused: a block whose
     * only child is an inline object has no `text` anywhere in it, so „is there anything
     * to read" answers no and the construct is dropped silently. That is the exact failure
     * this module exists to prevent, one level in, and it was caught by a test asserting
     * the refusal rather than by one asserting the rendering.
     */
    const inline = inlineOf(block, at);

    /**
     * An empty paragraph is a keystroke, not content, and it is dropped — deliberately,
     * and this is the one place this module changes what it was given. Rendering it emits
     * an element whose only effect is a doubled margin; for a heading or a list item it
     * emits an element with no accessible name, which is an axe `empty-heading` finding on
     * a page `npm run a11y` audits with no tag filter (MUSE-75).
     *
     * The list bookkeeping is deliberately untouched by a skip, so a blank line between
     * two bullets leaves one list rather than closing and reopening it.
     */
    if (!hasText(block)) continue;

    if (list !== undefined) {
      /**
       * `level` is Portable Text's own nesting depth and the block editor writes it the
       * moment somebody presses Tab inside a list. It is **not** an unmapped construct and
       * must not fail: refusing it would make an ordinary keystroke in the Studio a failed
       * deploy. So the depth is honoured by opening and closing real nested lists — which
       * is also what the design system's §11.8 outline rule needs, since a flat list of
       * visually indented items is a lie to a screen reader.
       */
      const level = read(block, 'level');
      if (
        level !== undefined &&
        (typeof level !== 'number' || !Number.isInteger(level) || level < 1)
      ) {
        unmapped(
          'a list `level` that is not a positive whole number',
          level,
          ['1', '2', '…'],
          at,
        );
      }
      const depth = typeof level === 'number' ? level : 1;

      closeListsTo(depth);
      while (openLists < depth) {
        out.push(list.open);
        openLists += 1;
      }
      out.push(`<li>${inline}</li>`);
      continue;
    }

    closeListsTo(0);
    out.push(`${wrapper!.open}${inline}${wrapper!.close}`);
  }

  closeListsTo(0);
  return out.join('');
}

/**
 * The same blocks as plain text.
 *
 * Not for the page — for a `<meta>` or a JSON-LD field that needs words rather than
 * markup. It goes through the same walk so that a construct this module cannot render
 * cannot be quietly *summarised* either: a description built from a body the page refuses
 * to publish would be the two surfaces disagreeing, which is MUSE-31's whole subject.
 */
export function portableTextToPlain(blocks: readonly unknown[], where: string): string {
  return renderPortableText(blocks, where)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import Blog from '../src/components/Blog.astro';
import PostPage from '../src/components/PostPage.astro';
import {
  BLOG_COPY,
  BLOG_ROUTE,
  assertPostSlugs,
  postMetaDescription,
  postMetaTitle,
  postUrl,
  postsIn,
  publishedIn,
  publishedLocales,
  reservedBlogSlugs,
} from '../src/lib/blog';
import { LOCALES, type Locale } from '../src/lib/i18n';
import { MORE_NAV, PRIMARY_NAV } from '../src/lib/nav';
import { ROUTES, reservedChildSlugs } from '../src/lib/pages';
import { PROSE_ELEMENTS, renderPortableText } from '../src/lib/portable-text';
import { MAX_WAIT_HOURS } from '../src/lib/rebuild';
import { ARTICLE_TYPE } from '../src/lib/structured-data';
import { decodePost, type Post } from '../src/lib/sanity/decode';
import { FIXTURE_ENV } from '../src/lib/sanity/fixture';
import { post as postSchema } from '../sanity/schemaTypes/documents/media';
import { PAGES_DEPLOY, basePath, buildSite, canonicalOf, type Build } from './helpers/build';
import { seedDocs } from './helpers/seed';
import { servePages, type Host } from './helpers/serve';
import {
  POSTS_RENDERED,
  POSTS_REWRITTEN,
  POST_NO_LANGUAGE,
  POST_RENDER_BOTH,
  POST_RENDER_EN_ONLY,
  POST_RENDER_HR_ONLY,
  POST_RENDER_SCHEDULED,
  POST_UNMAPPED_BLOCK,
  POSTS_DUPLICATE_SLUG,
  fixtureOf,
  type FixtureDoc,
} from './helpers/structural-content';

/**
 * **MUSE-26 — `/blog`, its posts, and the first Portable Text renderer on this site.**
 *
 * The ticket named three hard problems and this file is where all three are held to an
 * answer.
 *
 * **1. A post that exists in only one locale.** Decided: the other locale does not have
 * it — not listed, no URL, nothing linking to it — and **the sitemap, the `hreflang`
 * cluster and the locale switcher all read one fact** rather than three. `src/lib/blog.ts`
 * argues it, including what the alternative (list it and mark it) would have cost. What is
 * asserted here is that the three really do agree, against a real build holding a
 * Croatian-only post and an English-only one, so neither locale is privileged.
 *
 * **2. Portable Text, mapped explicitly, with no construct passing silently.** Every block
 * style, the list, both decorators and the link annotation have a rule; anything else is a
 * build failure naming itself, the block and where the rule goes. The teeth are the
 * *refusals*, so most of the renderer's assertions are about what it will not do — an
 * `image` block, an unmapped style, a `javascript:` href, a mark naming nothing.
 *
 * **3. The staleness window.** `publishedAt <= $now` is evaluated at build time, so a
 * scheduled post appears at the next build and the worst case is `MAX_WAIT_HOURS` — cited
 * by name, never written as a number, which is asserted below for MUSE-21's own reason.
 *
 * ---------------------------------------------------------------------------------
 * **One build, and why the rest is the container API and pure functions.**
 *
 * MUSE-68's heavyweight budget has no headroom, so this file performs exactly one
 * `astro build` and takes everything it can from Astro's container API, which compiles and
 * runs the real component against real props and costs nothing. The division is not
 * arbitrary: the container runs no asset pipeline and no router, so it cannot see CSS,
 * cannot see a URL, cannot see `getStaticPaths` and cannot see the sitemap. Those are
 * exactly what the one build is spent on. Everything else — the words, the branches, the
 * empty state, the renderer — is markup or arithmetic.
 *
 * What **no** build in this suite can see is layout: `npm run shots` is what measures 390px
 * for horizontal overflow, and `npm run a11y` audits both new routes in both themes off the
 * committed seed (where the blog is empty, which is the state it ships in). The long
 * unbroken token the ticket asks about is in the fixture and the rule that handles it is
 * asserted in the emitted CSS, which is the strongest statement available without a
 * browser launch this budget cannot afford.
 * ---------------------------------------------------------------------------------
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A document id and field path shaped the way the components pass one in. */
const WHERE = 'post-under-test `hr.body`';

/** One paragraph, as the block editor stores one. */
function block(fields: Record<string, unknown>): unknown {
  return { _type: 'block', _key: 'k', markDefs: [], ...fields };
}

function span(text: string, marks: string[] = []): unknown {
  return { _type: 'span', _key: 's', text, marks };
}

/** A decoded post, the way the read path hands one to a component. */
function decoded(doc: FixtureDoc): Post {
  return decodePost({
    _id: doc._id,
    slug: (doc.slug as { current: string }).current,
    publishedAt: doc.publishedAt,
    author: null,
    authorRef: null,
    coverImage: doc.coverImage === undefined ? null : coverOf(doc),
    hr: doc.hr ?? null,
    en: doc.en ?? null,
  });
}

function coverOf(doc: FixtureDoc): unknown {
  const image = doc.coverImage as Record<string, unknown>;
  return {
    assetId: (image.asset as { _ref: string })._ref,
    alt: image.alt,
    hotspot: image.hotspot,
    crop: image.crop,
  };
}

/** Markup with its tags stripped, for assertions about what a visitor reads. */
function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8230;|&hellip;/g, '…')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ----------------------------------------------------------- the Portable Text renderer */

describe('the renderer maps every construct the schema offers (AC2)', () => {
  it('sets a paragraph as a paragraph', () => {
    const html = renderPortableText(
      [block({ style: 'normal', children: [span('Hello')] })],
      WHERE,
    );
    expect(html).toBe('<p>Hello</p>');
  });

  it('renders the one subheading style as an `h2`, so no post skips a heading level', () => {
    /**
     * `h3` is Portable Text's *style name*; the heading level is a decision about the
     * document outline, and a post's `<h1>` is its title. Rendering the style's own name
     * would make every post with a subheading in it an axe `heading-order` finding —
     * which `npm run a11y` reports since MUSE-75 removed the tag filter, and which is
     * exactly the defect that ticket found on `/pricing`.
     */
    const html = renderPortableText([block({ style: 'h3', children: [span('Sub')] })], WHERE);
    expect(html).toBe('<h2>Sub</h2>');
    expect(html, 'the style name leaked into the heading level').not.toContain('<h3');
  });

  it('wraps a quote in a paragraph, because a blockquote takes flow content', () => {
    const html = renderPortableText(
      [block({ style: 'blockquote', children: [span('Quoted')] })],
      WHERE,
    );
    expect(html).toBe('<blockquote><p>Quoted</p></blockquote>');
  });

  it('groups consecutive list items into one list, and closes it', () => {
    const html = renderPortableText(
      [
        block({ listItem: 'bullet', children: [span('One')] }),
        block({ listItem: 'bullet', children: [span('Two')] }),
        block({ style: 'normal', children: [span('After')] }),
      ],
      WHERE,
    );
    expect(html).toBe('<ul><li>One</li><li>Two</li></ul><p>After</p>');
  });

  it('nests a Tab-indented list rather than flattening or refusing it', () => {
    /**
     * `level` is written by the block editor the moment somebody presses Tab inside a
     * list. Refusing it would make an ordinary keystroke in the Studio a failed deploy;
     * flattening it would show indentation to a sighted reader and a flat list to a screen
     * reader, which §11.8's outline rule is about.
     */
    const html = renderPortableText(
      [
        block({ listItem: 'bullet', level: 1, children: [span('Outer')] }),
        block({ listItem: 'bullet', level: 2, children: [span('Inner')] }),
        block({ listItem: 'bullet', level: 1, children: [span('Back')] }),
      ],
      WHERE,
    );
    expect(html).toBe('<ul><li>Outer</li><ul><li>Inner</li></ul><li>Back</li></ul>');
  });

  it('marks up both decorators and the link annotation', () => {
    const html = renderPortableText(
      [
        block({
          style: 'normal',
          markDefs: [{ _type: 'link', _key: 'L', href: 'https://example.invalid/x' }],
          children: [
            { _type: 'span', _key: 'a', text: 'bold', marks: ['strong'] },
            { _type: 'span', _key: 'b', text: 'italic', marks: ['em'] },
            { _type: 'span', _key: 'c', text: 'linked', marks: ['L'] },
          ],
        }),
      ],
      WHERE,
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain(
      '<a href="https://example.invalid/x" target="_blank" rel="noopener noreferrer">linked</a>',
    );
  });

  it('leaves an internal link in the tab, and guards an external one', () => {
    const internal = renderPortableText(
      [
        block({
          markDefs: [{ _type: 'link', _key: 'L', href: '/schedule/' }],
          children: [span('Schedule', ['L'])],
        }),
      ],
      WHERE,
    );
    expect(internal).toBe('<p><a href="/schedule/">Schedule</a></p>');
  });

  it('drops an empty paragraph, which is a keystroke rather than content', () => {
    // And a heading with no text, which would be an axe `empty-heading` finding.
    const html = renderPortableText(
      [
        block({ style: 'normal', children: [span('   ')] }),
        block({ style: 'h3', children: [] }),
        block({ style: 'normal', children: [span('Real')] }),
      ],
      WHERE,
    );
    expect(html).toBe('<p>Real</p>');
  });

  it('escapes text and attribute values, so a Studio field cannot become markup', () => {
    const html = renderPortableText(
      [
        block({
          markDefs: [{ _type: 'link', _key: 'L', href: 'https://example.invalid/?a=1&b="2"' }],
          children: [span('<script>alert(1)</script> & "quoted"', ['L'])],
        }),
      ],
      WHERE,
    );
    expect(html, 'a raw tag reached the page').not.toContain('<script');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    // The escaping must not double-escape its own ampersands.
    expect(html).not.toContain('&amp;amp;');
  });

  it('is deterministic, whatever order the marks arrive in', () => {
    // Two builds of one commit must be byte-identical (MUSE-20), and Portable Text says
    // nothing about the order of a span's marks.
    const of = (marks: string[]): string =>
      renderPortableText([block({ children: [span('x', marks)] })], WHERE);
    expect(of(['strong', 'em'])).toBe(of(['em', 'strong']));
    expect(of(['strong', 'em'])).toBe(of(['strong', 'em']));
  });

  it('lists every element it can emit, derived from the maps it branches on', () => {
    // `PROSE_ELEMENTS` is what `PostPage.astro`'s styles are checked against below, so a
    // hand-written list here would make that check as current as the last person who
    // remembered it.
    expect(PROSE_ELEMENTS).toEqual(['a', 'blockquote', 'em', 'h2', 'li', 'p', 'strong', 'ul']);
  });
});

describe('an unmapped construct fails the build, naming itself (AC2)', () => {
  /** Every refusal must say the same four things, so they are checked in one place. */
  function expectNamedFailure(run: () => unknown, needles: string[]): void {
    let message = '';
    try {
      run();
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, 'the construct was accepted').not.toBe('');
    for (const needle of [...needles, WHERE, 'src/lib/portable-text.ts']) {
      expect(message, `the failure does not name ${needle}`).toContain(needle);
    }
  }

  it('refuses a block type it has no rule for — an image, which the schema does not offer', () => {
    /**
     * The ticket's third constraint, answered structurally rather than with CSS: an image
     * block and a code block are the two things that would break the 68ch measure, and
     * neither can reach a page. The schema offers neither, and an import that bypasses the
     * Studio stops here.
     */
    expectNamedFailure(
      () => renderPortableText((POST_UNMAPPED_BLOCK.hr as { body: unknown[] }).body, WHERE),
      ['"image"', 'a block type', 'unmapped-image'],
    );
  });

  it('refuses a block style it has no rule for', () => {
    expectNamedFailure(
      () => renderPortableText([block({ style: 'h1', children: [span('Big')] })], WHERE),
      ['"h1"', 'a block style', 'normal'],
    );
  });

  it('refuses a list style it has no rule for', () => {
    expectNamedFailure(
      () => renderPortableText([block({ listItem: 'number', children: [span('One')] })], WHERE),
      ['"number"', 'a list style', 'bullet'],
    );
  });

  it('refuses an inline child that is not a span', () => {
    expectNamedFailure(
      () =>
        renderPortableText([block({ children: [{ _type: 'inlineThing', _key: 'i' }] })], WHERE),
      ['an inline child type', 'inlineThing'],
    );
  });

  it('refuses a mark naming an annotation that is not in `markDefs`', () => {
    /**
     * The Portable Text equivalent of MUSE-49's dangling reference: the annotation was
     * deleted and the span still points at it. Dropping the mark would publish the
     * sentence without the link in it — true, incomplete and invisible — so it is fatal
     * for the same reason a deleted author is.
     */
    expectNamedFailure(
      () => renderPortableText([block({ children: [span('x', ['gone'])] })], WHERE),
      ['"gone"', 'markDefs'],
    );
  });

  it('refuses an annotation type it has no rule for', () => {
    expectNamedFailure(
      () =>
        renderPortableText(
          [
            block({
              markDefs: [{ _type: 'internalRef', _key: 'L' }],
              children: [span('x', ['L'])],
            }),
          ],
          WHERE,
        ),
      ['an annotation type', 'internalRef'],
    );
  });

  it('refuses a `javascript:` href, which is the one failure that is not merely ugly', () => {
    /**
     * The Studio's `url` type refuses it; `npm run sanity:seed` imports NDJSON without
     * passing a single Studio validator (MUSE-78), and the whole point of this directory is
     * that the build does not trust the dataset. A `javascript:` href rendered into a page
     * is stored cross-site-scripting.
     */
    expectNamedFailure(
      () =>
        renderPortableText(
          [
            block({
              // eslint-disable-next-line no-script-url -- the string under test
              markDefs: [{ _type: 'link', _key: 'L', href: 'javascript:alert(1)' }],
              children: [span('tap', ['L'])],
            }),
          ],
          WHERE,
        ),
      ['javascript:', 'mailto:'],
    );
  });

  it('refuses a link with no href at all', () => {
    expectNamedFailure(
      () =>
        renderPortableText(
          [block({ markDefs: [{ _type: 'link', _key: 'L' }], children: [span('x', ['L'])] })],
          WHERE,
        ),
      ['no `href`'],
    );
  });

  it('says where the rule goes, rather than telling Mina to open the document', () => {
    // An unmapped block is a schema that grew an option the renderer does not know about,
    // so the message names the three files that have to move together.
    let message = '';
    try {
      renderPortableText([block({ style: 'h1', children: [span('x')] })], WHERE);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('src/components/PostPage.astro');
    expect(message).toContain('postBlockMember');
    expect(message).toContain('sanity/schemaTypes/objects/locale.ts');
  });
});

/* ----------------------------------------------------- the one-locale decision, in code */

describe('a post is published in the locales its text exists in (AC3)', () => {
  const both = decoded(POST_RENDER_BOTH);
  const hrOnly = decoded(POST_RENDER_HR_ONLY);
  const enOnly = decoded(POST_RENDER_EN_ONLY);

  it('answers the published locales in `LOCALES` order, Croatian first', () => {
    expect(publishedLocales(both)).toEqual(['hr', 'en']);
    expect(publishedLocales(hrOnly)).toEqual(['hr']);
    expect(publishedLocales(enOnly)).toEqual(['en']);
  });

  it('is one fact, read the same way by every surface', () => {
    // `publishedIn`, `postsIn` and `publishedLocales` are three readings of one field, and
    // the point of the decision is that they cannot disagree. Asserting them against each
    // other is what makes that structural rather than a comment.
    for (const post of [both, hrOnly, enOnly]) {
      for (const locale of LOCALES) {
        expect(publishedIn(post, locale)).toBe(publishedLocales(post).includes(locale));
        expect(postsIn([post], locale).length).toBe(publishedIn(post, locale) ? 1 : 0);
      }
    }
  });

  it('lists only this locale’s posts on an index', () => {
    const all = [both, hrOnly, enOnly];
    expect(postsIn(all, 'hr').map((post) => post.id)).toEqual([both.id, hrOnly.id]);
    expect(postsIn(all, 'en').map((post) => post.id)).toEqual([both.id, enOnly.id]);
  });
});

describe('the slug is the stored slug, and two posts may not share one (AC3)', () => {
  it('builds one URL per locale, slashed, from the one place that builds it', () => {
    expect(postUrl('a-post', 'hr')).toBe('/blog/a-post/');
    expect(postUrl('a-post', 'en')).toBe('/en/blog/a-post/');
  });

  it('fails naming both posts when two claim one URL', () => {
    let message = '';
    try {
      assertPostSlugs(POSTS_DUPLICATE_SLUG.map((doc) => decoded(doc)));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('post-duplicate-a');
    expect(message).toContain('post-duplicate-b');
    expect(message).toContain('post-twice');
    expect(message, 'the fix is not named').toContain('permanent address');
  });

  it('says nothing about slugs that are fine', () => {
    expect(() =>
      assertPostSlugs([POST_RENDER_BOTH, POST_RENDER_HR_ONLY].map((doc) => decoded(doc))),
    ).not.toThrow();
  });

  /**
   * **The reservation is derived, and it is tested against a route list that has a child**
   * (MUSE-26).
   *
   * `reservedBlogSlugs()` is `[]` today: `/blog` has no static child, so there is nothing
   * to reserve. A test that only asserted that would be the shape of green test this
   * repository keeps re-filing — it would pass with the derivation deleted. So the
   * derivation is exercised against a `/blog/archive` that does not exist yet, which is
   * what `reservedChildSlugs`' route-list parameter is for, and the real answer is pinned
   * separately so a *silent* reservation cannot appear either.
   */
  it('reserves the last segment of every static child, and nothing else', () => {
    const routes = [
      { route: '/blog', studioLabel: 'Blog' },
      { route: '/blog/archive', studioLabel: 'Arhiva' },
      { route: '/blog/tags/bachata', studioLabel: 'Too deep to be a child' },
      { route: '/schedule', studioLabel: 'Not under the prefix' },
    ];
    expect(reservedChildSlugs('/blog', routes)).toEqual(['archive']);
    expect(reservedChildSlugs('/schedule', routes)).toEqual([]);
  });

  it('reserves nothing today, and says so rather than implying a collision', () => {
    expect(reservedBlogSlugs()).toEqual([]);

    let message = '';
    try {
      assertPostSlugs(POSTS_DUPLICATE_SLUG.map((doc) => decoded(doc)));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message, 'the message invents a reserved slug').toContain('is reserved today');
  });
});

describe('a post page describes itself without a `page` document', () => {
  it('names the post beside the studio, in the separator the site already uses', () => {
    expect(postMetaTitle('Naslov', 'Muse by Mina')).toBe('Naslov — Muse by Mina');
  });

  it('cuts a long excerpt at a word, and leaves a short one alone', () => {
    expect(postMetaDescription('  Kratko.  ')).toBe('Kratko.');
    const long = `${'riječ '.repeat(60)}end`;
    const cut = postMetaDescription(long);
    expect(cut.length).toBeLessThanOrEqual(161);
    expect(cut.endsWith('…')).toBe(true);

    // „Cut at a word" stated as what it means: the kept text is a prefix of the original
    // and the original continues with a space, so no word was halved. Asserting that the
    // character before the ellipsis is whitespace would be the opposite claim — the cut
    // *removes* the space along with the partial word.
    const kept = cut.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(long.charAt(kept.length)).toBe(' ');
  });

  it('flattens the line breaks a `text` field carries', () => {
    expect(postMetaDescription('One.\n\nTwo.')).toBe('One. Two.');
  });
});

describe('the staleness window is derived from the rebuild cadence, never written down', () => {
  const BLOG = readFileSync(join(ROOT, 'src/lib/blog.ts'), 'utf8');

  it('cites the constant by name in the file that explains the window', () => {
    expect(BLOG).toContain('MAX_WAIT_HOURS');
  });

  it('writes no hour count of its own beside it', () => {
    /**
     * MUSE-21's rule: the cadence lives in `src/lib/rebuild.ts` and everything else cites
     * it. A sentence naming a duration goes stale the day the cron changes, and the badge
     * that promised Mina a *clock time* was already wrong for half the year.
     */
    const offenders = BLOG.split('\n')
      .map((line, index) => ({ line, at: index + 1 }))
      .filter(({ line }) => /\b\d+\s*(?:hours?|sati|sata)\b/i.test(line));
    expect(offenders.map(({ at, line }) => `src/lib/blog.ts:${at}: ${line.trim()}`)).toEqual(
      [],
    );
  });

  it('has a window at all, so the citation is not decorative', () => {
    expect(MAX_WAIT_HOURS).toBeGreaterThan(0);
  });
});

describe('the chrome is code and names no post', () => {
  it('puts no post, date or author of its own in the copy', () => {
    /**
     * `BLOG_COPY` is interface chrome in code, which is allowed — and the line between
     * chrome and content is that chrome names no post, no date and no person. A „kako
     * izgleda prvi sat" example title in the lede would pass every other test here.
     */
    const copy = Object.values(BLOG_COPY).flatMap((locale) => Object.values(locale));
    expect(copy.length).toBeGreaterThan(10);
    for (const line of copy) {
      expect(line, line).not.toMatch(/\b(?:19|20)\d\d\b/);
      expect(line, line).not.toMatch(/\d{1,2}[:.]\d\d/);
      expect(line, line).not.toMatch(/Mina|Antonio|Ilica/i);
    }
  });

  it('promises nothing about posts nobody has written', () => {
    // „ništa za sada" and „provjeri kasnije" are claims about future content, which is
    // MUSE-36's mistake in a smaller font. The empty state states a fact and offers a door.
    for (const locale of LOCALES) {
      const t = BLOG_COPY[locale];
      expect(`${t.emptyHeading} ${t.emptyBody}`).not.toMatch(
        /za sada|kasnije|soon|yet|coming|watch this/i,
      );
    }
  });
});

describe('`/blog` is declared everywhere a route has to be', () => {
  it('routes the index, and only the index', () => {
    const declared = ROUTES.map(({ route }) => route);
    expect(declared).toContain(BLOG_ROUTE);
    expect(
      declared.filter((route) => route.startsWith(`${BLOG_ROUTE}/`)),
      'a post page was declared as a route',
    ).toEqual([]);
  });

  it('seeds a `page` document for it, with the label the Studio dropdown shows', () => {
    const document = seedDocs().find((doc) => doc.route === BLOG_ROUTE);
    expect(document, 'no `page` document for /blog in the seed').toBeDefined();
    expect(document?._type).toBe('page');
    expect(ROUTES.find(({ route }) => route === BLOG_ROUTE)?.studioLabel).toBe('Blog');
  });

  it('puts the index in the More disclosure and not in the desktop bar', () => {
    // The bar is budgeted at four links plus the disclosure (`test/nav.test.ts`), and a
    // blog is not where a returning visitor is going.
    expect(MORE_NAV.map(({ route }) => route)).toContain(BLOG_ROUTE);
    expect(PRIMARY_NAV.map(({ route }) => route)).not.toContain(BLOG_ROUTE);
  });

  it('pins `BlogPosting` as the article type, because an unknown `@type` fails silently', () => {
    // MUSE-31's `DanceSchool` lesson: schema.org answers an unknown type with a node on
    // which nothing is recognised, and the markup still looks right in the source.
    expect(ARTICLE_TYPE).toBe('BlogPosting');
  });
});

/* -------------------------------------------------------------------------- the decoder */

describe('the decoder refuses what no page could render (AC3, MUSE-49)', () => {
  function failureOf(row: unknown): string {
    try {
      decodePost(row);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('decodePost accepted a row it should have refused.');
  }

  it('refuses a post with neither language, naming the document', () => {
    /**
     * The one rule the Studio cannot state: `required()` has no „one of these two" form and
     * `Rule.custom` is skipped unless the validation run is given a client
     * (`sanity/schemaTypes/enums.ts`). A post with neither language renders nowhere — no
     * index lists it, no URL resolves to it — which is precisely the silent nothing
     * `decode.ts` exists to refuse.
     */
    const message = failureOf({
      _id: POST_NO_LANGUAGE._id,
      slug: 'post-no-language',
      publishedAt: POST_NO_LANGUAGE.publishedAt,
      author: null,
      authorRef: null,
      coverImage: null,
      hr: null,
      en: null,
    });
    expect(message).toContain('post-no-language');
    expect(message).toContain('at least one language');
  });

  it('refuses a half-translated language, naming the field inside it', () => {
    const message = failureOf({
      _id: 'post-half',
      slug: 'post-half',
      publishedAt: POST_RENDER_BOTH.publishedAt,
      author: null,
      authorRef: null,
      coverImage: null,
      hr: { title: 'Naslov', excerpt: 'Uvod.', body: [] },
      en: null,
    });
    expect(message).toContain('post-half');
    expect(message).toContain('hr.body');
  });

  it('refuses a `publishedAt` that is not a UTC ISO instant', () => {
    /**
     * Two silent failures behind a loose datetime, and neither is a missing field: `Intl`
     * renders an unparseable date as the words "Invalid Date", and „is this published yet"
     * is decided by comparing strings in GROQ — so a value carrying `+02:00` is the same
     * instant, a different string, and sorts into the wrong half.
     */
    const message = failureOf({
      _id: 'post-offset',
      slug: 'post-offset',
      publishedAt: '2026-08-13T19:00:00+02:00',
      author: null,
      authorRef: null,
      coverImage: null,
      hr: POST_RENDER_BOTH.hr,
      en: null,
    });
    expect(message).toContain('publishedAt');
    expect(message).toContain('UTC ISO instant');
  });

  it('refuses a deleted author, naming the document, the field and the `_ref`', () => {
    /**
     * MUSE-49, from the blog's side. `author->name` over a deleted instructor answers
     * `null`, which is indistinguishable from „nobody was named" — the field's own
     * documented default — so the post published **unsigned** with nothing said. The
     * `_ref` is the evidence, and the pair must stay a pair.
     */
    const message = failureOf({
      _id: 'post-dangling',
      slug: 'post-dangling',
      publishedAt: POST_RENDER_BOTH.publishedAt,
      author: null,
      authorRef: 'instructor-that-was-deleted',
      coverImage: null,
      hr: POST_RENDER_BOTH.hr,
      en: null,
    });
    expect(message).toContain('post-dangling');
    expect(message).toContain('author');
    expect(message).toContain('instructor-that-was-deleted');
    expect(message, 'clearing the field is a valid fix for an optional reference').toContain(
      'clearing it',
    );
  });

  it('still publishes a post that simply has no author', () => {
    // The control: „fails whenever the byline is empty" would be the same bug from the
    // other side, and the Studio field says „Ostavi prazno i objava je potpisana studijem".
    const post = decodePost({
      _id: 'post-unsigned',
      slug: 'post-unsigned',
      publishedAt: POST_RENDER_BOTH.publishedAt,
      author: null,
      authorRef: null,
      coverImage: null,
      hr: POST_RENDER_BOTH.hr,
      en: null,
    });
    expect(post.author).toBeUndefined();
    expect(post.coverImage).toBeUndefined();
  });

  it('keeps the slug source working for a post written only in English', () => {
    /**
     * The Studio's own slug-suggestion function, read off the real schema definition
     * rather than out of the file — a `source` that stopped being a function would still
     * look right in a diff. A post with no Croatian title must still get a suggestion, or
     * Mina types the one permanent field on the document by hand.
     */
    const field = postSchema.fields.find((candidate) => candidate.name === 'slug');
    const source = (field as unknown as { options?: { source?: unknown } }).options?.source;
    expect(typeof source, '`slug.options.source` is not a function').toBe('function');

    const suggest = source as (doc: Record<string, unknown>) => string;
    expect(suggest({ hr: { title: 'Hrvatski naslov' }, en: { title: 'English' } })).toBe(
      'Hrvatski naslov',
    );
    expect(suggest({ en: { title: 'English only' } })).toBe('English only');
    expect(suggest({})).toBe('');
  });
});

/* ------------------------------------------------------------------- the rendered markup */

/**
 * Astro's container API: the real components, real props, real markup, no build.
 *
 * What it cannot see is stated rather than skipped — no asset pipeline, so no CSS, no
 * computed style and no layout. The build arm below reads the emitted stylesheet,
 * `npm run ds` reads the style blocks, and `npm run shots` measures 390px.
 */
const container = await AstroContainer.create();

const BOTH = decoded(POST_RENDER_BOTH);
const HR_ONLY = decoded(POST_RENDER_HR_ONLY);
const EN_ONLY = decoded(POST_RENDER_EN_ONLY);
const ALL = [BOTH, HR_ONLY, EN_ONLY];

describe('the index lists this locale’s posts, newest first (AC1)', () => {
  it('shows the date, the title and the summary of every post it lists', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Blog, { props: { locale, posts: ALL } });
      const read = words(html);

      for (const post of postsIn(ALL, locale)) {
        expect(read, `${post.id} title`).toContain(post.text[locale]!.title);
        expect(read, `${post.id} excerpt`).toContain(post.text[locale]!.excerpt);
      }
      expect(html, 'no machine-readable date beside the one a human reads').toContain(
        `datetime="${BOTH.publishedAt}"`,
      );
    }
  });

  it('hides a post that is not written in this locale, rather than marking it', async () => {
    // MUSE-26's decision, on the surface a reader meets first.
    const en = words(
      await container.renderToString(Blog, { props: { locale: 'en' as Locale, posts: ALL } }),
    );
    expect(en, 'a Croatian-only post was listed in English').not.toContain(
      HR_ONLY.text.hr!.title,
    );
    expect(en).toContain(EN_ONLY.text.en!.title);

    const hr = words(
      await container.renderToString(Blog, { props: { locale: 'hr' as Locale, posts: ALL } }),
    );
    expect(hr, 'an English-only post was listed in Croatian').not.toContain(
      EN_ONLY.text.en!.title,
    );
    expect(hr).toContain(HR_ONLY.text.hr!.title);
  });

  it('links each post at its own slug, in this locale', async () => {
    const html = await container.renderToString(Blog, {
      props: { locale: 'hr' as Locale, posts: ALL },
    });
    expect(html).toContain(`href="${postUrl(BOTH.slug, 'hr')}"`);
    expect(html).toContain(`href="${postUrl(HR_ONLY.slug, 'hr')}"`);
  });

  it('keeps the order it was given, which is newest first', async () => {
    const html = await container.renderToString(Blog, {
      props: { locale: 'hr' as Locale, posts: ALL },
    });
    const read = words(html);
    expect(read.indexOf(BOTH.text.hr!.title)).toBeLessThan(
      read.indexOf(HR_ONLY.text.hr!.title),
    );
  });
});

describe('with no posts at all, the page says so (AC5)', () => {
  it('says plainly that there is nothing, as the section’s own heading', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Blog, { props: { locale, posts: [] } });
      expect(html).toMatch(
        new RegExp(`<h2[^>]*>${BLOG_COPY[locale].emptyHeading.replace('.', '\\.')}`),
      );
    }
  });

  it('renders no list and no list heading — not an empty one', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Blog, { props: { locale, posts: [] } });
      expect(html, 'an empty list was rendered').not.toMatch(/<ul\b/);
      expect(words(html), 'a section heading with nothing under it').not.toContain(
        BLOG_COPY[locale].latest,
      );
    }
  });

  it('offers somewhere to go instead', async () => {
    for (const locale of LOCALES) {
      const html = await container.renderToString(Blog, { props: { locale, posts: [] } });
      expect(html).toContain(locale === 'hr' ? 'href="/schedule/"' : 'href="/en/schedule/"');
      expect(html).toContain(locale === 'hr' ? 'href="/contact/"' : 'href="/en/contact/"');
    }
  });

  it('shows the empty state in a locale with no posts even when the other has some', async () => {
    // The state `/en/blog/` is in the day Mina writes her first Croatian post, and the one
    // a „are there any posts at all" check would get wrong.
    const html = await container.renderToString(Blog, {
      props: { locale: 'en' as Locale, posts: [HR_ONLY] },
    });
    expect(html).toContain(BLOG_COPY.en.emptyHeading);
    expect(words(html)).not.toContain(HR_ONLY.text.hr!.title);
  });
});

describe('a post page is prose, with a byline that is always there (AC2)', () => {
  const STUDIO = 'Studio Fixture';

  async function render(post: Post, locale: Locale, author?: string): Promise<string> {
    return container.renderToString(PostPage, {
      props: {
        locale,
        post: author === undefined ? post : { ...post, author },
        studioName: STUDIO,
      },
    });
  }

  it('sets the title as the one `h1`, then the body’s subheadings as `h2`', async () => {
    const html = await render(BOTH, 'hr');
    expect((html.match(/<h1\b/g) ?? []).length, 'one h1 per page (§11.8)').toBe(1);
    expect(html).toContain(BOTH.text.hr!.title);
    expect(html, 'the body’s subheading skipped a level').not.toMatch(/<h3\b/);
    expect(html).toMatch(/<h2\b/);
  });

  it('names the instructor when the post names one', async () => {
    const html = await render(BOTH, 'hr', 'Instructor A');
    expect(words(html)).toContain('Instructor A');
  });

  it('signs an unsigned post with the studio’s own name, from the one read', async () => {
    // „Ostavi prazno i objava je potpisana studijem" is the field's documented default, so
    // a post with no author gets a byline rather than losing one — and the name comes off
    // the same `siteSettings` the footer and the JSON-LD render (MUSE-50).
    const html = await render(HR_ONLY, 'hr');
    expect(words(html)).toContain(STUDIO);
  });

  it('renders the whole body through the one renderer', async () => {
    const html = await render(BOTH, 'hr');
    const expected = renderPortableText(BOTH.text.hr!.body, 'x');
    expect(html).toContain(expected);
  });

  it('omits the cover frame entirely when there is no cover', async () => {
    // Not an empty box: a post without a photograph is prose, which is the state every
    // post will start in while the studio has no photography.
    const withCover = await render(BOTH, 'hr');
    const without = await render(HR_ONLY, 'hr');
    expect(withCover).toMatch(/<img\b/);
    expect(without, 'an empty image frame was reserved').not.toMatch(/<img\b/);
  });

  it('reserves the box the cover will take, at the ratio the Studio promises', async () => {
    const html = await render(BOTH, 'hr');
    const img = /<img\b[^>]*>/.exec(html);
    expect(img).not.toBeNull();
    expect(img![0]).toMatch(/\bwidth="\d+"/);
    expect(img![0]).toMatch(/\bheight="\d+"/);
    expect(img![0]).toContain(`alt="${BOTH.coverImage!.alt.hr}"`);
    expect(img![0]).toMatch(/object-position:\s*[\d.]+% [\d.]+%/);
  });

  it('leads back to the index', async () => {
    expect(await render(BOTH, 'en')).toContain('href="/en/blog/"');
  });

  it('renders a rewritten post and leaves no trace of the original (MUSE-50)', async () => {
    /**
     * Comparing a rendered page to the fixture it just read asserts nothing: every
     * equality test above passes while a literal in the component still happens to match.
     * So the same component renders a second dataset that shares no string with the first,
     * and the first set's words must appear nowhere.
     */
    const rewritten = POSTS_REWRITTEN.map((doc) => decoded(doc));
    for (const locale of LOCALES) {
      for (const post of rewritten.filter((candidate) => publishedIn(candidate, locale))) {
        const read = words(await render(post, locale));
        expect(read, `${post.id} was not rendered`).toContain(post.text[locale]!.title);

        const original = ALL.find((candidate) => candidate.id === post.id)!;
        expect(read, `${post.id}'s title survived the rewrite`).not.toContain(
          original.text[locale]!.title,
        );
        expect(read, `${post.id}'s summary survived the rewrite`).not.toContain(
          original.text[locale]!.excerpt,
        );
      }
    }
  });
});

/* ----------------------------------------------------------------------- the one build */

/**
 * **One `astro build`, spent on the five things the container cannot see.**
 *
 * Declared in `test/helpers/concurrency.ts`. It is a build against a dataset holding a
 * bilingual post, a Croatian-only one, an English-only one and one dated for later, which
 * is the only way to reach:
 *
 *   - `getStaticPaths` — which pages exist at all, per locale;
 *   - the **URL**, resolved through the model of GitHub Pages, which is where „the other
 *     locale handles it honestly" is a 404 rather than a file that happens to be absent;
 *   - the **`hreflang` cluster** in the emitted `<head>`;
 *   - the **sitemap**, whose `xhtml:link` groups are the third surface that has to agree;
 *   - the emitted **stylesheet**, for the prose rules and MUSE-14's figures.
 *
 * It also carries MUSE-50's build-level half for free: this build's dataset replaces the
 * committed seed's `page` documents, so the seeded `/blog` `<title>` and description must
 * appear in **no byte** of its output.
 */
let built: Build;
let host: Host;

const SEED_FIXTURE = process.env[FIXTURE_ENV];

beforeAll(async () => {
  built = buildSite(PAGES_DEPLOY, {
    [FIXTURE_ENV]: fixtureOf(POSTS_RENDERED as FixtureDoc[], 'posts'),
  });
  host = await servePages(built);
}, 240_000);

afterAll(async () => {
  await host?.close();
  process.env[FIXTURE_ENV] = SEED_FIXTURE;
});

/**
 * The two spellings of a post page's address, built from **this build's** deploy target.
 *
 * `postUrl` cannot be used here, and the reason is worth knowing: `localeUrl` reads
 * `import.meta.env.BASE_URL`, which inside the vitest process is `/` rather than the
 * build's `/MuseByMina`. So every assertion against `dist` derives its paths from
 * `basePath(built)` and `built.origin` instead — the discipline `test/urls.test.ts` keeps.
 */
function postTail(slug: string, locale: Locale): string {
  return `${locale === 'hr' ? '' : 'en/'}blog/${slug}/`;
}

function postPath(slug: string, locale: Locale): string {
  return `${basePath(built)}${postTail(slug, locale)}`;
}

function postAbsolute(slug: string, locale: Locale): string {
  return `${built.origin}/${postTail(slug, locale)}`;
}

function sitemapText(): string {
  return built
    .allFiles()
    .filter((file) => /^sitemap-\d+\.xml$/.test(file))
    .map((file) => built.read(file))
    .join('\n');
}

/**
 * Every stylesheet the build emitted, plus the post page's inline `<style>` blocks.
 *
 * Both halves, because `build.inlineStylesheets: 'auto'` means a small component
 * stylesheet may be inlined into the page instead of emitted as a file — so a check that
 * read only `.css` files would pass by finding nothing on exactly the pages where the rules
 * are small.
 */
function emittedCss(): string {
  const sheets = built
    .allFiles()
    .filter((file) => file.endsWith('.css'))
    .map((file) => built.read(file));
  const inline = [
    ...built.read('blog/post-both/index.html').matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g),
  ].map((match) => match[1]!);
  return [...sheets, ...inline].join('\n');
}

describe('a post written in one language has one URL, and all three surfaces agree (AC3)', () => {
  it('builds a page for each locale a post is written in, and no others', () => {
    const emitted = built.htmlFiles();

    expect(emitted).toContain('blog/post-both/index.html');
    expect(emitted).toContain('en/blog/post-both/index.html');
    expect(emitted).toContain('blog/post-hr-only/index.html');
    expect(emitted).toContain('en/blog/post-en-only/index.html');

    expect(emitted, 'a Croatian-only post was built in English').not.toContain(
      'en/blog/post-hr-only/index.html',
    );
    expect(emitted, 'an English-only post was built in Croatian').not.toContain(
      'blog/post-en-only/index.html',
    );
  });

  it('answers the URL that exists with a 200 and the one that does not with a 404', async () => {
    for (const [slug, locale] of [
      ['post-both', 'hr'],
      ['post-both', 'en'],
      ['post-hr-only', 'hr'],
      ['post-en-only', 'en'],
    ] as [string, Locale][]) {
      const probe = await host.get(postPath(slug, locale));
      expect([probe.status, probe.location], `${locale} ${slug}`).toEqual([200, undefined]);
    }

    for (const [slug, locale] of [
      ['post-hr-only', 'en'],
      ['post-en-only', 'hr'],
    ] as [string, Locale][]) {
      const probe = await host.get(postPath(slug, locale));
      expect(probe.status, `${locale} ${slug} is not a 404`).toBe(404);
    }
  });

  it('declares no `hreflang` on a one-locale post, and the pair on a bilingual one', () => {
    /**
     * The `<head>` half of the decision. A cluster of one states nothing a crawler can act
     * on, and a lone `hreflang="hr-HR"` is read as „this page is for Croatian speakers" —
     * which would ask Google to withhold a post from an English search it is a perfectly
     * good answer to. `x-default` goes with the cluster for the same reason.
     */
    const bilingual = built.read('blog/post-both/index.html');
    expect(bilingual).toContain(`hreflang="hr-HR" href="${postAbsolute('post-both', 'hr')}"`);
    expect(bilingual).toContain(`hreflang="en" href="${postAbsolute('post-both', 'en')}"`);
    expect(bilingual).toContain('hreflang="x-default"');

    const monolingual = built.read('blog/post-hr-only/index.html');
    expect(monolingual, 'a one-member cluster was declared').not.toContain('rel="alternate"');
    expect(monolingual, 'and no x-default either').not.toContain('x-default');
  });

  it('still declares its own canonical, because it is a page a crawler should find', () => {
    // The other half of MUSE-38's split: `indexable` and „has a twin" are two questions,
    // and a one-locale post is the live case where they differ.
    for (const [slug, locale] of [
      ['post-hr-only', 'hr'],
      ['post-en-only', 'en'],
      ['post-both', 'hr'],
    ] as [string, Locale][]) {
      const file = `${postTail(slug, locale)}index.html`;
      expect(canonicalOf(built.read(file)), file).toBe(postAbsolute(slug, locale));
      expect(built.read(file), `${file} went noindex`).not.toContain('name="robots"');
    }
  });

  it('gives the sitemap alternates for a bilingual post and none for a one-locale one', () => {
    /**
     * The third surface. `@astrojs/sitemap` derives its `xhtml:link` groups from the URLs
     * in the output and drops a group of one on its own, so this and the `<head>` agree by
     * rule rather than by coincidence — which is the whole reason `BaseLayout` was made to
     * apply the same threshold.
     */
    const sitemaps = sitemapText();
    expect(sitemaps.length).toBeGreaterThan(0);

    for (const [slug, locale] of [
      ['post-both', 'hr'],
      ['post-both', 'en'],
      ['post-hr-only', 'hr'],
      ['post-en-only', 'en'],
    ] as [string, Locale][]) {
      expect(sitemaps, `${locale} ${slug} is not in the sitemap`).toContain(
        postAbsolute(slug, locale),
      );
    }

    const entry = (loc: string): string => {
      const match = new RegExp(
        `<url>(?:(?!</url>)[\\s\\S])*${loc.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}[\\s\\S]*?</url>`,
      ).exec(sitemaps);
      expect(match, `no <url> entry for ${loc}`).not.toBeNull();
      return match![0];
    };

    expect(entry(postAbsolute('post-both', 'hr'))).toContain('xhtml:link');
    expect(
      entry(postAbsolute('post-hr-only', 'hr')),
      'the sitemap advertised a locale that has no page',
    ).not.toContain('xhtml:link');
  });

  it('renders the language switcher only where there is somewhere to switch to', () => {
    // The switcher is a prefix swap on the current route, so on a one-locale post it would
    // be a link to the 404 above. MUSE-38's `localeTwins` is what hides it.
    const bilingual = built.read('blog/post-both/index.html');
    expect(bilingual).toContain(`href="${postPath('post-both', 'en')}"`);

    const monolingual = built.read('blog/post-hr-only/index.html');
    expect(monolingual, 'the switcher offered a URL this build did not emit').not.toContain(
      postPath('post-hr-only', 'en'),
    );
  });

  it('lists a one-locale post on its own index and not on the other', () => {
    const hr = built.read('blog/index.html');
    const en = built.read('en/blog/index.html');

    expect(hr).toContain((POST_RENDER_HR_ONLY.hr as { title: string }).title);
    expect(en, 'a Croatian-only post reached the English index').not.toContain(
      (POST_RENDER_HR_ONLY.hr as { title: string }).title,
    );
    expect(en).toContain((POST_RENDER_EN_ONLY.en as { title: string }).title);
  });
});

describe('a post dated for later has no page and is on no index (AC4)', () => {
  it('emits no page for it in either locale', () => {
    const emitted = built.htmlFiles();
    expect(emitted).not.toContain('blog/post-scheduled/index.html');
    expect(emitted).not.toContain('en/blog/post-scheduled/index.html');
  });

  it('answers its URL with a 404 rather than publishing it early', async () => {
    // The whole point of `publishedAt`'s Studio description: a post can be prepared in
    // advance. A clockless reader behind `getStaticPaths` — which is what `/events` needs
    // and this must not have — would publish the text at a URL while the index hid it.
    for (const locale of LOCALES) {
      const probe = await host.get(postPath('post-scheduled', locale));
      expect(probe.status, `${locale} scheduled post`).toBe(404);
    }
  });

  it('keeps it out of both indexes and out of the sitemap', () => {
    const title = (POST_RENDER_SCHEDULED.hr as { title: string }).title;
    expect(built.read('blog/index.html')).not.toContain(title);
    expect(sitemapText()).not.toContain(postAbsolute('post-scheduled', 'hr'));
  });
});

describe('the built post page is typeset, and nothing in it breaks the measure', () => {
  it('styles every element the renderer can emit', () => {
    /**
     * `PROSE_ELEMENTS` is derived from the maps the renderer branches on, so this cannot
     * go stale: a block style added to the schema and the renderer without a rule in
     * `PostPage.astro` is a paragraph of unstyled browser default in the middle of a
     * typeset article, and it is a red test here instead.
     */
    const css = emittedCss();
    expect(css.length).toBeGreaterThan(0);
    const missing = PROSE_ELEMENTS.filter(
      (element) => !new RegExp(`\\.prose[^{]*\\b${element}\\b`).test(css),
    );
    expect(missing, 'the prose styles do not reach every element the renderer emits').toEqual(
      [],
    );
  });

  it('caps the measure and breaks a long token rather than widening the page', () => {
    // §5's 68ch, and the 390px case the ticket names: the fixture body ends with a
    // 200-character URL as link text, which is the realistic overflow on a post.
    const css = emittedCss();
    expect(css).toMatch(/max-width:68ch/);
    expect(css).toMatch(/overflow-wrap:anywhere/);
    expect(
      built.read('blog/post-both/index.html'),
      'the long token is not on the page',
    ).toContain('xxxxxxxxxx');
  });

  it('sets no `font-variant-numeric` of its own (MUSE-14)', () => {
    // `:root` and the form-control rule in `src/styles/base.css` are the two the document
    // is allowed to carry; a third would be a component replacing them.
    for (const file of built.allFiles().filter((name) => name.endsWith('.css'))) {
      const declarations = [
        ...built.read(file).matchAll(/font-variant-numeric\s*:[^;}]*/g),
      ].map((match) => match[0]);
      expect(declarations.length, `${file}: ${declarations.join(' | ')}`).toBeLessThanOrEqual(
        2,
      );
    }
  });

  it('ships no JavaScript file, with a dynamic route and a `set:html` in play', () => {
    // `test/nojs.test.ts` makes this claim over the committed seed, which has no posts —
    // so for the one page that injects HTML it is made here.
    expect(built.allFiles().filter((file) => file.endsWith('.js'))).toEqual([]);
  });
});

describe('a post page publishes `article` structured data through the one module (MUSE-31)', () => {
  function graphOf(file: string): Record<string, unknown>[] {
    const match = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(
      built.read(file),
    );
    expect(match, `${file} emits no JSON-LD`).not.toBeNull();
    const parsed = JSON.parse(match![1]!.replace(/\\u003c/g, '<')) as {
      '@graph': Record<string, unknown>[];
    };
    return parsed['@graph'];
  }

  it('emits exactly one block, carrying the studio, the page and the post', () => {
    const html = built.read('blog/post-both/index.html');
    expect((html.match(/application\/ld\+json/g) ?? []).length, 'a second block').toBe(1);

    const types = graphOf('blog/post-both/index.html').map((node) => node['@type']);
    expect(types).toContain(ARTICLE_TYPE);
    expect(types).toContain('WebPage');
  });

  it('describes the post with the strings the page itself shows', () => {
    const article = graphOf('blog/post-both/index.html').find(
      (node) => node['@type'] === ARTICLE_TYPE,
    )!;
    const text = POST_RENDER_BOTH.hr as { title: string; excerpt: string };

    expect(article.headline).toBe(text.title);
    expect(article.description).toBe(postMetaDescription(text.excerpt));
    expect(article.datePublished).toBe(POST_RENDER_BOTH.publishedAt);
    expect(article.url).toBe(postAbsolute('post-both', 'hr'));
    expect(article.inLanguage).toBe('hr-HR');
    expect(article.image, 'the cover is not in the block').toBeTruthy();
  });

  it('attributes an unsigned post to the studio node rather than to nobody', () => {
    // `author` is a required property for Google's article treatment, and the studio is
    // what the visible byline says — one fact, two syntaxes.
    const article = graphOf('blog/post-hr-only/index.html').find(
      (node) => node['@type'] === ARTICLE_TYPE,
    )!;
    const studio = graphOf('blog/post-hr-only/index.html').find((node) =>
      Array.isArray(node['@type']),
    )!;

    expect(article.author).toEqual({ '@id': studio['@id'] });
    expect(article.publisher).toEqual({ '@id': studio['@id'] });
    expect(article.image, 'a post with no cover claimed an image').toBeUndefined();
  });

  it('names the instructor on a post that has one', () => {
    const article = graphOf('blog/post-both/index.html').find(
      (node) => node['@type'] === ARTICLE_TYPE,
    )!;
    expect(article.author).toEqual({ '@type': 'Person', name: 'Instructor A' });
  });

  it('carries no article node on the index, which is not one', () => {
    expect(graphOf('blog/index.html').map((node) => node['@type'])).not.toContain(ARTICLE_TYPE);
  });
});

describe('the words come from the dataset, not from the components (MUSE-50)', () => {
  it('leaves the seeded `/blog` title and description in no byte of this output', () => {
    /**
     * This build read a dataset whose `page` documents are the fixture's, so the committed
     * seed's `/blog` title and description must appear nowhere. That is the one assertion a
     * literal in `Blog.astro` fails: every equality test above passes while a hardcoded
     * string still happens to match what the seed says.
     */
    const seeded = seedDocs()
      .filter((doc) => doc._id === 'page-blog')
      .flatMap((doc) =>
        ['title', 'description'].flatMap((field) =>
          Object.values(doc[field] as Record<string, unknown>).filter(
            (value): value is string => typeof value === 'string' && value.length > 12,
          ),
        ),
      );
    // Four: a title and a description, each in two locales. The `<title>`s happen to be
    // identical in both languages, which is a fact about the seed rather than a dedup.
    expect(seeded.length, 'no seeded strings to look for').toBe(4);

    const offenders: string[] = [];
    for (const file of built.allFiles()) {
      const bytes = readFileSync(join(built.outDir, file));
      for (const needle of seeded) {
        if (bytes.includes(needle)) offenders.push(`${file}: ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reads a post page’s own `<title>` from the post rather than from a `page` document', () => {
    const text = POST_RENDER_BOTH.hr as { title: string };
    expect(built.read('blog/post-both/index.html')).toContain(
      `<title>${postMetaTitle(text.title, 'Studio Fixture')}</title>`,
    );
  });

  it('publishes no `llms.txt` line per post', () => {
    // `llms.txt` is a short index of the site's sections and says so by linking the
    // sitemap; a line per post would make `test/seo.test.ts`'s set equality a claim about
    // the dataset rather than about the page registry.
    const llms = built.read('llms.txt');
    expect(llms, 'llms.txt lists /blog').toContain(`${built.origin}/blog/`);
    expect(llms, 'llms.txt grew a line per post').not.toContain(
      postAbsolute('post-both', 'hr'),
    );
  });
});

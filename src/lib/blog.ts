import { LOCALES, localeUrl, type Locale } from './i18n';
import { reservedChildSlugs } from './pages';
import { imageSrc, type Post } from './sanity';

/**
 * **`/blog` — the index, the posts, and the three decisions the ticket asked to be made
 * once and written down** (MUSE-26).
 *
 * None of this is content: every string here describes the *page* or the *site's own
 * state*. A post's title, its summary, its date and its text are all fields of a `post`
 * document in Sanity.
 *
 * ---------------------------------------------------------------------------------
 * ## 1. A post that exists in only one locale — the ticket's own hardest question
 *
 * **The other locale does not have it. It is not listed, it has no URL there, and
 * nothing links to it.**
 *
 * Everything else on this site exists in both languages by construction, and that is
 * right for everything else: a page title, a class name, a price's period are all short
 * enough that „both or neither" costs nothing and buys a site with no half-translated
 * pages in it. A blog post is the first content type where it does not hold, because
 * **nobody writes eight hundred words twice.** The schema used to require both halves of
 * `post.body`, which made a Croatian post unpublishable until an English one existed — and
 * the only way past a validator with nothing to put in the field is to paste a machine
 * translation. A `required()` field with no real value can only be filled with fiction,
 * which is MUSE-36.
 *
 * So a post carries one translation per language it is written in
 * (`sanity/schemaTypes/objects/locale.ts`), and „published in Croatian" is one fact:
 * {@link publishedLocales}. **The sitemap, `hreflang` and the locale switcher all read
 * that one fact**, which is what the ticket asked for — all three agree because there is
 * nothing for them to disagree about:
 *
 *   - **The index** in a locale lists the posts published in it. A Croatian-only post is
 *     absent from `/en/blog/` entirely.
 *   - **The URL** `/blog/<slug>/` is built for a locale only if the post is published in
 *     it, so `/en/blog/<slug>/` for a Croatian-only post is an ordinary 404 — not a page
 *     with a hole in it, and not a link anybody can reach, because the only thing that
 *     would have linked it is the index that does not list it.
 *   - **The sitemap** gets it for free and this was checked rather than assumed:
 *     `@astrojs/sitemap` derives its `xhtml:link` alternates from the URLs actually in the
 *     output and drops the whole group when there is only one
 *     (`createGetI18nLinks`: `if (links.length <= 1) return undefined`). So a
 *     one-locale post is one `<url>` with no alternates, and no configuration says so.
 *   - **`hreflang`** follows the same rule in the page's own `<head>`, because
 *     `BaseLayout.astro` now derives the cluster from the per-locale URL rather than from
 *     a flag — the same function the switcher reads. A cluster of one is **not emitted**:
 *     a lone `hreflang="hr-HR"` is not a self-reference inside a group, it is a statement
 *     that the page is *for* Croatian speakers, which would suppress a post we want found
 *     in English search. Nothing is claimed instead, which is what a single-language page
 *     has to say.
 *   - **The switcher** does not render on a page with no twin, which is MUSE-38's
 *     `localeTwin` doing exactly what it was split out for. `langInitScript` still ships
 *     and still persists `?lang=`; it simply has nowhere to send anybody, per locale,
 *     which is why `urlFor` answers `string | null` rather than taking a flag.
 *
 * **The alternative was listing it and marking it**, which the ticket also allows, and it
 * was rejected rather than overlooked. It is the more generous reading — an English
 * visitor would at least learn the post exists — and it costs two things that are worse
 * than the omission: the English index would link out of English into a page whose
 * chrome, nav and footer are Croatian and whose switcher is (correctly) hidden, so the
 * reader is dropped into the other language with no way back but the nav; and `title.en`
 * and `excerpt.en` would have to stay `required()` on a post with no English body, which
 * is the dormant-field-filled-with-fiction problem again, one field smaller. Hiding is
 * the honest answer when the thing being hidden is text the reader could not read anyway.
 *
 * ## 2. The slug is the document's stored slug, and it is permanent
 *
 * `/blog/<slug>/`, from `slug.current`. Never derived from the title or the date: a
 * derived URL moves when a typo is corrected, and a moving URL 404s for everybody who
 * linked it. {@link assertPostSlugs} is the half that can fail — a duplicate slug is two
 * posts claiming one URL, and which one Astro builds is not a decision anybody made.
 *
 * {@link reservedBlogSlugs} is the other half, and today it is **empty**: `/blog` has no
 * static child, so there is nothing to reserve. It is here anyway, derived from `ROUTES`,
 * so that the day `/blog/archive` or `/blog/tags` is routed it reserves itself — which is
 * the lesson MUSE-24 paid for on `/events/archive`. `reservedChildSlugs` takes its route
 * list as an argument precisely so that this can be *tested* against a prefix that has a
 * child rather than tested against nothing.
 *
 * ## 3. When a scheduled post appears
 *
 * `POSTS_QUERY` filters `publishedAt <= $now` and `$now` is the build's instant, so a post
 * dated for later appears at **the next build, not at its publish time**. The site is
 * static; nothing moves until something builds, and what builds is a push plus MUSE-21's
 * scheduled rebuild. Those runs are evenly spaced, so the longest a published post can
 * wait is `MAX_WAIT_HOURS` in `src/lib/rebuild.ts` — **cited by name and never written
 * here as a number**, for that file's own reason: a sentence naming a duration goes stale
 * the day the cron changes, and the same is true of a comment.
 *
 * That is accepted, and the direction it is wrong in is the harmless one — a reader never
 * sees a post *early*, only late. The alternative is a second answer to the same question:
 * re-filtering in the browser would make a post's presence depend on JavaScript on the one
 * page where a crawler is the most important reader, and the built output contains zero
 * `.js` files by design (`test/nojs.test.ts`).
 *
 * Note what is deliberately **not** done, and how it differs from `/events`: there is no
 * clockless reader behind `getStaticPaths`. `src/lib/sanity/queries.ts` has the argument —
 * an event must keep its page after it happens, a post must not have one before it does.
 * ---------------------------------------------------------------------------------
 */

/** The index. */
export const BLOG_ROUTE = '/blog';

/** The URL of one post's page, in `locale`. The only place that path is built. */
export function postUrl(slug: string, locale: Locale): string {
  return localeUrl(`${BLOG_ROUTE}/${slug}`, locale);
}

/**
 * The slugs a post may not have, because a static page already answers that URL.
 *
 * `[]` today. See decision 2 above for why it exists anyway and why it is derived.
 */
export function reservedBlogSlugs(): string[] {
  return reservedChildSlugs(BLOG_ROUTE);
}

/**
 * **Which languages a post is published in**, newest-first order preserved.
 *
 * The single fact decisions 1's four surfaces read. Returned in `LOCALES` order rather
 * than in the dataset's, so „Croatian first" (§10) holds whichever half was typed first.
 */
export function publishedLocales(post: Post): Locale[] {
  return LOCALES.filter((locale) => post.text[locale] !== undefined);
}

/** Is this post published in `locale`? */
export function publishedIn(post: Post, locale: Locale): boolean {
  return post.text[locale] !== undefined;
}

/** The posts an index in `locale` lists, in the order they arrive (newest first). */
export function postsIn(posts: readonly Post[], locale: Locale): Post[] {
  return posts.filter((post) => publishedIn(post, locale));
}

/** The least a post has to be for its URL to be decidable. */
interface Sluggable {
  id: string;
  slug: string;
}

/**
 * Fail the build if any post's slug cannot be a URL of its own.
 *
 * Two failures, both silent without this. A **duplicated** slug means two posts claiming
 * one URL, and which of them Astro builds is its business rather than a decision anybody
 * made — so one post is published and unreachable, and the one that wins may be the older
 * draft of a rewrite. A **reserved** slug builds a page the static route then shadows,
 * which is the same outcome arrived at from the other direction.
 *
 * Called from `getStaticPaths` in both locale templates, which is the one place that
 * already has every post in front of it. It is handed **every** post rather than the ones
 * published in that locale, because a collision is a fact about the dataset and not about
 * a language: two posts slugged alike, one Croatian and one English, collide on the day
 * somebody translates either of them.
 */
export function assertPostSlugs(posts: readonly Sluggable[]): void {
  const reserved = reservedBlogSlugs();

  const clashes = posts
    .filter((post) => reserved.includes(post.slug))
    .map(
      (post) =>
        `  \`${post.id}\` is slugged "${post.slug}", which is the URL of ` +
        `${BLOG_ROUTE}/${post.slug} — a page this site already serves.`,
    );

  const seen = new Map<string, string[]>();
  for (const post of posts) {
    seen.set(post.slug, [...(seen.get(post.slug) ?? []), post.id]);
  }
  const duplicates = [...seen]
    .filter(([, ids]) => ids.length > 1)
    .map(([slug, ids]) => `  "${slug}" is the slug of ${ids.length} posts: ${ids.join(', ')}.`);

  if (clashes.length === 0 && duplicates.length === 0) return;

  throw new Error(
    [
      'A `post` document cannot be published at the URL its slug asks for.',
      ...clashes,
      ...duplicates,
      ...(reserved.length === 0
        ? [
            `  No slug under ${BLOG_ROUTE} is reserved today — the site serves no static ` +
              `child of it — so the failure above is a duplicate.`,
          ]
        : [
            '  Reserved, because a static page answers each of these: ' +
              `${reserved.map((slug) => `"${slug}"`).join(', ')}. Astro gives a static ` +
              'route priority over a dynamic one, so the page would be built and then ' +
              'shadowed — published, and reachable by nobody.',
          ]),
      '  Change the slug in the Studio. It is the post’s permanent address, so change ' +
        'it before the post is shared rather than after.',
    ].join('\n'),
  );
}

/* ------------------------------------------------------------------ page metadata */

/**
 * What a post's page puts in `<title>` and `<meta name="description">`.
 *
 * **Derived rather than a `page` document**, which is the one place `/blog/<slug>/`
 * departs from the convention in `src/lib/pages.ts`. A `page` document exists per *route*
 * and the routes the Studio may describe are `ROUTES`; one per post would be a second
 * document Mina has to remember to write, keyed on a route that is not in the list,
 * saying again what the `post` document already says.
 *
 * `studioName` is passed in rather than read here, so it is the same `siteSettings` value
 * the footer, the JSON-LD block and `og:site_name` render — one read, no second copy
 * (MUSE-50).
 */
export function postMetaTitle(title: string, studioName: string): string {
  return `${title} — ${studioName}`;
}

/** Roughly what Google will show, cut at a word rather than mid-syllable. */
const META_DESCRIPTION_LIMIT = 160;

export function postMetaDescription(excerpt: string): string {
  const flat = excerpt.replace(/\s+/g, ' ').trim();
  if (flat.length <= META_DESCRIPTION_LIMIT) return flat;

  const cut = flat.slice(0, META_DESCRIPTION_LIMIT);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:—-]$/, '')}…`;
}

/* ------------------------------------------------------------------- the cover image */

/**
 * **The one width a cover image is served at**, and the reason it lives here rather than
 * in `PostPage.astro`.
 *
 * Two surfaces need the same URL: the `<img>` the reader sees, and the `image` property of
 * the `BlogPosting` node in the JSON-LD. A second width in a second file is a block
 * claiming an image the page does not serve — MUSE-31's whole subject, one field smaller —
 * so the width is a constant and the URL is one function.
 *
 * One width, no `srcset`: `src/lib/sanity/images.ts` has the argument, and
 * `scripts/budget.mjs` measures at `deviceScaleFactor: 1`, so a 1× entry would budget a
 * file almost nobody fetches.
 */
export const COVER_WIDTH = 1280;

/** The cover's absolute URL, or `undefined` for a post with no cover. */
export function postCoverUrl(post: Post): string | undefined {
  return post.coverImage === undefined
    ? undefined
    : imageSrc(post.coverImage, { width: COVER_WIDTH });
}

/* ------------------------------------------------------------------ interface chrome */

/**
 * **Interface chrome, and the empty state — which is the state this page ships in.**
 *
 * There are no `post` documents in the dataset and nobody has written any. That is the
 * whole reason this ticket could be built now: `getPosts` supports `minimum: 0`, so a blog
 * with nothing on it is a legitimate page rather than a broken one — *provided* it is
 * honest about being empty.
 *
 * So no invented posts, anywhere: not in `content/seed.ndjson`, not as an example, not „to
 * show the layout". MUSE-36 published thirteen invented classes naming two instructors who
 * do not work at the studio and it was live for the life of the project. The fixtures this
 * page is developed against live under `test/`.
 *
 * Three things the empty block does, and one it does not:
 *
 *   - it **says there is nothing**, in one sentence, as the section's own heading rather
 *     than as a note;
 *   - it **renders no list** — not an empty grid, not a section heading over nothing,
 *     because a heading with no rows under it reads as a page that failed to load;
 *   - it **offers somewhere to go**: the weekly schedule, which is what the studio
 *     actually runs, and the contact page;
 *   - it **promises nothing**. Not „ništa za sada", not „provjeri kasnije" — those are
 *     claims about posts nobody has written, which is MUSE-36's mistake in a smaller font.
 *
 * The words are **code, not CMS**, and that is the one judgement worth defending here. A
 * `localeString` for „there are no posts" would be a field whose correct value depends on
 * what else is in the dataset: Mina cannot see when it renders, so she cannot keep it
 * true, and a stale one would read as a claim rather than as a state. It sits with
 * `FORM_COPY` and `LEVEL_PREREQUISITE` for the same reason — interface chrome that
 * describes the site's own behaviour stays in code, and everything a reader would call
 * content is a field.
 *
 * Croatian first, because Croatian sets the layout (§10).
 */
export const BLOG_COPY: Record<
  Locale,
  {
    /** `/blog` */
    eyebrow: string;
    heading: string;
    lede: string;
    latest: string;
    emptyHeading: string;
    emptyBody: string;
    toSchedule: string;
    toContact: string;
    /** `/blog/<slug>` */
    toBlog: string;
    /** The label a cover image's figure gets when there is one. */
    readMore: string;
  }
> = {
  hr: {
    eyebrow: 'Iz studija',
    heading: 'Blog',
    lede: 'Tekstovi studija, najnoviji prvo.',
    latest: 'Najnovije',
    emptyHeading: 'Nema objavljenih tekstova.',
    emptyBody: 'Redovni satovi idu po tjednom rasporedu.',
    toSchedule: 'Raspored',
    toContact: 'Kontakt',
    toBlog: 'Svi tekstovi',
    readMore: 'Pročitaj',
  },
  en: {
    eyebrow: 'From the studio',
    heading: 'Blog',
    lede: 'Writing from the studio, newest first.',
    latest: 'Latest',
    emptyHeading: 'No posts are published.',
    emptyBody: 'Regular classes run to the weekly schedule.',
    toSchedule: 'Schedule',
    toContact: 'Contact',
    toBlog: 'All posts',
    readMore: 'Read',
  },
};

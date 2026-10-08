/**
 * **Which pages the site serves. Not what they say.**
 *
 * This file used to hold every page's `<title>` and one-line description as well. Those
 * are `page` documents in Sanity now (MUSE-20) — one per route, carrying `name`, `title`
 * and `description` in both locales — and the registry keeps only the half that is
 * structure: the list of routes.
 *
 * The split is the point, and it runs in one direction:
 *
 *   - **Which pages exist is decided by `src/pages/`** and declared here. A route cannot
 *     be invented from the Studio: `sanity/schemaTypes/enums.ts` builds the `route`
 *     field's dropdown *and its validation* from this list, so a `page` document can only
 *     describe a page the site actually serves. `test/seo.test.ts` reads its own page list
 *     off `src/pages/` rather than off any registry, for exactly that reason, and the
 *     three lists are held to each other by `test/routes.test.ts` — see the note on
 *     `inertRouteWarning` below for which disagreement is reported how, and why.
 *   - **What a page says is Mina's**, and lives in the CMS, so a title can be reworded
 *     without a deploy.
 *
 * One entry per *route*, not per locale page, because HR and EN share slugs (CLAUDE.md).
 * And one `page` document per route for the same reason: the `<title>`/`<meta
 * description>` a visitor gets and the one line `llms.txt` publishes have to be the same
 * string, and two documents would reintroduce the drift that single source exists to
 * prevent. `test/seo.test.ts` compares the two renderings against each other.
 *
 * `src/lib/sanity/index.ts` reads the documents and fails the build, naming the route, if
 * one is missing — so a page added here without a document in the Studio stops the build
 * rather than publishing with an empty `<title>`.
 */
export interface SiteRoute {
  /** Route without locale prefix or deploy base — `/`, `/schedule`. */
  route: string;
  /**
   * What the Studio's route dropdown calls this page.
   *
   * Studio-only: never rendered, never published, and not the page's `name` — that is a
   * field of the `page` document, which is what appears in `llms.txt`. It exists because
   * a dropdown reading `/`, `/schedule`, `/contact` is a worse thing to pick from than
   * one reading „Početna — /", and because a label for a page that does not exist yet is
   * not something the CMS can supply.
   *
   * **It duplicates each `page` document's `name.hr`, and MUSE-46 deliberately left that
   * alone.** The four values are identical to the four seeded names today, so pinning
   * them would have passed — and would have been wrong in a way the rest of this file
   * argues against. The strings are the same by coincidence of being good labels, not
   * because one derives from the other: this one must exist for a route whose document
   * does not, so it cannot be read off the document, and the document's `name` is
   * published copy Mina is entitled to reword on a Tuesday afternoon. A test tying them
   * together would turn a legitimate Studio edit into a red build — the thing MUSE-36's
   * `scheduleSlot.active` note and the severity argument below both exist to avoid — and
   * the cost of the drift it would catch is one stale word in a dropdown only Mina sees,
   * on a page she is picking by its route anyway. It is a fourth copy of a *label*, not
   * a fourth copy of which pages exist, and this ticket is about the second.
   */
  studioLabel: string;
}

/** Indexable pages, in the order they should be listed. Error routes are not here. */
export const ROUTES: SiteRoute[] = [
  { route: '/', studioLabel: 'Početna' },
  { route: '/schedule', studioLabel: 'Raspored' },
  // Inserted rather than appended (MUSE-59, MUSE-60): the order here is the order
  // `llms.txt` lists the site in and the order the Studio's dropdown offers, and it is the
  // order a reader meets the pages — what is on, what it costs, who teaches it, how to
  // come.
  { route: '/pricing', studioLabel: 'Cjenik' },
  { route: '/aboutus', studioLabel: 'O nama' },
  { route: '/contact', studioLabel: 'Kontakt' },
  { route: '/privacy', studioLabel: 'Izjava o privatnosti' },
];

/**
 * **The three lists, and the two ways they could disagree without anybody noticing**
 * (MUSE-46).
 *
 * Which pages exist is now asserted by three things that have to agree: `src/pages/`,
 * `ROUTES` above, and the `page` documents in the Studio. Only the first cannot lie —
 * a file either is compiled into a page or it is not — so every check is anchored there.
 *
 * Three of the four possible disagreements were already loud, or are now:
 *
 *   - **A route here with no `page` document** fails the build naming the route
 *     (`pagesByRoute` in `src/lib/sanity/index.ts`). Always has.
 *   - **A route here with no file under `src/pages/`** publishes a link in `llms.txt` to
 *     a URL that 404s — for machines, including this project's own QA agents, which is
 *     worse than an omission. `test/routes.test.ts` fails naming the route, and
 *     `test/seo.test.ts` fails against `dist` by resolving every URL `llms.txt`
 *     advertises through the model of GitHub Pages.
 *   - **A page under `src/pages/` that is not a route here** gets no `llms.txt` line and
 *     no `page` document; `test/seo.test.ts` has always caught it, because it reads its
 *     page list off the filesystem, and `test/routes.test.ts` now names it directly.
 *
 * The fourth is the one below: **a `page` document describing a route the site does not
 * serve.** It publishes nothing — `getPageMeta` walks `ROUTES`, so the document reaches
 * no `<title>`, no `<meta name="description">`, no sitemap entry and no `llms.txt`
 * line — and that is exactly why it was silent. Mina fills in four fields in two
 * languages and the site does not change.
 *
 * **It is a warning, not a failed build, and that is a decision rather than a shortcut.**
 * The Studio refuses the route at the point of editing (`sanity/schemaTypes/documents/
 * site.ts`), which is the instrument that reaches the person who can fix it, in her
 * language, while she is typing. What validation cannot prevent is the *other* order of
 * events: a developer deletes a route from `ROUTES`, and a document that was valid
 * yesterday is inert today. That lands in a pull request, so the pull request's build log
 * is where it belongs — and making it fatal would hand a stale CMS document the power to
 * stop every unrelated PR, every deploy and MUSE-21's scheduled rebuild, over a condition
 * that is provably inert. Severity should match consequence: nothing is published
 * wrongly, so nothing should stop publishing. `test/routes.test.ts` asserts the warning
 * against a real build's output, so "a log nobody reads" is at least a log that cannot
 * quietly stop saying it.
 */
export interface RouteDocument {
  /** The document's `_id`, so the warning names the thing to open in the Studio. */
  id: string;
  /** The route it claims to describe. */
  route: string;
  /** Mina's short name for the page, if the document has one. Only for the message. */
  name?: { hr: string };
}

/** The documents describing routes this site does not serve. */
export function inertRouteDocuments<T extends RouteDocument>(
  documents: readonly T[],
): T[] {
  const served = new Set(ROUTES.map(({ route }) => route));
  return documents.filter(({ route }) => !served.has(route));
}

/**
 * The first line of the warning, and the needle `test/routes.test.ts` looks for.
 *
 * Exported so the assertion and the message are one string. A test spelling the sentence
 * again is a test that passes while the build has gone quiet in a slightly different
 * wording — the mistake `test/content.test.ts` avoids the same way for
 * `TRANSIENT_BUILD_FAILURE`.
 */
export const INERT_ROUTE_WARNING = 'A `page` document describes a route this site does not serve';

/**
 * What the build prints when a `page` document is inert, or `undefined` when none is.
 *
 * `undefined` rather than an empty string so the caller cannot log a blank line on the
 * happy path, which is every build.
 */
export function inertRouteWarning(documents: readonly RouteDocument[]): string | undefined {
  const inert = inertRouteDocuments(documents);
  if (inert.length === 0) return undefined;

  return [
    // A leading newline because Astro writes its route lines without one, and an
    // unprefixed message lands glued to `/contact/index.html` in the build log.
    `\n[MUSE-46] ${INERT_ROUTE_WARNING}.`,
    ...inert.map(
      ({ id, route, name }) =>
        `  ${name?.hr === undefined ? '' : `„${name.hr}" `}(\`${id}\`) describes \`${route}\`.`,
    ),
    `  Nothing on the site reads it: it reaches no <title>, no <meta name="description">,`,
    `  no sitemap entry and no llms.txt line. It is inert, not broken — which is why this`,
    `  is a warning and the build is still going to succeed.`,
    `  Fix it either way round: delete the document in the Studio under „Stranica (naslov`,
    `  i opis)", or — if the page is meant to exist — add the route to \`ROUTES\` in`,
    `  \`src/lib/pages.ts\` *and* a file for it under \`src/pages/\`.`,
    `  Routes this site serves: ${ROUTES.map(({ route }) => route).join(', ')}.`,
  ].join('\n');
}

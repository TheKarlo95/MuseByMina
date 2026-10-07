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
 *     field's dropdown from this list, so a `page` document can only describe a page the
 *     site actually serves. `test/seo.test.ts` reads its own page list off `src/pages/`
 *     rather than off any registry, for exactly that reason.
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
   */
  studioLabel: string;
}

/** Indexable pages, in the order they should be listed. Error routes are not here. */
export const ROUTES: SiteRoute[] = [
  { route: '/', studioLabel: 'Početna' },
  { route: '/schedule', studioLabel: 'Raspored' },
  { route: '/contact', studioLabel: 'Kontakt' },
  { route: '/privacy', studioLabel: 'Izjava o privatnosti' },
];

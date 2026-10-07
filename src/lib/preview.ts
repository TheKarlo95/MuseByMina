/**
 * **Throwaway routes for components that have no page yet. Test-only** (MUSE-23).
 *
 * The problem this solves is narrow and keeps recurring in this project: a page ticket is
 * split in two because its *content* is not ready. MUSE-23 built `/aboutus` — the studio
 * story and the instructor cards — against a dataset that holds neither the story nor a
 * single instructor, and `src/lib/sanity/decode.ts` is built to fail the build by name
 * when a document a page needs is absent. Routing the page would have been correct code
 * that stops `main` building, every pull request, every deploy and MUSE-21's scheduled
 * rebuild with it.
 *
 * Leaving the component unrouted is the right call. It also leaves it untested, and more
 * than half of MUSE-23's acceptance criteria are statements about CSS — a 3:4 frame,
 * greyscale over 700ms, a reveal that works without a pointer, a placeholder that reserves
 * the same box as the photograph that will replace it. Astro's container API renders a
 * component to a string without Vite's CSS pipeline, so none of that is visible to it: it
 * can assert what the component *returns*, never what a visitor *receives*.
 *
 * So `astro.config.mjs` injects a route per entry below, **only** when
 * `MUSE_PREVIEW_ROUTES` names it, and the test builds the real site with that variable
 * set. Same mechanism as `MUSE_CONTENT_FIXTURE` in `src/lib/sanity/fixture.ts`, and it
 * stays out of a deploy for the same four reasons:
 *
 *   1. There is no default and no fallback. Unset, nothing is injected and the output is
 *      byte-identical to a build that has never heard of this module.
 *   2. The entry points live under `test/`, not under `src/pages/` — which is the tree
 *      `test/seo.test.ts` reads the site's page list off, so a preview route cannot
 *      appear in `llms.txt`, the sitemap or the nav even by accident.
 *   3. The build says out loud, in capitals, which routes it injected.
 *   4. `test/aboutus.test.ts` asserts that no workflow and no `package.json` script sets
 *      the variable, and that every entry point is under `test/`.
 *
 * **A preview route is not a staging area.** It exists so a component with no content can
 * be held to its acceptance criteria, and it goes away with the follow-up ticket that
 * routes the page properly. If an entry here outlives the ticket that added it, that is a
 * page somebody forgot to ship.
 */

/** The environment variable that asks for preview routes. Comma-separated names. */
export const PREVIEW_ROUTE_ENV = 'MUSE_PREVIEW_ROUTES';

/**
 * The routes that *can* be injected, name → entry point.
 *
 * Paths are repo-relative with a leading `./`, which is what `injectRoute` wants and what
 * lets the guard in `test/aboutus.test.ts` check they are all under `test/`.
 */
export const PREVIEW_ROUTES: Record<string, string> = {
  // MUSE-23. Remove this when the follow-up adds `src/pages/aboutus.astro`.
  aboutus: './test/preview/aboutus.astro',
};

/**
 * Which previews this build was asked for, validated.
 *
 * An unknown name **throws**. A typo'd preview name would otherwise be a build that
 * quietly injects nothing and a suite that fails on every assertion at once, with the
 * cause nowhere in the output.
 */
export function requestedPreviews(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];

  const names = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);

  const unknown = names.filter((name) => !(name in PREVIEW_ROUTES));
  if (unknown.length > 0) {
    throw new Error(
      `${PREVIEW_ROUTE_ENV} asked for ${unknown.map((n) => `\`${n}\``).join(', ')}, which ` +
        `is not a preview route. Known: ${Object.keys(PREVIEW_ROUTES).join(', ') || '(none)'}. ` +
        `See src/lib/preview.ts — these exist only so a component with no content yet can ` +
        `still be built and asserted on, and they are never part of a deploy.`,
    );
  }

  return names;
}

/**
 * The URL patterns one preview is served at: the Croatian route and its English twin.
 *
 * Both patterns share **one** entry point, which reads its locale off the path exactly as
 * `BaseLayout.astro` does. Two files would be two chances for the locales to drift, and
 * the thing under test is a component that renders both from one source.
 *
 * The `-preview` suffix is deliberate: it keeps the preview out of the URL space the real
 * page will own, so nothing — a stale bookmark, a sitemap, a test — can confuse the two.
 */
export function previewPatterns(name: string): string[] {
  return [`/${name}-preview`, `/en/${name}-preview`];
}

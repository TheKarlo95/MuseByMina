import { beforeAll, describe, expect, it } from 'vitest';

import { buildSite, PAGES_DEPLOY, type Build } from './helpers/build';

/**
 * MUSE-19 — the built site contains **no JavaScript files at all**, and no trace of a
 * CMS client.
 *
 * Asserted rather than assumed, because MUSE-19 is the commit that makes it breakable.
 * Until now there was nothing in the dependency tree that *could* ship to a browser; now
 * `@sanity/client` is a dependency, `sanity` is a devDependency with React behind it, and
 * the read path sits under `src/lib/` where any component can import it. One `<script>`
 * that imports `src/lib/sanity/` — or one `define:vars` that interpolates a query — turns
 * a page carrying 0 KB of JavaScript into a page carrying a CMS client.
 *
 * Nothing on the site needs one. Content is fetched at **build time**: the queries run in
 * Node while `astro build` is producing HTML, and the visitor downloads the result, not
 * the means. Two Astro behaviours make that distinction real rather than hoped-for, and
 * knowing which is which is the whole reason this suite counts *files*:
 *
 *   - component frontmatter runs at build time and is never bundled for the client;
 *   - a component `<script>` **is** bundled and shipped.
 *
 * Inline `<script>` blocks are therefore expected and fine — `src/lib/theme.ts` has to be
 * inline to stamp the theme before first paint (CLAUDE.md), and the schedule filters and
 * the trial form are inline too. A script *file* is a different claim: it means Astro
 * decided a bundle was big enough to externalise, which on this site can only mean
 * something arrived that does not belong.
 */
describe('the built site ships no JavaScript files and no CMS client', () => {
  let build: Build;

  beforeAll(() => {
    build = buildSite(PAGES_DEPLOY);
  }, 240_000);

  it('emits no script file anywhere in the output', () => {
    const scripts = build
      .allFiles()
      .filter((file) => /\.(js|mjs|cjs|jsx|ts|tsx|map)$/.test(file));
    expect(scripts).toEqual([]);
  });

  it('emits only the file types a static content site needs', () => {
    // An allow-list rather than a deny-list: a format nobody chose is exactly what
    // arriving unnoticed looks like.
    //
    // `webp` joined the list in MUSE-64, with the brand lockup — the first image the
    // site has ever shipped. One entry and one file: `test/lockup.test.ts` holds the
    // count, and `scripts/budget.mjs` holds what it may weigh. Note what this list
    // deliberately does *not* say: there is no `png`, `jpg` or `svg` here, so the source
    // raster reaching `dist` by being pointed at in `public/` is a failure of this line
    // as well as of that suite.
    const extensions = [
      ...new Set(build.allFiles().map((file) => file.replace(/^.*\./, ''))),
    ].sort();
    expect(extensions).toEqual(['css', 'html', 'txt', 'webp', 'woff2', 'xml']);
  });

  it('mentions no Sanity client, query or configuration anywhere in the output', () => {
    /**
     * The read path's own markers. If one of these reaches `dist` it means either a query
     * was interpolated into markup or the client was bundled — and both are invisible
     * from a page that renders correctly, because the content would still be on it.
     */
    const markers = [
      '@sanity/client',
      'apicdn.sanity.io',
      'q6fk9usq',
      '_type ==',
      'SANITY_PROJECT_ID',
      'defineQuery',
    ];
    const text = build.allFiles().filter((file) => /\.(html|css|txt|xml)$/.test(file));
    expect(text.length).toBeGreaterThan(10);

    for (const file of text) {
      const body = build.read(file);
      for (const marker of markers) {
        expect(body.includes(marker), `${file} contains "${marker}"`).toBe(false);
      }
    }
  });

  it('renders exactly the pages the site publishes', () => {
    // The routes the site publishes, spelled out. MUSE-20 moved the words of these pages
    // into the CMS and added none, which is what makes a migration a migration — and a
    // page that silently stopped building (a content error swallowed somewhere) would
    // otherwise look like a pass everywhere else in this file.
    //
    // MUSE-59 added the first new page since (`/pricing`, with the `pricingTier`
    // documents that make it buildable) and MUSE-60 the second (`/aboutus`, with the
    // `studioStory` document that makes it buildable at all). A page arriving here is the
    // one case where editing this list is correct, and it has to be a line in a diff
    // rather than a list derived from `ROUTES` — the claim is "the build emitted these
    // and nothing else", and deriving it from the registry would make it agree with
    // itself.
    expect(build.htmlFiles()).toEqual([
      '404.html',
      'aboutus/index.html',
      'contact/index.html',
      'en/aboutus/index.html',
      'en/contact/index.html',
      'en/index.html',
      'en/pricing/index.html',
      'en/privacy/index.html',
      'en/schedule/index.html',
      'index.html',
      'pricing/index.html',
      'privacy/index.html',
      'schedule/index.html',
    ]);
  });
});

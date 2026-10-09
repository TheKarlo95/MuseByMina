import { beforeAll, describe, expect, it } from 'vitest';

import { ICONS } from '../src/lib/icon';
import { SHARE_CARD_FILE } from '../src/lib/share-card';
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
    // count, and `scripts/budget.mjs` holds what it may weigh.
    //
    // `png` joined it in MUSE-40, with the tab icons, and that entry gave something up:
    // this line used to say *no* `png`, `jpg` or `svg`, so a source raster reaching
    // `dist` — pointed at from `public/`, or copied there by hand — failed here as well
    // as wherever else it was wrong. A favicon has to be a PNG (`webp` is not a
    // dependable icon format, and an apple-touch-icon must not be one), so the
    // extension can no longer carry that claim and the test below carries it instead:
    // the output's PNGs are *exactly* the registered icons, content-hashed by Vite.
    // Keep the two together — the allow-list alone is now a weaker statement than it
    // reads as.
    const extensions = [
      ...new Set(build.allFiles().map((file) => file.replace(/^.*\./, ''))),
    ].sort();
    expect(extensions).toEqual(['css', 'html', 'png', 'txt', 'webp', 'woff2', 'xml']);
  });

  /**
   * Every PNG in the output is a registered raster, emitted through the asset graph.
   *
   * The direction matters. `test/icon.test.ts` asserts that each icon in `ICONS` reaches
   * the output, which says nothing about a *seventh* PNG arriving beside them — a source
   * raster dropped into a recreated `public/`, an unused export, `logo/` copied wholesale.
   * This is the other direction, and it is the half the extension allow-list used to
   * provide for free.
   *
   * The content hash is part of the claim, not decoration: a file Vite emitted has one,
   * and a file that was copied verbatim out of `public/` does not. That is precisely the
   * distinction MUSE-35 was about.
   *
   * The registry is the five tab icons **plus the share card** (MUSE-69), which is a PNG
   * for the same reason an apple-touch-icon is: the audience is somebody else's software.
   * A link-preview scraper is not a browser and cannot be content-negotiated with, so
   * `webp` is not available here either. It is added as `SHARE_CARD_FILE` rather than as
   * a literal, so the entry cannot outlive the asset.
   */
  it('emits no PNG that is not a registered raster from the asset graph', () => {
    const stems = new Set(
      [...ICONS.map((icon) => icon.file), SHARE_CARD_FILE].map((file) =>
        file.replace(/\.png$/, ''),
      ),
    );

    const unexpected = build
      .allFiles()
      .filter((file) => file.endsWith('.png'))
      .filter((file) => {
        // `_astro/muse-icon-plum-32.GZ5LHn06.png` — name, hash, extension.
        const emitted = /^_astro\/(.+)\.[A-Za-z0-9_-]{8}\.png$/.exec(file);
        return emitted === null || !stems.has(emitted[1]!);
      });

    expect(unexpected).toEqual([]);
  });

  it('mentions no Sanity client, query or configuration anywhere in the output', () => {
    /**
     * The read path's own markers. If one of these reaches `dist` it means either a query
     * was interpolated into markup or the client was bundled — and both are invisible
     * from a page that renders correctly, because the content would still be on it.
     */
    const markers = [
      '@sanity/client',
      // Both read hosts. MUSE-81 moved the build onto the uncached one, so the cached
      // spelling alone would no longer name the host this build actually talks to —
      // and the client package carries both strings whichever one it is configured for.
      'apicdn.sanity.io',
      'api.sanity.io',
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
    //
    // MUSE-24 added `/events` and `/events/archive` **and a dynamic template**,
    // `src/pages/events/[slug].astro`, which is the first entry under `src/pages/` that
    // emits a page set rather than a page. It emits **none** here, and that is the state
    // the site ships in: there are no `event` documents in `content/seed.ndjson`, so this
    // list is still exhaustive. The assertion below is what says so out loud — a detail
    // page appearing in this build would mean an invented event had reached the seed.
    expect(build.htmlFiles()).toEqual([
      '404.html',
      'aboutus/index.html',
      'contact/index.html',
      'en/aboutus/index.html',
      'en/contact/index.html',
      'en/events/archive/index.html',
      'en/events/index.html',
      'en/index.html',
      'en/pricing/index.html',
      'en/privacy/index.html',
      'en/schedule/index.html',
      'en/whatisbachata/index.html',
      'events/archive/index.html',
      'events/index.html',
      'index.html',
      'pricing/index.html',
      'privacy/index.html',
      'schedule/index.html',
      // MUSE-65's `/whatisbachata`, with the `prosePage` document that makes it buildable.
      'whatisbachata/index.html',
    ]);
  });

  it('emits no event detail page, because the dataset holds no event (MUSE-24)', () => {
    // The other half of the list above, stated as the thing it means rather than left
    // implicit in an enumeration. `/events/<slug>/` is one page per `event` document; the
    // seed has none, and inventing one to make the page look furnished is MUSE-36.
    const details = build
      .htmlFiles()
      .filter((file) => /(?:^|^en\/)events\/(?!archive\/)[^/]+\/index\.html$/.test(file));
    expect(details, 'the committed seed has grown an event').toEqual([]);
  });
});

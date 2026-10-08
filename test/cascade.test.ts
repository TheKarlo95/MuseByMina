import { beforeAll, describe, expect, it } from 'vitest';

import { APEX_DEPLOY, buildSite, PAGES_DEPLOY, type Build } from './helpers/build';
import {
  cascadeReport,
  cssRole,
  EXPECTED_ORDER,
  expectedRoles,
  globalPreludes,
  headSheets,
  layerOffsets,
  scopedPreludes,
} from './helpers/cascade';

/**
 * **MUSE-43 — the cascade order in the built `<head>`, pinned by role.**
 *
 * Astro orders the stylesheets it emits by import-crawl order: `cssOrder` in
 * `astro/dist/core/build/runtime.js` sorts on a number that is the **sum of the import
 * indices** along the chain from a CSS module up to the page. So *where an `import`
 * statement sits in a component's frontmatter decides CSS cascade order in the built
 * `<head>`* — and adding an import, which is the most ordinary edit there is, moves it.
 *
 * It had already happened twice in one afternoon when this was written, on unrelated
 * tickets, by different hands:
 *
 *   - MUSE-35 added a `?url` font import to `BaseLayout.astro`. On `/` and `/en/` the
 *     global stylesheet moved from *before* the homepage's page-scoped `<style>` to
 *     after it. Shipped; nothing was looking.
 *   - MUSE-20 put a read-path import *below* `TrialForm` in `Contact.astro` and swapped
 *     two `<link rel="stylesheet">` tags on `/contact`. Caught only because that
 *     ticket's acceptance criterion was byte-identical output and someone was running
 *     `diff -r`. It was fixed by moving the import up, with a comment beside it — and a
 *     comment next to an import is not a guard, which is why this file exists.
 *
 * Nothing in the suite looked at head order, and the failure mode is silent: a rule
 * stops applying on one page, perhaps in one theme, and the page still renders.
 *
 * **What is asserted, and what is deliberately not.** Not filenames — they are
 * content-hashed, so pinning them would make every CSS edit fail the suite, which is
 * how a guard gets deleted. Not `<link>` versus `<style>` — which of the two a
 * stylesheet becomes is a size threshold (`build.inlineStylesheets: 'auto'`), and the
 * homepage's scoped block would become a `<link>` the day it grows past the limit with
 * its cascade position unchanged. What is asserted is the sequence of *roles*: the
 * global layer, then everything scoped. `test/helpers/cascade.ts` holds the long version
 * of that argument and the parser that answers it.
 */

let pages: Build;
let apex: Build;

beforeAll(async () => {
  pages = buildSite(PAGES_DEPLOY);
  apex = buildSite(APEX_DEPLOY);
}, 240_000);

/**
 * Both deploy targets, read lazily so `beforeAll` has run by the time one is used.
 *
 * Both, because `base` changes every emitted href and therefore the path a `<link>`
 * resolves to — the step this suite has to take to find out what a stylesheet *is*.
 * A guard that only resolved under `BASE=/MuseByMina` would go quiet on the domain move.
 */
const TARGETS: [string, () => Build][] = [
  ['Pages sub-path', () => pages],
  ['apex domain', () => apex],
];

describe.each(TARGETS)('%s', (target, build) => {
  it('serves every page with at least one stylesheet in the head', () => {
    // The order assertions below are vacuously true on a page with no stylesheets, so
    // this is the one that stops them passing by accident (MUSE-37's lesson).
    for (const page of build().htmlFiles()) {
      expect(headSheets(build(), page).length, page).toBeGreaterThan(0);
    }
  });

  it('puts the global layer first in every page head, and nothing global after it', () => {
    for (const page of build().htmlFiles()) {
      const sheets = headSheets(build(), page);
      expect(
        sheets.map((s) => s.role),
        cascadeReport(target, page, sheets),
      ).toEqual(expectedRoles(sheets));
    }
  });

  it('puts the global rules before the scoped ones inside the global stylesheet', () => {
    // The head order is only half of it. `BaseLayout.*.css` is one chunk carrying
    // `globals.css` *and* the scoped styles of the layout, header and footer, so an
    // import that moves inside `BaseLayout.astro` can reorder those two **within the
    // file** and leave the head order untouched. Same cause, same consequence, and a
    // head-order check cannot see it.
    for (const page of build().htmlFiles()) {
      const sheets = headSheets(build(), page);
      const global = sheets.find((s) => s.role === 'global');
      expect(global, `${page}: no stylesheet carries the global layer`).toBeDefined();

      const { global: at, scoped } = layerOffsets(global!.css);
      if (scoped === undefined) continue;
      expect(
        at! < scoped,
        [
          `${global!.label} (${target}, reached from ${page}): the global rules do not`,
          'come first inside the global stylesheet.',
          '',
          `  expected: ${EXPECTED_ORDER}, inside one chunk as well as across the head`,
          `  observed: first scoped rule at byte ${scoped}, first global rule at byte ${at}`,
          '',
          "  `import '../styles/globals.css'` must stay the *first* import in",
          'src/layouts/BaseLayout.astro — below the component imports it is bundled',
          'after their scoped styles. See MUSE-43.',
        ].join('\n'),
      ).toBe(true);
    }
  });

  it('has a page whose head holds more than one stylesheet', () => {
    // Otherwise there is no order to get wrong anywhere and this whole file is inert.
    const counts = build()
      .htmlFiles()
      .map((page) => headSheets(build(), page).length);
    expect(Math.max(...counts)).toBeGreaterThan(1);
  });
});

/**
 * The role parser, checked against its own corner cases.
 *
 * A content sniffer that answered "global" for every component sheet, or "scoped" for
 * the globals, would make the assertions above pass on any output at all. These are the
 * shapes that actually occur in `dist` plus the two that would fool a naive reading.
 */
describe('what counts as the global layer', () => {
  it('reads an @font-face block as global', () => {
    expect(cssRole('@font-face{font-family:X;src:url(a.woff2)}')).toBe('global');
  });

  it('reads a :root token block as global', () => {
    expect(cssRole(':root{--ink:#2b2b2b}')).toBe('global');
  });

  it('reads a bare element selector as global', () => {
    expect(cssRole('p{margin:0}')).toBe('global');
  });

  it('reads a fully scoped sheet as scoped', () => {
    expect(cssRole('.hero[data-astro-cid-abc]{color:red}')).toBe('scoped');
  });

  it('is not fooled by a @media wrapper around scoped rules', () => {
    const css = '@media (min-width:40em){.hero[data-astro-cid-abc]{color:red}}';
    expect(cssRole(css)).toBe('scoped');
  });

  it('is not fooled by @keyframes offsets, which are not selectors', () => {
    const css = '@keyframes rise{0%{opacity:0}to{opacity:1}}.x[data-astro-cid-abc]{color:red}';
    expect(cssRole(css)).toBe('scoped');
  });

  it('is not fooled by a brace inside a string', () => {
    const css = '.x[data-astro-cid-abc]::after{content:"}"}';
    expect(cssRole(css)).toBe('scoped');
  });

  it('calls a sheet holding both layers global, and says where each starts', () => {
    const css = ':root{--a:1px}.x[data-astro-cid-abc]{color:red}';
    expect(cssRole(css)).toBe('global');
    expect(globalPreludes(css)).toEqual([':root']);
    expect(scopedPreludes(css)).toEqual(['.x[data-astro-cid-abc]']);
    const { global, scoped } = layerOffsets(css);
    expect(global).toBeLessThan(scoped!);
  });

  it('ignores a selector that is only in a comment', () => {
    expect(cssRole('/* p{margin:0} */.x[data-astro-cid-abc]{color:red}')).toBe('scoped');
  });
});

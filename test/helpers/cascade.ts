import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { assetFile, type Build } from './build';

/**
 * **What a built page's `<head>` says about the cascade (MUSE-43).**
 *
 * Astro orders the stylesheets it emits by *import-crawl order* — `cssOrder` in
 * `astro/dist/core/build/runtime.js` sorts on a number that is the **sum of the import
 * indices** along the chain from a CSS module up to the page. So the position of an
 * `import` statement in a component's frontmatter decides CSS cascade order in the
 * built `<head>`, and adding one import above another silently reorders two layers.
 *
 * This module turns a built page into the one thing worth asserting about that: the
 * sequence of *roles* in the head, where a role is "does this stylesheet carry the
 * global layer or is every rule in it scoped to one component". Roles rather than
 * filenames, because the filenames are content-hashed — pinning them would make every
 * CSS edit fail the suite, which is how a guard gets deleted. Roles rather than
 * `<link>`-versus-`<style>`, because which of the two a stylesheet becomes is a size
 * threshold (`build.inlineStylesheets: 'auto'`), not a statement about the cascade: the
 * homepage's page-scoped block is inline today and would be a `<link>` the day it grows
 * past the limit, with its cascade position unchanged.
 */

/**
 * What a stylesheet does to the document.
 *
 * - `global` — it declares at least one thing at document level: an `@font-face`, a
 *   `:root` custom-property block, a bare element selector. These are the foundation
 *   (`src/styles/globals.css` → fonts, tokens, base) and they must be *overridable*.
 * - `scoped` — every selector in it carries `[data-astro-cid-…]`, so it only ever
 *   applies to one component's markup.
 *
 * A sheet that holds both is `global`: it is the one carrying the layer, and that is
 * exactly today's `BaseLayout.*.css`, which bundles the globals together with the
 * scoped styles of the layout, header and footer.
 */
export type CssRole = 'global' | 'scoped';

/** One stylesheet in a page's `<head>`, in document order. */
export interface HeadSheet {
  /** `<link>` or `<style>`. Reported, never asserted on — see the note above. */
  delivery: 'link' | 'style';
  /**
   * Something a human can look up: the emitted path for a `<link>`, a byte count and
   * the first selector for an inline block. Failure messages only.
   */
  label: string;
  role: CssRole;
  /** The stylesheet's text, so a caller can ask where inside it the global layer sits. */
  css: string;
  /**
   * The component this stylesheet was emitted for, as a repo path, when the chunk name
   * gives it away (`_astro/TrialForm.CcCBMyw_.css` → `src/components/TrialForm.astro`).
   *
   * This is the actionable half of a failure. The cause of a reordered head is an
   * `import` that moved in some component's frontmatter, and the chunk names are the
   * only thing in `dist` that points back at which one.
   */
  origin?: string;
}

const SCOPE_ATTR = '[data-astro-cid-';

/**
 * At-rules whose *block* still contains rules that match elements, so the selectors
 * inside them count. A `@media` wrapper does not make a scoped sheet global.
 */
const CONDITIONAL_AT_RULES = new Set([
  'media',
  'supports',
  'layer',
  'container',
  'scope',
  'starting-style',
]);

/**
 * At-rules that are themselves a document-level declaration. `@font-face` is the one
 * that matters here: six of them sit in `src/styles/fonts.css` and nothing scoped may
 * declare one.
 *
 * `@keyframes` is deliberately absent, and is skipped rather than counted: its `0%` and
 * `from` preludes are offsets, not selectors, so reading them as unscoped selectors
 * would make every component sheet that animates anything look global.
 */
const GLOBAL_AT_RULES = new Set([
  'font-face',
  'import',
  'property',
  'page',
  'counter-style',
  'font-feature-values',
]);

/** `css` with comments removed, so a commented-out selector cannot vote. */
function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Index of the `}` closing the block that opens at `open`, or the end of the string. */
function closeOf(css: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < css.length; i += 1) {
    const c = css[i]!;
    if (quote) {
      if (c === '\\') i += 1;
      else if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return css.length;
}

/**
 * Every prelude in `css` that a browser evaluates against the document, in source
 * order — selector lists and the document-level at-rules, descending through
 * conditional groups and stepping over `@keyframes`.
 */
function preludes(css: string): string[] {
  const out: string[] = [];

  const walk = (text: string): void => {
    let buf = '';
    let quote = '';
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i]!;
      if (quote) {
        buf += c;
        if (c === '\\') {
          buf += text[i + 1] ?? '';
          i += 1;
        } else if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") {
        quote = c;
        buf += c;
        continue;
      }
      if (c === ';') {
        // A statement at-rule — `@import`, `@charset`, `@namespace`.
        const prelude = buf.trim();
        if (prelude.startsWith('@')) out.push(prelude);
        buf = '';
        continue;
      }
      if (c !== '{') {
        buf += c;
        continue;
      }

      const prelude = buf.trim();
      buf = '';
      const end = closeOf(text, i);
      const body = text.slice(i + 1, end);
      i = end;

      if (!prelude.startsWith('@')) {
        out.push(prelude);
        continue;
      }
      const name = (/^@([\w-]+)/.exec(prelude)?.[1] ?? '').toLowerCase();
      if (CONDITIONAL_AT_RULES.has(name)) {
        walk(body);
      } else if (GLOBAL_AT_RULES.has(name)) {
        out.push(prelude);
      }
      // Anything else — `@keyframes` above all — declares nothing that matches an
      // element, so neither it nor its body votes.
    }
  };

  walk(stripComments(css));
  return out;
}

/** Is every selector in `prelude` scoped to a single Astro component? */
function isScoped(prelude: string): boolean {
  if (prelude.startsWith('@')) return false;
  const selectors = prelude.split(',').filter((s) => s.trim() !== '');
  return selectors.length > 0 && selectors.every((s) => s.includes(SCOPE_ATTR));
}

/** The document-level preludes in `css`, in source order. Empty means fully scoped. */
export function globalPreludes(css: string): string[] {
  return preludes(css).filter((p) => !isScoped(p));
}

/** The component-scoped preludes in `css`, in source order. */
export function scopedPreludes(css: string): string[] {
  return preludes(css).filter(isScoped);
}

/** See `CssRole`. */
export function cssRole(css: string): CssRole {
  return globalPreludes(css).length > 0 ? 'global' : 'scoped';
}

/**
 * Where inside one stylesheet its global layer begins and its scoped rules begin, as
 * character offsets, or `undefined` for a layer the sheet does not have.
 *
 * The head order is only half the question. `BaseLayout.*.css` is a single chunk holding
 * `globals.css` *and* the scoped styles of the layout, header and footer, so moving an
 * import inside `BaseLayout.astro` can reorder those two **within** the file and leave
 * the head order untouched. Same cause, same consequence, invisible to a head-order
 * check.
 */
export function layerOffsets(css: string): {
  global?: number;
  scoped?: number;
} {
  const clean = stripComments(css);
  const first = (prelude: string | undefined): number | undefined =>
    prelude === undefined ? undefined : clean.indexOf(prelude);
  return {
    global: first(globalPreludes(clean)[0]),
    scoped: first(scopedPreludes(clean)[0]),
  };
}

/**
 * The repo file a chunk was named after, if one exists.
 *
 * Astro names a CSS chunk after the component it was reached through, so
 * `_astro/TrialForm.CcCBMyw_.css` points at `TrialForm.astro`. Used for the failure
 * message and nothing else — the assertion must not key on a filename.
 */
function originOf(outputPath: string): string | undefined {
  const base = outputPath.split('/').pop() ?? '';
  const name = base.replace(/\.[\w-]+\.css$/, '');
  if (name === base) return undefined;
  for (const dir of ['src/layouts', 'src/components', 'src/pages']) {
    const candidate = `${dir}/${name}.astro`;
    // Resolved against the checkout, not against `dist`: the answer is about `src/`
    // and is the same under both deploy targets.
    if (existsSync(fileURLToPath(new URL(`../../${candidate}`, import.meta.url)))) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Every stylesheet in `page`'s `<head>`, in document order, with its role resolved.
 *
 * `<head>` only. A `<style>` in the body would be a different question, and Astro puts
 * none there.
 */
export function headSheets(build: Build, page: string): HeadSheet[] {
  const html = build.read(page);
  const headEnd = html.indexOf('</head>');
  const head = headEnd === -1 ? html : html.slice(0, headEnd);

  const sheets: HeadSheet[] = [];
  const pattern = /<link\b[^>]*>|<style\b[^>]*>([\s\S]*?)<\/style>/g;

  for (const m of head.matchAll(pattern)) {
    if (m[0].startsWith('<link')) {
      if (!/rel\s*=\s*["']?stylesheet/i.test(m[0])) continue;
      const href = /href\s*=\s*"([^"]*)"/.exec(m[0])?.[1];
      if (href === undefined) continue;
      const file = assetFile(build, href);
      const css = file !== undefined && build.isFile(file) ? build.read(file) : '';
      sheets.push({
        delivery: 'link',
        label: file ?? href,
        role: cssRole(css),
        css,
        origin: file === undefined ? undefined : originOf(file),
      });
      continue;
    }
    const css = m[1] ?? '';
    sheets.push({
      delivery: 'style',
      label: `inline, ${css.length} b, starting ${firstSelector(css)}`,
      role: cssRole(css),
      css,
    });
  }

  return sheets;
}

/** The first prelude in `css`, trimmed for a one-line failure message. */
function firstSelector(css: string): string {
  const first = preludes(css)[0] ?? '(no rules)';
  return first.length > 60 ? `${first.slice(0, 57)}…` : first;
}

/**
 * **The order this project pins, and why.**
 *
 * The global layer first, every scoped stylesheet after it. That is Astro's own
 * documented cascade — "`<link>` tags in the head (lowest precedence), imported styles,
 * scoped styles (highest)", and the tip beside it: *import the layout component before
 * other imports so that it has the lowest precedence*. It is also the only order the
 * design system can work in: `src/styles/globals.css` is `@font-face`, `:root` tokens,
 * resets and element defaults, and a component must be able to override an element
 * default at equal specificity. Put the globals last and the foundation wins every tie
 * instead of losing it — and `font-variant-numeric` is single-valued, so a global
 * `:root` winning one is how MUSE-14's `II:OO` comes back with the column still neatly
 * aligned. No pair of rules ties today, which is why the move is visually inert; that
 * is a property of this afternoon's CSS and one `:global()` undoes it.
 *
 * So this is a restoration, not a pin of whatever today's output happens to be: MUSE-35
 * and MUSE-20 between them left the global sheet *last* on all nine pages.
 */
export const EXPECTED_ORDER = 'the global layer first, then every scoped stylesheet';

/** The role sequence this project requires for a page with `sheets` stylesheets. */
export function expectedRoles(sheets: readonly HeadSheet[]): CssRole[] {
  return sheets.map((_, i) => (i === 0 ? 'global' : 'scoped'));
}

/**
 * A failure message that points at the cause rather than the symptom.
 *
 * The symptom is "a rule stopped applying on one page, maybe in one theme". The cause is
 * an `import` that moved in a component's frontmatter, which is the most ordinary edit
 * there is and is nowhere near the page that breaks. So the message names the suspects
 * by file — the chunk names in `dist` are the only thread back to them.
 */
export function cascadeReport(
  target: string,
  page: string,
  sheets: readonly HeadSheet[],
): string {
  const rows = sheets.map((s, i) => {
    const origin = s.origin ? `  (${s.origin})` : '';
    return `    ${i + 1}. ${s.role.padEnd(6)} <${s.delivery}> ${s.label}${origin}`;
  });

  const suspects = [
    'src/layouts/BaseLayout.astro',
    ...sheets.flatMap((s) => (s.origin ? [s.origin] : [])),
  ].filter((file, i, all) => all.indexOf(file) === i);

  return [
    `${page} (${target}): the stylesheet order in <head> is not the pinned one.`,
    '',
    `  expected: ${EXPECTED_ORDER}`,
    '  observed:',
    ...rows,
    '',
    '  Astro orders stylesheets by import-crawl order, so an import was almost',
    '  certainly reordered — or a new one added — in the frontmatter of one of:',
    ...suspects.map((f) => `    - ${f}`),
    '',
    "  The global import must stay first in the layout's frontmatter, and the layout",
    '  must stay first in the page wrapper. See MUSE-43 and the note in',
    '  test/helpers/cascade.ts.',
  ].join('\n');
}

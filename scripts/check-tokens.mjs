import { globSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Design-system compliance — `npm run ds`.
 *
 * Rules the spec states once and every component then has to remember. All of them fail
 * *silently* — the CSS is valid, the page renders, and the damage is only visible in the
 * other theme, at 4x zoom, or in a screenshot nobody takes. So they are checked rather
 * than written down.
 *
 * 1. COLOUR — "Components never reference a brand colour. They reference a role." Gold on
 *    cream is 2.02:1 and fails every threshold, so a literal that looks fine in dark will
 *    be unreadable in light. `--accent` simply IS gold in dark and gold-deep in light —
 *    use the role and it cannot go wrong. Three spellings are checked, because a brand
 *    colour has three: a hex literal, a colour function with literal channels, and
 *    `var(--gold)`.
 *
 *    The chrome band is not an exception any more: §12's fixed band has its own role set
 *    (`--band-*` in `tokens.css`), so the header and the footer reference a role like
 *    everything else. What is left is the *token layer* and two rasters, and each one is a
 *    named entry in `EXEMPTIONS` below rather than a directory the scan skips.
 *
 * 2. NUMERALS — `font-variant-numeric` is set **twice**, both times in
 *    `src/styles/base.css`, and nowhere else. Cormorant's default figures are old-style,
 *    so `19:00` renders `I9:OO`; the `:root` rule asks for `lining-nums tabular-nums` and
 *    prose inherits it. **Form controls do not inherit it** — the UA stylesheet gives
 *    `input`, `select`, `textarea` and `button` their own `font` *shorthand*, and a
 *    shorthand resets every sub-property it does not mention, so the declaration never
 *    arrives there and no ordering or `!important` on `:root` can reach it. The second
 *    rule names those elements plus `optgroup`, `option` and `::file-selector-button`; it
 *    is part of the fix, not a nicety (MUSE-57).
 *
 *    The property is a single inherited value, so a component that writes
 *    `font-variant-numeric: tabular-nums` REPLACES the document's value instead of adding
 *    to it — the column still aligns, the computed style still looks deliberate, and the
 *    times are unreadable again. That is exactly how MUSE-14 shipped, and MUSE-43 and
 *    MUSE-57 are the same rule paid for twice more.
 *
 *    **So the rule has a floor as well as a ceiling** (`numeralsHome`, which is MUSE-35's
 *    argument about the font count): refusing the property in a component is worth
 *    nothing if somebody has deleted the document rule it protects, and of the two rules
 *    the second is the one a reader is most likely to think redundant. This header is the
 *    surface that reader lands on, and until MUSE-118 it said the property was "set once
 *    for the whole document" — the sentence that would have told them to go ahead.
 *
 * 3. SHADOW — "There are no drop shadows in this system, in either theme." Depth is
 *    surface value plus hairlines (§5). `box-shadow`, `text-shadow` and `drop-shadow()`
 *    were enforced by four hand-written per-component assertions covering four of roughly
 *    fourteen components, which is how `Gallery.astro` — the lightbox, the surface on
 *    this site a shadow is most likely to be added to — shipped with no assertion at all
 *    (MUSE-99). `: none` is allowed: it adds no depth, and resetting a UA shadow on a
 *    control is legitimate.
 *
 * ## The instrument: regions and offsets, not lines
 *
 * This was a per-line text scan and six spellings walked past it (MUSE-99). Two of the
 * six were unfixable in principle by *any* regex, because neither question is about a
 * line:
 *
 *   - **Comments.** The old scan skipped a line beginning with `*`, in order to skip the
 *     continuation lines of a block comment. A CSS line beginning with `*` is also the
 *     universal selector, so `*, .band { color: #C8A96A }` was skipped entirely — hex,
 *     brand `var()` and numerals alike. Comments are now blanked by a scanner that tracks
 *     the comment and string state of each region, so a hex quoted mid-comment is still
 *     documentation (this file and several components rely on that) and a declaration is
 *     still read.
 *   - **A value split across lines.** The brand-variable rule needed `var(` and `--gold`
 *     on one line, and Prettier produces the split form on a long declaration. Rules are
 *     matched over the whole blanked region and an offence's line comes from the match
 *     *offset*, so a declaration may span as many lines as it likes.
 *
 * A region is CSS, code or markup, decided by the file extension and, for `.astro`, by
 * the frontmatter fence and the `<style>` / `<script>` boundaries. The comment and string
 * syntax differs per kind — CSS has no `//` comment and `https://` is not one — and
 * blanking preserves offsets, so every line number in a report is the line in the file.
 *
 * `postcss` would parse the CSS properly and is in the tree transitively via Vite. It is
 * not used here, for three reasons: taking it means *declaring* it (the
 * `styled-components` rule — a peer dependency that resolves anyway is still an
 * undeclared dependency), `package.json` is outside this branch, and it would cover only
 * the CSS third of what is scanned, while `theme-color` in markup and a hex in a `.ts`
 * raster constant are both real sites. What replaces a parser is that **every rule here
 * is called as a function against fixed inputs by `test/checktokens.test.ts`**, at no
 * heavyweight cost — which is what MUSE-118 was filed about: the numerals regex could be
 * deleted and `npm run ds` still reported `50 files clean`.
 *
 * ## The opt-out
 *
 * `ds-allow` on a line carrying a declaration exempts **that line**. In a comment of its
 * own it exempts the run it introduces, and the run is bounded four ways: a blank line, a
 * line carrying a brace (that line included — a brace is the end of the thing the note is
 * written above), the first non-offending line once an offending one has been covered,
 * and the end of the file. It used to be cleared only by a blank line, and CSS blocks
 * rarely contain one, so one note exempted the rest of the file and QA bought three
 * violations with a single comment. A run rather than one declaration because the only
 * real note in the tree covers a *pair* — the two `theme-color` metas, which are one fact
 * stated for the two colour schemes — and every honoured exemption is printed, so the
 * scope is in the log rather than implied.
 */

/**
 * Where the rules apply.
 *
 * `src/styles` and `src/lib` were outside this until MUSE-99, which is the escape with
 * nothing clever about it: a stylesheet under `src/styles/` imported by a component is in
 * that component's graph and was simply never read, and `src/lib/` holds two real brand
 * literals. The file count moving is how a reader can tell a directory is being read.
 */
export const SCAN = ['src/components', 'src/layouts', 'src/pages', 'src/styles', 'src/lib'];

/** The file kinds that can carry a style declaration. */
export const EXTENSIONS = ['astro', 'ts', 'css'];

/**
 * The one file `font-variant-numeric` may be declared in, and the two rules it must carry.
 *
 * Not a directory and not "the typography layer": MUSE-57's criterion is that the rule
 * lives *beside* the `:root` declaration in this one file, because the property is a
 * single value and two files declaring it is two answers to one question.
 */
export const NUMERALS_HOME = 'src/styles/base.css';

/** The elements the UA's `font` shorthand resets the property on (MUSE-57). */
export const UNINHERITING = [
  'input',
  'select',
  'textarea',
  'button',
  'optgroup',
  'option',
  '::file-selector-button',
];

/**
 * **Where a brand colour is allowed, each entry with its reason, each asserted still
 * live.**
 *
 * Deliberately not a skip list — MUSE-45's ruling, that a skip list is MUSE-19's
 * allow-list wearing the other hat. A skip list names a *file* and stops reading it; each
 * entry here names a file **and the shape of the declaration** it excuses, so everything
 * else in that same file is still read. `test/checktokens.test.ts` takes each entry away
 * in turn and requires the gate to report what it was covering, so an entry that has
 * stopped being necessary is a red test asking for its deletion — the way
 * `REBUILT_FROM_PARTS` and `test/contentdrift.test.ts`'s exemptions work.
 *
 *   - `customProperty` — the match must sit in the value of a `--x:` declaration.
 *   - `anchor` — the match's own line must also name this identifier.
 */
export const EXEMPTIONS = [
  {
    file: 'src/styles/tokens.css',
    customProperty: true,
    why:
      'the token layer itself: §1 is the brand palette and §2–3 map the role tokens onto ' +
      'it, so this is the one file where a brand colour is the subject rather than a ' +
      'reference. Scoped to custom-property declarations, so `color: #420535` here is ' +
      'still an offence — defining a token and using one are different acts.',
  },
  {
    file: 'src/lib/share-card.ts',
    anchor: 'SHARE_CARD_GROUND',
    why:
      'the share card is a raster, drawn by us and read by somebody else’s chat client ' +
      '(MUSE-69). A PNG ground takes no custom property and no theme follows it — the ' +
      'card is opaque plum by construction, because a transparent one is composited ' +
      'against whatever bubble the client happens to use.',
  },
  {
    file: 'src/lib/icon.ts',
    anchor: 'ICON_COLOURS',
    why:
      'the tab icons are rasters too, and these are §12’s two inks: the supplied white ' +
      'mark and its plum recolour, RGB replaced with the alpha preserved (MUSE-40). A ' +
      'tab strip is not a page and cannot read a stylesheet.',
  },
];

/** A brand hex. 3, 4, 6 or 8 digits — the alpha pair is how `#420535e6` got past `\b`. */
const HEX = /#([0-9a-fA-F]{3,8})(?![0-9a-fA-F])/g;

/** The digit counts CSS actually accepts. 5 or 7 is a typo, not a colour. */
const HEX_LENGTHS = new Set([3, 4, 6, 8]);

/**
 * A colour function, modern or otherwise. `color-mix` precedes `color` so it wins.
 *
 * Nothing matched these at all, so `color: rgb(200 169 106)` — §13's gold, to the digit —
 * was invisible. A call whose arguments reference a `var(--role)` is a role token being
 * adjusted and is allowed: `color-mix(in srgb, var(--band-surface) 96%, transparent)` is
 * what `Gallery.astro` legitimately does, and a literal mixed in beside a role is caught
 * by the hex rule on the same declaration.
 */
const COLOUR_FN = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix|color)\(/g;

/** A brand colour variable, which may be split across lines by any amount of space. */
const BRAND_VAR = /var\(\s*--(plum|gold|cream|red|green)[\w-]*\s*[,)]/g;

/** The numerals properties, in property position. */
const NUMERALS = /(?:^|[;{}\s])(font-variant-numeric|font-feature-settings)\s*:/g;

/** `box-shadow` and `text-shadow`, prefixed or not, with the value they are given. */
const SHADOW = /(?:^|[;{}\s])(?:-webkit-|-moz-)?((?:box|text)-shadow)\s*:([^;}]*)/g;

/** `drop-shadow()`, which arrives through `filter` and `backdrop-filter`. */
const DROP_SHADOW = /\bdrop-shadow\s*\(/g;

/** The opt-out note. */
const ALLOW = /ds-allow/g;

/* ------------------------------------------------------------------ regions and comments */

/** Which comment and string syntax a stretch of a file uses. */
const SYNTAX = {
  css: { block: true, line: false, html: false, jsx: false, strings: '\'"' },
  code: { block: true, line: true, html: false, jsx: false, strings: '\'"`' },
  markup: { block: false, line: false, html: true, jsx: true, strings: '' },
};

/** @typedef {keyof typeof SYNTAX} RegionKind */

/** @typedef {{ start: number, end: number }} Range */

/**
 * Split a file into stretches of one syntax each.
 *
 * `.css` and `.ts` are one region. An `.astro` file is its frontmatter (code), its
 * `<style>` blocks (CSS), its `<script>` blocks (code) and the markup between them — and
 * the markup matters: the two `theme-color` metas are brand literals in an attribute
 * rather than in a stylesheet.
 *
 * @returns {{ kind: RegionKind, start: number, end: number }[]}
 */
export function regionsOf(/** @type {string} */ file, /** @type {string} */ text) {
  if (file.endsWith('.css')) return [{ kind: 'css', start: 0, end: text.length }];
  if (!file.endsWith('.astro')) return [{ kind: 'code', start: 0, end: text.length }];

  /** @type {{ kind: RegionKind, start: number, end: number }[]} */
  const regions = [];
  let at = 0;

  if (text.startsWith('---')) {
    const close = text.indexOf('\n---', 3);
    if (close !== -1) {
      const after = text.indexOf('\n', close + 1);
      at = after === -1 ? text.length : after + 1;
      regions.push({ kind: 'code', start: 3, end: close });
    }
  }

  const embedded = /<(style|script)\b[^>]*>/gi;
  embedded.lastIndex = at;
  let open = embedded.exec(text);
  while (open) {
    const tag = open[1].toLowerCase();
    const bodyStart = open.index + open[0].length;

    // `<script is:inline set:html={…} />` has no body, and this layout's four scripts are
    // all spelled that way. Reading one as an opening tag and looking for `</script>`
    // swallowed the rest of the document into a code region, which is how the two
    // `theme-color` metas lost their `ds-allow` note: their braces were being read as CSS.
    if (open[0].endsWith('/>')) {
      embedded.lastIndex = bodyStart;
      open = embedded.exec(text);
      continue;
    }
    const closeAt = text.toLowerCase().indexOf(`</${tag}`, bodyStart);
    const bodyEnd = closeAt === -1 ? text.length : closeAt;

    regions.push({ kind: 'markup', start: at, end: open.index });
    regions.push({ kind: tag === 'style' ? 'css' : 'code', start: bodyStart, end: bodyEnd });

    at = bodyEnd;
    embedded.lastIndex = bodyEnd;
    open = embedded.exec(text);
  }

  regions.push({ kind: 'markup', start: at, end: text.length });
  return regions.filter((region) => region.end > region.start);
}

/**
 * Blank every comment in one region, keeping the text the same length, and say where the
 * comments were.
 *
 * Offsets are preserved so a line number is still the line in the file, which is the
 * whole reason this is a blanking pass rather than a `split('\n')`. Strings are kept —
 * `content="#420535"` is the declaration, not a comment — and tracking them is what stops
 * a `*` and a slash inside a `url()` from ending a comment that never started. In markup
 * the braces of a JSX comment expression are blanked with the comment, because a
 * leftover brace would read as the end of a CSS block.
 */
function scanRegion(/** @type {string} */ text, /** @type {RegionKind} */ kind) {
  const syntax = SYNTAX[kind];
  const out = text.split('');
  /** @type {Range[]} */
  const ranges = [];
  let i = 0;

  const blank = (/** @type {number} */ from, /** @type {number} */ to) => {
    for (let j = from; j < to && j < out.length; j += 1) {
      if (out[j] !== '\n') out[j] = ' ';
    }
    ranges.push({ start: from, end: Math.min(to, out.length) });
  };

  const run = (/** @type {string} */ opener, /** @type {string} */ closer) => {
    const end = text.indexOf(closer, i + opener.length);
    const stop = end === -1 ? text.length : end + closer.length;
    blank(i, stop);
    i = stop;
  };

  while (i < text.length) {
    if (syntax.jsx && text.startsWith('{/*', i)) {
      run('{/*', '*/}');
      continue;
    }
    if (syntax.block && text.startsWith('/*', i)) {
      run('/*', '*/');
      continue;
    }
    if (syntax.html && text.startsWith('<!--', i)) {
      run('<!--', '-->');
      continue;
    }
    if (syntax.line && text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      blank(i, end === -1 ? text.length : end);
      i = end === -1 ? text.length : end;
      continue;
    }
    if (syntax.strings.includes(text[i])) {
      const quote = text[i];
      let j = i + 1;
      while (j < text.length && text[j] !== quote) {
        if (text[j] === '\\') j += 1;
        else if (quote !== '`' && text[j] === '\n') break;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    i += 1;
  }

  return { blanked: out.join(''), ranges };
}

/** One region's text with its comments blanked. Exported so a test can drive it alone. */
export function blankComments(/** @type {string} */ text, /** @type {RegionKind} */ kind) {
  return scanRegion(text, kind).blanked;
}

/** The whole file with every comment blanked, region by region, plus the comment ranges. */
export function blankedSource(/** @type {string} */ file, /** @type {string} */ text) {
  let blanked = text;
  const comments = [];

  for (const { kind, start, end } of regionsOf(file, text)) {
    const region = scanRegion(text.slice(start, end), kind);
    blanked = blanked.slice(0, start) + region.blanked + blanked.slice(end);
    for (const range of region.ranges) {
      comments.push({ start: start + range.start, end: start + range.end });
    }
  }

  return { blanked, comments };
}

/** 1-based line number of an offset. */
function lineAt(/** @type {string} */ text, /** @type {number} */ offset) {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/** The declaration an offset sits in: everything back to the previous `;`, `{` or `}`. */
function declarationAt(/** @type {string} */ blanked, /** @type {number} */ offset) {
  let start = offset;
  while (start > 0 && !';{}'.includes(blanked[start - 1])) start -= 1;
  const chunk = blanked.slice(start, offset);
  const colon = chunk.indexOf(':');
  return colon === -1 ? null : chunk.slice(0, colon).trim();
}

/** The matching close paren for the open paren at `open`. */
function closingParen(/** @type {string} */ text, /** @type {number} */ open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

/* ------------------------------------------------------------------------------ the rules */

/** Every offence in one file, before the opt-out and the named exemptions are applied. */
function rawOffences(/** @type {string} */ file, /** @type {string} */ blanked) {
  /** @type {{ file: string, line: number, offset: number, rule: string, what: string }[]} */
  const found = [];
  const push = (
    /** @type {number} */ offset,
    /** @type {string} */ rule,
    /** @type {string} */ what,
  ) => found.push({ file, line: lineAt(blanked, offset), offset, rule, what });

  // A `#` after a word character, a `/` or an `&` is a URL fragment or an HTML entity,
  // never a colour: `url(x.svg#abcdef)`, `https://…/#abc123`, `&#128169;`. The residual
  // false positive, stated rather than left to be discovered: an `href="#abc123"` whose
  // fragment happens to be three to eight hex digits reads as a colour here. No anchor on
  // the site is spelled that way — they are `#main` and `#trial` — and the opt-out is what
  // the next one takes.
  for (const match of blanked.matchAll(HEX)) {
    if (!HEX_LENGTHS.has(match[1].length)) continue;
    if (/[\w&/]/.test(blanked[match.index - 1] ?? '')) continue;
    push(match.index, 'hex', `hard-coded hex #${match[1]}`);
  }

  for (const match of blanked.matchAll(COLOUR_FN)) {
    const open = match.index + match[0].length - 1;
    const args = blanked.slice(open + 1, closingParen(blanked, open));
    if (args.includes('var(--')) continue;
    push(match.index, 'colour-function', `literal colour ${match[1]}(${args.trim()})`);
  }

  for (const match of blanked.matchAll(BRAND_VAR)) {
    push(match.index, 'brand-var', `brand colour variable --${match[1]}`);
  }

  if (file !== NUMERALS_HOME) {
    for (const match of blanked.matchAll(NUMERALS)) {
      push(match.index, 'numerals', `${match[1]} declared outside ${NUMERALS_HOME}`);
    }
  }

  for (const match of blanked.matchAll(SHADOW)) {
    if (match[2].trim() === 'none') continue;
    push(match.index, 'shadow', `${match[1]}: ${match[2].trim()}`);
  }

  for (const match of blanked.matchAll(DROP_SHADOW)) {
    push(match.index, 'shadow', 'drop-shadow()');
  }

  return found.sort((a, b) => a.offset - b.offset || a.rule.localeCompare(b.rule));
}

/**
 * The lines a `ds-allow` note exempts, and the note that exempts each.
 *
 * On a line that carries a declaration the note covers that line. In a comment of its own
 * it covers the run it introduces, bounded as the header describes. The comment's extent
 * comes from the blanking pass rather than from looking for a terminator, so a note in a
 * line comment, a block comment and a JSX comment expression are all one case.
 */
function allowedLines(
  /** @type {string} */ text,
  /** @type {string} */ blanked,
  /** @type {Range[]} */ comments,
  /** @type {any} */ offending,
) {
  const lines = blanked.split('\n');
  const hasCode = lines.map((line) => line.trim() !== '');
  const allowed = new Map();

  for (const note of text.matchAll(ALLOW)) {
    const noteLine = lineAt(text, note.index);
    const breakAt = text.indexOf('\n', note.index);
    const reason = text.slice(note.index, breakAt === -1 ? text.length : breakAt).trim();

    if (hasCode[noteLine - 1]) {
      allowed.set(noteLine, reason);
      continue;
    }

    const comment = comments.find(({ start, end }) => note.index >= start && note.index < end);
    const last = comment ? lineAt(text, comment.end - 1) : noteLine;

    let covered = 0;
    for (let line = last + 1; line <= lines.length; line += 1) {
      if (!hasCode[line - 1]) break;
      allowed.set(line, reason);
      if (/[{}]/.test(lines[line - 1])) break;
      if (offending.has(line)) covered += 1;
      if (covered > 0 && !offending.has(line + 1)) break;
    }
  }

  return allowed;
}

/** Whether a named exemption covers this offence. */
function exempts(
  /** @type {any} */ entry,
  /** @type {string} */ blanked,
  /** @type {{ offset: number, line: number }} */ found,
) {
  if (entry.customProperty) {
    const property = declarationAt(blanked, found.offset);
    return property !== null && property.startsWith('--');
  }
  if (entry.anchor) {
    return (blanked.split('\n')[found.line - 1] ?? '').includes(entry.anchor);
  }
  return false;
}

/**
 * Every offence in one file, with the opt-out and the named exemptions applied.
 *
 * `exemptions` is a parameter so a test can take one entry away and require the gate to
 * report what that entry was covering. An exemption only ever excuses a colour rule:
 * numerals have one home and shadows have none, so there is nothing an exemption could
 * say about either.
 */
export function findOffences(
  /** @type {string} */ file,
  /** @type {string} */ text,
  { exemptions = EXEMPTIONS } = {},
) {
  const { blanked, comments } = blankedSource(file, text);
  const raw = rawOffences(file, blanked);
  const offending = new Set(raw.map(({ line }) => line));
  const allowed = allowedLines(text, blanked, comments, offending);
  const entries = exemptions.filter((entry) => entry.file === file);

  const offences = [];
  const honoured = [];

  for (const found of raw) {
    const note = allowed.get(found.line);
    if (note) {
      honoured.push({ ...found, by: 'ds-allow', why: note });
      continue;
    }
    const entry = entries.find((candidate) => exempts(candidate, blanked, found));
    if (entry) {
      honoured.push({ ...found, by: entry.file, why: entry.why });
      continue;
    }
    offences.push(found);
  }

  return { offences, honoured };
}

/**
 * **The floor under the numerals rule** (MUSE-118, and MUSE-35's argument about the font
 * count): a ceiling alone reads a page with no fonts served at all as the leanest it has
 * ever seen, and a gate that refuses the property in a component is worth nothing if the
 * document rule it protects has been deleted. Both rules are required, because of the two
 * the second is the one a reader thinks is redundant — this file's own header told them
 * it was, until MUSE-118.
 */
export function numeralsHome(/** @type {string} */ text) {
  const blanked = blankComments(text, 'css');
  const declarations = [...blanked.matchAll(/font-variant-numeric\s*:([^;}]*)/g)].map(
    (match) => {
      const open = blanked.lastIndexOf('{', match.index);
      const previous = Math.max(
        blanked.lastIndexOf('}', open),
        blanked.lastIndexOf('{', open - 1),
      );
      return {
        selectors: blanked
          .slice(previous + 1, open)
          .split(',')
          .map((part) => part.trim()),
        value: match[1].trim(),
        line: lineAt(blanked, match.index),
      };
    },
  );

  const missing = [];

  const root = declarations.find(({ selectors }) => selectors.join() === ':root');
  if (!root || !/lining-nums/.test(root.value) || !/tabular-nums/.test(root.value)) {
    missing.push('the `:root` rule asking for `lining-nums tabular-nums` (MUSE-14)');
  }

  const controls = declarations.find(({ selectors }) =>
    UNINHERITING.every((element) => selectors.includes(element)),
  );
  if (!controls) {
    missing.push(
      `the rule naming ${UNINHERITING.join(', ')} — a form control does not inherit the ` +
        'property, because the UA’s `font` shorthand resets it (MUSE-57)',
    );
  }

  if (declarations.length > 2) {
    missing.push(
      `${declarations.length} declarations where there are two: the property is a single ` +
        'value, so a third is a third answer to one question',
    );
  }

  return missing.map((what) => ({
    file: NUMERALS_HOME,
    line: declarations[0]?.line ?? 1,
    offset: 0,
    rule: 'numerals-home',
    what: `${NUMERALS_HOME} is missing ${what}`,
  }));
}

/* --------------------------------------------------------------------------- the whole run */

/** Every file the gate reads, relative to `cwd`. */
export function filesInScan(cwd = process.cwd()) {
  return SCAN.flatMap((dir) => globSync(`${dir}/**/*.{${EXTENSIONS.join(',')}}`, { cwd }))
    .map((file) => file.split('\\').join('/'))
    .sort();
}

/** The gate, over a tree. `cwd` is a parameter so a test can point it at a fixture. */
export function checkTree({ cwd = process.cwd(), exemptions = EXEMPTIONS } = {}) {
  const files = filesInScan(cwd);
  const offences = [];
  const honoured = [];

  for (const file of files) {
    const found = findOffences(file, readFileSync(`${cwd}/${file}`, 'utf8'), { exemptions });
    offences.push(...found.offences);
    honoured.push(...found.honoured);
  }

  if (files.includes(NUMERALS_HOME)) {
    offences.push(...numeralsHome(readFileSync(`${cwd}/${NUMERALS_HOME}`, 'utf8')));
  }

  return { files, offences, honoured };
}

/** What a reader is told to do about each rule. */
/** @type {Record<string, string[]>} */
export const GUIDANCE = {
  hex: [
    'use a role token (--surface, --text, --accent, --accent-fill, --line), or',
    '--band-* on the fixed chrome band. A literal that reads well in one theme is',
    'unreadable in the other: gold on cream is 2.02:1. Mark the line "ds-allow"',
    'with a reason if the surface really is outside CSS.',
  ],
  'colour-function': [
    'a literal colour is a literal colour however it is spelled. Use a role token;',
    'a call whose arguments reference one — color-mix(in srgb, var(--band-surface)',
    '96%, transparent) — is fine.',
  ],
  'brand-var': [
    'use a role token. --accent IS gold in dark and gold-deep in light, and --band-*',
    'is the role set for the chrome band that is plum-ink in both themes.',
  ],
  numerals: [
    'font-variant-numeric is one inherited value, set twice in src/styles/base.css',
    'and nowhere else. Declaring it here REPLACES "lining-nums tabular-nums" and',
    'brings back "19:00" → "I9:OO" (MUSE-14). Change the document rule instead.',
  ],
  shadow: [
    'there are no drop shadows in this system, in either theme (§5). Depth is surface',
    'value plus hairlines — raise the surface or add a --line hairline. ": none" is',
    'allowed, because it adds no depth.',
  ],
  'numerals-home': [
    'both rules are the fix, not one rule and a nicety: the property does not reach a',
    "form control through inheritance, because the UA's `font` shorthand resets it,",
    'so deleting either one reopens MUSE-14 on half the page (MUSE-57).',
  ],
};

function main() {
  const { files, offences, honoured } = checkTree();

  for (const { file, line, rule, what } of offences) {
    console.log(`✗ ${file}:${line}  ${what}`);
    (GUIDANCE[rule] ?? []).forEach((hint, at) => {
      console.log(`    ${at === 0 ? '→' : ' '} ${hint}`);
    });
  }

  // Every exemption is printed, because the defect this replaces was an opt-out whose
  // real scope was invisible. The `ds-allow` notes are listed individually — those are
  // the ones a reviewer has to judge — and the named registry entries are counted per
  // file, since the token layer legitimately holds a hundred and fifty of them.
  if (honoured.length) {
    const notes = honoured.filter(({ by }) => by === 'ds-allow');
    const named = new Map();
    for (const { file, by } of honoured) {
      if (by !== 'ds-allow') named.set(file, (named.get(file) ?? 0) + 1);
    }
    console.log(`${honoured.length} exemption(s) honoured:`);
    for (const { file, line, rule } of notes) {
      console.log(`    ds-allow  ${file}:${line} (${rule})`);
    }
    for (const [file, count] of named) {
      console.log(`    named     ${file} (${count})`);
    }
  }

  if (offences.length) {
    console.log(`\n${offences.length} design-system violation(s).`);
    process.exit(1);
  }
  console.log(`Design system: ${files.length} files clean.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();

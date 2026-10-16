import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  EXEMPTIONS,
  GUIDANCE,
  NUMERALS_HOME,
  SCAN,
  UNINHERITING,
  blankComments,
  checkTree,
  filesInScan,
  findOffences,
  numeralsHome,
  regionsOf,
} from '../scripts/check-tokens.mjs';

/**
 * **The design-system gate's own rules, called as functions against fixed inputs**
 * (MUSE-99, MUSE-118).
 *
 * `npm run ds` is the first of "the three that break things silently" in `CLAUDE.md`, and
 * until this file existed **nothing under `test/` asserted any of it**. `grep -rln
 * "check-tokens" test/` answered with one file, `test/pricing.test.ts`, and that is a
 * sentence in a comment rather than a claim about behaviour. So the numerals regex could
 * be deleted and `npm run ds` still printed `Design system: 50 files clean.` — a guard
 * reporting success because it had stopped asking the question. Measured before the fix,
 * by deleting it.
 *
 * That is the same defect as MUSE-112 (`test/helpers/measured.ts` had tests for the rule
 * it enforces and none of its own refusal) in a different file, and it is this board's
 * most repeated shape: **a rule with no test is a rule that can be deleted silently.**
 *
 * ## Why this costs nothing
 *
 * Every assertion here is a function call or a file read. No build, no dev server, no
 * browser — so `DECLARED` in `test/helpers/concurrency.ts` is untouched and the run's
 * heavyweight total is unchanged. That is a requirement rather than a convenience: the
 * metered total has zero headroom and the flake it meters is load-sensitive with no
 * threshold, so a guard over a *source* property may not cost an operation. It is
 * `test/a11yrules.test.ts`'s reasoning applied to a second script, and
 * `test/helpers/source-guard.ts`'s shape — the checker driven directly, with its answer
 * compared against what the input deserves.
 *
 * ## What is covered and what is not
 *
 * `COVERED` below holds one case per rule the gate can report, and its keys are asserted
 * equal to `GUIDANCE`'s — the map the gate reads its advice out of, so a rule that can be
 * reported has an entry there by construction. A new rule therefore arrives with a test
 * or arrives red; nothing in this file is "the one rule QA happened to look at".
 *
 * Three things this cannot see, written out because a guard whose limits are not stated
 * is read as a guard with none:
 *
 *   - **Whether the rules are the right rules.** That the design system says what the
 *     header says it says is a human reading of `muse-design-system.md`, not a test.
 *   - **A violation reaching the page by a route the gate does not read** — a hex in a
 *     `.json`, in `sanity/`, or computed at runtime from two halves. The scan is five
 *     directories and three extensions, and that set is asserted, not derived.
 *   - **Whether CI runs it.** `test/origin.test.ts` is where the workflow is parsed; here
 *     the subject is the gate's verdict, not the job that collects it.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/** A `.astro` component with one scoped style block — what every rule here is about. */
const component = (css: string): string =>
  `---\nconst x = 1;\n---\n<div />\n<style>\n${css}\n</style>\n`;

/** `rule:line` for each offence, which is what an assertion about a gate should read as. */
function offending(file: string, text: string): string[] {
  return findOffences(file, text).offences.map(
    (found: { rule: string; line: number }) => `${found.rule}:${found.line}`,
  );
}

/** The advice the gate prints for a rule, reached by a name the test computed. */
const guidanceFor = (rule: string): string[] => (GUIDANCE as Record<string, string[]>)[rule];

/** Just the rules, for the cases where the line is not the point. */
function rulesFired(file: string, text: string): string[] {
  return findOffences(file, text).offences.map((found: { rule: string }) => found.rule);
}

const PROBE = 'src/components/Probe.astro';

/**
 * **One case per rule the gate can report.**
 *
 * The completeness assertion below compares these keys against `GUIDANCE`'s, which is
 * where the gate keeps the advice it prints per rule — so there is no second list of
 * "rules that exist" to keep current, and a rule with no fixture is a red test naming it.
 */
const COVERED: ReadonlyMap<string, () => Array<{ rule: string }>> = new Map([
  ['hex', () => findOffences(PROBE, component('.a { color: #C8A96A; }')).offences],
  [
    'colour-function',
    () => findOffences(PROBE, component('.a { color: rgb(200 169 106); }')).offences,
  ],
  ['brand-var', () => findOffences(PROBE, component('.a { color: var(--gold); }')).offences],
  [
    'numerals',
    () => findOffences(PROBE, component('.a { font-variant-numeric: tabular-nums; }')).offences,
  ],
  ['shadow', () => findOffences(PROBE, component('.a { box-shadow: 0 1px 2px; }')).offences],
  ['numerals-home', () => numeralsHome(':root { color: inherit; }')],
]);

describe('the gate reports every rule it has, and every rule it has is tested', () => {
  it('has a case for each rule, so a new one cannot arrive untested', () => {
    expect([...COVERED.keys()].sort()).toEqual(Object.keys(GUIDANCE).sort());
  });

  it('fires each of them on an input that deserves it', () => {
    for (const [rule, produce] of COVERED) {
      expect(produce().map((found) => found.rule)).toContain(rule);
    }
  });

  it('says something useful about each, rather than naming a regex', () => {
    for (const rule of COVERED.keys()) {
      expect(guidanceFor(rule).join(' ')).toMatch(/[a-z]{4}/);
    }
  });
});

/* ------------------------------------------------------- MUSE-99: the six escapes, closed */

/**
 * **The spellings that walked past the per-line scan**, each one a thing somebody would
 * reach for naturally rather than a contrivance. All six reported `50 files clean` when
 * they were planted in a real component; the two the ticket calls unfixable in principle
 * by any regex are 3 and 4, and they are why the gate now blanks comments over a region
 * and matches over offsets instead of lines.
 */
const ESCAPES = [
  {
    escape: 1,
    what: 'an eight-digit hex — the alpha pair defeated \\b at both alternatives',
    css: '  .scrim { background: #420535e6; }',
    rule: 'hex',
  },
  {
    escape: 1,
    what: 'a four-digit hex, the same hole one pair in',
    css: '  .scrim { background: #4035; }',
    rule: 'hex',
  },
  {
    escape: 2,
    what: 'rgb() — §13’s gold, to the digit, matched by nothing',
    css: '  .gold { color: rgb(200 169 106); }',
    rule: 'colour-function',
  },
  {
    escape: 2,
    what: 'oklch(), the spelling a stylesheet written next year uses',
    css: '  .gold { color: oklch(0.72 0.09 80); }',
    rule: 'colour-function',
  },
  {
    escape: 2,
    what: 'hsl()',
    css: '  .gold { color: hsl(42 48% 60%); }',
    rule: 'colour-function',
  },
  {
    escape: 3,
    what: 'a line beginning with the universal selector, read as a comment continuation',
    css: '*, .band { color: #C8A96A; }',
    rule: 'hex',
  },
  {
    escape: 3,
    what: 'the same line hiding the numerals rule, which it also skipped entirely',
    css: '* { font-variant-numeric: tabular-nums; }',
    rule: 'numerals',
  },
  {
    escape: 4,
    what: 'a var() split across lines, which is what Prettier does to a long declaration',
    css: '  .s {\n    color: var(\n      --gold\n    );\n  }',
    rule: 'brand-var',
  },
];

describe('MUSE-99 — the six spellings that escaped the gate', () => {
  for (const { escape, what, css, rule } of ESCAPES) {
    it(`escape ${escape}: ${what}`, () => {
      const found = findOffences(PROBE, component(css)).offences;
      expect(found.map((one: { rule: string }) => one.rule)).toContain(rule);
    });
  }

  it('names a line in the file, which is the whole of what a reader does with it', () => {
    // The style block starts on line 5 of `component()`, so the declaration is line 6.
    expect(offending(PROBE, component('  .a { color: #C8A96A; }'))).toEqual(['hex:6']);
  });

  it('escape 4 names the line the value starts on, not the line the file ended on', () => {
    expect(
      offending(PROBE, component('  .s {\n    color: var(\n      --gold\n    );\n  }')),
    ).toEqual(['brand-var:7']);
  });

  /**
   * Escape 6 had nothing clever about it: a stylesheet under `src/styles/` imported by a
   * component is in that component's graph and the gate never opened it, and `src/lib/`
   * holds two real brand literals. The file count not moving when one was planted is how
   * QA established the directory was not being read, so the assertion is on the scan.
   */
  it('escape 6: reads src/styles and src/lib, not three directories out of five', () => {
    expect(SCAN).toEqual([
      'src/components',
      'src/layouts',
      'src/pages',
      'src/styles',
      'src/lib',
    ]);

    const files = filesInScan(ROOT);
    for (const dir of SCAN) {
      expect(files.filter((file: string) => file.startsWith(`${dir}/`)).length).toBeGreaterThan(
        0,
      );
    }
    expect(files).toContain(NUMERALS_HOME);
    expect(files).toContain('src/lib/share-card.ts');
  });

  it('escape 6: catches a brand colour in a stylesheet and in a library constant', () => {
    expect(rulesFired('src/styles/planted.css', '.a { color: #C8A96A; }')).toEqual(['hex']);
    expect(rulesFired('src/lib/planted.ts', "export const C = '#C8A96A';\n")).toEqual(['hex']);
  });
});

/* ---------------------------------------------------- the opt-out, which used to leak down */

describe('escape 5 — a ds-allow note is attached to something', () => {
  it('exempts the line it is written on', () => {
    expect(offending(PROBE, component('  .a { color: #C8A96A; } /* ds-allow: why */'))).toEqual(
      [],
    );
  });

  it('exempts the declarations it is written above', () => {
    const css = '  .a {\n    /* ds-allow: why */\n    color: #C8A96A;\n  }';
    expect(offending(PROBE, component(css))).toEqual([]);
  });

  /**
   * The measured defect. `allowBlock` was cleared only by a blank line and CSS blocks
   * rarely contain one, so one note bought an unbounded exemption — QA bought three with
   * it, the third being the numerals defect this gate's own header is written about.
   */
  it('does not buy three violations with one comment', () => {
    const css = [
      '  /* ds-allow: one note */',
      '  .a { color: #420535; }',
      '  .b { color: #C8A96A; }',
      '  .c { font-variant-numeric: oldstyle-nums; }',
    ].join('\n');
    expect(offending(PROBE, component(css))).toEqual(['hex:8', 'numerals:9']);
  });

  it('does not reach past the block it is written in', () => {
    const css = [
      '  .a {',
      '    /* ds-allow: why */',
      '    color: #C8A96A;',
      '  }',
      '  .b {',
      '    color: #420535;',
      '  }',
    ].join('\n');
    expect(offending(PROBE, component(css))).toEqual(['hex:11']);
  });

  it('does not reach past a blank line', () => {
    const css = ['  /* ds-allow: why */', '', '  .b { color: #420535; }'].join('\n');
    expect(offending(PROBE, component(css))).toEqual(['hex:8']);
  });

  it('does not reach the rest of the file, which is where it used to end', () => {
    const filler = Array.from({ length: 20 }, (_, i) => `  .f${i} { opacity: 1; }`);
    const css = ['  /* ds-allow: why */', ...filler, '  .late { color: #420535; }'].join('\n');
    expect(offending(PROBE, component(css))).toEqual(['hex:27']);
  });

  it('stops at the first clean declaration once it has covered an offending one', () => {
    const css = [
      '  .a {',
      '    /* ds-allow: why */',
      '    color: #C8A96A;',
      '    opacity: 1;',
      '    background: #420535',
      '  }',
    ].join('\n');
    expect(offending(PROBE, component(css))).toEqual(['hex:10']);
  });

  /**
   * **The one real note in the tree, asserted still necessary** — the
   * `test/contentdrift.test.ts` and `REBUILT_FROM_PARTS` move. `theme-color` takes no
   * custom property, so the two brand grounds are literal in an attribute; if that ever
   * stops being true this goes red asking for the note to be deleted rather than sitting
   * here for ever excusing something that no longer needs excusing.
   *
   * It also pins the *extent*: one note, exactly the two metas, which is why the opt-out
   * covers a run rather than a single declaration. Widening it is a red test.
   */
  it('is still needed by the two theme-color metas, and covers only those two', () => {
    const file = 'src/layouts/BaseLayout.astro';
    const source = read(file);

    const { offences, honoured } = findOffences(file, source);
    expect(offences).toEqual([]);
    expect(
      honoured.map((one: { by: string; rule: string }) => `${one.by}:${one.rule}`),
    ).toEqual(['ds-allow:hex', 'ds-allow:hex']);

    const lines = honoured.map((one: { line: number }) => source.split('\n')[one.line - 1]);
    expect(lines.every((line: string) => line.includes('theme-color'))).toBe(true);

    // Take the note away and the gate says exactly what the note is for.
    const without = source.replace('ds-allow', 'keep in sync');
    expect(rulesFired(file, without)).toEqual(['hex', 'hex']);
  });

  it('is the only note in the tree, so the census cannot quietly grow', () => {
    const notes = filesInScan(ROOT)
      .flatMap((file: string) =>
        [...read(file).matchAll(/ds-allow/g)].map(() => file as string),
      )
      .sort();
    expect(notes).toEqual(['src/layouts/BaseLayout.astro']);
  });
});

/* ------------------------------------------------------------- the rule that did not exist */

describe('shadows, which the gate had no rule for at all', () => {
  /**
   * `CLAUDE.md`: "No drop shadows, either theme. Depth is surface value plus hairlines."
   * It was enforced by four hand-written per-component assertions over roughly fourteen
   * components, two of which checked `box-shadow` only — so `Gallery.astro`'s lightbox,
   * the surface a shadow is most likely to be added to, had none, and a planted
   * `box-shadow` *and* `filter: drop-shadow(…)` left `npm run ds` clean and
   * `test/gallery.test.ts` at 47 passed.
   */
  for (const [what, css] of [
    ['box-shadow', '  .a { box-shadow: 0 2px 8px var(--line); }'],
    ['text-shadow', '  .a { text-shadow: 0 1px 0 var(--line); }'],
    ['a prefixed box-shadow', '  .a { -webkit-box-shadow: 0 2px 8px var(--line); }'],
    ['drop-shadow() through filter', '  .a { filter: drop-shadow(0 1px 2px var(--line)); }'],
    ['drop-shadow() through backdrop-filter', '  .a { backdrop-filter: drop-shadow(0 1px); }'],
  ]) {
    it(`fails on ${what}`, () => {
      expect(rulesFired(PROBE, component(css))).toContain('shadow');
    });
  }

  it('allows ": none", which adds no depth and is how a UA shadow is reset', () => {
    expect(offending(PROBE, component('  input { box-shadow: none; }'))).toEqual([]);
  });

  it('finds none in the tree, so the gate and the four component assertions agree', () => {
    const shadows = checkTree({ cwd: ROOT }).offences.filter(
      (one: { rule: string }) => one.rule === 'shadow',
    );
    expect(shadows).toEqual([]);
  });
});

/* ---------------------------------------------------------------- MUSE-118: the numerals rule */

describe('MUSE-118 — the numerals rule, which nothing watched', () => {
  it('still reports a component that declares the property, exactly as it did', () => {
    expect(offending(PROBE, component('  .t { font-variant-numeric: tabular-nums; }'))).toEqual(
      ['numerals:6'],
    );
    expect(offending(PROBE, component('  .t { font-feature-settings: "tnum"; }'))).toEqual([
      'numerals:6',
    ]);
  });

  it('tells the reader what the property does rather than that a regex matched', () => {
    const advice = GUIDANCE.numerals.join(' ');
    expect(advice).toContain('MUSE-14');
    expect(advice).toContain(NUMERALS_HOME);
    expect(advice).toContain('REPLACES');
  });

  it('lets the one file that owns the property declare it', () => {
    expect(rulesFired(NUMERALS_HOME, ':root { font-variant-numeric: lining-nums; }')).toEqual(
      [],
    );
  });

  it('is the only file in the tree that declares it, so the ceiling has one hole', () => {
    const declaring = filesInScan(ROOT).filter((file: string) =>
      /font-variant-numeric\s*:/.test(
        blankComments(read(file), file.endsWith('.css') ? 'css' : 'code'),
      ),
    );
    expect(declaring).toEqual([NUMERALS_HOME]);
  });

  /**
   * **The floor.** MUSE-35's argument about the font count: a ceiling alone reads a page
   * with zero faces served as the leanest it has ever seen, and a gate that refuses the
   * property in a component is worth nothing if the document rule it protects has been
   * deleted. MUSE-118's concrete risk is the *second* of the two rules — the one a reader
   * asking "is this redundant?" would delete, having been told by this gate's own header
   * that the property is set once.
   */
  describe('the floor under it: base.css must still carry both rules', () => {
    const base = read(NUMERALS_HOME);

    it('passes on the tree as it stands', () => {
      expect(numeralsHome(base)).toEqual([]);
    });

    it('fails when the :root rule goes, naming it and MUSE-14', () => {
      const without = base.replace('font-variant-numeric: lining-nums tabular-nums;', '');
      const missing = numeralsHome(without).map((one: { what: string }) => one.what);
      expect(missing.join(' ')).toContain('MUSE-14');
      expect(missing.join(' ')).toContain(':root');
    });

    it('fails when the form-control rule goes, naming the elements and MUSE-57', () => {
      const without = base.replace('font-variant-numeric: inherit;', '');
      const missing = numeralsHome(without).map((one: { what: string }) => one.what);
      expect(missing.join(' ')).toContain('MUSE-57');
      for (const element of UNINHERITING) {
        expect(missing.join(' ')).toContain(element);
      }
    });

    it('names every element whose UA font shorthand resets the property', () => {
      expect(UNINHERITING).toEqual([
        'input',
        'select',
        'textarea',
        'button',
        'optgroup',
        'option',
        '::file-selector-button',
      ]);
    });

    it('fails on a third declaration, because the property is a single value', () => {
      const extra = `${base}\n.late { font-variant-numeric: tabular-nums; }\n`;
      expect(
        numeralsHome(extra)
          .map((one: { what: string }) => one.what)
          .join(' '),
      ).toContain('3 declarations');
    });
  });

  /**
   * MUSE-118's third acceptance criterion. `scripts/check-tokens.mjs:21` said the property
   * "is set once for the whole document", which has been false since MUSE-57 — and that
   * file is the one surface a reader asking whether the second rule is redundant lands on,
   * so it was the sentence that would have told them to delete it.
   */
  it('describes the two rules that exist, not the one that existed before MUSE-57', () => {
    const header = read('scripts/check-tokens.mjs').split('export const SCAN')[0];
    expect(header).not.toContain('set once for the whole document');
    expect(header).toContain('set **twice**');
    expect(header).toContain('MUSE-57');
    expect(header).toContain('::file-selector-button');
  });
});

/* --------------------------------------------------------- comments, and the regions they sit in */

describe('a comment is documentation, and a declaration is not', () => {
  /**
   * The `isComment` fix must not reintroduce the problem it solves: this gate's own header
   * quotes hexes, and so do several components (`Lockup.astro`'s `#FFFFFF`,
   * `Header.astro`'s `#594553`). The old rule skipped any line beginning with `*`, which
   * also skipped the universal selector; the new one blanks comments per region, so the
   * question "is this a comment" is answered by where the delimiters are.
   */
  it('reads none of the four comment syntaxes as declarations', () => {
    const source = [
      '---',
      '// #C8A96A, var(--gold), font-variant-numeric: tabular-nums, box-shadow: 0 0 0',
      '/**',
      ' * #420535 and var(--plum) and text-shadow: 0 0 0 and drop-shadow(1px)',
      ' */',
      'const x = 1;',
      '---',
      '<!-- #420535 and var(--plum) and box-shadow: 0 0 0 -->',
      '{/* #C8A96A and var(--cream) and font-feature-settings: "tnum" */}',
      '<style>',
      '  /* #420535, var(--gold), font-variant-numeric: tabular-nums, box-shadow: 0 0 0 */',
      '  .ok { color: var(--accent); }',
      '</style>',
    ].join('\n');
    expect(offending(PROBE, source)).toEqual([]);
  });

  it('still reads the declaration on a line that also carries a comment', () => {
    expect(offending(PROBE, component('  .a { color: #C8A96A; } /* a note */'))).toEqual([
      'hex:6',
    ]);
  });

  it('does not read a URL fragment or an HTML entity as a colour', () => {
    const source = component("  .a { background: url('/x.svg#abcdef'); }");
    expect(offending(PROBE, source)).toEqual([]);
    expect(offending('src/lib/p.ts', "const u = 'https://x.test/#abc123';\n")).toEqual([]);
    expect(offending('src/lib/p.ts', "const e = '&#128169;';\n")).toEqual([]);
  });

  it('allows a colour function whose arguments reference a role token', () => {
    const css =
      '  .a { background: color-mix(in srgb, var(--band-surface) 96%, transparent); }';
    expect(offending(PROBE, component(css))).toEqual([]);
  });

  /**
   * The bug that silently disabled the only real opt-out in the tree while this ticket was
   * being implemented: Astro spells its four scripts `<script is:inline set:html={…} />`,
   * with no closing tag anywhere in the file. Read as an opening tag, the first one
   * swallowed the rest of the document into a code region — where a JSX comment's braces
   * survive blanking and read as the end of a CSS block, which moved the `ds-allow` note's
   * run off the two metas it is written above.
   */
  it('does not let a self-closing script swallow the rest of the document', () => {
    const source = [
      '---',
      'const x = 1;',
      '---',
      '<script is:inline set:html={x} />',
      '{/* ds-allow: why */}',
      '<meta name="theme-color" content="#420535" />',
    ].join('\n');

    expect(
      regionsOf('src/layouts/L.astro', source).map((one: { kind: string }) => one.kind),
    ).toContain('markup');
    expect(offending('src/layouts/L.astro', source)).toEqual([]);
  });
});

/* ------------------------------------------------- the exemptions, each asserted still live */

describe('the named exemptions, which are not a skip list', () => {
  /**
   * MUSE-45's ruling: a skip list is MUSE-19's allow-list wearing the other hat. A skip
   * list names a file and stops reading it; each entry here names a file **and the shape
   * of the declaration** it excuses, so the rest of that file is still read — and each one
   * is asserted *still live*, so an entry that has stopped being necessary is a red test
   * asking for its deletion.
   */
  it('is these three sites and no others', () => {
    expect(EXEMPTIONS.map((entry: { file: string }) => entry.file)).toEqual([
      'src/styles/tokens.css',
      'src/lib/share-card.ts',
      'src/lib/icon.ts',
    ]);
  });

  it('gives each one a reason somebody wrote, not a filename', () => {
    for (const entry of EXEMPTIONS) {
      expect(entry.why.length).toBeGreaterThan(80);
    }
  });

  it('honours every one of them somewhere in the tree', () => {
    const honoured = checkTree({ cwd: ROOT }).honoured;
    for (const entry of EXEMPTIONS) {
      expect(
        honoured.filter((one: { by: string }) => one.by === entry.file).length,
      ).toBeGreaterThan(0);
    }
  });

  it('needs every one of them: take one away and the gate reports what it covered', () => {
    for (const entry of EXEMPTIONS) {
      const without = EXEMPTIONS.filter((other: unknown) => other !== entry);
      const { offences } = checkTree({ cwd: ROOT, exemptions: without });
      expect(offences.map((one: { file: string }) => one.file)).toContain(entry.file);
    }
  });

  it('scopes the token layer to defining a token, not to using one', () => {
    const file = 'src/styles/tokens.css';
    expect(offending(file, ':root { --plum: #420535; }')).toEqual([]);
    expect(offending(file, ':root { --text-muted: rgba(247, 242, 238, .72); }')).toEqual([]);
    expect(offending(file, '.band { color: #420535; }')).toEqual(['hex:1']);
  });

  it('scopes a raster constant to its own line', () => {
    const file = 'src/lib/share-card.ts';
    const source = [
      "export const SHARE_CARD_GROUND = '#420535';",
      "const other = '#C8A96A';",
    ].join('\n');
    expect(offending(file, source)).toEqual(['hex:2']);
  });
});

/* --------------------------------------------------------------------- the tree as it stands */

describe('the tree the gate reports on', () => {
  it('is clean, and the count is every file under the five directories', () => {
    const { files, offences } = checkTree({ cwd: ROOT });
    expect(offences).toEqual([]);
    expect(files.length).toBe(filesInScan(ROOT).length);

    // The widening is visible in the count: it was 50 files, over three directories.
    expect(files.length).toBeGreaterThan(50);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

/**
 * **MUSE-98 — the accessibility gate's *rule set*, as a ratchet rather than a comment.**
 *
 * MUSE-55 deleted a hand-kept list of **which pages** to audit and replaced it with a walk
 * of the build. MUSE-75 deleted a hand-kept list of **which rules** to run and replaced it
 * with axe's default set. The first deletion got a guard — `test/origin.test.ts` fails if a
 * route list reappears in the script, in `ci.yml` or in an npm script. The second got a
 * paragraph in `scripts/a11y.mjs` and nothing else, so putting
 * `.withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])` back on the builder was green
 * on every check in the repository while "accessibility: pass" quietly went back to meaning
 * "no WCAG A/AA violation" — which is not what anybody reads it as. `heading-order` is
 * tagged `best-practice`, and `/pricing/` shipping `h1` → `h3` in both locales was a real
 * axe finding on a live page that the gate structurally could not report.
 *
 * ## Why this reads the source rather than the run
 *
 * The strongest possible subject is what the run *reports*: axe hands back `violations`,
 * `passes`, `incomplete` and `inapplicable`, and their union is exactly the set of rules it
 * ran, so a gate could compare that union against axe's own default-enabled set and refuse
 * to pass on a narrower one. That was weighed and is not what is here, for two reasons
 * neither of which is taste:
 *
 *   1. **The acceptance criterion is that a *test* fails.** Exercising the gate means a
 *      browser launch, and `test/helpers/concurrency.ts` records the run's heavyweight
 *      total with zero headroom — the flake it meters is load-sensitive with no threshold.
 *      A guard that costs an operation is a guard that has to be paid for out of another
 *      suite's budget, for a property that is decided at a single call site in a single
 *      file.
 *   2. **"Axe's default-enabled set" has no public spelling.** `axe.getRules()` answers
 *      with every registered rule, disabled ones included, so deriving the default set
 *      means either reading `axe._audit.rules[].enabled` — private, and silently empty if
 *      it ever moves — or subtracting the tags axe ships off, which is a list of standards
 *      to keep current. That is the exact artefact MUSE-75 deleted, rebuilt inside its own
 *      guard.
 *
 * So the rule is stated against **the call**, the way `test/helpers/source-guard.ts` states
 * its rules and for its reason: the two surviving `withTags` mentions in `scripts/a11y.mjs`
 * are *in the comment explaining the removal*, and a textual needle would fire on the
 * explanation. The cheapest way to silence a guard that reports prose is to delete the
 * prose, and then the reasoning is gone too.
 *
 * ## The shape: an allow-list of one method, so evasions fail closed
 *
 * The claim is not "no `withTags`" — that is a deny-list, and a deny-list of configuration
 * methods is one more list to keep current the day axe adds `.options()`-shaped sugar or
 * somebody reaches for `.disableRules()`. The claim is that the audit **configures
 * nothing**: between `new AxeBuilder({ page })` and the result there is `analyze()` and
 * nothing else, and the constructor is handed `page` and nothing else (`axeSource` would
 * replace axe-core wholesale).
 *
 * An allow-list also decides which way the evasions fall. A builder bound to a name and
 * configured a line later — `const b = new AxeBuilder({ page }); b.withTags(…)` — reads
 * here as a chain of *no* calls, which is not `['analyze']`, so it is red. A deny-list
 * would have been green.
 *
 * ## What this cannot catch
 *
 * Written out rather than left implied, because a guard whose limits are not stated is read
 * as a guard with none:
 *
 *   - **Configuration injected into the page instead of the builder.** An `axe.configure()`
 *     inside a `page.evaluate()` before `analyze()` would narrow the run and is invisible
 *     to a rule about the builder. Nothing here is a defence against a deliberate bypass;
 *     the defect this is aimed at was somebody restoring four tags in good faith.
 *   - **The rule set of the axe-core the lockfile resolves.** If a release moves a rule
 *     from enabled to disabled, this still passes and the gate really does audit less.
 *     That is MUSE-75's own bet, taken knowingly: the default set is the thing being
 *     tracked, so it widening *and* narrowing with the dependency is the point.
 *   - **Whether a reported violation is acted on.** The gate exits non-zero; what a human
 *     does with a red run is outside any test.
 *   - **Anything about a second viewport.** The gate audits one, 1280 × 900, so MUSE-75's
 *     mobile observations sit outside it in both themes and on every page. That is noted
 *     beside the rule in `scripts/a11y.mjs` and is a separate ticket, not a silent gap.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The package the builder can only be obtained from. */
const AXE_PACKAGE = '@axe-core/playwright';

/** Its one export, by the name the package spells it — an alias is resolved by rule. */
const AXE_EXPORT = 'AxeBuilder';

/** The one method an unconfigured audit calls. */
const ANALYZE = 'analyze';

/** The one option the constructor may be handed. */
const PAGE = 'page';

/** Directories that could hold an audit. Walked, so a new file is covered by being written. */
const ROOTS = ['scripts', 'test', 'src'] as const;

const PARSED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx']);

/**
 * **Every axe audit in the repository, and what each one is allowed to be.**
 *
 * Two kinds, and the distinction is the second acceptance criterion: this rule is about
 * **the gate**, not about every `AxeBuilder` in the tree.
 *
 *   - `'default'` — audits the full default rule set. Enforced: `analyze()` and nothing
 *     else. `scripts/a11y.mjs` is MUSE-75's subject; `test/gallery.test.ts` reached the
 *     same decision for the same reason and says so in its own comment, so it is held to
 *     it rather than merely excused from the other kind.
 *   - `'narrowed'` — deliberately audits less, with a reason and a ticket. Enforced in the
 *     **other direction**: it must still configure something. That is the
 *     `test/contentdrift.test.ts` and `test/lockup.test.ts` move — an exemption asserted
 *     *still live*, so if `test/contact.test.ts` ever widens to the default set this goes
 *     red asking for the entry to be deleted, instead of sitting here for ever excusing a
 *     narrowing that no longer exists.
 *
 * `audits` is how many builders the file constructs, so a *second* audit added to a file
 * that already has one is an undeclared audit rather than one inheriting the first's
 * classification.
 */
const AXE_SITES: ReadonlyMap<
  string,
  { audits: number; kind: 'default' | 'narrowed'; why: string }
> = new Map([
  [
    'scripts/a11y.mjs',
    {
      audits: 1,
      kind: 'default' as const,
      why:
        'the gate (MUSE-75). It filtered to wcag2a/2aa/21a/21aa, and heading-order is ' +
        'tagged best-practice, so /pricing/ shipping h1 → h3 in both locales was a real ' +
        'finding on a live page that the gate whose job is to catch it could not report.',
    },
  ],
  [
    'test/gallery.test.ts',
    {
      audits: 1,
      kind: 'default' as const,
      why:
        'the lightbox open, which the gate only ever sees closed (MUSE-25). Its own ' +
        'comment takes MUSE-75’s position explicitly, so it is held to it here.',
    },
  ],
  [
    'test/contact.test.ts',
    {
      audits: 1,
      kind: 'narrowed' as const,
      why:
        'the trial form’s error states, narrowed to WCAG A/AA — MUSE-7’s business, which ' +
        'test/gallery.test.ts records as not a precedent to copy. The exemption is for ' +
        'that one audit and is asserted still live below.',
    },
  ],
]);

/** One rule violation, in the shape every guard in this repository reports. */
interface Offence {
  file: string;
  line: number;
  what: string;
}

/** `file:line — what`, so a failure can be read out of the message. */
function listed(offences: Offence[]): string[] {
  return offences.map(({ file, line, what }) => `${file}:${line} — ${what}`);
}

/** One `new AxeBuilder(…)`, with the chain applied to it and the options it was handed. */
interface Audit {
  file: string;
  line: number;
  /** The methods called on the builder, outwards: `['withTags', 'analyze']`. */
  chain: string[];
  /** The constructor's option names, sorted. `['page']` for an unconfigured audit. */
  options: string[];
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx') || file.endsWith('.jsx')) return ts.ScriptKind.TSX;
  if (/\.(?:m|c)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * The names `AxeBuilder` is reachable under in this file.
 *
 * Read off the **import**, not assumed: `import { AxeBuilder as A }` and
 * `import * as axe from …` are both ways to construct a builder without the identifier
 * `AxeBuilder` appearing at the call. source-guard's rule — the exported name, never the
 * local alias — pointed the other way round, and this is the same principle applied to a
 * construction rather than to a call.
 */
function builderNames(tree: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of tree.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== AXE_PACKAGE
    ) {
      continue;
    }
    const clause = statement.importClause;
    if (clause === undefined) continue;
    if (clause.name !== undefined) names.add(`${clause.name.text}.${AXE_EXPORT}`);
    const bindings = clause.namedBindings;
    if (bindings === undefined) continue;
    if (ts.isNamespaceImport(bindings)) {
      names.add(`${bindings.name.text}.${AXE_EXPORT}`);
      continue;
    }
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === AXE_EXPORT) {
        names.add(element.name.text);
      }
    }
  }
  return names;
}

/**
 * The methods called on `builder`, in the order they are applied.
 *
 * `await`, parentheses and a non-null assertion are transparent — they are spellings, not
 * configuration. A property *read* that is never called is recorded as itself rather than
 * skipped, so handing `analyze` around as a value cannot read as an unconfigured chain.
 */
function chainOf(builder: ts.Node): string[] {
  const chain: string[] = [];
  let node: ts.Node = builder;
  for (;;) {
    const parent: ts.Node | undefined = node.parent;
    if (parent === undefined) return chain;
    if (
      ts.isParenthesizedExpression(parent) ||
      ts.isAwaitExpression(parent) ||
      ts.isNonNullExpression(parent)
    ) {
      node = parent;
      continue;
    }
    if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) return chain;
    const call: ts.Node | undefined = parent.parent;
    if (call !== undefined && ts.isCallExpression(call) && call.expression === parent) {
      chain.push(parent.name.text);
      node = call;
      continue;
    }
    chain.push(`${parent.name.text} (read, never called)`);
    return chain;
  }
}

/** The constructor's option names, or one unreadable marker — never silently nothing. */
function optionsOf(node: ts.NewExpression, tree: ts.SourceFile): string[] {
  const first = node.arguments?.[0];
  if (first === undefined) return [];
  if (!ts.isObjectLiteralExpression(first)) return [`<${first.getText(tree)}>`];
  return first.properties
    .map((property) => {
      if (ts.isSpreadAssignment(property)) return `...${property.expression.getText(tree)}`;
      const name = property.name;
      return name !== undefined && ts.isIdentifier(name)
        ? name.text
        : `<${property.getText(tree)}>`;
    })
    .sort();
}

/** Every audit in `file`, parsed. `source` is for the reader's own tests. */
function auditsIn(file: string, source?: string): Audit[] {
  const text = source ?? readFileSync(join(ROOT, file), 'utf8');
  if (!text.includes(AXE_PACKAGE)) return [];

  const tree = ts.createSourceFile(
    file,
    text,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    scriptKind(file),
  );
  const names = builderNames(tree);
  if (names.size === 0) return [];

  const found: Audit[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isNewExpression(node) && names.has(node.expression.getText(tree))) {
      found.push({
        file,
        line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        chain: chainOf(node),
        options: optionsOf(node, tree),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** Every file under `ROOTS` a rule here can read, repo-relative with forward slashes. */
function inspected(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  return ROOTS.flatMap((dir) => walk(join(ROOT, dir)))
    .map((file) => relative(ROOT, file).replace(/\\/g, '/'))
    .filter((file) => PARSED.has(extname(file).toLowerCase()))
    .sort();
}

/** Every audit there is, discovered rather than listed. */
function everyAudit(): Audit[] {
  return inspected().flatMap((file) => auditsIn(file));
}

describe('MUSE-98: the accessibility gate runs every rule axe enables by default', () => {
  /**
   * The loops below are loops over this discovery, so it is asserted before anything is
   * asserted with it. A discovery that silently stops matching does not fail a loop — it
   * makes the loop pass over nothing, which is the shape of "a check that confirms the
   * wrong thing" this board has re-filed several times, and is the shape MUSE-98 itself
   * is: a guard reading as though it covered something.
   */
  it('finds every axe audit in the repository, and every one is classified', () => {
    const counted = new Map<string, number>();
    for (const { file } of everyAudit()) counted.set(file, (counted.get(file) ?? 0) + 1);

    expect([...counted].sort(([a], [b]) => a.localeCompare(b))).toEqual(
      [...AXE_SITES]
        .map(([file, { audits }]): [string, number] => [file, audits])
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  });

  it('is reading the tree it claims to read', () => {
    // The reader against the real gate, spelled out, before any verdict is drawn from it.
    // The discovery above would notice the parse breaking, and this says what it found:
    // one audit, one call, one option. Every verdict below rests on that being the whole
    // of the gate's configuration, so it is written down rather than implied.
    expect(
      auditsIn('scripts/a11y.mjs').map(({ chain, options }) => ({ chain, options })),
    ).toEqual([{ chain: [ANALYZE], options: [PAGE] }]);
  });

  /**
   * The ticket's first acceptance criterion. Add the four tags MUSE-75 removed and this is
   * the test that goes red, naming the file, the line and why the filter may not come back.
   */
  it('lets the gate configure nothing — no tag filter, no rule list, no axe of its own', () => {
    const offences: Offence[] = [];
    for (const audit of everyAudit()) {
      const site = AXE_SITES.get(audit.file);
      if (site === undefined || site.kind !== 'default') continue;

      if (audit.chain.length !== 1 || audit.chain[0] !== ANALYZE) {
        offences.push({
          file: audit.file,
          line: audit.line,
          what:
            `the audit calls ${audit.chain.map((name) => `.${name}()`).join('') || 'nothing'} on ` +
            `the builder; .${ANALYZE}() and nothing else is the rule (MUSE-75). ${site.why} ` +
            `A filter is a list of standards worth checking, which is a list to keep ` +
            `current: with none, the next axe-core release widens what this sees. If this ` +
            `audit really must narrow, move it to AXE_SITES as 'narrowed' with a ticket — ` +
            `do not add the tag back.`,
        });
      }
      if (audit.options.length !== 1 || audit.options[0] !== PAGE) {
        offences.push({
          file: audit.file,
          line: audit.line,
          what:
            `the builder is constructed with { ${audit.options.join(', ')} }; { ${PAGE} } and ` +
            `nothing else is the rule (MUSE-75) — an axeSource replaces axe-core wholesale, ` +
            `which is the same narrowing by a different door.`,
        });
      }
    }
    expect(listed(offences)).toEqual([]);
  });

  /**
   * The second criterion, and the direction is the whole of it. `test/contact.test.ts`
   * audits the trial form's error states against WCAG A/AA and that is its own ticket's
   * business — so it must keep passing. An exemption that only ever excuses is one nobody
   * deletes, so it is asserted **still live**: widen contact to the default set and this
   * goes red asking for the entry to go.
   */
  it('leaves a narrower audit alone, and holds its exemption to still being needed', () => {
    const offences: Offence[] = [];
    for (const audit of everyAudit()) {
      const site = AXE_SITES.get(audit.file);
      if (site === undefined || site.kind !== 'narrowed') continue;

      if (audit.chain.length === 1 && audit.chain[0] === ANALYZE) {
        offences.push({
          file: audit.file,
          line: audit.line,
          what:
            `is listed in AXE_SITES as a deliberately narrower audit ("${site.why}") and now ` +
            `configures nothing, so the exemption excuses something that is no longer ` +
            `happening. Delete the entry — an exemption nobody can fail is one nobody ` +
            `removes.`,
        });
      }
      if (!audit.chain.includes(ANALYZE)) {
        offences.push({
          file: audit.file,
          line: audit.line,
          what: `configures a builder it never runs — the chain is ${JSON.stringify(audit.chain)}.`,
        });
      }
    }
    expect(listed(offences)).toEqual([]);
  });
});

/**
 * **The other half of MUSE-75, guarded with the first.**
 *
 * `incomplete` is axe saying *I could not tell* — most often a contrast ratio over an image
 * or a gradient. The gate prints a count and the rule names and never fails on them, which
 * is the honest reading of a green run; failing on them would make the gate red for
 * decorative elements that are correct, and silently folding them into the exit code is the
 * same over-promise MUSE-75 removed, pointing the other way.
 *
 * The counter is identified as **whatever decides the exit code** rather than by its name,
 * so a rename cannot make this pass over nothing.
 */
describe('MUSE-98: an undecided result is a note and never a failure (MUSE-75)', () => {
  const GATE = 'scripts/a11y.mjs';

  interface Gate {
    /** The identifier the non-zero exit is guarded by. */
    counter: string;
    /** Every `x += …` in the file: the target, the right-hand side's text, and the line. */
    increments: { target: string; value: string; line: number }[];
  }

  function readGate(): Gate {
    const text = readFileSync(join(ROOT, GATE), 'utf8');
    const tree = ts.createSourceFile(
      GATE,
      text,
      ts.ScriptTarget.ESNext,
      /* setParentNodes */ true,
      ts.ScriptKind.JS,
    );

    const counters = new Set<string>();
    const increments: Gate['increments'] = [];

    const visit = (node: ts.Node): void => {
      // `process.exit(1)` — walk out to the `if` that guards it and read its condition.
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(tree) === 'process.exit' &&
        node.arguments[0]?.getText(tree) === '1'
      ) {
        for (let up: ts.Node | undefined = node; up !== undefined; up = up.parent) {
          if (!ts.isIfStatement(up)) continue;
          const named = (inner: ts.Node): void => {
            if (ts.isIdentifier(inner)) counters.add(inner.text);
            ts.forEachChild(inner, named);
          };
          named(up.expression);
          break;
        }
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
        ts.isIdentifier(node.left)
      ) {
        increments.push({
          target: node.left.text,
          value: node.right.getText(tree),
          line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);

    expect([...counters], `${GATE}: the exit is not guarded by one identifier`).toHaveLength(1);
    return { counter: [...counters][0] as string, increments };
  }

  it('fails on violations, and on nothing axe could not decide', () => {
    const { counter, increments } = readGate();
    const failing = increments.filter(({ target }) => target === counter);

    // The discovery, asserted before the verdict: the gate counts violations somewhere, or
    // this test is a loop over nothing.
    expect(failing.length, `${GATE}: nothing adds to \`${counter}\``).toBeGreaterThan(0);
    expect(
      listed(
        failing
          .filter(({ value }) => value.includes('incomplete'))
          .map(({ value, line }) => ({
            file: GATE,
            line,
            what:
              `adds ${value} to \`${counter}\`, which decides the exit code — axe raises an ` +
              `incomplete result when it cannot compute the answer itself, so it is reported ` +
              `as a note and never failed on (MUSE-75).`,
          })),
      ),
    ).toEqual([]);
  });

  it('reports them rather than dropping them', () => {
    const { counter, increments } = readGate();
    const noted = increments.filter(
      ({ target, value }) => target !== counter && value.includes('incomplete'),
    );
    expect(
      noted.length,
      `${GATE}: nothing counts axe's incomplete results, so a green run says nothing about ` +
        `what it could not decide`,
    ).toBeGreaterThan(0);
  });
});

/**
 * **The reader, tested as a reader.**
 *
 * Against source strings rather than files on disk, for `test/helpers/source-guard.ts`'s
 * reason: a fixture file under `test/` that deliberately breaks the rules is a worse
 * problem than the one it solves, and a string is not a file. These are the evasions that
 * matter — the filter MUSE-75 removed, the comment that explains the removal, an aliased
 * import, and a builder configured a line after it is constructed.
 */
describe('MUSE-98: the rule reads the call, not the text of the file', () => {
  const importLine = `import { ${AXE_EXPORT} } from '${AXE_PACKAGE}';\n`;

  it('sees a bare audit as configuring nothing', () => {
    const probe = `${importLine}const r = await new ${AXE_EXPORT}({ page }).${ANALYZE}();\n`;
    expect(
      auditsIn('probe.mjs', probe).map(({ chain, options }) => ({ chain, options })),
    ).toEqual([{ chain: [ANALYZE], options: [PAGE] }]);
  });

  it('sees the tag filter MUSE-75 removed', () => {
    const probe =
      `${importLine}const r = await new ${AXE_EXPORT}({ page })\n` +
      `  .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])\n` +
      `  .${ANALYZE}();\n`;
    expect(auditsIn('probe.mjs', probe).map(({ chain }) => chain)).toEqual([
      ['withTags', ANALYZE],
    ]);
  });

  it('is not tripped by the comment that explains the removal', () => {
    // The two surviving mentions in `scripts/a11y.mjs` are prose of exactly this shape, and
    // a textual needle would report them — which is the failure mode that makes a guard get
    // weakened instead of fixed.
    const probe =
      `${importLine}// This read .withTags(['wcag2a']) until MUSE-75 removed it.\n` +
      `/** No .withTags() at all rather than the old list plus 'best-practice'. */\n` +
      `const r = await new ${AXE_EXPORT}({ page }).${ANALYZE}();\n`;
    expect(auditsIn('probe.mjs', probe).map(({ chain }) => chain)).toEqual([[ANALYZE]]);
  });

  it('follows an aliased import to the construction', () => {
    const probe =
      `import { ${AXE_EXPORT} as Builder } from '${AXE_PACKAGE}';\n` +
      `const r = await new Builder({ page }).withRules(['region']).${ANALYZE}();\n`;
    expect(auditsIn('probe.mjs', probe).map(({ chain }) => chain)).toEqual([
      ['withRules', ANALYZE],
    ]);
  });

  it('follows a namespace import too', () => {
    const probe =
      `import * as axe from '${AXE_PACKAGE}';\n` +
      `const r = await new axe.${AXE_EXPORT}({ page }).${ANALYZE}();\n`;
    expect(auditsIn('probe.mjs', probe).map(({ chain }) => chain)).toEqual([[ANALYZE]]);
  });

  it('reads a builder configured a line later as a chain of nothing, which is not the rule', () => {
    // The dataflow evasion, and the reason the rule is an allow-list: this is *not*
    // `['analyze']`, so it is red. A deny-list of method names would have been green.
    const probe =
      `${importLine}const b = new ${AXE_EXPORT}({ page });\n` +
      `b.withTags(['wcag2a']);\nconst r = await b.${ANALYZE}();\n`;
    expect(auditsIn('probe.mjs', probe).map(({ chain }) => chain)).toEqual([[]]);
  });

  it('reads an axe of the audit’s own as an option', () => {
    const probe = `${importLine}const r = await new ${AXE_EXPORT}({ page, axeSource: mine }).${ANALYZE}();\n`;
    expect(auditsIn('probe.mjs', probe).map(({ options }) => options)).toEqual([
      ['axeSource', PAGE],
    ]);
  });

  it('says nothing about a file that never imports the package', () => {
    expect(
      auditsIn('probe.mjs', `const r = new ${AXE_EXPORT}({ page }).${ANALYZE}();\n`),
    ).toEqual([]);
  });
});

import { readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * What a file under `test/` actually *does*, read off its syntax tree.
 *
 * `test/isolation.test.ts` enforces MUSE-17's invariants on the test tree itself, and
 * until MUSE-34 it did that by searching the source text for words. A substring scan
 * over raw text gets both answers wrong, and the ticket demonstrated both in one file:
 *
 *   - **False negative.** The needles were `rmSync`, `rmdir` and `promises.rm(`, so
 *     `import { rm } from 'node:fs/promises'` followed by `await rm(dir, …)` matched
 *     nothing. The same for a deletion reached through an alias, a namespace import, or
 *     `require`.
 *   - **False positive.** A *doc comment* that merely mentioned a forbidden word failed
 *     CI, pointing at prose instead of code. That is how a guard gets weakened rather
 *     than fixed: the cheapest way to make the message go away is to edit the needle.
 *
 * So the rules are expressed against syntax instead: an import's *imported* name (not
 * the local alias), a call's callee, a string literal's value. Comments are not any of
 * those things, so they cannot trip a rule, and an alias cannot slip past one.
 *
 * The parse is the point, not an optimisation — it is why these questions have answers
 * at all. `typescript` is already a devDependency (`astro check` runs on it), the files
 * are small, and the whole tree parses in well under a second.
 *
 * `copyPasteTripwire` keeps the old textual scan as a *second* line, over code with the
 * comments blanked out. It catches the shapes no rule here models — a deletion through
 * a package nobody has thought of yet, a shelled-out `rm -rf` — and it is deliberately
 * not the only line any more.
 *
 * MUSE-54 added `fixedSleeps` here rather than as a fourth scan beside this module,
 * because that is the form the rule has to take: a *call* named `waitForTimeout`. The
 * doc comment under that function mentions the name several times and does not trip it —
 * which is the whole reason the rules read syntax, and is why the sentence explaining why
 * a sleep was removed can stay in the file it was removed from. What the rule cannot
 * reach is written out there too, under its own heading, rather than left implied.
 */

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TEST_DIR = fileURLToPath(new URL('..', import.meta.url));

/** One rule violation, with enough detail for the failure message to be actionable. */
export interface Offence {
  /** Repo-relative, forward slashes. */
  file: string;
  /** 1-based, so it can be pasted after a colon. */
  line: number;
  /** What was found, in the words of the rule that found it. */
  what: string;
}

/**
 * A needle assembled from pieces at runtime.
 *
 * This module is part of the tree it inspects, so a literal `'rmSync'` in the list below
 * would be a `rmSync` in the source — and `copyPasteTripwire`, which searches text, would
 * report this file. The alternative is an exemption for the guard, which is precisely the
 * hole MUSE-34 was filed about: a guard that does not apply to itself.
 *
 * Splitting the word means the joined form never appears in the file. The AST rules do
 * not need this (an identifier in a *string* is not a call), but the tripwire does, and
 * one convention for both is easier to keep than two.
 */
export const frag = (...parts: string[]): string => parts.join('');

/** `node_modules`, the directory nothing but `scratch.ts` may name. */
const NODE_MODULES = frag('node_', 'modules');

const CHILD_PROCESS = frag('child_', 'process');

/** Removal APIs, by the name they are *exported* under. Aliases are resolved by rule. */
const REMOVAL_NAMES = new Set([
  frag('r', 'm'),
  frag('r', 'mSync'),
  frag('r', 'mdir'),
  frag('r', 'mdirSync'),
  frag('un', 'link'),
  frag('un', 'linkSync'),
  frag('rim', 'raf'),
  frag('rim', 'rafSync'),
]);

/** Modules whose removal exports are the ones above. */
const FS_MODULES = new Set(['fs', 'node:fs', 'fs/promises', 'node:fs/promises']);

/** Modules that exist to delete things; importing anything from one is the offence. */
const DELETE_MODULES = new Set([
  frag('rim', 'raf'),
  'fs-extra',
  'del',
  'trash',
  'shelljs',
]);

/** Modules that start processes. Importing anything from one is the offence. */
const PROCESS_MODULES = new Set([
  CHILD_PROCESS,
  `node:${CHILD_PROCESS}`,
  'node:worker_threads',
  'worker_threads',
  'execa',
  frag('cross-', 'spa', 'wn'),
  'zx',
  'shelljs',
]);

/** Called by name — `spawn(…)`, `execSync(…)` — these can only be the real thing. */
const BARE_STARTERS = new Set([
  frag('spa', 'wn'),
  frag('spa', 'wnSync'),
  frag('ex', 'ec'),
  frag('ex', 'ecSync'),
  frag('ex', 'ecFile'),
  frag('ex', 'ecFileSync'),
  'fork',
]);

/**
 * Called on an object — `cp.execSync(…)`.
 *
 * `exec` is absent on purpose: `DEV_URL.exec(log)` is a regular expression, and half the
 * suites do that. The import rule is what covers `cp.exec`, and an import is the only way
 * to get hold of the real one.
 */
const MEMBER_STARTERS = new Set(
  [...BARE_STARTERS].filter((name) => name !== frag('ex', 'ec')),
);

/**
 * Playwright's fixed sleep, by the name it is called under.
 *
 * MUSE-54. Three suites flaked in one afternoon and three of the sleeps were in one file,
 * which is MUSE-17's shape again: the instance was fixed under MUSE-33 and the pattern was
 * left, so it came back. A sleep is the only one of these shapes a rule can state exactly
 * — it has a name and it is always a call — so this is where the guard is sharpest and the
 * honesty note below the rule is where it stops.
 *
 * Split with `frag` like everything else here: the joined form never appears in this file,
 * so the textual tripwire that now carries it does not report its own definition.
 */
const SLEEP_NAMES = new Set([frag('waitFor', 'Timeout')]);

// ---------------------------------------------------------------------------
// The census: every file under `test/` is one of three kinds, and a fourth is an
// error rather than a file nobody looks at.
// ---------------------------------------------------------------------------

/**
 * Extensions that are parsed and checked against every rule.
 *
 * The list is long because MUSE-34's second hole was that it was one entry long. The old
 * walk collected `.ts` and nothing else, so moving identical rogue code into a plain
 * `.mjs` helper and importing it from a `.test.ts` left the guard green **in the same run
 * where two suites collided over one build directory and one of them never ran**.
 */
export const PARSED_EXTENSIONS = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
] as const;

/**
 * Extensions parsed in part: an `.astro` component's frontmatter is TypeScript and runs
 * during a build, so it gets the AST rules; its template is scanned as text.
 */
export const MARKUP_EXTENSIONS = ['.astro'] as const;

/** Extensions that cannot execute: fixtures, snapshots, expected output. */
export const INERT_EXTENSIONS = [
  '.json',
  '.ndjson',
  '.html',
  '.css',
  '.svg',
  '.txt',
  '.md',
  '.snap',
  '.woff2',
  '.woff',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.avif',
  '.ico',
] as const;

/** Every file under `test/`, whatever it is, as repo-relative paths. */
export function testFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      return entry.isDirectory() ? walk(full) : [full];
    });
  return walk(TEST_DIR)
    .map((f) => relative(ROOT, f).replace(/\\/g, '/'))
    .sort();
}

/** The files the rules below are able to read. */
export function inspectedFiles(): string[] {
  return testFiles().filter((file) => kindOf(file) !== 'inert');
}

type Kind = 'parsed' | 'markup' | 'inert' | 'unknown';

function kindOf(file: string): Kind {
  const ext = extname(file).toLowerCase();
  if ((PARSED_EXTENSIONS as readonly string[]).includes(ext)) return 'parsed';
  if ((MARKUP_EXTENSIONS as readonly string[]).includes(ext)) return 'markup';
  if ((INERT_EXTENSIONS as readonly string[]).includes(ext)) return 'inert';
  return 'unknown';
}

/**
 * Files whose extension no list above claims.
 *
 * Reported rather than ignored: an unlisted extension is a file the rules silently do not
 * read, and "silently not read" is how the `.mjs` hole worked. Adding one line to a list
 * is a decision; being skipped by accident is not.
 */
export function uncheckedKinds(): Offence[] {
  return testFiles()
    .filter((file) => kindOf(file) === 'unknown')
    .map((file) => ({
      file,
      line: 1,
      what: `no rule reads ${extname(file) || 'an extensionless file'} — add it to PARSED_EXTENSIONS, MARKUP_EXTENSIONS or INERT_EXTENSIONS in test/helpers/source-guard.ts`,
    }));
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

interface Import {
  /** The module specifier as written: `node:fs/promises`. */
  module: string;
  /** The name as *exported* by that module, or `null` for a namespace/default/bare import. */
  name: string | null;
  line: number;
}

interface Call {
  /**
   * Was it called *on* something — `cp.execSync(…)`, `/re/.exec(…)` — or by bare name?
   *
   * The distinction is syntactic rather than a side effect of whether the object could be
   * named: `/re/.exec(x)` has no identifier to report and is still a method call, and
   * treating it as a bare `exec(…)` would make every regular expression in the suite an
   * offence.
   */
  member: boolean;
  /** The object a method was called on, when it was written as an identifier. */
  object: string | null;
  /** The callee's own name: `rm`, `rmSync`, `spawn`. */
  name: string;
  line: number;
}

interface Facts {
  file: string;
  /** The raw file. */
  text: string;
  /** The same bytes with every comment replaced by spaces, newlines kept. */
  code: string;
  imports: Import[];
  calls: Call[];
  /** Every string literal and every template-literal text span, separately. */
  literals: { value: string; line: number }[];
}

const cache = new Map<string, Facts>();

/**
 * Read and parse `file`, or parse `source` as if it were `file`.
 *
 * The second form is how the rules are tested *as rules* — `test/isolation.test.ts`
 * hands them the evasions MUSE-34 demonstrated and asserts the verdict. A fixture file
 * on disk would be a file under `test/` that deliberately breaks the rules, which is a
 * worse problem than the one it solves; a string is not.
 */
function facts(file: string, source?: string): Facts {
  const hit = source === undefined ? cache.get(file) : undefined;
  if (hit) return hit;

  const text = source ?? readFileSync(join(ROOT, file), 'utf8');
  const view = executableView(file, text);
  const tree = ts.createSourceFile(
    file,
    view,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ true,
    scriptKind(file),
  );

  const imports: Import[] = [];
  const calls: Call[] = [];
  const literals: { value: string; line: number }[] = [];
  const lineOf = (node: ts.Node): number =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

  const visit = (node: ts.Node): void => {
    collect(node, { imports, calls, literals }, lineOf);
    ts.forEachChild(node, visit);
  };
  visit(tree);

  const built: Facts = {
    file,
    text,
    code: blankRanges(text, commentRanges(tree, view)),
    imports,
    calls,
    literals,
  };
  if (source === undefined) cache.set(file, built);
  return built;
}

function scriptKind(file: string): ts.ScriptKind {
  if (file.endsWith('.tsx') || file.endsWith('.jsx')) return ts.ScriptKind.TSX;
  if (/\.(?:m|c)?js$/.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * The part of the file that can execute, at its original offsets.
 *
 * For anything in the JS/TS family that is the whole file. For an `.astro` component it
 * is the frontmatter; the template is blanked rather than removed, so a reported line
 * number still matches the file a human opens.
 */
function executableView(file: string, text: string): string {
  if (!file.endsWith('.astro')) return text;

  const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fence) return blank(text, 0, 0);

  const start = fence.index + fence[0].indexOf('\n') + 1;
  return blank(text, start, start + (fence[1]?.length ?? 0));
}

/** `text` with everything outside `[from, to)` turned into spaces, newlines preserved. */
function blank(text: string, from: number, to: number): string {
  const hide = (slice: string): string => slice.replace(/[^\n]/g, ' ');
  return hide(text.slice(0, from)) + text.slice(from, to) + hide(text.slice(to));
}

function collect(
  node: ts.Node,
  into: { imports: Import[]; calls: Call[]; literals: { value: string; line: number }[] },
  lineOf: (node: ts.Node) => number,
): void {
  // import … from 'x'  /  export … from 'x'
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    const module = node.moduleSpecifier.text;
    const names = importedNames(node);
    if (names.length === 0) into.imports.push({ module, name: null, line: lineOf(node) });
    for (const name of names) into.imports.push({ module, name, line: lineOf(node) });
    return;
  }

  if (ts.isCallExpression(node)) {
    const callee = node.expression;

    // import('x') and require('x') — the other two ways in.
    const dynamic =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require');
    const first = node.arguments[0];
    if (dynamic && first !== undefined && ts.isStringLiteral(first)) {
      into.imports.push({ module: first.text, name: null, line: lineOf(node) });
      return;
    }

    if (ts.isIdentifier(callee)) {
      into.calls.push({ member: false, object: null, name: callee.text, line: lineOf(node) });
    } else if (ts.isPropertyAccessExpression(callee)) {
      into.calls.push({
        member: true,
        object: ts.isIdentifier(callee.expression) ? callee.expression.text : null,
        name: callee.name.text,
        line: lineOf(node),
      });
    } else if (ts.isElementAccessExpression(callee)) {
      // fs['rmSync'](…) — the string is the name.
      const key = callee.argumentExpression;
      if (ts.isStringLiteral(key)) {
        into.calls.push({ member: true, object: null, name: key.text, line: lineOf(node) });
      }
    }
    return;
  }

  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    into.literals.push({ value: node.text, line: lineOf(node) });
    return;
  }

  // A template literal's spans are separate values: `node_${'modules'}` is two pieces,
  // and joining them is what the needle-splitting convention above relies on.
  if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
    into.literals.push({ value: node.text, line: lineOf(node) });
  }
}

/** The names an import clause brings in, as the *exporting* module spells them. */
function importedNames(node: ts.ImportDeclaration | ts.ExportDeclaration): string[] {
  const clause = ts.isImportDeclaration(node) ? node.importClause : node.exportClause;
  if (clause === undefined) return [];

  if (ts.isImportClause(clause)) {
    const names: string[] = [];
    if (clause.name) names.push(clause.name.text);
    const bindings = clause.namedBindings;
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const element of bindings.elements) {
        // `propertyName` is the exported name when the import is aliased.
        names.push((element.propertyName ?? element.name).text);
      }
    }
    return names;
  }

  if (ts.isNamedExports(clause)) {
    return clause.elements.map((element) => (element.propertyName ?? element.name).text);
  }
  return [];
}

/**
 * Where the comments are, according to the parser that read the file.
 *
 * Deliberately **not** a lexer of its own. A raw `ts.createScanner` loop gets this wrong
 * in a way that is invisible until it bites: a template literal with a substitution —
 * `` `node:${CHILD_PROCESS}` `` — leaves the scanner needing `reScanTemplateToken` after
 * the closing brace, which only a parser calls, so the next backtick it meets opens a
 * template that swallows everything up to the following one. Measured here: the first
 * backtick in a doc comment nine lines later closed it, and from that point every comment
 * in the file was scanned as code. The guard then reported its own prose — the exact
 * false positive MUSE-34 is about, reintroduced by the fix for it.
 *
 * The parse has already happened, so the comment ranges are free: every token's leading
 * and trailing trivia, including the end-of-file token's, which is where a comment after
 * the last statement lives.
 */
function commentRanges(tree: ts.SourceFile, text: string): [number, number][] {
  const ranges: [number, number][] = [];
  const seen = new Set<number>();

  const visit = (node: ts.Node): void => {
    if (!seen.has(node.pos)) {
      seen.add(node.pos);
      for (const range of ts.getLeadingCommentRanges(text, node.pos) ?? []) {
        ranges.push([range.pos, range.end]);
      }
      for (const range of ts.getTrailingCommentRanges(text, node.end) ?? []) {
        ranges.push([range.pos, range.end]);
      }
    }
    for (const child of node.getChildren(tree)) visit(child);
  };
  visit(tree);

  return ranges;
}

/**
 * `text` with every range replaced by spaces of the same length.
 *
 * Lengths and line breaks are preserved so a tripwire hit still reports the line a human
 * can open the file to.
 */
function blankRanges(text: string, ranges: [number, number][]): string {
  const chars = text.split('');
  for (const [from, to] of ranges) {
    for (let i = from; i < to && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  }
  return chars.join('');
}

// ---------------------------------------------------------------------------
// The rules
// ---------------------------------------------------------------------------

/** Deletions: an import of a removal API, or a call to one. */
export function deletions(file: string, source?: string): Offence[] {
  const { imports, calls } = facts(file, source);
  const found: Offence[] = [];

  for (const { module, name, line } of imports) {
    if (DELETE_MODULES.has(module)) {
      found.push({ file, line, what: `imports from '${module}', which deletes files` });
    } else if (name !== null && FS_MODULES.has(module) && REMOVAL_NAMES.has(name)) {
      found.push({ file, line, what: `imports ${name} from '${module}'` });
    }
  }

  for (const call of calls) {
    if (REMOVAL_NAMES.has(call.name)) {
      found.push({ file, line: call.line, what: `calls ${named(call)}` });
    }
  }

  return found;
}

/** Child processes: an import of a module that starts one, or a call that starts one. */
export function processStarts(file: string, source?: string): Offence[] {
  const { imports, calls } = facts(file, source);
  const found: Offence[] = [];

  for (const { module, line } of imports) {
    if (PROCESS_MODULES.has(module)) {
      found.push({ file, line, what: `imports '${module}', which starts processes` });
    }
  }

  for (const call of calls) {
    const starts = call.member ? MEMBER_STARTERS.has(call.name) : BARE_STARTERS.has(call.name);
    if (starts) found.push({ file, line: call.line, what: `calls ${named(call)}` });
  }

  return found;
}

/**
 * Fixed sleeps: a call to the thing that waits on the clock instead of on a condition.
 *
 * Stated as **a call whose callee is named `waitForTimeout`** — a member call, a bare one,
 * or one reached through a string key. Not a substring scan, which is the distinction
 * MUSE-34 established and left a note asking for: a comment explaining *why there is no
 * sleep here any more* must not fail CI, because the cheapest way to make that message go
 * away is to delete the comment, and then the reasoning is gone too.
 *
 * ---
 *
 * **What this rule cannot reach.** MUSE-54's three sightings were one sleep, one scroll
 * assertion and one selector wait, and only the first has a name to match. So, plainly:
 *
 *   - **A measurement taken too early with no wait at all.** `test/contact.test.ts`'s CTA
 *     flake was `getBoundingClientRect` read while the page was still scrolling. There is
 *     no call to forbid — the defect is the *absence* of a wait — and nothing short of
 *     knowing what each assertion depends on could see it.
 *   - **A poll that samples on a fixed interval.** The old `settleScroll` slept 25 ms
 *     between reads inside a loop, which is the same bet wearing a loop. This rule would
 *     catch today's spelling because the sleep was still `waitForTimeout`; rewrite it as a
 *     Node `setTimeout` and it would not. `setTimeout` is deliberately *not* on the list:
 *     `test/helpers/scratch.ts` uses two for a process-kill grace period, which is a timer
 *     doing a timer's job, and a rule that fires on it would be turned off rather than
 *     obeyed.
 *   - **A wait on the right condition with too small a budget.** `test/trialform.test.ts`
 *     waited for exactly the right selector and gave it 15 s on a machine running ten
 *     builds. A timeout argument is a number; no rule can tell a generous one from a tight
 *     one.
 *
 * The first and third are covered by `test/helpers/browser-settle.ts` being the one place
 * these suites wait, not by a rule here. That is a convention, and this file exists
 * because conventions do not hold — which is the honest state of it rather than a gap
 * being talked around.
 */
export function fixedSleeps(file: string, source?: string): Offence[] {
  return facts(file, source)
    .calls.filter((call) => SLEEP_NAMES.has(call.name))
    .map((call) => ({
      file,
      line: call.line,
      what:
        `calls ${named(call)} — a fixed sleep is a bet that the machine is not busy ` +
        `(MUSE-54). Wait for the condition it is approximating; ` +
        `test/helpers/browser-settle.ts has the shapes.`,
    }));
}

/**
 * Build directories named in code.
 *
 * A string literal, not the file's text: a comment that explains where builds go — and
 * several of them do — is documentation, not a second place the path is decided.
 */
export function buildDirectoryNames(file: string, source?: string): Offence[] {
  return facts(file, source)
    .literals.filter(({ value }) => value.includes(NODE_MODULES))
    .map(({ value, line }) => ({
      file,
      line,
      what: `the string ${JSON.stringify(value)} names a build directory`,
    }));
}

/**
 * The textual scan, kept as a second line and run over code with comments blanked.
 *
 * It exists for the shapes the rules above do not model: a deletion through a package
 * nobody has imported yet, an `rm -rf` handed to a shell, a path pasted in from a script.
 * It is a tripwire, so it is allowed to be crude — but it is no longer allowed to be
 * crude *about comments*, which is what made it fire on prose and miss the call beside it.
 */
export function copyPasteTripwire(file: string, source?: string): Offence[] {
  const { code } = facts(file, source);
  const needles: RegExp[] = [
    new RegExp(`\\b${frag('r', 'm')}\\b`),
    new RegExp(`\\b${frag('r', 'mSync')}\\b`),
    new RegExp(`\\b${frag('r', 'mdir')}`),
    new RegExp(`\\b${frag('un', 'link')}\\b`),
    new RegExp(`\\b${frag('un', 'linkSync')}\\b`),
    new RegExp(frag('rim', 'raf')),
    new RegExp(CHILD_PROCESS),
    new RegExp(`\\b${frag('spa', 'wn')}`),
    new RegExp(`\\b${frag('ex', 'ecSync')}\\b`),
    new RegExp(`\\b${frag('ex', 'ecFile')}`),
    new RegExp(NODE_MODULES),
    // MUSE-54, as a second line behind the AST rule: the name assembled at runtime, or
    // reached through a key the parser sees as a string rather than as a callee.
    new RegExp(frag('waitFor', 'Timeout')),
  ];

  const found: Offence[] = [];
  code.split('\n').forEach((text, index) => {
    for (const needle of needles) {
      const hit = needle.exec(text);
      if (hit) found.push({ file, line: index + 1, what: `tripwire: ${hit[0]}` });
    }
  });
  return found;
}

/** How a call reads in a failure message. */
function named({ object, name }: Call): string {
  return object === null ? name : `${object}.${name}`;
}

/** `file:line — what`, the form a failure message can be read out of. */
export function listed(offences: Offence[]): string[] {
  return offences.map(({ file, line, what }) => `${file}:${line} — ${what}`);
}

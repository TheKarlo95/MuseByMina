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
 * MUSE-107 moved MUSE-48's browser rules in for the same reason, and they are the third
 * demonstration of both failures in one guard. `test/browserlocale.test.ts` searched each
 * line of a discovered file for an assembled substring, so `browser['new' + 'Context']({
 * locale: 'en-US' })` planted in `scripts/a11y.mjs` left the guard green — and the guard
 * had to assemble its needles from fragments in the first place *because* it searched
 * text and would otherwise have reported its own prose. A rule over a callee has neither
 * problem: the names below are spelled out, a comment that mentions one is not a call, and
 * a computed member is folded to the name it computes. Discovery moved with them —
 * `drivesBrowser` asks the parser which module a file imports, so `await import('play' +
 * 'wright')` is an import of Playwright rather than a line no regular expression matched.
 *
 * MUSE-54 added `fixedSleeps` here rather than as a fourth scan beside this module,
 * because that is the form the rule has to take: a *call* named `waitForTimeout`. The
 * doc comment under that function mentions the name several times and does not trip it —
 * which is the whole reason the rules read syntax, and is why the sentence explaining why
 * a sleep was removed can stay in the file it was removed from. What the rule cannot
 * reach is written out there too, under its own heading, rather than left implied.
 *
 * ---
 *
 * ## What this module cannot see
 *
 * Each rule carries its own limits under its own heading. These are the limits of the
 * *facts* every rule reads, so they apply to all of them at once — and they are here
 * because MUSE-113 found three shapes that got past the guard, two of which the module
 * claimed no limitation about. „The guard passes because it cannot see" is the failure mode
 * this file exists to prevent, so a limit that is not written down is the defect.
 *
 *   - **`inspectedFiles()` walks `test/` and nothing else, so no census taken with it reads
 *     `scripts/`** (MUSE-113). The rules themselves take a path and have no opinion about
 *     it — `test/browserlocale.test.ts` already applies `drivesBrowser` and
 *     `browserOwnership` to `scriptFiles()`, which is where the browser exposure in
 *     `scripts/` is actually bounded, and `test/isolation.test.ts`'s own census is the one
 *     that stops at `test/`. **Widening that walk was considered and rejected**: the
 *     invariants it enforces are MUSE-17's, which are about a *test* not choosing where it
 *     builds, and a script's job includes starting processes. Measured over the 17 files in
 *     `scripts/`: `processStarts` reports 6 and `copyPasteTripwire` 8, all of them in
 *     the two maintenance scripts that run `git` through `execFileSync` — correct code in
 *     both, and a guard that reddens correct code is a guard somebody turns off. (Neither is
 *     named here: one of the two is a command only a human may reach, which the guard three
 *     screens down this same tree enforces, and it reported this sentence when the first
 *     draft of it spelled the name.) The other five rules report nothing there today, which is
 *     the state the boundary is being stated against rather than an argument for moving it.
 *   - **A namespace import is read by the names the file takes off it**, not by the module
 *     it names (`namespaceImports`). A namespace reached some other way is not: `const fs =
 *     require('node:fs')` and `const ns = await import('playwright')` bind an object this
 *     module records as an import of no name, so the rules keyed on a name see nothing and
 *     only the rules keyed on a *module* or on a *call* apply — which is how both of those
 *     are in fact covered today, and `copyPasteTripwire` is the second line behind them.
 *   - **A name is matched across the whole file, never within a scope.** Two functions that
 *     both call their tab `tab` are one name here, so one gated tab satisfies an ungated
 *     one. That is acceptable only because the suite takes delivery of a tab in exactly one
 *     helper; the note under `uncommittedTabs` says what a second delivery point would have
 *     to bring with it.
 *   - **No value is followed.** `staticString` folds a name spelled in pieces and
 *     `candidateValues` flattens a `??`, and neither reads a variable, a function's return
 *     value or a property off an object. A rule that needed to would be a type checker.
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

/**
 * Playwright's "a tab appeared" events, and the helper that turns a tab into a document.
 *
 * MUSE-61. `context.waitForEvent('page')` resolves when the tab *object* exists, which in
 * Chromium is while it is still at `about:blank`; everything a test then waits on — `load`
 * on an already-loaded blank document, a `localStorage` read against an opaque origin — is
 * no barrier at all, and the assertion reads `about:blank` instead of the page it named.
 * `settleNewTab` in `test/helpers/browser-settle.ts` is the only wait in the tree that
 * establishes otherwise, so the rule is that a tab taken out of one of these events is
 * handed to it.
 *
 * Split with `frag` like everything else here, so the textual tripwire and the AST rule can
 * share one convention and this file never reports its own definitions.
 */
const TAB_EVENT = frag('waitFor', 'Event');
const TAB_EVENT_NAMES = new Set(['page', 'popup']);
const TAB_COMMIT = frag('settleNew', 'Tab');

/**
 * The dev server, and the module that asks a server whether its URLs name real pages.
 *
 * MUSE-62's rule, implemented here at its author's request rather than in a second parser
 * of the test tree: `test/fonts.test.ts` drove `astro dev` at a path that 404ed and measured
 * `404.astro` for eleven green tests, because the error page carries the same stylesheet and
 * the same six faces as every other page. `astroDev()` now probes a page through
 * `test/helpers/measured.ts` before handing the server over, which is the primary defence
 * and a runtime one; this is the belt, for the suite that reaches past the probe.
 */
const DEV_SERVER = frag('astro', 'Dev');
const MEASURED_MODULE = 'measured';

/**
 * The one module that may drive a browser, and the modules a browser can come from.
 *
 * MUSE-48's rule, MUSE-107's statement of it. A file drives a browser by **importing**
 * one of these, which is the only way to get one — so a script or suite written next year
 * is covered the day it is written, with nobody adding it to a list.
 *
 * `playwright` is matched exactly rather than by its last path segment, because
 * `@axe-core/playwright` is a different package that `scripts/a11y.mjs` legitimately
 * imports and that drives no browser of its own. `browser-checks.mjs` is matched by its
 * basename, because every importer spells the relative path differently.
 */
export const BROWSER_DOOR = 'scripts/browser-checks.mjs';
const BROWSER_DOOR_FILE = 'browser-checks.mjs';
const BROWSER_MODULES = new Set(['playwright', 'playwright-core', '@playwright/test']);

/**
 * Playwright's launchers, by the name the module exports them under.
 *
 * Importing one is the offence rather than only calling `launch` on it: a launcher handed
 * to another function launches just as well, and an import is the thing a rule over syntax
 * can see without following values about.
 */
const BROWSER_LAUNCHERS = new Set(['chromium', 'firefox', 'webkit']);

/**
 * The calls `scripts/browser-checks.mjs` owns, each with the reason it owns it.
 *
 * Spelled out, not assembled from fragments. The textual scan this replaces had to hide
 * these names from itself — `new${'Context('}` — because it searched the text of files
 * that include the guard's own prose, and the first draft of that prose reddened the run.
 * A rule over a *callee* has no such problem: a name inside a comment or a string is not a
 * call, which is the whole reason MUSE-34 made these rules read syntax.
 *
 * `launch` is the launcher's own method and nothing else in `test/` or `scripts/` calls a
 * method by that name — `launchChecks()`, the sanctioned one, is a different name, and it
 * is where the run's browser census is written (MUSE-68).
 */
const BROWSER_OWNED = new Map([
  [
    'newContext',
    'opens a browser context, which is where the language a page is measured as is decided',
  ],
  ['newPage', 'opens a page without asserting which page it then measured'],
  ['addInitScript', 'seeds the page before it runs — one of the two halves of the locale pin'],
  [
    'setItem',
    'writes stored state, and the write is a decision about which language is being measured',
  ],
  ['launch', 'starts a browser, which goes through launchChecks() so the census sees it'],
]);

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

export interface Import {
  /** The module specifier as written: `node:fs/promises`. */
  module: string;
  /** The name as *exported* by that module, or `null` for a namespace/default/bare import. */
  name: string | null;
  line: number;
}

export interface Call {
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
  /** The first argument when it is a string literal — `waitForEvent('page')`. */
  firstString: string | null;
  /** The first argument when it is a bare identifier — `settleNewTab(tab, …)`. */
  firstIdentifier: string | null;
  line: number;
}

/**
 * One `const x = …`, read down to the values its initializer can produce.
 *
 * Enough to track a tab from the event that produced it to the wait that commits it, which
 * is two hops at most: `const opened = ctx.waitForEvent('page')` and then
 * `const tab = await opened`. Deliberately not a scope-aware resolver — see the honesty note
 * under `uncommittedTabs` for what that costs.
 *
 * **The initializer is a *set* of candidate values, not one** (MUSE-113). It used to be
 * read as a single expression — a call, or an identifier, or nothing — so
 * `const opened = already ?? ctx.waitForEvent('page')` carried no callee, and the rule that
 * tracks tabs stopped tracking at the first hop. That shape silently disabled MUSE-61's
 * guard on an earlier cut of its own branch, which is written down above
 * `middleClickOpens` in `test/localeswitch.test.ts`. `??`, `||`, `&&` and `?:` are all the
 * same question — which branch runs is not a question syntax answers — so every branch is
 * a candidate and a rule asks whether *any* of them is the thing it forbids.
 */
interface Binding {
  name: string;
  line: number;
  /** Was the initializer, or any branch of it, `await`ed? */
  awaited: boolean;
  /**
   * Did the initializer choose between values — `a ?? f()`, `a || f()`, `a ? b : f()`?
   *
   * Then awaitedness is unknown rather than false: the alternative may be a value the
   * event's promise resolves to. `uncommittedTabs` is where that costs something and where
   * what it does about it is written out.
   */
  choice: boolean;
  /** Every candidate that is a call, by callee name and first string argument. */
  calls: { name: string; argument: string | null }[];
  /** Every candidate that is nothing but an identifier. */
  identifiers: string[];
}

interface Facts {
  file: string;
  /** The raw file. */
  text: string;
  /** The same bytes with every comment replaced by spaces, newlines kept. */
  code: string;
  imports: Import[];
  calls: Call[];
  /** Simple variable declarations, in source order. */
  bindings: Binding[];
  /** Every string literal and every template-literal text span, separately. */
  literals: { value: string; line: number }[];
}

/** `import * as ns from 'm'` — the local name, and the module behind it. */
interface Namespace {
  local: string;
  module: string;
  line: number;
}

/** `ns.name` or `ns['name']`, where the object is written as a plain identifier. */
interface Read {
  object: string;
  name: string;
  line: number;
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
  const bindings: Binding[] = [];
  const literals: { value: string; line: number }[] = [];
  const namespaces: Namespace[] = [];
  const reads: Read[] = [];
  const lineOf = (node: ts.Node): number =>
    tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;

  const visit = (node: ts.Node): void => {
    collect(node, { imports, calls, bindings, literals, namespaces, reads }, lineOf);
    ts.forEachChild(node, visit);
  };
  visit(tree);
  for (const entry of namespaceImports(namespaces, reads)) imports.push(entry);

  const built: Facts = {
    file,
    text,
    code: blankRanges(text, commentRanges(tree, view)),
    imports,
    calls,
    bindings,
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
  into: {
    imports: Import[];
    calls: Call[];
    bindings: Binding[];
    literals: { value: string; line: number }[];
    namespaces: Namespace[];
    reads: Read[];
  },
  lineOf: (node: ts.Node) => number,
): void {
  // `const x = …`. Recorded and then fallen through, not returned on: the initializer holds
  // calls and literals the rules above need, and an early return here would hide them.
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.initializer !== undefined
  ) {
    const values = candidateValues(node.initializer, false);
    into.bindings.push({
      name: node.name.text,
      line: lineOf(node),
      awaited: values.some(({ awaited }) => awaited),
      choice: values.length > 1,
      calls: values.flatMap(({ expression }) => {
        if (!ts.isCallExpression(expression)) return [];
        const name = calleeName(expression.expression);
        if (name === null) return [];
        const first = expression.arguments[0];
        return [
          {
            name,
            argument: first !== undefined && ts.isStringLiteral(first) ? first.text : null,
          },
        ];
      }),
      identifiers: values.flatMap(({ expression }) =>
        ts.isIdentifier(expression) ? [expression.text] : [],
      ),
    });
  }

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

    // `import * as ns from 'm'` brings in no *name*, so the entry above carries none and
    // every rule keyed on one goes quiet (MUSE-113). The names it brings in are the ones
    // the file then reads off `ns`, which `namespaceImports` pairs up once the whole file
    // has been walked.
    const local = namespaceLocal(node);
    if (local !== null) into.namespaces.push({ local, module, line: lineOf(node) });
    return;
  }

  if (ts.isCallExpression(node)) {
    const callee = node.expression;

    // import('x') and require('x') — the other two ways in.
    const dynamic =
      callee.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(callee) && callee.text === 'require');
    const first = node.arguments[0];
    const specifier = first === undefined ? null : staticString(first);
    // Folded, not read as one literal: `import('play' + 'wright')` is an import of
    // Playwright (MUSE-107), and a discovery that could not see it applied no rule to the
    // file at all.
    if (dynamic && specifier !== null) {
      into.imports.push({ module: specifier, name: null, line: lineOf(node) });
      return;
    }

    // The first argument, in the two forms a rule here asks about: `waitForEvent('page')`
    // and `settleNewTab(tab, …)`. Nothing deeper — a rule that needed to understand an
    // expression would be a type checker, not a guard.
    const firstString = first !== undefined && ts.isStringLiteral(first) ? first.text : null;
    const firstIdentifier =
      first !== undefined && ts.isIdentifier(first) ? first.text : null;

    if (ts.isIdentifier(callee)) {
      into.calls.push({
        member: false,
        object: null,
        name: callee.text,
        firstString,
        firstIdentifier,
        line: lineOf(node),
      });
    } else if (ts.isPropertyAccessExpression(callee)) {
      into.calls.push({
        member: true,
        object: ts.isIdentifier(callee.expression) ? callee.expression.text : null,
        name: callee.name.text,
        firstString,
        firstIdentifier,
        line: lineOf(node),
      });
    } else if (ts.isElementAccessExpression(callee)) {
      // fs['rmSync'](…) — the string is the name, and `browser['new' + 'Context'](…)` is
      // the same call written in pieces (MUSE-107).
      const key = staticString(callee.argumentExpression);
      if (key !== null) {
        into.calls.push({
          member: true,
          object: null,
          name: key,
          firstString,
          firstIdentifier,
          line: lineOf(node),
        });
      }
    }
    return;
  }

  // `ns.name` and `ns['name']`, which is how a namespace import is spent (MUSE-113). Not
  // returned on, and recorded for every object rather than only for a namespace: which
  // identifiers are namespaces is known once the whole file has been walked, and an import
  // can sit below its first use.
  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    into.reads.push({ object: node.expression.text, name: node.name.text, line: lineOf(node) });
  } else if (ts.isElementAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const key = staticString(node.argumentExpression);
    if (key !== null) {
      into.reads.push({ object: node.expression.text, name: key, line: lineOf(node) });
    }
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

/**
 * The string an expression computes, when it computes one without running anything.
 *
 * MUSE-107. The parser read `o['rmSync']` and `import('playwright')` and stopped at a
 * single literal, so `browser['new' + 'Context'](…)` and `await import('play' + 'wright')`
 * were a member call with no name and an import of nothing — a forbidden call inside a
 * discovered file, and a file discovery never reached. Both are the same evasion the
 * guards in this module already model for an *alias*: the name is there, spelled in
 * pieces, and joining pieces is something a reader does at a glance.
 *
 * Deliberately only the forms whose value is in the file: literals, a parenthesis, `+`
 * between two of them, and a template whose substitutions are themselves foldable. A
 * variable is not followed — that is a type checker's job, and `copyPasteTripwire` is the
 * second line for what no rule here models.
 *
 * **It is not used for `literals`**, which stay split per span: `buildDirectoryNames` and
 * the needle-splitting convention this module writes its own constants with both depend on
 * `node_${'modules'}` being two values. Folding is for the two places the file is *naming*
 * something — a callee and a module specifier.
 */
function staticString(expression: ts.Expression): string | null {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isParenthesizedExpression(expression)) return staticString(expression.expression);
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticString(expression.left);
    const right = staticString(expression.right);
    return left === null || right === null ? null : left + right;
  }
  if (ts.isTemplateExpression(expression)) {
    let joined = expression.head.text;
    for (const span of expression.templateSpans) {
      const piece = staticString(span.expression);
      if (piece === null) return null;
      joined += piece + span.literal.text;
    }
    return joined;
  }
  return null;
}

/**
 * The name a callee is written under — `f`, `o.f`, `o['f']` — or `null`.
 *
 * Only the callee's *own* name, the way the `Call` facts above read it: what a call is
 * reached through is a separate question and no rule here asks it.
 */
function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression)) {
    return staticString(expression.argumentExpression);
  }
  return null;
}

/**
 * The names an import clause brings in, as the *exporting* module spells them.
 *
 * A namespace import brings in no name here on purpose — `import * as ns` binds one local
 * object and the names are whatever the file reads off it, which is `namespaceImports`'
 * question (MUSE-113). The `name: null` entry this returns nothing for is still pushed, and
 * is what the rules keyed on a *module* rather than a name read: `drivesBrowser` never had
 * the hole for exactly that reason.
 */
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

/** The local name a namespace import binds, or `null` for any other import clause. */
function namespaceLocal(node: ts.ImportDeclaration | ts.ExportDeclaration): string | null {
  if (!ts.isImportDeclaration(node)) return null;
  const bindings = node.importClause?.namedBindings;
  return bindings !== undefined && ts.isNamespaceImport(bindings) ? bindings.name.text : null;
}

/**
 * The names a file imports by reading them off a namespace.
 *
 * MUSE-113. `importedNames` resolves a default binding and `ts.isNamedImports`, aliases
 * included, and a namespace import has neither — so `import * as scratch from
 * './helpers/scratch'` recorded one entry with `name: null` and **every rule stated against
 * an imported name went quiet**: the deletion rule's `REMOVAL_NAMES`, MUSE-62's
 * `unmeasuredDevServers`, MUSE-48's launcher rule. Not one rule's bug — the shape of the
 * fact they all read.
 *
 * The name is taken from the *use*, not from the import: a namespace brings in everything
 * the module exports, so a rule that fired on the import alone would fire on
 * `test/format.test.ts` and `test/projections.test.ts`, which legitimately import a
 * namespace and read nothing forbidden off it. A permanent false positive is a guard that
 * gets deleted (MUSE-34), so the question asked is the one a reader asks: *which* names
 * does this file take off that module.
 *
 * Reported at the import's line, so the message reads the same as it does for a named
 * import, and deduplicated per name, so reading one name twice is one offence.
 */
function namespaceImports(namespaces: Namespace[], reads: Read[]): Import[] {
  const found: Import[] = [];
  for (const { local, module, line } of namespaces) {
    const seen = new Set<string>();
    for (const read of reads) {
      if (read.object !== local || seen.has(read.name)) continue;
      seen.add(read.name);
      found.push({ module, name: read.name, line });
    }
  }
  return found;
}

/** The operators that pick between two values without syntax saying which. */
const CHOICE_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.AmpersandAmpersandToken,
]);

/**
 * The values an initializer can produce, with whether each one was `await`ed.
 *
 * MUSE-113. A binding used to be read as one expression, so the whole of
 * `already ?? ctx.waitForEvent('page')` was „not a call" and the tab it produces was never
 * tracked — the shape that turned MUSE-61's guard off on an earlier cut of its own branch.
 * Parentheses and `await` are unwrapped, and `??`, `||`, `&&` and `?:` are flattened into
 * their branches, because which branch runs is not a question syntax answers.
 *
 * Deliberately shallow in the same way `staticString` is: no variable is followed and no
 * call's return value is looked into. It is the shape of the initializer, not its value.
 */
function candidateValues(
  expression: ts.Expression,
  awaited: boolean,
): { expression: ts.Expression; awaited: boolean }[] {
  if (ts.isParenthesizedExpression(expression)) {
    return candidateValues(expression.expression, awaited);
  }
  if (ts.isAwaitExpression(expression)) return candidateValues(expression.expression, true);
  if (ts.isConditionalExpression(expression)) {
    return [
      ...candidateValues(expression.whenTrue, awaited),
      ...candidateValues(expression.whenFalse, awaited),
    ];
  }
  if (
    ts.isBinaryExpression(expression) &&
    CHOICE_OPERATORS.has(expression.operatorToken.kind)
  ) {
    return [
      ...candidateValues(expression.left, awaited),
      ...candidateValues(expression.right, awaited),
    ];
  }
  return [{ expression, awaited }];
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
 * A new tab taken out of a Playwright event and never gated on a commit.
 *
 * MUSE-61, and the rule is about the class rather than about the line that failed.
 * `context.waitForEvent('page')` hands back a tab that exists; in Chromium a middle-click
 * creates it at `about:blank` and the document arrives later. Everything the suite then
 * waited on was satisfiable in that state — reproduced deterministically by delaying the
 * tab's first document request — so `expect(tab.url())` compared against the empty document
 * and a pull request touching no browser code went red. The gate has to be a **commit**, and
 * `settleNewTab` is the only thing in the tree that establishes one.
 *
 * Two hops of dataflow, which is all the idiom needs: the promise (`const opened =
 * ctx.waitForEvent('page')`) and the tab awaited out of it (`const tab = await opened`), plus
 * the direct `const tab = await ctx.waitForEvent('page')`. A tab is satisfied when
 * `settleNewTab` is called with it as its first argument.
 *
 * ---
 *
 * **What this rule cannot reach**, in the same spirit as the note under `fixedSleeps` — a
 * rule whose limits are not written down is read as a rule with none:
 *
 *   - **A tab nothing binds to a name.** `(await opened).waitForLoadState('load')` is
 *     invisible here, and the textual tripwire deliberately does **not** cover it: the event
 *     is legitimate and necessary — it is how a middle-click's tab is taken delivery of at
 *     all — so a needle on its name would fire on correct code for ever, and the cheapest
 *     way to silence a permanent false positive is to delete the needle. Naming the tab is
 *     the normal way to write it, and the funnel below is what makes that reliable.
 *   - **Matching is by name across the whole file, not by scope.** Two tests that both call
 *     their tab `tab` are satisfied by either one routing it. That is the same crudeness
 *     `buildDirectoryNames` accepts, and it is why the suite now takes delivery of a tab in
 *     exactly one helper: one binding is a rule that cannot be fooled by a second one.
 *     **The limit now rests on that convention holding** (MUSE-113): a second place that
 *     takes delivery of a tab has to arrive with a scope-aware fix for this, because at that
 *     point one gated tab named `tab` would satisfy an ungated one.
 *   - **A tab bound through a choice is held to the name it stops at, not to its
 *     awaitedness.** `const tab = already ?? ctx.waitForEvent('page')` may hold a tab or a
 *     promise, so the rule treats the name as the tab unless some later binding awaits it
 *     onward — which is conservative in one direction only. A plain non-awaited call
 *     (`const opened = ctx.waitForEvent('page')`, never awaited into a name) is still read
 *     as a promise and is still invisible, which is the first limit above; MUSE-61 decided
 *     that deliberately and MUSE-113 did not reopen it.
 *   - **It says nothing about what happens *after* the commit.** A test that waits properly
 *     and then asserts the wrong thing is a wrong test, not a flaky one, and no guard reading
 *     syntax can tell those apart.
 */
export function uncommittedTabs(file: string, source?: string): Offence[] {
  const { calls, bindings } = facts(file, source);

  /** Variables holding the *promise* of a tab, and the line it was asked for on. */
  const promised = new Map<string, number>();
  /**
   * Every tab the file takes delivery of — a list, not a map keyed by name.
   *
   * Three tests each calling theirs `tab` is the shape this rule was written against, and a
   * map would report the last of them and hide the other two. The *verdict* is still by
   * name, which is the crudeness noted above; the *report* names every line.
   */
  const tabs: { name: string; line: number }[] = [];

  /**
   * Names the file hands on to another name: `const tab = await opened`.
   *
   * Computed over every binding before the walk below, because it is what decides where a
   * choice-bound tab's obligation stops, and the binding that hands the tab on is further
   * down the file than the one that holds the choice.
   */
  const handedOn = new Set(
    bindings.filter(({ awaited }) => awaited).flatMap(({ identifiers }) => identifiers),
  );

  for (const binding of bindings) {
    const fromEvent = binding.calls.some(
      (call) =>
        call.name === TAB_EVENT &&
        call.argument !== null &&
        TAB_EVENT_NAMES.has(call.argument),
    );

    if (fromEvent) {
      if (binding.awaited) tabs.push({ name: binding.name, line: binding.line });
      // `const opened = already ?? ctx.waitForEvent('page')` (MUSE-113). The alternative
      // may already be a tab, so whether this name holds a tab or the promise of one is not
      // something syntax answers. What it does answer is that a tab reaches this name — so
      // the obligation stops here unless the file hands it to a name that awaits it, which
      // is what the live helper does and why it stays green.
      else if (binding.choice && !handedOn.has(binding.name)) {
        tabs.push({ name: binding.name, line: binding.line });
      } else promised.set(binding.name, binding.line);
      continue;
    }
    // `const tab = await opened` — the second hop, and the only one.
    const awaitedFrom = binding.awaited
      ? binding.identifiers.map((name) => promised.get(name)).find((line) => line !== undefined)
      : undefined;
    if (awaitedFrom !== undefined) tabs.push({ name: binding.name, line: awaitedFrom });
  }

  const committed = new Set(
    calls
      .filter((call) => call.name === TAB_COMMIT && call.firstIdentifier !== null)
      .map((call) => call.firstIdentifier as string),
  );

  return tabs
    .filter(({ name }) => !committed.has(name))
    .map(({ name, line }) => ({
      file,
      line,
      what:
        `takes a new tab out of ${TAB_EVENT}() into \`${name}\` and never waits for it to ` +
        `commit a document (MUSE-61) — a tab arrives at about:blank, and \`load\` and a ` +
        `localStorage read are both satisfiable there. Hand it to ${TAB_COMMIT}() from ` +
        `test/helpers/browser-settle.ts before asserting anything about it.`,
    }));
}

/**
 * A dev server driven by a file that never asks whether its URLs name real pages.
 *
 * MUSE-62's rule, and its reasoning: `test/fonts.test.ts` requested a path that 404ed and
 * measured `404.astro` for eleven green tests, because the error page carries the same
 * stylesheet and the same six faces as every page it was standing in for. The primary
 * defence is a runtime one — `astroDev()` probes a page through `test/helpers/measured.ts`
 * before it hands the server over — so this is the belt: a suite that reaches past the probe
 * still has to have the question in front of it.
 *
 * Keyed on the **module**, not on which function is called: `fetchMeasuredPage` and
 * `assertMeasuredPage` answer the same question in two syntaxes and a rule naming one of
 * them would be satisfied by neither. It lives here rather than in a second parser of the
 * test tree, which is why MUSE-62 left both these files alone.
 *
 * What it cannot reach: a file that imports the module and then does not use it. An import
 * nothing uses is a lint failure in this repository (`astro check`), which is a different
 * gate doing its own job.
 */
export function unmeasuredDevServers(file: string, source?: string): Offence[] {
  const { imports } = facts(file, source);
  const drives = imports.filter((entry) => entry.name === DEV_SERVER);
  if (drives.length === 0) return [];

  const measures = imports.some(
    (entry) => entry.module.split('/').pop() === MEASURED_MODULE,
  );
  if (measures) return [];

  return drives.map(({ line }) => ({
    file,
    line,
    what:
      `imports ${DEV_SERVER} but not ./${MEASURED_MODULE} — a dev server answers an unknown ` +
      `path with the error page, which carries the same stylesheet and fonts as the page ` +
      `that was asked for (MUSE-62). Read pages through fetchMeasuredPage/assertMeasuredPage ` +
      `so a wrong URL is a named failure rather than eleven green tests.`,
  }));
}

/**
 * The modules a file imports, as the exporting module spells the names.
 *
 * Exposed because two of MUSE-48's questions are census questions rather than rules —
 * *which* files drive a browser, and which of them import the door that asserts nothing —
 * and both have to be answered by the parser or they are answered by a regular expression
 * that a concatenation defeats (MUSE-107). The list is the parser's, so a dynamic import
 * and a `require` are in it, and an aliased name appears under the name its module
 * exports.
 */
export function importsOf(file: string, source?: string): Import[] {
  return facts(file, source).imports;
}

/**
 * The calls `file` makes, by the name each callee is written under.
 *
 * The companion to `importsOf`, and exposed for the same reason: „which files reach the
 * one door that asserts nothing" is a census, and a census taken by searching text is
 * defeated by the concatenation this module now folds. A destructured dynamic import
 * leaves no imported name behind, so the *call* is the second signal — and a call is
 * exactly what this module can state (MUSE-34).
 */
export function callsOf(file: string, source?: string): Call[] {
  return facts(file, source).calls;
}

/**
 * Whether `file` can get hold of a browser at all.
 *
 * The question MUSE-48's guards are stated over: a file that cannot obtain a browser
 * cannot open a context, so the token rules below are applied to the files this answers
 * yes for. It used to be a regular expression over the file's text — `/from
 * ['"](playwright|[^'"]*browser-checks\.mjs)['"]/` — which is a model of an import
 * statement, and `await import('play' + 'wright')` is an import that the model does not
 * describe: the file drove a browser and no rule applied to it, which MUSE-107
 * demonstrated end to end with a probe that measured `/en/` and reported `/`.
 *
 * Asked of the import list instead, so every spelling the loader accepts counts: static,
 * dynamic, `require`, aliased, and a specifier assembled from pieces.
 *
 * It says nothing about `scripts/browser-checks.mjs` itself, which is the module the rules
 * are *about* — the one exclusion, made by the caller so that it is visible there.
 */
export function drivesBrowser(file: string, source?: string): boolean {
  return importsOf(file, source).some(
    ({ module }) =>
      BROWSER_MODULES.has(module) || module.split('/').pop() === BROWSER_DOOR_FILE,
  );
}

/**
 * Calls only `scripts/browser-checks.mjs` may make, and launchers only it may import.
 *
 * MUSE-48's rule — „no file in `scripts/` or `test/` may call `newContext`, `newPage`,
 * `addInitScript`, `setItem` or launch a browser" — restated against callees and imported
 * names (MUSE-107). Every offence is returned, each naming the call it found: the four
 * `expect`s per file this replaces short-circuited, so a file with five planted tokens
 * reported two and named none of them.
 *
 * ---
 *
 * **What this rule cannot reach.** The same shape of note as `fixedSleeps`:
 *
 *   - **A call through a value this file does not follow.** `const open = browser.newContext;
 *     await open(…)` is a property read, not a call, and `const { newContext: make } = browser`
 *     spells the name in code but calls `make(…)`. The declaration is visible to a reader and
 *     to nothing here, exactly as `fixedSleeps`' aliased sleep is — and the tripwire does not
 *     carry these names, because they appear in the legitimate prose of three files and a
 *     permanent false positive is a guard that gets deleted.
 *   - **Playwright reached through something that is not an import.** A browser handed in as
 *     an argument is how every suite in this tree gets one, which is the point: the
 *     *context* is what the door owns, and a suite holding a browser can still only open a
 *     page through it.
 *   - **Whether the door was used correctly.** That `openCheckPage` asserts where it landed
 *     is asserted in `test/browserlocale.test.ts` against a running browser, not here.
 */
export function browserOwnership(file: string, source?: string): Offence[] {
  const { imports, calls } = facts(file, source);
  const found: Offence[] = [];

  for (const { module, name, line } of imports) {
    if (name !== null && BROWSER_MODULES.has(module) && BROWSER_LAUNCHERS.has(name)) {
      found.push({
        file,
        line,
        what:
          `imports ${name} from '${module}' — a browser is launched in ${BROWSER_DOOR} ` +
          `and nowhere else, so the run's census sees it (MUSE-48, MUSE-68)`,
      });
    }
  }

  for (const call of calls) {
    const why = BROWSER_OWNED.get(call.name);
    if (why !== undefined) {
      found.push({
        file,
        line: call.line,
        what:
          `calls ${named(call)} — ${why}. ${BROWSER_DOOR} owns it (MUSE-48): open pages ` +
          `with openCheckPage(), which pins the locale and asserts the page it measured.`,
      });
    }
  }

  return found;
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

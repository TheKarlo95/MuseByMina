import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

import {
  ASTRO_PLUGIN,
  GENERATED_TYPES,
  astroPluginPresent,
  filesByKind,
  listed,
  offences,
  parsedRegions,
  quoteOffences,
  repoFiles,
  whitespaceOffences,
} from '../scripts/check-format.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file: string): string => readFileSync(join(ROOT, file), 'utf8');

/**
 * MUSE-58 — the repository's formatting is stated, and something reads it.
 *
 * The ticket's defect was an absence: no `.prettierrc`, no `.editorconfig`, no `biome.json`,
 * no eslint config, no `format` script. The convention was single quotes in every one of
 * 6,713 string literals and it was written down nowhere, so `npx prettier --write <file>` —
 * whose default is `singleQuote: false` — did not conform to the repository, it overrode it.
 * MUSE-45's pull request arrived as 538/319 for a 96-line change with all five checks green.
 *
 * This file is the half that keeps the config from becoming decoration. It does three jobs
 * that running the scan does not:
 *
 *   - It **gives the scan teeth**, by planting each offence in a string and demanding the
 *     rule name it. A guard with no demonstrated failure is a guard nobody has seen fail.
 *   - It **pins the wiring**: the npm script, the CI step, and the config values that the
 *     scan reads rather than restates.
 *   - It **asserts the exemptions are still live** — the `.astro` scope, the ignore list,
 *     the one generated file — so an exemption that stops being true is a red test rather
 *     than a widening nobody re-reads.
 *
 * It deliberately does **not** assert that `prettier --check` passes on the tree. It
 * cannot: no `printWidth` leaves this tree alone (measured — 49 of the 96 files prettier
 * owns are byte-identical under the committed config, 47 differ in wrapping only), and
 * making it pass would mean the tree-wide reformat the ticket exists to prevent. The
 * reasoning is in `prettier.config.mjs` and `scripts/check-format.mjs`; the test for it is
 * the first `it` below, which asserts the tree is clean *as it stands*.
 */
describe('MUSE-58: the formatting convention is stated and read', () => {
  it('holds over the repository as it stands, with nothing reformatted', async () => {
    // The whole point of choosing an invariant over `prettier --check`: this passes on the
    // tree at the commit that introduced it. If it ever needs a reformat to go green, the
    // rule has grown past what the repository actually agrees about.
    const found = await offences();
    expect(listed(found).join('\n')).toBe('');
  });

  it('reads every source file the repository has, and says what it skipped', () => {
    const files = repoFiles();
    const { parsed, text, skipped } = filesByKind(files);

    // Exclusions come from `.gitignore`, so there is no scan list to keep exhaustive —
    // MUSE-42's rule. These are the trees the check must be able to see.
    for (const tree of ['src/', 'test/', 'scripts/', 'sanity/']) {
      expect(
        parsed.filter((f) => f.startsWith(tree)).length,
        `${tree} has no file the quote rule can parse`,
      ).toBeGreaterThan(0);
    }
    // `.github/` holds only workflows, which rule 2 reads and rule 1 cannot parse. It is
    // named because it is one of the trees MUSE-42's old two-directory scan never saw.
    expect(text.filter((f) => f.startsWith('.github/')).length).toBeGreaterThan(0);
    expect(parsed).toContain('astro.config.mjs');
    expect(parsed).toContain('prettier.config.mjs');
    expect(parsed).toContain('scripts/check-format.mjs');
    // The guard applies to itself. An exempt guard is MUSE-34's hole.
    expect(parsed).toContain('test/format.test.ts');

    // `.astro` is parsed (frontmatter only) and read as text; `.css` and `.md` are text,
    // because `.prettierignore` disclaims them and they still need a stated minimum.
    expect(parsed.some((f) => f.endsWith('.astro'))).toBe(true);
    expect(text.some((f) => f.endsWith('.css'))).toBe(true);
    expect(text).toContain('CLAUDE.md');

    expect(files.filter((f) => f.startsWith('node' + '_modules'))).toEqual([]);
    expect(files.filter((f) => f.startsWith('dist/'))).toEqual([]);

    // "Unchecked" is a reported set rather than an absence. Fonts and artwork are assets;
    // a text format arriving in the tree shows up here and has to be classified.
    expect(skipped).toEqual(['.png', '.svg', '.woff2']);
  });

  it('names the file and line of a requoted literal', () => {
    // MUSE-45's defect, planted. All 348 of its requoted lines were literals exactly like
    // this one: contents that force neither quote, written with the wrong one.
    const planted = ['const a = 1;', 'const b = "plain";', ''].join('\n');
    const found = quoteOffences('test/planted.ts', planted, "'");

    expect(found).toHaveLength(1);
    expect(found[0]!.line).toBe(2);
    expect(found[0]!.rule).toBe('quotes');
    expect(listed(found)[0]).toContain('test/planted.ts:2');
    expect(listed(found)[0]).toContain('plain');
  });

  it('takes the preferred quote from the config rather than deciding for itself', () => {
    // So the rule and `prettier.config.mjs` cannot drift, and so the `overrides` entry
    // that pins the generated Sanity types to double quotes is honoured by the same code.
    const single = "const a = 'x';\n";
    const double = 'const a = "x";\n';

    expect(quoteOffences('a.ts', single, "'")).toEqual([]);
    expect(quoteOffences('a.ts', double, '"')).toEqual([]);
    expect(quoteOffences('a.ts', double, "'")).toHaveLength(1);
    expect(quoteOffences('a.ts', single, '"')).toHaveLength(1);
  });

  it('reads syntax, so prose about quotes cannot trip it', () => {
    /**
     * The MUSE-34 lesson, applied: a substring scan over source reports comments and
     * misses code. `scripts/check-format.mjs` has four paragraphs discussing quote
     * characters and a planted `"plain"` three assertions up — neither is a string
     * literal, and a rule stated against text would fail on both.
     */
    const prose = [
      '// A double quote in a comment: "like this".',
      '/** And in a doc comment: "like this". */',
      'const t = `a template with "quotes" and ${1} in it`;',
      "const ok = 'real';",
      '',
    ].join('\n');

    expect(quoteOffences('a.ts', prose, "'")).toEqual([]);
  });

  it('skips a literal whose contents force the quote, and says so', () => {
    // Prettier's rule is escape-minimising, which is a tie-break rather than the
    // convention. Four literals in the tree resolve it the other way from Prettier and are
    // left alone — see the note in `scripts/check-format.mjs`. Neither spelling here is an
    // offence, because the contents, not the convention, decided.
    expect(quoteOffences('a.ts', 'const a = "it\'s";\n', "'")).toEqual([]);
    expect(quoteOffences('a.ts', "const a = 'say \"hi\"';\n", "'")).toEqual([]);
  });

  it('names the file and line of each whitespace offence', () => {
    const tab = whitespaceOffences('a.ts', 'const a = 1;\n\tconst b = 2;\n');
    expect(tab).toHaveLength(1);
    expect(tab[0]!.line).toBe(2);
    expect(tab[0]!.what).toContain('tab');

    const trailing = whitespaceOffences('a.ts', 'const a = 1;  \n');
    expect(trailing.map((o) => o.line)).toEqual([1]);
    expect(trailing[0]!.what).toContain('trailing');

    expect(whitespaceOffences('a.ts', 'const a = 1;\r\n')[0]!.what).toContain('CR');
    expect(whitespaceOffences('a.ts', 'const a = 1;')[0]!.what).toContain('final newline');

    expect(whitespaceOffences('a.ts', 'const a = 1;\n')).toEqual([]);
    // Measured and deliberately *not* a rule: two files in the tree end on a blank line.
    expect(whitespaceOffences('a.ts', 'const a = 1;\n\n')).toEqual([]);
  });

  it('reads an .astro file at its fence, and refuses a file it cannot split', () => {
    const component = ['---', "import x from 'y';", '---', '<p>markup</p>', ''].join('\n');
    const regions = parsedRegions('a.astro', component);

    expect(regions).toHaveLength(1);
    expect(regions[0]!.line).toBe(2);
    expect(regions[0]!.source).toBe("import x from 'y';");

    // The markup half is out of scope, and must be: finding its `<script>` blocks by
    // pattern also matches the ones *described* in frontmatter comments. `TrialForm` has
    // five such mentions, and a crude scan reported all five as code.
    const withScript = ['---', '---', '<script>const a = "x";</script>', ''].join('\n');
    expect(quoteOffences('a.astro', withScript, "'")).toEqual([]);

    // And the split is asserted, not assumed. Every `.astro` file here opens with `---`
    // and holds exactly one more; if that stops being true the scan must fail loudly
    // rather than read the wrong half.
    expect(() => parsedRegions('a.astro', '<p>no frontmatter</p>\n')).toThrow(/expected/);
    expect(() => parsedRegions('a.astro', '---\nconst a = 1;\n')).toThrow(/found 1/);
  });

  it('keeps the .astro exemption live: no Astro parser is installed', async () => {
    /**
     * This is what makes the frontmatter-only scope above correct rather than a gap.
     * Prettier answers "No parser could be inferred" for all 22 `.astro` files, so no
     * formatter can rewrite one and the markup half is outside the defect class. Add
     * `prettier-plugin-astro` and that stops being true in both directions at once — the
     * files become formattable and the convention stops being stated for them.
     */
    expect(
      astroPluginPresent(),
      `${ASTRO_PLUGIN} is installed. Prettier can now rewrite .astro files whole: widen ` +
        'the quote rule past the frontmatter fence and drop `*.astro` from .prettierignore.',
    ).toBe(false);

    const pkg = JSON.parse(read('package.json'));
    expect({ ...pkg.dependencies, ...pkg.devDependencies }[ASTRO_PLUGIN]).toBeUndefined();

    // And the CLI skips them rather than failing on them. Without the ignore entry
    // `prettier --write .` errors with "No parser could be inferred" for all 22.
    const component = repoFiles().find((f) => f.endsWith('.astro'));
    expect(component, 'the repository must still have .astro components').toBeTruthy();
    const info = await prettier.getFileInfo(join(ROOT, component!), {
      ignorePath: join(ROOT, '.prettierignore'),
    });
    expect(info.ignored).toBe(true);
    expect(info.inferredParser).toBe(null);
  });

  it('pins the one generated file to the style its generator emits', async () => {
    /**
     * `@sanity/codegen` formats its output by calling Prettier's `resolveConfig()` on the
     * output path — see `dist/utils/resolveFormatter.js` — and `resolveConfig` does not
     * consult `.prettierignore`. So `src/lib/sanity/sanity.types.ts` is reachable by this
     * config whether or not it is ignored, and it is committed as Prettier *defaults*,
     * because that is what the generator emitted when there was no config at all.
     *
     * Without the `overrides` entry, the next `npm run sanity:types` re-emits all 146 lines
     * of it in single quotes at width 96 and `ci.yml`'s `sanity` job goes red on a branch
     * that never touched the schema, blaming the schema. The scan's `generatedTypes` rule
     * runs a full `prettier --check` on exactly that file, which is the only assertion that
     * fails if `@sanity/codegen` ever changes its own formatting.
     */
    const config = read('prettier.config.mjs');
    expect(config).toContain(GENERATED_TYPES);
    expect(config).toMatch(/overrides/);

    // Not ignored — being checkable is what proves the pin still matches the generator.
    // Asked of Prettier rather than of `.prettierignore`'s text, because that file's
    // comments name this path in order to explain why it is absent, and a substring
    // assertion would read the explanation as the entry. Same trap, two files apart.
    const info = await prettier.getFileInfo(join(ROOT, GENERATED_TYPES), {
      ignorePath: join(ROOT, '.prettierignore'),
    });
    expect(info.ignored).toBe(false);
    expect(info.inferredParser).toBe('typescript');
    expect(repoFiles()).toContain(GENERATED_TYPES);
  });

  it('states exactly the two settings the tree disagrees with Prettier about', async () => {
    /**
     * Measured, not chosen: a scratch copy was formatted under each candidate and the diff
     * counted. `semi`, `tabWidth`, `useTabs`, `trailingComma`, `arrowParens`,
     * `bracketSpacing`, `quoteProps` and `objectWrap` all already match Prettier's default,
     * so restating them would be a value to re-measure when a default moves. Only the two
     * that differ are written down.
     */
    const { default: config } = (await import('../prettier.config.mjs')) as {
      default: Record<string, unknown>;
    };

    expect(config.singleQuote).toBe(true);
    expect(config.printWidth).toBe(96);
    expect(Object.keys(config).sort()).toEqual(['overrides', 'printWidth', 'singleQuote']);
  });

  it('is wired to an npm script and to the cheapest CI job', () => {
    const pkg = JSON.parse(read('package.json'));

    expect(pkg.scripts['format:check']).toBe('node scripts/check-format.mjs');
    expect(pkg.scripts.format).toBe('prettier --write');
    // Declared, not merely resolvable. `prettier` was already in the lockfile as a
    // transitive dev dependency, which is exactly the shape that failed Sanity's
    // declaration preflight for `styled-components` — installed, undeclared, and so
    // invisible to every gate that reads `package.json`.
    expect(pkg.devDependencies.prettier, 'prettier must be declared, not inherited')
      .toBeTruthy();

    /**
     * The ticket's constraint on enforcement was that it must be fast, and that CI's total
     * wall clock must not materially rise. So this is a *step* in the existing
     * `designsystem` job rather than a sixth check: that job is the only one here needing
     * neither a build nor a browser, so its wall clock is `npm ci` and a 1.3-second scan
     * disappears into it. A new job would have paid for a runner and another `npm ci` to
     * run the fastest check in the repository.
     *
     * Comments stripped, so the paragraph explaining the step does not read as one.
     */
    const ci = read('.github/workflows/ci.yml');
    const from = ci.indexOf('\n  designsystem:');
    expect(from, 'the designsystem job must still exist to host the step').toBeGreaterThan(0);
    const job = ci.slice(from);
    const commands = job
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    const end = commands.indexOf('\n  rebuildloop:');
    expect(commands.slice(0, end === -1 ? undefined : end)).toContain('npm run format:check');
  });

  it('is written down where the next agent reads it', () => {
    // The recurrence this ticket is about is behavioural: every agent on this board has
    // the same reflex, a formatting doubt and a bare `prettier` invocation. The config
    // stops the damage; CLAUDE.md is what stops the reach for the command.
    const claude = read('CLAUDE.md');
    expect(claude).toContain('prettier.config.mjs');
    expect(claude).toContain('format:check');
  });
});

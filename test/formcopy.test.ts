import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { beforeAll, describe, expect, it } from 'vitest';

import TrialForm from '../src/components/TrialForm.astro';
import {
  FORM_COPY,
  FORM_FIELDS,
  GATED_COPY,
  requiredMessage,
  type CopyGate,
  type LevelOption,
} from '../src/lib/forms';
import { LOCALES, type Locale } from '../src/lib/i18n';
import { LEVELS, LEVEL_NAME } from '../src/lib/schedule';

/**
 * MUSE-7 — "every user-facing string needs both HR and EN".
 *
 * A browser test can only catch a missing translation on a string it happens to render.
 * This walks the table instead, so a message that only appears after a 503 is covered the
 * same as a label. It compares the two locales structurally — same keys, same option
 * values, different words — rather than asserting any particular wording.
 *
 * MUSE-53 added the second half of the file: the same table, asked where each of its
 * strings is allowed to be said. See the long note above `the placement of a shared copy
 * string`.
 */
const [HR, EN] = [FORM_COPY.hr, FORM_COPY.en];

/** Every leaf string in the copy table, keyed by dotted path. */
function leaves(value: unknown, path = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (typeof value === 'string') {
    out.set(path, value);
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      for (const [key, leaf] of leaves(item, `${path}[${index}]`)) out.set(key, leaf);
    });
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      for (const [sub, leaf] of leaves(item, path ? `${path}.${key}` : key)) out.set(sub, leaf);
    }
  }
  return out;
}

describe('the form copy table', () => {
  it('has an entry for every locale the site declares', () => {
    expect(Object.keys(FORM_COPY).sort()).toEqual([...LOCALES].sort());
  });

  it('declares exactly the same strings in HR and EN', () => {
    expect([...leaves(EN).keys()].sort()).toEqual([...leaves(HR).keys()].sort());
  });

  it('leaves none of them blank', () => {
    for (const copy of Object.values(FORM_COPY)) {
      for (const [path, text] of leaves(copy)) {
        // `levels[0].value` is intentionally the empty "not sure yet" option.
        if (/^levels\[\d+]\.value$/.test(path)) continue;
        expect(text.trim(), `${path} is empty`).not.toBe('');
      }
    }
  });

  it('actually translates the prose rather than reusing the English', () => {
    // Labels like "Level"/"Razina" are short enough to coincide in principle; the
    // sentences are not, and those are where an untranslated string hides.
    const prose = [
      'invalid',
      'requiredAny',
      'tooLong',
      'sentTitle',
      'sentBody',
      'failTitle',
      'failBody',
      'failOffline',
      'privacy',
      'noscript',
      'noscriptAsk',
    ] as const;
    for (const key of prose) {
      expect(EN[key], `${key} is the same in both languages`).not.toBe(HR[key]);
    }
  });

  it('has a message for every field that can be left blank by mistake', () => {
    for (const field of FORM_FIELDS.filter((f) => f.required)) {
      for (const copy of Object.values(FORM_COPY)) {
        expect(requiredMessage(copy, field.name).trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('has a format message for every field whose format is validated', () => {
    // email and tel are the two the component format-checks; a missing message there
    // means a field silently refuses to submit with nothing shown.
    for (const field of FORM_FIELDS.filter((f) => f.kind === 'email' || f.kind === 'tel')) {
      for (const copy of Object.values(FORM_COPY)) {
        expect(copy.format[field.name], `format message for ${field.name}`).toBeTruthy();
      }
    }
  });

  it('offers the same level values in both languages', () => {
    // The submitted value is language-independent, so the studio inbox reads the same
    // whichever site a person used.
    expect(EN.levels.map((l) => l.value)).toEqual(HR.levels.map((l) => l.value));
  });

  it('submits the level key, not a second spelling of the level', () => {
    /**
     * MUSE-18 — the decision this ticket had to make.
     *
     * The values were `pocetni` / `improver` / `srednji` / `napredni`: three Croatian
     * slugs predating MUSE-6's English level names, plus the enum key, because MUSE-36
     * added a fourth level and its author had no way to see the convention. One list,
     * two conventions, and `test/home.test.ts`'s guard could not see either — the wire
     * format was a table of its own with no single source above it.
     *
     * So the wire format *is* the key now. `LEVELS` is the vocabulary the Studio
     * dropdown, the GROQ projection, the grid's row order and the homepage doors all
     * already speak, so a submitted `intermediate` can be matched back to a class by
     * Mina and by anything automated later; and there is one string per level in the
     * system rather than two tables to keep in step. `PUBLIC_FORM_ENDPOINT` is unset
     * (MUSE-12), so no submission has ever carried the old values and there is no
     * history to preserve.
     *
     * Asserted against `LEVELS` in order, so a fifth level cannot arrive with a fifth
     * convention.
     */
    for (const copy of Object.values(FORM_COPY)) {
      expect(copy.levels.slice(1).map((l) => l.value)).toEqual([...LEVELS]);
    }
  });

  it('declares which level each option is, so the rendered label can be checked', () => {
    // The `data-level-name` contract (MUSE-11) reaches the `<option>` through this
    // field; `test/home.test.ts` asserts the attribute against the built markup.
    for (const copy of Object.values(FORM_COPY)) {
      const [notSure, ...levels] = copy.levels;
      expect(notSure!.level, 'the "not sure yet" option claims to be a level').toBeUndefined();
      expect(levels.map((l) => l.level)).toEqual([...LEVELS]);
    }
  });

  it('labels the levels out of LEVEL_NAME, and translates the one that is prose', () => {
    // These labels used to be required to *differ*, which was the pre-MUSE-6 rule.
    // A level renders English in both locales, and since MUSE-11 both locales read it
    // from `LEVEL_NAME` — so the level labels are the same words on purpose, and the
    // Croatian form no longer says `Početni` while `/schedule` says `Beginner`.
    const [hrNotSure, ...hrLevels] = HR.levels;
    const [enNotSure, ...enLevels] = EN.levels;

    // One option per level, read off `LEVELS` rather than counted: MUSE-36 added a
    // fourth, and a hardcoded 3 here is a second place the set of levels is written.
    expect(hrLevels.length, 'the levels are missing from the select').toBe(LEVELS.length);
    expect(enLevels.map((l) => l.label)).toEqual(hrLevels.map((l) => l.label));

    /**
     * MUSE-18 — and compared against `LEVEL_NAME` rather than only against each other.
     *
     * HR `===` EN was the whole of this assertion, which is satisfied by both locales
     * drifting *together*: relabelling the select `Novice` / `Expert` in one edit left
     * this suite green, which is the hole the ticket was filed about. The oracle has to
     * be the map, not the other locale.
     */
    for (const locale of LOCALES) {
      expect(FORM_COPY[locale].levels.slice(1).map((l) => l.label)).toEqual(
        LEVELS.map((level) => LEVEL_NAME[locale][level]),
      );
    }

    // "Još ne znam" / "Not sure yet" is not a level. It is prose, so it is translated.
    expect(hrNotSure!.value, 'the default option is the blank one').toBe('');
    expect(enNotSure!.label, 'the "not sure yet" option is not translated').not.toBe(
      hrNotSure!.label,
    );
  });

  it('ends every string a link is appended to with a colon', () => {
    // `failBody`, `failOffline` and `noscript` are each followed by the studio email
    // address in the markup. Without the colon the sentence reads as if it were finished.
    for (const copy of Object.values(FORM_COPY)) {
      for (const key of ['failBody', 'failOffline', 'noscript'] as const) {
        expect(copy[key].trimEnd().endsWith(':'), key).toBe(true);
      }
    }
  });

  it('says nothing in the failure lines about what technically failed', () => {
    /**
     * MUSE-15 — the failure block used to end with `Error.message`, so the Croatian page
     * read `PUBLIC_FORM_ENDPOINT is not configured` / `HTTP 500 Internal Server Error`.
     * The fix is not to translate those: a status code is not information a visitor can
     * act on, and copy that enumerates them dates the moment a provider changes one.
     * `test/trialform.test.ts` proves no diagnostic is *rendered*; this keeps one out of
     * the copy table, which is the other way it could come back.
     */
    for (const copy of Object.values(FORM_COPY)) {
      for (const key of ['failTitle', 'failBody', 'failOffline'] as const) {
        expect(copy[key], `${key} names an HTTP status`).not.toMatch(/\b[1-5]\d\d\b/);
        expect(copy[key], `${key} names a build-time variable`).not.toMatch(/[A-Z][A-Z0-9]*_[A-Z0-9_]+/);
      }
    }
  });
});

/**
 * **Placement — the question the residue guards do not answer (MUSE-53).**
 *
 * `test/trialform.test.ts`, `test/pricing.test.ts` and `test/aboutus.test.ts` each
 * subtract every phrase the site wrote from what the visitor can read and fail on the
 * remainder. That answers **provenance** — *did we write this?* — and answers it well:
 * a leaked diagnostic, an untranslated line, a provider's error body all fail by
 * existing rather than by matching a pattern somebody guessed.
 *
 * It cannot answer **placement** — *should this be here?* A string added to `FORM_COPY`
 * becomes, by definition, "something we wrote", so it is subtracted on every page those
 * guards run against, including the pages it must never appear on. The subtraction set
 * is everything the form can ever say, not everything *this page* is allowed to say,
 * and it widens with every string anybody adds — the most ordinary edit there is.
 * Measured: ungating the package `<select>` so it leaks onto `/contact` left
 * `test/trialform.test.ts` at 38 passed, with only `test/pricing.test.ts` red.
 *
 * ---
 *
 * **Why this is not a per-page list of permitted copy keys.**
 *
 * That was the obvious shape and it is the shape this repository keeps paying for: a
 * list is a second description of the code, it is maintained by whoever remembers it
 * exists, and six tickets here (MUSE-37, MUSE-42, MUSE-46, MUSE-50, MUSE-52 and the
 * deploy-host scan) are the same failure. A page x key matrix would be the largest such
 * list on the project.
 *
 * So placement is carried two ways, neither of them a list of strings:
 *
 *   1. **By the types, where they reach.** `FormCopy`'s `labels`, `hints`, `required`
 *      and `format` are keyed by `CoreFieldName`, which excludes `'package'`, and the
 *      package field's three strings are a group of their own. `formFields()` is the one
 *      function that pairs a field with its copy, the component reads nothing else, and
 *      the branch that reads `copy.package` is the branch that takes `packages`. A field
 *      cannot be rendered without copy chosen for it by name, so the package field can
 *      no longer be leaked by appending it to the list the component iterates — that is
 *      now a type error.
 *   2. **By behaviour, where the types cannot reach.** A one-line change to the
 *      condition inside `formFields` still type-checks. So this suite renders the
 *      component under **every prop shape it accepts** and asks which of the copy
 *      table's strings moved:
 *
 *        - a string in a `GATED_COPY` group must appear where its gate is on and
 *          nowhere else — that is the leak, named with the string and the pages;
 *        - a string **not** in a group whose presence nevertheless varies between
 *          shapes fails as an undeclared gate.
 *
 * The second rule is the acceptance criterion that matters. A string added to
 * `FORM_COPY` and rendered conditionally is covered the moment it exists: it is detected
 * by *moving*, not by its author knowing this ticket happened. Declaring it in
 * `GATED_COPY` is then one line beside the strings it is about, and every further string
 * in that group is covered for free, because the group's reader is `Object.values`.
 *
 * The pages are derived too — the call sites of `<TrialForm>` under `src/`, walked up to
 * the routes that reach them — so a new page or a new embedding component joins this
 * guard without being added to anything.
 */
describe('the placement of a shared copy string', () => {
  /**
   * What each gate needs to be switched on.
   *
   * The one hand-written thing in here, and it is a *sample*, not a declaration: it says
   * what a `packages` prop looks like, not which strings it unlocks. It cannot go stale
   * silently — the first assertion below fails if a gate has no recipe, which is what a
   * new gate arriving looks like.
   *
   * The labels are deliberately nothing like any copy string, so they cannot be mistaken
   * for one by a substring search.
   */
  const GATE_PROPS: Record<CopyGate, Record<string, unknown>> = {
    packages: {
      packages: [
        { value: 'fixture-tier-one', label: 'Qqq fixture tier one' },
        { value: 'fixture-tier-two', label: 'Qqq fixture tier two' },
      ] as readonly LevelOption[],
    },
  };

  /** `none` is the form as `/` and `/contact` render it: no optional prop at all. */
  type Shape = 'none' | CopyGate;
  const GATES = Object.keys(GATED_COPY) as CopyGate[];
  const SHAPES: readonly Shape[] = ['none', ...GATES];

  const propsFor = (shape: Shape, locale: Locale): Record<string, unknown> =>
    shape === 'none' ? { locale } : { locale, ...GATE_PROPS[shape] };

  // --------------------------------------------------------------------------------
  // Which routes render the form, and under which shape — read off the source rather
  // than listed, so a failure names a real page and a new one joins on its own.
  // --------------------------------------------------------------------------------

  const SRC = fileURLToPath(new URL('../src', import.meta.url));
  const PAGES = join(SRC, 'pages');

  const astroFiles = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return astroFiles(full);
      return entry.isFile() && entry.name.endsWith('.astro') ? [full] : [];
    });

  const source = new Map(astroFiles(SRC).map((file) => [file, readFileSync(file, 'utf8')]));

  /** The `.astro` files `file` imports, resolved — the component graph, one edge deep. */
  const importsOf = (file: string): string[] =>
    [...(source.get(file) ?? '').matchAll(/from\s+['"]([^'"]+\.astro)['"]/g)].map((m) =>
      resolve(dirname(file), m[1]!),
    );

  /**
   * The prop names on each `<TrialForm …>` tag in `file`.
   *
   * A spread is reported as `...` and fails below: the guard cannot know what shape a
   * spread renders, and a prop shape it cannot model is one it is not covering.
   */
  const trialFormProps = (file: string): string[][] =>
    [...(source.get(file) ?? '').matchAll(/<TrialForm\b([^>]*?)\/?>/g)].map((m) => {
      const attrs = m[1]!;
      const names = [...attrs.matchAll(/(?:^|\s)([A-Za-z_][\w:-]*)\s*=/g)].map((a) => a[1]!);
      return /\{\s*\.\.\./.test(attrs) ? [...names, '...'] : names;
    });

  /** `locale` picks which table is read; it unlocks no string, so it gates nothing. */
  const NEUTRAL_PROPS = new Set(['locale']);

  /** Every call site, with the prop names on each of its tags. */
  const CALL_SITES = [...source.keys()]
    .map((file) => ({ file, tags: trialFormProps(file) }))
    .filter((site) => site.tags.length > 0);

  const shapesOf = (props: readonly string[]): Shape[] => {
    const gates = props.filter((name): name is CopyGate => (GATES as string[]).includes(name));
    return gates.length === 0 ? ['none'] : gates;
  };

  /** `src/pages/en/contact.astro` → `/en/contact`; `src/pages/index.astro` → `/`. */
  const routeOf = (file: string): string => {
    const rel = relative(PAGES, file).replace(/\.astro$/, '');
    return rel === 'index' ? '/' : `/${rel.replace(/\/index$/, '')}`;
  };

  /** The shapes a page renders, following its component imports transitively. */
  const shapesReachedBy = (page: string): Set<Shape> => {
    const out = new Set<Shape>();
    const seen = new Set<string>();
    const queue = [page];
    while (queue.length > 0) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      for (const tag of trialFormProps(file)) for (const shape of shapesOf(tag)) out.add(shape);
      queue.push(...importsOf(file));
    }
    return out;
  };

  const PAGE_SHAPES = astroFiles(PAGES).map((page) => ({
    route: routeOf(page),
    shapes: shapesReachedBy(page),
  }));

  /** What to call a shape in a failure message: its routes, or the file that has it. */
  const whereRendered = (shape: Shape): string => {
    const routes = PAGE_SHAPES.filter((page) => page.shapes.has(shape)).map((page) => page.route);
    if (routes.length > 0) return routes.sort().join(', ');
    const files = CALL_SITES.filter((site) =>
      site.tags.some((tag) => shapesOf(tag).includes(shape)),
    ).map((site) => relative(SRC, site.file));
    return files.length > 0
      ? `no routed page yet — rendered by ${files.sort().join(', ')}`
      : 'nothing renders this shape';
  };

  const describeShape = (shape: Shape): string =>
    shape === 'none'
      ? `the form with no optional props (${whereRendered('none')})`
      : `the form handed \`${shape}\` (${whereRendered(shape)})`;

  // --------------------------------------------------------------------------------
  // One render per locale per shape.
  // --------------------------------------------------------------------------------

  const ENTITIES: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    '#39': "'",
  };

  /**
   * The rendered markup, entities decoded and case-folded.
   *
   * **Attributes included, deliberately.** Most of this table reaches the page as
   * `data-msg-*` rather than as text — `sending`, `invalid` and `failBody` are never
   * visible until the browser writes them somewhere — and a gated string handed to the
   * browser in an attribute has leaked just as surely as one in a `<label>`.
   */
  const readable = (html: string): string =>
    html
      .replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole)
      .normalize('NFC')
      .toLowerCase();

  const rendered = new Map<string, string>();
  const key = (locale: Locale, shape: Shape): string => `${locale}:${shape}`;

  beforeAll(async () => {
    const container = await AstroContainer.create();
    for (const locale of LOCALES) {
      for (const shape of SHAPES) {
        rendered.set(
          key(locale, shape),
          readable(
            await container.renderToString(TrialForm, { props: propsFor(shape, locale) }),
          ),
        );
      }
    }
  }, 120_000);

  const says = (locale: Locale, shape: Shape, phrase: string): boolean =>
    rendered.get(key(locale, shape))!.includes(readable(phrase));

  /** Path → string for every leaf long enough that a substring search means something. */
  const stringsOf = (locale: Locale): Map<string, string> =>
    new Map([...leaves(FORM_COPY[locale])].filter(([, text]) => text.length >= 3));

  /** Which gate a string belongs to, or `undefined` for the ungated majority. */
  const gateOf = (locale: Locale, text: string): CopyGate | undefined =>
    GATES.find((gate) => GATED_COPY[gate](FORM_COPY[locale]).includes(text));

  it('knows how to switch on every gate the copy table declares', () => {
    // A gate with no sample is a gate this suite silently stops rendering, which would
    // be the whole mechanism going quiet. So it fails here instead, naming the gate.
    expect(Object.keys(GATE_PROPS).sort()).toEqual([...GATES].sort());
  });

  it('models the prop shape of every call site the site has', () => {
    expect(
      CALL_SITES.length,
      'nothing under src/ renders TrialForm — has the component been renamed?',
    ).toBeGreaterThan(0);
    for (const site of CALL_SITES) {
      for (const tag of site.tags) {
        const unmodelled = tag.filter(
          (name) => !NEUTRAL_PROPS.has(name) && !(GATES as string[]).includes(name),
        );
        expect(
          unmodelled,
          `${relative(SRC, site.file)} passes TrialForm a prop this guard does not model: ` +
            `${unmodelled.join(', ')}. If it unlocks copy, declare it in \`GATED_COPY\` ` +
            `(src/lib/forms.ts) with a sample in \`GATE_PROPS\` here; if it renders no copy ` +
            `of its own, add it to \`NEUTRAL_PROPS\` and say why.`,
        ).toEqual([]);
      }
    }
  });

  for (const locale of LOCALES) {
    /**
     * AC1 — the leak, named with the string and the page.
     *
     * This is the assertion the teeth were measured against: take the `packages`
     * condition out of `formFields` and the package strings appear on the `none` shape,
     * which is `/` and `/contact`, and this fails saying exactly that.
     */
    it(`${locale}: a gated string is said only where its gate is on`, () => {
      for (const gate of GATES) {
        for (const phrase of GATED_COPY[gate](FORM_COPY[locale])) {
          if (phrase.length < 3) continue;
          for (const shape of SHAPES) {
            if (shape === gate) continue;
            expect(
              says(locale, shape, phrase),
              `${locale}: "${phrase}" is \`GATED_COPY.${gate}\` copy and belongs only to ` +
                `${describeShape(gate)}, but ${describeShape(shape)} renders it.`,
            ).toBe(false);
          }
        }
      }
    });

    it(`${locale}: a gate that is declared actually unlocks something`, () => {
      // Otherwise a dead entry in `GATED_COPY` would exempt a string from the
      // varies-between-shapes rule below while gating nothing at all — a hole shaped
      // exactly like the one this ticket is about.
      for (const gate of GATES) {
        const group = GATED_COPY[gate](FORM_COPY[locale]);
        expect(group.length, `\`GATED_COPY.${gate}\` declares no strings`).toBeGreaterThan(0);
        for (const phrase of group) {
          expect(
            says(locale, gate, phrase),
            `${locale}: "${phrase}" is declared as \`${gate}\` copy but ${describeShape(gate)} ` +
              `does not render it. Either it is not gated by \`${gate}\`, or nothing renders ` +
              `it at all — both make the declaration misleading.`,
          ).toBe(true);
        }
      }
    });

    /**
     * AC3 — the half that needs nobody to have read this file.
     *
     * Every string that is *not* declared gated must be said on every shape or on none.
     * A new string rendered under a condition therefore fails by moving, with its path
     * in the copy table and the shapes it was found on, and the fix is one line in
     * `GATED_COPY` rather than a test somebody has to think to write.
     */
    it(`${locale}: a string whose placement varies is declared as gated`, () => {
      for (const [path, text] of stringsOf(locale)) {
        if (gateOf(locale, text) !== undefined) continue;
        const said = SHAPES.filter((shape) => says(locale, shape, text));
        const missing = SHAPES.filter((shape) => !said.includes(shape));
        expect(
          said.length === SHAPES.length || said.length === 0,
          `${locale}: \`${path}\` ("${text}") is rendered by ${said
            .map(describeShape)
            .join(' and ')} but not by ${missing
            .map(describeShape)
            .join(' and ')}. A string the form says on some pages and not others is gated ` +
            `copy: declare it in \`GATED_COPY\` in src/lib/forms.ts, beside the strings it ` +
            `belongs with. Until it is, every residue guard in the suite subtracts it from ` +
            `the pages it must never appear on, and reports green.`,
        ).toBe(true);
      }
    });
  }

  /**
   * AC2 — each residue guard says, in its own file, what it answers and what it does not.
   *
   * Enforced rather than asked for, because the reason this ticket exists is that the
   * guards *read* like they cover placement. The fingerprint is the word itself, so a
   * fourth residue guard written next year inherits the requirement without its author
   * knowing about any of this.
   */
  it('makes every residue guard state that it answers provenance and not placement', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const guards = readdirSync(dir)
      .filter((name) => name.endsWith('.test.ts'))
      .map((name) => ({ name, text: readFileSync(join(dir, name), 'utf8') }))
      .filter((file) => /\bresidue\b/i.test(file.text));

    // Not a list to maintain — it is read off `test/`. Only the floor is pinned, so that
    // a rename or a deletion cannot leave this assertion looping over nothing.
    expect(guards.length, 'no residue guard found — has the pattern been renamed?')
      .toBeGreaterThanOrEqual(3);

    for (const guard of guards) {
      for (const word of ['provenance', 'placement']) {
        expect(
          new RegExp(`\\b${word}\\b`, 'i').test(guard.text),
          `test/${guard.name} subtracts the site's own copy from a page, so it answers ` +
            `provenance rather than placement — but it never says the word "${word}". Say ` +
            `what the guard answers, *did we write this?*, and what it cannot, *should this ` +
            `be here?*. A reader who takes it for the second will not write the test that ` +
            `covers it.`,
        ).toBe(true);
      }
    }
  });
});

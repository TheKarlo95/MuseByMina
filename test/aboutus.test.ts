import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APEX_DEPLOY,
  PAGES_DEPLOY,
  assetFile,
  basePath,
  buildFailure,
  buildSite,
  canonicalOf,
  linkHrefs,
  type Build,
} from './helpers/build';
import { seedDocs, type SeedDoc } from './helpers/seed';
import { servePages, type Host } from './helpers/serve';
import {
  FULL,
  INSTRUCTOR_A,
  STUDIO_STORY_DOC,
  expectedImage,
  fixtureOf,
  type FixtureDoc,
} from './helpers/structural-content';
import { formatDate } from '../src/lib/dates';
import { LOCALES, type Locale } from '../src/lib/i18n';
import { ROUTES } from '../src/lib/pages';
import { MORE_NAV, PRIMARY_NAV } from '../src/lib/nav';
import { imageFocus, imageSrc, type ImageRef } from '../src/lib/sanity';
import {
  PREVIEW_ROUTE_ENV,
  PREVIEW_ROUTES,
  previewPatterns,
  requestedPreviews,
} from '../src/lib/preview';

/**
 * MUSE-23 / MUSE-60 — `/aboutus`: the studio story and the instructors.
 *
 * ---------------------------------------------------------------------------------
 * **MUSE-60 routed the page and deleted the preview entry that stood in for it.**
 *
 * MUSE-23 built the component and deliberately stopped short of the route. The reason was
 * never timidity: `src/lib/sanity/decode.ts` fails the build, loudly and by name, when a
 * document a page needs is missing, and the dataset held no `studioStory`. A `/aboutus`
 * route would therefore have stopped `main` building — every pull request, every deploy,
 * and MUSE-21's scheduled rebuild with it. So the component was driven through a throwaway
 * route injected by `astro.config.mjs` only when `MUSE_PREVIEW_ROUTES` named it, and
 * `src/lib/preview.ts` said in its own words what to do with that entry: it goes away with
 * the ticket that routes the page, and an entry that outlives its ticket is a page somebody
 * forgot to ship.
 *
 * **This file is where "deleting the entry must not delete the coverage" is kept honest.**
 * Every MUSE-23 assertion below is the one MUSE-23 wrote; only the *file it reads* changed,
 * from `aboutus-preview/index.html` to `aboutus/index.html`. None was dropped, and none
 * needed to be: they were always assertions about a real `astro build`'s output, which is
 * why the preview mechanism existed at all rather than Astro's container API — that
 * renders a component to a string with no Vite CSS pipeline, so the scoped `<style>` block
 * never appears, and more than half of MUSE-23's criteria are statements about CSS (a 3:4
 * frame, greyscale over `--dur-slow`, a reveal that works without a pointer, a placeholder
 * reserving the same box as the photograph that will replace it).
 *
 * Two assertions changed in substance rather than in address, and both are stated below
 * rather than quietly deleted:
 *
 *   - "publishes no `/aboutus` in either locale" is now its exact inverse, and it is
 *     checked the way a crawler would: 200 through the model of GitHub Pages, with a
 *     canonical that is not a redirect.
 *   - "adds no route to the registry and no entry to the nav" is now the three-way
 *     agreement MUSE-46 made assertable — `ROUTES`, `src/pages/` and the `page` document —
 *     plus the nav entry MUSE-13's rule requires each page ticket to re-add for itself.
 *
 * And the retirement itself is asserted, because an empty registry that nothing guards is
 * how the mechanism comes back by accident: see "the preview mechanism is retired, not
 * loosened" below for which of its guards still have a subject and what replaced the one
 * that did not.
 * ---------------------------------------------------------------------------------
 *
 * **Three builds, and what each is for.**
 *
 *   `page`    the real route against the structural fixture — one of everything, so an
 *             instructor with a portrait, one without, and one with no bio all appear on
 *             one page. This is what every MUSE-23 criterion is read off.
 *   `plain`   the real route against the **committed seed**, which is what the deploy
 *             will publish: Mina and Antonio, their roles, no bio either of them wrote,
 *             and the placeholder story MUSE-60 seeded.
 *   `edited`  the same seed with the story rewritten, which is the only assertion a
 *             literal in the component fails while it still happens to match (MUSE-50).
 *
 * `page` is given its own `SANITY_PROJECT_ID`/`SANITY_DATASET`, both obviously fake. That
 * is not tidiness: the portrait URLs are built from them, so a hardcoded project id in
 * `src/lib/sanity/images.ts` would show up here as the wrong host path rather than passing
 * by coincidence against the real default.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Deliberately not the live values — see the note above. */
const PREVIEW_SOURCE = { SANITY_PROJECT_ID: 'muse23fixture', SANITY_DATASET: 'fixtureset' };

/** Where the route lands in the output, per locale. */
const PAGE_FILE: Record<Locale, string> = {
  hr: 'aboutus/index.html',
  en: 'en/aboutus/index.html',
};

/** The seeded `studioStory`, which is the placeholder MUSE-60 wrote into the dataset. */
function seededStory(): SeedDoc {
  const found = seedDocs().find((doc) => doc._type === 'studioStory');
  if (!found) throw new Error('The seed has no `studioStory` document.');
  return found;
}

let page: Build;
let plain: Build;
let host: Host;

beforeAll(async () => {
  page = buildSite(PAGES_DEPLOY, {
    MUSE_CONTENT_FIXTURE: fixtureOf(FULL, 'aboutus'),
    ...PREVIEW_SOURCE,
  });
  // No fixture override: the ordinary build, reading the committed seed — which is the
  // site the deploy publishes once somebody has run `npm run sanity:seed`.
  plain = buildSite(APEX_DEPLOY);
  host = await servePages(page);
});

afterAll(async () => {
  await host?.close();
});

/** Every rule a page actually loads: its inline `<style>` blocks and its stylesheets. */
function pageCss(build: Build, file: string): string {
  const html = build.read(file);
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1]!);
  const linked = linkHrefs(html, 'stylesheet')
    .map((href) => assetFile(build, href))
    .filter((file): file is string => file !== undefined && build.isFile(file))
    .map((file) => build.read(file));
  return [...inline, ...linked].join('\n');
}

/**
 * The body of an at-rule, brace-matched.
 *
 * Written out rather than regexed because the delivered CSS is **minified** — Vite
 * minifies stylesheets in a production build — so there is no newline to anchor the
 * closing brace on, and a non-greedy `[\s\S]*?\}\}` stops at the first nested rule's
 * brace. The pattern matches the at-rule's prelude only; this walks to its real end.
 */
function atRuleBody(css: string, prelude: RegExp): string | undefined {
  const match = prelude.exec(css);
  if (!match) return undefined;

  const open = css.indexOf('{', match.index + match[0].length);
  if (open === -1) return undefined;

  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return undefined;
}

/**
 * One attribute off a tag, with the entity Astro escapes put back.
 *
 * Astro escapes `&` in an attribute, so a URL carrying query parameters is written
 * `?rect=…&amp;w=600`. Comparing against the raw URL would fail for a reason that has
 * nothing to do with the thing being asserted.
 */
function attribute(tag: string, name: string): string {
  const raw = new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
  expect(raw, `no ${name} attribute in ${tag.slice(0, 160)}`).toBeDefined();
  return raw!.replace(/&amp;/g, '&');
}

/**
 * Matches `filter: grayscale(…)` at full strength or at none, whichever spelling the
 * minifier chose.
 *
 * It does choose: Vite minifies the delivered CSS and rewrites the authored
 * `grayscale(1)` to `grayscale()`, which is the same filter — the argument defaults to 1 —
 * and not the same string. Asserting the authored spelling against the delivered file is
 * how a test ends up pinning the minifier's version rather than the behaviour.
 */
function greyscale(on: boolean): RegExp {
  return on
    ? /filter:\s*grayscale\(\s*(?:1|100%)?\s*\)/
    : /filter:\s*grayscale\(\s*0%?\s*\)/;
}

/**
 * One bilingual field off a fixture document.
 *
 * `FixtureDoc` indexes to `unknown` on purpose — it models "a document as Sanity's export
 * writes it" — so the cast happens here once rather than at every assertion.
 */
function localeField(doc: FixtureDoc, field: string): Record<Locale, string> {
  return doc[field] as Record<Locale, string>;
}

/** The origin story's paragraphs, in order. */
function paragraphsOf(doc: FixtureDoc): Record<Locale, string>[] {
  return doc.story as Record<Locale, string>[];
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/**
 * Every run of text inside `<main>`, one entry per element, tags and attributes gone.
 *
 * Per element rather than as one blob: the question below is whether any *chunk* reads as
 * prose, and flattening the page into a single string would join nine unrelated two-word
 * labels into one nine-word run that looks exactly like a sentence.
 *
 * `<main>` and not the whole page, because the header and the footer are not this
 * component's copy — `Footer.astro` owns its own words and `test/content.test.ts` owns
 * them in turn.
 */
function mainChunks(html: string): string[] {
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/.exec(html)?.[1] ?? '';
  return main
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/g, '<>')
    .split(/<[^>]*>/)
    .map((chunk) =>
      chunk
        .replace(/&(#?\w+);/g, (_match, name: string) => ENTITIES[name] ?? ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
}

/** CSS with every `@media` block removed: what applies at any viewport width. */
function withoutMediaBlocks(css: string): string {
  let out = '';
  for (let i = 0; i < css.length; i += 1) {
    if (!css.startsWith('@media', i)) {
      out += css[i];
      continue;
    }
    const open = css.indexOf('{', i);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    for (; j < css.length; j += 1) {
      if (css[j] === '{') depth += 1;
      else if (css[j] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    i = j;
  }
  return out;
}

/** The component's own `<style>` block, read from source. */
function componentStyle(): string {
  const source = readFileSync(join(ROOT, 'src/components/AboutUs.astro'), 'utf8');
  return source.slice(source.indexOf('<style>'));
}

/** The `<li>` of one instructor, by the name it renders. */
function memberCard(html: string, name: string): string {
  const cards = [...html.matchAll(/<li class="member[^"]*"[\s\S]*?<\/li>/g)].map((m) => m[0]!);
  const found = cards.filter((card) => card.includes(`>${name}<`));
  expect(found.length, `expected exactly one card naming ${name}, got ${found.length}`).toBe(1);
  return found[0]!;
}

/* ---------------------------------------------------------------- the page is shipped */

describe('MUSE-60: /aboutus is a page of this site, in both locales', () => {
  it('publishes both locale pages from the committed seed', () => {
    // `plain` reads `content/seed.ndjson` with no override, which is what the deploy
    // reads from the dataset — so this is the assertion that the seeded documents are
    // enough to build the page at all. MUSE-23's version of this test asserted the
    // opposite, and the reason it had to is gone: the `studioStory` document exists.
    expect(plain.has('aboutus/index.html')).toBe(true);
    expect(plain.has('en/aboutus/index.html')).toBe(true);
  });

  it('answers 200 at the slashed spelling and 301s the other, through the Pages model', async () => {
    // The model `test/urls.test.ts` pins against the live deploy's observed behaviour.
    // `astro preview` answers both spellings with 200, so it cannot see this (MUSE-9).
    const base = basePath(page);
    for (const path of [`${base}aboutus/`, `${base}en/aboutus/`]) {
      expect(await host.get(path), path).toEqual({ status: 200, location: undefined });
    }
    expect(await host.get(`${base}aboutus`)).toEqual({
      status: 301,
      location: `${base}aboutus/`,
    });
  });

  it('declares a canonical that is itself and not a redirect', async () => {
    for (const locale of LOCALES) {
      const canonical = canonicalOf(page.read(PAGE_FILE[locale]));
      expect(canonical, locale).toBe(
        `${page.origin}${locale === 'hr' ? '' : '/en'}/aboutus/`,
      );
      // A canonical that 301s disqualifies itself and drops the hreflang cluster, which
      // is the whole of MUSE-9 — so it is fetched rather than eyeballed.
      expect(await host.getUrl(canonical!), locale).toEqual({
        status: 200,
        location: undefined,
      });
    }
  });

  it('appears in the sitemap and in llms.txt, at the URLs it is served at', () => {
    // Read off whichever sitemap file `@astrojs/sitemap` wrote rather than naming one:
    // the index's children are its business, and `test/urls.test.ts` is where that
    // structure is pinned.
    const sitemaps = page
      .allFiles()
      .filter((file) => file.endsWith('.xml'))
      .map((file) => page.read(file))
      .join('\n');
    expect(sitemaps, 'no sitemap in the output').toContain('<loc>');

    for (const locale of LOCALES) {
      const url = `${page.origin}${locale === 'hr' ? '' : '/en'}/aboutus/`;
      expect(sitemaps, locale).toContain(`<loc>${url}</loc>`);
      expect(page.read('llms.txt'), locale).toContain(url);
    }
  });

  it('is one route in ROUTES, two files under src/pages/, and one `page` document', () => {
    // The three-way agreement MUSE-46 made assertable in both directions. Stated here as
    // well as there because *this* ticket is the one that could ship two of the three —
    // and a route with no document is a red build while a route with no file is a dead
    // link in `llms.txt`.
    expect(ROUTES.map((entry) => entry.route)).toContain('/aboutus');
    for (const file of ['src/pages/aboutus.astro', 'src/pages/en/aboutus.astro']) {
      expect(existsSync(join(ROOT, file)), file).toBe(true);
    }
    const documents = seedDocs().filter(
      (doc) => doc._type === 'page' && doc.route === '/aboutus',
    );
    expect(documents.map((doc) => doc._id)).toHaveLength(1);
  });

  it('puts BaseLayout first in each wrapper, because import position is the cascade', () => {
    // There is no config for stylesheet order in Astro; the import position is the only
    // lever, and `test/cascade.test.ts` asserts the resulting `<head>` against `dist`.
    // Said here too, because a page wrapper is where somebody reorders imports to be
    // tidy — it happened twice in one afternoon (MUSE-35, MUSE-20).
    for (const file of ['src/pages/aboutus.astro', 'src/pages/en/aboutus.astro']) {
      const imports = [...readFileSync(join(ROOT, file), 'utf8').matchAll(/^import .*$/gm)];
      expect(imports.length, file).toBeGreaterThan(1);
      expect(imports[0]![0], file).toMatch(/BaseLayout/);
    }
  });

  it('is in the nav, so the About entry resolves rather than 404ing', () => {
    // MUSE-13's rule: each page ticket re-adds its own entry as part of being done.
    // `test/nav.test.ts` follows every link in the built output and is what makes that a
    // test rather than a convention — in both directions, since MUSE-37 (a page nothing
    // links to is an orphan).
    const nav = [...PRIMARY_NAV, ...MORE_NAV];
    const entry = nav.find((item) => item.route === '/aboutus');
    expect(entry, '/aboutus is not in src/lib/nav.ts').toBeDefined();
    expect(entry!.label.hr).toBeTruthy();
    expect(entry!.label.en).toBeTruthy();

    for (const locale of LOCALES) {
      const href = `${basePath(page)}${locale === 'hr' ? '' : 'en/'}aboutus/`;
      expect(
        page.read(PAGE_FILE[locale]).includes(`href="${href}"`),
        `${locale} page carries no link to ${href}`,
      ).toBe(true);
    }
  });
});

/* -------------------------------------------- the preview mechanism, retired not loosened */

describe('the preview mechanism is retired, not loosened', () => {
  it('holds an empty registry, which is the state MUSE-60 leaves it in', () => {
    // `src/lib/preview.ts`: "If an entry here outlives the ticket that added it, that is
    // a page somebody forgot to ship." `aboutus` was the only entry, and this is the
    // ticket that shipped it.
    expect(Object.keys(PREVIEW_ROUTES)).toEqual([]);
    expect(existsSync(join(ROOT, 'test/preview/aboutus.astro'))).toBe(false);
  });

  it('refuses the retired name rather than injecting nothing and going quiet', () => {
    /**
     * **The guard that replaced a vacuous one.** MUSE-23's "every entry point is under
     * `test/`" is a loop over the registry, and a loop over an empty registry passes
     * without asserting anything — so on its own it would now be a green test with no
     * subject, which is the defect class this repository has re-filed six times.
     *
     * What still has teeth with the registry empty is the *validation*: asking for
     * `aboutus` used to inject two routes and now has to fail, naming the name and the
     * file that explains the mechanism. That is a real regression path — a stale
     * `MUSE_PREVIEW_ROUTES=aboutus` in somebody's shell, or a suite rebased across this
     * ticket — and the alternative is a build that silently injects nothing and a suite
     * that fails on every assertion at once with the cause nowhere in the output.
     */
    expect(() => requestedPreviews('aboutus')).toThrow(/aboutus/);
    expect(() => requestedPreviews('aboutus')).toThrow(/src\/lib\/preview\.ts/);
    // And the message says the registry is empty rather than printing a bare `Known: `.
    expect(() => requestedPreviews('aboutus')).toThrow(/\(none\)/);
  });

  it('injects nothing when the variable is unset, which is every deploy', () => {
    // Both real builds in this file are made with the variable unset, so this is read off
    // their output rather than asserted about the config: no `-preview` path anywhere,
    // under either deploy target.
    for (const build of [page, plain]) {
      expect(build.allFiles().filter((file) => file.includes('-preview'))).toEqual([]);
    }
    expect(requestedPreviews(undefined)).toEqual([]);
    expect(requestedPreviews('')).toEqual([]);
    expect(requestedPreviews('  ')).toEqual([]);
  });

  it('keeps the switch out of every deploy path', () => {
    /**
     * The same guard `test/content.test.ts` puts on `MUSE_CONTENT_FIXTURE`, for the same
     * reason: a test-only switch that a workflow could set is a test-only switch that will
     * eventually ship. Matched as an assignment so a comment naming the variable is still
     * allowed to.
     *
     * **This one keeps its subject with the registry empty** — it is a claim about the
     * variable's name, not about what the registry holds — which is why it stays rather
     * than going with the entry.
     */
    const assignment = new RegExp(`${PREVIEW_ROUTE_ENV}['"]?\\s*[:=]`);
    const workflows = readdirSync(join(ROOT, '.github/workflows')).map((file) =>
      join('.github/workflows', file),
    );
    expect(workflows.length).toBeGreaterThan(0);

    for (const file of [...workflows, 'package.json']) {
      expect(readFileSync(join(ROOT, file), 'utf8'), file).not.toMatch(assignment);
    }
  });

  it('still requires an entry point under test/ and a -preview URL, for the next one', () => {
    /**
     * Vacuous today, and deliberately kept: the two properties that make a preview route
     * invisible to `test/seo.test.ts`'s page list and to `ROUTES` are properties of an
     * *entry*, and the next page ticket whose content is not ready will add one. The test
     * above is what carries the weight while this one has nothing to iterate, and the
     * emptiness is asserted there rather than implied here.
     */
    for (const [name, entrypoint] of Object.entries(PREVIEW_ROUTES)) {
      expect(entrypoint, name).toMatch(/^\.\/test\//);
      expect(ROUTES.map((entry) => entry.route), name).not.toContain(`/${name}`);
      for (const pattern of previewPatterns(name)) expect(pattern).toContain('-preview');
    }
    // `previewPatterns` is registry-independent, so the shape of a future entry's URLs is
    // checked whether or not one exists.
    expect(previewPatterns('whatever')).toEqual(['/whatever-preview', '/en/whatever-preview']);
  });
});

/* ------------------------------------------------------------------- the content */

describe('AC1: who runs the studio, how it started, and who teaches', () => {
  it('renders the origin story from Sanity, in both locales', () => {
    for (const locale of LOCALES) {
      const html = page.read(PAGE_FILE[locale]);
      expect(html, locale).toContain(localeField(STUDIO_STORY_DOC, 'heading')[locale]);
      for (const paragraph of paragraphsOf(STUDIO_STORY_DOC)) {
        expect(html, `${locale}: ${paragraph[locale]}`).toContain(paragraph[locale]);
      }
    }
  });

  it('keeps the paragraphs in order on the page, not just in the reader', () => {
    const html = page.read(PAGE_FILE.hr);
    const [first, second] = paragraphsOf(STUDIO_STORY_DOC);
    expect(html.indexOf(first!.hr)).toBeLessThan(html.indexOf(second!.hr));
  });

  it('dates the story the way each locale writes a date (§10)', () => {
    /**
     * HR `13. kolovoza 2026.` · EN `13 August 2026`. The design system spells both out,
     * and they are genuinely different forms rather than a translation — which is why
     * `foundedOn` is stored as an ISO date and formatted by the page.
     *
     * The machine-readable value rides along in `<time datetime>`, so the rendered form
     * can change without the date becoming unparseable.
     */
    expect(page.read(PAGE_FILE.hr)).toContain('13. kolovoza 2026.');
    expect(page.read(PAGE_FILE.en)).toContain('13 August 2026');

    for (const locale of LOCALES) {
      expect(page.read(PAGE_FILE[locale]), locale).toContain('datetime="2026-08-13"');
    }
  });

  it('gives every instructor their name, what they teach and a short bio', () => {
    /**
     * `bio` became optional in MUSE-36, when Mina and Antonio became the first two real
     * `instructor` documents and nobody had written a paragraph about either of them — so
     * `INSTRUCTOR_C` now has none, and its card is a name and a role.
     *
     * The assertion is therefore "the bio is rendered **when there is one**", with a row
     * on each side of the condition: two fixture instructors have a paragraph and one does
     * not, which is also what keeps `bio` and a typo of it distinguishable in
     * `INSTRUCTORS_QUERY` (`test/projections.test.ts`).
     */
    for (const locale of LOCALES) {
      const html = page.read(PAGE_FILE[locale]);
      let withBio = 0;
      for (const id of ['instructor-a', 'instructor-b', 'instructor-c'] as const) {
        const doc = FULL.find((d) => d._id === id)!;
        const card = memberCard(html, doc.name as string);
        expect(card, `${id} role (${locale})`).toContain(localeField(doc, 'role')[locale]);
        if (doc.bio === undefined) continue;
        expect(card, `${id} bio (${locale})`).toContain(localeField(doc, 'bio')[locale]);
        withBio += 1;
      }
      expect(withBio, 'no fixture instructor has a bio — the check is vacuous').toBeGreaterThan(
        0,
      );
    }
  });

  it('omits the bio paragraph entirely for an instructor who has none', () => {
    // Not an empty `<p class="bio">`, which would leave a gap the design system did not
    // ask for — and not a placeholder sentence, which is the move MUSE-36 exists to undo.
    const doc = FULL.find((d) => d._id === 'instructor-c')!;
    expect(doc.bio, 'the fixture instructor without a bio has one').toBeUndefined();

    for (const locale of LOCALES) {
      const card = memberCard(page.read(PAGE_FILE[locale]), doc.name as string);
      expect(card, `${locale} card renders an empty bio paragraph`).not.toMatch(
        /class="bio[^"]*"/,
      );
    }
  });

  it('contains no prose the CMS did not supply', () => {
    /**
     * **The assertion this whole ticket is really about, and it is phrased as a residue
     * for the reason `test/trialform.test.ts` phrases its one that way** (MUSE-15).
     *
     * MUSE-36 is open and Urgent because invented-but-plausible placeholder content
     * reached production and named two instructors who do not exist. A test that looked
     * for today's fabrications — a grep for two names, a list of forbidden sentences —
     * passes the moment somebody invents a third, and a string allow-list is the defect
     * class this repo has now re-filed six times. So the question asked here is the
     * inverse one: **is every sentence a visitor can read on this page one that came out
     * of Sanity?**
     *
     * Every value the CMS supplied is subtracted from each chunk of rendered text. What
     * survives is the component's own writing, and the component is allowed to write
     * interface chrome — an eyebrow, a section heading, the word before a date — but not
     * prose. So the leftovers are held to three things no label ever violates and no
     * invented bio ever satisfies: **no full stop, no digit, and at most three words.**
     *
     * That needs no second copy of the chrome strings, which matters: a list of allowed
     * phrases here would be a list somebody extends in the same commit that adds the
     * sentence, and the diff would look deliberate. A sentence has nowhere to hide
     * instead — adding `<p>Studio je otvoren 2019.</p>` to the component fails this on all
     * three counts at once.
     *
     * ---
     *
     * **What this answers: provenance, not placement** (MUSE-53).
     *
     * The question is *where did this sentence come from?* — the CMS, or somebody's
     * imagination. It is blind by construction to *should this be here?*: anything that
     * came out of Sanity is subtracted, so a paragraph belonging to one document
     * rendered under another, or an instructor's bio appearing on a card that is not
     * hers, is subtracted away and this stays green. The chunk-level rules narrow that a
     * little — a bio is only subtracted from the chunk it is in — but the guarantee is
     * about origin, not position, and it should not be read as more.
     *
     * The copy-table analogue of the same gap is `GATED_COPY` in `src/lib/forms.ts` and
     * the placement suite in `test/formcopy.test.ts`. This component has no shared copy
     * table yet; the day it grows one, placement belongs there and not here.
     */
    const supplied = (locale: Locale): string[] =>
      [
        localeField(STUDIO_STORY_DOC, 'heading')[locale],
        ...paragraphsOf(STUDIO_STORY_DOC).map((paragraph) => paragraph[locale]),
        // Derived from `foundedOn` rather than stored, but still the CMS's value — §10
        // decides its shape, not its content.
        formatDate(STUDIO_STORY_DOC.foundedOn as string, locale),
        ...FULL.filter((doc) => doc._type === 'instructor').flatMap((doc) => [
          doc.name as string,
          localeField(doc, 'role')[locale],
          // Optional since MUSE-36: an instructor with no bio supplies no paragraph, so
          // there is nothing to subtract — and nothing for the residue to contain either.
          ...(doc.bio === undefined ? [] : [localeField(doc, 'bio')[locale]]),
        ]),
      ]
        // Longest first, so a bio is removed before the name it may contain.
        .sort((a, b) => b.length - a.length);

    for (const locale of LOCALES) {
      const residue = mainChunks(page.read(PAGE_FILE[locale]))
        .map((chunk) => {
          let left = chunk;
          for (const phrase of supplied(locale)) left = left.split(phrase).join(' ');
          return left.replace(/\s+/g, ' ').trim();
        })
        .filter(Boolean)
        // Punctuation on its own carries no language: the frame's `✦` is a mark, not a word.
        .filter((chunk) => /[\p{L}\p{N}]/u.test(chunk));

      for (const chunk of residue) {
        expect(chunk, `${locale}: a full stop means a sentence, and a sentence means prose`)
          .not.toMatch(/\./);
        expect(chunk, `${locale}: every number on this page comes from the CMS`).not.toMatch(
          /\p{N}/u,
        );
        expect(
          chunk.split(' ').length,
          `${locale}: "${chunk}" is too long to be a label — is it copy that should be in Sanity?`,
        ).toBeLessThanOrEqual(3);
      }

      // And the subtraction has to have had something to subtract, or this passes on an
      // empty page.
      expect(mainChunks(page.read(PAGE_FILE[locale])).length, locale).toBeGreaterThan(10);
    }
  });

  it('puts exactly one <h1> on the page and skips no heading level', () => {
    for (const locale of LOCALES) {
      const html = page.read(PAGE_FILE[locale]);
      const levels = [...html.matchAll(/<h([1-6])\b/g)].map((m) => Number(m[1]));
      expect(levels.filter((level) => level === 1), locale).toHaveLength(1);
      expect(new Set(levels), locale).toEqual(new Set([1, 2, 3]));
    }
  });
});

/* ----------------------------------------------------------------- the Instagram link */

describe('AC2: an instructor name links to Instagram when Sanity has a URL', () => {
  it('links the name of the instructor who has one', () => {
    const card = memberCard(page.read(PAGE_FILE.hr), 'Instructor A');
    expect(card).toContain(`href="${INSTRUCTOR_A.instagram as string}"`);
    // Off-site, in a new tab, with the referrer and the opener handled.
    expect(card).toMatch(/rel="[^"]*noopener[^"]*"/);
    expect(card).toMatch(/rel="[^"]*noreferrer[^"]*"/);
  });

  it('renders a plain name for the instructors who do not', () => {
    const html = page.read(PAGE_FILE.hr);
    for (const name of ['Instructor B', 'Instructor C']) {
      // A name linking nowhere is worse than a name — which is why `instagram` is
      // optional in the schema rather than required with a studio-wide fallback.
      expect(memberCard(html, name), name).not.toContain('<a ');
    }
  });

  it('says where the link goes, without changing what the page reads', () => {
    // WCAG 2.5.3: the visible label has to be part of the accessible name. A suffix in a
    // visually-hidden span does that; an `aria-label` of "Instagram" alone would not.
    const card = memberCard(page.read(PAGE_FILE.en), 'Instructor A');
    expect(card).toMatch(/Instructor A<span class="srOnly"[^>]*>[^<]*Instagram/);
  });
});

/* -------------------------------------------------------------- the portrait frame */

describe('AC3: the portrait is 3:4, greyscale at rest, colour over 700ms', () => {
  it('renders the portrait from the asset Sanity names, cropped by the hotspot', () => {
    const portrait = expectedImage(INSTRUCTOR_A, 'portrait') as ImageRef;
    const card = memberCard(page.read(PAGE_FILE.hr), 'Instructor A');
    const src = new URL(attribute(card, 'src'));

    /**
     * The path is asserted literally, against the obviously-fake project and dataset the
     * preview build was given. That is the point of giving it fake ones: a project id
     * hardcoded in `src/lib/sanity/images.ts` would read as a pass against the real
     * default, which is what the test process resolves to.
     */
    expect(src.origin).toBe('https://cdn.sanity.io');
    expect(src.pathname).toBe(
      '/images/muse23fixture/fixtureset/fixturePortraitA-1600x900.jpg',
    );

    // The crop and the width come from the ref, so they are compared against the function
    // rather than retyped — sixteen numbers per image, and a typo in an expectation is a
    // test that passes for the wrong reason (`expectedImage` has the same note).
    expect(src.search).toBe(new URL(imageSrc(portrait, { width: 600 })).search);
    expect(src.searchParams.get('rect')).toBe('432,225,720,441');

    /**
     * The hotspot becomes `object-position`, which is what a focal point *means* for a
     * cover crop (§9 rule 2). Dropping it centre-crops silently.
     *
     * This fixture's hotspot sits outside its own crop, so the page case is the clamped
     * one — `0% 0%`. That is a real state (Mina can crop after setting a hotspot) but it
     * is a weak thing to assert a formula against, which is why the arithmetic has its own
     * describe block below with a hotspot that lands inside its crop.
     */
    const focus = imageFocus(portrait);
    expect(attribute(card, 'style')).toBe(`object-position: ${focus.x}% ${focus.y}%`);
  });

  it('declares the 3:4 box on the <img> itself, so nothing reflows while it loads', () => {
    const card = memberCard(page.read(PAGE_FILE.hr), 'Instructor A');
    const width = Number(/\bwidth="(\d+)"/.exec(card)?.[1]);
    const height = Number(/\bheight="(\d+)"/.exec(card)?.[1]);
    expect(width / height).toBeCloseTo(3 / 4, 5);
  });

  it('carries the alt text Mina wrote, in the page’s own language', () => {
    const portrait = expectedImage(INSTRUCTOR_A, 'portrait');
    for (const locale of LOCALES) {
      const card = memberCard(page.read(PAGE_FILE[locale]), 'Instructor A');
      expect(card, locale).toContain(`alt="${portrait.alt[locale]}"`);
    }
  });

  it('is below the fold, so it loads lazily', () => {
    const card = memberCard(page.read(PAGE_FILE.hr), 'Instructor A');
    expect(card).toContain('loading="lazy"');
    expect(card).toContain('decoding="async"');
  });

  it('is greyscale at rest and full colour over --dur-slow', () => {
    const css = pageCss(page, PAGE_FILE.hr);

    const rest = [...css.matchAll(/\.portrait[^{}]*\{[^{}]*\}/g)]
      .map((m) => m[0]!)
      .filter((rule) => greyscale(true).test(rule));
    expect(rest.length, 'no greyscale-at-rest rule found — is the CSS being read?').toBe(1);

    // 700ms, named as the token rather than written out: §8 gives `--dur-slow` that value
    // and "image hover" as its job, so a literal here is a second copy of the number.
    expect(rest[0]!).toMatch(/transition:[^;}]*filter[^;}]*var\(--dur-slow\)/);

    // The reveal, and it is a filter change rather than two images.
    expect(css).toMatch(
      new RegExp(`:hover[^{}]*\\.portrait[^{}]*\\{[^{}]*${greyscale(false).source}`),
    );
  });

  it('reaches full colour without a pointer', () => {
    /**
     * A hover-only reveal is unusable by keyboard and by touch, and the ticket says so.
     * Two separate answers, because they are two separate problems:
     *
     *   `:focus-within`      the keyboard. Tabbing to the Instagram link reveals the card
     *                        it belongs to.
     *   `@media (hover: none)` touch. There is no hover to wait for, so the portraits are
     *                        simply in colour — a tap is a navigation, not a reveal.
     */
    const css = pageCss(page, PAGE_FILE.hr);

    expect(css).toMatch(
      new RegExp(`:focus-within[^{}]*\\.portrait[^{}]*\\{[^{}]*${greyscale(false).source}`),
    );

    const touch = atRuleBody(css, /@media\s*\(\s*hover\s*:\s*none\s*\)/);
    expect(touch, 'no (hover: none) block — the reveal is pointer-only').toBeDefined();
    expect(touch!).toMatch(greyscale(false));
    expect(touch!).toMatch(/\.portrait/);
  });

  it('respects prefers-reduced-motion without a second copy of that rule', () => {
    /**
     * §8 asks for one thing here: the duration collapses. `src/styles/base.css` already
     * does that for every transition on the site, with `!important`, and the page under
     * test carries it — so a `prefers-reduced-motion` block *in this component* would be a
     * second copy of a decision that is made once, which is the shape of bug this repo
     * keeps re-filing (`font-variant-numeric`, the level names, the address).
     *
     * What the component owes instead is to stay reachable by that rule, and §8's other
     * half: content is never gated behind an animation that has been switched off. So the
     * component is held to animating **nothing but `filter`** — no `transform`, no
     * `animation`, nothing that moves or resizes — which is asserted against its own
     * source, because other components on the page legitimately use transforms and the
     * delivered CSS cannot tell whose is whose.
     */
    const style = componentStyle();
    expect(style, 'an @keyframes animation cannot degrade to visible').not.toMatch(
      /animation(-name)?\s*:/,
    );
    // Not `text-transform`, which is how the tracked caps in §4 are set and is no more
    // motion than `font-weight` is.
    expect(style, 'a transform is motion, and the portrait treatment is not').not.toMatch(
      /(?:^|[\s;{])transform\s*:/m,
    );

    const transitions = [...style.matchAll(/transition[^;}]*;/g)].map((m) => m[0]!);
    expect(transitions.length).toBeGreaterThan(0);
    for (const declaration of transitions) {
      expect(declaration, 'only `filter` and `color` are transitioned').toMatch(
        /\b(filter|color)\b/,
      );
    }

    // And the one rule that switches them off really is in what the visitor receives.
    const reduced = atRuleBody(
      pageCss(page, PAGE_FILE.hr),
      /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/,
    );
    expect(reduced, 'the page carries no reduced-motion rule at all').toBeDefined();
    expect(reduced!).toMatch(/transition-duration:\s*0?\.01ms/);
  });
});

/* ------------------------------------------------------------ the placeholder frame */

describe('AC4: with no photograph, the frame still reserves the 3:4 box', () => {
  it('renders a frame and no image for the instructor who has no portrait', () => {
    const card = memberCard(page.read(PAGE_FILE.hr), 'Instructor C');
    expect(card).toContain('class="frame');
    expect(card).not.toContain('<img');
  });

  it('reserves the space from one rule both branches share', () => {
    /**
     * The acceptance criterion is "the layout does not shift when a real image lands", and
     * the only way to *guarantee* that is for the two branches not to have separate
     * sizing: the ratio is declared once, on the element that is present either way.
     *
     * So this asserts the shape of the CSS rather than measuring two renders — a
     * measurement would pass today and say nothing about the day a photograph arrives.
     */
    const css = pageCss(page, PAGE_FILE.hr);
    const framed = [...css.matchAll(/\.frame[^{}]*\{[^{}]*\}/g)].map((m) => m[0]!);
    const ratios = framed.filter((rule) => /aspect-ratio:\s*3\s*\/\s*4/.test(rule));
    expect(ratios.length, 'the 3:4 box is not declared on .frame').toBe(1);

    // And neither branch is allowed to size itself: no aspect-ratio and no height on the
    // image or the placeholder, or the two could disagree.
    for (const selector of ['.portrait', '.placeholder']) {
      const own = [...css.matchAll(new RegExp(`\\${selector}[^{}]*\\{[^{}]*\\}`, 'g'))].map(
        (m) => m[0]!,
      );
      expect(own.filter((rule) => /aspect-ratio/.test(rule)), selector).toEqual([]);
    }
  });

  it('fills the frame with the plum ground it keeps in both themes', () => {
    /**
     * Design system §7.2: "Media frames keep a plum ground in both themes." This is the
     * rule the ticket warns against "fixing" on a light page.
     *
     * Through the `--band-*` roles rather than `--surface-deep`. Both resolve to plum-ink
     * in both themes, but `--band-*` is the role **set** — ground, hairline and accent
     * together — that `src/styles/tokens.css` defines as "must NOT follow the page theme",
     * and the placeholder mark inside the frame needs the accent half of it: plain
     * `--accent` is gold-deep on a light page, which on plum-ink is nearly invisible. One
     * role set for the whole island keeps the frame from being half theme-fixed.
     */
    const css = pageCss(page, PAGE_FILE.hr);
    const framed = [...css.matchAll(/\.frame[^{}]*\{[^{}]*\}/g)].map((m) => m[0]!).join('\n');
    expect(framed).toMatch(/background:\s*var\(--band-surface\)/);
    expect(framed).toMatch(/border[^;}]*var\(--band-line-accent\)/);

    const mark = [...css.matchAll(/\.placeholder[^{}]*\{[^{}]*\}/g)].map((m) => m[0]!).join('\n');
    expect(mark).toMatch(/color:\s*var\(--band-accent\)/);
  });

  it('keeps the placeholder out of the accessibility tree', () => {
    // It is a frame with nothing in it. A screen reader has nothing to say about it, and
    // the instructor's name and bio are right there as real text.
    const card = memberCard(page.read(PAGE_FILE.hr), 'Instructor C');
    expect(card).toMatch(/class="placeholder[^"]*"[^>]*aria-hidden="true"/);
  });
});

/* ------------------------------------------------- the geometry, on its own */

describe('the portrait URL and focal point, computed rather than hardcoded', () => {
  const ref = (
    hotspot: ImageRef['hotspot'],
    crop: ImageRef['crop'],
  ): ImageRef => ({
    assetId: 'image-abc123def456-1600x900-jpg',
    alt: { hr: 'HR alt', en: 'EN alt' },
    hotspot,
    crop,
  });

  it('builds a CDN URL from the asset id and the configured project', () => {
    // Shape, not a guess: `image-<id>-<w>x<h>-<ext>` becomes `<id>-<w>x<h>.<ext>` under
    // the project and dataset the build was configured with.
    const url = new URL(imageSrc(ref(undefined, undefined), { width: 600 }));
    expect(url.origin).toBe('https://cdn.sanity.io');
    expect(url.pathname).toContain('/abc123def456-1600x900.jpg');
    expect(url.searchParams.get('w')).toBe('600');
    // §9 rule 5 wants webp with a jpg fallback; `auto=format` is the CDN negotiating it,
    // which is one URL instead of a `<picture>` with two.
    expect(url.searchParams.get('auto')).toBe('format');
    expect(url.searchParams.get('rect')).toBeNull();
  });

  it('turns a manual crop into a pixel rect on the source image', () => {
    // 20% off the left, 10% off the right, 25% top, 5% bottom of a 1600×900 original.
    const url = new URL(
      imageSrc(ref(undefined, { top: 0.25, bottom: 0.05, left: 0.2, right: 0.1 }), {
        width: 600,
      }),
    );
    expect(url.searchParams.get('rect')).toBe('320,225,1120,630');
  });

  it('centres on the hotspot, and re-bases it inside a crop', () => {
    // No crop: the hotspot is already a fraction of the whole image.
    expect(imageFocus(ref({ x: 0.4, y: 0.25, width: 0.5, height: 0.5 }, undefined))).toEqual({
      x: 40,
      y: 25,
    });

    // With a crop, the hotspot has to be expressed against the *cropped* frame, because
    // that is the image the browser receives. (0.4 - 0.2) / 0.7 = 28.57…%.
    const cropped = imageFocus(
      ref({ x: 0.4, y: 0.25, width: 0.5, height: 0.5 }, {
        top: 0.25,
        bottom: 0.05,
        left: 0.2,
        right: 0.1,
      }),
    );
    expect(cropped.x).toBeCloseTo(28.57, 1);
    expect(cropped.y).toBeCloseTo(0, 5);
  });

  it('falls back to the centre when Mina never moved the hotspot', () => {
    // Absent means "crop from the centre" — the same thing Sanity does — rather than
    // `object-position: 0% 0%`, which would quietly align every portrait top-left.
    expect(imageFocus(ref(undefined, undefined))).toEqual({ x: 50, y: 50 });
  });

  it('names the asset when its id is not one', () => {
    // A loud failure, because the alternative is an `<img>` pointing at a 404 — and
    // MUSE-49 is about exactly this class of silently blank image.
    const broken = { ...ref(undefined, undefined), assetId: 'file-abc-pdf' };
    expect(() => imageSrc(broken, { width: 600 })).toThrow(/file-abc-pdf/);
  });
});

/* ------------------------------------------- design-system rules `npm run ds` cannot see */

describe('design-system rules the component could break silently', () => {
  it('never sets Cormorant below its 26px floor', () => {
    // Below 26px the `đ` crossbar vanishes and *Dođi* renders as "Dodi" (§4). The display
    // scale bottoms out at 1.625rem for that reason.
    const css = pageCss(page, PAGE_FILE.hr);
    const blocks = [...css.matchAll(/\{[^{}]*\}/g)].map((m) => m[0]!);
    const display = blocks.filter((b) => /font-family:\s*var\(--font-display\)/.test(b));
    expect(display.length, 'no --font-display rule found — is the CSS being read?').toBeGreaterThan(
      0,
    );

    const offenders = display.filter((block) => {
      const size = /font-size:\s*(?:clamp\(\s*)?([\d.]+)rem/.exec(block);
      return size !== null && Number(size[1]) * 16 < 26;
    });
    expect(offenders).toEqual([]);
  });

  it('adds no drop shadow, in either theme', () => {
    // §5: depth is surface value plus hairlines. A shadow makes it read as a dashboard.
    const css = pageCss(page, PAGE_FILE.hr);
    expect(css).not.toMatch(/box-shadow\s*:\s*(?!none)/);
    expect(css).not.toMatch(/filter\s*:\s*[^;}]*drop-shadow/);
  });

  it('sizes nothing that holds Croatian to a fixed pixel width', () => {
    /**
     * §10: Croatian runs 20–25% longer than English, so a box sized to fit the English
     * string clips the Croatian one. `max-width` is fine — it is a measure, and the
     * content shrinks below it; `width: 320px` is not.
     */
    const style = componentStyle()
      // The visually-hidden clip box is 1px by 1px by definition. It holds no text a
      // reader sees, so it is not a measure — it is the standard way to take something
      // out of the visual flow without taking it out of the accessibility tree.
      .replace(/\.srOnly[^{}]*\{[^{}]*\}/g, '');

    expect(style).not.toMatch(/(?<!max-|min-)\bwidth:\s*\d+px/);
    // `minmax(260px, 1fr)` is the usual way to write an auto-fitting grid, and it is a
    // pixel floor: the Croatian column stops shrinking before the viewport does.
    expect(style).not.toMatch(/minmax\(\s*\d+px/);
  });

  it('stacks to one column before it can overflow 390px', () => {
    /**
     * AC: zero horizontal overflow at 390px. The roster is a single column by default and
     * only becomes a grid inside a `min-width` query, so the narrow case is the *absence*
     * of a multi-column rule rather than a breakpoint someone has to pick correctly.
     */
    const style = componentStyle();

    const rosterRules = [...style.matchAll(/\.roster[^{}]*\{[^{}]*\}/g)].map((m) => m[0]!);
    expect(rosterRules.length, 'no .roster rule — did the grid move?').toBeGreaterThan(0);

    // Every `@media` block removed, leaving only what applies at *any* width. Removing
    // them one at a time rather than slicing at the first one: the narrow-screen claim is
    // about the rules with no query on them, and those are interleaved with the queries
    // rather than all sitting above them.
    const unconditional = withoutMediaBlocks(style);
    expect(unconditional).toMatch(/\.roster[^{}]*\{[^{}]*grid-template-columns:\s*1fr/);
    // And no multi-column rule escapes a query — `repeat(2, …)` at every width is the
    // overflow this is about.
    expect(unconditional).not.toMatch(/grid-template-columns:\s*repeat/);
  });

  it('never redeclares the document’s numerals', () => {
    // `font-variant-numeric` is one inherited value set once in `src/styles/base.css`;
    // a component that declares it REPLACES "lining-nums tabular-nums" and brings back
    // `19:00` → `I9:OO` (MUSE-14). `npm run ds` rejects the property outright — this is
    // the same rule asserted against what the page actually serves.
    const source = readFileSync(join(ROOT, 'src/components/AboutUs.astro'), 'utf8');
    expect(source).not.toMatch(/font-variant-numeric|font-feature-settings/);
  });
});

/* ------------------------------------------- what the deploy will actually publish */

/**
 * **MUSE-60's own content criteria, read off a build of the committed seed.**
 *
 * Everything above runs against the structural fixture, which is right for the CSS and
 * the projection geometry — it holds one of everything and nothing plausible. It cannot
 * answer the question this ticket is really about, which is what a visitor sees on the
 * day the dataset is seeded: **Mina and Antonio, named, with their roles, and no bio
 * either of them wrote.**
 *
 * So these read `plain`, the build with no fixture override at all.
 */
describe('AC: the seeded page names the real instructors and invents nothing', () => {
  const instructors = () => seedDocs().filter((doc) => doc._type === 'instructor');

  it('renders every seeded instructor with their name and their role', () => {
    expect(instructors().length, 'the seed has no instructors').toBeGreaterThan(0);

    for (const locale of LOCALES) {
      const html = plain.read(PAGE_FILE[locale]);
      for (const doc of instructors()) {
        const card = memberCard(html, doc.name as string);
        expect(card, `${doc._id} role (${locale})`).toContain(
          (doc.role as Record<Locale, string>)[locale],
        );
      }
    }
  });

  it('writes no bio for anybody who has not written one', () => {
    /**
     * **The content rule this ticket turns on.** `bio` is optional because Mina and
     * Antonio are real and nobody has written a paragraph about either of them — a
     * `required()` bio could only have been satisfied by inventing one, which is how
     * MUSE-36 put thirteen fabricated classes on the live site.
     *
     * Asserted two ways, because each alone is weak: no seeded instructor *has* a bio
     * (so the dataset was not quietly filled in), and no card renders a `bio` paragraph
     * (so the component did not substitute one of its own).
     */
    for (const doc of instructors()) {
      expect(doc.bio, `${doc._id} has a bio in the seed — who wrote it?`).toBeUndefined();
    }

    for (const locale of LOCALES) {
      const html = plain.read(PAGE_FILE[locale]);
      for (const doc of instructors()) {
        expect(
          memberCard(html, doc.name as string),
          `${doc._id} card renders a bio paragraph (${locale})`,
        ).not.toMatch(/class="bio[^"]*"/);
      }
    }
  });

  it('claims no founding date, because nobody has told us one', () => {
    /**
     * **`foundedOn` came off the required list in MUSE-60, and this is why.**
     *
     * MUSE-23 made the origin story *dated* on purpose — World Bachata Meet Up's version
     * of this page works because it is a dated story rather than a list of names — and
     * `foundedOn` was `required()`. But no founding date for this studio is written down
     * anywhere, and the whole of MUSE-60's content rule is that the placeholder story
     * asserts nothing checkable. A required date could therefore only have been satisfied
     * by picking one, which is the exact move that made MUSE-36 Urgent: a plausible fact,
     * invented to get past a validator, published as fact.
     *
     * So it is optional now, on the same argument that made `bio`, `portrait` and
     * `instagram` optional, and the page omits the line rather than printing a gap. Make
     * it `required()` when Mina says a date, not before.
     */
    expect(
      seededStory().foundedOn,
      'the seed names a founding date — who confirmed it?',
    ).toBeUndefined();

    for (const locale of LOCALES) {
      const html = plain.read(PAGE_FILE[locale]);
      expect(html, `${locale} renders a founding date`).not.toMatch(/class="founded/);
      expect(html, `${locale} renders a <time> element`).not.toMatch(/<time\b/);
    }
  });

  it('still renders the date when the dataset has one', () => {
    // The other side of the condition, so "optional" did not become "dropped". The
    // structural fixture carries `foundedOn`, and §10's two forms are asserted above in
    // "dates the story the way each locale writes a date".
    expect(STUDIO_STORY_DOC.foundedOn).toBeDefined();
    for (const locale of LOCALES) {
      expect(page.read(PAGE_FILE[locale]), locale).toMatch(/class="founded/);
    }
  });

  it('renders the seeded story, heading and every paragraph, in both locales', () => {
    const story = seededStory();
    const heading = story.heading as Record<Locale, string>;
    const paragraphs = story.story as Record<Locale, string>[];
    expect(paragraphs.length, 'the seeded story has no paragraphs').toBeGreaterThan(0);

    for (const locale of LOCALES) {
      const html = plain.read(PAGE_FILE[locale]);
      expect(html, `${locale} heading`).toContain(heading[locale]);
      for (const paragraph of paragraphs) {
        expect(html, `${locale}: ${paragraph[locale]}`).toContain(paragraph[locale]);
      }
    }
  });
});

/* ------------------------------------------------------------------------- the teeth */

/**
 * **A rebuild from an edited dataset has to move the story** (MUSE-50).
 *
 * Every assertion above compares the page to the seed the build just read, and all of
 * them pass with the story compiled into the component as a literal — because the literal
 * would still happen to match. That is not a hypothetical: it is precisely how MUSE-50's
 * fifth address surface shipped, and why `test/contentdrift.test.ts` ends with a build of
 * a mutated fixture rather than with a scan.
 *
 * So: one build, one claim in two halves. The edited words appear on both locale pages,
 * and the seeded words appear **nowhere in the output** — not one byte, which also covers
 * a copy that leaked into `llms.txt` or a meta tag.
 */
const EDITED_STORY = {
  heading: { hr: 'HR uređeni naslov priče', en: 'EN edited story heading' },
  story: [
    { hr: 'HR uređeni prvi odlomak.', en: 'EN edited first paragraph.' },
    { hr: 'HR uređeni drugi odlomak.', en: 'EN edited second paragraph.' },
  ],
};

let edited: Build;

beforeAll(() => {
  const story = seededStory();
  edited = buildSite(PAGES_DEPLOY, {
    MUSE_CONTENT_FIXTURE: fixtureOf(
      [
        ...seedDocs().filter((doc) => doc._id !== story._id),
        {
          ...story,
          heading: { _type: 'localeString', ...EDITED_STORY.heading },
          story: EDITED_STORY.story.map((paragraph, index) => ({
            _key: `edited-${index}`,
            _type: 'localeText',
            ...paragraph,
          })),
        },
      ] as FixtureDoc[],
      'aboutus-edited',
    ),
  });
}, 240_000);

describe('AC: the story came from the dataset, and an edit moves it', () => {
  it('edits to something that really differs from the seed', () => {
    // Otherwise every assertion below is satisfied by a literal in the component.
    const seeded = seededStory();
    expect(EDITED_STORY.heading.hr).not.toBe(
      (seeded.heading as Record<Locale, string>).hr,
    );
    expect((seeded.story as Record<Locale, string>[]).length).toBeGreaterThan(0);
  });

  it('publishes the edited heading and paragraphs on both locale pages', () => {
    for (const locale of LOCALES) {
      const html = edited.read(PAGE_FILE[locale]);
      expect(html, `${locale} heading`).toContain(EDITED_STORY.heading[locale]);
      for (const paragraph of EDITED_STORY.story) {
        expect(html, `${locale}: ${paragraph[locale]}`).toContain(paragraph[locale]);
      }
    }
  });

  it('leaves the seeded story nowhere in the output — not one byte', () => {
    const seeded = seededStory();
    const words = [
      ...Object.values(seeded.heading as Record<Locale, string>),
      ...(seeded.story as Record<Locale, string>[]).flatMap((p) => Object.values(p)),
    ].filter((value) => typeof value === 'string' && value !== '');
    expect(words.length).toBeGreaterThan(0);

    const stale = edited
      .allFiles()
      .filter((file) =>
        words.some((word) => readFileSync(join(edited.outDir, file)).includes(word)),
      );
    expect(stale).toEqual([]);
  });

  it('keeps the paragraphs in the order the dataset lists them', () => {
    // An array that lost its order is a story told backwards, and no decoder can see it:
    // both paragraphs are present and both are well-formed.
    const html = edited.read(PAGE_FILE.hr);
    expect(html.indexOf(EDITED_STORY.story[0]!.hr)).toBeLessThan(
      html.indexOf(EDITED_STORY.story[1]!.hr),
    );
  });
});

/* ---------------------------------------- the ordering trap, as a build that must fail */

describe('AC: a missing studioStory fails the build, naming itself', () => {
  /**
   * **The reason this ticket is two steps and not one.** `npm run build` fetches the live
   * dataset, and the page is routed now — so a dataset with no `studioStory` stops the
   * site building: every pull request, every deploy, MUSE-21's scheduled rebuild.
   *
   * That is the correct behaviour (`src/lib/sanity/decode.ts` exists to refuse publishing
   * a heading above nothing) and it is *also* the reason the pull request may not be
   * merged before `npm run sanity:seed` has run. Asserted against a real build rather
   * than a decoder called in isolation: the decoder existing says nothing about whether
   * the build calls it.
   */
  it('names the document, its type and the page that needs it', () => {
    const withoutStory = fixtureOf(
      seedDocs().filter((doc) => doc._type !== 'studioStory') as FixtureDoc[],
      'aboutus-no-story',
    );
    const output = buildFailure(PAGES_DEPLOY, { MUSE_CONTENT_FIXTURE: withoutStory });
    expect(output).toContain('studioStory');
  });

  it('names the type when there is no instructor either', () => {
    const withoutInstructors = fixtureOf(
      seedDocs().filter((doc) => doc._type !== 'instructor') as FixtureDoc[],
      'aboutus-no-instructors',
    );
    const output = buildFailure(PAGES_DEPLOY, {
      MUSE_CONTENT_FIXTURE: withoutInstructors,
    });
    expect(output).toContain('instructor');
  });
});

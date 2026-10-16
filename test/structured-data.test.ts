import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APEX_DEPLOY,
  basePath,
  buildSite,
  canonicalOf,
  PAGES_DEPLOY,
  type Build,
} from './helpers/build';
import { claimOutDir } from './helpers/scratch';
import { seedDocs, type SeedDoc } from './helpers/seed';
import { resolveRequest, servePages, type Host } from './helpers/serve';

/**
 * **MUSE-31 — the studio's own details, published once, in machine-readable form.**
 *
 * The site had no structured data at all: `validator.schema.org` answered
 * `"numObjects": 0` for every URL on the live deploy. This suite covers the block that
 * could land first — the organisation: name, address, email, social profiles, URL. The
 * ticket's other three types (`FAQPage`, `Event`, `Article`) wait on pages that do not
 * exist yet, and nothing here is derived from the class schedule on purpose; see the PR.
 *
 * **What this suite is actually for, and it is not "the block is present".**
 *
 * Structured data that disagrees with the visible page is worse than none: Google reads
 * it as an attempt to say one thing to a crawler and another to a reader. And a block
 * assembled from literals is a *second copy of the content*, which drifts — this
 * repository has the receipts (MUSE-11's homepage level names, MUSE-50's fifth address
 * surface, which is still open). So the load-bearing assertions below are the ones that
 * compare the block against **what that same page rendered**, field by field, and then
 * rebuild the site from an edited dataset and demand that both move together.
 *
 * That second build is what makes the comparison mean something. A block with
 * `"Ilica 209"` compiled into it satisfies every equality test against today's output,
 * because today's output is `Ilica 209` — it is exactly the state MUSE-50 describes, and
 * it passes a suite that only ever sees one dataset. `edited` changes the address, the
 * email and all three social URLs in the fixture, and asserts the block followed; a
 * hardcoded copy fails there and nowhere else.
 */

const LOCALES = ['hr', 'en'] as const;
type Locale = (typeof LOCALES)[number];

/* --------------------------------------------------------- which pages are asserted on */

/**
 * **The page set is the build's own, derived rather than written down** (MUSE-100).
 *
 * It was four routes per locale, listed, with a comment citing `test/seo.test.ts` as the
 * precedent for listing them. The citation was backwards: that suite reads its page list
 * off `src/pages/` with `readdirSync`, which is the filesystem and the opposite of a
 * literal. Meanwhile the build emits twenty-three `.html` files, so `/gallery`,
 * `/pricing`, `/events`, `/events/archive`, `/aboutus`, `/blog` and `/whatisbachata` —
 * each in both locales, two thirds of the site — sat outside every assertion in this
 * file, the per-page block count included. A second JSON-LD block on any of them
 * published with the suite green.
 *
 * So the set comes off the output, the way `auditTargets` walks `dist` for
 * `npm run a11y` (MUSE-55) and `test/routes.test.ts` anchors on the filesystem
 * (MUSE-46): there is no list to extend, and a page routed tomorrow is asserted on the
 * day it builds.
 *
 * The locale is the only thing still named here, and it is named as URL shape — which
 * prefix the output path carries — not as a route list.
 */
/** The locale published at the deploy root, with no prefix of its own. */
const DEFAULT_LOCALE: Locale = 'hr';

/** One built page, with the locale its URL publishes it in. */
interface Page {
  file: string;
  locale: Locale;
  html: string;
}

/** Every `.html` file a build emits, split into the pages and the error page. */
interface Partition {
  pages: Page[];
  /** The file the host hands back for a path nothing answers. */
  errorPage: string;
}

/**
 * The locale an output path publishes a page in: `en/schedule/index.html` is `en`.
 *
 * Read off the path rather than off the page's own `<html lang>`, which is a claim the
 * suite tests (AC4) and so may not also be the thing it groups by. The two are held to
 * each other instead, in the first test below.
 */
function localeOfOutput(file: string): Locale {
  const first = file.split('/')[0];
  const prefixed = LOCALES.find((locale) => locale !== DEFAULT_LOCALE && locale === first);
  return prefixed ?? DEFAULT_LOCALE;
}

/**
 * The error page, identified by the role it plays rather than by its name.
 *
 * `resolveRequest` is this repository's model of GitHub Pages, and MUSE-38's rule is that
 * the host serves the error page's *body* for an unknown path inside the deploy prefix.
 * So "which page has no URL of its own" is a question the host answers, and the one page
 * this suite excludes from the block count is excluded for a reason it can state.
 */
function errorPageFile(build: Build): string {
  const base = basePath(build);
  const probe = resolveRequest(build.outDir, base, `${base}no-such-path-muse-100`);
  const body = probe.status === 404 ? probe.file : undefined;
  if (body === undefined) {
    throw new Error(
      `The host model answers an unknown path with ${probe.status} and ` +
        `${body ?? 'no body'}; MUSE-38 says it serves the error page's body, and ` +
        'that is how this suite knows which page carries no block.',
    );
  }
  return body;
}

/** Computed once per build: two dozen page reads, and every test below wants them. */
const partitions = new WeakMap<Build, Partition>();

/**
 * Every page of a build, derived from the output.
 *
 * Deliberately a *partition* rather than a filter: each `.html` file the build emits is
 * either a page this suite asserts a block on, or the error page it asserts the absence
 * of, and nothing is quietly neither. A page the build starts emitting tomorrow lands in
 * the first set the day it builds, which is the whole point of not writing the set down.
 */
function pagePartition(build: Build): Partition {
  const cached = partitions.get(build);
  if (cached) return cached;

  const errorPage = errorPageFile(build);
  const files = build.htmlFiles();
  if (!files.includes(errorPage)) {
    throw new Error(`The output has no ${errorPage}, which the host model asks for.`);
  }
  const pages = files
    .filter((file) => file !== errorPage)
    .map((file) => ({ file, locale: localeOfOutput(file), html: build.read(file) }));
  if (pages.length === 0) {
    throw new Error(
      'The build emitted no pages besides the error page. Every assertion below is ' +
        'vacuous over an empty page set, so this is a failure rather than a clean run.',
    );
  }

  const partition: Partition = { pages, errorPage };
  partitions.set(build, partition);
  return partition;
}

/** Every indexable page of a build, with the locale it is published in. */
function indexablePages(build: Build): Page[] {
  return pagePartition(build).pages;
}

/* --------------------------------------------------------------- reading the output */

/** The mime type a JSON-LD block declares. */
const JSON_LD_MIME = 'application/ld+json';

/** Every `<script …>` opening tag on a page, as its attribute text. */
function scriptAttributes(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1]!);
}

/**
 * The `type` an opening tag declares, quoted either way or not at all.
 *
 * Case-folded, because an HTML attribute name is case-insensitive and so is the mime
 * comparison a browser makes: `TYPE='Application/LD+JSON'` is a JSON-LD block to every
 * crawler that reads it, and a check that disagrees is a check that can be spelled around.
 */
function declaredType(attributes: string): string | undefined {
  const match = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>=`]+))/i.exec(attributes);
  if (!match) return undefined;
  return (match[1] ?? match[2] ?? match[3])!.trim().toLowerCase();
}

function isJsonLdScript(attributes: string): boolean {
  return declaredType(attributes) === JSON_LD_MIME;
}

/**
 * How many JSON-LD blocks a page publishes, counted off its opening tags.
 *
 * Counted separately from `jsonLdBlocks` because the count *is* the claim — exactly one —
 * and reading it off the opening tags means nothing about how the element is closed can
 * drop a tag out of the total. The two are compared, so a disagreement is loud.
 */
function jsonLdTagCount(html: string): number {
  return scriptAttributes(html).filter(isJsonLdScript).length;
}

/**
 * The raw text of every JSON-LD block on a page.
 *
 * Deliberately **not** parsed here. "Does it parse" is one of the claims under test — a
 * trailing comma in hand-assembled JSON-LD is the classic break and it is silent, since
 * a crawler simply ignores a block it cannot read — so the extractor hands back text and
 * the assertion does the parsing.
 *
 * The `type` attribute is **read**, not matched against a literal (MUSE-100). The old
 * extractor required the exact bytes `type="application/ld+json"` in the markup, and a
 * computed attribute — `const LD_MIME = 'application/ld' + '+json'` in a component's
 * frontmatter, then `type={LD_MIME}` — puts exactly that attribute in the output while
 * matching nothing in the source. The rendered tag is what a crawler reads, so the
 * rendered tag is what is read here, however it came to be written.
 */
function jsonLdBlocks(html: string): string[] {
  return [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
    .filter((match) => isJsonLdScript(match[1]!))
    .map((match) => match[2]!);
}

/** The one JSON-LD document a page publishes, parsed. Fails if there is not exactly one. */
function jsonLdOf(file: string, html: string): Record<string, unknown> {
  const blocks = jsonLdBlocks(html);
  expect(blocks, `${file}: JSON-LD blocks`).toHaveLength(1);
  return JSON.parse(blocks[0]!) as Record<string, unknown>;
}

/** The nodes of a `@graph`, or the single node, keyed by the type names each declares. */
function nodesOf(document: Record<string, unknown>): Record<string, unknown>[] {
  const graph = document['@graph'];
  return Array.isArray(graph) ? (graph as Record<string, unknown>[]) : [document];
}

/** The node whose `@type` includes `type`. Fails if there is not exactly one. */
function node(document: Record<string, unknown>, type: string): Record<string, unknown> {
  const matching = nodesOf(document).filter((n) => {
    const declared = n['@type'];
    return Array.isArray(declared) ? declared.includes(type) : declared === type;
  });
  expect(matching, `nodes of @type ${type}`).toHaveLength(1);
  return matching[0]!;
}

/** The studio node — the organisation block this ticket is about. */
function studioNode(document: Record<string, unknown>): Record<string, unknown> {
  return node(document, 'LocalBusiness');
}

/** The `<html lang>` a page declares. */
function htmlLang(html: string): string | undefined {
  return /<html[^>]*\blang=["']([^"']*)["']/.exec(html)?.[1];
}

/**
 * The street and city the page *shows*, read out of its `<address>` element.
 *
 * The footer renders the two lines with the country translated underneath (design system
 * §7.1), so the city line is „Zagreb, Hrvatska" — the country is the site's word, not
 * part of `siteSettings.address`, and is split back off here. Astro's scoping attribute
 * on the `<br>` is why this strips tags rather than matching a fixed string.
 */
function renderedAddress(html: string): { street: string; city: string } {
  const blocks = [...html.matchAll(/<address[^>]*>([\s\S]*?)<\/address>/g)].map((m) =>
    m[1]!
      .replace(/<[^>]*>/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
  expect(blocks.length, 'rendered <address> elements').toBeGreaterThan(0);
  const unique = [...new Set(blocks.map((lines) => lines.join('|')))];
  expect(unique, 'the page shows one address, not several').toHaveLength(1);
  const lines = blocks[0]!;
  expect(lines, `<address> lines: ${unique[0]}`).toHaveLength(2);
  return { street: lines[0]!, city: lines[1]!.split(',')[0]!.trim() };
}

/** The address the page offers as a `mailto:`. One, or the assertion fails. */
function renderedEmail(html: string): string {
  const found = new Set(
    [...html.matchAll(/href=["']mailto:([^"'?]+)/g)].map((m) => decodeEntities(m[1]!)),
  );
  expect([...found], 'rendered mailto: addresses').toHaveLength(1);
  return [...found][0]!;
}

/**
 * The social profiles the page links to, as `rel="me"` hrefs, in document order.
 *
 * `rel="me"` is not a convenience selector here — it is the markup's own claim that the
 * link points at another profile of the same entity, which is precisely what `sameAs`
 * means. So the two are the same statement in two syntaxes, and a test may hold them
 * equal without knowing which networks the studio is on.
 */
function renderedProfiles(html: string): string[] {
  const hrefs = [...html.matchAll(/<a\b([^>]*)>/g)]
    .map((m) => m[1]!)
    .filter((attrs) => /\brel=["'][^"']*\bme\b[^"']*["']/.test(attrs))
    .map((attrs) => decodeEntities(/\bhref=["']([^"']*)["']/.exec(attrs)?.[1] ?? ''));
  return [...new Set(hrefs)];
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};

function decodeEntities(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => ENTITIES[entity]!);
}

/* ------------------------------------------------------------------ the fixtures */

function seededSettings(): SeedDoc {
  const found = seedDocs().find((doc) => doc._type === 'siteSettings');
  if (!found) throw new Error('The seed has no `siteSettings` document.');
  return found;
}

/** Write a one-off fixture into a directory nothing else can name, and return its path. */
function fixtureOf(docs: unknown[]): string {
  const path = join(claimOutDir('structured-data-fixture'), 'content.ndjson');
  writeFileSync(path, docs.map((doc) => JSON.stringify(doc)).join('\n') + '\n');
  return path;
}

/**
 * Every studio detail the block publishes, changed at once.
 *
 * Every one of them, because a block can be half hardcoded: MUSE-50's straggler was one
 * field out of five while the other four read the CMS correctly. One edit per field is
 * what makes "the block follows the dataset" a claim about the block rather than about
 * whichever field the fixture happened to touch.
 */
const EDITED_ADDRESS = 'Nova ulica 7, Split';
const EDITED_EMAIL = 'studio@example.invalid';
const EDITED_PROFILES: Record<string, string> = {
  instagram: 'https://www.instagram.com/example.edited',
  facebook: 'https://www.facebook.com/example.edited',
  linktree: 'https://linktr.ee/example.edited',
};

let pages: Build;
let apex: Build;
/** The same site, rebuilt after every studio detail was changed in the "Studio". */
let edited: Build;
let pagesHost: Host;
let apexHost: Host;

beforeAll(async () => {
  pages = buildSite(PAGES_DEPLOY);
  apex = buildSite(APEX_DEPLOY);
  edited = buildSite(PAGES_DEPLOY, {
    MUSE_CONTENT_FIXTURE: fixtureOf([
      ...seedDocs().filter((doc) => doc._id !== 'siteSettings'),
      {
        ...seededSettings(),
        address: EDITED_ADDRESS,
        email: EDITED_EMAIL,
        social: (seededSettings().social as { platform: string }[]).map((entry) => ({
          ...entry,
          url: EDITED_PROFILES[entry.platform]!,
        })),
      },
    ]),
  });
  pagesHost = await servePages(pages);
  apexHost = await servePages(apex);
}, 300_000);

afterAll(async () => {
  await pagesHost?.close();
  await apexHost?.close();
});

const TARGETS: [string, () => Build][] = [
  ['Pages sub-path', () => pages],
  ['apex domain', () => apex],
];

/* -------------------------------------------------------------------- the block */

/**
 * The page set itself, asserted (MUSE-100). A derivation that quietly returns eight pages
 * of twenty-two, or none at all, makes every test below pass while covering nothing — so
 * what it derived is a claim in its own right, and it is the first one.
 */
describe('the page set is the build’s own', () => {
  for (const [name, build] of TARGETS) {
    it(`accounts for every .html file the build emits (${name})`, () => {
      const { pages, errorPage } = pagePartition(build());
      expect(
        [...pages.map((page) => page.file), errorPage].sort(),
        'every built page is either asserted on or the error page — nothing is neither',
      ).toEqual(build().htmlFiles());
    });

    it(`covers every locale the build publishes in (${name})`, () => {
      const { pages } = pagePartition(build());
      for (const locale of LOCALES) {
        expect(
          pages.filter((page) => page.locale === locale).map((page) => page.file),
          `${locale}: pages asserted on`,
        ).not.toEqual([]);
      }
    });

    /**
     * The locale is derived from the output path, so the path and the page's own
     * `<html lang>` have to agree about it — otherwise a page published under `/en/` in
     * Croatian would be grouped as English and compared against the English copy, and
     * AC4's per-locale assertions would be reading the wrong pages.
     */
    it(`publishes each page in the language its path claims (${name})`, () => {
      const wrong = indexablePages(build())
        .filter(({ locale, html }) => !new RegExp(`^${locale}\\b`).test(htmlLang(html) ?? ''))
        .map(({ file, locale, html }) => `${file}: /${locale} but lang=${htmlLang(html)}`);
      expect(wrong).toEqual([]);
    });

    /**
     * The guard against the whole file going quiet again. The retired list named eight
     * files; the build emits twenty-three, and every route added since went uncovered.
     * This is not a floor on the page count — the partition above already says the set is
     * the output's — it is the one assertion that a reviewer can read as "the defect
     * MUSE-100 was filed for is not back", and it goes red if the set ever shrinks to what
     * the literal used to name.
     */
    it(`asserts on the pages outside the four routes this file used to name (${name})`, () => {
      const named = ['', 'schedule/', 'contact/', 'privacy/'].flatMap((route) => [
        `${route}index.html`,
        `en/${route}index.html`,
      ]);
      const beyond = indexablePages(build())
        .map((page) => page.file)
        .filter((file) => !named.includes(file));
      expect(beyond, 'pages the old literal list left uncovered').not.toEqual([]);
    });
  }
});

/**
 * AC1 — Given any page, then it carries an organisation block with name, address,
 * email, social profiles and URL.
 */
describe('AC1: every page carries the studio block', () => {
  for (const [name, build] of TARGETS) {
    /**
     * **The honest instrument for "one emission site" is the output** (MUSE-100): it
     * cannot lie about how many tags a page carries and it is immune to every spelling of
     * the `type` attribute and to whichever file produced the markup. The source scan
     * below is kept for the better message, not for the coverage.
     */
    it(`publishes exactly one JSON-LD document per page (${name})`, () => {
      const wrong = indexablePages(build())
        .map(({ file, html }) => ({
          file,
          tags: jsonLdTagCount(html),
          blocks: jsonLdBlocks(html).length,
        }))
        .filter(({ tags, blocks }) => tags !== 1 || blocks !== 1)
        .map(
          ({ file, tags, blocks }) => `${file}: ${tags} tag(s), ${blocks} readable block(s)`,
        );
      expect(
        wrong,
        'a second block on a page is a second answer to "does the markup agree with it"',
      ).toEqual([]);
    });

    it(`names the studio, its address, its email and its profiles (${name})`, () => {
      for (const { file, html } of indexablePages(build())) {
        const studio = studioNode(jsonLdOf(file, html));
        expect(Object.keys(studio).sort(), file).toEqual(
          [
            '@id',
            '@type',
            'address',
            'description',
            'email',
            'name',
            'sameAs',
            'url',
          ].sort(),
        );
        const address = studio.address as Record<string, unknown>;
        expect(address['@type'], file).toBe('PostalAddress');
        for (const field of ['streetAddress', 'addressLocality', 'addressCountry']) {
          expect(typeof address[field], `${file}: address.${field}`).toBe('string');
        }
        expect(Array.isArray(studio.sameAs), `${file}: sameAs`).toBe(true);
        expect((studio.sameAs as string[]).length, `${file}: sameAs`).toBeGreaterThan(0);
      }
    });
  }

  /**
   * The 404 declares no canonical, because the host serves its body for any unknown path
   * (see `BaseLayout`'s `indexable` prop) — so it has no URL of its own for a block to
   * reference, and a `WebPage` node keyed on a URL that is itself a 404 is a statement
   * about a page that does not exist. Structured data rides with having a URL.
   */
  it('publishes none on the error page, which has no URL of its own', () => {
    const errorPage = pagePartition(pages).errorPage;
    const html = pages.read(errorPage);
    expect(canonicalOf(html), `${errorPage} declares a canonical`).toBeUndefined();
    expect(jsonLdTagCount(html), `${errorPage}: JSON-LD tags`).toBe(0);
    expect(jsonLdBlocks(html)).toEqual([]);
  });
});

/**
 * AC2 — Given any emitted block, then it parses as valid JSON.
 *
 * The cheap test that catches the common break. A block a crawler cannot parse is
 * indistinguishable from no block at all, from the outside.
 */
describe('AC2: every emitted block parses', () => {
  for (const [name, build] of TARGETS) {
    it(`parses every block as JSON, with a schema.org context (${name})`, () => {
      const broken: string[] = [];
      for (const { file, html } of indexablePages(build())) {
        // Not vacuous: "every block parses" is trivially true of no blocks, and that is
        // the reading under which a suite stays green with the feature removed.
        expect(jsonLdBlocks(html), `${file}: blocks to parse`).toHaveLength(1);
        for (const raw of jsonLdBlocks(html)) {
          try {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            expect(parsed['@context'], `${file}: @context`).toBe('https://schema.org');
          } catch (error) {
            broken.push(`${file}: ${(error as Error).message}`);
          }
        }
      }
      expect(broken).toEqual([]);
    });

    /**
     * A `</script>` inside a string value ends the element early, whatever JSON says, so
     * the serialiser escapes `<`. Asserted on the emitted text rather than on the
     * serialiser, because the escaping only matters at the point it reaches HTML.
     */
    it(`emits no raw "<" inside the script element (${name})`, () => {
      for (const { file, html } of indexablePages(build())) {
        expect(jsonLdBlocks(html), `${file}: blocks to check`).toHaveLength(1);
        for (const raw of jsonLdBlocks(html)) {
          expect(raw, `${file}: JSON-LD payload`).not.toContain('<');
        }
      }
    });
  }
});

/**
 * AC3 — Given a page in either locale, then the block references that page's canonical
 * URL, and that URL does not redirect (MUSE-9).
 */
describe('AC3: the block references the page’s own canonical', () => {
  for (const [name, build] of TARGETS) {
    it(`keys the page node on the page's own canonical (${name})`, () => {
      const wrong: string[] = [];
      for (const { file, html } of indexablePages(build())) {
        const canonical = canonicalOf(html);
        const page = node(jsonLdOf(file, html), 'WebPage');
        if (page['@id'] !== canonical || page.url !== canonical) {
          wrong.push(`${file}: @id ${String(page['@id'])}, url ${String(page.url)} ≠ ${canonical}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  /**
   * Fetched from the model of GitHub Pages `test/urls.test.ts` introduced, not matched
   * against a pattern. The unslashed spelling of every URL on this site is a 301, and a
   * redirecting URL inside structured data names something other than the page it is on —
   * which is the MUSE-9 bug in a second syntax. `astro preview` answers both spellings
   * with 200 and so cannot see it.
   */
  for (const [name, build, host] of [
    ['Pages sub-path', () => pages, () => pagesHost],
    ['apex domain', () => apex, () => apexHost],
  ] as [string, () => Build, () => Host][]) {
    it(`resolves every URL in every block to a 200 with no redirect (${name})`, async () => {
      const urls = new Map<string, string>();
      for (const { file, html } of indexablePages(build())) {
        for (const n of nodesOf(jsonLdOf(file, html))) {
          for (const [key, value] of Object.entries(n)) {
            if (key !== '@id' && key !== 'url') continue;
            if (typeof value !== 'string') continue;
            // Only this site's own URLs; `sameAs` points off-site by definition.
            if (!value.startsWith(`${build().origin}/`)) continue;
            urls.set(value.replace(/#.*$/, ''), `${file} ${key}`);
          }
        }
      }
      expect(urls.size, 'no own-site URLs inside the blocks').toBeGreaterThan(0);

      const bad: string[] = [];
      for (const [url, source] of urls) {
        const probe = await host().getUrl(url);
        if (probe.status !== 200 || probe.location !== undefined) {
          bad.push(`${source}: ${url} -> ${probe.status} ${probe.location ?? ''}`.trim());
        }
      }
      expect(bad).toEqual([]);
    });
  }
});

/**
 * AC4 — Given a page in either locale, then the structured data is in that page's
 * language.
 */
describe('AC4: the block is in the page’s own language', () => {
  for (const [name, build] of TARGETS) {
    it(`declares the language the page declares (${name})`, () => {
      for (const { file, locale, html } of indexablePages(build())) {
        const page = node(jsonLdOf(file, html), 'WebPage');
        expect(page.inLanguage, `${file} (${locale})`).toBe(htmlLang(html));
      }
    });

    /**
     * And the prose with it. `inLanguage` is a label a copy-paste keeps while the text
     * under it stays in the other language, which is the failure this pair exists for:
     * the two locales must describe the studio differently, and each must match the
     * tagline-level summary its own pages are built from.
     */
    it(`describes the studio in that locale, differently per locale (${name})`, () => {
      const byLocale = new Map<Locale, Set<string>>();
      for (const { file, locale, html } of indexablePages(build())) {
        const studio = studioNode(jsonLdOf(file, html));
        expect(typeof studio.description, `${file}: description`).toBe('string');
        const seen = byLocale.get(locale) ?? new Set<string>();
        seen.add(studio.description as string);
        byLocale.set(locale, seen);
      }
      for (const locale of LOCALES) {
        expect([...byLocale.get(locale)!], `${locale}: one description`).toHaveLength(1);
      }
      const summary = seededSettings().summary as Record<Locale, string>;
      expect([...byLocale.get('hr')!][0]).toBe(summary.hr);
      expect([...byLocale.get('en')!][0]).toBe(summary.en);
      expect(summary.hr).not.toBe(summary.en);
    });

    /**
     * The two locales' studio nodes are separate entities, keyed on their own locale's
     * homepage. One `@id` carrying two different descriptions is a self-contradicting
     * graph for anything that merges nodes by identity.
     */
    it(`gives each locale's studio node its own @id and url (${name})`, () => {
      const ids = new Map<Locale, Set<string>>();
      for (const { file, locale, html } of indexablePages(build())) {
        const studio = studioNode(jsonLdOf(file, html));
        const seen = ids.get(locale) ?? new Set<string>();
        seen.add(`${String(studio['@id'])} ${String(studio.url)}`);
        ids.set(locale, seen);
      }
      for (const locale of LOCALES) {
        expect([...ids.get(locale)!], `${locale}: one studio identity`).toHaveLength(1);
      }
      expect([...ids.get('hr')!][0]).not.toBe([...ids.get('en')!][0]);
    });

    /** Each page node points at the studio node that is actually in its own document. */
    it(`points the page node at the studio node beside it (${name})`, () => {
      for (const { file, html } of indexablePages(build())) {
        const document = jsonLdOf(file, html);
        const studio = studioNode(document);
        const page = node(document, 'WebPage');
        expect(page.about, file).toEqual({ '@id': studio['@id'] });
      }
    });
  }
});

/**
 * AC5 — **the point of the ticket.** Given any page, the address, email and social URLs
 * inside the block equal the ones that same page renders.
 */
describe('AC5: the block agrees with the page, field by field', () => {
  for (const [name, build] of TARGETS) {
    it(`publishes the address the page shows (${name})`, () => {
      const drifted: string[] = [];
      for (const { file, html } of indexablePages(build())) {
        const shown = renderedAddress(html);
        const address = studioNode(jsonLdOf(file, html)).address as Record<string, string>;
        if (
          address.streetAddress !== shown.street ||
          address.addressLocality !== shown.city
        ) {
          drifted.push(
            `${file}: block ${address.streetAddress}, ${address.addressLocality} — ` +
              `page ${shown.street}, ${shown.city}`,
          );
        }
      }
      expect(drifted).toEqual([]);
    });

    it(`publishes the email the page offers (${name})`, () => {
      const drifted: string[] = [];
      for (const { file, html } of indexablePages(build())) {
        const studio = studioNode(jsonLdOf(file, html));
        const shown = renderedEmail(html);
        if (studio.email !== shown) drifted.push(`${file}: ${String(studio.email)} ≠ ${shown}`);
      }
      expect(drifted).toEqual([]);
    });

    it(`publishes exactly the profiles the page links to (${name})`, () => {
      const drifted: string[] = [];
      for (const { file, html } of indexablePages(build())) {
        const studio = studioNode(jsonLdOf(file, html));
        const shown = renderedProfiles(html);
        expect(shown.length, `${file}: rel="me" links`).toBeGreaterThan(0);
        const published = [...(studio.sameAs as string[])].sort();
        if (JSON.stringify(published) !== JSON.stringify([...shown].sort())) {
          drifted.push(`${file}: block ${published.join(' ')} — page ${shown.join(' ')}`);
        }
      }
      expect(drifted).toEqual([]);
    });

    it(`publishes the studio name the page's own copyright line uses (${name})`, () => {
      for (const { file, html } of indexablePages(build())) {
        const studio = studioNode(jsonLdOf(file, html));
        expect(html, `${file}: © line names ${String(studio.name)}`).toContain(
          `© 2026 ${String(studio.name)}`,
        );
      }
    });
  }
});

/**
 * AC6 — **the assertion a hardcoded copy fails.** Given the studio's details changed in
 * the CMS, then the block changes with them.
 *
 * Everything above compares the block against today's output, and today's output is what
 * a literal would also say. This rebuilds the whole site from an edited dataset. It is
 * the same instrument `test/content.test.ts` uses for the migration, for the same reason:
 * comparing a build to its own input proves nothing about where the build read it from.
 */
describe('AC6: the block follows the dataset', () => {
  it('moves the address, the email and every profile when the Studio does', () => {
    for (const { file, html } of indexablePages(edited)) {
      const studio = studioNode(jsonLdOf(file, html));
      const address = studio.address as Record<string, string>;
      expect([address.streetAddress, address.addressLocality], file).toEqual([
        'Nova ulica 7',
        'Split',
      ]);
      expect(studio.email, file).toBe(EDITED_EMAIL);
      expect([...(studio.sameAs as string[])].sort(), file).toEqual(
        Object.values(EDITED_PROFILES).sort(),
      );
    }
  });

  /** And the edited build's own pages still agree with their own blocks. */
  it('keeps the block and the page in step in the edited build too', () => {
    for (const { file, html } of indexablePages(edited)) {
      const studio = studioNode(jsonLdOf(file, html));
      const address = studio.address as Record<string, string>;
      expect([address.streetAddress, address.addressLocality], file).toEqual([
        renderedAddress(html).street,
        renderedAddress(html).city,
      ]);
      expect(studio.email, file).toBe(renderedEmail(html));
      expect([...(studio.sameAs as string[])].sort(), file).toEqual(
        [...renderedProfiles(html)].sort(),
      );
    }
  });

  /**
   * The guard against the whole suite passing vacuously: the edited values must actually
   * be different from the seeded ones, or AC6 asserts nothing.
   */
  it('edits values that really differ from the seed', () => {
    const settings = seededSettings();
    expect(settings.address).not.toBe(EDITED_ADDRESS);
    expect(settings.email).not.toBe(EDITED_EMAIL);
    for (const entry of settings.social as { platform: string; url: string }[]) {
      expect(entry.url).not.toBe(EDITED_PROFILES[entry.platform]);
    }
  });
});

/**
 * AC7 — the block validates. The parts of "no errors in the Rich Results Test" that a
 * local suite can hold; the run against the validator itself is in the PR.
 */
describe('AC7: the block is the shape a validator accepts', () => {
  /**
   * **`DanceSchool` is not a schema.org type.** The ticket asks for „a `DanceSchool` (or
   * `LocalBusiness`) block" and `https://schema.org/DanceSchool` is a 404 — there is no
   * dance type anywhere under `LocalBusiness` (33 direct subtypes, checked) and none
   * under `EducationalOrganization` either. An unknown `@type` is not a parse error and
   * not a hard failure: the validator reports the node with no recognised type and every
   * property on it unrecognised, so the page carries structured data that says nothing.
   *
   * So the studio is multi-typed as what it is — a local business that is also an
   * educational organisation — and this test is here so the ticket's wording does not
   * talk anybody into putting the 404 back.
   */
  it('declares only types that exist in schema.org', () => {
    for (const { file, html } of indexablePages(pages)) {
      for (const n of nodesOf(jsonLdOf(file, html))) {
        const declared = n['@type'];
        const types = Array.isArray(declared) ? declared : [declared];
        for (const type of types) {
          expect(
            ['LocalBusiness', 'EducationalOrganization', 'WebPage', 'PostalAddress'],
            `${file}: @type ${String(type)} — see the note above about DanceSchool`,
          ).toContain(type);
        }
      }
    }
  });

  it('types the studio as both a local business and an educational organisation', () => {
    for (const { file, html } of indexablePages(pages)) {
      expect(studioNode(jsonLdOf(file, html))['@type'], file).toEqual([
        'LocalBusiness',
        'EducationalOrganization',
      ]);
    }
  });

  /**
   * Google's local-business guidance: `name` and `address` are required, and
   * `addressCountry` is wanted as an ISO 3166-1 alpha-2 code rather than a country name.
   * The site renders the country as a translated word („Hrvatska"/"Croatia"), which is a
   * different thing from the code, so the two cannot be read off each other.
   */
  it('gives the country as an ISO 3166-1 alpha-2 code', () => {
    for (const { file, html } of indexablePages(pages)) {
      const address = studioNode(jsonLdOf(file, html)).address as Record<string, string>;
      expect(address.addressCountry, file).toMatch(/^[A-Z]{2}$/);
    }
  });

  it('leaves no empty string or null anywhere in a block', () => {
    for (const { file, html } of indexablePages(pages)) {
      const empty: string[] = [];
      const walk = (value: unknown, path: string): void => {
        if (value === null || value === '') empty.push(path);
        else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
        else if (typeof value === 'object') {
          for (const [k, v] of Object.entries(value as object)) walk(v, `${path}.${k}`);
        }
      };
      walk(jsonLdOf(file, html), file);
      expect(empty, `${file}: empty values`).toEqual([]);
    }
  });
});

/* ------------------------------------------------- the source scan: for the message */

const SRC = fileURLToPath(new URL('../src', import.meta.url));

/**
 * How each extension under `src/` is read, and **every extension present must be
 * classified** — the rule `test/helpers/source-guard.ts` states for `test/`, for the same
 * reason: a file nothing reads is a blind spot rather than a clean result, and a skip list
 * nobody maintains is how MUSE-34's second hole stayed open.
 *
 * `code` is parsed and its string and template literals are read. `markup` is an `.astro`
 * component: the frontmatter gets the `code` treatment and the template is read as text.
 * `inert` cannot produce an element on a page under any circumstances.
 *
 * Each list holds only what the tree actually has — a declared extension that is no
 * longer present is a failure too, because an entry nothing exercises reads as coverage
 * and is not. The day a `.mjs` lands under `src/`, the completeness check asks for the
 * decision rather than guessing it.
 */
const CODE_EXTENSIONS = ['.ts'] as const;
const MARKUP_EXTENSIONS = ['.astro'] as const;
// `.webm` and `.webp` are the hero video and its poster (MUSE-133) — inert for the same
// reason the fonts and the lockup are: a JSON-LD block cannot hide in a binary, and the
// test below keeps this list from rotting into fiction by asserting each one is still here.
const INERT_EXTENSIONS = ['.css', '.png', '.webm', '.webp', '.woff2'] as const;

type Kind = 'code' | 'markup' | 'inert';

function kindOf(file: string): Kind | undefined {
  if (MARKUP_EXTENSIONS.some((ext) => file.endsWith(ext))) return 'markup';
  if (CODE_EXTENSIONS.some((ext) => file.endsWith(ext))) return 'code';
  if (INERT_EXTENSIONS.some((ext) => file.endsWith(ext))) return 'inert';
  return undefined;
}

/** Every file under `src/`, whatever it is, as `src/`-relative paths. */
function srcFiles(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });
  return walk(SRC)
    .map((path) => path.slice(SRC.length + 1).replace(/\\/g, '/'))
    .sort();
}

/**
 * A `<script>` opening tag declaring the JSON-LD mime, as *text*.
 *
 * Loose about the attribute order so `<script is:inline type="application/ld+json">` is
 * the same finding as the other order, and anchored on `<script` so the mime string on
 * its own — in a `const`, in a comparison, in this file's own prose — is not one.
 */
const WRITES_TAG = /<script\b[^>]{0,200}?application\/ld\+json/i;

/** The frontmatter of an `.astro` component, and its template, separately. */
function astroHalves(text: string): { frontmatter: string; template: string } {
  const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fence) return { frontmatter: '', template: text };
  return { frontmatter: fence[1]!, template: text.slice(fence.index + fence[0].length) };
}

/** Every string literal and every template-literal text span in a chunk of TypeScript. */
function literalsIn(file: string, code: string): string[] {
  const tree = ts.createSourceFile(
    file,
    code,
    ts.ScriptTarget.ESNext,
    /* setParentNodes */ false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      found.push(node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/**
 * Does this file's **code** write a JSON-LD `<script>` tag?
 *
 * Takes the text as an argument so the rule can be tested *as a rule*, against the two
 * escapes MUSE-100 recorded, rather than by planting a tag in the tree and remembering to
 * take it out again.
 *
 * **It reads code, not prose, and that is the reason the narrowing needs.** The old scan
 * looked at `.astro` files only, and said a `.ts` module could not emit a tag — it can:
 * export the tag as a string and write `<Fragment set:html={EXTRA_LD} />`, and no `.astro`
 * file contains the literal. So every file that can execute is read now, and what is read
 * is its string literals and its markup, with comments left out by construction — which
 * is what lets `src/lib/structured-data.ts` and `BaseLayout.astro` go on *documenting* the
 * tag in a doc comment. A guard that cannot survive the thing it guards being documented
 * is a guard that gets deleted.
 *
 * **What it cannot see is a computed attribute**, and `does not see a computed type` below
 * asserts that rather than leaving it to be discovered: `'application/ld' + '+json'` is in
 * no literal, and a template span splits either side of its `${}`. No text scan can close
 * that, which is why this one is the second check and the per-page count over the built
 * output is the first.
 */
function writesJsonLdTag(file: string, text: string): boolean {
  const kind = kindOf(file);
  if (kind === 'inert' || kind === undefined) return false;
  if (kind === 'code') {
    return literalsIn(file, text).some((value) => WRITES_TAG.test(value));
  }
  const { frontmatter, template } = astroHalves(text);
  const blanked = template
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  return (
    WRITES_TAG.test(blanked) ||
    literalsIn(`${file}.ts`, frontmatter).some((value) => WRITES_TAG.test(value))
  );
}

/**
 * The structural rule the ticket asks for: one module, not a `<script>` tag per
 * component. Asserted on the source tree as well as on the output, because the natural
 * way to add `Event` markup later is a tag in the events component — and a failure that
 * names the file beats one that names the page it reached.
 */
describe('the emission lives in one place', () => {
  it('writes a JSON-LD `<script>` tag in exactly one file under `src/`', () => {
    const emitters = srcFiles().filter((file) =>
      writesJsonLdTag(file, readFileSync(join(SRC, file), 'utf8')),
    );
    expect(emitters, 'one emission site, or "agrees with the page" has two answers').toEqual([
      'layouts/BaseLayout.astro',
    ]);
  });

  it('classifies every extension present under `src/`', () => {
    const unread = srcFiles().filter((file) => kindOf(file) === undefined);
    expect(
      unread,
      'an extension nothing knows how to read is a blind spot, not a pass',
    ).toEqual([]);
  });

  /** Each declared extension is asserted still live, so the table cannot rot into fiction. */
  it('declares no extension that is no longer in the tree', () => {
    const files = srcFiles();
    for (const ext of [...CODE_EXTENSIONS, ...MARKUP_EXTENSIONS, ...INERT_EXTENSIONS]) {
      expect(
        files.some((file) => file.endsWith(ext)),
        `${ext} is classified above and nothing under src/ has it any more`,
      ).toBe(true);
    }
  });
});

/**
 * The scan's own behaviour, against the forms MUSE-100 demonstrated.
 *
 * Each is a source string rather than a file: a fixture under `src/` that deliberately
 * breaks the rule would be a second emission site shipped to the deploy, which is a worse
 * problem than the one it solves (`source-guard.ts` takes the same position for `test/`).
 */
describe('the source scan reads code, not prose', () => {
  it('finds the tag in an `.astro` template', () => {
    const component = [
      '---',
      'const x = 1;',
      '---',
      '',
      '<script type="application/ld+json">{}</script>',
    ].join('\n');
    expect(writesJsonLdTag('components/Qa.astro', component)).toBe(true);
  });

  /**
   * MUSE-100's second escape. The old scan read `.astro` files only and gave as its reason
   * that a `.ts` module cannot emit a tag; this is the module that did, through
   * `<Fragment set:html={EXTRA_LD} />` in a component containing no literal of its own.
   */
  it('finds the tag in a `.ts` module that exports it as a string', () => {
    const module = [
      'export const EXTRA_LD =',
      `  '<script type="application/ld+json">{"@type":"ImageGallery"}</script>';`,
    ].join('\n');
    expect(writesJsonLdTag('lib/qa-extra-ld.ts', module)).toBe(true);
  });

  it('finds it in a template literal too', () => {
    const module = 'export const LD = `<script type="application/ld+json">${body}</script>`;';
    expect(writesJsonLdTag('lib/qa-extra-ld.ts', module)).toBe(true);
  });

  it('does not report the tag named in a doc comment', () => {
    const module = [
      '/** Serialised for a `<script type="application/ld+json">`. */',
      'export function jsonLd(x: unknown): string {',
      '  return JSON.stringify(x);',
      '}',
    ].join('\n');
    expect(writesJsonLdTag('lib/structured-data.ts', module)).toBe(false);
  });

  it('does not report the tag named in an `.astro` template comment', () => {
    const component = [
      '---',
      'const x = 1;',
      '---',
      '',
      "{/* The site's only `application/ld+json` tag lives in BaseLayout. */}",
      '<p>{x}</p>',
    ].join('\n');
    expect(writesJsonLdTag('components/Qa.astro', component)).toBe(false);
  });

  it('does not report the mime type on its own, outside a tag', () => {
    expect(writesJsonLdTag('lib/qa.ts', `const MIME = 'application/ld+json';`)).toBe(false);
  });

  /**
   * **The hole, asserted.** MUSE-100's first escape computes the attribute, so the mime
   * string is in no literal and in no template span. The scan says `false` here and is
   * right to: there is nothing in the text to find. The per-page count over the built
   * output is what catches this form, which is why that check is the primary one and this
   * one may not be the only one. If this test ever goes red because somebody taught the
   * scan to follow a concatenation, that is fine — delete it and say so.
   */
  it('does not see a computed `type`, which is why the output count is the first check', () => {
    const component = [
      '---',
      `const LD_MIME = 'application/ld' + '+json';`,
      '---',
      '',
      '<script type={LD_MIME} is:inline set:html={payload} />',
    ].join('\n');
    expect(writesJsonLdTag('components/Qa.astro', component)).toBe(false);
  });
});

/**
 * And the extractor's own behaviour, since it is now the primary check. Every spelling
 * below is one tag to a browser, so every one of them has to be one tag here.
 */
describe('the output count sees a block however the tag is spelled', () => {
  it('counts a computed, a single-quoted and an upper-case attribute alike', () => {
    const html = [
      '<script type="application/ld+json">{"a":1}</script>',
      `<script is:inline type='application/ld+json'>{"b":2}</script>`,
      '<script TYPE="Application/LD+JSON">{"c":3}</script>',
      '<script type=application/ld+json>{"d":4}</script>',
      '<script type="application/ld+json" >{"e":5}</script>',
    ].join('\n');
    expect(jsonLdTagCount(html)).toBe(5);
    expect(jsonLdBlocks(html).map((raw) => JSON.parse(raw) as unknown)).toEqual([
      { a: 1 },
      { b: 2 },
      { c: 3 },
      { d: 4 },
      { e: 5 },
    ]);
  });

  it('counts no ordinary script and no mention of the mime in text', () => {
    const html = [
      '<script type="module">const t = "application/ld+json";</script>',
      '<p>application/ld+json</p>',
      '<script>console.log(1);</script>',
    ].join('\n');
    expect(jsonLdTagCount(html)).toBe(0);
    expect(jsonLdBlocks(html)).toEqual([]);
  });
});

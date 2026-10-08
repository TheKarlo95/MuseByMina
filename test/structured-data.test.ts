import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  APEX_DEPLOY,
  buildSite,
  canonicalOf,
  PAGES_DEPLOY,
  type Build,
} from './helpers/build';
import { claimOutDir } from './helpers/scratch';
import { seedDocs, type SeedDoc } from './helpers/seed';
import { servePages, type Host } from './helpers/serve';

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

/**
 * The route → output file mapping, spelled out rather than imported from
 * `src/lib/i18n.ts`, for the reason `test/seo.test.ts` and `test/content.test.ts` both
 * give: an assertion about URLs that computes its expectations with the code under test
 * agrees with that code by construction.
 */
const PAGE_FILES: Record<Locale, string[]> = {
  hr: ['index.html', 'schedule/index.html', 'contact/index.html', 'privacy/index.html'],
  en: [
    'en/index.html',
    'en/schedule/index.html',
    'en/contact/index.html',
    'en/privacy/index.html',
  ],
};

/** Every indexable page of a build, with the locale it is published in. */
function indexablePages(build: Build): { file: string; locale: Locale; html: string }[] {
  return LOCALES.flatMap((locale) =>
    PAGE_FILES[locale].map((file) => ({ file, locale, html: build.read(file) })),
  );
}

/* --------------------------------------------------------------- reading the output */

/**
 * The raw text of every `<script type="application/ld+json">` block on a page.
 *
 * Deliberately **not** parsed here. "Does it parse" is one of the claims under test — a
 * trailing comma in hand-assembled JSON-LD is the classic break and it is silent, since
 * a crawler simply ignores a block it cannot read — so the extractor hands back text and
 * the assertion does the parsing.
 */
function jsonLdBlocks(html: string): string[] {
  return [
    ...html.matchAll(
      /<script[^>]*\btype=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/g,
    ),
  ].map((match) => match[1]!);
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
 * AC1 — Given any page, then it carries an organisation block with name, address,
 * email, social profiles and URL.
 */
describe('AC1: every page carries the studio block', () => {
  for (const [name, build] of TARGETS) {
    it(`publishes exactly one JSON-LD document per page (${name})`, () => {
      const missing = indexablePages(build())
        .filter(({ html }) => jsonLdBlocks(html).length !== 1)
        .map(({ file, html }) => `${file}: ${jsonLdBlocks(html).length} block(s)`);
      expect(missing).toEqual([]);
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
    const html = pages.read('404.html');
    expect(canonicalOf(html), 'the 404 declares a canonical').toBeUndefined();
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

/**
 * The structural rule the ticket asks for: one module, not a `<script>` tag per
 * component. Asserted on the source tree rather than left as a note, because the natural
 * way to add `Event` markup later is a tag in the events component — and once there are
 * two emission sites, "the block agrees with the page" has two answers.
 */
describe('the emission lives in one place', () => {
  it('writes a `<script type="application/ld+json">` tag in exactly one file', async () => {
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const root = fileURLToPath(new URL('../src', import.meta.url));

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry);
        return statSync(path).isDirectory() ? walk(path) : [path];
      });

    /**
     * `.astro` only, and the mime string only inside a `<script>` tag.
     *
     * Both narrowings are the rule stated accurately rather than loosely. What must not
     * spread is the *element* — a second `<script type="application/ld+json">` is what
     * puts a second block on a page — and markup only reaches a page from a component or
     * a layout. A `.ts` module under `src/lib/` cannot emit one; the convention here is
     * already that a module exports script *content* and an `.astro` file writes the tag
     * around it (`src/lib/theme.ts`, `src/lib/lang.ts`).
     *
     * Written loosely, this check fails on `src/lib/structured-data.ts` naming the tag in
     * its own doc comment — a guard that cannot survive the thing it guards being
     * documented is a guard that gets deleted.
     */
    const tag = /<script[^>]*\btype=["']application\/ld\+json["']/;
    const emitters = walk(root)
      .filter((path) => path.endsWith('.astro'))
      .filter((path) => tag.test(readFileSync(path, 'utf8')))
      .map((path) => path.slice(root.length + 1));

    expect(emitters, 'one emission site, or "agrees with the page" has two answers').toEqual(
      ['layouts/BaseLayout.astro'],
    );
  });
});

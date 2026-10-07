import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { astroBuild } from './scratch';

/**
 * Where a build lands is not this module's business any more — `./scratch.ts` mints the
 * directory and runs `astro build` into it, and nothing in `test/` can name one itself.
 * Re-exported because `SCRATCH` was part of this module's surface (MUSE-9).
 */
export { SCRATCH } from './scratch';

/** A deploy target, exactly as CI passes it to `npm run build`. */
export interface Deploy {
  SITE: string;
  BASE: string;
}

/** What `.github/workflows/deploy.yml` uses today: GitHub Pages project sub-path. */
export const PAGES_DEPLOY: Deploy = {
  SITE: 'https://thekarlo95.github.io',
  BASE: '/MuseByMina',
};

/** A deliberately different target: custom apex domain, no sub-path. */
export const APEX_DEPLOY: Deploy = {
  SITE: 'https://muse.example',
  BASE: '/',
};

export interface Build {
  deploy: Deploy;
  outDir: string;
  /** The site root as a browser sees it, no trailing slash. */
  origin: string;
  read(file: string): string;
  has(file: string): boolean;
  files(): string[];
  /** Is `file` an existing regular file? A directory is not something a browser can fetch. */
  isFile(file: string): boolean;
  /** Every `.html` page in the output, as output-relative paths. */
  htmlFiles(): string[];
  /**
   * Every file in the output, recursively, as output-relative paths.
   *
   * `files()` lists the output root only, which is enough to check that a root-level
   * artefact exists. `test/nojs.test.ts` needs the whole tree instead: its claim is that
   * there is no `.js` file *anywhere* in the deployed output, and a deny-list that only
   * sees the root is a deny-list that misses `_astro/`.
   */
  allFiles(): string[];
}

/** Every file under `dir`, recursively, as absolute paths. */
function walkOutput(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkOutput(full) : [full];
  });
}

/**
 * Build the real site into a directory of its own with the given SITE/BASE.
 *
 * The output directory is minted by `astroBuild`, not chosen here: see `./scratch.ts`
 * for why that is the fix for MUSE-17 rather than another per-suite naming scheme.
 */
export function buildSite(deploy: Deploy): Build {
  const outDir = astroBuild({ SITE: deploy.SITE, BASE: deploy.BASE });

  const basePath = deploy.BASE === '/' ? '' : deploy.BASE.replace(/\/$/, '');

  return {
    deploy,
    outDir,
    origin: `${deploy.SITE.replace(/\/$/, '')}${basePath}`,
    read: (file) => readFileSync(join(outDir, file), 'utf8'),
    has: (file) => existsSync(join(outDir, file)),
    files: () => readdirSync(outDir),
    isFile: (file) => {
      try {
        return statSync(join(outDir, file)).isFile();
      } catch {
        return false;
      }
    },
    htmlFiles: () =>
      walkOutput(outDir)
        .filter((f) => f.endsWith('.html'))
        .map((f) => relative(outDir, f).replace(/\\/g, '/'))
        .sort(),
    allFiles: () =>
      walkOutput(outDir)
        .map((f) => relative(outDir, f).replace(/\\/g, '/'))
        .sort(),
  };
}

/**
 * The URL space the deploy owns, with a trailing slash so it can be a `new URL` base.
 *
 * `https://host/MuseByMina/` on Pages, `https://host/` on an apex domain. Anything the
 * host serves lives under this prefix and nothing else does.
 */
function deployRoot(build: Build): URL {
  return new URL(`${build.origin}/`);
}

/** The path prefix the deploy is served from, with its slash: `/MuseByMina/`, or `/`. */
export function basePath(build: Build): string {
  return deployRoot(build).pathname;
}

/** A subresource a built page tells the browser to fetch. */
export interface AssetRef {
  /** Where it came from, for failure messages — e.g. `<link rel="preload">`. */
  source: string;
  /** The attribute value as emitted, undecoded. */
  url: string;
}

/**
 * `<link>` rel values that name a file the deploy has to serve.
 *
 * Deliberately not `canonical`, `alternate` or an `<a href>`: those are page URLs, which
 * `pageRefs` collects and `test/urls.test.ts` resolves against a host that redirects —
 * the trailing-slash question (MUSE-9), not the does-this-file-exist question.
 */
const ASSET_RELS = new Set([
  'preload',
  'modulepreload',
  'prefetch',
  'stylesheet',
  'icon',
  'apple-touch-icon',
  'mask-icon',
  'manifest',
]);

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/**
 * Every subresource URL in a built page, read off the markup.
 *
 * Derived from the HTML rather than from a list of the tags we happen to emit today, so
 * the next asset reference anyone adds is covered the day it lands.
 */
export function assetRefs(html: string): AssetRef[] {
  const refs: AssetRef[] = [];

  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const rels = (attr(m[0], 'rel') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const named = rels.filter((rel) => ASSET_RELS.has(rel));
    const href = attr(m[0], 'href');
    if (named.length === 0 || href === undefined) continue;
    refs.push({ source: `<link rel="${rels.join(' ')}">`, url: href });
  }

  for (const [tag, pattern] of [
    ['script', /<script\b[^>]*>/g],
    ['img', /<img\b[^>]*>/g],
    ['source', /<source\b[^>]*>/g],
  ] as const) {
    for (const m of html.matchAll(pattern)) {
      const url = attr(m[0], 'src');
      if (url !== undefined) refs.push({ source: `<${tag} src>`, url });
    }
  }

  return refs;
}

/** `href` of every `<link>` carrying exactly `rel`, in document order. */
export function linkHrefs(html: string, rel: string): string[] {
  return assetRefs(html)
    .filter((ref) => ref.source === `<link rel="${rel}">`)
    .map((ref) => ref.url);
}

/**
 * Is `url` something this deploy itself must serve?
 *
 * False for another origin, a `data:` URI and a bare fragment — real references the suite
 * has no business resolving against `dist`.
 */
export function isOwnAsset(build: Build, url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed || trimmed.startsWith('#')) return false;
  let resolved: URL;
  try {
    resolved = new URL(trimmed, deployRoot(build));
  } catch {
    return false;
  }
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return false;
  return resolved.origin === deployRoot(build).origin;
}

/**
 * The output file `url` is served from, or `undefined` if nothing serves it.
 *
 * Answers the question the way the host does: resolve the reference, then look it up
 * *under the deploy base path*. A same-origin URL outside that prefix — `/MuseByMina…`
 * rather than `/MuseByMina/…`, which is MUSE-8 — is a 404 however many matching bytes
 * sit in `dist`, so it gets no file at all rather than one that happens to exist.
 */
export function assetFile(build: Build, url: string): string | undefined {
  const root = deployRoot(build);
  let resolved: URL;
  try {
    resolved = new URL(url.trim(), root);
  } catch {
    return undefined;
  }
  if (resolved.origin !== root.origin) return undefined;
  if (!resolved.pathname.startsWith(root.pathname)) return undefined;
  const path = decodeURIComponent(resolved.pathname.slice(root.pathname.length));
  return path === '' ? 'index.html' : path;
}

/**
 * A page URL a built page points at — a navigable address, not a subresource.
 *
 * Kept apart from `AssetRef` because the question is different: an asset either exists in
 * `dist` or does not, whereas a page URL can exist and still be the wrong *spelling* of
 * itself and 301. `test/urls.test.ts` (MUSE-9) is what resolves these.
 */
export interface PageRef {
  /** Where it came from, for failure messages — e.g. `<link rel="canonical">`. */
  source: string;
  /** The attribute value as emitted. */
  url: string;
}

/** The `<link rel="canonical">` href a page declares, if any. */
export function canonicalOf(html: string): string | undefined {
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    if ((attr(m[0], 'rel') ?? '').toLowerCase() !== 'canonical') continue;
    return attr(m[0], 'href');
  }
  return undefined;
}

/**
 * `hreflang` → `href` for the `<link rel="alternate">` tags a page declares.
 *
 * `x-default` is included: Google treats it as one more alternate in the cluster, and it
 * has to be a canonical, non-redirecting URL for exactly the same reason.
 */
export function declaredAlternates(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    if ((attr(m[0], 'rel') ?? '').toLowerCase() !== 'alternate') continue;
    const hreflang = attr(m[0], 'hreflang');
    const href = attr(m[0], 'href');
    if (hreflang && href) out.set(hreflang, href);
  }
  return out;
}

/**
 * Every navigable URL in a built page: links, canonical, hreflang alternates, `og:url`.
 *
 * Read off the markup rather than off a list of the tags the layout happens to emit
 * today, so a URL added tomorrow is covered the day it lands — the same reasoning as
 * `assetRefs` above.
 */
export function pageRefs(html: string): PageRef[] {
  const refs: PageRef[] = [];

  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    const rel = (attr(m[0], 'rel') ?? '').toLowerCase();
    const href = attr(m[0], 'href');
    if (href === undefined) continue;
    if (rel === 'canonical') refs.push({ source: '<link rel="canonical">', url: href });
    if (rel === 'alternate') {
      const hreflang = attr(m[0], 'hreflang');
      refs.push({ source: `<link rel="alternate" hreflang="${hreflang}">`, url: href });
    }
  }

  for (const m of html.matchAll(/<meta\b[^>]*>/g)) {
    if (attr(m[0], 'property') !== 'og:url') continue;
    const content = attr(m[0], 'content');
    if (content === undefined) continue;
    refs.push({ source: '<meta property="og:url">', url: content });
  }

  for (const m of html.matchAll(/<a\b[^>]*>/g)) {
    const href = attr(m[0], 'href');
    if (href !== undefined) refs.push({ source: '<a href>', url: href });
  }

  return refs;
}

/** Every `<loc>` in a sitemap document, exactly as written. */
export function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!.trim());
}

/** Each `<url>…</url>` block of a urlset, keyed by its own `<loc>`. */
export function urlEntries(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1]!;
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
    if (loc) out.set(loc.trim(), block);
  }
  return out;
}

/** `hreflang` → `href` for the xhtml:link alternates inside one `<url>` block. */
export function alternates(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of block.matchAll(/<xhtml:link\b([^>]*)\/?>/g)) {
    const attrs = m[1]!;
    const hreflang = /hreflang="([^"]+)"/.exec(attrs)?.[1];
    const href = /href="([^"]+)"/.exec(attrs)?.[1];
    if (hreflang && href) out.set(hreflang, href);
  }
  return out;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
};

/** Enough HTML entity decoding for attribute values Astro escapes on output. */
function decodeEntities(text: string): string {
  return text.replace(/&(#?\w+);/g, (whole, name: string) => ENTITIES[name] ?? whole);
}

/**
 * The `<meta name="description">` a built page serves, decoded.
 *
 * Reading it out of the HTML rather than out of `src/lib/pages.ts` is the whole point:
 * it is the second, independent renderer of the same string, so `llms.txt` can be
 * checked against what a visitor actually gets.
 */
export function metaDescription(html: string): string | undefined {
  for (const m of html.matchAll(/<meta\b[^>]*>/g)) {
    if (!/\bname="description"/.test(m[0])) continue;
    const content = /\bcontent="([^"]*)"/.exec(m[0])?.[1];
    if (content !== undefined) return decodeEntities(content);
  }
  return undefined;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a markdown link whose target is exactly `url` — trailing slash included.
 *
 * Anchored on the closing paren on purpose. A substring test would let `/` match every
 * line in the file, and `/blog` match the `/blog/post` line — so a page could be missing
 * from `llms.txt` entirely and still look present.
 *
 * The slash is *not* optional (it was, until MUSE-9). `llms.txt` publishes URLs for
 * crawlers to follow; a tolerant matcher here let the index advertise the redirecting
 * spelling of every page while the suite stayed green.
 */
export function markdownLinkTo(url: string): RegExp {
  return new RegExp(`\\]\\(\\s*${escapeRegExp(url)}\\s*\\)`);
}

/** The description half of `- [Name](url): description`, or `undefined`. */
export function linkDescription(line: string): string | undefined {
  return /\]\([^)]*\):\s*(\S.*)$/.exec(line)?.[1]?.trim();
}

/** One `User-agent` record: the agents it names and the rules that apply to them. */
export interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

/**
 * robots.txt parsed into user-agent groups (RFC 9309 §2.2).
 *
 * Groups are what make the file mean anything: a `Disallow` only applies to the agents
 * named in its own group. Consecutive `User-agent` lines share one group; the next
 * `User-agent` after a rule starts a new one. Comments and unknown directives are
 * dropped, as crawlers drop them.
 */
export function robotsGroups(txt: string): RobotsGroup[] {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | undefined;
  let acceptingAgents = false;

  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;

    const match = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const field = match[1]!.toLowerCase();
    const value = match[2]!.trim();

    if (field === 'user-agent') {
      if (!current || !acceptingAgents) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
        acceptingAgents = true;
      }
      current.agents.push(value.toLowerCase());
      continue;
    }

    if (field !== 'allow' && field !== 'disallow') continue;
    if (!current) continue; // A rule outside any group applies to nobody.
    acceptingAgents = false;
    // An empty `Disallow:` is the canonical "nothing is disallowed"; it is not a rule.
    if (field === 'disallow' && value === '') continue;
    current[field].push(value);
  }

  return groups;
}

/**
 * Does a robots.txt path pattern match `path`?
 *
 * Patterns are prefix matches with two wildcards (RFC 9309 §2.2.3): `*` stands for any
 * run of characters and a trailing `$` anchors the end. `/` and `/*` therefore both
 * match every path on the site — which is the case a plain `/^Disallow:\s*\/$/` grep
 * misses.
 */
export function robotsPathMatches(pattern: string, path: string): boolean {
  if (pattern === '') return false;
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split('*').map(escapeRegExp).join('[\\s\\S]*');
  return new RegExp(`^${source}${anchored ? '$' : ''}`).test(path);
}

/** The group a crawler calling itself `agent` would obey, or `undefined`. */
export function groupFor(groups: RobotsGroup[], agent: string): RobotsGroup | undefined {
  return groups.find((g) => g.agents.includes(agent.toLowerCase()));
}

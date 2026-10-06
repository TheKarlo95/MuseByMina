import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Build scratch space. Inside the repo rather than `os.tmpdir()` on purpose: Astro
 * moves assets out of `.astro/` with `fs.rename`, which fails with EXDEV when the
 * output directory is on another filesystem.
 */
const SCRATCH = join(ROOT, 'node_modules/.muse-test-builds');

/** Wiped once per run so stale output can never be mistaken for a fresh build. */
let cleaned = false;

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

/**
 * Vitest stamps Vite's own reserved env names onto `process.env` for the test run.
 * Inherited by a child `astro build` they override the real config — `BASE_URL=/`
 * silently flattens `base`, and `NODE_ENV=test` is not what CI builds with. Drop them
 * so the child sees exactly the environment the deploy workflow gives it.
 */
const VITEST_LEAKS = ['BASE_URL', 'MODE', 'DEV', 'PROD', 'SSR', 'NODE_ENV'];

function deployEnv(deploy: Deploy): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of VITEST_LEAKS) delete env[key];
  return { ...env, SITE: deploy.SITE, BASE: deploy.BASE };
}

export interface Build {
  deploy: Deploy;
  outDir: string;
  /** The site root as a browser sees it, no trailing slash. */
  origin: string;
  read(file: string): string;
  has(file: string): boolean;
  files(): string[];
}

/**
 * Build the real site into a throwaway directory with the given SITE/BASE.
 *
 * Deliberately shells out to `astro build` rather than poking at internals: the
 * acceptance criteria are all about what lands in the deployed output.
 */
export function buildSite(deploy: Deploy): Build {
  if (!cleaned) {
    rmSync(SCRATCH, { recursive: true, force: true });
    cleaned = true;
  }
  mkdirSync(SCRATCH, { recursive: true });
  const outDir = mkdtempSync(join(SCRATCH, 'build-'));

  execFileSync('npx', ['astro', 'build', '--outDir', outDir], {
    cwd: ROOT,
    env: deployEnv(deploy),
    stdio: 'pipe',
  });

  const basePath = deploy.BASE === '/' ? '' : deploy.BASE.replace(/\/$/, '');

  return {
    deploy,
    outDir,
    origin: `${deploy.SITE.replace(/\/$/, '')}${basePath}`,
    read: (file) => readFileSync(join(outDir, file), 'utf8'),
    has: (file) => existsSync(join(outDir, file)),
    files: () => readdirSync(outDir),
  };
}

/** Trailing slashes are not semantic here; the site sets `trailingSlash: 'never'`. */
export function normalise(url: string): string {
  return url.replace(/\/$/, '');
}

/** Every `<loc>` in a sitemap document. */
export function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => normalise(m[1]!.trim()));
}

/** Each `<url>…</url>` block of a urlset, keyed by its own `<loc>`. */
export function urlEntries(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/g)) {
    const block = m[1]!;
    const loc = /<loc>([^<]+)<\/loc>/.exec(block)?.[1];
    if (loc) out.set(normalise(loc.trim()), block);
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
    if (hreflang && href) out.set(hreflang, normalise(href));
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
 * Matches a markdown link whose target is exactly `url`, trailing slash optional.
 *
 * Anchored on the closing paren on purpose. A substring test would let `/` match every
 * line in the file, and `/blog` match the `/blog/post` line — so a page could be missing
 * from `llms.txt` entirely and still look present.
 */
export function markdownLinkTo(url: string): RegExp {
  return new RegExp(`\\]\\(\\s*${escapeRegExp(url)}/?\\s*\\)`);
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

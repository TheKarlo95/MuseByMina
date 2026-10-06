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

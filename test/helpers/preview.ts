import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveRequest } from './serve';

/**
 * A served build, for the browser suite.
 *
 * `test/helpers/build.ts` builds into a shared scratch tree it wipes per run; this one
 * owns its own output directory and never touches that tree, so adding a third suite
 * cannot race the two that already build there. It also needs two things that helper
 * deliberately does not do: a running HTTP server, and a stub endpoint standing in for
 * the form provider.
 *
 * The stub is served **same-origin**. The real endpoint is cross-origin, but a mocked
 * cross-origin JSON POST has to survive a CORS preflight that browser automation does
 * not reliably let you intercept — so the suite would be testing the mock, not the
 * form. Same-origin keeps every assertion about our own behaviour. What that cannot
 * cover (the provider's CORS headers, its response shape, real delivery) needs real
 * credentials and is called out in the PR.
 *
 * Page URLs are resolved by `resolveRequest` from `./serve` — the model of GitHub Pages
 * that MUSE-9 established and `test/urls.test.ts` pins — rather than by a second,
 * more forgiving resolver here. A browser suite that quietly served both spellings of
 * every URL would be the easiest possible way to stop noticing a trailing-slash
 * regression.
 */
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Inside the repo: Astro renames files out of `.astro/`, which is EXDEV across devices. */
const OUT_DIR = join(ROOT, 'node_modules/.muse-form-preview');

/** What `.github/workflows/deploy.yml` deploys to today — the sub-path case. */
export const PREVIEW_SITE = 'https://thekarlo95.github.io';
export const PREVIEW_BASE = '/MuseByMina';

/**
 * The endpoint the build is configured with: a root-relative path onto the test server.
 *
 * Deliberately outside `PREVIEW_BASE` so it cannot be mistaken for a page of the site.
 */
export const STUB_ENDPOINT = '/__form';

/** See `build.ts` — Vitest stamps Vite's reserved names onto `process.env`. */
const VITEST_LEAKS = ['BASE_URL', 'MODE', 'DEV', 'PROD', 'SSR', 'NODE_ENV'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/** One submission the stub endpoint received. */
export interface StubRequest {
  method: string;
  contentType: string;
  /** Parsed when the body is JSON; `undefined` for a form-encoded native POST. */
  json?: Record<string, unknown>;
  raw: string;
}

/** How the stub should answer the next submission. */
export type StubReply =
  | { kind: 'ok'; status?: number; body?: string }
  | { kind: 'error'; status: number; body?: string }
  /** Destroy the socket — what an offline visitor or a DNS failure looks like. */
  | { kind: 'drop' };

/**
 * The path the host serves a locale-prefixed route at, base and trailing slash included.
 *
 * `/contact` → `/MuseByMina/contact/`. Page URLs carry the slash since MUSE-9; the
 * unslashed spelling is a 301, so it is not what a test should be asserting against.
 */
export function pagePath(route: string): string {
  const segments = route.split('/').filter(Boolean);
  return `${PREVIEW_BASE}/${segments.map((segment) => `${segment}/`).join('')}`;
}

export interface Preview {
  /** `http://127.0.0.1:<port>/MuseByMina`, no trailing slash. */
  origin: string;
  /** Absolute URL for a locale-prefixed route such as `/en/contact`, slash included. */
  url(route: string): string;
  /** Submissions the stub endpoint has received, oldest first. */
  requests: StubRequest[];
  /** Set how the stub answers; applies to every subsequent submission. */
  reply(next: StubReply): void;
  close(): Promise<void>;
}

/** The built output directory, rebuilt once per worker. */
export function buildPreview(): string {
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of VITEST_LEAKS) delete env[key];

  execFileSync('npx', ['astro', 'build', '--outDir', OUT_DIR], {
    cwd: ROOT,
    env: {
      ...env,
      SITE: PREVIEW_SITE,
      BASE: PREVIEW_BASE,
      PUBLIC_FORM_ENDPOINT: STUB_ENDPOINT,
    },
    stdio: 'pipe',
  });

  return OUT_DIR;
}

function extensionOf(file: string): string {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot).toLowerCase();
}

/** Build the site with the stub endpoint configured, then serve it. */
export async function startPreview(): Promise<Preview> {
  // Always a fresh build: stale output that happens to pass is the one failure mode a
  // build-and-assert suite must never have.
  const outDir = buildPreview();

  const requests: StubRequest[] = [];
  let nextReply: StubReply = { kind: 'ok' };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === STUB_ENDPOINT) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        const contentType = req.headers['content-type'] ?? '';
        let json: Record<string, unknown> | undefined;
        if (contentType.includes('application/json')) {
          try {
            json = JSON.parse(raw) as Record<string, unknown>;
          } catch {
            json = undefined;
          }
        }
        requests.push({ method: req.method ?? 'GET', contentType, json, raw });

        if (nextReply.kind === 'drop') {
          res.socket?.destroy();
          return;
        }
        const status = nextReply.kind === 'ok' ? (nextReply.status ?? 200) : nextReply.status;
        res.writeHead(status, { 'content-type': MIME['.json']! });
        res.end(nextReply.body ?? (nextReply.kind === 'ok' ? '{"success":true}' : '{}'));
      });
      return;
    }

    const served = resolveRequest(outDir, `${PREVIEW_BASE}/`, url.pathname);
    if (served.status === 301) {
      res.writeHead(301, { location: served.location });
      res.end();
      return;
    }
    if (served.status === 404) {
      res.writeHead(404, { 'content-type': MIME['.html']! });
      res.end('<!doctype html><title>404</title>not found');
      return;
    }
    // Content types matter here in a way they do not for `servePages`: this output is
    // rendered, and HTML without a charset turns every `č` into a replacement character.
    res.writeHead(200, {
      'content-type': MIME[extensionOf(served.file)] ?? 'application/octet-stream',
    });
    res.end(readFileSync(join(outDir, served.file)));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const host = `http://127.0.0.1:${port}`;

  return {
    origin: `${host}${PREVIEW_BASE}`,
    url: (route) => `${host}${pagePath(route)}`,
    requests,
    reply: (next) => {
      nextReply = next;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

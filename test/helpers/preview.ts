import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { FIXTURE_ENV } from '../../src/lib/sanity/fixture';

import { astroBuild } from './scratch';
import { extensionOf, MIME, resolveRequest } from './serve';

/**
 * A served build, for the browser suites.
 *
 * Output lands wherever `astroBuild` puts it, same as `test/helpers/build.ts`: a
 * directory nothing else can name and nobody has to clear. What this helper adds over
 * that one is a running HTTP server and a stub endpoint standing in for the form
 * provider.
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

/** What `.github/workflows/deploy.yml` deploys to today — the sub-path case. */
export const PREVIEW_SITE = 'https://thekarlo95.github.io';
export const PREVIEW_BASE = '/MuseByMina';

/**
 * The endpoint the build is configured with: a root-relative path onto the test server.
 *
 * Deliberately outside `PREVIEW_BASE` so it cannot be mistaken for a page of the site.
 */
export const STUB_ENDPOINT = '/__form';


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

/** How the build under test is configured, beyond the deploy target. */
export interface PreviewOptions {
  /**
   * What `PUBLIC_FORM_ENDPOINT` is built with. The stub by default.
   *
   * `''` builds the site exactly as `main` deploys it today: MUSE-12 is parked, so no
   * endpoint is configured and a submit cannot reach a provider at all. That is a real
   * failure mode, not a hypothetical one, and MUSE-15's first defect was only visible
   * in it — so a suite has to be able to ask for it.
   */
  endpoint?: string;
  /**
   * An ndjson fixture for this build to read instead of the live dataset (MUSE-25).
   *
   * `MUSE_CONTENT_FIXTURE`, which `vitest.config.ts` already sets for the committed seed —
   * so leaving this unset builds the site a browser suite has always built, off
   * `content/seed.ndjson`, and this option is only how a suite asks for a *different*
   * dataset. Pass `fixtureOf(…)` from `./structural-content`, which is also what
   * `buildSite` takes.
   *
   * It exists because `/gallery`'s subject is photographs and the seed has none: an empty
   * gallery is the shipped page and a populated one is the only state in which a lightbox
   * can be opened, focused, arrowed through and audited. `buildSite` could already do this
   * and cannot serve the result to a browser, which is the half that was missing.
   */
  content?: string;
}

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

/**
 * Build the site with the stub endpoint configured, into a directory of its own.
 *
 * `label` is a readability hint only — it shapes the directory name so a failed build
 * says which suite owned the tree. It used to *be* the isolation (MUSE-10 gave each
 * suite its own name), which is why this bug came back: a name has to be remembered, and
 * a suite copied from another one inherits the name along with everything else. Two
 * callers passing the same label now still get different directories, and a caller that
 * passes none is just as isolated.
 */
export function buildPreview(label?: string, options: PreviewOptions = {}): string {
  return astroBuild(
    {
      SITE: PREVIEW_SITE,
      BASE: PREVIEW_BASE,
      PUBLIC_FORM_ENDPOINT: options.endpoint ?? STUB_ENDPOINT,
      // Omitted rather than set to `undefined`-as-a-string when no fixture is asked for:
      // `vitest.config.ts`'s value then survives and the build reads the committed seed.
      ...(options.content === undefined ? {} : { [FIXTURE_ENV]: options.content }),
    },
    label,
  );
}

/**
 * Build the site with the stub endpoint configured, then serve it.
 *
 * `label` only shapes the output directory's name; see `buildPreview`. Two browser
 * suites running in parallel workers cannot share an output tree whatever they pass.
 */
export async function startPreview(
  label?: string,
  options: PreviewOptions = {},
): Promise<Preview> {
  // Always a fresh build: stale output that happens to pass is the one failure mode a
  // build-and-assert suite must never have.
  const outDir = buildPreview(label, options);

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

    /**
     * Everything that is not the stub endpoint is a static host, and a static host does
     * not accept a POST (MUSE-15). GitHub Pages answers `405 Not Allowed` as an
     * unstyled server page for any method but GET/HEAD, whatever the path — which is
     * what a `method="post"` form with no `action` gets a visitor without JavaScript.
     *
     * Modelled here rather than asserted from a comment, so a form that can still
     * submit natively to a page of the site fails a test instead of shipping.
     */
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': MIME['.txt']! });
      res.end('405 Not Allowed');
      return;
    }

    const served = resolveRequest(outDir, `${PREVIEW_BASE}/`, url.pathname);
    if (served.status === 301) {
      res.writeHead(301, { location: served.location });
      res.end();
      return;
    }
    if (served.status === 404) {
      // The build's own error page, body and all, exactly as the deploy serves it for an
      // unknown path (MUSE-38). A stub body here is why no browser suite could see that
      // the 404 shipped no language handling at all.
      res.writeHead(404, { 'content-type': MIME['.html']! });
      res.end(
        served.file === undefined
          ? '<!doctype html><title>404</title>not found'
          : readFileSync(join(outDir, served.file)),
      );
      return;
    }
    // The table lives in `./serve.ts` now — `servePages` renders to a browser too
    // (MUSE-35), so it needs the same content types rather than a laxer set of its own.
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

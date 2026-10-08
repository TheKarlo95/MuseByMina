import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import {
  extensionOf,
  MIME,
  resolveRequest,
  type Served,
} from '../../scripts/dist-origin.mjs';
import { basePath, type Build } from './build';

/**
 * A static host that resolves URLs the way GitHub Pages does.
 *
 * The resolver, the content types and the `Served` shape are **not defined here**. They
 * live in `scripts/dist-origin.mjs` and are re-exported, because MUSE-52 gave the browser
 * gates in `scripts/` their own in-process server over `dist` — they no longer attach to
 * an `astro preview` daemon — and that server has to answer exactly what this one
 * answers. Two models of the host would drift, and the lenient one would be the one that
 * stopped noticing a trailing-slash regression (MUSE-9). The move is the only direction
 * that works: a `.mjs` script cannot import a `.ts` helper, and `test/origin.test.ts`
 * fails if a second `resolveRequest` reappears in this file.
 *
 * Everything the rules are, and why `astro preview` cannot stand in for them, is
 * documented at the resolver. `test/urls.test.ts` pins each rule against the live
 * deploy's observed behaviour.
 */
export { extensionOf, MIME, resolveRequest, type Served };

/** One response, reduced to what a crawler decides on. */
export interface Probe {
  status: number;
  location: string | undefined;
}

export interface Host {
  /** The local origin standing in for the deploy's own. */
  origin: string;
  /** GET a site-relative path, following nothing. */
  get(path: string): Promise<Probe>;
  /** GET an absolute URL the build declares, rewritten onto this host. */
  getUrl(url: string): Promise<Probe>;
  close(): Promise<void>;
}

/** Serve `build`'s output over HTTP with the resolution rules above. */
export async function servePages(build: Build): Promise<Host> {
  const base = basePath(build);

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    const served = resolveRequest(build.outDir, base, path);

    if (served.status === 301) {
      res.writeHead(301, { Location: served.location });
      res.end();
      return;
    }
    if (served.status === 404) {
      // The build's own `404.html` when the resolver found one — what GitHub Pages serves
      // for an unknown path, and the only way a browser suite can reach the error page at
      // all (MUSE-38).
      if (served.file !== undefined) {
        res.writeHead(404, { 'Content-Type': MIME['.html']! });
        res.end(readFileSync(join(build.outDir, served.file)));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    // Typed, not bare. `test/fonts.test.ts` drives a real browser against this host to
    // measure which faces the CSS engine asks for, and a stylesheet served without
    // `text/css` is one the browser declines to apply — which would read as "this page
    // needs no fonts" rather than as a broken harness.
    res.writeHead(200, {
      'Content-Type': MIME[extensionOf(served.file)] ?? 'application/octet-stream',
    });
    res.end(readFileSync(join(build.outDir, served.file)));
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind to a TCP port');
  }
  const origin = `http://127.0.0.1:${address.port}`;

  const get = async (path: string): Promise<Probe> => {
    const res = await fetch(`${origin}${path}`, { redirect: 'manual' });
    return { status: res.status, location: res.headers.get('location') ?? undefined };
  };

  return {
    origin,
    get,
    getUrl: (url) => {
      const parsed = new URL(url);
      return get(`${parsed.pathname}${parsed.search}`);
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

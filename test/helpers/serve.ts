import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

import { basePath, type Build } from './build';

/**
 * A static host that resolves URLs the way GitHub Pages does.
 *
 * `astro preview` is not usable for this: it answers both `/MuseByMina` and
 * `/MuseByMina/` with 200 and never redirects, so the mismatch MUSE-9 is about is
 * invisible to it. The rules below were read off the live deploy with
 * `curl -o /dev/null -w '%{http_code} %{redirect_url}'`, and `test/urls.test.ts`
 * pins each of them so this model cannot quietly drift into being lenient:
 *
 *   /MuseByMina       301 -> /MuseByMina/     deploy root, spelled without its slash
 *   /MuseByMina/      200                     index.html of a directory, with the slash
 *   /MuseByMina/en    301 -> /MuseByMina/en/  directory, without the slash
 *   /MuseByMina/en/   200
 *   /MuseByMina/404   200                     extensionless resolution of 404.html
 *   /MuseByMina/404/  404                     …but not as a directory
 *   /MuseByMina/nope  404
 */
export type Served =
  | { status: 200; file: string }
  | { status: 301; location: string }
  | { status: 404 };

function isFile(outDir: string, relPath: string): boolean {
  try {
    return statSync(join(outDir, relPath)).isFile();
  } catch {
    return false;
  }
}

/**
 * What the host answers for `requestPath`, given an output tree published under `base`.
 *
 * `base` carries its trailing slash (`/MuseByMina/`, or `/` on an apex domain), because
 * that prefix is the whole URL space the deploy owns.
 */
export function resolveRequest(
  outDir: string,
  base: string,
  requestPath: string,
): Served {
  if (!requestPath.startsWith(base)) {
    // The deploy root written without its slash. Pages cannot serve this as a page —
    // it is a directory — so it always redirects, whatever `build.format` is.
    if (`${requestPath}/` === base) return { status: 301, location: base };
    return { status: 404 };
  }

  let rel: string;
  try {
    rel = decodeURIComponent(requestPath.slice(base.length));
  } catch {
    return { status: 404 };
  }

  if (rel !== '' && isFile(outDir, rel)) return { status: 200, file: rel };

  const index = join(rel, 'index.html');
  if (isFile(outDir, index)) {
    return requestPath.endsWith('/')
      ? { status: 200, file: index }
      : { status: 301, location: `${requestPath}/` };
  }

  // Pages serves `/foo` from `foo.html`, but not `/foo/`.
  if (!requestPath.endsWith('/') && isFile(outDir, `${rel}.html`)) {
    return { status: 200, file: `${rel}.html` };
  }

  return { status: 404 };
}

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
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    res.writeHead(200);
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

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * **Where a browser check gets its server, and how it knows whose build answered.**
 *
 * MUSE-52. `astro preview` daemonises under this environment — Astro 7's agent-mode
 * backgrounding, the same behaviour that makes `--ignore-lock` load-bearing for
 * `astro dev` in MUSE-35 — and it will **silently reuse an existing daemon on another
 * port** rather than fail or warn. With several worktrees routinely live at once, a
 * foreign daemon is the normal case, not an accident. So `npm run a11y`, which needed a
 * server and took whatever was at `ORIGIN`, bound to a preview belonging to a different
 * agent's worktree, audited that build, and reported every route clean in both themes.
 * Nothing wrong shipped, but only because somebody was suspicious.
 *
 * `scripts/a11y.mjs` had already been hardened twice for exactly this: it checks the HTTP
 * status (added after it reported 8/8 clean against a stale server answering 404) and it
 * checks for an unexpected redirect (added after it audited the wrong page twice). Both
 * confirm *something* answered correctly. Neither confirms **which build** answered —
 * and "which build" is the question, so a third liveness check would have been the third
 * wrong answer.
 *
 * Two mechanisms, because the problem has two halves:
 *
 *   1. **There is nothing to attach to.** With no `ORIGIN`, a check serves `dist` itself
 *      from an in-process `node:http` server on an **ephemeral** port. No daemon is
 *      started, no fixed port is named, and the server dies with the process that needs
 *      it. This is the shape `test/helpers/preview.ts` has always used, which is why the
 *      vitest suite was never exposed to this bug — the scripts were simply the half that
 *      never got it.
 *   2. **An explicit one is proved.** `ORIGIN` stays supported, because pointing a check
 *      at a server you started yourself or at the deployed site is legitimate. When it is
 *      set, every URL the run is about to measure is fetched and compared **byte for
 *      byte** against what the local build holds for it, and a difference is a hard
 *      failure naming the URL and both digests. `UNVERIFIED_ORIGIN=1` opts out — for the
 *      deployed site, where there is no local build to compare against — and the log then
 *      stops claiming the result is about this build.
 *
 * **Identity is content, never a stamp.** The fingerprint is a hash of the output tree
 * computed by the reader, so nothing is added to `dist` and nothing in it varies between
 * two builds of one commit. The ticket weighs a `<meta>` or a stamp file and flags that
 * cost; MUSE-20's byte-identical criterion is still live, so this side of the comparison
 * is the one that pays. `test/origin.test.ts` fingerprints two independent builds of the
 * commit and demands they agree, which is what keeps that true rather than intended.
 *
 * It also makes the comparison mean the right thing: two worktrees sitting on the same
 * commit are serving the *same site*, and auditing either is sound. What fails is a
 * server whose bytes differ from the build under test — which is the actual defect, not
 * "a different directory".
 */

/** The repository root — this file lives in `scripts/`. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Where `npm run build` puts the site, unless `DIST` says otherwise. */
const DEFAULT_DIST = 'dist';

/** What `astro.config.mjs` mounts the site under, unless `BASE` says otherwise. */
const DEFAULT_BASE = '/MuseByMina';

/**
 * What the deploy's own `404.html` is called in the output tree.
 *
 * One file for the whole site, served for every unknown path — which is why the page has
 * no URL of its own and no locale twin (MUSE-13, MUSE-38).
 */
const ERROR_PAGE = '404.html';

/**
 * What the host answers for a request.
 *
 * A 404 carries a `file` when the build has an error page to serve for it, because that
 * is what GitHub Pages does: the status is 404 and the body is `404.html`. The model used
 * to answer the status and invent the body, which left the one page a lost visitor
 * actually meets unreachable to every browser suite in the repo — MUSE-38's all-Croatian
 * 404 could only be reproduced against the deployed site. A request outside the deploy's
 * own prefix gets no body, because that URL space is not ours to answer for (MUSE-8).
 *
 * @typedef {{ status: 200, file: string } | { status: 301, location: string } | { status: 404, file?: string }} Served
 */

/**
 * One page a browser check is going to measure.
 *
 * Three fields rather than a route string, because MUSE-55: a route string carries only
 * *which* page, and the two things a check also has to know about the error page are the
 * **spelling** of its URL and the **status** the host answers for it. Both used to be
 * assumed — `site.url()` for the spelling and a literal `200` for the status — and
 * between them they made the one page every lost visitor meets the one page the
 * accessibility gate could not reach.
 *
 * `route` is still what decides the locale pin and what the log calls the page
 * (`scripts/browser-checks.mjs`, MUSE-48); `path` is what is actually requested; `status`
 * and `file` come from `resolveRequest`, so they are the host model's answer rather than
 * anyone's expectation.
 *
 * @typedef {object} AuditTarget
 * @property {string} route Locale-prefixed route — `/`, `/en/schedule`, `/en/404`.
 * @property {string} path The URL path to request, exactly as the host wants it spelled.
 * @property {number} status What the host answers for that path. Not always 200.
 * @property {string} file The file in the build that answers it.
 */

/**
 * A running static host over one build.
 *
 * @typedef {object} DistServer
 * @property {string} origin Scheme, host and the port it really bound to — no path.
 * @property {number} port The ephemeral port, for a log line that can be checked.
 * @property {() => Promise<void>} close
 */

/**
 * The build under test, reduced to something a log line can carry.
 *
 * @typedef {object} Fingerprint
 * @property {string} hash 16 hex characters of a sha256 over the whole output tree.
 * @property {number} files How many files that was.
 */

/**
 * What `verifyServedBuild` proved.
 *
 * @typedef {object} Verification
 * @property {string} hash
 * @property {number} files
 * @property {string[]} checked The URL paths it compared, deploy base included.
 */

/**
 * The site a check is about to measure.
 *
 * @typedef {object} Site
 * @property {string} origin
 * @property {string} base The deploy base, trailing slash included.
 * @property {(route: string) => string} url Absolute URL for a route, slash included.
 * @property {(path: string) => { url: (route: string) => string }} at This site addressed
 *   at one exact URL path — for the page whose spelling is not `pagePath`'s. See `at`.
 * @property {() => Promise<void>} close
 */

/**
 * Content types for everything the build emits.
 *
 * Shared with `test/helpers/serve.ts` and `test/helpers/preview.ts`, which serve the same
 * output to the same browser. A stylesheet sent without `text/css` is ignored outright in
 * standards mode, and HTML without a charset turns every `č` into a replacement
 * character — so a server that omits these does not render a slightly different page, it
 * renders a different one, and a check against it measures that.
 *
 * Typed as an open record rather than inferred: every caller indexes it with whatever
 * extension the build happened to emit, and the fallback beside each lookup is the point.
 *
 * @type {Record<string, string>}
 */
export const MIME = {
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

/**
 * The lowercased extension of `file`, dot included, or `''`.
 *
 * @param {string} file
 * @returns {string}
 */
export function extensionOf(file) {
  const dot = file.lastIndexOf('.');
  return dot === -1 ? '' : file.slice(dot).toLowerCase();
}

/**
 * @param {string} outDir
 * @param {string} relPath
 * @returns {boolean}
 */
function isFile(outDir, relPath) {
  try {
    return statSync(join(outDir, relPath)).isFile();
  } catch {
    return false;
  }
}

/**
 * What the host answers for `requestPath`, given an output tree published under `base`.
 *
 * A model of GitHub Pages, and **the only one in the repository** — `test/helpers/serve.ts`
 * re-exports this rather than keeping a second copy, because two resolvers drift and the
 * lenient one would be the one that stopped noticing a trailing-slash regression (MUSE-9).
 * `astro preview` is not usable for this either: it answers both `/MuseByMina` and
 * `/MuseByMina/` with 200 and never redirects, so the mismatch MUSE-9 is about is
 * invisible to it. The rules below were read off the live deploy with
 * `curl -o /dev/null -w '%{http_code} %{redirect_url}'`, and `test/urls.test.ts` pins each
 * of them:
 *
 *   /MuseByMina       301 -> /MuseByMina/     deploy root, spelled without its slash
 *   /MuseByMina/      200                     index.html of a directory, with the slash
 *   /MuseByMina/en    301 -> /MuseByMina/en/  directory, without the slash
 *   /MuseByMina/en/   200
 *   /MuseByMina/404   200                     extensionless resolution of 404.html
 *   /MuseByMina/404/  404                     …but not as a directory
 *   /MuseByMina/nope  404
 *
 * The two 404s above are served *with the error page's body*, which is the `file` on the
 * `Served` shape — see the note there.
 *
 * `base` carries its trailing slash (`/MuseByMina/`, or `/` on an apex domain), because
 * that prefix is the whole URL space the deploy owns.
 *
 * @param {string} outDir
 * @param {string} base
 * @param {string} requestPath
 * @returns {Served}
 */
export function resolveRequest(outDir, base, requestPath) {
  if (!requestPath.startsWith(base)) {
    // The deploy root written without its slash. Pages cannot serve this as a page —
    // it is a directory — so it always redirects, whatever `build.format` is.
    if (`${requestPath}/` === base) return { status: 301, location: base };
    return { status: 404 };
  }

  let rel;
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

  // Inside our prefix and nothing matched: the deploy's own error page, body and all.
  return isFile(outDir, ERROR_PAGE)
    ? { status: 404, file: ERROR_PAGE }
    : { status: 404 };
}

/**
 * Every file in `outDir`, as `/`-separated paths relative to it.
 *
 * @param {string} outDir
 * @returns {string[]}
 */
function filesUnder(outDir) {
  /** @type {string[]} */
  const found = [];
  /** @param {string} prefix */
  const walk = (prefix) => {
    const dir = prefix === '' ? outDir : join(outDir, prefix);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else found.push(rel);
    }
  };
  walk('');
  return found.sort();
}

/**
 * Which build this output tree **is**.
 *
 * A sha256 over every path and every byte under `outDir`. Derived from content, so it is
 * identical for two builds of one commit in two different directories and different the
 * moment one byte of output differs — which is the only definition that makes "is this
 * server serving my build" a question with a right answer. Nothing is written into
 * `dist`: the cost of identity is paid by the reader, not by the output (MUSE-20).
 *
 * Truncated to 16 characters because it goes in a log line a person reads. Collision is
 * not the threat model here — a stale daemon is not adversarial.
 *
 * @param {string} outDir
 * @returns {Fingerprint}
 */
export function fingerprint(outDir) {
  const files = filesUnder(outDir);
  const whole = createHash('sha256');
  for (const rel of files) {
    whole.update(rel);
    whole.update('\0');
    whole.update(createHash('sha256').update(readFileSync(join(outDir, rel))).digest());
    whole.update('\n');
  }
  return { hash: whole.digest('hex').slice(0, 16), files: files.length };
}

/**
 * The path the host serves `route` at, deploy base and trailing slash included.
 *
 * `/en/schedule` → `/MuseByMina/en/schedule/`. Page URLs carry the slash since MUSE-9;
 * the unslashed spelling is a 301, so auditing it would audit a redirect rather than the
 * page. One implementation, shared by all three browser gates — each of them used to
 * carry its own copy of this join.
 *
 * @param {string} base The deploy base, trailing slash included.
 * @param {string} route
 * @returns {string}
 */
export function pagePath(base, route) {
  const segments = route.split('/').filter(Boolean);
  return `${base}${segments.map((segment) => `${segment}/`).join('')}`;
}

/** `/404` — the error page's route, derived from the file the deploy looks for. */
const ERROR_ROUTE = `/${ERROR_PAGE.slice(0, -'.html'.length)}`;

/**
 * The route an output file is published as. `en/schedule/index.html` → `/en/schedule`.
 *
 * @param {string} rel
 * @returns {string}
 */
function routeOfOutput(rel) {
  if (rel === 'index.html') return '/';
  if (rel.endsWith('/index.html')) return `/${rel.slice(0, -'/index.html'.length)}`;
  return `/${rel.slice(0, -'.html'.length)}`;
}

/**
 * **Every page in a build, with the URL the host serves it at and the status it answers.**
 *
 * MUSE-55. `npm run a11y` ran over a route list in an environment variable, and that list
 * had never contained `/404` — so the one page no happy path links to, and every lost
 * visitor meets, was the one page the accessibility gate never audited. MUSE-38 turned it
 * into a bilingual page with two `<h1>`s, two `lang` blocks and two exits, audited it by
 * hand, and said plainly that it was not gated.
 *
 * It could not have been listed, either. Two things were wrong and both of them were
 * individually *correct*:
 *
 *   1. `site.url(route)` appends a trailing slash, because page URLs carry one (MUSE-9) —
 *      so `/404` became `/MuseByMina/404/`, which the host answers **404** for, since it
 *      is not a directory. The slash is not the bug and must not be "fixed".
 *   2. The gate asserted 200 for everything, hard-won after it reported "8/8 clean"
 *      against a stale server that was 404ing every route. Relaxing that to
 *      must-be-anything would give the 404 back its reach and give it up for every other
 *      page.
 *
 * So the spelling and the status are **carried with the page** instead of assumed, and
 * both come from `resolveRequest` — the one model of GitHub Pages in this repository
 * (`test/urls.test.ts` pins its every rule against the live deploy). The set is **read off
 * the output tree**, which is the half that keeps it from rotting: a page added to
 * `src/pages/` is audited the day it builds, with no list anywhere to extend. A list
 * extended by hand is the defect this repository has re-filed seven times.
 *
 * The error page is the one entry that is not simply "an HTML file at its own URL", and it
 * gets **one target per locale**:
 *
 *   /404     → /MuseByMina/404      200   extensionless resolution of 404.html
 *   /en/404  → /MuseByMina/en/404   404   nothing there; the deploy's error page answers
 *
 * That is not the same page twice for the sake of it. The page has **no locale in its
 * path** and is bilingual by construction (MUSE-38) — one document, both languages, no
 * client-side selection — so there is no single locale to pin it to, and pinning it to one
 * would audit a bilingual page as though it were monolingual. Auditing it once per locale
 * means both an `hr-HR` browser and an `en-US` browser are measured meeting it, which is
 * what the bilingual markup is *for*, and it is also what makes the expected-status
 * machinery live rather than theoretical: `/en/404` is a real recorded host behaviour
 * whose correct answer is not 200.
 *
 * @param {string} outDir
 * @param {string} base The deploy base, trailing slash included.
 * @param {object} [options]
 * @param {string[]} [options.locales] The site's locales, for the error page. Passed in
 *   rather than imported: the locales live in `src/lib/i18n.ts`, a `.mjs` script cannot
 *   import a `.ts` module, and `scripts/browser-checks.mjs` — which already mirrors them,
 *   pinned by `test/browserlocale.test.ts` — is the module that must not be imported from
 *   here, or it would drag Playwright into every caller of this one.
 * @param {string} [options.defaultLocale] The locale served without a path prefix.
 * @returns {AuditTarget[]}
 */
export function auditTargets(outDir, base, { locales = [], defaultLocale = '' } = {}) {
  /** @type {Map<string, AuditTarget>} */
  const byPath = new Map();

  /**
   * @param {string} route
   * @param {string} path
   * @param {string} [mustServe] The output file this target is a target *of*, when the
   *   caller knows: a derived URL that resolves to some other file is a derivation bug,
   *   and finding out by auditing the wrong page is how MUSE-48 happened.
   */
  const add = (route, path, mustServe) => {
    const served = resolveRequest(outDir, base, path);
    if (served.status === 301) {
      throw new Error(
        `${path} is a redirect, not a page — auditing it would audit the 301 ` +
          `(MUSE-9). ${route} was derived to the wrong spelling.`,
      );
    }
    if (served.file === undefined) {
      throw new Error(`Nothing in ${outDir} answers ${path}, derived for ${route}.`);
    }
    if (mustServe !== undefined && served.file !== mustServe) {
      throw new Error(
        `${path}, derived for ${mustServe}, is served ${served.file} by the host model.`,
      );
    }
    if (!byPath.has(path)) {
      byPath.set(path, { route, path, status: served.status, file: served.file });
    }
  };

  for (const rel of filesUnder(outDir)) {
    if (!rel.endsWith('.html')) continue;
    const route = routeOfOutput(rel);
    // A directory page is served at its slashed URL and 301s from the other spelling;
    // a bare `foo.html` is served extensionlessly at `/foo` and 404s at `/foo/`. One
    // place adds the slash, and it is still `pagePath`.
    const path = rel.endsWith('index.html')
      ? pagePath(base, route)
      : `${base}${route.slice(1)}`;
    add(route, path, rel);
  }

  // The error page, once per locale — see the note above.
  if (isFile(outDir, ERROR_PAGE)) {
    for (const locale of locales) {
      const route = locale === defaultLocale ? ERROR_ROUTE : `/${locale}${ERROR_ROUTE}`;
      add(route, `${base}${route.slice(1)}`, ERROR_PAGE);
    }
  }

  return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

/**
 * Serve `outDir` over HTTP on a port the kernel picks.
 *
 * `listen(0)` is the mechanism, not a detail: there is no port for a stranger's daemon to
 * already be on, and the server cannot outlive the process that started it the way the
 * orphaned `astro preview --json` daemons in MUSE-35's review did.
 *
 * @param {string} outDir
 * @param {string} base The deploy base, trailing slash included.
 * @returns {Promise<DistServer>}
 */
export async function serveDist(outDir, base) {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    // A static host does not accept a POST (MUSE-15); GitHub Pages answers 405 whatever
    // the path.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': MIME['.txt'] });
      res.end('405 Not Allowed');
      return;
    }

    const served = resolveRequest(outDir, base, path);
    if (served.status === 301) {
      res.writeHead(301, { location: served.location });
      res.end();
      return;
    }
    if (served.status === 404) {
      // The build's own error page where there is one, so a browser driven at an unknown
      // path meets the page the deploy would actually serve it (MUSE-38).
      res.writeHead(404, { 'content-type': MIME['.html'] });
      res.end(
        served.file === undefined
          ? '<!doctype html><title>404</title>not found'
          : readFileSync(join(outDir, served.file)),
      );
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[extensionOf(served.file)] ?? 'application/octet-stream',
    });
    res.end(readFileSync(join(outDir, served.file)));
  });

  await new Promise((done) => server.listen(0, '127.0.0.1', () => done(undefined)));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the static host did not bind to a TCP port');
  }

  return {
    origin: `http://127.0.0.1:${address.port}`,
    port: address.port,
    close: () =>
      new Promise((done) => {
        server.closeAllConnections?.();
        server.close(() => done(undefined));
      }),
  };
}

/** sha256 of some bytes, hex. */
const digest = (/** @type {Buffer | Uint8Array} */ bytes) =>
  createHash('sha256').update(bytes).digest('hex');

/** The first 12 characters of a digest, which is what a human compares. */
const shortDigest = (/** @type {Buffer | Uint8Array} */ bytes) => digest(bytes).slice(0, 12);

/**
 * The URL path one entry of a run's route list is measured at.
 *
 * A plain string is a page route and gets `pagePath`'s spelling, slash included — which is
 * what `npm run shots` and `npm run ux:schedule` pass. An `AuditTarget` carries its own
 * spelling, because the error page's is not a directory's (MUSE-55).
 *
 * @param {string} base
 * @param {string | AuditTarget} entry
 * @returns {string}
 */
function probePath(base, entry) {
  return typeof entry === 'string' ? pagePath(base, entry) : entry.path;
}

/**
 * Which URLs a run has to agree on with the server, for a set of routes.
 *
 * The pages themselves, because those are what the check measures and a difference in one
 * of them *is* the bug. Plus `llms.txt`, which publishes every page's description and so
 * moves when any page's words move — one extra fetch that widens the comparison beyond
 * the handful of routes a given invocation happens to list.
 *
 * @param {string} base
 * @param {string} outDir
 * @param {(string | AuditTarget)[]} routes
 * @returns {string[]}
 */
function probePaths(base, outDir, routes) {
  const paths = routes.map((entry) => probePath(base, entry));
  const index = `${base}llms.txt`;
  if (resolveRequest(outDir, base, index).status === 200) paths.push(index);
  return [...new Set(paths)];
}

/**
 * What to do about a mismatch. Non-obvious enough to be worth spelling out at the point
 * of failure: the daemon is not this process's child, nothing in the output points at it,
 * and the natural reading of "the audit failed" is that the page is broken.
 */
const MISMATCH_ADVICE = [
  'MUSE-52: `astro preview` daemonises here and silently reuses a daemon on another',
  'port, so a check pointed at one can audit a different worktree\'s build and report it',
  'clean. Either stop the stale daemon, or just unset ORIGIN — the check then serves',
  'dist itself on a port of its own and there is nothing to attach to. If this origin is',
  'deliberately not this build (the deployed site, say), set UNVERIFIED_ORIGIN=1 and the',
  'log will say the result is not pinned to a local build.',
].join('\n');

/**
 * Prove that the server at `origin` is serving the build in `outDir`.
 *
 * Resolves with what it compared; rejects naming the mismatch. Byte equality rather than
 * a heuristic, because every weaker question has already been asked here and answered
 * confidently about the wrong tree.
 *
 * @param {object} args
 * @param {string} args.origin
 * @param {string} args.base The deploy base, trailing slash included.
 * @param {string} args.outDir
 * @param {(string | AuditTarget)[]} args.routes
 * @returns {Promise<Verification>}
 */
export async function verifyServedBuild({ origin, base, outDir, routes }) {
  const build = fingerprint(outDir);
  const paths = probePaths(base, outDir, routes);
  /** @type {string[]} */
  const problems = [];

  for (const path of paths) {
    const url = `${origin}${path}`;
    const expected = resolveRequest(outDir, base, path);

    let response;
    try {
      response = await fetch(url, { redirect: 'manual' });
    } catch (cause) {
      throw new Error(
        `Could not reach ${url} — nothing is answering at ${origin}.\n` +
          `  ${cause instanceof Error ? cause.message : String(cause)}\n\n` +
          'Unset ORIGIN and the check serves dist itself, which cannot be unreachable.',
        { cause },
      );
    }

    // Nothing in the build answers this URL at all. A 301 lands here too: a redirect is
    // not a page, and a run that measured one would be measuring the hop.
    if (expected.file === undefined) {
      problems.push(
        [
          `  ${url}`,
          `    the server answered  ${response.status}`,
          '    this build has       nothing at that URL — the page is not in the build',
        ].join('\n'),
      );
      continue;
    }

    // The status the **host model** gives this URL, not a literal 200 (MUSE-55). The
    // error page is served at `…/404` with a 200 and at `…/en/404` with a 404, and both
    // of those are correct answers that a run has to be able to state. What is *not*
    // relaxed is the comparison: an answer other than the one this build says that URL
    // has is still a hard failure, which is the half MUSE-52 and its two predecessors
    // were each written to keep.
    if (response.status !== expected.status) {
      problems.push(
        [
          `  ${url}`,
          `    the server answered  ${response.status}`,
          `    this build has       ${expected.status}, ${expected.file}`,
        ].join('\n'),
      );
      continue;
    }

    const served = Buffer.from(await response.arrayBuffer());
    const mine = readFileSync(join(outDir, expected.file));
    if (!served.equals(mine)) {
      problems.push(
        [
          `  ${url}`,
          `    the server returned  sha256 ${shortDigest(served)}  ${served.byteLength} bytes`,
          `    this build has       sha256 ${shortDigest(mine)}  ${mine.byteLength} bytes  (${expected.file})`,
        ].join('\n'),
      );
    }
  }

  if (problems.length > 0) {
    throw new Error(
      [
        `The server at ${origin} is not serving the build under test.`,
        '',
        ...problems,
        '',
        `Build under test: ${build.hash}, ${build.files} files, ${outDir}`,
        '',
        MISMATCH_ADVICE,
      ].join('\n'),
    );
  }

  return { hash: build.hash, files: build.files, checked: paths };
}

/**
 * @param {string} outDir
 * @param {string} base
 */
function requireBuild(outDir, base) {
  if (resolveRequest(outDir, base, base).status !== 200) {
    throw new Error(
      `No build to check at ${outDir} — ${base}index.html is not there.\n` +
        'Run `npm run build` first.',
    );
  }
}

/**
 * Where `dist` is and what it is mounted under, for one invocation.
 *
 * Exported because MUSE-55 made the audit set a question about the output tree rather
 * than a list in the environment, and `auditTargets` needs to be told which tree — but it
 * is still this module that decides what `DIST` and `BASE` mean, so a check cannot come to
 * a different answer than the server it is about to measure.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ base: string, dist: string }}
 */
export function buildLocation(env = process.env) {
  const distArg = env.DIST ?? DEFAULT_DIST;
  return {
    base: `${(env.BASE ?? DEFAULT_BASE).replace(/\/+$/, '')}/`,
    dist: isAbsolute(distArg) ? distArg : resolve(ROOT, distArg),
  };
}

/**
 * @param {string} origin
 * @param {string} base
 * @param {() => Promise<void>} close
 * @returns {Site}
 */
function siteAt(origin, base, close = async () => {}) {
  return {
    origin,
    base,
    url: (route) => `${origin}${pagePath(base, route)}`,
    /**
     * This site, addressed at one exact URL path.
     *
     * The `RouteSource` `scripts/browser-checks.mjs` takes is a single `url(route)`
     * method on purpose — a check must not be able to reach past it to an origin and
     * join a URL itself, because joining the URL by hand is how MUSE-9's slash got lost.
     * `at` is how a check names a spelling that is not `pagePath`'s **without** opening
     * that door: the path still comes from this module, from `resolveRequest`'s model of
     * the host, and the route handed to `openCheckPage` alongside it still decides the
     * locale pin and the log line. The error page is the only thing that needs it
     * (MUSE-55), and `pagePath` is still the only place a trailing slash is added.
     *
     * @param {string} path
     */
    at: (path) => ({ url: () => `${origin}${path}` }),
    close,
  };
}

/**
 * Serve the local build, on a port of its own, and say which build it is.
 *
 * This is also `npm run preview`. It replaces `astro preview`, which is where the
 * orphaned daemons came from in the first place — MUSE-35's review found three of them
 * still listening, parented to pid 3158, from *manual* invocations — and which is not a
 * correct model of the host anyway: it answers both `/MuseByMina` and `/MuseByMina/` with
 * 200 and never redirects, so a trailing-slash regression is invisible to anyone checking
 * by hand (MUSE-9). `resolveRequest` above is the model `test/urls.test.ts` pins.
 *
 * @param {object} [args]
 * @param {Record<string, string | undefined>} [args.env]
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<Site>}
 */
export async function serveBuild({ env = process.env, log = console.log } = {}) {
  const { base, dist } = buildLocation(env);
  requireBuild(dist, base);
  const server = await serveDist(dist, base);
  const build = fingerprint(dist);
  log(`build   ${build.hash}  ${build.files} files  ${dist}`);
  log(`origin  ${server.origin}${base}  — served in-process from that build`);
  return siteAt(server.origin, base, server.close);
}

/**
 * Resolve the site a browser check is about to measure, and say in the log which build
 * it is.
 *
 * The single entry point for all three browser gates. They used to each read `ORIGIN`,
 * default it to `http://localhost:4321`, and join their own page URLs — three copies of
 * the trust that made this bug possible and three copies of MUSE-9's trailing slash.
 * `test/origin.test.ts` fails if any script in `scripts/` that drives a browser reads
 * `ORIGIN` or names a port again.
 *
 * @param {object} [args]
 * @param {(string | AuditTarget)[]} [args.routes] Every page this run will measure — a
 *   route string, or an `AuditTarget` carrying its own spelling and expected status. They
 *   are what gets compared against the server, so a page left out is a page nothing
 *   vouched for.
 * @param {Record<string, string | undefined>} [args.env]
 * @param {(line: string) => void} [args.log]
 * @returns {Promise<Site>}
 */
export async function openSite({ routes = [], env = process.env, log = console.log } = {}) {
  const { base, dist } = buildLocation(env);
  const given = env.ORIGIN?.replace(/\/+$/, '');

  if (given === undefined || given === '') return serveBuild({ env, log });

  if (env.UNVERIFIED_ORIGIN) {
    log(`origin  ${given}${base}  — NOT VERIFIED (UNVERIFIED_ORIGIN is set)`);
    log('        whatever this reports is about whichever build that server holds.');
    return siteAt(given, base);
  }

  requireBuild(dist, base);
  const checked = await verifyServedBuild({ origin: given, base, outDir: dist, routes });
  log(`build   ${checked.hash}  ${checked.files} files  ${dist}`);
  log(
    `origin  ${given}${base}  — verified byte-identical to that build on ` +
      `${checked.checked.length} URL(s)`,
  );
  return siteAt(given, base);
}

/**
 * `openSite`, as a command-line entry point: a mismatch is a report and exit 1, not a
 * stack trace.
 *
 * The three browser gates call this rather than `openSite` so that the message — which is
 * several paragraphs and the only place the fix is written down — is the first thing on
 * screen, in the same shape `scripts/check-sanity.mjs` and `scripts/check-tokens.mjs`
 * report in. The throwing version stays exported because that is the one with tests.
 *
 * @param {Parameters<typeof openSite>[0]} [args]
 * @returns {Promise<Site>}
 */
export async function openSiteOrExit(args) {
  try {
    return await openSite(args);
  } catch (problem) {
    console.error(`\n${problem instanceof Error ? problem.message : String(problem)}\n`);
    process.exit(1);
  }
}

/**
 * `auditTargets` over the build this invocation is about, as a command-line entry point.
 *
 * Paired with `openSiteOrExit` for the same reason it exists: a gate's first line of
 * output should be the report, not a stack trace. "There is no build here" is the common
 * case and `requireBuild`'s message is the one that says `npm run build`.
 *
 * @param {object} [args]
 * @param {Record<string, string | undefined>} [args.env]
 * @param {string[]} [args.locales]
 * @param {string} [args.defaultLocale]
 * @returns {AuditTarget[]}
 */
export function auditTargetsOrExit({ env = process.env, locales, defaultLocale } = {}) {
  try {
    const { base, dist } = buildLocation(env);
    requireBuild(dist, base);
    const targets = auditTargets(dist, base, { locales, defaultLocale });
    if (targets.length === 0) {
      // A gate that audits nothing reports success. This repository has shipped that
      // twice — "8/8 clean" against a 404ing server, and a guard looping over an empty
      // discovery — so an empty set is a failure here rather than a quiet pass.
      throw new Error(`No pages found in ${dist} to audit. That cannot be right.`);
    }
    return targets;
  } catch (problem) {
    console.error(`\n${problem instanceof Error ? problem.message : String(problem)}\n`);
    process.exit(1);
  }
}

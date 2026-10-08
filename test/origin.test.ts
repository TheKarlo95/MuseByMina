import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditTargets,
  fingerprint,
  openSite,
  resolveRequest,
  serveBuild,
  serveDist,
  verifyServedBuild,
  type AuditTarget,
  type DistServer,
} from '../scripts/dist-origin.mjs';
import { buildPreview, PREVIEW_BASE } from './helpers/preview';
import { claimOutDir } from './helpers/scratch';

/**
 * MUSE-52 — a browser check must answer about **its own** build.
 *
 * `astro preview` daemonises under this environment and **silently reuses a daemon on
 * another port** rather than failing or warning. So `npm run a11y`, which needed a server
 * and took whatever was at `ORIGIN`, bound to a preview belonging to a different agent's
 * worktree and reported every route clean in both themes — about somebody else's output.
 * That happened; the catch was a human being suspicious, which is not a mechanism.
 *
 * `scripts/a11y.mjs` had already been hardened twice for this class: it checks the HTTP
 * status (after reporting 8/8 clean against a stale 404-serving server) and checks for an
 * unexpected redirect (after auditing the wrong page twice). Both confirm *something*
 * answered. Neither confirms **which build** answered. This file is about that gap, and
 * the bar it has to clear is the ticket's: delete the fix, point a check at a server
 * serving a different build, and something must turn red.
 *
 * Two halves, because the acceptance criteria are two different claims:
 *
 *   1. **Retire the daemon.** With no `ORIGIN` the checks serve `dist` themselves from an
 *      in-process `node:http` server on an ephemeral port — the shape `test/helpers/`
 *      has used all along and the reason the suite was never exposed to this. There is
 *      nothing to attach to, so "never silently attach" is true by construction rather
 *      than detected.
 *   2. **Verify an explicit one.** `ORIGIN` is still how someone points a check at a real
 *      server — the deployed site, or a preview they started themselves — so when it is
 *      set, the bytes that server returns for every URL the run will measure are compared
 *      against the local build, and a difference is a loud failure naming both digests.
 *
 * Identity is **content**, never a stamp: the fingerprint is a hash of the output tree,
 * computed on the reader's side, so nothing is added to `dist` and MUSE-20's
 * byte-identical criterion is untouched. The last test in the first group pins that by
 * fingerprinting two independent builds of this commit and demanding they agree.
 *
 * The end-to-end proof — `node scripts/a11y.mjs` against a foreign server — cannot live
 * here: `test/isolation.test.ts` allows exactly one module in this tree to start a child
 * process, and the answer to a new need is never a second name on that list. So the
 * guards at the bottom assert instead that every browser script in `scripts/` goes
 * through this module and that CI starts no daemon, which is what makes the module's
 * tests speak for the scripts.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPTS = join(ROOT, 'scripts');

/** The routes the real `npm run a11y` audits by default. */
const ROUTES = ['/', '/en'];

/** A no-op logger, so a passing test does not print the identity banner. */
const quiet = () => {};

/** Everything `openSite` reads, with nothing inherited from the real environment. */
function env(overrides: Record<string, string> = {}): Record<string, string> {
  return { BASE: PREVIEW_BASE, ...overrides };
}

describe('a check serves its own build rather than attaching to a daemon', () => {
  let ours = '';
  /** The same tree with one page rewritten — "a different worktree's build". */
  let foreign = '';
  const servers: DistServer[] = [];

  beforeAll(async () => {
    ours = buildPreview('origin');

    foreign = claimOutDir('origin-foreign');
    cpSync(ours, foreign, { recursive: true });
    const index = join(foreign, 'index.html');
    writeFileSync(
      index,
      readFileSync(index, 'utf8').replace('</body>', '<p>another branch</p></body>'),
    );
  }, 240_000);

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  /** Serve `outDir` and register it for teardown. */
  async function serve(outDir: string): Promise<DistServer> {
    const server = await serveDist(outDir, `${PREVIEW_BASE}/`);
    servers.push(server);
    return server;
  }

  it('binds a port of its own on the loopback, never the preview default', async () => {
    const server = await serve(ours);
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    // 4321 is what `astro preview` takes and what the scripts used to assume. A check
    // that never names a fixed port cannot be handed a stranger's server on one.
    expect(server.port).not.toBe(4321);
    expect(server.port).toBeGreaterThan(0);
  });

  it('gives two concurrent runs two different servers', async () => {
    const [a, b] = [await serve(ours), await serve(foreign)];
    expect(a.port).not.toBe(b.port);

    // And each answers with its own tree — the whole point. Two agents auditing at once
    // is the normal case now, not an accident.
    const [one, two] = await Promise.all([
      fetch(`${a.origin}${PREVIEW_BASE}/`).then((r) => r.text()),
      fetch(`${b.origin}${PREVIEW_BASE}/`).then((r) => r.text()),
    ]);
    expect(one).not.toContain('another branch');
    expect(two).toContain('another branch');
  });

  it('resolves URLs the way the deploy does, slash included', async () => {
    const server = await serve(ours);
    const slashed = await fetch(`${server.origin}${PREVIEW_BASE}/en/`, {
      redirect: 'manual',
    });
    expect(slashed.status).toBe(200);
    // MUSE-9: the unslashed spelling is a redirect, and `astro preview` answering it 200
    // is exactly why it is not usable as a model of the host.
    const bare = await fetch(`${server.origin}${PREVIEW_BASE}/en`, { redirect: 'manual' });
    expect(bare.status).toBe(301);
    expect(bare.headers.get('location')).toBe(`${PREVIEW_BASE}/en/`);
  });

  it('serves a stylesheet as text/css, so the page the check measures is painted', async () => {
    const server = await serve(ours);
    const html = await fetch(`${server.origin}${PREVIEW_BASE}/`).then((r) => r.text());
    const href = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(html)?.[1];
    expect(href, 'the homepage links a stylesheet').toBeTruthy();
    const css = await fetch(`${server.origin}${href}`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toContain('text/css');
  });

  it('names the build it measured, by a hash of the output and not a stamp in it', async () => {
    const lines: string[] = [];
    const site = await openSite({
      routes: ROUTES,
      env: env({ DIST: ours }),
      log: (line: string) => lines.push(line),
    });
    servers.push({ origin: site.origin, port: 0, close: site.close });

    const printed = lines.join('\n');
    expect(printed).toContain(fingerprint(ours).hash);
    expect(printed).toContain(ours);
    // A reader has to be able to tell from the log, not by inference, that the audit was
    // against a server this process started over that tree.
    expect(printed).toContain(site.origin);
  });

  it('adds nothing to the build, so two builds of this commit still agree', () => {
    // The ticket weighs a build stamp and rejects a varying one: MUSE-20's criterion is
    // that two builds of one commit are byte-identical. Identity here is a hash the
    // *reader* computes, so there is nothing in `dist` to vary — and this is what says so.
    const second = buildPreview('origin');
    expect(fingerprint(second).hash).toBe(fingerprint(ours).hash);
    expect(fingerprint(second).files).toBe(fingerprint(ours).files);
    expect(fingerprint(foreign).hash).not.toBe(fingerprint(ours).hash);
  }, 240_000);

  it('fingerprints the content and not the path it happens to sit at', () => {
    const copy = claimOutDir('origin-copy');
    cpSync(ours, copy, { recursive: true });
    expect(fingerprint(copy).hash).toBe(fingerprint(ours).hash);
  });

  it('refuses to run at all when there is no build to serve', async () => {
    const empty = claimOutDir('origin-empty');
    await expect(
      openSite({ routes: ROUTES, env: env({ DIST: empty }), log: quiet }),
    ).rejects.toThrow(/npm run build/);
  });

  it('is also what `npm run preview` is now, so no daemon is left behind', async () => {
    // `scripts/preview.mjs` calls `serveBuild` directly. The orphaned
    // `astro.mjs preview --json` daemons MUSE-35's review found were started by hand, not
    // by a check — so retiring it only inside the gates would leave the supply intact.
    const lines: string[] = [];
    const site = await serveBuild({
      env: env({ DIST: ours }),
      log: (line: string) => lines.push(line),
    });
    servers.push({ origin: site.origin, port: 0, close: site.close });

    expect(site.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(site.base).toBe(`${PREVIEW_BASE}/`);
    expect(lines.join('\n')).toContain(fingerprint(ours).hash);

    const page = await fetch(`${site.origin}${site.base}`);
    expect(page.status).toBe(200);
    expect(await page.text()).not.toContain('another branch');
  });
});

describe('an explicit ORIGIN is checked against the local build', () => {
  let ours = '';
  let foreign = '';
  const servers: DistServer[] = [];

  beforeAll(async () => {
    ours = buildPreview('origin-verify');

    foreign = claimOutDir('origin-verify-foreign');
    cpSync(ours, foreign, { recursive: true });
    // One page differs, the rest is identical — the real shape of the incident. Two
    // worktrees on the same project are not two different websites.
    const index = join(foreign, 'index.html');
    writeFileSync(
      index,
      readFileSync(index, 'utf8').replace('</body>', '<p>another branch</p></body>'),
    );
    // And a route this build does not have at all: `/gallery/`, which is 404 here and
    // would have been 200 on the daemon that answered. It was `/aboutus/` until MUSE-60
    // routed that page — this has to be a path the build genuinely lacks, or the copy
    // below overwrites a real page and the assertion inverts.
    cpSync(join(foreign, 'en'), join(foreign, 'gallery'), { recursive: true });
  }, 240_000);

  afterAll(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });

  async function serve(outDir: string): Promise<DistServer> {
    const server = await serveDist(outDir, `${PREVIEW_BASE}/`);
    servers.push(server);
    return server;
  }

  it('passes when the server is serving the build under test', async () => {
    const server = await serve(ours);
    const report = await verifyServedBuild({
      origin: server.origin,
      base: `${PREVIEW_BASE}/`,
      outDir: ours,
      routes: ROUTES,
    });
    expect(report.checked.length).toBeGreaterThanOrEqual(ROUTES.length);
    expect(report.checked).toContain(`${PREVIEW_BASE}/`);
  });

  it('passes against a second, independent build of the same commit', async () => {
    // Identity is the build, not the directory. Two worktrees on the same commit are
    // serving the same site and auditing either is sound; a check that failed here would
    // be asserting something nobody asked for.
    const twin = buildPreview('origin-verify');
    const server = await serve(twin);
    await expect(
      verifyServedBuild({
        origin: server.origin,
        base: `${PREVIEW_BASE}/`,
        outDir: ours,
        routes: ROUTES,
      }),
    ).resolves.toBeTruthy();
  }, 240_000);

  it('fails naming the URL, both digests and the local build', async () => {
    const server = await serve(foreign);
    const error = await verifyServedBuild({
      origin: server.origin,
      base: `${PREVIEW_BASE}/`,
      outDir: ours,
      routes: ROUTES,
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );

    expect(error, 'a foreign build must not verify').toBeTruthy();
    const message = error!.message;
    // The mismatch, not just the fact of one. A failure that says "something is wrong"
    // is how this file got hardened twice without closing the hole.
    expect(message).toContain(`${server.origin}${PREVIEW_BASE}/`);
    expect(message).toContain(fingerprint(ours).hash);
    expect(message).toContain(ours);
    const served = readFileSync(join(foreign, 'index.html'));
    const mine = readFileSync(join(ours, 'index.html'));
    expect(message).toContain(digest(served).slice(0, 12));
    expect(message).toContain(digest(mine).slice(0, 12));
    // And it has to say what to do, because the fix is non-obvious: the daemon is not
    // this process's child and nothing in the output points at it.
    expect(message).toContain('MUSE-52');
  });

  it('fails when the server has a URL the build under test does not', async () => {
    const server = await serve(foreign);
    const error = await verifyServedBuild({
      origin: server.origin,
      base: `${PREVIEW_BASE}/`,
      outDir: ours,
      routes: ['/gallery'],
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeTruthy();
    expect(error!.message).toContain('/gallery/');
    // The local build has no such page, and saying so is the whole difference between
    // this and the status check that is already there.
    expect(error!.message).toMatch(/not in the build|404/);
  });

  it('fails when nothing is listening, rather than reporting clean', async () => {
    const dead = await serveDist(ours, `${PREVIEW_BASE}/`);
    const origin = dead.origin;
    await dead.close();
    await expect(
      verifyServedBuild({ origin, base: `${PREVIEW_BASE}/`, outDir: ours, routes: ROUTES }),
    ).rejects.toThrow(new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  it('refuses a foreign ORIGIN through openSite, which is what the gates wrap', async () => {
    const server = await serve(foreign);
    await expect(
      openSite({
        routes: ROUTES,
        env: env({ ORIGIN: server.origin, DIST: ours }),
        log: quiet,
      }),
    ).rejects.toThrow(/MUSE-52/);
  });

  it('lets a foreign ORIGIN through only when it is asked for, and says so out loud', async () => {
    // Pointing a check at the deployed site is legitimate and must stay possible. What
    // it must not be is the default, or silent: the log has to stop claiming the result
    // is about this build.
    const server = await serve(foreign);
    const lines: string[] = [];
    const site = await openSite({
      routes: ROUTES,
      env: env({ ORIGIN: server.origin, DIST: ours, UNVERIFIED_ORIGIN: '1' }),
      log: (line: string) => lines.push(line),
    });
    expect(site.origin).toBe(server.origin);
    const printed = lines.join('\n');
    expect(printed).toMatch(/not verified|unverified/i);
    expect(printed).not.toContain(fingerprint(ours).hash);
    await site.close();
  });

  it('builds the same URLs the checks measure, slash included', async () => {
    const server = await serve(ours);
    const site = await openSite({
      routes: ROUTES,
      env: env({ ORIGIN: server.origin, DIST: ours }),
      log: quiet,
    });
    expect(site.url('/')).toBe(`${server.origin}${PREVIEW_BASE}/`);
    expect(site.url('/en')).toBe(`${server.origin}${PREVIEW_BASE}/en/`);
    expect(site.url('/en/schedule')).toBe(`${server.origin}${PREVIEW_BASE}/en/schedule/`);
    await site.close();
  });
});

/**
 * MUSE-55 — what the accessibility gate audits is read off the build, not listed.
 *
 * `npm run a11y` ran over `ROUTES`: two homepages by default and a comma-separated list
 * in `ci.yml` whose own comment said "adding a page → add it". The error page was never
 * on it and **could not be**, for two reasons that were each individually correct —
 * `site.url('/404')` spells the slashed `/MuseByMina/404/`, which the host answers 404
 * for because it is not a directory (MUSE-9), and the gate asserted 200 for everything,
 * which it had been hardened into after reporting "8/8 clean" against a stale server that
 * was 404ing every route.
 *
 * So the page no happy path links to, that every lost visitor meets, and that MUSE-38 had
 * just turned into a bilingual page with two `<h1>`s and two exits, was the one page the
 * gate never looked at. Its author audited it by hand and said so.
 *
 * Both halves are fixed here rather than one: the **set** comes off the output tree, and
 * each page carries the **spelling** and the **status** the host model gives it. The bar
 * the tests below have to clear is the ticket's — add a page to the build and it is
 * audited with nothing edited; serve a page at an unexpected status and the run still
 * fails loudly.
 */
describe('the audited set is derived from the build', () => {
  let outDir = '';
  const base = `${PREVIEW_BASE}/`;
  /** The site's own locales. Spelled out, not imported from `src/lib/i18n.ts`: a copy
   * here would be a second list, and `test/browserlocale.test.ts` already pins the one
   * the gate passes in against that module. */
  const LOCALES = ['hr', 'en'];
  let targets: AuditTarget[] = [];

  beforeAll(() => {
    outDir = buildPreview('origin-targets');
    targets = auditTargets(outDir, base, { locales: LOCALES, defaultLocale: 'hr' });
  }, 240_000);

  /** Every `.html` file in a build, as `/`-separated paths relative to it. */
  function htmlFiles(dir: string): string[] {
    const walk = (prefix: string): string[] =>
      readdirSync(join(dir, prefix), { withFileTypes: true }).flatMap((entry) => {
        const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        return entry.isDirectory() ? walk(rel) : [rel];
      });
    return walk('').filter((rel) => rel.endsWith('.html')).sort();
  }

  it('audits every page the build contains, the error page included', () => {
    // The first acceptance criterion, and the one that cannot be satisfied by a list:
    // what gets audited is exactly what got built. `/contact` was absent from the gate
    // for the life of MUSE-18 — axe had never seen the trial form's `<select>` — and
    // nothing but this says it cannot go absent again.
    const files = htmlFiles(outDir);
    expect(files).toContain('404.html');
    expect(files.length).toBeGreaterThan(5);
    expect([...new Set(targets.map((t) => t.file))].sort()).toEqual(files);
  });

  it('requests the error page unslashed, which is the only spelling that reaches it', () => {
    // Not a workaround for the trailing slash — a fact about GitHub Pages, recorded off
    // the live deploy and pinned in `test/urls.test.ts`: `/MuseByMina/404` resolves
    // extensionlessly to `404.html`, and `/MuseByMina/404/` does not, because it is not
    // a directory. The slash rule is right and is untouched; what moved is that the
    // spelling travels with the page instead of being assumed.
    const paths = targets.map((t) => t.path);
    expect(paths).toContain(`${base}404`);
    expect(paths).not.toContain(`${base}404/`);
  });

  it('audits the bilingual error page once per locale, each at its own status', () => {
    // The error page has no locale in its path and is bilingual by construction
    // (MUSE-38), so there is no one locale to pin it to. Both are audited, each at the
    // URL a visitor of that language actually arrives at — and `/en/404` is the live
    // instance of "a page whose correct response is not 200", without which the
    // expected-status machinery would be theory.
    const error = targets.filter((t) => t.file === '404.html');
    expect(error.map((t) => [t.route, t.path, t.status])).toEqual([
      ['/404', `${base}404`, 200],
      ['/en/404', `${base}en/404`, 404],
    ]);
  });

  it('takes each status from the host model rather than expecting 200', () => {
    // The assertion that must not be weakened into must-be-anything: every target states
    // a status, and it is the one `resolveRequest` gives that URL.
    expect(targets.every((t) => t.status === 200 || t.status === 404)).toBe(true);
    expect(targets.filter((t) => t.status !== 200)).toHaveLength(1);
    for (const target of targets) {
      expect(resolveRequest(outDir, base, target.path), target.path).toEqual(
        target.status === 200
          ? { status: 200, file: target.file }
          : { status: target.status, file: target.file },
      );
    }
  });

  it('spells a directory page with its slash and nothing else', () => {
    const byRoute = new Map(targets.map((t) => [t.route, t.path]));
    expect(byRoute.get('/')).toBe(base);
    expect(byRoute.get('/en')).toBe(`${base}en/`);
    expect(byRoute.get('/en/schedule')).toBe(`${base}en/schedule/`);
    // And a route string is still what the locale pin and the log are built from
    // (MUSE-48), so every target has to carry one.
    expect(targets.every((t) => t.route.startsWith('/'))).toBe(true);
  });

  it('audits a page added to the build with no list edited', () => {
    // The third acceptance criterion. A page under `src/pages/` becomes a directory with
    // an `index.html` in the output, so this adds one to a copy of the tree rather than
    // building a throwaway route — the derivation is about the output, and a build is the
    // one thing a suite here may not start for itself.
    const grown = claimOutDir('origin-targets-grown');
    cpSync(outDir, grown, { recursive: true });
    mkdirSync(join(grown, 'newpage'), { recursive: true });
    writeFileSync(
      join(grown, 'newpage/index.html'),
      '<!doctype html><html lang="hr"><title>new</title><body><h1>new</h1></body></html>',
    );

    const after = auditTargets(grown, base, { locales: LOCALES, defaultLocale: 'hr' });
    expect(after.map((t) => t.route)).toContain('/newpage');
    expect(after.find((t) => t.route === '/newpage')?.path).toBe(`${base}newpage/`);
    expect(after).toHaveLength(targets.length + 1);
  });

  it('refuses to derive a target for a URL nothing in the build answers', () => {
    // The derivation's own failure mode: a spelling that resolves to a redirect or to
    // nothing would be audited as a 301 hop or as a stub, which is how this class of bug
    // stays invisible. An empty tree has no `404.html` either, so nothing can stand in.
    const empty = claimOutDir('origin-targets-empty');
    expect(auditTargets(empty, base, { locales: LOCALES, defaultLocale: 'hr' })).toEqual([]);
  });

  it('still compares the served bytes for a page whose status is not 200', async () => {
    const server = await serveDist(outDir, base);
    try {
      const report = await verifyServedBuild({
        origin: server.origin,
        base,
        outDir,
        routes: targets,
      });
      // MUSE-52's guarantee is untouched by the status flexibility: the error page's URL
      // is in the compared set, so a server holding a different 404 fails before a
      // browser is opened.
      expect(report.checked).toContain(`${base}en/404`);
      expect(report.checked).toContain(`${base}404`);
    } finally {
      await server.close();
    }
  });

  it('fails loudly when a page answers a status this build does not give it', async () => {
    // The second acceptance criterion's other half. A tree with no error page answers
    // 404-with-no-body where this build answers 200 with `404.html` — the same shape as
    // the stale server that once reported "8/8 clean", and it must still be a hard
    // failure now that 404 is a legitimate expectation elsewhere in the set.
    const noErrorPage = claimOutDir('origin-targets-no-404');
    cpSync(outDir, noErrorPage, {
      recursive: true,
      // A filter, not a deletion: nothing under `test/` may delete anything (MUSE-34).
      filter: (from) => relative(outDir, from) !== '404.html',
    });
    expect(statSync(join(noErrorPage, 'index.html')).isFile()).toBe(true);

    const server = await serveDist(noErrorPage, base);
    try {
      const error = await verifyServedBuild({
        origin: server.origin,
        base,
        outDir,
        routes: targets,
      }).then(
        () => null,
        (e: unknown) => e as Error,
      );
      expect(error, 'a server missing the error page must not verify').toBeTruthy();
      expect(error!.message).toContain(`${base}404`);
      // Naming both sides, not just the fact of a mismatch.
      expect(error!.message).toContain('404.html');
      expect(error!.message).toContain('MUSE-52');
    } finally {
      await server.close();
    }
  });
});

/**
 * The guards. The module above is only worth its tests if the scripts actually use it,
 * and if nothing puts the daemon back.
 */
describe('nothing can go back to trusting whatever is at ORIGIN', () => {
  /**
   * Every script that drives a browser, read off the directory rather than listed — so a
   * fourth gate is covered by the two guards below the moment it is written, with nobody
   * having to know they exist.
   *
   * A gate is recognised by importing `scripts/browser-checks.mjs`, which is the only way
   * to open a page here since MUSE-48: that module owns Playwright, and `scripts/` no
   * longer imports it at all, so "imports playwright" — what this used to look for — now
   * matches the module and none of its callers. `test/browserlocale.test.ts` asserts the
   * same set from the other side, and that Playwright stays out of these scripts, which is
   * what keeps the two discoveries describing the same files.
   *
   * Matched as an **import**, not as a mention — the same correction
   * `test/browserlocale.test.ts` already carries, for the same reason and in the other
   * direction. This read `includes('browser-checks.mjs')`, so a prose reference to that
   * module anywhere under `scripts/` enrolled the file as a browser gate; MUSE-55 put one
   * in `scripts/dist-origin.mjs` (explaining why it may *not* import it) and the guards
   * below promptly failed on the module that resolves `ORIGIN` for everybody. A discovery
   * that reads words rather than syntax is the shape MUSE-34 replaced wholesale.
   */
  function browserScripts(): string[] {
    const imports = /from ['"][^'"]*browser-checks\.mjs['"]/;
    return readdirSync(SCRIPTS)
      .filter((f) => f.endsWith('.mjs') && f !== 'browser-checks.mjs')
      .filter((f) => imports.test(readFileSync(join(SCRIPTS, f), 'utf8')))
      .sort();
  }

  it('finds the browser gates at all', () => {
    // The guards below are `for` loops over this list. A filter that silently stops
    // matching does not fail them — it makes them pass over nothing, which is precisely
    // the shape of "a check that confirms the wrong thing" this ticket is the third
    // instance of. So the discovery is asserted before anything is asserted with it.
    expect(browserScripts()).toEqual([
      'a11y.mjs',
      // MUSE-63's performance budget. `npm run budget` serves `dist` over an ephemeral
      // port like the other three, so the guards below apply to it unchanged.
      'budget.mjs',
      'schedule-ux.mjs',
      'screenshot-themes.mjs',
    ]);
  });

  it('routes every one of them through this module', () => {
    for (const script of browserScripts()) {
      const source = readFileSync(join(SCRIPTS, script), 'utf8');
      expect(source, script).toContain('dist-origin.mjs');
      // The exiting wrapper, so a mismatch is the several-paragraph report and not a
      // stack trace with the explanation somewhere above it.
      expect(source, script).toContain('openSiteOrExit');
    }
  });

  it('lets none of them read ORIGIN or name a port for itself', () => {
    for (const script of browserScripts()) {
      const source = readFileSync(join(SCRIPTS, script), 'utf8');
      // Reading the variable directly is how the trust got in. One module resolves it,
      // verifies it, and reports what it measured.
      expect(source, script).not.toContain(`process.env.${'ORIGIN'}`);
      // A fixed port is the thing a stranger's daemon can be sitting on. The default is
      // an ephemeral port over this build, and there is no port to guess.
      expect(source, script).not.toContain('4321');
    }
  });

  it('starts no preview daemon in CI either', () => {
    // CI has no stale daemons, so the daemon there was never wrong — but leaving it in
    // means the audited origin is a daemon again, and the next hardening of this file
    // starts from a worse place than it has to.
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const a11y = ci.slice(ci.indexOf('\n  a11y:'));
    const job = a11y.slice(0, a11y.indexOf('\n  sanity:'));
    // Comments stripped, so the step that explains why there is no daemon does not read
    // as one. What the job *runs* is the claim.
    const commands = job
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(commands).toContain('npm run a11y');
    expect(commands).not.toContain('astro preview');
    expect(commands).not.toContain('wait-on');
  });

  it('hands the audit no route list in CI either (MUSE-55)', () => {
    // The list that used to live in this job said "adding a page → add it", and the page
    // it never contained was the error page — which could not be reached at the spelling
    // a route list produces. The audited set is read off `dist` now, so a list here would
    // be a *narrowing* of it: eight routes named by hand, silently replacing ten derived
    // from the build. Comments stripped, so the step that explains why there is no list
    // does not read as one.
    const ci = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const a11y = ci.slice(ci.indexOf('\n  a11y:'));
    const job = a11y.slice(0, a11y.indexOf('\n  sanity:'));
    const commands = job
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');
    expect(commands).not.toContain(`${'ROU'}TES`);
  });

  it('lets the audit take its set from the build and from nowhere else', () => {
    // The gate's own half of the rule above. A route list read from the environment is a
    // list wherever it is written down, and one that *defaults* to two homepages is worse
    // than one that is wrong — `npm run a11y` reported "all pages clean" locally while
    // auditing two of nine for the life of this script.
    const source = readFileSync(join(SCRIPTS, 'a11y.mjs'), 'utf8');
    expect(source).toContain('auditTargets');
    expect(source).not.toContain(`process.env.${'ROUTES'}`);
    expect(source).not.toContain(`process.env.${'ROUTE'}`);
  });

  it('leaves no way to start a preview daemon by hand either', () => {
    // The stale daemons that caused this were started by `npm run preview`, not by a
    // check. Retiring `astro preview` from the gates and leaving the command that
    // produces it would fix the symptom and keep the supply.
    const scripts = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts as
      | Record<string, string>
      | undefined;
    expect(scripts?.preview).toBe('node scripts/preview.mjs');
    for (const [name, command] of Object.entries(scripts ?? {})) {
      expect(command, name).not.toContain('astro preview');
    }
    // And it must not name a port, for the same reason the gates must not.
    expect(readFileSync(join(SCRIPTS, 'preview.mjs'), 'utf8')).not.toContain('4321');
  });

  it('keeps one model of the static host, shared with the suite', () => {
    // `test/helpers/serve.ts` and `test/helpers/preview.ts` serve `dist` to a browser
    // too. Two resolvers would drift, and the lenient one would be the one that stopped
    // noticing a trailing-slash regression (MUSE-9).
    const helper = readFileSync(join(ROOT, 'test/helpers/serve.ts'), 'utf8');
    expect(helper).toContain('dist-origin.mjs');
    expect(helper).not.toMatch(/^export function resolveRequest/m);
  });
});

/**
 * sha256 of a buffer, hex.
 *
 * Spelled out here rather than imported from the module under test: the point of the
 * mismatch assertions is that the message carries the digest of what each side actually
 * holds, and borrowing the module's own hash would let a wrong one agree with itself.
 */
function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

import { createHash } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  fingerprint,
  openSite,
  serveBuild,
  serveDist,
  verifyServedBuild,
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
    // And a route this build does not have at all: MUSE-23's `/aboutus/`, which was 404
    // here and 200 on the daemon that answered.
    cpSync(join(foreign, 'en'), join(foreign, 'aboutus'), { recursive: true });
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
      routes: ['/aboutus'],
    }).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(error).toBeTruthy();
    expect(error!.message).toContain('/aboutus/');
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
 * The guards. The module above is only worth its tests if the scripts actually use it,
 * and if nothing puts the daemon back.
 */
describe('nothing can go back to trusting whatever is at ORIGIN', () => {
  /** Every script that drives a browser, read off the directory rather than listed. */
  function browserScripts(): string[] {
    return readdirSync(SCRIPTS)
      .filter((f) => f.endsWith('.mjs'))
      .filter((f) => readFileSync(join(SCRIPTS, f), 'utf8').includes("from 'playwright'"))
      .sort();
  }

  it('finds the three browser gates', () => {
    // If a fourth appears, it is covered by the two tests below without anyone adding it
    // to a list — which is the only version of this that survives.
    expect(browserScripts()).toEqual(['a11y.mjs', 'schedule-ux.mjs', 'screenshot-themes.mjs']);
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

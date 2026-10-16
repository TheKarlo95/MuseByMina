import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The read path's own report of where it reads from. Imported from the index, which is
// the only module anything outside `src/lib/sanity/` may import (`test/sanity.test.ts`).
import { contentEndpoint, endpointNote, source } from '../src/lib/sanity';
// The scripts' spelling of the same host, so the two can be compared rather than trusted.
import { API_HOST, queryUrl, target } from '../scripts/seed-compare.mjs';

/**
 * MUSE-81 — **the build reads the host it was meant to read, and says which one.**
 *
 * ## What this suite can prove, and what it cannot
 *
 * The defect was a *stale* read: the cached read host is eventually consistent, so a build
 * that starts inside the refresh window after a publish gets the previous revision, every
 * check stays green, and the deploy publishes content one revision behind. Observed on
 * 9 October: an import at 10:12 verified in the dataset, a rebuild at 10:13 reporting
 * success, the old description still live at 10:14, and a second rebuild at 10:18 — no
 * other change — correct.
 *
 * **Nothing here reproduces that, and nothing here could.** Reproducing it needs a write
 * to the dataset, and there is no content-write token in this project on purpose
 * (MUSE-21 declined a GitHub PAT inside Sanity; MUSE-45 kept content away from
 * `SANITY_DEPLOY_TOKEN`), nor may this suite touch the network at all — it reads
 * `content/seed.ndjson` through `groq-js`.
 *
 * **So be exact about which of MUSE-81's criteria has been verified and how** (MUSE-90).
 * The one about the *endpoint* — which host a build talks to — was established by hand,
 * against the live dataset, by the falsification recorded below, and the one about the
 * *log* is asserted here as a function and, since MUSE-90, off a real build's log in
 * `test/content.test.ts`. The first — **publish, then build immediately, and read the
 * published value — has never been verified by anybody.** It needs a write to the
 * dataset; no agent may make one and this project holds no token that could. That the
 * uncached host answers with the dataset as of the moment it is asked is Sanity's
 * documented behaviour, taken on trust here and not a measurement anybody took. Nothing
 * in this repository should be read as evidence for it.
 *
 * What is left for a test is the half that is *ours*, and it is the half that was wrong:
 * **which host the build talks to**. That is a property of this repository, it is
 * checkable offline, and it is what a future edit would get wrong. Split in two:
 *
 *   1. The configuration resolves to the uncached host — asserted through the client's
 *      own `getUrl()`, the same function the request path calls, rather than by restating
 *      the rule that turns `useCdn` into a hostname.
 *   2. Nothing else in the read surface reaches for the cached host, and the one URL
 *      builder the scripts share agrees with the client about where the dataset is.
 *
 * The *consistency* of the two hosts is Sanity's property, not ours, and is not something
 * a test in this repository can establish. It is documented, it was measured during
 * MUSE-20 (about a minute of lag), and it was observed again above.
 *
 * ## The proof that was run by hand, and what it is worth
 *
 * Asserting the configured flag proves what this repository *says*. What the build *does*
 * was established separately, by a real `astro build` against the live dataset with
 * `dns.lookup` patched from `--import` — at the resolver rather than at `fetch`, because
 * `@sanity/client`'s Node entry uses get-it's undici-backed fetch and a patch on
 * `globalThis.fetch` sees Astro's telemetry and nothing else. Two runs, differing only in
 * `useCdn`, with the **cached host made unresolvable** in both:
 *
 *     useCdn: true    6 lookups, all of the cached host; build fails, SanityUnavailableError
 *     useCdn: false   1 lookup, the uncached host; build succeeds, Complete!
 *
 * A falsification rather than an observation: with the flag as `main` had it, removing the
 * cached host removes the build's only route to the content, which is what "the build read
 * the CDN" means operationally. With the flag as it is here, the same removal changes
 * nothing.
 *
 * **What that does not prove.** It establishes the endpoint, not the staleness window. The
 * failing sequence was *write, then immediately build*, and reproducing it needs a write to
 * the dataset — so the closing of the window rests on the uncached host being strongly
 * consistent, which is Sanity's documented behaviour and not a measurement taken here. The
 * honest statement of the fix is therefore: the build no longer reads the host that is
 * allowed to be behind. Nobody should read these assertions as more than that.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* ------------------------------------------------------- 1. the configured endpoint */

describe('the build reads the uncached host', () => {
  it('is configured not to use the cached one', () => {
    /**
     * The run-time half of a pin that is also a compile-time one: `SanitySource.useCdn`
     * is the literal type `false`, so `CLIENT_CONFIG` cannot say otherwise without
     * `astro check` — which `npm run build` runs — refusing to build. Both halves are
     * needed for the reason `perspective` needs both: the value is unobservable from any
     * offline build, so a flipped flag ships green, and a type alone is deleted in the
     * same edit that flips it.
     */
    expect(source().useCdn).toBe(false);
  });

  it('resolves to a host the client itself names, not one this test spells', () => {
    /**
     * `contentEndpoint()` asks `client.getUrl(path, useCdn)` — the function the request
     * path calls, with the `canUseCdn` the request path passes for a data query. So this
     * is the URL a query is actually fetched from, and it would catch an `apiHost` or
     * `useProjectHostname` mistake as readily as a flipped `useCdn`.
     */
    const { projectId, dataset, apiVersion } = source();
    const endpoint = contentEndpoint();

    expect(endpoint.cached).toBe(false);
    expect(endpoint.url).toBe(
      `https://${projectId}.${API_HOST}/v${apiVersion}/data/query/${dataset}`,
    );
  });

  it('asks for the same perspective the build asks for', () => {
    /**
     * **A second thing the two readers have to agree about, and did not** (MUSE-90).
     *
     * `CLIENT_CONFIG` sets `perspective: 'published'`, and the HTTP API's default with no
     * `perspective` parameter is the **raw** one — drafts included. So `queryUrl` sent
     * the `.mjs` readers at a different view of the dataset from the build's, which is
     * invisible while no draft exists and wrong in the two places it would show:
     * `npm run sanity:read` could report `OK` for a query the build answers as `EMPTY`,
     * the single distinction that script exists to draw, and `npm run sanity:seed:check`
     * would list a `drafts.`-prefixed document as something the seed has not got.
     *
     * The parameter is honoured rather than ignored, which is worth knowing because an
     * ignored one would make this assertion decorative: the API answers an unknown
     * perspective with HTTP 400 `validationError`, measured against the live dataset on
     * 2026-10-16. The dataset held no `drafts.` document that day — `count(*[_id in
     * path("drafts.**")])` was 0 — so this closes a hole rather than fixing a symptom.
     */
    const asked = new URL(queryUrl('*[_id == "siteSettings"]')).searchParams;
    expect(asked.get('perspective')).toBe(source().perspective);
  });

  it('reads the same dataset the scripts compare against', () => {
    // Two spellings of one address is the MUSE-9 shape, and a `.mjs` script cannot import
    // a `.ts` module, so the agreement has to be asserted rather than arranged.
    const fromScripts = new URL(queryUrl('*[_id == "siteSettings"]'));
    const fromClient = new URL(contentEndpoint().url);

    expect(fromScripts.host).toBe(fromClient.host);
    expect(fromScripts.pathname.startsWith(fromClient.pathname)).toBe(true);
    expect(target()).toMatchObject({
      projectId: source().projectId,
      dataset: source().dataset,
      apiVersion: source().apiVersion,
    });
  });
});

/* ------------------------------------------------------------- 2. what the log says */

describe('the build log names the endpoint', () => {
  /**
   * **These two are the function, not the log** (MUSE-90). `endpointNote` is pure and
   * `contentEndpoint()` is a value, so both can be asserted here with no build — and for
   * the life of MUSE-81 that was all anything asserted: QA deleted the line from
   * `announce` in `src/lib/sanity/client.ts` and the entire run stayed green.
   *
   * That the *build* prints it is asserted in `test/content.test.ts`, off the log of the
   * one build in the suite given no fixture, because that is the only build whose banner
   * can carry this clause. It is not re-asserted here: a build of this suite's own would
   * be an eleventh heavyweight operation, and `DECLARED` in
   * `test/helpers/concurrency.ts` has no headroom.
   */
  it('names the host and says the content is current', () => {
    const note = endpointNote(contentEndpoint());
    expect(note).toContain(`${source().projectId}.${API_HOST}`);
    expect(note).toContain('uncached');
    expect(note).not.toContain('CACHED');
  });

  it('says the other regime is a staleness risk, in the one case nothing can produce', () => {
    /**
     * `endpointNote` takes the endpoint rather than reading it precisely so this case is
     * assertable: a warning that can only be produced by configuring the thing it warns
     * about is a warning nothing checks. If somebody does revive the cached host, the one
     * line in the deploy log that anybody reads says what it means for that build.
     */
    const note = endpointNote({
      url: 'https://q6fk9usq.apicdn.sanity.io/v2024-10-01/data/query/production',
      cached: true,
    });
    expect(note).toContain('apicdn.sanity.io');
    expect(note).toContain('CACHED');
    expect(note).toContain('MUSE-81');
  });
});

/* ------------------------------------------------- 3. nothing else reaches for the CDN */

/** Every file under a directory, recursively, as repository-relative paths. */
function filesUnder(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

describe('the cached read host is named nowhere in the read surface', () => {
  /**
   * **A textual scan, with no exemptions, prose included** — the stance `test/seo.test.ts`
   * takes about the deploy host, and for the same reason: there is no legitimate use for
   * the cached hostname in this repository, so a sentence containing it is as much a
   * failure as a `fetch` to it. A host in a comment reaches no request and is still how
   * the next copy of this bug gets written.
   *
   * It is a scan rather than a syntax rule (MUSE-34's preference) only because the needle
   * is a *hostname*: it can appear in a string, a template literal, a URL in a comment or
   * a line of Markdown, and the rule is the same in all four. The usual objection — prose
   * tripping a guard — is answered by the needle being the fully-qualified name. The
   * argument in `src/lib/sanity/client.ts` discusses the cached host at length and says
   * „the cached host", which is also the wording to use if you need to discuss it.
   *
   * `test/` is deliberately outside the scan: the case above has to spell the hostname to
   * assert the warning, and `test/nojs.test.ts` keeps it as a marker string that must not
   * reach `dist`.
   *
   * **What this scan cannot see is a second client** (MUSE-90), because a client is given
   * the host as a *boolean* and derives the name itself — so `useCdn: true` in a file that
   * never spells the hostname passes everything here. That rule is the one-client rule,
   * it lives in `test/sanity.test.ts`, and MUSE-90 widened it from `src/` to the scripts
   * and the root configuration a build loads. It is not duplicated here: two guards for
   * one rule is the shape MUSE-9 is about.
   */
  const CACHED_HOST = 'apicdn.sanity.io';

  it('appears in no file under src/ or scripts/', () => {
    const offences: string[] = [];
    const scanned = [...filesUnder('src'), ...filesUnder('scripts')];

    for (const file of scanned) {
      // Read everything, with no extension list to keep exhaustive — a font or an image
      // decoded as text simply cannot contain the needle, and a skip list is how a scan
      // acquires a blind spot (MUSE-42).
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (line.includes(CACHED_HOST)) offences.push(`${file}:${index + 1}`);
      });
    }

    expect(scanned.length).toBeGreaterThan(40);
    expect(
      offences,
      `the eventually-consistent read host is named at ${offences.join(', ')}. A build or ` +
        `a check that reads it can publish content one revision behind with every gate ` +
        `green (MUSE-81). Read the dataset through \`queryUrl\` in ` +
        `\`scripts/seed-compare.mjs\`, or through \`src/lib/sanity\`; to discuss the host ` +
        `in prose, call it "the cached host".`,
    ).toEqual([]);
  });

  it('is not what `scripts/sanity-read-check.mjs` reports against', () => {
    /**
     * The regression the scan above is calibrated on. `npm run sanity:read` used to build
     * its own URL against the cached host, and its whole purpose is to tell EMPTY — a
     * legitimate answer from an empty dataset — apart from a broken query. Run just after
     * `npm run sanity:seed` it could report EMPTY for documents that were in the dataset,
     * which is the one verdict it must never get wrong, and MUSE-78 now gates merges on a
     * comparison in the same neighbourhood.
     */
    const read = readFileSync(join(ROOT, 'scripts/sanity-read-check.mjs'), 'utf8');
    expect(read).toContain('queryUrl');
    const own = readFileSync(join(ROOT, 'scripts/seed-compare.mjs'), 'utf8');
    expect(own).toContain(`export const API_HOST`);
  });

  it('walks into subdirectories, which is what makes the count above meaningful', () => {
    // A `filesUnder` that stopped at the top level would scan four files, find nothing,
    // and pass — so the depth is asserted rather than assumed.
    const scanned = filesUnder('src');
    expect(scanned).toContain('src/lib/sanity/client.ts');
    expect(scanned).toContain('src/styles/fonts.css');
  });
});

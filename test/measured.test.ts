import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { experimental_AstroContainer as AstroContainer } from 'astro/container';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { localeUrl } from '../src/lib/i18n';
import NotFoundPage from '../src/pages/404.astro';
import EnglishSchedulePage from '../src/pages/en/schedule.astro';
import SchedulePage from '../src/pages/schedule.astro';

import { PAGES_DEPLOY } from './helpers/build';
import {
  assertMeasuredPage,
  canonicalOf,
  fetchMeasuredPage,
  NO_CANONICAL_ADVICE,
} from './helpers/measured';

/**
 * **The rule `test/helpers/measured.ts` states, tested as a rule — MUSE-112.**
 *
 * MUSE-62 is fixed by one comparison: every page a dev server serves is read through
 * `fetchMeasuredPage`, which holds the response's `<link rel="canonical">` against the
 * path that was asked for, and `404.astro` deliberately declares none — so the error page
 * cannot pass for a real one. **Nothing asserted that it throws.** The only references
 * under `test/` were call sites, plus one synthetic source string in
 * `test/isolation.test.ts` that belongs to `unmeasuredDevServers`'s own test. So the guard
 * *around* the rule had tests and the rule did not, which is the shape this board keeps
 * re-filing: MUSE-60's empty registry, MUSE-76's renamed field, MUSE-98's unguarded rule
 * set.
 *
 * Post-merge QA demonstrated the cost. Patching one branch to the natural tidy-up —
 * *"the 404 declares no canonical, so there is nothing to compare"*:
 *
 * ```ts
 * if (canonical === undefined) return { requested, canonical: requested, html };
 * ```
 *
 * made `fetchMeasuredPage` **accept the error page**, including at MUSE-47's corrupted
 * base.
 *
 * **One correction to that reading, found while writing this and worth keeping.** The
 * weakening is not invisible: `test/budget.test.ts`'s `bothAgree` runs
 * `assertMeasuredPage` and `scripts/budget.mjs`'s `assertDocumentIsItself` over the same
 * document and requires them to agree, so weakening one of the two goes red there. Two
 * things that does not cover, which is why this file is still the pin:
 *
 *   - **The assertion is anchored on `assertMeasuredPage`'s own answer**
 *     (`.toEqual([first === null, first === null])`), so it states that the two copies
 *     agree and never that either refuses. Weaken both — the tidy-up applied to "both
 *     copies of this check", which is how a duplicated rule is usually edited — and it
 *     passes. The only absolute claim there is made about `budget.mjs`'s message.
 *   - **It costs three heavyweight operations** (two builds and a browser) and reports as
 *     *"measured.ts and budget.mjs disagree"*, which names a symptom rather than the rule.
 *     The tests below cost none and name the rule.
 *
 * Two reasons that edit is worse than it reads, and both are why this file exists:
 *
 *   1. **`assertMeasuredPage` checks no status at all.** The status check lives in
 *      `fetchMeasuredPage`, so on the browser-DOM path — `test/fonts.test.ts` and
 *      `test/budget.test.ts`, where there is no response object to read — the canonical is
 *      the whole of the defence.
 *   2. **On a served `dist` the error page answers 200.** `resolveRequest` in
 *      `scripts/dist-origin.mjs` returns `404.html` as the body under a 200 at
 *      `/MuseByMina/404`, a host behaviour read off the live deploy and depended on by
 *      MUSE-55's audit of the error page. So the status says nothing there either.
 *
 * ## Zero heavyweight operations, and where the markup comes from
 *
 * `DECLARED` in `test/helpers/concurrency.ts` is unchanged and this file performs no
 * `astro build`, no `astro dev` and no browser launch: the headroom is zero, so a suite
 * about a test helper may not spend any of it (MUSE-68).
 *
 * The markup is still **not hand-written**, which is the acceptance criterion: the three
 * fixtures are the real `src/pages/404.astro`, `src/pages/schedule.astro` and
 * `src/pages/en/schedule.astro`, rendered through Astro's container API with the real
 * `BaseLayout`, the real `localeUrl` and `Astro.site` set to the deploy target
 * `test/helpers/build.ts` already pins against `astro.config.mjs`'s default. So a fixture
 * cannot drift from the page: delete the canonical from `BaseLayout.astro` and these tests
 * go red, and give `404.astro` one and they go red the other way.
 *
 * Two things a container render cannot give, stated rather than left to be discovered:
 *
 *   - **No asset pipeline** — no stylesheet, no hashed font URLs. None of it reaches the
 *     canonical, which is built in the layout's frontmatter from `localeUrl(route, locale)`
 *     and `Astro.site`.
 *   - **`import.meta.env.BASE_URL` is `/` in this process**, measured, so the rendered
 *     canonicals carry the apex spelling rather than the Pages sub-path. Every path here is
 *     therefore built with `localeUrl` — the one place a page URL is spelled (MUSE-9) —
 *     rather than written out, so these assertions hold under either deploy target. The
 *     sub-path spelling is already pinned against `dist` by `test/urls.test.ts`, which
 *     fetches every declared canonical and requires a non-redirecting 200.
 *
 * ## Why a real loopback server rather than a stubbed `fetch`
 *
 * `fetchMeasuredPage`'s subject is a real `Response`, and the two cases that matter are
 * about its status: a non-200, and a 200 carrying the error page's body. A monkey-patched
 * global would prove the helper reads a property of an object this file invented. The
 * server below is `node:http` on an ephemeral port answering four fixed paths — the two
 * pairings the host model records (`resolveRequest`) and the 500 `astro dev` answers when
 * a page's frontmatter throws (`test/devcontent.test.ts`'s live arm). It is not a
 * heavyweight operation: nothing is built, rendered or launched.
 */

/** One fixed answer: what the server replies with at a path. */
interface Answer {
  status: number;
  body: string;
}

/** The three pages this file measures, as the real components emit them. */
interface Fixtures {
  /** `/schedule/`, which declares its own canonical. */
  schedule: string;
  /** `/en/schedule/` — a real page, and a *different* one. */
  englishSchedule: string;
  /** `404.astro`, which declares no canonical (MUSE-38). */
  errorPage: string;
}

/** Where the deploy lives, as `astro.config.mjs` defaults and `test/seo.test.ts` pins. */
const SITE = PAGES_DEPLOY.SITE;

/** The one page used in both locales, spelled the only way a page URL may be spelled. */
const SCHEDULE = {
  hr: localeUrl('/schedule', 'hr'),
  en: localeUrl('/schedule', 'en'),
} as const;

/** The error page's own path in the build — `dist/404.html`, served at `/404`. */
const ERROR_PATH = localeUrl('/404', 'hr');

/**
 * `/404` without its slash: extensionless resolution of `404.html`, which the host answers
 * **200**. The recorded row is `/MuseByMina/404` → `200`; the prefix differs here because
 * the base in this process is `/`, and the pairing of status and body is what is modelled.
 */
const ERROR_PATH_AT_200 = ERROR_PATH.replace(/\/$/, '');

/** Inside the prefix and nothing matched: a 404 carrying the error page's body (MUSE-38). */
const MISSING_PATH = '/nope/';

/** A render failure: the status whose first diagnosis this ticket corrects. */
const BROKEN_PATH = '/broken/';

let fixtures: Fixtures;
let server: Server;
let origin: string;

/** A URL on the loopback server, which is a different origin from the canonical's. */
const at = (path: string): string => `${origin}${path}`;

beforeAll(async () => {
  const container = await AstroContainer.create({ astroConfig: { site: SITE } });

  /**
   * The layout reads the route off `Astro.url`, so each page is rendered at its own URL.
   * That is the same derivation a build performs — `routeKey(Astro.url.pathname)` — which
   * is what makes the English page's canonical genuinely name the English route rather
   * than a string this file chose.
   */
  const render = (page: Parameters<typeof container.renderToString>[0], path: string) =>
    container.renderToString(page, { request: new Request(`${SITE}${path}`) });

  const [schedule, englishSchedule, errorPage] = await Promise.all([
    render(SchedulePage, SCHEDULE.hr),
    render(EnglishSchedulePage, SCHEDULE.en),
    render(NotFoundPage, ERROR_PATH),
  ]);
  fixtures = { schedule, englishSchedule, errorPage };

  const answers = new Map<string, Answer>([
    // An ordinary page, served at the spelling that is allowed to be a canonical.
    [SCHEDULE.hr, { status: 200, body: schedule }],
    // The error page under a 200. Read off the live deploy and written out at
    // `resolveRequest` in `scripts/dist-origin.mjs`; MUSE-55's audit depends on it.
    [ERROR_PATH_AT_200, { status: 200, body: errorPage }],
    // The error page under a 404, which is the other row (MUSE-38).
    [MISSING_PATH, { status: 404, body: errorPage }],
    // What `astro dev` answers when a page's frontmatter throws — an unreachable dataset
    // is the one failure `test/devcontent.test.ts` exists for, and the body is 88 bytes of
    // nothing rather than a page.
    [BROKEN_PATH, { status: 500, body: 'Internal Server Error' }],
  ]);

  server = createServer((request, response) => {
    const answer = answers.get(new URL(request.url ?? '/', 'http://host.invalid').pathname);
    response.writeHead(answer?.status ?? 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(answer?.body ?? '');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe('the fixtures are the real pages, which is what makes the rest of this honest', () => {
  it('renders two pages that declare their own canonicals and an error page that declares none', () => {
    expect(canonicalOf(fixtures.schedule)).toBe(`${SITE}${SCHEDULE.hr}`);
    expect(canonicalOf(fixtures.englishSchedule)).toBe(`${SITE}${SCHEDULE.en}`);

    // The premise of every refusal below, and it is a property of `404.astro` rather than
    // of this file: a page served at a URL that does not exist cannot say which URL it is
    // (MUSE-38, the same reason it declares no hreflang).
    expect(canonicalOf(fixtures.errorPage)).toBeUndefined();

    // And it is the error page, not an empty render: both halves of the bilingual body.
    expect(fixtures.errorPage).toContain('Ova stranica još ne postoji.');
    expect(fixtures.errorPage).toContain('This page doesn’t exist yet.');
  });
});

describe('assertMeasuredPage: the canonical comparison, which is the whole rule', () => {
  it('accepts a page whose canonical names the path that was requested', () => {
    const measured = assertMeasuredPage(at(SCHEDULE.hr), fixtures.schedule);

    expect(measured.canonical).toBe(`${SITE}${SCHEDULE.hr}`);
    expect(measured.html).toBe(fixtures.schedule);
    expect(measured.requested).toBe(at(SCHEDULE.hr));
  });

  it('compares pathnames, so the local port is not mistaken for a different page', () => {
    // The request went to 127.0.0.1 and the canonical names the deploy's real origin.
    // That difference is not the question, and a rule reading the whole URL would refuse
    // every page every dev-server suite reads.
    expect(() => assertMeasuredPage(at(SCHEDULE.en), fixtures.englishSchedule)).not.toThrow();
    expect(() =>
      assertMeasuredPage(`${SITE}${SCHEDULE.en}`, fixtures.englishSchedule),
    ).not.toThrow();
  });

  it('refuses the error page, saying it declares none', () => {
    // The assertion QA's tidy-up removes. `if (canonical === undefined) return …` passes
    // this page as whatever was asked for, which is how MUSE-62's corrupted base was
    // measured for months with the suite green.
    let thrown: Error | undefined;
    try {
      assertMeasuredPage(at(SCHEDULE.hr), fixtures.errorPage);
    } catch (error) {
      thrown = error as Error;
    }

    expect(
      thrown,
      'assertMeasuredPage accepted a page that declares no canonical — see MUSE-112: ' +
        'that is the error page, and accepting it is MUSE-62 reopened',
    ).toBeDefined();
    expect(thrown!.message).toContain('declares no <link rel="canonical">');
    expect(thrown!.message).toContain(SCHEDULE.hr);
    expect(thrown!.message).toContain('no canonical');
    // The failure has to say what such a page almost certainly is, because the symptom is
    // otherwise silent — a green suite measuring `404.astro`.
    expect(thrown!.message).toContain(NO_CANONICAL_ADVICE);
  });

  it('refuses a page that is a different page, naming both paths', () => {
    // Both are real pages, both declare a canonical, both answer 200. Only the canonical
    // separates them — the English page for the Croatian one is exactly MUSE-48's defect,
    // and „Muse by Mina" appears in both.
    let thrown: Error | undefined;
    try {
      assertMeasuredPage(at(SCHEDULE.hr), fixtures.englishSchedule);
    } catch (error) {
      thrown = error as Error;
    }

    expect(
      thrown,
      'assertMeasuredPage accepted the English page for the Croatian one — see MUSE-112: ' +
        'the path comparison is what tells /en/ from / (MUSE-48)',
    ).toBeDefined();
    expect(thrown!.message, 'the path that was asked for').toContain(
      `requested  ${SCHEDULE.hr}`,
    );
    expect(thrown!.message, 'the path the page says it is').toContain(
      `measured   ${SCHEDULE.en}`,
    );
  });

  it('names the environment it was given, because a failure in one of three has to', () => {
    expect(() => assertMeasuredPage(at(SCHEDULE.hr), fixtures.errorPage, 'astro dev')).toThrow(
      /A check in astro dev asked for/,
    );
  });
});

describe('fetchMeasuredPage: the status, and the half that holds when the status is 200', () => {
  it('accepts a real page served at its own path', async () => {
    const measured = await fetchMeasuredPage(at(SCHEDULE.hr));
    expect(measured.canonical).toBe(`${SITE}${SCHEDULE.hr}`);
    expect(measured.html).toBe(fixtures.schedule);
  });

  it('refuses a non-200, naming the status in the headline', async () => {
    await expect(fetchMeasuredPage(at(BROKEN_PATH))).rejects.toThrow(
      /asked for \S+\/broken\/ and the server answered 500\./,
    );
  });

  it('refuses the error page served under a 200, which is what a served dist does', async () => {
    // `/404` is 200 with `404.html` as the body (`resolveRequest`). The status check
    // cannot see it, so this is the case where the canonical is the only line — and the
    // one QA's tidy-up turns into a pass.
    let thrown: Error | undefined;
    try {
      await fetchMeasuredPage(at(ERROR_PATH_AT_200));
    } catch (error) {
      thrown = error as Error;
    }

    expect(
      thrown,
      'fetchMeasuredPage accepted a 200 carrying the error page — see MUSE-112: the host ' +
        'answers /404 that way, so the status proves nothing there',
    ).toBeDefined();
    expect(thrown!.message).toContain('declares no <link rel="canonical">');
    expect(thrown!.message, 'nothing was wrong with the status').not.toContain(
      'the server answered',
    );
  });

  it('attaches the error-page advice to a 404 and withholds it from a 500 (MUSE-112)', async () => {
    // A 404 inside the deploy's prefix really is the error page, body and all (MUSE-38),
    // so naming it is the right first diagnosis.
    await expect(fetchMeasuredPage(at(MISSING_PATH))).rejects.toThrow(NO_CANONICAL_ADVICE);

    // A 500 is not. The one failure `test/devcontent.test.ts` exists for is an unreachable
    // dataset, where the URL existed and the base was right — so „check the base and the
    // route" sends the reader to look at the two things that were correct.
    let thrown: Error | undefined;
    try {
      await fetchMeasuredPage(at(BROKEN_PATH));
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(
      thrown!.message,
      'a 500 was told it is almost certainly the error page at a URL that does not exist; ' +
        'on the one failure mode this fires for, the URL and the base were both right',
    ).not.toContain(NO_CANONICAL_ADVICE);
    expect(thrown!.message, 'the status stays in the headline').toContain('answered 500.');
  });
});

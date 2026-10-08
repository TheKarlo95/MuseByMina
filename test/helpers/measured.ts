/**
 * "I measured the page I named", over `fetch` — MUSE-62.
 *
 * `scripts/browser-checks.mjs` already owns this idea for Playwright: `openCheckPage`
 * compares the path it asked for against the path it landed on, and that assertion — not
 * the locale pin beside it — is the half MUSE-48 said generalises. This module is the
 * same claim for a plain `fetch`, and it exists because the browser version cannot make
 * it: **MUSE-47's URL was wrong before it was requested.** The base came out
 * `/MuseByMina/%1B[31m/`, `astro dev` answered it with `404.astro` and no redirect, so
 * requested and landed agreed perfectly and the page was the error page.
 *
 * ## Why the canonical, and not the body
 *
 * The witness has to come from the page's own markup, naming where the page believes it
 * lives, independently of how it was reached. `<link rel="canonical">` is built inside
 * the page from `localeUrl` and `Astro.site` (MUSE-9), and **`404.astro` deliberately
 * declares none** (MUSE-38, same reason it declares no hreflang): a page served at a URL
 * that does not exist cannot say which URL it is. So "the response carries a canonical
 * naming the route I asked for" separates a real page from the error page by
 * construction, rather than by a list of things the error page happens not to say.
 *
 * Body text cannot do it. Every page of this site contains „Muse by Mina", which is
 * exactly how `test/devcontent.test.ts` could have gone green with eight copies of the
 * homepage, and how `test/fonts.test.ts` went green for the life of MUSE-35's coverage
 * against eight copies of the 404: the error page loads the same stylesheet, declares the
 * same six faces and carries the same two preloads, so every font measurement gave the
 * right answer for the wrong document.
 *
 * Nor can the status alone, though it is checked here too and it is cheap. A built site
 * served by `test/helpers/serve.ts` answers an unknown path with the *error page's body*
 * under a 404 (MUSE-38), so status catches that case — but a path that is merely the
 * wrong page is a 200, and only the canonical can tell `/en/` from `/`.
 *
 * ## No `vitest` in here
 *
 * Plain `Error`s rather than `expect`, so this is callable from `test/helpers/scratch.ts`
 * — which is loaded by the `globalSetup`, outside any test worker, where importing
 * `vitest` is not safe. A thrown error is reported the same way an assertion is, and it
 * carries the one thing a failure here needs: both paths, side by side.
 */

/** An attribute's value as emitted, read off a single tag. */
export function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/**
 * The `<link rel="canonical">` href a page declares, if any.
 *
 * It lives here rather than in `test/helpers/build.ts`, which is where it was: this
 * module is the one that says what a canonical is *for*, and `build.ts` cannot import
 * from here without a cycle — `scratch.ts` imports this module, and `build.ts` imports
 * `scratch.ts`. So the definition moved and `build.ts` re-exports it, because it was part
 * of that module's surface.
 */
export function canonicalOf(html: string): string | undefined {
  for (const m of html.matchAll(/<link\b[^>]*>/g)) {
    if ((attr(m[0], 'rel') ?? '').toLowerCase() !== 'canonical') continue;
    return attr(m[0], 'href');
  }
  return undefined;
}

/** A page that has been shown to be the page it was asked for. */
export interface MeasuredPage {
  /** The URL that was requested. */
  requested: string;
  /** The canonical the page declared — an absolute URL at the real deploy origin. */
  canonical: string;
  /** The markup, for the caller's own assertions. */
  html: string;
}

/**
 * Assert that `html` is the page `requested` names, and hand it back.
 *
 * Separate from the fetch so that HTML obtained some other way goes through the same one
 * implementation — a Playwright page's `content()`, or a response body a route
 * interception has already rewritten. A second copy of this comparison is a second place
 * it can be weakened.
 *
 * The comparison is on **pathnames**: the canonical names the deploy's real origin
 * (`https://thekarlo95.github.io/…`) while the request went to a local port, and that
 * difference is not the question. `where` is free-text naming the environment, since a
 * failure in one of three environments has to say which.
 */
export function assertMeasuredPage(
  requested: string,
  html: string,
  where?: string,
): MeasuredPage {
  const asked = new URL(requested).pathname;
  const context = where === undefined ? '' : ` in ${where}`;
  const canonical = canonicalOf(html);

  if (canonical === undefined) {
    throw new Error(
      [
        `A check${context} asked for ${requested} and got a page that declares no ` +
          `<link rel="canonical">.`,
        '',
        `  requested  ${asked}`,
        `  measured   — no canonical —`,
        '',
        NO_CANONICAL_ADVICE,
      ].join('\n'),
    );
  }

  const got = new URL(canonical).pathname;
  if (got !== asked) {
    throw new Error(
      [
        `A check${context} asked for ${requested} and got a page that says it is ` +
          `${canonical}.`,
        '',
        `  requested  ${asked}`,
        `  measured   ${got}`,
        '',
        'The response was a page, and a different one. Whatever this check went on to ' +
          'measure, it measured about that page.',
      ].join('\n'),
    );
  }

  return { requested, canonical, html };
}

/**
 * Fetch a page and prove it is the page that was asked for.
 *
 * The one way anything under `test/` should read a page over HTTP. Status first, because
 * it is the clearer message when it fires, then the canonical, which is the half that
 * holds when the status is 200.
 */
export async function fetchMeasuredPage(
  requested: string,
  where?: string,
): Promise<MeasuredPage> {
  const context = where === undefined ? '' : ` in ${where}`;
  const response = await fetch(requested);
  const html = await response.text();

  if (response.status !== 200) {
    throw new Error(
      [
        `A check${context} asked for ${requested} and the server answered ` +
          `${response.status}.`,
        '',
        NO_CANONICAL_ADVICE,
      ].join('\n'),
    );
  }

  return assertMeasuredPage(requested, html, where);
}

/**
 * What a canonical-less page almost certainly is, and where to look.
 *
 * Written out rather than left to the reader because the symptom is so quiet: MUSE-47's
 * base put an escape sequence in the path, every page of the dev server 404ed, and the
 * only visible consequence was that a green suite had been measuring `404.astro` for
 * months.
 */
const NO_CANONICAL_ADVICE =
  'Every page this site serves declares a canonical; `404.astro` deliberately does not ' +
  '(MUSE-38). So this is almost certainly the error page, served at a URL that does not ' +
  'exist — check the base and the route the URL was built from (MUSE-62).';

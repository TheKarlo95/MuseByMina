import { SanityUnavailableError } from './decode';

/**
 * **A query may not run without the parameters it references (MUSE-51).**
 *
 * Two of the queries in `./queries.ts` take `$now`. Run one without it and the two read
 * paths disagree about whether anything is wrong:
 *
 *     live API   HTTP 400 `{"type":"queryParseError","description":"param $now
 *                referenced, but not provided"}`  →  `SanityUnavailableError`
 *     `groq-js`  substitutes nothing and answers `[]`  →  an empty list
 *
 * The second one is the dangerous half, and not because the message was merely wrong. It
 * *was* wrong — `requireDocuments` saw zero rows and reported "this is an empty dataset,
 * not a broken query", which asserts the one thing that is false — but the count check was
 * also the only thing that noticed at all. `getEvents({ minimum: 0 })` is a legitimate,
 * documented call for a studio with no upcoming events, and with it the whole failure is
 * silent: an empty `/events` publishes offline while the deploy fails with a transport
 * error, and the two environments disagree about whether the build is broken.
 *
 * So the count check cannot be the instrument here, in either direction: it fires on a
 * legitimate empty result and stays quiet on a broken query. The parameters are checked
 * **before the query runs**, which is the only point at which the two cases are still
 * distinguishable — a referenced parameter that was not supplied is a fact about the
 * query text and the call, visible without a dataset, a network or a count.
 *
 * `./client.ts` calls this in front of *both* paths rather than teaching each one to
 * behave like the other. That is deliberate:
 *
 *   - **Neither path gets to be the one that is right.** A guard only in the fixture would
 *     leave the live path's behaviour defined by Sanity's 400, which is a different error
 *     message in a different wording that happens to say the same thing. One check in
 *     front of both means the two environments cannot disagree — the error is the same
 *     class and the same text, and `test/projections.test.ts` asserts that by comparing
 *     the messages rather than by trusting that they read alike.
 *   - **It survives the divergence flipping.** `groq-js` is pinned and the live
 *     `API_VERSION` is pinned, but a GROQ version that decided to answer a missing
 *     parameter with `null` instead of a 400 would silently reopen this on the live side.
 *     A check that never asks either engine cannot be told a new lie.
 *   - **It is a 400 not sent.** The request cannot succeed, so there is nothing to learn
 *     from making it.
 *
 * `./fixture.ts` calls it as well, for the direct callers that do not come through
 * `runQuery` — `test/projections.test.ts` evaluates query text against a fixture itself —
 * in the same way `published()` there is the fixture's half of `perspective: 'published'`.
 * The register of known `groq-js`-vs-live divergences lives at the top of that file.
 */

/**
 * The parameters a GROQ query references, sorted, each without its `$`.
 *
 * **A scanner, not a parse**, and that needs justifying because `groq-js` would give the
 * answer exactly: its tree carries a `{type: 'Parameter', name}` node per reference. But
 * `groq-js` is a devDependency, imported dynamically, precisely so that nothing on the
 * live read path depends on it being installed (`./fixture.ts`, reason 4) — and this
 * guard's whole value is that it runs on the live path too. Two implementations, one per
 * path, would be two things that can disagree about the question they exist to settle.
 *
 * So there is one scanner, and it is **pinned to the real parser by a test rather than by
 * an argument**: `test/projections.test.ts` walks every query in `./queries.ts` through
 * `groq-js` and asserts the `Parameter` nodes it finds are exactly what this function
 * returns. A query whose parameters this cannot see is a red test, not a silent gap.
 *
 * String literals and `//` comments are skipped, since `$` inside either is text and not a
 * reference. An unterminated literal consumes the rest of the query, which costs nothing:
 * a query that does not parse cannot run on either path, and both say so.
 */
export function queryParameters(query: string): string[] {
  const referenced = new Set<string>();

  for (let index = 0; index < query.length; index += 1) {
    const char = query[index];

    if (char === '"' || char === "'") {
      index = endOfLiteral(query, index);
      continue;
    }

    if (char === '/' && query[index + 1] === '/') {
      const newline = query.indexOf('\n', index);
      index = newline === -1 ? query.length : newline;
      continue;
    }

    if (char !== '$') continue;

    // GROQ identifiers never start with a digit, so `$1` is not a parameter and the
    // parser is the thing that should complain about it.
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(query.slice(index + 1))?.[0];
    if (name === undefined) continue;
    referenced.add(name);
    index += name.length;
  }

  return [...referenced].sort();
}

/** The index of the quote closing the literal opened at `open`, or the end of the query. */
function endOfLiteral(query: string, open: number): number {
  const quote = query[open];
  for (let index = open + 1; index < query.length; index += 1) {
    if (query[index] === '\\') {
      index += 1;
      continue;
    }
    if (query[index] === quote) return index;
  }
  return query.length;
}

/**
 * Throw unless every parameter the query references was supplied.
 *
 * `SanityUnavailableError`, not `SanityContentError`, and the three outcomes `./decode.ts`
 * keeps apart are the reason: the query never ran, so there is no content to judge. This
 * sits beside the other two things already classed as unavailable for the same
 * reason — a GROQ syntax error and a projection that answered with something other than a
 * list. Calling it a content error would send whoever reads the log into the Studio
 * looking for documents that were never the problem.
 *
 * A parameter present with the value `undefined` counts as missing. `@sanity/client`
 * serialises each parameter with `JSON.stringify`, which has no spelling for `undefined`,
 * so `{now: undefined}` reaches the API as the same absence — the same mistake in a
 * different shape, and it would be strange for the two to be reported differently. `null`
 * is a value and is accepted.
 */
export function requireQueryParameters(query: string, params: Record<string, unknown>): void {
  const referenced = queryParameters(query);
  const missing = referenced.filter((name) => params[name] === undefined);
  if (missing.length === 0) return;

  const supplied = Object.keys(params)
    .filter((name) => params[name] !== undefined)
    .sort();

  throw new SanityUnavailableError(
    `A query was run without ${missing.length === 1 ? 'a parameter' : 'parameters'} it ` +
      `references: ${list(missing)}.\n` +
      `This is a broken query, not missing content — the query never ran, so there is ` +
      `nothing in the dataset to blame and no document count that means anything. ` +
      `Supply ${list(missing)} at the call site, or stop referencing ` +
      `${missing.length === 1 ? 'it' : 'them'} in the query.\n` +
      `  Referenced: ${referenced.length === 0 ? 'none' : list(referenced)}\n` +
      `  Supplied:   ${supplied.length === 0 ? 'none' : list(supplied)}\n` +
      `Checked before the query is sent, because the two read paths answer it ` +
      `differently and one of the answers is silent: the live API refuses the request ` +
      `with HTTP 400 \`queryParseError\`, while \`groq-js\` answers \`[]\` — a result ` +
      `indistinguishable from a dataset that holds no matching documents, which a ` +
      `reader passing \`minimum: 0\` accepts without a word.\n` +
      `Query was:\n${query.trim()}`,
  );
}

/** `$now`, `$now and $until`, `$a, $b and $c` — parameter names as a reader meets them. */
function list(names: string[]): string {
  const spelled = names.map((name) => `\`$${name}\``);
  if (spelled.length <= 1) return spelled.join('');
  return `${spelled.slice(0, -1).join(', ')} and ${spelled.at(-1)}`;
}

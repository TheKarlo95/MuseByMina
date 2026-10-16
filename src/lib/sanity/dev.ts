/**
 * **Is the read path running inside a dev server, or inside a build? (MUSE-47)**
 *
 * One question, asked in three places, and the answer has to be the *same* in all three
 * or the caching rules disagree with each other: `./index.ts` memoises a reader,
 * `./fixture.ts` caches the parsed NDJSON, and `./client.ts` announces which of the two
 * regimes is in force. So it is one function rather than three conditions.
 *
 * ---
 *
 * **Why `import.meta.hot` and not an environment variable.**
 *
 * This is a gate that decides whether content may be re-read, and MUSE-20 spent its
 * review budget on four barriers whose shared property is that none of them is
 * "remember not to". A gate a deploy could trip by setting a variable would be a fifth
 * way in, so this one is not readable from the environment at all:
 *
 *   - `import.meta.hot` is Vite's HMR handle. It exists only while a module is being
 *     served by a dev server; a production build has no HMR, so there is nothing for it
 *     to be. Measured on Astro 7.3.6, against this repo: `typeof import.meta.hot` is
 *     `'object'` under `astro dev` and `'undefined'` under `astro build` — the prerender
 *     pass included, which is the one that actually calls these readers.
 *   - It is `undefined` under `vitest run` too, so every in-process test sees the
 *     **build** regime, which is the one the existing suite already assumes
 *     (`test/projections.test.ts` relies on `getSiteSettings` memoising).
 *   - Nothing in a workflow, an npm script or a shell can make it true. `NODE_ENV`,
 *     `process.argv` and `npm_lifecycle_event` all distinguish the two commands as
 *     well — all three were measured — and all three are settable by whoever runs the
 *     build, which disqualifies them for this job.
 *
 * ---
 *
 * **Write it as the literal `import.meta.hot` — but the reason this gave was false**
 * (MUSE-94).
 *
 * What stood here said Vite's dev transform rewrites that exact member access, so
 * `'hot' in import.meta` is *not* equivalent and is **false in dev**. Measured: it is
 * true. This file was reduced to nothing but the in-operator, with no literal
 * `import.meta.hot` left anywhere in it, comments included — Vite's injection decision is
 * a source scan, so a mention in a comment is enough to spoil the measurement — and a
 * real `astro dev` on Astro 7.3.6 printed:
 *
 *     [qa] in-operator says true;
 *     keys=["filename","dirname","url","env","resolve","glob","main","hot"]
 *     [content] dev server — the file is re-read on each request, …
 *
 * So `import.meta` carries `hot` unconditionally under `astro dev`: the in-operator, the
 * literal and a cast all answer the same thing, and the regime came out right with the
 * gate written the way this file forbade. Write the literal anyway — it is the form Vite
 * documents and statically understands, where the other two rest on the dev-SSR
 * `import.meta` object happening to carry the property, which is an implementation detail
 * of the server rather than anything Vite promises.
 *
 * **That preference is unguarded, and this sentence is the guard it has instead.** No
 * test can tell the three spellings apart, because they behave identically: QA swapped
 * the gate for the forbidden form and `test/devcontent.test.ts` stayed 18/18 green, which
 * is exactly how the false claim survived MUSE-47 — the file prescribed a spelling, the
 * suite could not see the spelling, and nothing could ever contradict the reason. A guard
 * would need its own dev server and a probe route, and `test/helpers/concurrency.ts` has
 * zero headroom. **What is guarded is the property the gate actually needs**: that it
 * cannot be produced from the environment. `test/devcontent.test.ts` builds with
 * `NODE_ENV=development` and reads the regime off the build's log, and forcing
 * `inDevServer()` either way turns six tests red in each direction.
 *
 * Note that this is not the thing `test/sanity.test.ts` forbids. The rule there is that
 * no module in the read path may read its **configuration** off `import.meta.env`,
 * because Vite substitutes those names into client bundles; the project id living in
 * `process.env` is what makes a stray client import throw instead of quietly working.
 * `import.meta.hot` carries no configuration and is a constant of the build, not a value
 * read from it.
 */
export function inDevServer(): boolean {
  return import.meta.hot !== undefined;
}

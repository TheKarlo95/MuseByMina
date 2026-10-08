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
 * It must be written as the literal expression `import.meta.hot`. Vite's dev transform
 * rewrites that exact member access into the injected HMR context, so `'hot' in
 * import.meta` and `(import.meta as …).hot` are *not* equivalent — the first is false in
 * dev, and the second is a cast away from the form Vite looks for.
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

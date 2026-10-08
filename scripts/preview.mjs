import { serveBuild } from './dist-origin.mjs';

/**
 * `npm run preview` — the built site, served the way GitHub Pages serves it.
 *
 * This used to be `astro preview`, and MUSE-52 is why it is not any more. Two reasons,
 * either of which on its own would be enough:
 *
 *   - **It daemonises.** Astro 7 backgrounds it under this environment and then silently
 *     reuses an existing daemon on another port rather than failing or warning. MUSE-35's
 *     review found three orphaned `astro.mjs preview --json` daemons still listening from
 *     *manual* `npm run preview` invocations, parented to pid 3158 — they outlive the
 *     session that started them, and the next thing that wants a server gets handed one
 *     of them. That is how a clean accessibility report came to be about a different
 *     agent's worktree. This server is this process: Ctrl-C and it is gone.
 *   - **It is not the host.** `astro preview` answers both `/MuseByMina` and
 *     `/MuseByMina/` with 200 and never redirects, so the trailing-slash mismatch MUSE-9
 *     is about is invisible to anyone checking a page by hand. `resolveRequest` in
 *     `scripts/dist-origin.mjs` is the model read off the live deploy and pinned by
 *     `test/urls.test.ts`, so what you see here is what Pages does.
 *
 * It serves `dist`, so it needs `npm run build` first and will say so if there is none.
 * For live reload while editing, that is `npm run dev` — a different tool for a different
 * question.
 */
const site = await serveBuild();

console.log('\nCtrl-C to stop. Nothing is left running afterwards.');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    void site.close().then(() => process.exit(0));
  });
}

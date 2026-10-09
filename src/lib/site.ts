/**
 * Deploy-root URLs — for files the *build* publishes at the root, not bundled assets.
 *
 * `sitemap-index.xml`, `robots.txt` and `llms.txt` sit at the root of the build output,
 * which is the root of the deployed site — `/MuseByMina` on GitHub Pages today, `/` once
 * a custom domain is live. Both come from `SITE`/`BASE` in `astro.config.mjs`, so
 * nothing here may name a host.
 *
 * The join lives here rather than at the call site: whether `BASE_URL` carries a
 * trailing slash depends on `trailingSlash` in `astro.config.mjs`, so interpolating it —
 * `${BASE_URL}robots.txt` — yields either the right path or `/MuseByMinarobots.txt`, a
 * 404 that only shows up on the sub-path deploy (MUSE-8). Normalising in one place is
 * what makes the join independent of that setting.
 *
 * ## What this is NOT for any more (MUSE-35)
 *
 * This used to say "and everything copied out of `public/`". There is no `public/` now:
 * the six font files were the only thing in it, and a root-absolute path to one is
 * exactly the bug MUSE-35 fixed — Vite rewrites a CSS `url()` to include `base` only at
 * build time, so `astro dev` 404'd all six faces while the deploy was fine.
 *
 * An asset belonging to the site's own code — a font, an image, an icon — goes in
 * `src/assets/` and is **imported**, so Vite emits it with a content hash and resolves
 * every reference to it in both environments, with no base-path join at all. See
 * `src/styles/fonts.css` and the `?url` imports in `src/lib/fonts.ts`.
 *
 * Reach for `rootPath` only when a file genuinely has to live at a fixed, published URL
 * that something outside this codebase asks for by name — `favicon.ico`, `CNAME`,
 * `.well-known/…` — and put that file in a restored `public/`.
 */
const BASE = import.meta.env.BASE_URL.replace(/\/+$/, '');

/** Path to a file published at the deploy root, including the base path. */
export function rootPath(file: string): string {
  return `${BASE}/${file.replace(/^\/+/, '')}`;
}

/**
 * Absolute URL for a file published at the deploy root.
 *
 * `site` comes from the endpoint's `APIContext`; it is always set because
 * `astro.config.mjs` always sets `site`. Failing loudly beats emitting a relative
 * `Sitemap:` line that no crawler will follow.
 */
export function rootUrl(file: string, site: URL | undefined): string {
  if (!site) throw new Error('`site` is not configured — cannot build absolute URLs.');
  return new URL(rootPath(file), site).href;
}

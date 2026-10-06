/**
 * Deploy-root URLs.
 *
 * `sitemap-index.xml`, `robots.txt` and `llms.txt` all sit at the root of the build
 * output, which is the root of the *deployed* site — `/MuseByMina` on GitHub Pages
 * today, `/` once a custom domain is live. Both come from `SITE`/`BASE` in
 * `astro.config.mjs`, so nothing here may name a host.
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

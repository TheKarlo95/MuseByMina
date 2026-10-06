import type { APIRoute } from 'astro';
import { rootUrl } from '../lib/site';

/**
 * Generated rather than dropped in `public/`, because the `Sitemap:` line has to be an
 * absolute URL and the origin is env-driven (`SITE`/`BASE`). A static file would pin
 * the host and silently point at the old deploy after a domain move.
 *
 * Nothing is disallowed: the whole site is public marketing copy.
 */
export const GET: APIRoute = ({ site }) => {
  const body = [
    'User-agent: *',
    'Allow: /',
    '',
    `Sitemap: ${rootUrl('sitemap-index.xml', site)}`,
    '',
  ].join('\n');

  return new Response(body, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};

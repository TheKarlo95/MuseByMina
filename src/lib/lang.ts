export const LANG_STORAGE_KEY = 'muse-lang';

/**
 * Runs as a blocking inline script, on the Croatian homepage only.
 *
 * The site is statically hosted with no edge compute, so there is no IP geolocation —
 * the browser's own language preference is the signal. Croatian stays the default and
 * is what gets served; only a visitor whose browser is clearly not Croatian is sent to
 * the English mirror.
 *
 * Deliberately narrow, because a redirect that fires on the wrong page is far worse
 * than one that never fires:
 *   - root route only, so no deep page can bounce
 *   - never if the viewer has already chosen a language
 *   - never if a `?lang=` override is present
 *   - replaceState, so Back isn't trapped in a redirect loop
 *
 * `?query` and `#fragment` are carried across. Every CTA on the site points at `/#trial`
 * (`src/lib/nav.ts`), so dropping the fragment landed exactly the visitors this redirect
 * exists for at the top of `/en/` instead of at the form (MUSE-10). The fragment is never
 * sent to the server, so there is nowhere else this can be fixed — it has to happen here,
 * in the inline script, before the English page loads. `enHomeUrl` comes from
 * `localeUrl('/', 'en')` and carries neither, so appending is concatenation rather than a
 * merge; `test/lang.test.ts` drives it in a real non-Croatian browser.
 */
export function langInitScript(enHomeUrl: string): string {
  return `
(function () {
  try {
    if (localStorage.getItem('${LANG_STORAGE_KEY}')) return;
    if (location.search.indexOf('lang=') !== -1) return;
    var langs = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < langs.length; i++) {
      if (/^hr\\b/i.test(langs[i])) return;
    }
    location.replace('${enHomeUrl}' + location.search + location.hash);
  } catch (e) {}
})();
`.trim();
}

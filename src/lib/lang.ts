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
    location.replace('${enHomeUrl}');
  } catch (e) {}
})();
`.trim();
}

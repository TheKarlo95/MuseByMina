import { DEFAULT_LOCALE, type Locale } from './i18n';

export const LANG_STORAGE_KEY = 'muse-lang';

/**
 * The one mirror the inline selector below can send a viewer to.
 *
 * `langInitScript` is handed a single URL — the English homepage — so English is the only
 * destination it can express. Naming that rather than spelling `'en'` inline keeps the
 * limit in one place: adding a third locale to `LOCALES` needs this script to learn more
 * URLs before `?lang=` can select it, and until then an unknown value is ignored rather
 * than quietly stored and disobeyed.
 */
const MIRROR_LOCALE: Locale = 'en';

/** The locales the inline selector can actually act on. */
const SELECTABLE: readonly Locale[] = [DEFAULT_LOCALE, MIRROR_LOCALE];

/** The query parameter that requests a language for this visit. */
export const LANG_PARAM = 'lang';

/**
 * Carry the viewer's current `?query` and `#fragment` onto a locale URL.
 *
 * **This is the one place the carry rule lives.** It is the rule MUSE-10 established for
 * the automatic redirect and MUSE-16 found missing from the manual switcher: a fragment is
 * never sent to the server, so a URL built at render time cannot possibly contain one, and
 * the only moment it can be attached is client-side at the point of navigation.
 *
 * `url` comes from `localeUrl()` and carries neither a query nor a fragment, so attaching
 * is concatenation rather than a merge — with one exception. `?lang=` names a *requested*
 * language, so carrying it verbatim across a locale switch would hand the destination a
 * URL explicitly asking to be somewhere else, and `langInitScript` below would bounce the
 * viewer straight back. Switching language therefore rewrites the parameter to the locale
 * being switched to. It is never invented: a URL without `?lang=` gets one without it, the
 * same restraint as the fragment.
 *
 * The query is left byte-identical when there is no `lang` to rewrite, rather than round
 * tripped through `URLSearchParams`, which would re-encode a visitor's campaign tags.
 */
export function carryLocation(
  url: string,
  locale: Locale,
  search: string,
  hash: string,
): string {
  let query = search;
  const params = new URLSearchParams(search);
  if (params.has(LANG_PARAM)) {
    params.set(LANG_PARAM, locale);
    query = `?${params.toString()}`;
  }
  return `${url}${query}${hash}`;
}

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
 *   - replaceState, so Back isn't trapped in a redirect loop
 *
 * ## Precedence: `?lang=` beats a stored choice beats the browser
 *
 * `?lang=` used to *suppress* detection without *selecting* anything, so `/?lang=en` on an
 * English browser left the viewer on the Croatian page — the exact opposite of what the
 * parameter asks for, and wrong for everyone a link was shared with (MUSE-16). It now
 * selects, and it is the strongest of the three signals: it is explicit, it is attached to
 * *this* request, and it is how one person hands another a link in a particular language.
 * A stored `muse-lang` is also explicit but was chosen on some earlier visit, so a fresh
 * request overrides it — and replaces it, because the whole point of persisting a click is
 * that the choice sticks, and a choice arriving by link is no less of a choice. The
 * browser's `navigator.languages` is last: it is a default, not a decision.
 *
 * This cannot loop. The only redirect is away from the default locale toward the English
 * mirror, the mirror does not run this script (`detectLanguage` is passed by
 * `src/pages/index.astro` alone), and `?lang=hr` on the Croatian page is already satisfied
 * so it navigates nowhere. The other half is `LocaleSwitch.astro`, which rewrites a carried
 * `?lang=` to the locale it is switching to — see `carryLocation` above.
 *
 * A `?lang=` value naming no known locale still suppresses detection and selects nothing:
 * the parameter has always meant "I am choosing", and a typo is not a reason to hand the
 * decision back to the browser.
 *
 * The guard reads the parameter rather than searching the query string. `indexOf('lang=')`
 * matched `?slang=whatever` too, silently disabling detection for any URL carrying a param
 * that happened to end in `lang`.
 *
 * `?query` and `#fragment` are carried across. Every CTA on the site points at `/#trial`
 * (`src/lib/nav.ts`), so dropping the fragment landed exactly the visitors this redirect
 * exists for at the top of `/en/` instead of at the form (MUSE-10). The fragment is never
 * sent to the server, so there is nowhere else this can be fixed — it has to happen here,
 * in the inline script, before the English page loads.
 *
 * The concatenation is written out by hand rather than calling `carryLocation`: this is a
 * blocking inline script in `<head>`, and importing a module would mean shipping and
 * awaiting one, which is precisely what it exists not to do. The two live in the same file
 * so they cannot drift apart unnoticed, and the rewrite branch is deliberately absent here
 * because the carried `?lang=` always already names the destination. `test/lang.test.ts`
 * and `test/localeswitch.test.ts` drive both halves in a real browser.
 */
export function langInitScript(enHomeUrl: string): string {
  return `
(function () {
  try {
    var SELECTABLE = ${JSON.stringify([...SELECTABLE])};
    var requested = new URLSearchParams(location.search).get('${LANG_PARAM}');
    if (requested !== null) {
      if (SELECTABLE.indexOf(requested) !== -1) {
        // Its own try: a blocked localStorage must not cost the viewer the redirect.
        try { localStorage.setItem('${LANG_STORAGE_KEY}', requested); } catch (e) {}
        if (requested === '${MIRROR_LOCALE}') {
          location.replace('${enHomeUrl}' + location.search + location.hash);
        }
      }
      return;
    }
    if (localStorage.getItem('${LANG_STORAGE_KEY}')) return;
    var langs = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < langs.length; i++) {
      if (/^hr\\b/i.test(langs[i])) return;
    }
    location.replace('${enHomeUrl}' + location.search + location.hash);
  } catch (e) {}
})();
`.trim();
}

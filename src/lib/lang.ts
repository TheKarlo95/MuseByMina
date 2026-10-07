import { DEFAULT_LOCALE, LOCALES, type Locale } from './i18n';

export const LANG_STORAGE_KEY = 'muse-lang';

/**
 * The locale browser detection sends a viewer to when their browser is not Croatian.
 *
 * Detection is a two-way question with a two-locale answer, so it is named rather than
 * spelled `'en'` inline: adding a third locale to `LOCALES` needs a rule for *which*
 * non-Croatian browser goes where, and this is where that rule would live. Everything
 * else in this file is already general over `LOCALES` — only the detection branch has to
 * choose, and only it has to be revisited.
 */
const MIRROR_LOCALE: Locale = 'en';

/** The query parameter that requests a language. */
export const LANG_PARAM = 'lang';

/**
 * Carry the viewer's current `?query` and `#fragment` onto a locale URL, and stamp the
 * locale onto `?lang=`.
 *
 * **This is the one place the carry rule lives.** It is the rule MUSE-10 established for
 * the automatic redirect and MUSE-16 found missing from the manual switcher: a fragment is
 * never sent to the server, so a URL built at render time cannot possibly contain one, and
 * the only moment it can be attached is client-side at the point of navigation.
 *
 * `url` comes from `localeUrl()` and carries neither a query nor a fragment, so attaching
 * is concatenation rather than a merge. `?lang=` is the exception, and it is *always*
 * written — rewritten when the viewer's URL already has one, appended when it does not:
 *
 *   - Rewriting is what stops the switch fighting the redirect it just caused. Carrying
 *     `?lang=en` verbatim onto the Croatian page would hand `langInitScript` a URL
 *     explicitly asking for English and bounce the viewer straight back (MUSE-16).
 *   - Appending is what makes the href a *durable* link to a language (MUSE-33). MUSE-16
 *     moved the carry out of the click handler and into the href precisely because
 *     middle-click, "open in new tab" and "copy link address" fire no `click` event — and
 *     then left the persistence behind in the handler, so those paths produced a bare
 *     `/MuseByMina/#trial` that the homepage redirect was free to reinterpret. A link that
 *     names the language cannot be reinterpreted, by a new tab or by a stranger.
 *
 * Everything that is not `lang` is left byte-identical. The query is spliced as a string
 * rather than round-tripped through `URLSearchParams.toString()`, which re-encodes what it
 * did not have to touch — `%20` comes back out as `+` — and a function claiming to *carry*
 * a visitor's campaign tags should not be rewriting them (MUSE-33).
 */
export function carryLocation(
  url: string,
  locale: Locale,
  search: string,
  hash: string,
): string {
  return `${url}${withLang(search, locale)}${hash}`;
}

/**
 * `search` with exactly one `lang=<locale>`, and every other pair untouched.
 *
 * A repeated `lang` is collapsed rather than rewritten twice: `URLSearchParams.get()`
 * returns the *first* occurrence, so leaving a second one behind would let it decide the
 * destination and send the viewer somewhere the switcher did not offer.
 */
function withLang(search: string, locale: Locale): string {
  const pairs = search.replace(/^\?/, '').split('&').filter(Boolean);
  let written = false;
  const kept = pairs.flatMap((pair) => {
    if (paramName(pair) !== LANG_PARAM) return [pair];
    if (written) return [];
    written = true;
    return [`${LANG_PARAM}=${locale}`];
  });
  if (!written) kept.push(`${LANG_PARAM}=${locale}`);
  return `?${kept.join('&')}`;
}

/**
 * The decoded name of one `a=b` pair.
 *
 * Decoded because `URLSearchParams` decodes before matching, so `l%61ng=en` *is* a `lang`
 * parameter to the script that reads it. Comparing raw strings would miss it, append a
 * second `lang=`, and leave the first one deciding the destination.
 */
function paramName(pair: string): string {
  const raw = pair.split('=')[0] ?? '';
  try {
    return decodeURIComponent(raw.replace(/\+/g, ' '));
  } catch {
    return raw;
  }
}

export interface LangRouting {
  /** This same route in `locale`, deploy base and trailing slash included. */
  urlFor(locale: Locale): string;
  /** The locale this page is rendered in. */
  locale: Locale;
  /**
   * May a stored choice or the browser's preference route away from this page?
   *
   * The default locale's homepage only. See the precedence note below for why `?lang=`
   * is not subject to this and everything else is.
   */
  detect: boolean;
}

/**
 * Runs as a blocking inline script, in `<head>`, on every page that has a locale twin.
 *
 * The site is statically hosted with no edge compute, so there is no IP geolocation —
 * the browser's own language preference is the signal. Croatian stays the default and
 * is what gets served; only a visitor whose browser is clearly not Croatian is sent to
 * the English mirror.
 *
 * ## Precedence: `?lang=` beats a stored choice beats the browser
 *
 * **`?lang=`** is the strongest signal and the only one that may act on *any* page. It is
 * explicit, it is attached to this request, and it is how one person hands another a link
 * in a particular language. It used to *suppress* detection without *selecting* anything,
 * so `/?lang=en` on an English browser left the viewer on the Croatian page (MUSE-16), and
 * it only worked on `/` at all — a shared `/schedule/?lang=en` did nothing (MUSE-33). It
 * now selects, everywhere, and persists, because a choice arriving by link is no less of a
 * choice than a click on the switcher.
 *
 * **A stored `muse-lang`** is also explicit but was chosen on an earlier visit, so a fresh
 * request overrides it. It beats the browser, and this is the bug MUSE-33 fixes: the guard
 * used to read `if (localStorage.getItem(KEY)) return;`, so the *presence* of a stored
 * value suppressed the redirect and the value was never read at all. `muse-lang=en` meant
 * "do not redirect to English" — the inverse of what it records. Harmless while only a
 * switcher click wrote the key, because staying put happened to be right; MUSE-16 made
 * `?lang=` persist and routed a shared link into the backwards branch, so an English
 * visitor got English once and Croatian forever after.
 *
 * **`navigator.languages`** is last. It is a default, not a decision.
 *
 * A value naming no locale — stored or requested — is *not* a decision either, and must
 * not masquerade as one by suppressing the rules below it. `/?lang=de` stranding an English
 * browser on Croatian was the same shape of bug as `?slang=` silently disabling detection:
 * something that is not an answer being treated as one. Unrecognised values therefore fall
 * through to the next signal, and nothing unrecognised is ever stored.
 *
 * ## Deliberately narrow, and why `detect` exists
 *
 * A redirect that fires on the wrong page is far worse than one that never fires, so the
 * browser's preference and a stored choice act on the default locale's homepage alone
 * (`detectLanguage` in `BaseLayout.astro`, passed by `src/pages/index.astro`). A shared
 * `/schedule/` link therefore lands on `/schedule/` for everyone, and a visitor who once
 * chose English can still be sent a Croatian page — the link they were given still works.
 * `?lang=` is exempt because it is the *link itself* asking, not an inference about it.
 *
 * ## It cannot loop
 *
 * Every branch funnels into one `go()`, which navigates to this same route in some other
 * locale and returns without moving when that locale is already the one being served. So a
 * hop only ever happens toward the locale the rules just chose, and the destination is a
 * page serving it:
 *
 *   - `?lang=X` → the page serving X, where `?lang=X` is satisfied and `go()` is a no-op.
 *   - stored or detected X → only ever evaluated on the default homepage, and X's page
 *     does not `detect`, so nothing there can reconsider.
 *   - an unrecognised `?lang=` rides along in the carried query and reads as "nothing
 *     asked for" at the destination too, exactly as it did at the origin.
 *
 * `replaceState` semantics (`location.replace`) keep the origin out of the history stack,
 * so Back cannot return to a page that would immediately bounce forward again. The other
 * half of the no-loop argument is `carryLocation` above, which rewrites a carried `?lang=`
 * to the locale being switched to — MUSE-16 shipped a loop from exactly that seam.
 * `test/localeswitch.test.ts` enumerates every combination of page, parameter, stored value
 * and browser rather than reasoning case by case, and asserts each one settles in one hop.
 *
 * ## Carrying, and why this is hand-written
 *
 * `?query` and `#fragment` are carried across verbatim. Every CTA on the site points at
 * `/#trial` (`src/lib/nav.ts`), so dropping the fragment landed exactly the visitors this
 * redirect exists for at the top of `/en/` instead of at the form (MUSE-10). The fragment
 * is never sent to the server, so there is nowhere else this can be fixed.
 *
 * The concatenation is written out by hand rather than calling `carryLocation`: this is a
 * blocking inline script in `<head>`, and importing a module would mean shipping and
 * awaiting one, which is precisely what it exists not to do. The two live in the same file
 * so they cannot drift apart unnoticed, and the `?lang=` rewrite is deliberately absent
 * here because this script only ever navigates toward a locale the URL is already asking
 * for, or that nothing at the destination will reconsider. `test/lang.test.ts` and
 * `test/localeswitch.test.ts` drive both halves in a real browser.
 */
export function langInitScript({ urlFor, locale, detect }: LangRouting): string {
  const urls = Object.fromEntries(LOCALES.map((l) => [l, urlFor(l)]));
  return `
(function () {
  try {
    var LOCALES = ${JSON.stringify([...LOCALES])};
    var URLS = ${JSON.stringify(urls)};
    var HERE = ${JSON.stringify(locale)};
    var KEY = ${JSON.stringify(LANG_STORAGE_KEY)};
    var DETECT = ${detect ? 'true' : 'false'};

    // A locale this script can act on, which is also the only way URLS[value] is read.
    function known(value) { return LOCALES.indexOf(value) !== -1; }

    // The one navigation this script can perform: this same route in another locale,
    // query and fragment carried over byte for byte. Already there is not a navigation.
    function go(locale) {
      if (locale === HERE) return;
      location.replace(URLS[locale] + location.search + location.hash);
    }

    var requested = new URLSearchParams(location.search).get(${JSON.stringify(LANG_PARAM)});
    if (known(requested)) {
      // Its own try: a blocked localStorage must not cost the viewer the redirect.
      try { localStorage.setItem(KEY, requested); } catch (e) {}
      go(requested);
      return;
    }

    // Past here the page is being routed on an inference rather than on a request.
    if (!DETECT) return;

    var stored = null;
    try { stored = localStorage.getItem(KEY); } catch (e) {}
    if (known(stored)) { go(stored); return; }

    var langs = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < langs.length; i++) {
      if (/^${DEFAULT_LOCALE}\\b/i.test(langs[i])) return;
    }
    go(${JSON.stringify(MIRROR_LOCALE)});
  } catch (e) {}
})();
`.trim();
}

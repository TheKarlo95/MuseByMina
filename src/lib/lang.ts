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
 *
 * `search` and `hash` default to empty, because there is a caller with nothing to carry:
 * the error page's two exits (`src/pages/404.astro`), which are built at render time and
 * so cannot have either. They still have to come through here, which is the point of the
 * defaults — MUSE-56 was those two hrefs being built with `localeUrl()` alone, and the
 * Croatian one therefore pointing at the bare deploy root, which is the single route on
 * the site that browser detection may reinterpret. Hand-appending `?lang=` there would
 * have fixed the page and left the rule in two places; a default argument keeps "a link
 * that names its language" one function, called by everything that offers a language.
 */
export function carryLocation(
  url: string,
  locale: Locale,
  search = '',
  hash = '',
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
  /**
   * This same route in `locale`, deploy base and trailing slash included — or `null` when
   * this page has no addressable twin in that locale.
   *
   * `null` is the error page's answer for every locale (MUSE-38). GitHub Pages serves one
   * root `404.html` for every unknown path, so `/404/`, `/en/404` and `/en/404/` are all
   * themselves 404s: there is no URL to send anybody to. A locale with no URL is therefore
   * a locale this script cannot navigate to — which is a *different* statement from "this
   * page does not route by language", and keeping them different is the whole of MUSE-38.
   * The choice is still read and still persisted; only the hop is impossible.
   *
   * Expressed per locale rather than as one boolean because that is the shape the fact has:
   * the day a page exists in Croatian and not in English, `go()` already does the right
   * thing for it without a second flag deciding what "has a twin" means.
   */
  urlFor(locale: Locale): string | null;
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
 * Runs as a blocking inline script, in `<head>`, on **every** page the site builds.
 *
 * It used to run on every page that had a locale twin, which sounds like the same thing
 * and is not. `BaseLayout.astro` derived that from `indexable`, so the error page — the
 * page a lost visitor is most likely to meet — shipped no language handling at all, and
 * the `?lang=` MUSE-33 documented as working everywhere was silently discarded there
 * (MUSE-38). Whether a page has a twin to *navigate* to is now a fact about each URL, held
 * in `urlFor` above; whether the script runs is not a question any more.
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
 * **Case is not meaning.** `?lang=EN` is somebody asking for English, so the value is
 * folded before it is matched (MUSE-39) — requested and stored alike, since the same
 * question applies to a key a hand or another tab may have written. This does not widen
 * what counts as an answer, which is why it cannot undo the rule above: a folded value
 * either names a locale or still does not, and `de` folds to `de`. `navigator.languages`
 * was already matched case-insensitively; this is the other two signals catching up. The
 * canonical lowercase spelling is what gets stored and what indexes `URLS`, so the fold
 * reaches the write as well as the match and no uppercase value can originate here. A
 * mixed-case key that is already there is obeyed and left alone rather than rewritten:
 * there is one write in this script, and adding a second to a read-only branch would buy
 * nothing a fold at the point of reading does not already give.
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
 *   - a locale this page has no URL in is not a hop at all, so the error page records the
 *     choice and stays exactly where it is (MUSE-38). A redirect to the `/en/404/` the
 *     host cannot serve would be a dead end dressed as a fix.
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
 * awaiting one, which is precisely what it exists not to do. The script below is a
 * template literal, so nothing inside it — comments included — may contain a backtick or
 * a `${`; both are a syntax error in *this* file rather than in the generated script,
 * which is at least loud. The two live in the same file so they cannot drift apart
 * unnoticed, and the `?lang=` rewrite is deliberately absent here because this script
 * only ever navigates toward a locale the URL is already asking for, or that nothing at
 * the destination will reconsider. `test/lang.test.ts` and
 * `test/localeswitch.test.ts` drive both halves in a real browser.
 */
export function langInitScript({ urlFor, locale, detect }: LangRouting): string {
  /**
   * Only the locales this page actually has a URL in.
   *
   * A locale `urlFor` answers `null` for is left out of the map entirely rather than
   * carried as a null, so the error page's markup contains no `/en/404/` at all — a URL
   * the host cannot serve, sitting in an inline script, is a navigation waiting for
   * somebody to re-enable one (MUSE-38).
   */
  const urls: Partial<Record<Locale, string>> = {};
  for (const l of LOCALES) {
    const url = urlFor(l);
    if (url !== null) urls[l] = url;
  }

  return `
(function () {
  try {
    var LOCALES = ${JSON.stringify([...LOCALES])};
    var URLS = ${JSON.stringify(urls)};
    var HERE = ${JSON.stringify(locale)};
    var KEY = ${JSON.stringify(LANG_STORAGE_KEY)};
    var DETECT = ${detect ? 'true' : 'false'};

    // The locale a value names, in canonical form — or null when it names none. This is
    // also the only way URLS[...] and localStorage are ever written or read.
    //
    // Case-folded before matching (MUSE-39). The lang parameter is one a human hand-types
    // or hand-edits out of a shared link, and ?lang=EN falling through as unrecognised was
    // a failure with no symptom: no English, and no indication why. Folding cannot
    // reintroduce MUSE-33's bug, because a folded value either names a locale or still
    // does not -- "de" folds to "de" and is nobody's language here.
    //
    // It hands back the canonical spelling rather than a boolean so the fold reaches the
    // write as well as the match: whatever case arrives, only lowercase is stored.
    //
    // toLowerCase, not toLocaleLowerCase -- the latter folds a capital I to the dotless
    // Turkish form under a Turkish locale, which would make ?lang=EN work everywhere
    // except in Turkey.
    function named(value) {
      var folded = typeof value === 'string' ? value.toLowerCase() : '';
      return LOCALES.indexOf(folded) === -1 ? null : folded;
    }

    // The one navigation this script can perform: this same route in another locale,
    // query and fragment carried over byte for byte. Already there is not a navigation --
    // and neither is a locale this page has no URL in.
    //
    // URLS is missing a locale only on a page with no twin there, which today means the
    // error page: the host serves one root error document for every unknown path, so
    // there is no English one to replace this location with (MUSE-38). Every caller
    // funnels through here, so "the choice was recorded, nothing moved" is true of all of
    // them without any branch having to know it.
    //
    // Note this comment names no path. It ships inside the page, and a URL the host
    // cannot serve is better not written there at all, even as prose.
    function go(locale) {
      var url = URLS[locale];
      if (locale === HERE || url === undefined) return;
      location.replace(url + location.search + location.hash);
    }

    var param = new URLSearchParams(location.search).get(${JSON.stringify(LANG_PARAM)});
    var requested = named(param);
    if (requested !== null) {
      // The canonical spelling, never the one that arrived: this is the only write in the
      // script, so nothing but lowercase can be in the key however it was asked for
      // (MUSE-39).
      // Its own try: a blocked localStorage must not cost the viewer the redirect.
      try { localStorage.setItem(KEY, requested); } catch (e) {}
      go(requested);
      return;
    }

    // Past here the page is being routed on an inference rather than on a request.
    if (!DETECT) return;

    var stored = null;
    try { stored = named(localStorage.getItem(KEY)); } catch (e) {}
    if (stored !== null) { go(stored); return; }

    var langs = navigator.languages || [navigator.language || ''];
    for (var i = 0; i < langs.length; i++) {
      if (/^${DEFAULT_LOCALE}\\b/i.test(langs[i])) return;
    }
    go(${JSON.stringify(MIRROR_LOCALE)});
  } catch (e) {}
})();
`.trim();
}

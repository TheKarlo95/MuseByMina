export type Theme = 'dark' | 'light' | 'system';

export const THEME_STORAGE_KEY = 'muse-theme';
export const THEMES: Theme[] = ['dark', 'light', 'system'];

/**
 * Runs as a blocking inline script in <head>, before first paint.
 *
 * Without this, the theme is stamped from a useEffect that runs after
 * hydration — so a viewer who chose light loads the dark plum page and
 * watches it flip. Design system §2 promises this resolves correctly.
 *
 * `system` deliberately stamps nothing: the CSS already resolves it via
 * prefers-color-scheme, with dark on bare :root as the brand default.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var t = localStorage.getItem('${THEME_STORAGE_KEY}');
    if (t === 'dark' || t === 'light') {
      document.documentElement.setAttribute('data-theme', t);
    }
  } catch (e) {}
})();
`.trim();

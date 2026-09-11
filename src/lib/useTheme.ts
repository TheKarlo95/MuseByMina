'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { THEME_STORAGE_KEY, type Theme } from './theme';

const listeners = new Set<() => void>();

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  // `storage` fires for other tabs; the local Set covers this one.
  window.addEventListener('storage', onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onChange);
  };
}

function getSnapshot(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === 'dark' || v === 'light' ? v : 'system';
  } catch {
    return 'system';
  }
}

// During SSR and hydration the stored choice is unknowable. The inline script
// in <head> has already painted the right theme; this only governs which
// button reads as pressed, which React reconciles right after hydration.
function getServerSnapshot(): Theme {
  return 'system';
}

export function useTheme(): [Theme, (next: Theme) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setTheme = useCallback((next: Theme) => {
    const el = document.documentElement;
    if (next === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', next);

    try {
      if (next === 'system') localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* private mode — the choice still applies for this page view */
    }
    listeners.forEach((l) => l());
  }, []);

  return [theme, setTheme];
}

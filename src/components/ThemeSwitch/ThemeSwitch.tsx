'use client';

import { THEMES, type Theme } from '@/lib/theme';
import { useTheme } from '@/lib/useTheme';
import styles from './ThemeSwitch.module.css';

const LABELS: Record<Theme, string> = {
  dark: 'Tamno',
  light: 'Svijetlo',
  system: 'Sustav',
};

/**
 * Design system §7.1: a real <button> group with aria-pressed, three states,
 * keyboard operable. Defaults to system and only stamps data-theme once the
 * viewer chooses.
 */
export function ThemeSwitch() {
  const [theme, setTheme] = useTheme();

  return (
    <div className={styles.group} role="group" aria-label="Tema">
      {THEMES.map((t) => (
        <button
          key={t}
          type="button"
          className={styles.button}
          aria-pressed={theme === t}
          onClick={() => setTheme(t)}
        >
          {LABELS[t]}
        </button>
      ))}
    </div>
  );
}

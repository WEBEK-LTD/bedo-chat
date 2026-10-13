/**
 * Light, dark or the device's setting (D-48). The choice is a cookie so the server renders the page in the right
 * theme from the first paint (app/layout.tsx); "system" removes it and the CSS follows prefers-color-scheme.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export const THEME_COOKIE = 'bedo_theme';

export function themeFromCookie(value: string | undefined): 'light' | 'dark' | undefined {
  return value === 'light' || value === 'dark' ? value : undefined;
}

export function currentTheme(): ThemeChoice {
  if (typeof document === 'undefined') return 'system';
  return themeFromCookie(document.documentElement.dataset.theme) ?? 'system';
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  const secure = window.location.protocol === 'https:' ? '; secure' : '';
  if (choice === 'system') {
    delete root.dataset.theme;
    document.cookie = `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax${secure}`;
  } else {
    root.dataset.theme = choice;
    document.cookie = `${THEME_COOKIE}=${choice}; path=/; max-age=31536000; samesite=lax${secure}`;
  }
}

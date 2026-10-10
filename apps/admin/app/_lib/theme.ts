/**
 * Admin Dashboard theme (D-48). It follows the device unless the admin picks Light or Dark with the header button;
 * the choice is kept in this browser only (the dashboard is a static page, so there is no cookie to read on the server).
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'bedo_admin_theme';
export const THEME_ORDER: ThemeChoice[] = ['system', 'light', 'dark'];

export function savedTheme(): ThemeChoice {
  try {
    const value = window.localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // Private windows may refuse storage: the choice then lasts until the page is closed.
  }
}

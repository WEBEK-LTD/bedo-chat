'use client';

import { useEffect } from 'react';
import { applyTheme, savedTheme } from '../_lib/theme';

/** Puts back the theme this admin picked in this browser (D-48), on every page including sign-in. */
export function ThemeInit() {
  useEffect(() => applyTheme(savedTheme()), []);
  return null;
}

'use client';

import { Icon, type IconName } from '@bedo/ui';
import { useState } from 'react';
import { applyTheme, currentTheme, type ThemeChoice } from '../../_lib/theme';

const CHOICES: Array<{ id: ThemeChoice; label: string; hint: string; icon: IconName }> = [
  { id: 'system', label: 'Same as this device', hint: 'Light or dark, following the device setting', icon: 'brightness_auto' },
  { id: 'light', label: 'Light', hint: 'Always light', icon: 'light_mode' },
  { id: 'dark', label: 'Dark', hint: 'Always dark', icon: 'dark_mode' },
];

/** Appearance (D-48): light, dark or the device's setting, kept on this browser. */
export function AppearancePanel() {
  const [choice, setChoice] = useState<ThemeChoice>(currentTheme);
  return (
    <div className="flex flex-col gap-3 p-4">
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm text-ink-secondary">Theme on this browser</legend>
        {CHOICES.map((item) => (
          <label
            key={item.id}
            className="flex cursor-pointer items-center gap-3 rounded-md border border-line px-3 py-3 transition-colors hover:bg-surface-hover has-[:checked]:border-accent has-[:checked]:bg-accent-soft"
          >
            <Icon name={item.icon} className="shrink-0 text-ink-secondary" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">{item.label}</span>
              <span className="text-sm text-ink-secondary">{item.hint}</span>
            </span>
            <input
              type="radio"
              name="theme"
              value={item.id}
              checked={choice === item.id}
              onChange={() => {
                applyTheme(item.id);
                setChoice(item.id);
              }}
              className="size-4"
            />
          </label>
        ))}
      </fieldset>
    </div>
  );
}

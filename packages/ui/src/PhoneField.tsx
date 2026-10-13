'use client';

import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Icon } from './Icon.js';
import { type CountryCode, countryOfInternational, DEFAULT_PHONE_COUNTRY, phoneCountries, type PhoneCountry, searchCountries, splitInternational, toInternational } from './phone.js';

const REMEMBERED = 'bedo_phone_country';

function rememberedCountry(): CountryCode {
  try {
    const value = window.localStorage.getItem(REMEMBERED);
    if (value && phoneCountries().some((country) => country.code === value)) return value as CountryCode;
  } catch {
    // Storage may be blocked: the default country is used.
  }
  return DEFAULT_PHONE_COUNTRY;
}

function remember(code: CountryCode): void {
  try {
    window.localStorage.setItem(REMEMBERED, code);
  } catch {
    // Not kept: fine.
  }
}

function Flag({ code }: { code: CountryCode }) {
  // Served by the site (apps/web/public/flags, from flag-icons, MIT): small WebP pictures, the same on every device.
  return <img src={`/flags/${code.toLowerCase()}.webp`} alt="" width={24} height={18} className="h-[18px] w-6 shrink-0 rounded-[3px] object-cover shadow-[0_0_0_1px_rgba(0,0,0,0.08)]" />;
}

export interface PhoneFieldProps {
  id: string;
  label: string;
  /** The full international number (E.164), or '' while nothing usable is typed. */
  value: string;
  onChange: (e164: string) => void;
  hint?: string;
  error?: string | null;
  autoFocus?: boolean;
  disabled?: boolean;
  autoComplete?: string;
}

/**
 * Phase 15: phone number with a country picker. The person picks a country (flag and calling code, searchable by name
 * or code; Australia first, then the last one chosen on this browser) and types only the rest of the number; the
 * national "0" in front is dropped. A whole international number typed or pasted switches the country itself.
 */
export function PhoneField({ id, label, value, onChange, hint, error, autoFocus, disabled, autoComplete = 'tel-national' }: PhoneFieldProps) {
  const [country, setCountry] = useState<CountryCode>(() => (value ? splitInternational(value, DEFAULT_PHONE_COUNTRY).country : DEFAULT_PHONE_COUNTRY));
  const [national, setNational] = useState(() => (value ? splitInternational(value, DEFAULT_PHONE_COUNTRY).national : ''));
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);

  // The remembered country, once in the browser (not during the server render).
  const startedEmpty = useRef(!value);
  useEffect(() => {
    if (startedEmpty.current) setCountry(rememberedCountry());
  }, []);

  // The form cleared the number (after adding it, say): clear the box too.
  useEffect(() => {
    if (value === '') setNational((typed) => (toInternational(typed, DEFAULT_PHONE_COUNTRY) === '' ? typed : ''));
  }, [value]);

  const current = useMemo(() => phoneCountries().find((item) => item.code === country)!, [country]);
  const matches = useMemo(() => searchCountries(query).slice(0, 80), [query]);

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const close = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  function choose(next: PhoneCountry) {
    setCountry(next.code);
    remember(next.code);
    setOpen(false);
    setQuery('');
    onChange(toInternational(national, next.code));
    input.current?.focus();
  }

  function type(text: string) {
    const whole = countryOfInternational(text);
    if (whole) {
      setCountry(whole.country);
      setNational(whole.national);
      onChange(toInternational(whole.national, whole.country));
      return;
    }
    const cleaned = text.replace(/[^\d\s()-]/g, '');
    setNational(cleaned);
    onChange(toInternational(cleaned, country));
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const pick = matches[active];
      if (pick) choose(pick);
    }
  }

  const helpId = hint || error ? `${id}-help` : undefined;
  return (
    <div className="flex flex-col gap-1.5" ref={root}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative">
        <div
          className={`flex h-[var(--bedo-control-height)] items-stretch overflow-hidden rounded-sm border bg-surface transition-[border-color,box-shadow] focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15 ${error ? 'border-danger' : 'border-line'}`}
        >
          <button
            type="button"
            disabled={disabled}
            aria-label={`Country: ${current.name} (+${current.dial})`}
            aria-haspopup="listbox"
            aria-expanded={open}
            onClick={() => {
              setOpen((value) => !value);
              setActive(0);
            }}
            className="flex shrink-0 items-center gap-1.5 border-r border-line pl-3 pr-2 text-[length:var(--bedo-font-size-md)] transition-colors hover:bg-surface-hover"
          >
            <Flag code={country} />
            <span className="tabular-nums">+{current.dial}</span>
            <Icon name="keyboard_arrow_down" size={18} className="text-ink-secondary" />
          </button>
          <input
            ref={input}
            id={id}
            type="tel"
            inputMode="tel"
            autoComplete={autoComplete}
            value={national}
            disabled={disabled}
            autoFocus={autoFocus}
            placeholder="Phone number"
            aria-invalid={error ? true : undefined}
            aria-describedby={helpId}
            onChange={(event) => type(event.target.value)}
            className="min-w-0 flex-1 bg-transparent px-3 text-[length:var(--bedo-font-size-md)] outline-none placeholder:text-ink-secondary"
          />
        </div>
        {open ? (
          <div className="bedo-fade-in absolute left-0 right-0 top-full z-30 mt-1 flex max-h-80 flex-col overflow-hidden rounded-md border border-line bg-surface shadow-raised">
            <div className="flex items-center gap-2 border-b border-line px-3">
              <Icon name="search" size={18} className="shrink-0 text-ink-secondary" />
              <input
                ref={search}
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setActive(0);
                }}
                onKeyDown={onSearchKey}
                aria-label="Search country or code"
                aria-controls={listId}
                placeholder="Search country or code"
                className="h-10 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-ink-secondary"
              />
            </div>
            <ul id={listId} role="listbox" aria-label="Countries" className="min-h-0 flex-1 overflow-y-auto py-1">
              {matches.length === 0 ? <li className="px-3 py-2 text-sm text-ink-secondary">No country found.</li> : null}
              {matches.map((item, index) => (
                <li
                  key={item.code}
                  role="option"
                  aria-selected={item.code === country}
                  onPointerEnter={() => setActive(index)}
                  onClick={() => choose(item)}
                  className={`flex cursor-pointer items-center gap-3 px-3 py-2 text-sm ${index === active ? 'bg-surface-hover' : ''}`}
                >
                  <Flag code={item.code} />
                  <span className="min-w-0 flex-1 truncate">{item.name}</span>
                  <span className="shrink-0 tabular-nums text-ink-secondary">+{item.dial}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
      {error ? (
        <p id={helpId} className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={helpId} className="text-sm text-ink-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

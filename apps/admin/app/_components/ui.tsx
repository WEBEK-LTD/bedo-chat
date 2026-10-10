'use client';

import { Icon, type IconName } from '@bedo/ui';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent shadow-sm hover:bg-accent-hover active:scale-[0.98]',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-hover active:scale-[0.98]',
  danger: 'border border-line bg-surface text-danger hover:bg-surface-hover active:scale-[0.98]',
  ghost: 'text-accent hover:bg-accent-soft',
};

export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  children,
  disabled,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={`h-[var(--bedo-control-height)] rounded-sm px-4 text-sm font-semibold transition-[background-color,transform] duration-150 disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_STYLES[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function IconButton({ icon, label, onClick }: { icon: IconName; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="grid size-10 shrink-0 place-items-center rounded-full text-ink-secondary transition-colors hover:bg-surface-hover hover:text-ink"
    >
      <Icon name={icon} />
    </button>
  );
}

export function TextField({
  label,
  id,
  hint,
  error,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string; id: string; hint?: ReactNode; error?: string | null }) {
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        {...props}
        aria-invalid={error ? true : undefined}
        aria-describedby={hint || error ? `${id}-help` : undefined}
        className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 text-[length:var(--bedo-font-size-md)] outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15 aria-[invalid=true]:border-danger"
      />
      {error ? (
        <p id={`${id}-help`} className="text-sm text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-help`} className="text-sm text-ink-secondary">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-danger">
      <Icon name="error" size={20} className="shrink-0" />
      <span>{message}</span>
    </p>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warning'; children: ReactNode }) {
  return (
    <div className={`flex items-start gap-3 rounded-md border p-3.5 text-sm ${tone === 'warning' ? 'border-danger/25 bg-danger/5' : 'border-accent/15 bg-accent-soft/70'}`}>
      <Icon name={tone === 'warning' ? 'warning' : 'info'} size={20} className={`shrink-0 ${tone === 'warning' ? 'text-danger' : 'text-accent'}`} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function TextArea({
  label,
  id,
  hint,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; id: string; hint?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        {...props}
        className="min-h-24 rounded-sm border border-line bg-surface px-3 py-2 text-sm outline-none transition-[border-color,box-shadow] focus:border-accent focus:ring-3 focus:ring-accent/15"
      />
      {hint ? <p className="text-sm text-ink-secondary">{hint}</p> : null}
    </div>
  );
}

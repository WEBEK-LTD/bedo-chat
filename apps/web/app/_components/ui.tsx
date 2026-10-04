'use client';

import { Icon, type IconName } from '@bedo/ui';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_STYLES: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover',
  secondary: 'border border-line bg-surface text-ink hover:bg-surface-hover',
  danger: 'border border-line bg-surface text-danger hover:bg-surface-hover',
  ghost: 'text-accent hover:bg-surface-hover',
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
      className={`h-[var(--bedo-control-height)] rounded-sm px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${BUTTON_STYLES[variant]} ${className}`}
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
      className="grid size-10 shrink-0 place-items-center rounded-sm text-ink-secondary hover:bg-surface-hover"
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
        className="h-[var(--bedo-control-height)] rounded-sm border border-line bg-surface px-3 text-[length:var(--bedo-font-size-md)] outline-none focus:border-accent aria-[invalid=true]:border-danger"
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
    <div className="flex items-start gap-3 rounded-md bg-surface-subtle p-3 text-sm">
      <Icon name={tone === 'warning' ? 'warning' : 'info'} size={20} className={`shrink-0 ${tone === 'warning' ? 'text-danger' : 'text-ink-secondary'}`} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Avatar({ name, photoUrl, size = 40 }: { name: string | null; photoUrl: string | null; size?: number }) {
  const initials = (name ?? '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
  return photoUrl ? (
    // A plain <img>: the picture is a short-lived signed URL from private storage.
    <img src={photoUrl} alt="" width={size} height={size} className="shrink-0 rounded-full object-cover" style={{ width: size, height: size }} />
  ) : (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full bg-accent font-medium text-on-accent"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials || <Icon name="person" size={size * 0.6} />}
    </span>
  );
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

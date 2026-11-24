import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

const control =
  "w-full rounded-md border border-line bg-surface-2 px-3 text-sm text-fg placeholder:text-fg-subtle transition-colors " +
  "focus:outline-none focus:ring-2 focus:ring-ring/60 focus:border-accent disabled:opacity-60 " +
  "aria-[invalid=true]:border-danger aria-[invalid=true]:focus:ring-danger/40";

/**
 * Accessible form field: label, control, hint and error are linked through
 * htmlFor / aria-describedby / aria-invalid.
 */
export function Field({
  label,
  name,
  error,
  hint,
  children,
  className,
}: {
  label: string;
  name: string;
  error?: string;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <label htmlFor={name} className="block text-sm font-medium text-fg">
        {label}
      </label>
      {children}
      {hint && !error && (
        <p id={`${name}-hint`} className="text-xs text-fg-subtle">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${name}-error`} role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function describedBy(name: string, error?: string, hint?: boolean) {
  if (error) return `${name}-error`;
  if (hint) return `${name}-hint`;
  return undefined;
}

export function Input({
  name,
  error,
  hasHint,
  className,
  ...props
}: ComponentProps<"input"> & { name: string; error?: string; hasHint?: boolean }) {
  return (
    <input
      id={props.id ?? name}
      name={name}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(name, error, hasHint)}
      className={cn(control, "h-10", className)}
      {...props}
    />
  );
}

export function Textarea({
  name,
  error,
  hasHint,
  className,
  ...props
}: ComponentProps<"textarea"> & { name: string; error?: string; hasHint?: boolean }) {
  return (
    <textarea
      id={props.id ?? name}
      name={name}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(name, error, hasHint)}
      className={cn(control, "min-h-24 py-2 leading-relaxed", className)}
      {...props}
    />
  );
}

export function Select({
  name,
  error,
  className,
  children,
  ...props
}: ComponentProps<"select"> & { name: string; error?: string }) {
  return (
    <select
      id={props.id ?? name}
      name={name}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy(name, error)}
      className={cn(control, "h-10 pr-8", className)}
      {...props}
    >
      {children}
    </select>
  );
}

export function Checkbox({ name, label, description, ...props }: ComponentProps<"input"> & { name: string; label: string; description?: string }) {
  return (
    <label htmlFor={name} className="flex cursor-pointer items-start gap-3 rounded-md p-1">
      <input
        id={name}
        name={name}
        type="checkbox"
        className="mt-0.5 size-4 rounded border-line bg-surface-2 accent-[rgb(var(--color-accent))]"
        {...props}
      />
      <span>
        <span className="block text-sm font-medium text-fg">{label}</span>
        {description && <span className="block text-xs text-fg-subtle">{description}</span>}
      </span>
    </label>
  );
}

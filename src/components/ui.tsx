import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Search as SearchIcon, X } from 'lucide-react';
import { cls } from '../lib/format';
import { fuzzyMatch } from '../lib/fuzzy';
import { useToasts } from '../lib/store';

// ---------------------------------------------------------------- buttons

type Variant = 'primary' | 'white' | 'glass' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-gradient-accent text-on-accent shadow-[0_8px_30px_-8px_var(--a1)] hover:brightness-110',
  white: 'bg-white text-black hover:bg-white/90',
  glass: 'glass text-fg hover:bg-white/12',
  ghost: 'text-muted hover:text-fg hover:bg-white/8',
  danger: 'bg-bad/15 text-bad hover:bg-bad/25',
  outline: 'border border-line-strong text-fg hover:bg-white/6',
};
const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2.5 rounded-2xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'glass', size = 'md', loading, icon, className, children, disabled, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cls(
        'inline-flex shrink-0 items-center justify-center font-semibold whitespace-nowrap transition-[transform,background,filter,color] duration-200 select-none active:scale-[0.97] disabled:opacity-45 disabled:active:scale-100',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean; size?: 'sm' | 'md' | 'lg' }>(
  function IconButton({ label, active, size = 'md', className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        aria-label={label}
        title={label}
        className={cls(
          'inline-flex shrink-0 items-center justify-center rounded-full transition-all duration-200 active:scale-90 disabled:opacity-40',
          size === 'sm' ? 'size-8' : size === 'lg' ? 'size-12' : 'size-10',
          active ? 'bg-white text-black' : 'text-fg hover:bg-white/10',
          className,
        )}
        {...rest}
      >
        {children}
      </button>
    );
  },
);

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cls('animate-spin text-muted', className ?? 'size-5')} />;
}

// ---------------------------------------------------------------- inputs

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cls(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors duration-300 disabled:opacity-40',
        checked ? 'bg-gradient-accent' : 'bg-white/15',
      )}
    >
      <motion.span
        layout
        transition={{ type: 'spring', stiffness: 700, damping: 35 }}
        className={cls('size-5 rounded-full bg-white shadow-md', checked ? 'ml-auto' : '')}
      />
    </button>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'md',
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  size?: 'sm' | 'md';
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cls('inline-flex rounded-full bg-white/6 p-1', className)} role="tablist">
      {options.map((o) => (
        <button
          key={o.value}
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={cls(
            'relative rounded-full font-medium whitespace-nowrap transition-colors',
            size === 'sm' ? 'px-3 py-1 text-xs' : 'px-4 py-1.5 text-sm',
            value === o.value ? 'text-black' : 'text-muted hover:text-fg',
          )}
        >
          {value === o.value && (
            <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-full bg-white" transition={{ type: 'spring', stiffness: 500, damping: 38 }} />
          )}
          <span className="relative z-10 inline-flex items-center gap-1.5">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

export function Chip({ active, onClick, children, className }: { active?: boolean; onClick?: () => void; children: ReactNode; className?: string }) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active ?? false}
      className={cls(
        'inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium whitespace-nowrap transition-all duration-200 active:scale-95',
        active ? 'border-transparent bg-white text-black' : 'border-line text-muted hover:border-line-strong hover:text-fg',
        className,
      )}
    >
      {children}
    </button>
  );
}

export function Badge({ children, tone = 'default', className }: { children: ReactNode; tone?: 'default' | 'accent' | 'ok' | 'warn' | 'bad'; className?: string }) {
  const tones = {
    default: 'bg-white/10 text-fg',
    accent: 'bg-gradient-accent text-on-accent',
    ok: 'bg-ok/15 text-ok',
    warn: 'bg-warn/15 text-warn',
    bad: 'bg-bad/15 text-bad',
  };
  return <span className={cls('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tracking-wide', tones[tone], className)}>{children}</span>;
}

const fieldBase =
  'w-full rounded-xl border border-line bg-white/[0.04] px-3.5 text-sm text-fg placeholder:text-faint transition-colors focus:border-accent/60 focus:bg-white/[0.06] focus:outline-none';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cls(fieldBase, 'h-11', className)} {...rest} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cls(fieldBase, 'min-h-24 py-2.5', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cls(fieldBase, 'h-11 appearance-none bg-[length:12px] bg-[right_14px_center] bg-no-repeat pr-9', className)} style={{ backgroundImage: CHEVRON }} {...rest}>
      {children}
    </select>
  );
}
const CHEVRON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'%3E%3Cpath d='M2 4l4 4 4-4' fill='none' stroke='%23a7a5bb' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E")`;

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  format,
  label,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  label?: string;
}) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-3">
      <input
        aria-label={label}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-white/12 [&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-white [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-white [&::-webkit-slider-thumb]:shadow"
        style={{ background: `linear-gradient(90deg, var(--a1) ${pct}%, rgb(255 255 255 / 0.12) ${pct}%)` }}
      />
      {format && <span className="w-14 shrink-0 text-right text-xs text-muted tabular-nums">{format(value)}</span>}
    </div>
  );
}

/**
 * Settings search. Inside a provider with a query, rows that don't match render nothing and matching ones
 * are marked, so CSS can hide groups and pages without a match. `all` keeps every row (its group or page matched);
 * `context` is the page and group names, so "subtitle size" finds Size under Subtitles.
 */
export const SettingsFilter = createContext<{ q: string; all?: boolean; context?: string } | null>(null);

/** The readable text of a label or hint, for searching. */
export function textOf(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (isValidElement(node)) return textOf((node.props as { children?: ReactNode }).children);
  return '';
}

/** One settings line: label + hint on the left, control on the right. */
export function Row({ label, hint, children, stack }: { label: ReactNode; hint?: ReactNode; children: ReactNode; stack?: boolean }) {
  const filter = useContext(SettingsFilter);
  const searching = Boolean(filter?.q);
  if (searching && !filter!.all && !fuzzyMatch(`${filter!.context ?? ''} ${textOf(label)} ${textOf(hint)}`, filter!.q)) return null;
  return (
    <div data-hit={searching ? '' : undefined} className={cls('flex gap-4 py-3.5', stack ? 'flex-col' : 'items-center justify-between')}>
      <div className="min-w-0">
        <div className="text-sm font-medium text-fg">{label}</div>
        {hint && <div className="mt-0.5 text-[13px] leading-snug text-faint">{hint}</div>}
      </div>
      <div className={cls(stack ? 'w-full' : 'shrink-0')}>{children}</div>
    </div>
  );
}

export function Card({ children, className, hit }: { children: ReactNode; className?: string; hit?: boolean }) {
  return (
    <div data-group="" data-hit={hit ? '' : undefined} className={cls('rounded-3xl border border-line bg-white/[0.025] p-5 sm:p-6', className)}>
      {children}
    </div>
  );
}

/** A titled card of settings rows. While searching, a matching title shows the whole group. */
export function SettingsGroup({ title, children, hint }: { title: string; children: ReactNode; hint?: ReactNode }) {
  const filter = useContext(SettingsFilter);
  const titleHit = Boolean(filter?.q && !filter.all && fuzzyMatch(`${filter.context ?? ''} ${title}`, filter.q));
  const inner = filter && (titleHit ? { ...filter, all: true } : { ...filter, context: `${filter.context ?? ''} ${title}` });
  return (
    <Card className="mb-5" hit={titleHit || Boolean(filter?.q && filter.all)}>
      <h3 className="font-display text-lg font-semibold">{title}</h3>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
      <SettingsFilter.Provider value={inner}>
        <div className="mt-2 divide-y divide-line">{children}</div>
      </SettingsFilter.Provider>
    </Card>
  );
}

/** The search box above a settings menu. */
export function SettingsSearch({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative">
      <SearchIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onChange('')}
        placeholder={placeholder}
        aria-label={placeholder}
        className={cls(fieldBase, 'h-10 pl-9')}
      />
    </div>
  );
}

export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cls('h-1 overflow-hidden rounded-full bg-white/15', className)}>
      <div className="bg-gradient-accent h-full rounded-full transition-[width] duration-200" style={{ width: `${Math.max(0, Math.min(100, value * 100))}%` }} />
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center animate-rise">
      {icon && <div className="mb-4 grid size-14 place-items-center rounded-2xl bg-white/6 text-muted">{icon}</div>}
      <h3 className="font-display text-xl font-semibold">{title}</h3>
      {children && <div className="mt-2 max-w-md text-sm leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- overlays

/** Centered dialog on desktop, bottom sheet on phones. */
export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[120] flex items-end justify-center sm:items-center sm:p-6" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            role="dialog"
            aria-modal
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 30, opacity: 0, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 900, damping: 60 }}
            className={cls(
              'glass-strong relative flex max-h-[92dvh] w-full flex-col overflow-hidden rounded-t-3xl shadow-2xl sm:rounded-3xl',
              wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
            )}
          >
            {title !== undefined && (
              <div className="flex items-center justify-between gap-3 px-6 pt-5 pb-2">
                <h2 className="font-display text-lg font-semibold">{title}</h2>
                <IconButton label="Close" size="sm" onClick={onClose}>
                  <X className="size-4" />
                </IconButton>
              </div>
            )}
            <div className="overflow-y-auto px-6 pt-2 pb-6">{children}</div>
            {footer && <div className="flex justify-end gap-2 border-t border-line px-6 py-4">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** A small anchored popover menu. */
export function Menu({
  trigger,
  children,
  align = 'right',
  width = 'w-60',
  up,
}: {
  trigger: (open: boolean, toggle: () => void) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: 'left' | 'right';
  width?: string;
  up?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      {trigger(open, () => setOpen((o) => !o))}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: up ? 6 : -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: up ? 6 : -6, scale: 0.97 }}
            transition={{ duration: 0.16 }}
            className={cls(
              'menu-surface absolute z-[90] overflow-hidden rounded-2xl p-1.5',
              width,
              align === 'right' ? 'right-0' : 'left-0',
              up ? 'bottom-full mb-2 origin-bottom' : 'top-full mt-2 origin-top',
            )}
          >
            {children(() => setOpen(false))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function MenuItem({
  icon,
  children,
  onClick,
  active,
  danger,
  hint,
}: {
  icon?: ReactNode;
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  danger?: boolean;
  hint?: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cls(
        'flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors hover:bg-white/10 focus-visible:bg-white/10',
        danger ? 'text-bad' : active ? 'font-medium text-fg' : 'text-fg/90 hover:text-fg',
      )}
    >
      {icon && <span className="grid size-5 shrink-0 place-items-center text-muted [&>svg]:size-[18px]">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="text-xs text-muted">{hint}</span>}
      {active && <Check className="size-4 text-accent" />}
    </button>
  );
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return createPortal(
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[150] flex flex-col items-center gap-2 px-4 sm:bottom-6">
      <AnimatePresence>
        {toasts.map((t) => (
          <motion.div
            key={t.id}
            layout
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="glass-strong pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl py-2.5 pr-2.5 pl-4 text-sm shadow-2xl"
          >
            <span className={cls('size-2 shrink-0 rounded-full', t.tone === 'ok' ? 'bg-ok' : t.tone === 'bad' ? 'bg-bad' : 'bg-accent')} />
            <span className="flex-1">{t.text}</span>
            {t.action && (
              <Button
                size="sm"
                variant="white"
                onClick={() => {
                  t.action!.run();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </Button>
            )}
          </motion.div>
        ))}
      </AnimatePresence>
    </div>,
    document.body,
  );
}

// ---------------------------------------------------------------- avatar

const AVATAR_COLORS: Record<string, string> = {
  red: '#e11d48',
  blue: '#3b6fe0',
  green: '#16a34a',
  amber: '#e07a0c',
  purple: '#7c3aed',
  teal: '#0d9488',
  pink: '#db2777',
  slate: '#52607a',
};
export const AVATAR_KEYS = Object.keys(AVATAR_COLORS);

export function Avatar({ avatar, name, className }: { avatar: string | null | undefined; name: string; className?: string }) {
  if (avatar?.startsWith('data:') || avatar?.startsWith('http')) {
    return <img src={avatar} alt="" className={cls('rounded-full object-cover', className ?? 'size-9')} />;
  }
  return (
    <span
      className={cls('grid shrink-0 place-items-center rounded-full font-display font-bold text-white select-none', className ?? 'size-9 text-sm')}
      style={{ background: AVATAR_COLORS[avatar ?? ''] ?? AVATAR_COLORS.purple }}
    >
      {name.trim().charAt(0).toUpperCase() || '?'}
    </span>
  );
}

export function SectionTitle({ children, action, className }: { children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cls('mb-3 flex items-end justify-between gap-4 px-5 sm:px-10', className)}>
      <h2 className="font-display text-lg font-semibold tracking-tight sm:text-xl">{children}</h2>
      {action}
    </div>
  );
}

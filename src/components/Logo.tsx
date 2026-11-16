export function LogoMark({ className = 'size-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden>
      <defs>
        <linearGradient id="nova-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--a1)" />
          <stop offset="1" stopColor="var(--a2)" />
        </linearGradient>
      </defs>
      <path
        d="M256 40c12 92 42 150 90 182 28 19 64 28 126 34-62 6-98 15-126 34-48 32-78 90-90 182-12-92-42-150-90-182-28-19-64-28-126-34 62-6 98-15 126-34 48-32 78-90 90-182z"
        fill="url(#nova-g)"
      />
    </svg>
  );
}

export function Logo() {
  return (
    <span className="flex items-center gap-2">
      <LogoMark />
      <span className="font-display text-xl font-bold tracking-tight max-sm:hidden">Nova</span>
    </span>
  );
}

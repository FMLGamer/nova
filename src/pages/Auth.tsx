import { motion } from 'motion/react';
import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowRight } from 'lucide-react';
import { api } from '../lib/api';
import { cls } from '../lib/format';
import { errorText } from '../lib/store';
import { LogoMark } from '../components/Logo';
import { Spinner } from '../components/ui';

const SECTIONS = ['Movies', 'Shows', 'Anime', 'Live TV', 'Books', 'Music'];

/** A slowly advancing scrub bar: the one bit of motion on the page. */
function Timeline() {
  return (
    <div className="relative h-8" aria-hidden>
      <div className="absolute inset-x-0 top-1/2 h-px bg-white/15" />
      <div className="absolute inset-x-0 top-1/2 flex -translate-y-1/2 justify-between">
        {Array.from({ length: 49 }).map((_, i) => (
          <span key={i} className={cls('w-px bg-white/20', i % 8 === 0 ? 'h-3' : 'h-1.5')} />
        ))}
      </div>
      <div className="absolute inset-y-0 left-0 animate-[scrub_48s_linear_infinite]">
        <span className="absolute top-1/2 -left-px h-6 w-0.5 -translate-y-1/2 bg-progress" />
      </div>
    </div>
  );
}

function AuthScene({ step, title, subtitle, children, footer }: { step: string; title: string; subtitle: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="grid min-h-dvh bg-[#08080b] lg:grid-cols-[1.15fr_1fr]">
      <style>{'@keyframes scrub { from { left: 0 } to { left: 100% } }'}</style>
      <aside className="relative flex flex-col justify-between gap-10 border-white/8 px-6 pt-8 pb-8 sm:px-12 lg:border-r lg:py-12">
        <div className="flex items-center gap-2.5">
          <LogoMark className="size-7" />
          <span className="font-display text-lg font-semibold tracking-tight">Nova</span>
        </div>
        <div className="max-lg:hidden">
          <p className="max-w-xl font-display text-[clamp(2.6rem,4.6vw,4.4rem)] leading-[0.98] font-semibold tracking-[-0.03em] text-balance">
            Everything you watch, read and listen to.
          </p>
          <div className="mt-8 flex flex-wrap gap-x-5 gap-y-2 font-mono text-[11px] tracking-[0.18em] text-white/45 uppercase">
            {SECTIONS.map((s) => (
              <span key={s}>{s}</span>
            ))}
          </div>
          <div className="mt-10 max-w-xl">
            <Timeline />
          </div>
        </div>
        <div className="font-mono text-[11px] tracking-[0.18em] text-white/35 uppercase max-lg:hidden">Self-hosted · Private · Yours</div>
      </aside>

      <main className="flex items-center px-6 pb-12 sm:px-12 lg:py-12">
        <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2 }} className="w-full max-w-sm">
          <div className="font-mono text-[11px] tracking-[0.2em] text-white/40 uppercase">{step}</div>
          <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-2 text-sm text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
          <div className="mt-8 border-t border-white/8 pt-5 text-sm text-muted">{footer}</div>
        </motion.div>
      </main>
    </div>
  );
}

function Field({ label, className, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block">
      <span className="font-mono text-[10.5px] tracking-[0.18em] text-white/45 uppercase">{label}</span>
      <input
        {...props}
        className={cls(
          'mt-1.5 block h-11 w-full rounded-md border border-white/12 bg-white/[0.03] px-3 text-[15px] text-fg transition-colors placeholder:text-white/25 hover:border-white/20 focus:border-white/60 focus:bg-white/[0.05] focus:outline-none',
          className,
        )}
      />
    </label>
  );
}

function Remember({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted select-none">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="size-4 rounded-sm accent-white" />
      Keep me signed in
    </label>
  );
}

function Submit({ busy, disabled, children }: { busy: boolean; disabled: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={disabled || busy}
      className="group mt-2 flex h-11 w-full items-center justify-between rounded-md bg-white px-4 text-[15px] font-semibold text-black transition-[opacity,transform] active:scale-[0.99] disabled:opacity-35"
    >
      {children}
      {busy ? <Spinner className="size-4" /> : <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />}
    </button>
  );
}

export function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.auth.login(username.trim(), password, remember);
      qc.setQueryData(['session'], s);
      navigate(params.get('next') || '/', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScene
      step="Sign in"
      title="Welcome back"
      subtitle="Pick up where you left off."
      footer={
        <>
          Got an invite?{' '}
          <Link to="/register" className="font-medium text-fg underline underline-offset-4 decoration-white/25 hover:decoration-white">
            Create your account
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Username" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Remember value={remember} onChange={setRemember} />
        {error && <p className="border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
        <Submit busy={busy} disabled={!username || !password}>
          Sign in
        </Submit>
      </form>
    </AuthScene>
  );
}

export function Register() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const qc = useQueryClient();
  const [inviteCode, setInvite] = useState(params.get('code') ?? '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await api.auth.register(username.trim(), password, inviteCode.trim(), remember);
      qc.setQueryData(['session'], s);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScene
      step="Create account"
      title="Join with an invite"
      subtitle="Ask the person who runs this server for a code."
      footer={
        <>
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-fg underline underline-offset-4 decoration-white/25 hover:decoration-white">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Invite code" autoFocus value={inviteCode} onChange={(e) => setInvite(e.target.value.toUpperCase())} className="font-mono tracking-[0.3em]" />
        <Field label="Username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
        <Field label="Password" type="password" autoComplete="new-password" placeholder="8 characters or more" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Remember value={remember} onChange={setRemember} />
        {error && <p className="border-l-2 border-bad pl-3 text-sm text-bad">{error}</p>}
        <Submit busy={busy} disabled={!inviteCode || !username || password.length < 8}>
          Create account
        </Submit>
      </form>
    </AuthScene>
  );
}

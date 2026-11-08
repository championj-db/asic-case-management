import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { monthYear, riskLabel, txt } from '../lib/format';

export type Row = Record<string, unknown>;

/* ---------- Session (identity + persona) ---------- */
export interface Me {
  email: string;
  userId: string;
  displayName: string;
  persona: 'Investigator' | 'Enforcement Lead' | 'Legal Counsel';
  teamId: string;
  personas: Row[];
  austrac_authorised: boolean;
  sees_all_teams: boolean;
}
export const SessionContext = createContext<{ me: Me | null; refreshMe: () => void; switchPersona: (id: string) => void }>({
  me: null,
  refreshMe: () => {},
  switchPersona: () => {},
});
export const useSession = () => useContext(SessionContext);

/* ---------- Toast ---------- */
const ToastContext = createContext<(msg: string) => void>(() => {});
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 3200);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className={`toast${msg ? ' show' : ''}`} role="status" aria-live="polite">
        {msg}
      </div>
    </ToastContext.Provider>
  );
}

/* ---------- States (SPEC 7: every screen has loading, empty and error states) ---------- */
export function Skeleton({ h = 16, w = '100%', style }: { h?: number; w?: number | string; style?: React.CSSProperties }) {
  return <div className="skeleton" style={{ height: h, width: w, ...style }} aria-hidden="true" />;
}
export function SkeletonBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="card-body stack" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} h={18} w={`${90 - i * 9}%`} />
      ))}
    </div>
  );
}
export function PageSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton h={34} w={320} />
      <div className="kpis" style={{ marginTop: 20 }}>
        {Array.from({ length: 5 }, (_, i) => (
          <div className="kpi" key={i}>
            <Skeleton h={12} w="60%" />
            <Skeleton h={28} w="40%" style={{ marginTop: 16 }} />
          </div>
        ))}
      </div>
      <section className="card">
        <SkeletonBlock rows={6} />
      </section>
    </div>
  );
}
export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong style={{ color: 'var(--fg)' }}>{title}</strong>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <strong>Couldn’t load this view</strong>
      <p>{message}</p>
      {onRetry && (
        <button className="btn" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

/* ---------- Marks ---------- */
const PROV_LABEL: Record<string, string> = { public: 'Public', synthetic: 'Synthetic', derived: 'Derived', 'de-identified': 'De-identified', uploaded: 'Uploaded' };
export function Prov({ p, title }: { p: unknown; title?: string }) {
  const k = txt(p ?? 'synthetic');
  const desc =
    title ??
    (k === 'public'
      ? 'From a published public dataset'
      : k === 'derived'
        ? 'Computed by a model or pipeline from other data'
        : k === 'synthetic'
          ? 'Generated to stand in for data that is not public'
          : k);
  return (
    <span className={`prov ${k}`} title={desc}>
      {PROV_LABEL[k] ?? k}
    </span>
  );
}
/** Every AI output is labelled with ✦, the model and the time (SPEC 8.7). */
export function AiLabel({ model, at, children }: { model?: unknown; at?: unknown; children?: ReactNode }) {
  const when = at ? new Date(txt(at)).toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <span className="ai-label">
      <span className="ai-mark" aria-hidden="true">
        ✦{' '}
      </span>
      {children ?? 'AI'}
      {model ? ` · ${txt(model)}` : ''}
      {when ? ` · ${when}` : ''}
    </span>
  );
}
export function RiskChip({ p, band, label = '12m', collapsedOn, collapseStatus }: { p: unknown; band: unknown; label?: string; collapsedOn?: unknown; collapseStatus?: unknown }) {
  if (band === 'Collapsed')
    return (
      <span className="risk-chip Collapsed" title={`${riskLabel(p, band, collapsedOn, collapseStatus)} (ASIC register). No forward probability applies.`}>
        <span className="band-mark Collapsed" aria-hidden="true" />
        Collapsed{collapsedOn ? ` · ${monthYear(collapsedOn)}` : ''}
      </span>
    );
  if (p === null || p === undefined) return <span className="risk-chip">Not scored</span>;
  return (
    <span className={`risk-chip ${txt(band)}`} title={`Collapse probability (${label}) — model output`}>
      <span className={`band-mark ${txt(band)}`} aria-hidden="true" />
      {Math.round(Number(p) * 100)}% · {txt(band)}
    </span>
  );
}
export function Restricted({ count }: { count: number }) {
  return (
    <span className="prov restricted" title="AUSTRAC-restricted. Detail is visible only to members of the authorised group.">
      Restricted{count ? ` – ${count} record${count === 1 ? '' : 's'}` : ''}
    </span>
  );
}

/** zeroBase anchors the axis at 0 (probabilities); turn it off to show movement within a narrow band (scores). */
export function Sparkline({ points, label, height = 44, zeroBase = true }: { points: number[]; label: string; height?: number; zeroBase?: boolean }) {
  if (points.length < 2) return <p className="note">Not enough history for a trend.</p>;
  const max = Math.max(...points, 0.0001);
  const min = zeroBase ? Math.min(...points, 0) : Math.min(...points) - 1;
  const span = max - min || 1;
  const pts = points.map((v, i) => `${(i / (points.length - 1)) * 220},${height - 4 - ((v - min) / span) * (height - 8)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 220 ${height}`} role="img" aria-label={label} preserveAspectRatio="none">
      <polyline points={pts} />
    </svg>
  );
}

/* ---------- Dialog ---------- */
export function Dialog({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('textarea, input, select, button')?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="card-head">
          <h3>{title}</h3>
          <button className="btn sm ghost" onClick={onClose} aria-label="Close dialog">
            Close
          </button>
        </div>
        <div className="card-body">{children}</div>
        {footer && <div className="card-body scenario-actions" style={{ borderTop: '1px solid var(--border-soft)' }}>{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- Sortable table helper ---------- */
export function useSort<T extends Row>(rows: T[], initial: string, initialDir: 'asc' | 'desc' = 'desc') {
  const [key, setKey] = useState(initial);
  const [dir, setDir] = useState<'asc' | 'desc'>(initialDir);
  const sorted = [...rows].sort((a, b) => {
    const av = a[key];
    const bv = b[key];
    if (av === bv) return 0;
    if (av === null || av === undefined) return 1;
    if (bv === null || bv === undefined) return -1;
    const r = typeof av === 'number' || !Number.isNaN(Number(av)) ? Number(av) - Number(bv) : txt(av).localeCompare(txt(bv));
    return dir === 'asc' ? r : -r;
  });
  const th = (k: string, label: string, cls = '') => (
    <th
      className={`sortable ${cls}`}
      onClick={() => {
        if (k === key) setDir(dir === 'asc' ? 'desc' : 'asc');
        else {
          setKey(k);
          setDir('desc');
        }
      }}
      aria-sort={k === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      scope="col"
    >
      {label}
      {k === key ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
    </th>
  );
  return { sorted, th };
}

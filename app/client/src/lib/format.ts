export const money = (v: unknown, digits = 1): string => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '—';
  const s = n < 0 ? '−' : '';
  const a = Math.abs(n);
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(digits)}b`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(digits)}m`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}k`;
  return `${s}$${a.toFixed(0)}`;
};

export const pct = (v: unknown, digits = 0): string =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(digits)}%`;

export const num = (v: unknown, digits = 0): string =>
  v === null || v === undefined || v === '' || Number.isNaN(Number(v))
    ? '—'
    : Number(v).toLocaleString('en-AU', { maximumFractionDigits: digits, minimumFractionDigits: digits });

const toDate = (v: unknown) => {
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

export const date = (v: unknown): string => {
  const d = v ? toDate(v) : null;
  return d ? d.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' }) : v ? txt(v) : '—';
};

export const monthYear = (v: unknown): string => {
  const d = v ? toDate(v) : null;
  return d ? d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }) : '—';
};
/** Day and month; the year is added whenever it is not the current year, so multi-year chronologies stay unambiguous. */
export const shortDate = (v: unknown): string => {
  const d = v ? toDate(v) : null;
  if (!d) return v ? txt(v) : '—';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-AU', sameYear ? { day: '2-digit', month: 'short' } : { day: '2-digit', month: 'short', year: 'numeric' });
};

export const monthLabel = (v: unknown): string => {
  const d = v ? toDate(v) : null;
  return d ? d.toLocaleDateString('en-AU', { month: 'short', year: '2-digit' }) : '—';
};

export const dateTime = (v: unknown): string => {
  const d = v ? toDate(v) : null;
  return d ? d.toLocaleString('en-AU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
};

export const ago = (v: unknown): string => {
  const d = v ? toDate(v) : null;
  if (!d) return '';
  const m = Math.round((Date.now() - d.getTime()) / 60000);
  if (m < 60) return `${Math.max(m, 1)}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
};

export const signed = (v: unknown, digits = 0): string => {
  const n = Number(v);
  if (v === null || v === undefined || v === '' || Number.isNaN(n)) return '—';
  return `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}`;
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const abbrev = (name: string) =>
  String(name)
    .replace(/\b(PTY|LTD|LIMITED|THE)\b\.?/gi, '')
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .join('')
    .slice(0, 3)
    .toUpperCase();

const KEEP_UPPER = new Set(['ABN', 'ACN', 'ASIC', 'ATO', 'APRA', 'AFS', 'NSW', 'VIC', 'QLD', 'WA', 'SA', 'NT', 'ACT', 'TAS', 'AU', 'II', 'III', 'IV']);

/** Title-case register names ("ACME SUPER PTY LTD" -> "Acme Super Pty Ltd"); leaves mixed-case strings alone. */
export const titleCase = (s: unknown): string => {
  const str = txt(s);
  if (str !== str.toUpperCase()) return str;
  return str
    .toLowerCase()
    .split(/(\s+|-)/)
    .map((w) => (KEEP_UPPER.has(w.toUpperCase()) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join('');
};

export const STAGE_LABEL = (s: unknown) => (s === 'Litigation' || s === 'Referral' ? 'Litigation / Referral' : txt(s ?? '—'));

/** Display text for an untyped row value (numbers, strings, booleans, dates; objects as JSON). */
export function txt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

/** Collapse status text: an already-collapsed entity shows the event and its date, never a probability. */
export const collapseKind = (status: unknown): string => (status === 'EXAD' ? 'External administration' : 'Deregistered');
export const riskLabel = (p: unknown, band: unknown, collapsedOn?: unknown, collapseStatus?: unknown): string => {
  if (band === 'Collapsed') return `Collapsed${collapsedOn ? ` ${date(collapsedOn)}` : ''} · ${collapseKind(collapseStatus)}`;
  if (p === null || p === undefined) return 'Not scored';
  return `${Math.round(Number(p) * 100)}% · ${txt(band)}`;
};

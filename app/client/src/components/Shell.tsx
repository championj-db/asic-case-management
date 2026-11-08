import { useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { api, useApi } from '../lib/api';
import { initials, titleCase, txt } from '../lib/format';
import { useSession, type Row } from './common';

interface NavCounts {
  my_work: number;
  cases: number;
  portfolio: number;
  entities: number;
  intake: number;
  admin: number;
}

const compact = (n: number | undefined) => (n === undefined ? '' : n >= 1000 ? `${Math.round(n / 1000)}k` : txt(n).padStart(2, '0'));

export function Shell({ children }: { children: ReactNode }) {
  const { me, switchPersona } = useSession();
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const location = useLocation();
  const counts = useApi<NavCounts>(me ? `/api/nav-counts?p=${me.userId}&l=${location.pathname.split('/')[1]}` : null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  // The menu belongs to the page it was opened on, so navigating closes it without an effect
  const menu = menuAt === location.pathname;
  const setMenu = (open: boolean | ((m: boolean) => boolean)) => {
    const next = typeof open === 'function' ? open(menu) : open;
    setMenuAt(next ? location.pathname : null);
  };

  const c = counts.data;
  const item = (to: string, label: string, count?: string) => (
    <NavLink to={to} className={({ isActive }) => (isActive ? 'active' : '')}>
      <span>{label}</span>
      <span className="count">{count}</span>
    </NavLink>
  );

  return (
    <div className="app">
      <div className="classification" data-od-id="classification-banner">
        OFFICIAL: Sensitive · Public, synthetic and derived data — provenance shown on every record
      </div>
      <header className="topbar" data-od-id="application-header">
        <div className="brand" data-od-id="brand">
          <span className="crest">ASIC</span>
          <span>Case Management</span>
        </div>
        <input
          className="search"
          data-od-id="global-search"
          aria-label="Search cases, entities and evidence"
          placeholder="Search cases, entities and evidence · Ctrl+K"
          readOnly
          onFocus={(e) => {
            e.currentTarget.blur();
            setPalette(true);
          }}
          onClick={() => setPalette(true)}
        />
        <div className="user">
          <div className="user-copy">
            <strong>{me?.displayName ?? '…'}</strong>
            <small>
              {me?.persona ?? ''}
              {me?.austrac_authorised ? ' · AUSTRAC authorised' : ''}
            </small>
          </div>
          <button className="avatar" aria-label="Open user menu" aria-expanded={menu} data-od-id="user-menu" onClick={() => setMenu((m) => !m)}>
            {me ? initials(me.displayName) : ''}
          </button>
        </div>
        {menu && me && (
          <div className="menu" role="menu">
            <div className="menu-label">Signed in</div>
            <div style={{ padding: '0 12px 8px' }} className="small muted">
              {me.email}
            </div>
            <div className="menu-label">Act as demo persona (audited)</div>
            {me.personas
              .filter((p) => ['u.investigator1', 'u.lead1', 'u.counsel1', 'u.investigator3', 'u.lead3'].includes(txt(p.user_id)))
              .map((p: Row) => (
                <button
                  key={txt(p.user_id)}
                  role="menuitemradio"
                  aria-checked={p.user_id === me.userId}
                  className={p.user_id === me.userId ? 'active' : ''}
                  onClick={() => switchPersona(txt(p.user_id))}
                >
                  <strong>{txt(p.display_name)}</strong>
                  <small>
                    {txt(p.persona)} · Team {txt(p.team_id)}
                  </small>
                </button>
              ))}
            <NavLink to="/sources" className="link" style={{ display: 'block', padding: 12 }}>
              Data sources &amp; provenance
            </NavLink>
          </div>
        )}
      </header>
      <div className="shell">
        <aside className="sidebar" data-od-id="primary-navigation">
          <div className="nav-group">
            <div className="nav-label">Workspace</div>
            <nav className="nav" aria-label="Primary">
              {item('/my-work', 'My Work', compact(c?.my_work))}
              {item('/executive', 'Executive Briefing', 'Live')}
              {item('/portfolio', 'Portfolio', compact(c?.portfolio))}
              {item('/cases', 'Cases', compact(c?.cases))}
              {item('/entities', 'Entities', compact(c?.entities))}
              {item('/intake', 'Intake Queue', compact(c?.intake))}
            </nav>
          </div>
          <div className="nav-group">
            <div className="nav-label">System</div>
            <nav className="nav" aria-label="System">
              {item('/admin', 'Admin', compact(c?.admin))}
              {item('/sources', 'Data sources')}
            </nav>
          </div>
        </aside>
        <main className="content" data-od-id="application-views" id="main">
          {children}
        </main>
      </div>
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
    </div>
  );
}

interface SearchResult {
  cases: Row[];
  entities: Row[];
  evidence: Row[];
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [res, setRes] = useState<SearchResult>({ cases: [], entities: [], evidence: [] });
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => {
    if (q.trim().length < 2) return;
    const t = window.setTimeout(() => {
      api.get<SearchResult>(`/api/search?q=${encodeURIComponent(q)}`).then(setRes).catch(() => undefined);
    }, 160);
    return () => window.clearTimeout(t);
  }, [q]);

  const shown = q.trim().length >= 2 ? res : { cases: [], entities: [], evidence: [] };
  const items = [
    ...shown.cases.map((c) => ({ group: 'Cases', label: txt(c.title), meta: `${txt(c.case_number)} · ${txt(c.stage)}`, to: `/cases/${txt(c.case_id)}/overview` })),
    ...shown.entities.map((e) => ({ group: 'Entities', label: titleCase(e.name), meta: `${txt(e.entity_type)}${e.abn_acn ? ` · ACN ${txt(e.abn_acn)}` : ''}`, to: `/entities/${txt(e.entity_id)}` })),
    ...shown.evidence.map((e) => ({ group: 'Evidence', label: txt(e.filename), meta: txt(e.doc_type), to: `/cases/${txt(e.case_id)}/evidence?doc=${txt(e.evidence_id)}` })),
  ];
  const go = (to: string) => {
    void navigate(to);
    onClose();
  };
  let lastGroup = '';
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search">
        <input
          ref={input}
          value={q}
          placeholder="Search cases, entities (name or ACN) and evidence…"
          aria-label="Search"
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, items.length - 1));
            if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
            if (e.key === 'Enter' && items[active]) go(items[active].to);
          }}
        />
        <div className="palette-results" role="listbox">
          {q.trim().length < 2 && <p className="note" style={{ padding: 12 }}>Type at least two characters. ↑↓ to move, Enter to open, Esc to close.</p>}
          {q.trim().length >= 2 && items.length === 0 && <p className="note" style={{ padding: 12 }}>No matches.</p>}
          {items.map((it, i) => {
            const header = it.group !== lastGroup ? <div className="palette-group">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={`${it.to}-${i}`}>
                {header}
                <button className={`palette-item${i === active ? ' active' : ''}`} role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => go(it.to)}>
                  <strong>{it.label}</strong>
                  <small className="muted">{it.meta}</small>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

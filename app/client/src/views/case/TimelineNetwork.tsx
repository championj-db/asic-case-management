import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { api, useApi } from '../../lib/api';
import { date, monthLabel, pct, shortDate, titleCase, txt } from '../../lib/format';
import { AiLabel, Empty, ErrorState, Prov, RiskChip, SkeletonBlock, useToast, type Row } from '../../components/common';

/** Selection shared between Timeline and Network (SPEC 7 S4.3: selecting a node highlights its events). */
const selKey = (caseId: string) => `asic.sel.${caseId}`;
const getSel = (caseId: string) => sessionStorage.getItem(selKey(caseId));
const putSel = (caseId: string, id: string | null) => (id ? sessionStorage.setItem(selKey(caseId), id) : sessionStorage.removeItem(selKey(caseId)));

const LANE_OF: Record<string, string> = {
  silver_case: 'Case',
  silver_company_status_history: 'ASIC register',
  silver_published_notice: 'Published notices',
  silver_breach_report: 'Reports & alerts',
  silver_enforcement_alternative: 'Prior enforcement',
  silver_evidence_extraction: 'Evidence (confirmed)',
};

/* ---------------- S4.3 Timeline ---------------- */
export function TimelineTab({ caseId }: { caseId: string }) {
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ events: Row[]; suggested: Row[]; entities: Row[] }>(`/api/cases/${caseId}/timeline`);
  const [groupBy, setGroupBy] = useState<'source' | 'entity'>('source');
  const [selEvent, setSelEvent] = useState<Row | null>(null);
  const [types, setTypes] = useState<Set<string>>(new Set());
  const selectedEntity = getSel(caseId);

  const events = useMemo(() => (data?.events ?? []).filter((e) => !types.has(txt(e.event_type))), [data, types]);
  const allTypes = useMemo(() => [...new Set((data?.events ?? []).map((e) => txt(e.event_type)))].sort(), [data]);
  const names = new Map((data?.entities ?? []).map((e) => [txt(e.entity_id), titleCase(e.name)]));

  const review = async (e: Row, status: string) => {
    try {
      await api.post(`/api/events/${txt(e.event_id)}/review`, { status });
      reload();
    } catch (err) {
      toast((err as Error).message);
    }
  };
  const exportCsv = () => {
    const rows = [['date', 'type', 'description', 'source', 'evidence', 'provenance'], ...events.map((e) => [txt(e.event_date).slice(0, 10), txt(e.event_type), txt(e.description), txt(e.source), ((e.evidence_ids as string[]) ?? []).join(' '), txt(e.provenance)])];
    const csv = rows.map((r) => r.map((v) => `"${v.replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${caseId}-chronology.csv`;
    a.click();
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <section className="card"><SkeletonBlock rows={8} /></section>;

  const times = events.map((e) => new Date(txt(e.event_date)).getTime()).filter((t) => !Number.isNaN(t));
  const t0 = Math.min(...times);
  const t1 = Math.max(...times, t0 + 86400000);
  const lanes = groupBy === 'source'
    ? [...new Set(events.map((e) => LANE_OF[txt(e.source)] ?? txt(e.source)))]
    : [...new Set(events.flatMap((e) => ((e.entity_ids as string[]) ?? []).slice(0, 1)))];
  const laneOf = (e: Row) => (groupBy === 'source' ? LANE_OF[txt(e.source)] ?? txt(e.source) : ((e.entity_ids as string[]) ?? [])[0]);
  const W = 1000;
  const LH = 46;
  const left = 170;
  const x = (t: number) => left + ((t - t0) / (t1 - t0)) * (W - left - 20);
  const H = lanes.length * LH + 40;
  const months: number[] = [];
  const m = new Date(t0);
  m.setDate(1);
  while (m.getTime() <= t1) {
    months.push(m.getTime());
    m.setMonth(m.getMonth() + 3);
  }
  const bins = Array.from({ length: 40 }, () => 0);
  times.forEach((t) => bins[Math.min(39, Math.floor(((t - t0) / (t1 - t0)) * 40))]++);
  const binMax = Math.max(...bins, 1);

  return (
    <section className="case-panel active" data-od-id="timeline-panel">
      <div className="decision-bar">
        <div><h2>Chronology</h2><p>Confirmed events by lane, with links to supporting evidence. {selectedEntity ? `Highlighting events for ${names.get(selectedEntity) ?? selectedEntity} (selected on the Network tab).` : ''}</p></div>
        <div className="header-actions">
          <div className="search-mode" role="group" aria-label="Group lanes by">
            <button className={groupBy === 'source' ? 'on' : ''} onClick={() => setGroupBy('source')}>By source</button>
            <button className={groupBy === 'entity' ? 'on' : ''} onClick={() => setGroupBy('entity')}>By entity</button>
          </div>
          <button className="btn" onClick={exportCsv}>Export chronology</button>
        </div>
      </div>
      <section className="card">
        <div className="table-tools">
          <span className="small muted">Event types:</span>
          {allTypes.map((t) => (
            <button key={t} className={`tag${types.has(t) ? '' : ' on'}`} aria-pressed={!types.has(t)} onClick={() => { const n = new Set(types); if (n.has(t)) n.delete(t); else n.add(t); setTypes(n); }}>{t}</button>
          ))}
        </div>
        {events.length === 0 ? <Empty title="No confirmed events">Confirm AI-suggested events below or on the Evidence tab.</Empty> : (
          <div className="card-body lanes">
            <svg className="lane-svg" viewBox={`0 0 ${W} ${H + 50}`} width="100%" role="img" aria-label="Case chronology swim lanes">
              {lanes.map((l, i) => (
                <g key={l}>
                  <line x1={left} x2={W - 10} y1={i * LH + 30} y2={i * LH + 30} stroke="var(--border-soft)" />
                  <text x={0} y={i * LH + 34}>{groupBy === 'entity' ? (names.get(l) ?? l).slice(0, 26) : l}</text>
                </g>
              ))}
              <g className="axis">
                {months.map((t) => (
                  <g key={t}>
                    <line x1={x(t)} x2={x(t)} y1={10} y2={H - 6} stroke="var(--border-soft)" strokeDasharray="2 4" />
                    <text x={x(t)} y={H + 6} textAnchor="middle">{monthLabel(t)}</text>
                  </g>
                ))}
              </g>
              {events.map((e) => {
                const li = lanes.indexOf(laneOf(e));
                const t = new Date(txt(e.event_date)).getTime();
                const hl = selectedEntity && ((e.entity_ids as string[]) ?? []).includes(selectedEntity);
                return (
                  <g key={txt(e.event_id)} className={`ev${selEvent?.event_id === e.event_id ? ' sel' : ''}`} onClick={() => setSelEvent(e)} tabIndex={0} onKeyDown={(k) => k.key === 'Enter' && setSelEvent(e)} role="button" aria-label={`${txt(e.event_type)} on ${date(e.event_date)}`}>
                    <circle cx={x(t)} cy={li * LH + 30} r={e.ai_flag ? 7 : 6} fill={e.ai_flag ? 'var(--viz-8)' : hl ? 'var(--accent)' : 'var(--viz-2)'} stroke="var(--surface)" strokeWidth={2} />
                  </g>
                );
              })}
              <g transform={`translate(0, ${H + 18})`}>
                <text x={0} y={18} className="small" fill="var(--muted)">Density</text>
                {bins.map((b, i) => (
                  <rect key={i} x={left + (i * (W - left - 20)) / 40} width={(W - left - 20) / 40 - 2} y={28 - (b / binMax) * 26} height={(b / binMax) * 26} fill="var(--viz-10)" />
                ))}
              </g>
            </svg>
          </div>
        )}
        {selEvent && (
          <div className="card-body" style={{ borderTop: '1px solid var(--border-soft)' }}>
            <div className="spread">
              <div><strong>{txt(selEvent.event_type)}</strong> · {date(selEvent.event_date)} <Prov p={selEvent.provenance} /> {selEvent.ai_flag ? <AiLabel>Confirmed from evidence</AiLabel> : null}</div>
              <button className="btn sm ghost" onClick={() => setSelEvent(null)}>Close</button>
            </div>
            <p style={{ marginTop: 6 }}>{txt(selEvent.description)}</p>
            <div className="row" style={{ marginTop: 6 }}>
              {((selEvent.evidence_ids as string[]) ?? []).map((ev) => <a key={ev} className="citation" href={`/cases/${caseId}/evidence?doc=${ev}`}>{ev}</a>)}
              <span className="small muted">Source: {txt(selEvent.source)}</span>
            </div>
          </div>
        )}
        <table className="sr-only"><caption>Chronology</caption><tbody>{events.map((e) => <tr key={txt(e.event_id)}><td>{txt(e.event_date)}</td><td>{txt(e.event_type)}</td><td>{txt(e.description)}</td></tr>)}</tbody></table>
      </section>
      <section className="card" style={{ marginTop: 20 }}>
        <div className="card-head"><h3>✦ Suggested events from evidence</h3><span className="ai-label">{data?.suggested.length ?? 0} awaiting review</span></div>
        {(data?.suggested.length ?? 0) === 0 ? <Empty title="Nothing to review" /> : (
          <table className="data-table">
            <thead><tr><th>Date</th><th>Event</th><th>Evidence</th><th /></tr></thead>
            <tbody>
              {data?.suggested.slice(0, 40).map((e) => (
                <tr key={txt(e.event_id)}>
                  <td className="mono nowrap">{shortDate(e.event_date)}</td>
                  <td>{txt(e.description)}</td>
                  <td>{((e.evidence_ids as string[]) ?? []).map((ev) => <a key={ev} className="citation" href={`/cases/${caseId}/evidence?doc=${ev}`}>{ev}</a>)}</td>
                  <td className="right nowrap">
                    <button className="btn sm" onClick={() => review(e, 'confirmed')}>Confirm</button>{' '}
                    <button className="btn sm ghost" onClick={() => review(e, 'rejected')}>Reject</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}

/* ---------------- S4.4 Network ---------------- */
interface Net {
  nodes: Row[];
  edges: Row[];
  annotations: Row[];
  truncated: boolean;
}
const REL_LABEL: Record<string, string> = { officer_of: 'Officer of', shares_director: 'Shares a director', co_director: 'Co-director', shares_business_name: 'Shares business name', possible_match: 'Possible banned match' };
const REL_TYPES = Object.keys(REL_LABEL);

/** Small deterministic force layout (≤ 60 nodes): repulsion, spring edges, gentle gravity. */
function layout(nodes: Row[], edges: Row[], seeds: Set<string>) {
  const pos = new Map<string, { x: number; y: number }>();
  nodes.forEach((n, i) => {
    const a = (i / Math.max(nodes.length, 1)) * Math.PI * 2;
    const r = seeds.has(txt(n.id)) ? 60 : 200;
    pos.set(txt(n.id), { x: 500 + Math.cos(a) * r, y: 260 + Math.sin(a) * r * 0.6 });
  });
  for (let it = 0; it < 220; it++) {
    const disp = new Map<string, { x: number; y: number }>();
    nodes.forEach((n) => disp.set(txt(n.id), { x: 0, y: 0 }));
    for (const a of nodes) {
      for (const b of nodes) {
        if (a === b) continue;
        const pa = pos.get(txt(a.id))!;
        const pb = pos.get(txt(b.id))!;
        const dx = pa.x - pb.x;
        const dy = pa.y - pb.y;
        const d2 = Math.max(dx * dx + dy * dy, 25);
        const f = 5200 / d2;
        const da = disp.get(txt(a.id))!;
        da.x += dx * f * 0.05;
        da.y += dy * f * 0.05;
      }
    }
    for (const e of edges) {
      const pa = pos.get(txt(e.from_entity));
      const pb = pos.get(txt(e.to_entity));
      if (!pa || !pb) continue;
      const dx = pb.x - pa.x;
      const dy = pb.y - pa.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (d - 110) * 0.02;
      disp.get(txt(e.from_entity))!.x += (dx / d) * f * 10;
      disp.get(txt(e.from_entity))!.y += (dy / d) * f * 10;
      disp.get(txt(e.to_entity))!.x -= (dx / d) * f * 10;
      disp.get(txt(e.to_entity))!.y -= (dy / d) * f * 10;
    }
    const cool = 1 - it / 240;
    for (const n of nodes) {
      const p = pos.get(txt(n.id))!;
      const d = disp.get(txt(n.id))!;
      d.x += (500 - p.x) * 0.01;
      d.y += (260 - p.y) * 0.015;
      const m = Math.sqrt(d.x * d.x + d.y * d.y) || 1;
      const step = Math.min(m, 18 * cool);
      p.x = Math.min(960, Math.max(40, p.x + (d.x / m) * step));
      p.y = Math.min(490, Math.max(30, p.y + (d.y / m) * step));
    }
  }
  return pos;
}

/**
 * Label placement in priority order (case parties, selection / path, then most-connected). A label that would overlap a
 * placed label or another node is left for hover / focus, which keeps dense neighbourhoods readable.
 */
function placeLabels(nodes: Row[], pos: Map<string, { x: number; y: number }>, radius: (n: Row) => number, pinned: Set<string>) {
  const boxes: { x1: number; y1: number; x2: number; y2: number }[] = nodes.map((n) => {
    const p = pos.get(txt(n.id))!;
    const r = radius(n);
    return { x1: p.x - r, y1: p.y - r, x2: p.x + r, y2: p.y + r };
  });
  const prio = (n: Row) => (n.role === 'respondent' ? 0 : n.role ? 1 : pinned.has(txt(n.id)) ? 2 : 3);
  const order = [...nodes].sort((a, b) => prio(a) - prio(b) || Number(b.degree) - Number(a.degree));
  const shown = new Set<string>();
  for (const n of order) {
    const p = pos.get(txt(n.id))!;
    const w = Math.min(titleCase(n.name).length, 24) * 6.4;
    const y = p.y + radius(n) + 4;
    const box = { x1: p.x - w / 2, y1: y, x2: p.x + w / 2, y2: y + 13 };
    const own = boxes[nodes.indexOf(n)];
    const hit = boxes.some((b) => b !== own && box.x1 < b.x2 && box.x2 > b.x1 && box.y1 < b.y2 && box.y2 > b.y1);
    if (!hit || prio(n) === 0) {
      shown.add(txt(n.id));
      boxes.push(box);
    }
  }
  return shown;
}

function shortestPath(edges: Row[], a: string, b: string): string[] {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const f = txt(e.from_entity);
    const t = txt(e.to_entity);
    adj.set(f, [...(adj.get(f) ?? []), t]);
    adj.set(t, [...(adj.get(t) ?? []), f]);
  }
  const prev = new Map<string, string | null>([[a, null]]);
  const q = [a];
  while (q.length) {
    const n = q.shift()!;
    if (n === b) break;
    for (const m of adj.get(n) ?? []) if (!prev.has(m)) { prev.set(m, n); q.push(m); }
  }
  if (!prev.has(b)) return [];
  const path: string[] = [];
  for (let c: string | null = b; c; c = prev.get(c) ?? null) path.unshift(c);
  return path;
}

export function NetworkTab({ caseId }: { caseId: string }) {
  const nav = useNavigate();
  const toast = useToast();
  const [expand, setExpand] = useState<string[]>([]);
  const [rel, setRel] = useState<string[]>([]);
  const [depth, setDepth] = useState(1);
  const url = `/api/cases/${caseId}/network?depth=${depth}&expand=${expand.join(',')}&rel=${rel.join(',')}`;
  const { data, error, loading, reload } = useApi<Net>(url);
  const [sel, setSelState] = useState<string | null>(getSel(caseId));
  const [pathFrom, setPathFrom] = useState<string | null>(null);
  const [pathState, setPathState] = useState<{ on: Net | null; path: string[] }>({ on: null, path: [] });
  const path = pathState.on === data ? pathState.path : [];
  const setPath = (p: string[]) => setPathState({ on: data, path: p });
  const [groupPeople, setGroupPeople] = useState(false);
  const [note, setNote] = useState('');
  const setSel = (id: string | null) => {
    setSelState(id);
    putSel(caseId, id);
  };

  const view = useMemo(() => {
    if (!data) return null;
    let nodes = data.nodes;
    let edges = data.edges;
    if (groupPeople) {
      const people = new Set(nodes.filter((n) => n.type === 'person' && !n.role).map((n) => txt(n.id)));
      if (people.size > 1) {
        nodes = [...nodes.filter((n) => !people.has(txt(n.id))), { id: 'GROUP-people', name: `${people.size} officers (grouped)`, type: 'group', degree: people.size, role: null }];
        edges = edges.map((e) => ({ ...e, from_entity: people.has(txt(e.from_entity)) ? 'GROUP-people' : e.from_entity, to_entity: people.has(txt(e.to_entity)) ? 'GROUP-people' : e.to_entity })).filter((e) => e.from_entity !== e.to_entity);
      }
    }
    const seeds = new Set(nodes.filter((n) => n.role).map((n) => txt(n.id)));
    return { nodes, edges, pos: layout(nodes, edges, seeds) };
  }, [data, groupPeople]);


  const addNote = async () => {
    try {
      await api.post(`/api/cases/${caseId}/annotations`, { entity_id: sel, label: note });
      setNote('');
      toast('Annotation added to this case only · source data unchanged');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  if (error) return <ErrorState message={error} onRetry={reload} />;
  const selNode = view?.nodes.find((n) => n.id === sel);
  const maxDeg = Math.max(...(view?.nodes.map((n) => Number(n.degree)) ?? [1]), 1);
  const onPath = new Set(path);
  const radius = (n: Row) => 14 + (Number(n.degree) / maxDeg) * 22 + (n.role === 'respondent' ? 8 : 0);
  const labelled = view ? placeLabels(view.nodes, view.pos, radius, new Set([...path, ...(sel ? [sel] : [])])) : new Set<string>();
  const pathEdge = (e: Row) => {
    const i = path.indexOf(txt(e.from_entity));
    return i >= 0 && (path[i + 1] === e.to_entity || path[i - 1] === e.to_entity);
  };

  return (
    <section className="case-panel active" data-od-id="network-panel">
      <div className="decision-bar">
        <div><h2>Entities &amp; Network</h2><p>Resolved parties, officers and related companies. Node size = connections in view; ring = collapse risk (not identity confidence). Annotations never change source data.</p></div>
        <div className="header-actions">
          <button className="btn" disabled={!sel} onClick={() => { if (pathFrom && sel && pathFrom !== sel && view) { const p = shortestPath(view.edges, pathFrom, sel); setPath(p); setPathFrom(null); if (!p.length) toast('No path between those entities in this view'); } else { setPathFrom(sel); toast('Now select the second entity, then Find path again'); } }}>
            {pathFrom ? 'Find path to…' : 'Find path'}
          </button>
          <button className="btn primary" disabled={!sel || txt(sel).startsWith('GROUP')} onClick={() => sel && setExpand([...new Set([...expand, sel])])}>Expand one hop</button>
        </div>
      </div>
      <section className="card">
        <div className="table-tools">
          <span className="small muted">Relationships:</span>
          {REL_TYPES.map((r) => (
            <button key={r} className={`tag${rel.length === 0 || rel.includes(r) ? ' on' : ''}`} onClick={() => setRel(rel.includes(r) ? rel.filter((x) => x !== r) : [...rel, r])}>{REL_LABEL[r]}</button>
          ))}
          <select className="select" value={depth} onChange={(e) => setDepth(Number(e.target.value))} aria-label="Depth"><option value={1}>1 hop</option><option value={2}>2 hops</option></select>
          <label className="row small"><input type="checkbox" checked={groupPeople} onChange={(e) => setGroupPeople(e.target.checked)} /> Group officers</label>
          {expand.length > 0 && <button className="btn sm ghost" onClick={() => setExpand([])}>Reset expansion</button>}
        </div>
        <div className="network">
          {loading && !data ? <SkeletonBlock rows={10} /> : view && view.nodes.length === 0 ? <Empty title="No relationships found" /> : view && (
            <svg viewBox="0 0 1000 520" role="img" aria-label="Entity relationship network">
              {view.edges.map((e, i) => {
                const a = view.pos.get(txt(e.from_entity));
                const b = view.pos.get(txt(e.to_entity));
                if (!a || !b) return null;
                return <line key={i} className={`edge${pathEdge(e) ? ' path' : ''}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={pathEdge(e) ? 3 : 1 + Math.min(Number(e.weight ?? 1), 3) * 0.5} strokeDasharray={e.rel_type === 'possible_match' ? '4 4' : undefined}><title>{REL_LABEL[txt(e.rel_type)] ?? txt(e.rel_type)}</title></line>;
              })}
              {view.nodes.map((n) => {
                const p = view.pos.get(txt(n.id))!;
                const r = radius(n);
                const risk = n.p_collapse_12m === null || n.p_collapse_12m === undefined ? null : Number(n.p_collapse_12m);
                const ring = n.risk_band === 'Collapsed' ? 'var(--fg)' : risk === null ? 'var(--border)' : risk > 0.6 ? 'var(--danger)' : risk > 0.35 ? 'var(--viz-9)' : risk > 0.15 ? 'var(--warn)' : 'var(--success)';
                return (
                  <g key={txt(n.id)} className={`node-g${sel === n.id ? ' sel' : ''}`} transform={`translate(${p.x},${p.y})`} onClick={() => setSel(txt(n.id))} onDoubleClick={() => n.type !== 'group' && !txt(n.id).startsWith('BAN-') && nav(`/entities/${txt(n.id)}`)} tabIndex={0} role="button" aria-label={`${titleCase(n.name)}${n.role ? `, ${txt(n.role)}` : ''}`} onKeyDown={(k) => k.key === 'Enter' && setSel(txt(n.id))}>
                    <circle className="core" r={r} fill="var(--surface)" stroke={sel === n.id || onPath.has(txt(n.id)) ? 'var(--accent)' : ring} strokeWidth={n.role ? 6 : 4} />
                    {n.type === 'person' && <circle r={4} fill="var(--muted)" />}
                    <title>{titleCase(n.name)}</title>
                    <text className={`n-label${labelled.has(txt(n.id)) || sel === n.id || onPath.has(txt(n.id)) ? '' : ' minor'}`} y={r + 13} textAnchor="middle">{titleCase(n.name).slice(0, 24)}</text>
                  </g>
                );
              })}
            </svg>
          )}
        </div>
        <div className="network-legend">
          <span>Ring: <span className="band-mark Low" />Low <span className="band-mark Elevated" />Elevated <span className="band-mark High" />High/Critical risk · grey = not scored</span>
          <span>Thick ring = case party · dot = person · dashed edge = unconfirmed possible match</span>
          {data?.truncated && <span className="trend-up">View truncated at 60 entities — filter relationships or expand selectively</span>}
          <span>Double-click a node for Entity 360</span>
        </div>
        {selNode && (
          <div className="card-body" style={{ borderTop: '1px solid var(--border-soft)' }}>
            <div className="spread">
              <div>
                <strong>{titleCase(selNode.name)}</strong> <span className="muted small">{txt(selNode.type)}{selNode.role ? ` · ${txt(selNode.role)}` : ''}</span>{' '}
                <Prov p={selNode.provenance} />{' '}
                {selNode.match_confidence !== null && selNode.match_confidence !== undefined && <span className="badge">Identity {pct(selNode.match_confidence)}</span>}{' '}
                <RiskChip p={selNode.p_collapse_12m} band={selNode.risk_band} collapsedOn={selNode.risk_collapse_date} collapseStatus={selNode.risk_collapse_status} />
              </div>
              {selNode.type !== 'group' && !txt(selNode.id).startsWith('BAN-') && <button className="btn sm" onClick={() => nav(`/entities/${txt(selNode.id)}`)}>Entity 360</button>}
            </div>
            <div className="row" style={{ marginTop: 10 }}>
              <input className="number" style={{ flex: 1 }} placeholder="Case-local annotation, e.g. “Controls transfer account per EV-291”" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Annotation" />
              <button className="btn" disabled={!note.trim()} onClick={addNote}>Annotate</button>
            </div>
          </div>
        )}
        {(data?.annotations.length ?? 0) > 0 && (
          <div className="card-body" style={{ borderTop: '1px solid var(--border-soft)' }}>
            <span className="ai-label">Case annotations</span>
            <div className="list">{data?.annotations.map((a) => <div className="list-item" key={txt(a.annotation_id)}><div><strong>{txt(a.label)}</strong><small>{txt(a.entity_id ?? 'case')} · {txt(a.created_by)}</small></div><small>{shortDate(a.created_at)}</small></div>)}</div>
          </div>
        )}
        <table className="data-table">
          <thead><tr><th>Entity</th><th>Role / type</th><th>Relationship</th><th className="num">Connections</th><th className="num">Risk</th></tr></thead>
          <tbody>
            {view?.nodes.slice().sort((a, b) => Number(b.degree) - Number(a.degree)).slice(0, 30).map((n) => {
              const e = view.edges.find((x) => x.from_entity === n.id || x.to_entity === n.id);
              return (
                <tr key={txt(n.id)} className={`clickable${sel === n.id ? ' selected' : ''}`} onClick={() => setSel(txt(n.id))}>
                  <td>{titleCase(n.name)}</td>
                  <td>{txt(n.role ?? n.type)}</td>
                  <td>{e ? REL_LABEL[txt(e.rel_type)] ?? txt(e.rel_type) : '—'} {e ? <Prov p={e.provenance} /> : null}</td>
                  <td className="num">{txt(n.degree)}</td>
                  <td className="num">{n.risk_band === 'Collapsed' ? 'Collapsed' : pct(n.p_collapse_12m)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </section>
  );
}

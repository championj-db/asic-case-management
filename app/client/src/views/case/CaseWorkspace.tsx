import { useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router';
import { api, useApi } from '../../lib/api';
import { date, dateTime, money, riskLabel, shortDate, STAGE_LABEL, titleCase, txt } from '../../lib/format';
import { AiLabel, Dialog, Empty, ErrorState, PageSkeleton, Prov, RiskChip, SkeletonBlock, useSession, useToast, type Row } from '../../components/common';
import { EvidenceTab } from './EvidenceTab';
import { NetworkTab, TimelineTab } from './TimelineNetwork';
import { ScoringTab } from './ScoringTab';
import { BriefTab } from './BriefTab';

export interface CaseDetail {
  case: Row & { criteria: Row | null; stage_index: number };
  stages: string[];
  parties: Row[];
  recent_events: Row[];
  budget: Row[];
  open_tasks: number;
  evidence_count: number;
  extractions_pending: number;
  next_key_date: Row | null;
  latest_decision: Row | null;
}

const TABS: [string, string][] = [
  ['overview', 'Overview'],
  ['evidence', 'Evidence'],
  ['timeline', 'Timeline'],
  ['network', 'Entities & Network'],
  ['scoring', 'Scoring & Scenarios'],
  ['brief', 'Brief'],
  ['tasks', 'Tasks'],
  ['audit', 'Audit'],
];

export function CaseWorkspace() {
  const { id = '', tab = 'overview' } = useParams();
  const { me } = useSession();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<CaseDetail>(me ? `/api/cases/${id}?p=${me.userId}` : null);
  const [advance, setAdvance] = useState(false);
  const [reason, setReason] = useState('');

  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  const c = data.case;
  const next = data.stages[c.stage_index + 1];
  const title = titleCase(c.respondent_name ?? txt(c.title).split(' - ')[0]);

  const doAdvance = async () => {
    try {
      await api.patch(`/api/cases/${id}`, { stage: next, reason: reason || undefined });
      toast(`Advanced to ${next} · audited`);
      setAdvance(false);
      setReason('');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  return (
    <section className="view active" data-od-id="case-workspace-view">
      <p className="crumbs">
        <NavLink to="/cases" className="link">Cases</NavLink> / {txt(c.case_number)} / {TABS.find(([k]) => k === tab)?.[1]}
      </p>
      <section className="case-header" data-od-id="case-header">
        <div className="case-summary">
          <div>
            <div className="title-row">
              <h1>{title}</h1>
              <span className="badge">{txt(c.case_type)}</span>
              {c.story_tag ? <span className="badge" title="One of the demo story cases">Story · {txt(c.story_tag).replace(/_/g, ' ')}</span> : null}
            </div>
            <p className="case-meta">
              {txt(c.case_number)} · Lead: {txt(c.lead_name ?? '—')} · Team: {txt(c.team_name ?? c.team_id)} · Respondent{' '}
              <button className="link" onClick={() => nav(`/entities/${txt(c.respondent_entity_id)}`)}>{txt(c.respondent_entity_id)}</button>
            </p>
            <div className="badges" style={{ marginTop: 12 }}>
              <span className="badge">PPS <strong>{c.pps === null || c.pps === undefined ? '—' : Math.round(Number(c.pps))}</strong></span>
              <span className="badge">{c.risk_band === 'Collapsed' ? 'Respondent' : 'Collapse risk'} <strong>{riskLabel(c.p_collapse_12m, c.risk_band, c.risk_collapse_date, c.risk_collapse_status)}</strong></span>
              <span className="badge">Next key date <strong>{data.next_key_date ? `${date(data.next_key_date.due_date)} · ${txt(data.next_key_date.title)}` : '—'}</strong></span>
              {data.latest_decision && <span className="badge">Decision <strong>{txt(data.latest_decision.decision)} · {txt(data.latest_decision.approval_status)}</strong></span>}
            </div>
          </div>
          <div className="header-actions">
            <button className="btn" data-od-id="generate-brief" onClick={() => nav(`/cases/${id}/brief`)}>Generate brief</button>
            <button className="btn primary" data-od-id="advance-stage" disabled={!next} onClick={() => setAdvance(true)}>
              {next ? 'Advance stage' : 'Closed'}
            </button>
          </div>
        </div>
        <div className="stage-wrap" aria-label="Case stage progress">
          <ol className="stages" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {data.stages.map((s, i) => (
              <li key={s} className={`stage${i < c.stage_index ? ' done' : i === c.stage_index ? ' current' : ''}`} aria-current={i === c.stage_index ? 'step' : undefined}>
                {s}
              </li>
            ))}
          </ol>
        </div>
      </section>
      <nav className="case-tabs" aria-label="Case sections" data-od-id="case-tabs">
        {TABS.map(([k, label]) => (
          <NavLink key={k} to={`/cases/${id}/${k}`} className={tab === k ? 'active' : ''} aria-current={tab === k ? 'page' : undefined}>
            {label}
            {k === 'evidence' && data.extractions_pending > 0 ? <span className="count" title={`${data.extractions_pending} AI extractions awaiting review`} aria-label={`${data.extractions_pending} AI extractions awaiting review`}>{data.extractions_pending}</span> : null}
            {k === 'tasks' && data.open_tasks > 0 ? <span className="count">{data.open_tasks}</span> : null}
          </NavLink>
        ))}
      </nav>
      {tab === 'overview' && <OverviewTab data={data} onChange={reload} />}
      {tab === 'evidence' && <EvidenceTab caseId={id} />}
      {tab === 'timeline' && <TimelineTab caseId={id} />}
      {tab === 'network' && <NetworkTab caseId={id} />}
      {tab === 'scoring' && <ScoringTab caseId={id} onChange={reload} />}
      {tab === 'brief' && <BriefTab caseId={id} />}
      {tab === 'tasks' && <TasksTab caseId={id} onChange={reload} />}
      {tab === 'audit' && <AuditTab caseId={id} />}
      {advance && (
        <Dialog
          title={`Advance to ${next}`}
          onClose={() => setAdvance(false)}
          footer={
            <>
              <button className="btn" onClick={() => setAdvance(false)}>Cancel</button>
              <button className="btn primary" onClick={doAdvance}>Advance stage</button>
            </>
          }
        >
          <p>
            {STAGE_LABEL(c.stage)} → <strong>{next}</strong>. The change is recorded in the audit log with your identity
            {me ? ` (${me.displayName}, ${me.persona})` : ''}.
          </p>
          {next === 'Litigation / Referral' && data.latest_decision?.approval_status !== 'Approved' && (
            <p className="trend-up">
              {data.latest_decision ? `The prosecution decision is ${txt(data.latest_decision.approval_status).toLowerCase()}.` : 'No prosecution decision has been proposed yet.'} An approved decision is expected before litigation or referral.
            </p>
          )}
          <label>
            Note (optional)
            <textarea className="number" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
        </Dialog>
      )}
    </section>
  );
}

function OverviewTab({ data, onChange }: { data: CaseDetail; onChange: () => void }) {
  const c = data.case;
  const toast = useToast();
  const nav = useNavigate();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(txt(c.summary ?? ''));
  const save = async () => {
    try {
      await api.patch(`/api/cases/${txt(c.case_id)}`, { summary: text, summary_ai: false });
      toast('Summary saved · audited');
      setEditing(false);
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const respondents = data.parties.filter((p) => p.role === 'respondent');
  const others = data.parties.filter((p) => p.role !== 'respondent');
  const budgetTotal = data.budget.reduce((a, b) => a + Number(b.approved_budget_aud ?? 0), 0);
  return (
    <section className="case-panel active" data-od-id="case-overview-panel">
      <div className="decision-bar">
        <div><h2>Case overview</h2><p>Investigator-maintained summary, parties, recent confirmed events and financials.</p></div>
        {c.summary_ai ? <AiLabel>AI suggestion · edited by investigator</AiLabel> : null}
      </div>
      <div className="grid-main">
        <div className="column">
          <section className="card">
            <div className="card-head">
              <h3>Summary</h3>
              {!editing && <button className="btn" onClick={() => setEditing(true)}>Edit</button>}
            </div>
            <div className="card-body">
              {editing ? (
                <div className="stack">
                  <textarea className="number" style={{ minHeight: 160 }} value={text} onChange={(e) => setText(e.target.value)} aria-label="Case summary" />
                  <div className="scenario-actions"><button className="btn" onClick={() => setEditing(false)}>Cancel</button><button className="btn primary" onClick={save}>Save summary</button></div>
                </div>
              ) : c.summary ? (
                <p>{txt(c.summary)}</p>
              ) : (
                <Empty title="No summary yet" action={<button className="btn" onClick={() => setEditing(true)}>Write a summary</button>}>
                  {txt(c.title)}. Generate a brief to get an AI-drafted summary you can edit.
                </Empty>
              )}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Parties</h3><button className="btn sm" onClick={() => nav(`/cases/${txt(c.case_id)}/network`)}>Open network</button></div>
            <table className="data-table">
              <thead><tr><th>Entity</th><th>Role</th><th>Collapse risk</th></tr></thead>
              <tbody>
                {[...respondents, ...others].slice(0, 14).map((p) => (
                  <tr key={txt(p.entity_id)} className="clickable" onClick={() => nav(`/entities/${txt(p.entity_id)}`)}>
                    <td><strong>{titleCase(p.entity_name ?? p.entity_id)}</strong><small className="note">{txt(p.entity_type ?? p.party_kind)}</small></td>
                    <td><span className="stage-chip">{txt(p.role)}</span></td>
                    <td><RiskChip p={p.p_collapse_12m} band={p.risk_band} collapsedOn={p.risk_collapse_date} collapseStatus={p.risk_collapse_status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="card">
            <div className="card-head"><h3>Recent confirmed events</h3><button className="btn sm" onClick={() => nav(`/cases/${txt(c.case_id)}/timeline`)}>Timeline</button></div>
            <div className="card-body list">
              {data.recent_events.length === 0 && <p className="note">No confirmed events yet.</p>}
              {data.recent_events.map((e) => (
                <div className="list-item" key={txt(e.event_id)}>
                  <div><strong>{txt(e.event_type)}</strong> <Prov p={e.provenance} /><small>{txt(e.description).slice(0, 140)}</small></div>
                  <span className="mono small">{shortDate(e.event_date)}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
        <aside className="column">
          <section className="card">
            <div className="card-head"><h3>Financials</h3><Prov p="synthetic" /></div>
            <div className="card-body list">
              <div className="list-item"><span>Estimated recoverable</span><strong className="mono">{money(c.est_recoverable_aud)}</strong></div>
              <div className="list-item"><span>Estimated litigation cost</span><strong className="mono">{money(c.est_litigation_cost_aud)}</strong></div>
              <div className="list-item"><span>Cost to date</span><strong className="mono">{money(c.cost_to_date_aud)}</strong></div>
              <div className="list-item"><span>Approved budget</span><strong className="mono">{money(budgetTotal || c.approved_budget_aud)}</strong></div>
              {data.budget.map((b) => {
                const used = Number(b.approved_budget_aud) ? Number(b.spent_aud) / Number(b.approved_budget_aud) : 0;
                return (
                  <div className="list-item" key={txt(b.category)}>
                    <div style={{ width: '100%' }}>
                      <small>{txt(b.category)} · {money(b.spent_aud)} of {money(b.approved_budget_aud)}</small>
                      <div className="spend-bar"><span style={{ width: `${Math.min(100, used * 100)}%` }} /></div>
                    </div>
                    <span className="mono">{Math.round(used * 100)}%</span>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Work</h3></div>
            <div className="card-body list">
              <div className="list-item"><span>Evidence items</span><strong className="mono">{data.evidence_count}</strong></div>
              <div className="list-item"><span>✦ Extractions to review</span><strong className="mono">{data.extractions_pending}</strong></div>
              <div className="list-item"><span>Open tasks</span><strong className="mono">{data.open_tasks}</strong></div>
              <div className="list-item"><span>Consumers affected</span><strong className="mono">{Number(c.consumers_affected ?? 0).toLocaleString('en-AU')}</strong></div>
              <div className="list-item"><span>Limitation date</span><strong className="mono">{shortDate(c.limitation_date)}</strong></div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function TasksTab({ caseId, onChange }: { caseId: string; onChange: () => void }) {
  const { me } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<{ tasks: Row[] }>(`/api/cases/${caseId}/tasks`);
  const [title, setTitle] = useState('');
  const [assignee, setAssignee] = useState('');
  const [due, setDue] = useState('');
  const add = async () => {
    try {
      await api.post(`/api/cases/${caseId}/tasks`, { title, assignee: assignee || null, due_date: due || null });
      setTitle('');
      setDue('');
      toast('Task added · audited');
      reload();
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const setStatus = async (t: Row, status: string) => {
    try {
      await api.patch(`/api/tasks/${txt(t.task_id)}`, { status });
      reload();
      onChange();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  return (
    <section className="case-panel active" data-od-id="tasks-panel">
      <div className="decision-bar"><div><h2>Tasks</h2><p>Case work with owners, due dates and status. Every change is audited.</p></div></div>
      <section className="card">
        <div className="table-tools">
          <input className="number" style={{ maxWidth: 420 }} placeholder="New task" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Task title" />
          <select className="select" value={assignee} onChange={(e) => setAssignee(e.target.value)} aria-label="Assignee">
            <option value="">Unassigned</option>
            {me?.personas.map((p) => <option key={txt(p.user_id)} value={txt(p.user_id)}>{txt(p.display_name)} · {txt(p.persona)}</option>)}
          </select>
          <input className="select" type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Due date" />
          <button className="btn primary" disabled={title.trim().length < 2} onClick={add}>Add task</button>
        </div>
        {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <SkeletonBlock /> : (data?.tasks.length ?? 0) === 0 ? (
          <Empty title="No tasks yet">Add the next piece of work above, e.g. “Confirm extracted transfer event”.</Empty>
        ) : (
          <table className="data-table">
            <thead><tr><th>Task</th><th>Assignee</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>
              {data?.tasks.map((t) => (
                <tr key={txt(t.task_id)}>
                  <td>{txt(t.title)}</td>
                  <td>{txt(t.assignee_name ?? 'Unassigned')}</td>
                  <td>{shortDate(t.due_date)}</td>
                  <td>
                    <select className="select" value={txt(t.status)} onChange={(e) => setStatus(t, e.target.value)} aria-label="Task status">
                      {['Open', 'In progress', 'Done'].map((s) => <option key={s}>{s}</option>)}
                    </select>
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

function AuditTab({ caseId }: { caseId: string }) {
  const { data, error, loading, reload } = useApi<{ entries: Row[] }>(`/api/cases/${caseId}/audit`);
  const [filter, setFilter] = useState('');
  const rows = (data?.entries ?? []).filter((e) => !filter || (filter === 'ai' ? e.ai_flag : `${txt(e.action)} ${txt(e.actor)}`.toLowerCase().includes(filter.toLowerCase())));
  const exportCsv = async () => {
    const res = await fetch(`/api/cases/${caseId}/audit/export`, { headers: { 'x-acting-as': localStorage.getItem('asic.actingAs') ?? '' } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${caseId}-audit.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
    reload();
  };
  return (
    <section className="case-panel active" data-od-id="audit-panel">
      <div className="decision-bar">
        <div><h2>Audit</h2><p>Append-only history of user, AI, model and restricted-data activity. The database rejects edits and deletes.</p></div>
        <button className="btn" onClick={exportCsv}>Export audit log</button>
      </div>
      <section className="card">
        <div className="table-tools">
          <input className="number" placeholder="Filter by action or actor" value={filter === 'ai' ? '' : filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter audit" />
          <button className={`btn sm${filter === 'ai' ? ' primary' : ''}`} onClick={() => setFilter(filter === 'ai' ? '' : 'ai')}>✦ AI actions only</button>
        </div>
        {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <SkeletonBlock /> : rows.length === 0 ? <Empty title="No audit entries yet">Actions on this case are recorded here as they happen.</Empty> : (
          <table className="data-table">
            <thead><tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>Change</th><th>Reason / version</th></tr></thead>
            <tbody>
              {rows.map((e) => (
                <tr key={txt(e.audit_id)}>
                  <td className="mono nowrap">{dateTime(e.at)}</td>
                  <td>{e.ai_flag ? <span className="ai-label">✦ AI · </span> : null}{txt(e.acting_as ?? e.actor)}<small className="note">{txt(e.actor)}</small></td>
                  <td>{txt(e.action)}</td>
                  <td className="small">{e.field ? `${txt(e.field)}: ${txt(e.old_value ?? '—').slice(0, 40)} → ${txt(e.new_value ?? '—').slice(0, 60)}` : e.new_value ? txt(e.new_value).slice(0, 80) : ''}</td>
                  <td className="small">{txt(e.reason ?? e.model_version ?? '')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}

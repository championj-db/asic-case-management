import { useNavigate } from 'react-router';
import { useApi } from '../lib/api';
import { ago, collapseKind, date, money, monthLabel, shortDate, signed, STAGE_LABEL, titleCase, abbrev, pct, txt } from '../lib/format';
import { Empty, ErrorState, PageSkeleton, Prov, RiskChip, useSession, useSort, type Row } from '../components/common';

/* ---------------- S1 My Work ---------------- */
interface MyWork {
  cases: Row[];
  tasks: Row[];
  kpis: Record<string, number>;
  activity: Row[];
  approvals?: Row[];
}

const CRITERION_LABEL: Record<string, string> = { financial: 'Financial return', success: 'Likelihood of success', harm: 'Consumer harm', deterrence: 'Deterrence', urgency: 'Urgency' };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function MyWorkView() {
  const { me } = useSession();
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<MyWork>(me ? `/api/my-work?p=${me.userId}` : null);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  const k = data.kpis;
  return (
    <section className="view active" data-od-id="my-work-view">
      <header className="page-head">
        <div>
          <h1>My Work</h1>
          <p>Cases, evidence and decisions requiring {me?.displayName}’s attention · {me?.teamId}.</p>
        </div>
        <button className="btn primary" onClick={() => nav('/intake')}>
          Triage intake
        </button>
      </header>
      <div className="kpis">
        <div className="kpi"><span>My open cases</span><strong>{k.open_cases}</strong><small>{k.decision_stage} at decision stage</small></div>
        <div className="kpi"><span>My open tasks</span><strong>{k.tasks_due}</strong><small className={k.overdue ? 'trend-up' : ''}>{k.overdue} overdue · team {k.team_tasks} ({k.team_overdue} overdue)</small></div>
        <div className="kpi"><span>Evidence not yet reviewed</span><strong>{k.evidence_unreviewed}</strong><small>{k.evidence_hot} tagged Hot</small></div>
        <div className="kpi"><span>✦ AI extractions to confirm</span><strong>{k.extractions_pending}</strong><small>Across {k.extraction_docs} documents</small></div>
        <div className="kpi"><span>Agency &amp; register updates</span><strong>{k.agency_updates}</strong><small>Latest confirmed signals</small></div>
      </div>
      <div className="grid-main">
        <section className="card">
          <div className="card-head">
            <h3>My cases</h3>
            <button className="btn" onClick={() => nav('/cases')}>All cases</button>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            {data.cases.length === 0 ? (
              <Empty title="No open cases for your team">Cases opened from the Intake Queue appear here.</Empty>
            ) : (
              <table className="data-table">
                <thead>
                  <tr><th>Case</th><th>Stage</th><th className="num">PPS</th><th>Insolvency risk</th><th>Next deadline</th></tr>
                </thead>
                <tbody>
                  {data.cases.map((c) => (
                    <tr key={txt(c.case_id)} className="clickable" onClick={() => nav(`/cases/${txt(c.case_id)}/overview`)}>
                      <td>
                        <strong>{titleCase(c.respondent_name ?? c.title)}</strong>
                        <small className="note">{txt(c.case_number)} · {txt(c.case_type)}{c.lead_user === me?.userId ? ' · You lead' : ''}</small>
                      </td>
                      <td><span className="stage-chip">{STAGE_LABEL(c.stage)}</span></td>
                      <td className="num">{c.pps === null || c.pps === undefined ? '—' : Math.round(Number(c.pps))}</td>
                      <td><RiskChip p={c.p_collapse_12m} band={c.risk_band} collapsedOn={c.risk_collapse_date} collapseStatus={c.risk_collapse_status} /></td>
                      <td className={c.next_due && new Date(txt(c.next_due)) < new Date(new Date().toDateString()) ? 'trend-up' : undefined}>{c.next_due ? `${new Date(txt(c.next_due)) < new Date(new Date().toDateString()) ? 'Overdue · ' : ''}${date(c.next_due)} · ${txt(c.next_task)}` : c.limitation_date ? `Limitation ${date(c.limitation_date)}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
        <aside className="card">
          <div className="card-head"><h3>Recent activity</h3></div>
          <div className="card-body list">
            {data.activity.length === 0 && <Empty title="Nothing new" />}
            {data.activity.map((a, i) => (
              <div className="list-item" key={i} onClick={() => nav(`/cases/${txt(a.case_id)}/timeline`)} style={{ cursor: 'pointer' }}>
                <div>
                  <strong>{txt(a.event_type)}</strong> <Prov p={a.provenance} />
                  <p>{titleCase(txt(a.case_title).split(' - ')[0])}</p>
                  <small>{txt(a.description).slice(0, 90)}</small>
                </div>
                <small>{shortDate(a.event_date)}</small>
              </div>
            ))}
          </div>
        </aside>
      </div>
      {(data.approvals?.length ?? 0) > 0 && (
        <section className="card" style={{ marginTop: 20 }}>
          <div className="card-head"><h3>Decisions awaiting your approval</h3><span className="ai-label">Four-eyes · proposed by another lead or counsel</span></div>
          <table className="data-table">
            <thead><tr><th>Case</th><th>Proposed decision</th><th>Proposed by</th><th className="num">PPS</th><th>Since</th></tr></thead>
            <tbody>
              {data.approvals?.map((d) => (
                <tr key={txt(d.decision_id)} className="clickable" onClick={() => nav(`/cases/${txt(d.case_id)}/scoring`)}>
                  <td>{titleCase(txt(d.case_title).split(' - ')[0])}</td>
                  <td><strong>{txt(d.decision)}</strong></td>
                  <td>{txt(d.decided_by_name ?? d.decided_by)}</td>
                  <td className="num">{Math.round(Number(d.pps_total))}</td>
                  <td>{shortDate(d.decided_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {data.tasks.length > 0 && (
        <section className="card" style={{ marginTop: 20 }}>
          <div className="card-head"><h3>Open tasks</h3></div>
          <table className="data-table">
            <thead><tr><th>Task</th><th>Case</th><th>Due</th><th>Status</th></tr></thead>
            <tbody>
              {data.tasks.map((t) => (
                <tr key={txt(t.task_id)} className="clickable" onClick={() => nav(`/cases/${txt(t.case_id)}/tasks`)}>
                  <td>{txt(t.title)}</td>
                  <td>{titleCase(txt(t.case_title).split(' - ')[0])}</td>
                  <td>{shortDate(t.due_date)}</td>
                  <td><span className="stage-chip">{txt(t.status)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </section>
  );
}

/* ---------------- S7 Executive Briefing ---------------- */
interface Exec {
  trajectory: Row[];
  spend: Row[];
  portfolio: Row;
  attention: Row[];
  since_last: Row;
  generated_at: string;
}

function attentionSignal(a: Row): { signal: string; action: string } {
  const risk = Number(a.risk_delta_pts ?? 0);
  const d = Number(a.pps_delta ?? 0);
  const ratio = Number((a.criteria as Row | null)?.return_ratio ?? 0);
  if (risk >= 5) return { signal: `Insolvency risk ${signed(risk)} pts`, action: 'Consider asset preservation' };
  if (Number(a.pps) >= 70) return { signal: `PPS reached ${Math.round(Number(a.pps))}`, action: 'Advance to decision' };
  if (d <= -5) return { signal: `PPS ${signed(d, 1)}`, action: 'Review scope and cost' };
  if (ratio < 1) return { signal: `Predicted ROI ${ratio.toFixed(2)}×`, action: 'Consider alternatives' };
  return { signal: `PPS ${signed(d, 1)} since last quarter`, action: 'Monitor' };
}

export function ExecutiveView() {
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<Exec>('/api/executive');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  const p = data.portfolio;
  const gross = Number(p.gross_recovery ?? 0);
  const net = Number(p.net_return ?? 0);
  const spend = Number(p.committed_spend ?? 0);
  const budget = Number(p.approved_budget ?? 0);
  const maxNet = Math.max(...data.trajectory.map((t) => Math.abs(Number(t.net_return ?? 0))), 1);
  const updated = new Date(data.generated_at);
  return (
    <section className="view active" data-od-id="executive-briefing-view">
      <div className="exec-hero" style={{ alignItems: 'center' }}>
        <div>
          <span className="ai-label" style={{ color: 'inherit' }}>Executive briefing · Enforcement portfolio</span>
        </div>
        <div className="exec-date">
          <strong>{updated.toLocaleDateString('en-AU', { day: '2-digit', month: 'short', year: 'numeric' })}</strong>
          <br />
          <span>Updated {updated.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' })} · SQL warehouse</span>
        </div>
      </div>
      <div className="kpis">
        <div className="kpi"><span>Open cases</span><strong>{txt(p.open_cases ?? '—')}</strong><small>Scored by PPS</small></div>
        <div className="kpi"><span>Committed portfolio spend</span><strong>{money(spend)}</strong><small>{budget ? `${Math.round((spend / budget) * 100)}% of approved budget` : ''}</small></div>
        <div className="kpi"><span>Predicted gross recovery</span><strong>{money(gross)}</strong><small>Probability-adjusted</small></div>
        <div className="kpi"><span>Probability-adjusted net return</span><strong>{money(net)}</strong><small className={net >= 0 ? 'trend-good' : 'trend-up'}>{spend ? `${(gross / Math.max(Number(p.committed_spend), 1)).toFixed(2)}× return on spend to date` : ''}</small></div>
        <div className="kpi"><span>High insolvency risk</span><strong>{txt(p.high_collapse ?? 0)}</strong><small className="trend-up">Respondents at High or Critical{Number(p.collapsed_respondents ?? 0) ? ` · ${txt(p.collapsed_respondents)} already insolvent or deregistered` : ''}</small></div>
      </div>
      <div className="grid-main">
        <div className="column">
          <section className="card">
            <div className="card-head">
              <h3>Portfolio evolution</h3>
              <span className="badge">{data.trajectory.length ? `${monthLabel(data.trajectory[0].as_of_date)} – ${monthLabel(data.trajectory[data.trajectory.length - 1].as_of_date)}` : ''}</span>
            </div>
            <div className="card-body">
              <p className="note">Probability-adjusted net return across open cases at each quarterly scoring snapshot; the latest is highlighted. Hover a bar for detail.</p>
              <div className="trajectory" role="img" aria-label="Portfolio net return by scoring snapshot">
                {data.trajectory.map((t) => (
                  <div
                    key={txt(t.as_of_date)}
                    style={{ height: `${Math.max(6, (Math.abs(Number(t.net_return ?? 0)) / maxNet) * 92)}%`, ...(Number(t.net_return) < 0 ? { opacity: 0.3 } : {}) }}
                    title={`${monthLabel(t.as_of_date)}: net ${money(t.net_return)} · gross ${money(t.gross_recovery)} · ${txt(t.cases)} cases · avg PPS ${txt(t.avg_pps)}`}
                  >
                    <span>{monthLabel(t.as_of_date)}</span>
                  </div>
                ))}
              </div>
              <table className="sr-only">
                <caption>Portfolio evolution</caption>
                <tbody>{data.trajectory.map((t) => <tr key={txt(t.as_of_date)}><td>{monthLabel(t.as_of_date)}</td><td>{money(t.net_return)}</td></tr>)}</tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="card-head">
              <h3>Cases requiring executive attention</h3>
              <button className="btn" onClick={() => window.print()}>Export briefing</button>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="data-table">
                <thead><tr><th>Case</th><th>Signal</th><th className="num">Spend</th><th className="num">Predicted ROI</th><th>Recommended action</th></tr></thead>
                <tbody>
                  {data.attention.map((a) => {
                    const s = attentionSignal(a);
                    const ratio = (a.criteria as Row | null)?.return_ratio;
                    return (
                      <tr key={txt(a.case_id)} className="clickable" onClick={() => nav(`/cases/${txt(a.case_id)}/scoring`)}>
                        <td><strong>{titleCase(a.respondent_name ?? a.title)}</strong><small className="note">{STAGE_LABEL(a.stage)} · PPS {Math.round(Number(a.pps))}</small></td>
                        <td>{s.signal}</td>
                        <td className="num">{money(a.cost_to_date_aud)}</td>
                        <td className="num">{ratio === null || ratio === undefined ? '—' : `${Number(ratio).toFixed(2)}×`}</td>
                        <td>{s.action}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        </div>
        <aside className="column">
          <section className="card">
            <div className="card-head"><h3>Spend against budget</h3><Prov p="synthetic" /></div>
            <div className="card-body list">
              {data.spend.map((s) => {
                const used = Number(s.budget) ? Number(s.spent) / Number(s.budget) : 0;
                return (
                  <div className="list-item" key={txt(s.category)}>
                    <div>
                      <strong>{txt(s.category)}</strong>
                      <small>{money(s.spent)} of {money(s.budget)}</small>
                      <div className="spend-bar"><span style={{ width: `${Math.min(100, used * 100)}%` }} /></div>
                    </div>
                    <span className="mono">{Math.round(used * 100)}%</span>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Last 30 days</h3></div>
            <div className="card-body list">
              <div className="list-item"><div><strong>{plural(Number(data.since_last.advanced ?? 0), 'stage advance', 'stage advances')}</strong><small>Recorded in the audit log</small></div><span>→</span></div>
              <div className="list-item"><div><strong>{plural(Number(data.since_last.scenarios ?? 0), 'scenario saved', 'scenarios saved')}</strong><small>What-if analysis by leads</small></div><span>↻</span></div>
              <div className="list-item"><div><strong>{plural(Number(data.since_last.decisions ?? 0), 'approved decision', 'approved decisions')}</strong><small>{Number(data.since_last.decisions_proposed ?? 0)} proposed · four-eyes approval</small></div><span>✓</span></div>
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

/* ---------------- S2 Portfolio ---------------- */
interface Portfolio {
  kpis: Record<string, number | null>;
  cases: Row[];
  movers: Row[];
}

const STAGE_COLOR: Record<string, string> = {
  Assessment: 'var(--viz-4)',
  Investigation: 'var(--viz-2)',
  Decision: 'var(--viz-5)',
  Litigation: 'var(--viz-8)',
  Referral: 'var(--viz-8)', // shown together with Litigation
  Outcome: 'var(--viz-10)',
};

export function PortfolioView() {
  const nav = useNavigate();
  const { data, error, loading, reload } = useApi<Portfolio>('/api/portfolio');
  const { sorted, th } = useSort(data?.cases ?? [], 'pps');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  const k = data.kpis;
  const maxRec = Math.max(...data.cases.map((c) => Number(c.est_recoverable_aud ?? 0)), 1);
  return (
    <section className="view active" data-od-id="portfolio-view">
      <header className="page-head">
        <div>
          <h1>Enforcement portfolio</h1>
          <p>Prioritise matters by PPS, insolvency risk, recoverable amount and current spend.</p>
        </div>
      </header>
      <div className="kpis">
        <div className="kpi"><span>Open cases</span><strong>{k.open_cases}</strong></div>
        <div className="kpi"><span>Estimated recoverable</span><strong>{money(k.est_recoverable)}</strong></div>
        <div className="kpi"><span>Cost to date</span><strong>{money(k.cost_to_date)}</strong></div>
        <div className="kpi"><span>Average PPS</span><strong>{k.avg_pps === null ? '—' : Math.round(Number(k.avg_pps))}</strong></div>
        <div className="kpi"><span>High insolvency risk</span><strong>{k.high_collapse}</strong>{k.collapsed ? <small>{k.collapsed} respondents already insolvent or deregistered</small> : null}</div>
      </div>
      <div className="grid-main">
        <section className="card">
          <div className="card-head">
            <h3>Priority matrix</h3>
            <span className="ai-label">Bubble size · recoverable amount · colour · stage</span>
          </div>
          <div className="matrix" role="img" aria-label="Case priority matrix: PPS against insolvency risk">
            {data.cases
              .filter((c) => c.pps !== null && c.pps !== undefined)
              .map((c) => {
                const size = 26 + Math.sqrt(Number(c.est_recoverable_aud ?? 0) / maxRec) * 40;
                return (
                  <button
                    key={txt(c.case_id)}
                    className="bubble"
                    style={{
                      left: `${Number(c.pps)}%`,
                      top: `${100 - (c.risk_band === 'Collapsed' ? 1 : Number(c.p_collapse_12m ?? 0)) * 100}%`,
                      width: size,
                      height: size,
                      background: STAGE_COLOR[txt(c.stage)] ?? 'var(--viz-2)',
                    }}
                    title={`${titleCase(c.respondent_name)} · PPS ${Math.round(Number(c.pps))} · ${c.risk_band === 'Collapsed' ? 'respondent insolvent or deregistered' : `insolvency risk ${pct(c.p_collapse_12m)}`} · ${money(c.est_recoverable_aud)} recoverable · ${STAGE_LABEL(c.stage)}`}
                    aria-label={`${titleCase(c.respondent_name)}, PPS ${Math.round(Number(c.pps))}, ${c.risk_band === 'Collapsed' ? 'respondent insolvent or deregistered' : `insolvency risk ${pct(c.p_collapse_12m)}`}`}
                    onClick={() => nav(`/cases/${txt(c.case_id)}/scoring`)}
                  >
                    {abbrev(txt(c.respondent_name ?? c.title))}
                  </button>
                );
              })}
          </div>
          <div className="network-legend">
            {[...new Map(Object.entries(STAGE_COLOR).map(([s, col]) => [STAGE_LABEL(s), col])).entries()].map(([label, col]) => (
              <span key={label} className="row"><span className="band-mark" style={{ background: col }} />{label}</span>
            ))}
          </div>
        </section>
        <aside className="card">
          <div className="card-head"><h3>Movers · last quarter</h3></div>
          <div className="card-body list">
            {data.movers.length === 0 && <Empty title="No material movement">No case moved by 1+ PPS point or 5+ risk points since the previous quarterly snapshot.</Empty>}
            {data.movers.map((m) => {
              const r = Number(m.risk_delta_pts);
              const d = Number(m.pps_delta);
              const riskLed = Math.abs(r) >= Math.abs(d);
              return (
                <div className="list-item" key={txt(m.case_id)} style={{ cursor: 'pointer' }} onClick={() => nav(`/cases/${txt(m.case_id)}/scoring`)}>
                  <div>
                    <strong>{titleCase(m.respondent_name ?? m.title)}</strong>
                    <p>{riskLed ? 'Insolvency model · new agency data' : `Led by ${(CRITERION_LABEL[txt(m.driver)] ?? 'score').toLowerCase()} (${signed(Number(m.driver_delta ?? d))} pts)`} · since {date(m.since)}</p>
                  </div>
                  <span className={`mono ${riskLed ? (r > 0 ? 'trend-up' : 'trend-good') : d > 0 ? 'trend-good' : ''}`}>
                    {riskLed ? `Risk ${signed(r)}` : `PPS ${signed(d)}`}
                  </span>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
      <section className="card" style={{ marginTop: 20 }}>
        <div className="card-head"><h3>All open cases</h3><span className="note">Click a column to sort</span></div>
        <div className="scroll-x">
          <table className="data-table">
            <thead>
              <tr>
                {th('title', 'Case')}
                {th('stage', 'Stage')}
                {th('pps', 'PPS', 'num')}
                {th('p_collapse_12m', 'Insolvency risk 12m', 'num')}
                {th('est_recoverable_aud', 'Recoverable', 'num')}
                {th('cost_to_date_aud', 'Cost to date', 'num')}
                {th('opened_at', 'Age')}
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={txt(c.case_id)} className="clickable" onClick={() => nav(`/cases/${txt(c.case_id)}/overview`)}>
                  <td><strong>{titleCase(c.respondent_name ?? c.title)}</strong><small className="note">{txt(c.case_number)} · {txt(c.team_name ?? c.team_id)}</small></td>
                  <td><span className="stage-chip">{STAGE_LABEL(c.stage)}</span></td>
                  <td className="num">{c.pps === null || c.pps === undefined ? '—' : Math.round(Number(c.pps))}</td>
                  <td className="num">{c.risk_band === 'Collapsed' ? collapseKind(c.risk_collapse_status) : pct(c.p_collapse_12m)}</td>
                  <td className="num">{money(c.est_recoverable_aud)}</td>
                  <td className="num">{money(c.cost_to_date_aud)}</td>
                  <td>{ago(c.opened_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

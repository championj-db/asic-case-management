import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { api, useApi } from '../lib/api';
import { collapseKind, date, money, num, pct, riskLabel, shortDate, STAGE_LABEL, titleCase, txt } from '../lib/format';
import {
  AiLabel, Empty, ErrorState, PageSkeleton, Prov, Restricted, RiskChip, SkeletonBlock, Sparkline, useSession, useSort, useToast, type Row,
} from '../components/common';

/* ---------------- Cases list ---------------- */
export function CasesView() {
  const nav = useNavigate();
  const { me } = useSession();
  const { data, error, loading, reload } = useApi<{ cases: Row[] }>(me ? `/api/cases?p=${me.userId}` : null);
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('');
  const rows = (data?.cases ?? []).filter(
    (c) => (!stage || STAGE_LABEL(c.stage) === stage) && (!q || `${txt(c.title)} ${txt(c.case_number)}`.toLowerCase().includes(q.toLowerCase())),
  );
  const { sorted, th } = useSort(rows, 'pps');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <PageSkeleton />;
  return (
    <section className="view active">
      <header className="page-head">
        <div>
          <h1>Cases</h1>
          <p>{me?.sees_all_teams ? 'All enforcement teams' : `Your team’s matters (${me?.teamId})`} · sorted by Prosecution Priority Score.</p>
        </div>
        <button className="btn primary" onClick={() => nav('/intake')}>Open a case from intake</button>
      </header>
      <section className="card">
        <div className="table-tools">
          <input className="number" placeholder="Filter by name or number" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter cases" />
          <select className="select" value={stage} onChange={(e) => setStage(e.target.value)} aria-label="Filter by stage">
            <option value="">All stages</option>
            {['Assessment', 'Investigation', 'Decision', 'Litigation / Referral', 'Outcome', 'Closed'].map((s) => <option key={s}>{s}</option>)}
          </select>
          <span className="note">{sorted.length} cases</span>
        </div>
        {sorted.length === 0 ? (
          <Empty title="No cases match these filters" />
        ) : (
          <div className="scroll-x">
            <table className="data-table">
              <thead>
                <tr>{th('title', 'Case')}{th('case_type', 'Type')}{th('stage', 'Stage')}{th('pps', 'PPS', 'num')}{th('pps_band', 'Recommendation')}{th('p_collapse_12m', 'Collapse risk')}{th('lead_name', 'Lead')}</tr>
              </thead>
              <tbody>
                {sorted.map((c) => (
                  <tr key={txt(c.case_id)} className="clickable" onClick={() => nav(`/cases/${txt(c.case_id)}/overview`)}>
                    <td><strong>{titleCase(c.respondent_name ?? c.title)}</strong><small className="note">{txt(c.case_number)}{c.story_tag ? ' · Demo story' : ''}{c.created_from_intake ? ' · New from intake' : ''}</small></td>
                    <td>{txt(c.case_type)}</td>
                    <td><span className="stage-chip">{STAGE_LABEL(c.stage)}</span></td>
                    <td className="num">{c.pps === null || c.pps === undefined ? '—' : Math.round(Number(c.pps))}</td>
                    <td>{txt(c.pps_band ?? 'Not yet scored')}</td>
                    <td><RiskChip p={c.p_collapse_12m} band={c.risk_band} collapsedOn={c.risk_collapse_date} collapseStatus={c.risk_collapse_status} /></td>
                    <td>{txt(c.lead_name ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </section>
  );
}

/* ---------------- S3 Intake Queue ---------------- */
interface IntakeDetail {
  item: Row;
  entity_id: string;
  profile: Row | null;
  risk: (Row & { drivers: Row[] }) | null;
  open_cases: Row[];
  related_cases: Row[];
  sources: Row[];
  prior_reports: number;
}

export function IntakeView() {
  const nav = useNavigate();
  const toast = useToast();
  const list = useApi<{ items: Row[]; total?: number }>('/api/intake');
  const [sel, setSel] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? items.length;
  const current = sel ?? (items[0] ? txt(items[0].intake_id) : null);
  const detail = useApi<IntakeDetail>(current ? `/api/intake/${current}` : null);
  const [reason, setReason] = useState('');
  const [linkCase, setLinkCase] = useState('');
  const [suggestion, setSuggestion] = useState<Row | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setReason('');
    setSuggestion(null);
    setLinkCase('');
  }, [current]);

  const decide = async (disposition: string) => {
    if (!current) return;
    if (reason.trim().length < 5) {
      toast('A reason is required for every disposition');
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<{ case_id: string | null }>(`/api/intake/${current}/disposition`, {
        disposition, reason, case_id: disposition === 'Link to case' ? linkCase : undefined, ai_suggestion: suggestion ?? undefined,
      });
      toast(`${disposition} recorded${r.case_id ? ` · ${r.case_id}` : ''} · audited`);
      setSel(null);
      list.reload();
      if (disposition === 'Open case' && r.case_id) void nav(`/cases/${r.case_id}/overview`);
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const suggest = async () => {
    if (!current) return;
    setBusy(true);
    try {
      setSuggestion(await api.post<Row>(`/api/intake/${current}/suggest`));
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (list.error) return <ErrorState message={list.error} onRetry={list.reload} />;
  if (list.loading && !list.data) return <PageSkeleton />;
  const d = detail.data;
  const caseOptions = [...(d?.open_cases ?? []), ...(d?.related_cases ?? [])];
  return (
    <section className="view active" data-od-id="intake-queue-view">
      <header className="page-head">
        <div>
          <h1>Intake Queue</h1>
          <p>Triage new reports and alerts against resolved entities, shared-agency signals and open cases. Every disposition needs a reason.</p>
        </div>
        <span className="badge">{total > items.length ? `Newest ${items.length} of ${total.toLocaleString()} awaiting triage` : `${items.length} awaiting triage`}</span>
      </header>
      {items.length === 0 ? (
        <section className="card"><Empty title="The queue is clear">New breach reports and alerts will appear here.</Empty></section>
      ) : (
        <section className="card queue">
          <div className="queue-list" role="listbox" aria-label="Intake items" style={{ maxHeight: 720, overflow: 'auto' }}>
            {items.map((it) => (
              <button
                key={txt(it.intake_id)}
                role="option"
                aria-selected={txt(it.intake_id) === current}
                className={`queue-item${txt(it.intake_id) === current ? ' active' : ''}`}
                onClick={() => setSel(txt(it.intake_id))}
              >
                <strong>{txt(it.report_kind)} · {titleCase(it.entity_name ?? it.acn)}</strong>
                <small>{txt(it.category)} · {shortDate(it.received_at)} · {it.band === 'Collapsed' ? riskLabel(null, 'Collapsed', it.risk_collapse_date, it.risk_collapse_status) : it.p_collapse_12m !== null && it.p_collapse_12m !== undefined ? `risk ${pct(it.p_collapse_12m)}` : 'not scored'}</small>
              </button>
            ))}
          </div>
          <div className="queue-detail">
            {detail.loading && !d ? <SkeletonBlock rows={6} /> : detail.error ? <ErrorState message={detail.error} onRetry={detail.reload} /> : d && (
              <>
                <div className="page-head">
                  <div>
                    <span className="ai-label">Resolved entity · {d.profile ? `${Math.round(Number(d.profile.match_confidence ?? 1) * 100)}% identity confidence` : 'not in focus slice'}</span>
                    <h2>
                      <button className="link" onClick={() => nav(`/entities/${d.entity_id}`)}>{titleCase(d.profile?.name ?? d.item.acn)}</button>
                    </h2>
                    <p>ACN {txt(d.item.acn)} · {txt(d.profile?.status ?? '—')} · {txt(d.profile?.type ?? '')} <Prov p="public" /></p>
                  </div>
                  <RiskChip p={d.risk?.p_collapse_12m} band={d.risk?.band} collapsedOn={d.risk?.collapse_date} collapseStatus={d.risk?.collapse_status} />
                </div>
                <p style={{ marginBottom: 16 }}>{txt(d.item.summary)} <Prov p={d.item.provenance} /></p>
                <div className="kpis" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
                  {d.risk?.band === 'Collapsed' ? (
                    <div className="kpi"><span>Entity status</span><strong className="sm">Collapsed</strong><small>{collapseKind(d.risk.collapse_status)} on {date(d.risk.collapse_date)} · ASIC register</small></div>
                  ) : (
                    <div className="kpi"><span>Top risk driver</span><strong className="sm">{d.risk?.drivers?.[0] ? txt(d.risk.drivers[0].label) : '—'}</strong><small>{d.risk?.drivers?.[0] ? txt(d.risk.drivers[0].sentence) : 'No model score'}</small></div>
                  )}
                  <div className="kpi"><span>Related open cases</span><strong>{caseOptions.length}</strong><small>{caseOptions[0] ? `${txt(caseOptions[0].role ?? 'respondent')} in ${txt(caseOptions[0].case_id)}` : 'None'}</small></div>
                  <div className="kpi"><span>Source records</span><strong>{d.sources.reduce((a, s) => a + Number(s.n), 0)}</strong><small>{d.sources.map((s) => txt(s.agency)).join(', ') || '—'}</small></div>
                </div>
                <p className="note" style={{ marginBottom: 16 }}>
                  Alleged loss {money(d.item.alleged_loss_aud)} · {num(d.item.consumers_affected)} consumers · {d.prior_reports} prior reports on this entity · ATO debt {money(d.profile?.ato_debt_aud)} <Prov p="synthetic" />
                </p>
                <section className="card" style={{ boxShadow: 'none', marginBottom: 16 }}>
                  <div className="card-head">
                    <h3>Triage suggestion</h3>
                    <button className="btn sm" onClick={suggest} disabled={busy}>{suggestion ? 'Regenerate' : '✦ Suggest disposition'}</button>
                  </div>
                  <div className="card-body">
                    {suggestion ? (
                      <div className="ai-panel">
                        <AiLabel model={suggestion.model} at={suggestion.generated_at}>Suggestion · {txt(suggestion.confidence ?? '')} confidence · a person decides</AiLabel>
                        <p style={{ marginTop: 8 }}><strong>{txt(suggestion.disposition ?? 'No suggestion')}</strong>{suggestion.case_id ? ` → ${txt(suggestion.case_id)}` : ''}</p>
                        <ul>{((suggestion.reasons as string[]) ?? []).map((r, i) => <li key={i}>{r}</li>)}</ul>
                        <button className="btn sm" onClick={() => setReason(`${txt(suggestion.disposition)}: ${((suggestion.reasons as string[]) ?? []).join('; ')}`)}>Use as starting reason</button>
                      </div>
                    ) : (
                      <p className="note">The assistant reads the report, the entity’s cross-agency profile, collapse risk and open cases, then proposes a disposition with reasons. It never decides.</p>
                    )}
                  </div>
                </section>
                <section className="card" style={{ boxShadow: 'none' }}>
                  <div className="card-head"><h3>Disposition</h3><span className="ai-label">Reason required · audited</span></div>
                  <div className="card-body">
                    <textarea className="number" placeholder="Record the reason for this disposition" value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Disposition reason" />
                    {caseOptions.length > 0 && (
                      <select className="select" style={{ marginTop: 12, width: '100%' }} value={linkCase} onChange={(e) => setLinkCase(e.target.value)} aria-label="Case to link">
                        <option value="">Choose a case to link…</option>
                        {caseOptions.map((c) => <option key={txt(c.case_id)} value={txt(c.case_id)}>{txt(c.case_id)} · {txt(c.title)}</option>)}
                      </select>
                    )}
                    <div className="scenario-actions">
                      <button className="btn" disabled={busy} onClick={() => decide('No further action')}>No further action</button>
                      <button className="btn" disabled={busy || !linkCase} onClick={() => decide('Link to case')}>Link to existing case</button>
                      <button className="btn primary" disabled={busy} onClick={() => decide('Open case')}>Open case</button>
                    </div>
                  </div>
                </section>
              </>
            )}
          </div>
        </section>
      )}
    </section>
  );
}

/* ---------------- Entities list ---------------- */
export function EntitiesView() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  const { data, error, loading, reload } = useApi<{ entities: Row[] }>(`/api/entities?q=${encodeURIComponent(query)}`);
  return (
    <section className="view active">
      <header className="page-head">
        <div>
          <h1>Entities</h1>
          <p>Resolved companies and licensees with shared-agency intelligence. Identity confidence is shown separately from risk.</p>
        </div>
      </header>
      <section className="card">
        <div className="table-tools">
          <input className="number" placeholder="Name or ACN" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search entities" />
          <span className="note">Showing entities with open cases first, then highest collapse risk</span>
        </div>
        {error ? <ErrorState message={error} onRetry={reload} /> : loading && !data ? <SkeletonBlock rows={8} /> : (data?.entities.length ?? 0) === 0 ? <Empty title="No entities match" /> : (
          <table className="data-table">
            <thead><tr><th>Entity</th><th>Status</th><th>Agencies</th><th className="num">Records</th><th className="num">Open cases</th><th>Collapse risk</th></tr></thead>
            <tbody>
              {data?.entities.map((e) => (
                <tr key={txt(e.entity_id)} className="clickable" onClick={() => nav(`/entities/${txt(e.entity_id)}`)}>
                  <td><strong>{titleCase(e.name)}</strong><small className="note">ACN {txt(e.abn_acn ?? '—')} · {txt(e.entity_type)}</small></td>
                  <td>{txt(e.status ?? '—')}</td>
                  <td>{((e.agencies as string[]) ?? []).join(' · ')}</td>
                  <td className="num">{txt(e.source_record_count ?? 0)}</td>
                  <td className="num">{txt(e.open_cases ?? 0)}</td>
                  <td><RiskChip p={e.p_collapse_12m} band={e.band} collapsedOn={e.risk_collapse_date} collapseStatus={e.risk_collapse_status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}

/* ---------------- S5 Entity 360 ---------------- */
interface Entity360 {
  entity: Row;
  profile: Row | null;
  risk: (Row & { drivers: Row[] }) | null;
  risk_history: Row[];
  sources: Row[];
  related: Row[];
  officers: Row[];
  cases: Row[];
  resolution: Row[];
  past_matters: Row[];
  austrac: { count: number; authorised: boolean; detail: Row | null };
}

const STATUS: Record<string, string> = { REGD: 'Registered', EXAD: 'External administration', SOFF: 'Strike-off in progress', DRGD: 'Deregistered', NOAC: 'Not active' };
const REL: Record<string, string> = { officer_of: 'Officer', shares_director: 'Shares a director', co_director: 'Co-director', shares_business_name: 'Shares a business name', possible_match: 'Possible banned-register match' };

export function EntityView() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Entity360>(`/api/entities/${id}`);
  const decide = async (rid: string, decision: string) => {
    try {
      await api.post(`/api/resolution/${rid}`, { decision });
      toast(`Resolution recorded: ${decision} · audited`);
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  const p = data.profile ?? {};
  const e = data.entity;
  const agencyCount = data.sources.filter((s) => !['ASIC', 'ABR'].includes(txt(s.agency))).length;
  return (
    <section className="view active" data-od-id="entity-360-view">
      <header className="page-head">
        <div>
          <span className="ai-label">Entity 360</span>
          <h1>{titleCase(e.name)}</h1>
          <p>
            {txt(p.type ?? e.entity_type)} · {e.abn_acn ? `ACN ${txt(e.abn_acn)}` : ''} {e.abn ? `· ABN ${txt(e.abn)}` : ''} · {STATUS[txt(e.status)] ?? txt(e.status ?? '—')} <Prov p={e.provenance} />
          </p>
        </div>
        <div className="badges">
          <span className="badge" title="How sure we are these records are the same entity — not a risk measure">
            Resolved from {data.sources.length} records · {Math.round(Number(e.match_confidence ?? 1) * 100)}% confidence
          </span>
          {data.risk && <span className="badge">{data.risk.band === 'Collapsed' ? 'Status' : 'Risk'} <strong>{riskLabel(data.risk.p_collapse_12m, data.risk.band, data.risk.collapse_date, data.risk.collapse_status)}</strong></span>}
        </div>
      </header>
      <div className="grid-main">
        <div className="column">
          <section className="card">
            <div className="card-head"><h3>Identity</h3><span className="ai-label">Identity confidence is separate from risk</span></div>
            <div className="card-body">
              <dl className="identity-grid">
                <div><dt>Registered name</dt><dd>{titleCase(e.name)}</dd></div>
                <div><dt>Registered</dt><dd>{date(p.reg_date)}</dd></div>
                <div><dt>ABN / GST</dt><dd>{txt(p.abn_status ?? '—')} · GST {txt(p.gst_status ?? '—')}</dd></div>
                <div><dt>Officers (synthetic)</dt><dd>{data.officers.length} recorded</dd></div>
                <div><dt>Licences</dt><dd>{((p.licences as Row[]) ?? []).map((l) => `${txt(l.licence_type)} ${txt(l.licence_no)}`).join(', ') || 'None'}</dd></div>
                <div><dt>Collapse event</dt><dd>{p.collapse_status ? `${STATUS[txt(p.collapse_status)] ?? txt(p.collapse_status)} · ${date(p.collapse_date)}` : 'None recorded'}</dd></div>
              </dl>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Shared intelligence</h3><span className="note">{agencyCount} shared-agency records</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="data-table">
                <tbody>
                  <tr><td><span className="agency">ASIC</span></td><td>Register status, licences, banned register{Number(p.directors_possible_banned_match) > 0 ? ` · ${txt(p.directors_possible_banned_match)} possible director match (unconfirmed)` : ''}</td><td className="num"><Prov p={p.asic_provenance ?? 'public'} /></td></tr>
                  <tr><td><span className="agency">ATO</span></td><td>Debt {money(p.ato_debt_aud)} at {date(p.ato_period)} · on-time lodgement {num(p.lodgement_on_time_pct)}% · STP headcount {num(p.stp_headcount)}{p.ato_tt_total_income_aud ? ` · Tax transparency: income ${money(p.ato_tt_total_income_aud)}, tax payable ${money(p.ato_tt_tax_payable_aud)} (${txt(p.ato_tt_income_year)})` : ''}</td><td className="num"><Prov p={p.ato_provenance} />{p.ato_tt_total_income_aud ? <> <Prov p="public" /></> : null}</td></tr>
                  <tr><td><span className="agency">APRA</span></td><td>{num(p.apra_flag_count)} prudential flags{((p.apra_flags as string[]) ?? []).length ? ` · ${((p.apra_flags as string[]) ?? []).join(', ')}` : ''}</td><td className="num"><Prov p={p.apra_provenance} /></td></tr>
                  <tr><td><span className="agency">AFCA</span></td><td>{num(p.afca_complaints_latest)} complaints in the latest year</td><td className="num"><Prov p={p.afca_provenance} /></td></tr>
                  <tr>
                    <td><span className="agency">AUSTRAC</span></td>
                    <td>
                      {data.austrac.detail
                        ? `${num(data.austrac.detail.smr_count_24m)} SMRs in 24 months · ${num(data.austrac.detail.large_flow_count)} large-flow · latest ${date(data.austrac.detail.latest_report_date)} · ${((data.austrac.detail.smr_types as string[]) ?? []).join(', ')}`
                        : data.austrac.count ? <Restricted count={data.austrac.count} /> : 'No records'}
                    </td>
                    <td className="num">{data.austrac.detail ? <span className="prov restricted">Authorised view</span> : data.austrac.count ? 'Masked' : ''}</td>
                  </tr>
                  <tr><td><span className="agency">DFAT</span></td><td>{((p.sanctions_possible_match_refs as string[]) ?? []).length ? `Possible sanctions-list name match: ${((p.sanctions_possible_match_refs as string[]) ?? []).join(', ')} (requires review)` : 'No sanctions-list name match'}</td><td className="num"><Prov p="public" /></td></tr>
                </tbody>
              </table>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Source records</h3><span className="note">Every number above traces to one of these</span></div>
            <div className="scroll-x" style={{ maxHeight: 280, overflow: 'auto' }}>
              <table className="data-table">
                <thead><tr><th>Agency</th><th>Source</th><th>Key</th><th className="num">Match</th><th>Provenance</th></tr></thead>
                <tbody>
                  {data.sources.map((s) => (
                    <tr key={txt(s.source_record_id)}><td>{txt(s.agency)}</td><td className="mono small">{txt(s.source_table)}</td><td className="mono small">{txt(s.source_key)}</td><td className="num">{pct(s.match_score)}</td><td><Prov p={s.provenance} /></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          {data.resolution.length > 0 && (
            <section className="card">
              <div className="card-head"><h3>Resolution review</h3><span className="ai-label">Possible matches · human decision required</span></div>
              <div className="card-body list">
                {data.resolution.map((r) => (
                  <div className="list-item" key={txt(r.review_id)}>
                    <div>
                      <strong>{titleCase(r.candidate_name)}</strong>
                      <small>{txt(r.candidate_source)} · match {pct(r.match_score)} · {((r.match_reasons as string[]) ?? []).join(', ')}</small>
                    </div>
                    {r.decision ? <span className="badge">{txt(r.decision)}</span> : (
                      <div className="row">
                        <button className="btn sm" onClick={() => decide(txt(r.review_id), 'Not the same')}>Not the same</button>
                        <button className="btn sm" onClick={() => decide(txt(r.review_id), 'Merge')}>Merge</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
        <aside className="column">
          <section className="card">
            <div className="card-head"><h3>{data.risk?.band === 'Collapsed' ? 'Status' : 'Collapse risk'}</h3>{data.risk?.band !== 'Collapsed' && <span className="ai-label">✦ Model · {txt(data.risk?.model_version ?? '').split(';')[0]}</span>}</div>
            <div className="card-body">
              {data.risk?.band === 'Collapsed' ? (
                <>
                  <div className="risk-number"><strong>Collapsed</strong><span>{collapseKind(data.risk.collapse_status)} · {date(data.risk.collapse_date)}</span></div>
                  <p className="note">From the ASIC register. A collapsed entity has no forward collapse probability; the trend shows the calibrated risk it carried beforehand.</p>
                  <Sparkline points={data.risk_history.map((h) => Number(h.p_collapse_12m))} label="Collapse probability at each quarterly snapshot before the collapse" />
                </>
              ) : data.risk ? (
                <>
                  <div className="risk-number"><strong>{pct(data.risk.p_collapse_12m)}</strong><span>{txt(data.risk.band)} · 12 months</span></div>
                  <Sparkline points={data.risk_history.map((h) => Number(h.p_collapse_12m))} label="Collapse probability at each quarterly snapshot" />
                  <p className="note">24-month probability: {pct(data.risk.p_collapse_24m)} · {data.risk_history.length} quarterly snapshots</p>
                  <div className="drivers" style={{ marginTop: 12 }}>
                    {data.risk.drivers.map((d, i) => (
                      <div className="driver" key={i}>
                        <div>{txt(d.sentence)}<small>{txt(d.agency ?? 'ASIC')} · {d.direction === 'raises' ? 'raises' : 'lowers'} risk</small></div>
                        <strong>{Number(d.shap) > 0 ? '+' : '−'}{Math.abs(Math.round(Number(d.shap) * 100))} pts</strong>
                      </div>
                    ))}
                  </div>
                </>
              ) : <Empty title="Not scored">Only companies in the curated focus slice are scored.</Empty>}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Cases</h3></div>
            <div className="card-body list">
              {data.cases.length === 0 && <p className="note">Not a party to any open case.</p>}
              {data.cases.map((c) => (
                <div className="list-item" key={`${txt(c.case_id)}-${txt(c.role)}`} style={{ cursor: 'pointer' }} onClick={() => nav(`/cases/${txt(c.case_id)}/overview`)}>
                  <div><strong>{txt(c.case_id)}</strong><small>{txt(c.role)} · {STAGE_LABEL(c.stage)}</small></div>
                  <span className="mono">PPS {c.pps === null || c.pps === undefined ? '—' : Math.round(Number(c.pps))}</span>
                </div>
              ))}
              {data.past_matters.map((m) => (
                <div className="list-item" key={txt(m.matter_id)}>
                  <div><strong>{txt(m.citation ?? m.matter_id)}</strong><small>{txt(m.matter_type)} · {date(m.judgment_date)} · {Number(m.success) === 1 ? 'Successful' : 'Unsuccessful'}</small></div>
                  <Prov p={m.provenance} />
                </div>
              ))}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Related entities</h3></div>
            <div className="card-body list">
              {data.related.length === 0 && <p className="note">No relationships recorded.</p>}
              {data.related.slice(0, 12).map((r, i) => (
                <div className="list-item" key={i} style={{ cursor: r.name ? 'pointer' : 'default' }} onClick={() => r.name && nav(`/entities/${txt(r.other)}`)}>
                  <div><strong>{titleCase(r.name ?? r.other)}</strong><small>{REL[txt(r.rel_type)] ?? txt(r.rel_type)} · <Prov p={r.provenance} /></small></div>
                  <RiskChip p={r.p_collapse_12m} band={r.band} collapsedOn={r.risk_collapse_date} collapseStatus={r.risk_collapse_status} />
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

/* ---------------- S6 Admin ---------------- */
interface Admin {
  weights: Row[];
  params: Row[];
  proposals: Row[];
  presets: Row[];
  models: Row[];
}
const W_LABELS: [string, string][] = [['w_financial', 'Financial return'], ['w_success', 'Likelihood of success'], ['w_harm', 'Consumer / market harm'], ['w_deterrence', 'Deterrence'], ['w_urgency', 'Urgency']];

export function AdminView() {
  const { me } = useSession();
  const toast = useToast();
  const { data, error, loading, reload } = useApi<Admin>('/api/admin');
  const current = data?.weights[0];
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const [reason, setReason] = useState('');
  const w = useMemo(() => draft ?? Object.fromEntries(W_LABELS.map(([k]) => [k, Number(current?.[k] ?? 0)])), [draft, current]);
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  const propose = async () => {
    try {
      await api.post('/api/admin/weights-proposals', { weights: w, reason });
      toast('Weights proposal recorded · applied by the scoring job after approval');
      setDraft(null);
      setReason('');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  const params = data.params[0];
  return (
    <section className="view active" data-od-id="admin-view">
      <header className="page-head">
        <div><h1>Administration</h1><p>Versioned scoring weights, PPS parameters, registered models and intervention presets.</p></div>
      </header>
      <div className="grid-main">
        <div className="column">
          <section className="card">
            <div className="card-head"><h3>Scoring weights · {txt(current?.weights_version ?? '')}</h3><span className="badge">Current</span></div>
            <div className="card-body criteria">
              {W_LABELS.map(([k, label]) => (
                <div className="criterion" key={k}>
                  <span>{label}</span>
                  {me?.persona === 'Enforcement Lead' ? (
                    <input className="slider" style={{ margin: 0 }} type="range" min={0} max={0.5} step={0.01} value={w[k]} onChange={(e) => setDraft({ ...w, [k]: Number(e.target.value) })} aria-label={`${label} weight`} />
                  ) : (
                    <div className="bar"><span style={{ width: `${w[k] * 100 * 2}%` }} /></div>
                  )}
                  <strong>{Math.round(w[k] * 100)}%</strong>
                </div>
              ))}
              <p className="note">{txt(current?.note ?? '')}</p>
              {draft && (
                <div className="decision-form">
                  <p className={Math.abs(sum - 1) > 0.001 ? 'trend-up' : 'note'}>Total {Math.round(sum * 100)}% (must be 100%)</p>
                  <textarea className="number" placeholder="Reason for the proposed change (required, audited)" value={reason} onChange={(e) => setReason(e.target.value)} />
                  <div className="scenario-actions">
                    <button className="btn" onClick={() => setDraft(null)}>Discard</button>
                    <button className="btn primary" disabled={Math.abs(sum - 1) > 0.001 || reason.trim().length < 5} onClick={propose}>Propose change</button>
                  </div>
                </div>
              )}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>PPS parameters · {txt(params?.params_version ?? '')}</h3><Prov p="derived" /></div>
            <div className="card-body">
              <p className="note">Every constant in the score, including the fitted P(success) coefficients. The live what-if engine and batch scoring both read this version, so results reproduce exactly.</p>
              <table className="data-table"><tbody>
                {Object.entries((typeof params?.params_json === 'string' ? JSON.parse(params.params_json) : params?.params_json ?? {}) as Record<string, number>).map(([k, v]) => (
                  <tr key={k}><td className="mono small">{k}</td><td className="num">{txt(v)}</td></tr>
                ))}
              </tbody></table>
            </div>
          </section>
          {data.proposals.length > 0 && (
            <section className="card">
              <div className="card-head"><h3>Weight proposals</h3></div>
              <table className="data-table">
                <thead><tr><th>Proposed</th><th>By</th><th>Reason</th><th>Status</th></tr></thead>
                <tbody>{data.proposals.map((pr) => <tr key={txt(pr.proposal_id)}><td>{shortDate(pr.proposed_at)}</td><td>{txt(pr.proposed_by_name ?? pr.proposed_by)}</td><td>{txt(pr.reason)}</td><td><span className="stage-chip">{txt(pr.status)}</span></td></tr>)}</tbody>
              </table>
            </section>
          )}
        </div>
        <aside className="column">
          <section className="card">
            <div className="card-head"><h3>Model registry</h3><span className="note">Unity Catalog</span></div>
            <div className="card-body list">
              {data.models.length === 0 && <p className="note">No registered model versions found.</p>}
              {data.models.map((m, i) => (
                <div className="list-item" key={i}>
                  <div>
                    <strong>{txt(m.model_name).split('.').pop()} v{txt(m.version ?? '?')}</strong>
                    <small>{m.error ? txt(m.error) : `${txt(m.status ?? '')} · ${m.created_at ? date(Number(m.created_at)) : ''}`}</small>
                  </div>
                  {((m.aliases as string[]) ?? []).map((a) => <span className="badge" key={a}>{a}</span>)}
                </div>
              ))}
              <div className="list-item"><div><strong>Evidence extraction &amp; briefs</strong><small>Foundation Model API · via the app’s serving endpoint</small></div><span className="badge">Current</span></div>
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Intervention presets</h3></div>
            <div className="card-body list">
              {data.presets.map((pr) => (
                <div className="list-item" key={txt(pr.preset_id)}>
                  <div><strong>{txt(pr.name)}</strong><small>cost ×{txt(pr.cost_multiplier)} · duration ×{txt(pr.duration_multiplier)}{pr.p_collapse_override !== null ? ` · P(collapse) → ${pct(pr.p_collapse_override)}` : ''}{pr.p_success_override !== null ? ` · P(success) → ${pct(pr.p_success_override)}` : ''} · recoverable ×{txt(pr.recoverable_multiplier)}</small></div>
                </div>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

/* ---------------- Data sources & provenance ---------------- */
export function SourcesView() {
  const { data, error, loading, reload } = useApi<{ sources: Row[]; record_counts: Row[] }>('/api/sources');
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <PageSkeleton />;
  return (
    <section className="view active">
      <header className="page-head">
        <div>
          <h1>Data sources &amp; provenance</h1>
          <p>Real public data wherever it exists; synthetic data only where a confidential source would sit in production. Every record carries a provenance badge.</p>
        </div>
        <div className="row"><Prov p="public" /><Prov p="synthetic" /><Prov p="derived" /></div>
      </header>
      <div className="grid-main">
        <section className="card">
          <table className="data-table">
            <thead><tr><th>Source</th><th>Publisher</th><th>Feeds</th><th>Licence</th><th>Provenance</th></tr></thead>
            <tbody>
              {data?.sources.map((s) => (
                <tr key={txt(s.id)}><td><strong>{txt(s.name)}</strong><small className="note">{txt(s.id)}</small></td><td>{txt(s.publisher)}</td><td>{txt(s.feeds)}</td><td className="small">{txt(s.licence)}</td><td><Prov p={s.provenance} /></td></tr>
              ))}
            </tbody>
          </table>
        </section>
        <aside className="card">
          <div className="card-head"><h3>Linked source records</h3></div>
          <table className="data-table">
            <thead><tr><th>Agency</th><th>Provenance</th><th className="num">Records</th></tr></thead>
            <tbody>{data?.record_counts.map((r, i) => <tr key={i}><td>{txt(r.agency)}</td><td><Prov p={r.provenance} /></td><td className="num">{num(r.records)}</td></tr>)}</tbody>
          </table>
        </aside>
      </div>
    </section>
  );
}

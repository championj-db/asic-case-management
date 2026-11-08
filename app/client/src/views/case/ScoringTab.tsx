import { useMemo, useState } from 'react';
import {
  applyPreset, breakEven, computePps, contributions, sensitivity, withCollapse24,
  type InterventionPreset, type PpsInputs, type PpsParams, type PpsResult, type PpsWeights,
} from '../../../../shared/pps';
import { api, useApi } from '../../lib/api';
import { collapseKind, date, money, pct, monthYear, shortDate, txt } from '../../lib/format';
import { AiLabel, Empty, ErrorState, PageSkeleton, Sparkline, useSession, useToast, type Row } from '../../components/common';

interface Scoring {
  scored: boolean;
  inputs: Row;
  criteria: Row;
  total: number;
  band: string;
  weights: PpsWeights;
  weights_version: string;
  params: PpsParams;
  params_version: string;
  model_version: string;
  scored_at: string;
  as_of_date: string;
  risk_defaulted: boolean;
  presets: InterventionPreset[];
  risk: { p_collapse_12m: number; p_collapse_24m: number; band: string; collapse_date?: string | null; collapse_status?: string | null; model_version: string; scored_at: string; drivers: Row[] } | null;
  risk_history: Row[];
  pps_history: Row[];
  system_scenarios: (Row & { inputs: Row; outputs: Row })[];
  saved_scenarios: (Row & { inputs: Row; outputs: Row })[];
  decisions: Row[];
  austrac_authorised: boolean;
}

const VIZ = ['var(--viz-2)', 'var(--viz-5)', 'var(--viz-4)', 'var(--viz-8)', 'var(--viz-9)'];

function toInputs(r: Row): PpsInputs {
  return {
    recoverable: Number(r.recoverable ?? 0),
    litigation_cost: Number(r.litigation_cost ?? 1),
    duration_months: Number(r.duration_months ?? 12),
    p_success: Number(r.p_success ?? 0.5),
    p_collapse_12m: Number(r.p_collapse_12m ?? 0.1),
    p_collapse_24m: Number(r.p_collapse_24m ?? 0.2),
    consumers_affected: Number(r.consumers_affected ?? 0),
    consumer_loss: Number(r.consumer_loss ?? 0),
    vulnerable: Boolean(r.vulnerable),
    strategic_priority: Number(r.strategic_priority ?? 0),
    months_to_limitation: Number(r.months_to_limitation ?? 60),
    recent_smr: Boolean(r.recent_smr),
  };
}

function toResult(r: Row): PpsResult {
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    total: n('total'), band: txt(r.band ?? '') as PpsResult['band'], financial: n('financial'), success: n('success'), harm: n('harm'),
    deterrence: n('deterrence'), urgency: n('urgency'), p_collapse_before_judgment: n('p_collapse_before_judgment'),
    expected_recovery: n('expected_recovery'), expected_net_recovery: n('expected_net_recovery'),
    return_ratio: r.return_ratio === null || r.return_ratio === undefined ? null : n('return_ratio'),
  };
}

interface Field {
  key: string;
  label: string;
  hint: string;
  min: number;
  max: number;
  step: number;
  get: (i: PpsInputs) => number;
  set: (i: PpsInputs, v: number) => PpsInputs;
}

const FIELDS: Field[] = [
  { key: 'cost', label: 'Litigation cost', hint: 'Estimated external and internal cost · $m', min: 0.05, max: 10, step: 0.05, get: (i) => i.litigation_cost / 1e6, set: (i, v) => ({ ...i, litigation_cost: Math.max(v, 0.01) * 1e6 }) },
  { key: 'recovery', label: 'Recoverable amount', hint: 'Excludes penalties · $m', min: 0, max: 50, step: 0.1, get: (i) => i.recoverable / 1e6, set: (i, v) => ({ ...i, recoverable: v * 1e6 }) },
  { key: 'success', label: 'Probability of success', hint: 'Counsel assessment · %', min: 1, max: 99, step: 1, get: (i) => Math.round(i.p_success * 100), set: (i, v) => ({ ...i, p_success: v / 100 }) },
  { key: 'collapse', label: 'Collapse probability', hint: 'Within 24 months (model) · %', min: 0, max: 99, step: 1, get: (i) => Math.round(i.p_collapse_24m * 100), set: (i, v) => withCollapse24(i, v / 100) },
  { key: 'loss', label: 'Consumer loss', hint: 'Harm criterion input · $m', min: 0, max: 100, step: 0.1, get: (i) => i.consumer_loss / 1e6, set: (i, v) => ({ ...i, consumer_loss: v * 1e6 }) },
];
const ADVANCED: Field[] = [
  { key: 'duration', label: 'Case duration', hint: 'Months to judgment', min: 2, max: 72, step: 1, get: (i) => Math.round(i.duration_months), set: (i, v) => ({ ...i, duration_months: v }) },
  { key: 'strategic', label: 'Deterrence / strategic priority', hint: 'Lead assessment · 0–100', min: 0, max: 100, step: 1, get: (i) => Math.round(i.strategic_priority), set: (i, v) => ({ ...i, strategic_priority: v }) },
  { key: 'consumers', label: 'Consumers affected', hint: 'People', min: 0, max: 200000, step: 50, get: (i) => i.consumers_affected, set: (i, v) => ({ ...i, consumers_affected: v }) },
];

function recommendationText(r: PpsResult, w: PpsWeights): string {
  const parts = contributions(r, w).slice().sort((a, b) => b.points - a.points);
  const lead = parts.slice(0, 2).map((p) => p.label.toLowerCase());
  const weak = parts[parts.length - 1].label.toLowerCase();
  const verb = r.band === 'Proceed' ? 'clears the proceed threshold' : r.band === 'Proceed – conditional' ? 'clears the conditional threshold' : r.band === 'Consider alternatives' ? 'falls in the alternatives band' : 'falls below the alternatives threshold';
  return `The matter ${verb}, led by ${lead.join(' and ')}. ${weak.charAt(0).toUpperCase() + weak.slice(1)} contributes least; check the sensitivity analysis before deciding.`;
}

/** Largest PPS swing for a driver; tiny effects read as 0 rather than a signed zero. */
const swing = (v: number) => (Math.abs(v) < 0.05 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`);

/** One proposed decision with its four-eyes approval state; a different Enforcement Lead can approve or return it. */
function DecisionRow({ d, onDone }: { d: Row; onDone: () => void }) {
  const { me } = useSession();
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const status = txt(d.approval_status);
  const canApprove = status === 'Awaiting approval' && me?.persona === 'Enforcement Lead' && me.userId !== d.decided_by;
  const act = async (action: 'Approved' | 'Returned') => {
    setBusy(true);
    try {
      await api.post(`/api/decisions/${txt(d.decision_id)}/approval`, { action, note });
      toast(`Decision ${action.toLowerCase()}`);
      onDone();
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="list-item" style={{ alignItems: 'flex-start', flexDirection: 'column', gap: 8 }}>
      <div className="spread" style={{ width: '100%' }}>
        <div><strong>{txt(d.decision)}</strong><small>{txt(d.rationale)}</small></div>
        <span className={`badge${status === 'Approved' ? ' good' : status === 'Returned' ? ' warn' : ''}`}>{status}</span>
      </div>
      <small>
        Proposed by {txt(d.decided_by_name ?? d.decided_by)} · {shortDate(d.decided_at)} · PPS {Math.round(Number(d.pps_total))}
        {d.approver ? ` · ${status.toLowerCase()} by ${txt(d.approver_name ?? d.approver)} ${shortDate(d.approved_at)}${d.approval_note ? `: “${txt(d.approval_note)}”` : ''}` : ''}
      </small>
      {canApprove && (
        <div className="row" style={{ gap: 8, width: '100%' }}>
          <input className="input" style={{ flex: 1 }} placeholder="Approval note (required)" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Approval note" />
          <button className="btn sm primary" disabled={busy || note.trim().length < 5} onClick={() => void act('Approved')}>Approve</button>
          <button className="btn sm" disabled={busy || note.trim().length < 5} onClick={() => void act('Returned')}>Return</button>
        </div>
      )}
      {status === 'Awaiting approval' && me?.userId === d.decided_by && <small className="muted">A different enforcement lead must approve this decision.</small>}
    </div>
  );
}

export function ScoringTab({ caseId, onChange }: { caseId: string; onChange: () => void }) {
  const { data, error, loading, reload } = useApi<Scoring>(`/api/cases/${caseId}/scoring`);
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  if (!data.scored) return <Empty title="Not yet scored">This case was opened from intake. It is scored on the next run of the scoring job.</Empty>;
  return <ScoringBody key={`${data.params_version}-${data.saved_scenarios.length}-${data.decisions.length}`} data={data} caseId={caseId} reload={() => { reload(); onChange(); }} />;
}

function ScoringBody({ data, caseId, reload }: { data: Scoring; caseId: string; reload: () => void }) {
  const { me } = useSession();
  const toast = useToast();
  const base = useMemo(() => toInputs(data.inputs), [data.inputs]);
  const [inputs, setInputs] = useState<PpsInputs>(base);
  const [weights, setWeights] = useState<PpsWeights>(data.weights);
  const [preset, setPreset] = useState<string>('baseline');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [compare, setCompare] = useState<{ name: string; r: PpsResult; inputs: PpsInputs }[]>([]);
  const [name, setName] = useState('');
  const [decision, setDecision] = useState('');
  const [rationale, setRationale] = useState('');

  const baseline = useMemo(() => computePps(base, data.weights, data.params), [base, data.weights, data.params]);
  const live = useMemo(() => computePps(inputs, weights, data.params), [inputs, weights, data.params]);
  const sens = useMemo(() => sensitivity(inputs, weights, data.params), [inputs, weights, data.params]);
  const be = useMemo(() => breakEven(inputs, weights, data.params), [inputs, weights, data.params]);
  const contrib = contributions(baseline, data.weights);
  const sensMax = Math.max(...sens.map((s) => Math.max(Math.abs(s.low), Math.abs(s.high))), 1);
  const isLead = me?.persona === 'Enforcement Lead';
  const changedWeights = JSON.stringify(weights) !== JSON.stringify(data.weights);
  const parityOk = Math.abs(baseline.total - Number(data.total)) <= 0.1;

  const choosePreset = (id: string) => {
    setPreset(id);
    if (id === 'baseline') setInputs(base);
    else {
      const p = data.presets.find((x) => x.preset_id === id);
      if (p) setInputs(applyPreset(base, p));
    }
  };
  const presetName = preset === 'baseline' ? 'Baseline' : data.presets.find((p) => p.preset_id === preset)?.name ?? 'Working scenario';

  const save = async () => {
    try {
      await api.post(`/api/cases/${caseId}/scenarios`, {
        name: name.trim() || (preset === 'baseline' && JSON.stringify(inputs) !== JSON.stringify(base) ? 'Working scenario' : presetName),
        preset_id: preset === 'baseline' ? null : preset,
        inputs,
        weights: changedWeights ? weights : undefined,
      });
      toast(`Scenario saved with ${data.model_version.split(';')[0]}, weights ${data.weights_version} and params ${data.params_version}`);
      setName('');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };
  const recordDecision = async () => {
    try {
      await api.post(`/api/cases/${caseId}/decision`, { decision, rationale });
      toast('Decision recorded · audited');
      reload();
    } catch (e) {
      toast((e as Error).message);
    }
  };

  const comparisonRows = [
    { name: 'Baseline', r: baseline, inputs: base, by: 'scoring job' },
    ...data.saved_scenarios.slice(0, 3).map((s) => ({ name: txt(s.name), r: toResult(s.outputs), inputs: toInputs(s.inputs), by: txt(s.author_name ?? s.author) })),
    ...compare.map((c) => ({ ...c, by: 'unsaved' })),
  ].slice(0, 4);

  return (
    <section className="case-panel active" data-od-id="scoring-panel">
      <section className="decision-bar" data-od-id="decision-heading">
        <div>
          <h2>Prosecution decision support</h2>
          <p>Test assumptions, compare interventions and record a reproducible recommendation. Scores as at {date(data.as_of_date)}.</p>
        </div>
        <span className="ai-label">Decision aid · Human approval required</span>
      </section>
      <div className="workspace">
        <div className="column">
          <section className="card" data-od-id="baseline-pps">
            <div className="card-head">
              <h3>Baseline priority score</h3>
              <span className="badge" title={`Parameters ${data.params_version}`}>Weights {data.weights_version}</span>
            </div>
            <div className="card-body">
              <div className="score-hero">
                <div className="score-ring" style={{ background: `conic-gradient(var(--fg) 0 ${baseline.total}%, var(--border-soft) ${baseline.total}% 100%)` }}>
                  <div className="score-value"><strong>{Math.round(baseline.total)}</strong><span>of 100</span></div>
                </div>
                <div className="recommendation">
                  <span className="ai-label">Current recommendation</span>
                  <h2>{baseline.band}</h2>
                  <p>{recommendationText(baseline, data.weights)}</p>
                </div>
              </div>
              <div className="stacked" role="img" aria-label="PPS contribution by criterion">
                {contrib.map((c, i) => (
                  <span key={c.key} style={{ width: `${c.points}%`, background: VIZ[i] }} title={`${c.label}: ${c.points.toFixed(1)} points`} />
                ))}
              </div>
              <div className="criteria" aria-label="PPS criteria breakdown">
                {contrib.map((c, i) => (
                  <div className="criterion" key={c.key}>
                    <span><span className="band-mark" style={{ background: VIZ[i] }} />{c.label} · {Math.round(c.weight * 100)}%</span>
                    <div className="bar"><span style={{ width: `${c.score}%` }} /></div>
                    <strong>{Math.round(c.score)}</strong>
                  </div>
                ))}
              </div>
              <p className="note">
                {data.risk_defaulted ? 'No collapse score for this respondent; default probabilities used. ' : ''}
                {!data.austrac_authorised ? 'Urgency may include restricted agency signals (not shown). ' : ''}
                Criteria, weights and thresholds require ASIC confirmation. {parityOk ? '' : `Live engine differs from batch score (${data.total}) — parameters may have changed since scoring.`}
              </p>
              {data.pps_history.length > 1 && (
                <>
                  <Sparkline points={data.pps_history.map((h) => Number(h.total))} label="PPS at each quarterly scoring snapshot" zeroBase={false} />
                  <p className="note">PPS by quarter: {data.pps_history.map((h) => `${monthYear(h.as_of_date)}: ${Math.round(Number(h.total))}`).join(' · ')}</p>
                </>
              )}
            </div>
          </section>
          <section className="card" data-od-id="collapse-model">
            <div className="card-head">
              <h3>{data.risk?.band === 'Collapsed' ? 'Respondent status' : 'Collapse probability'}</h3>
              {data.risk && <AiLabel model={data.risk.model_version.split(';')[0]} at={data.risk.scored_at}>Model</AiLabel>}
            </div>
            {data.risk?.band === 'Collapsed' ? (
              <div className="card-body">
                <div className="risk-number">
                  <strong>Collapsed</strong>
                  <span>{collapseKind(data.risk.collapse_status)} · {date(data.risk.collapse_date)}</span>
                </div>
                <p className="note">
                  From the ASIC register. The respondent has already collapsed, so no forward probability applies: the PPS treats collapse as certain,
                  which removes most of the expected recovery. Consider recovery from directors, related entities or insurers, or a non-financial outcome.
                </p>
              </div>
            ) : data.risk ? (
              <div className="card-body risk-layout">
                <div className="risk-number">
                  <strong>{pct(data.risk.p_collapse_12m)}</strong>
                  <span>{data.risk.band} · 12 months</span>
                  <p className="note">24 months: {pct(data.risk.p_collapse_24m)}</p>
                  <Sparkline points={data.risk_history.map((h) => Number(h.p_collapse_12m))} label="Collapse probability over time" height={36} />
                </div>
                <div className="drivers">
                  {data.risk.drivers.map((d, i, all) => (
                    <div className="driver" key={i}>
                      <div>{txt(d.label)}<small>{txt(d.sentence)} · {txt(d.agency ?? 'ASIC')}</small></div>
                      <strong title="Share of the shown drivers' total contribution (SHAP, log-odds)">{Number(d.shap) >= 0 ? '↑' : '↓'} {Math.round((Math.abs(Number(d.shap)) / (all.reduce((a, x) => a + Math.abs(Number(x.shap) || 0), 0) || 1)) * 100)}%</strong>
                    </div>
                  ))}
                  <p className="note">Probabilities are calibrated to the collapse rate observed on the ASIC register. ↑ raises / ↓ lowers risk; % is each driver&rsquo;s share of the shown contribution (SHAP).</p>
                  <p className="note">Top drivers by SHAP contribution. Cross-agency signals (ATO, APRA, AFCA, AUSTRAC) are what ASIC cannot see on its own registers.</p>
                </div>
              </div>
            ) : (
              <div className="card-body"><p className="note">Respondent is not scored by the collapse model; defaults are used.</p></div>
            )}
          </section>
          <section className="card" data-od-id="sensitivity-chart">
            <div className="card-head"><h3>Sensitivity</h3><span className="ai-label">Impact on PPS of ±20% change</span></div>
            <div className="card-body tornado">
              {sens.map((s) => {
                const neg = Math.min(s.low, s.high);
                const pos = Math.max(s.low, s.high);
                return (
                  <div className="t-row" key={s.key} title={`−20%: ${s.low > 0 ? '+' : ''}${s.low} · +20%: ${s.high > 0 ? '+' : ''}${s.high}`}>
                    <span>{s.label}</span>
                    <div className="t-bar" style={{ position: 'relative' }}>
                      {neg < 0 && <span className="t-fill left" style={{ width: `${(Math.abs(neg) / sensMax) * 50}%`, position: 'absolute', right: '50%', marginRight: 0 }} />}
                      {pos > 0 && <span className="t-fill right" style={{ width: `${(pos / sensMax) * 50}%`, position: 'absolute', left: '50%', marginLeft: 0, background: 'var(--viz-5)' }} />}
                    </div>
                    <strong>{swing(pos >= Math.abs(neg) ? pos : neg)}</strong>
                  </div>
                );
              })}
            </div>
          </section>
        </div>
        <div className="column">
          <section className="card" data-od-id="scenario-modeller">
            <div className="card-head">
              <h3>Scenario modeller</h3>
              <button className="btn" data-od-id="reset-scenario" onClick={() => { choosePreset('baseline'); setWeights(data.weights); }}>Reset</button>
            </div>
            <div className="card-body">
              <div className="presets" aria-label="Intervention presets">
                <button className={`preset${preset === 'baseline' ? ' active' : ''}`} onClick={() => choosePreset('baseline')} aria-pressed={preset === 'baseline'}>Baseline</button>
                {data.presets.map((p) => (
                  <button key={p.preset_id} className={`preset${preset === p.preset_id ? ' active' : ''}`} onClick={() => choosePreset(p.preset_id)} aria-pressed={preset === p.preset_id}>
                    {p.name}
                  </button>
                ))}
              </div>
              <div className="form-grid">
                {[...FIELDS, ...(showAdvanced ? ADVANCED : [])].map((f) => {
                  const v = f.get(inputs);
                  return (
                    <div className="field" key={f.key}>
                      <label htmlFor={`f-${f.key}`}>{f.label}<span>{f.hint}</span></label>
                      <input className="number" id={`f-${f.key}-n`} type="number" min={f.min} max={f.max} step={f.step} value={Number(v.toFixed(2))} onChange={(e) => setInputs(f.set(inputs, Number(e.target.value)))} aria-label={`${f.label} value`} />
                      <input className="slider" id={`f-${f.key}`} type="range" min={f.min} max={Math.max(f.max, v)} step={f.step} value={v} onChange={(e) => setInputs(f.set(inputs, Number(e.target.value)))} />
                    </div>
                  );
                })}
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn sm ghost" onClick={() => setShowAdvanced((s) => !s)}>{showAdvanced ? 'Fewer inputs' : 'More inputs'}</button>
                <label className="row small"><input type="checkbox" checked={inputs.vulnerable} onChange={(e) => setInputs({ ...inputs, vulnerable: e.target.checked })} /> Vulnerable cohort affected</label>
              </div>
              {isLead && showAdvanced && (
                <div className="criteria" style={{ marginTop: 16 }}>
                  <span className="ai-label">Criterion weights · leads only · saved scenarios are marked “custom”</span>
                  {(['w_financial', 'w_success', 'w_harm', 'w_deterrence', 'w_urgency'] as const).map((k, i) => (
                    <div className="criterion" key={k}>
                      <span>{contrib[i].label}</span>
                      <input className="slider" style={{ margin: 0 }} type="range" min={0} max={0.5} step={0.01} value={weights[k]} onChange={(e) => setWeights({ ...weights, [k]: Number(e.target.value) })} aria-label={`${contrib[i].label} weight`} />
                      <strong>{Math.round(weights[k] * 100)}%</strong>
                    </div>
                  ))}
                </div>
              )}
              <div className="live-result" aria-live="polite">
                <div className="result"><span>Scenario PPS</span><strong>{Math.round(live.total)}</strong></div>
                <div className="result"><span>Recommendation</span><strong style={{ fontSize: 'var(--text-base)' }}>{live.band.replace('Proceed – conditional', 'Conditional')}</strong></div>
                <div className="result"><span>Expected net recovery</span><strong>{money(live.expected_net_recovery, 2)}</strong></div>
              </div>
              <div className="break-even">
                <strong>Break-even</strong>
                <span>
                  {be.maxLitigationCost === null
                    ? 'Prosecution stays below the conditional threshold at any litigation cost under these assumptions'
                    : be.costAlwaysAbove
                      ? 'Prosecution stays above the conditional threshold across the cost range tested'
                      : `Prosecution remains above threshold while litigation cost is below ${money(be.maxLitigationCost, 2)}`}
                  {be.maxCollapse24 === null ? '.' : be.collapseAlwaysAbove ? ', at any collapse probability.' : ` or collapse probability stays below ${Math.round(be.maxCollapse24 * 100)}%.`}
                </span>
              </div>
              <div className="row" style={{ marginTop: 16 }}>
                <input className="number" style={{ flex: 1 }} placeholder={`Scenario name (default: ${presetName})`} value={name} onChange={(e) => setName(e.target.value)} aria-label="Scenario name" />
              </div>
              <div className="scenario-actions">
                <button className="btn" data-od-id="compare-scenario" disabled={comparisonRows.length >= 4} onClick={() => setCompare([...compare, { name: name.trim() || presetName, r: live, inputs }])}>Add to compare</button>
                <button className="btn primary" data-od-id="save-scenario" onClick={save}>Save scenario</button>
              </div>
              <p className="note">
                Scenario will be stamped with {me?.displayName}, {data.model_version.split(';')[0]}, weights {data.weights_version}{changedWeights ? ' (custom)' : ''} and params {data.params_version}. Saving creates an audit event; the server recomputes the score.
              </p>
            </div>
          </section>
          <section className="card" data-od-id="scenario-comparison">
            <div className="card-head"><h3>Scenario comparison</h3><span className="badge">{comparisonRows.length} of 4</span></div>
            <div className="card-body" style={{ padding: 0 }}>
              <table className="comparison">
                <thead><tr><th>Scenario</th><th>PPS</th><th>P(collapse)</th><th>Net recovery</th></tr></thead>
                <tbody>
                  {comparisonRows.map((s, i) => (
                    <tr key={i}>
                      <td>{s.name}<small className="note" style={{ display: 'block' }}>{s.by}</small></td>
                      <td className="mono">{Math.round(Number(s.r.total))}</td>
                      <td className="mono">{pct(s.inputs.p_collapse_24m)}</td>
                      <td className="mono">{money(s.r.expected_net_recovery, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.system_scenarios.length > 1 && (
                <p className="note" style={{ padding: '0 16px 16px' }}>
                  Batch presets: {data.system_scenarios.filter((s) => s.preset_id).map((s) => `${txt(s.name)} ${Math.round(Number(s.outputs.total))}`).join(' · ')}
                </p>
              )}
            </div>
          </section>
          <section className="card">
            <div className="card-head"><h3>Prosecution decision</h3><span className="ai-label">Proposed by a lead or counsel · approved by a second lead · audited</span></div>
            <div className="card-body">
              {data.decisions.length > 0 && (
                <div className="list" style={{ marginBottom: 12 }}>
                  {data.decisions.slice(0, 3).map((d) => <DecisionRow key={txt(d.decision_id)} d={d} onDone={reload} />)}
                </div>
              )}
              {me?.persona === 'Investigator' ? (
                <p className="note">Decisions are recorded by an enforcement lead or counsel.</p>
              ) : (
                <div className="decision-form">
                  <select className="select" value={decision} onChange={(e) => setDecision(e.target.value)} aria-label="Decision">
                    <option value="">Choose a decision…</option>
                    {['Proceed', 'Proceed – conditional', 'Consider alternatives', 'Do not pursue'].map((d) => <option key={d}>{d}</option>)}
                  </select>
                  <textarea className="number" placeholder="Rationale (required). Reference the scenarios and evidence that support the decision." value={rationale} onChange={(e) => setRationale(e.target.value)} aria-label="Decision rationale" />
                  <div className="scenario-actions">
                    <button className="btn primary" disabled={!decision || rationale.trim().length < 10} onClick={recordDecision}>Propose decision</button>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      </div>
    </section>
  );
}

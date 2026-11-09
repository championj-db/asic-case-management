/**
 * Prosecution Priority Score (SPEC 8.2) — an exact port of the SQL function `pps_compute`
 * (src/notebooks/05_score_risk_and_pps.ipynb). Every constant comes from the versioned `pps_params`
 * table, so the live what-if engine in the browser and batch scoring in Databricks agree.
 *
 * A decision aid only: it never makes the decision.
 */

export interface PpsParams {
  success_b0: number;
  success_b1: number;
  success_default_strength: number;
  fin_return_cap: number;
  collapse_clamp: number;
  harm_consumers_log_scale: number;
  harm_loss_log_scale: number;
  harm_w_consumers: number;
  harm_w_loss: number;
  harm_w_vulnerable: number;
  urg_w_collapse: number;
  urg_w_smr: number;
  urg_w_limitation: number;
  limitation_window_months: number;
  limitation_ramp_months: number;
  default_p_collapse_12m: number;
  default_p_collapse_24m: number;
  band_proceed: number;
  band_conditional: number;
  band_alternatives: number;
}

export interface PpsWeights {
  w_financial: number;
  w_success: number;
  w_harm: number;
  w_deterrence: number;
  w_urgency: number;
}

export interface PpsInputs {
  recoverable: number;
  litigation_cost: number;
  duration_months: number;
  p_success: number;
  p_collapse_12m: number;
  p_collapse_24m: number;
  consumers_affected: number;
  consumer_loss: number;
  vulnerable: boolean;
  strategic_priority: number;
  months_to_limitation: number;
  recent_smr: boolean;
}

export type Band = 'Proceed' | 'Proceed – conditional' | 'Consider alternatives' | 'Do not pursue';

export interface PpsResult {
  total: number;
  band: Band;
  financial: number;
  success: number;
  harm: number;
  deterrence: number;
  urgency: number;
  p_collapse_before_judgment: number;
  expected_recovery: number;
  expected_net_recovery: number;
  return_ratio: number | null;
}

/** Spark `round(x, d)` is HALF_UP on the decimal value; the epsilon absorbs binary representation error. */
export function roundHalfUp(x: number, digits: number): number {
  const f = 10 ** digits;
  const v = Math.abs(x) * f;
  return (Math.sign(x) * Math.floor(v + 0.5 + 1e-9)) / f;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi);

export function bandFor(total: number, p: PpsParams): Band {
  if (total >= p.band_proceed) return 'Proceed';
  if (total >= p.band_conditional) return 'Proceed – conditional';
  if (total >= p.band_alternatives) return 'Consider alternatives';
  return 'Do not pursue';
}

export function pSuccessFromStrength(strength: number | null | undefined, p: PpsParams): number {
  const s = strength ?? p.success_default_strength;
  return 1 / (1 + Math.exp(-(p.success_b0 + p.success_b1 * s)));
}

export function computePps(i: PpsInputs, w: PpsWeights, p: PpsParams): PpsResult {
  const pcb = 1 - Math.pow(1 - clamp(i.p_collapse_24m, 0, p.collapse_clamp), i.duration_months / 24);
  const er = i.recoverable * i.p_success * (1 - pcb);
  const ratio = i.litigation_cost !== 0 ? er / i.litigation_cost : null;
  const fin = 100 * Math.min((ratio ?? 0) / p.fin_return_cap, 1);
  const suc = 100 * i.p_success;
  const hrm =
    100 *
    (p.harm_w_consumers * Math.min(Math.log10(Math.max(i.consumers_affected, 0) + 1) / p.harm_consumers_log_scale, 1) +
      p.harm_w_loss * Math.min(Math.log10(Math.max(i.consumer_loss, 0) + 1) / p.harm_loss_log_scale, 1) +
      p.harm_w_vulnerable * (i.vulnerable ? 1 : 0));
  const det = clamp(i.strategic_priority ?? 0, 0, 100);
  const urg =
    100 *
    (p.urg_w_collapse * i.p_collapse_12m +
      p.urg_w_smr * (i.recent_smr ? 1 : 0) +
      p.urg_w_limitation * clamp((p.limitation_window_months - i.months_to_limitation) / p.limitation_ramp_months, 0, 1));
  const total = roundHalfUp(w.w_financial * fin + w.w_success * suc + w.w_harm * hrm + w.w_deterrence * det + w.w_urgency * urg, 1);
  return {
    total,
    band: bandFor(total, p),
    financial: roundHalfUp(fin, 1),
    success: roundHalfUp(suc, 1),
    harm: roundHalfUp(hrm, 1),
    deterrence: roundHalfUp(det, 1),
    urgency: roundHalfUp(urg, 1),
    p_collapse_before_judgment: roundHalfUp(pcb, 4),
    expected_recovery: roundHalfUp(er, 0),
    expected_net_recovery: roundHalfUp(er - i.litigation_cost, 0),
    return_ratio: ratio === null ? null : roundHalfUp(ratio, 3),
  };
}

/** Contribution of each criterion to the total (weight × criterion score), for the stacked bar. */
export function contributions(r: PpsResult, w: PpsWeights) {
  return [
    { key: 'financial', label: 'Financial return', weight: w.w_financial, score: r.financial, points: w.w_financial * r.financial },
    { key: 'success', label: 'Likelihood of success', weight: w.w_success, score: r.success, points: w.w_success * r.success },
    { key: 'harm', label: 'Consumer / market harm', weight: w.w_harm, score: r.harm, points: w.w_harm * r.harm },
    { key: 'deterrence', label: 'Deterrence / strategic priority', weight: w.w_deterrence, score: r.deterrence, points: w.w_deterrence * r.deterrence },
    { key: 'urgency', label: 'Urgency', weight: w.w_urgency, score: r.urgency, points: w.w_urgency * r.urgency },
  ] as const;
}

/** Collapse probability edits move the 12- and 24-month probabilities together, keeping their ratio. */
export function withCollapse24(i: PpsInputs, p24: number): PpsInputs {
  const ratio = i.p_collapse_24m > 0 ? i.p_collapse_12m / i.p_collapse_24m : 0.5;
  return { ...i, p_collapse_24m: p24, p_collapse_12m: clamp(p24 * ratio, 0, 1) };
}

export interface SensitivityRow {
  key: string;
  label: string;
  low: number;
  high: number;
}

/** Tornado: change in PPS when each input moves −20% / +20% (probabilities clamped to [0, 1]). */
export function sensitivity(i: PpsInputs, w: PpsWeights, p: PpsParams, pct = 0.2): SensitivityRow[] {
  const base = computePps(i, w, p).total;
  const bump = (f: (x: PpsInputs, m: number) => PpsInputs) => [
    roundHalfUp(computePps(f(i, 1 - pct), w, p).total - base, 1),
    roundHalfUp(computePps(f(i, 1 + pct), w, p).total - base, 1),
  ];
  const rows: [string, string, (x: PpsInputs, m: number) => PpsInputs][] = [
    ['litigation_cost', 'Litigation cost', (x, m) => ({ ...x, litigation_cost: x.litigation_cost * m })],
    ['p_collapse', 'Insolvency risk', (x, m) => withCollapse24(x, clamp(x.p_collapse_24m * m, 0, 1))],
    ['p_success', 'P(success)', (x, m) => ({ ...x, p_success: clamp(x.p_success * m, 0, 1) })],
    ['recoverable', 'Recoverable amount', (x, m) => ({ ...x, recoverable: x.recoverable * m })],
    ['duration_months', 'Case duration', (x, m) => ({ ...x, duration_months: x.duration_months * m })],
    ['consumer_loss', 'Consumer loss', (x, m) => ({ ...x, consumer_loss: x.consumer_loss * m })],
  ];
  return rows
    .map(([key, label, f]) => {
      const [low, high] = bump(f);
      return { key, label, low, high };
    })
    .sort((a, b) => Math.max(Math.abs(b.low), Math.abs(b.high)) - Math.max(Math.abs(a.low), Math.abs(a.high)));
}

export interface BreakEven {
  threshold: number;
  maxLitigationCost: number | null; // highest cost that keeps the PPS at or above the threshold (null = never / always)
  maxCollapse24: number | null; // highest P(collapse 24m) that keeps the PPS at or above the threshold
  costAlwaysAbove: boolean;
  collapseAlwaysAbove: boolean;
}

/** Break-even thresholds for the conditional band, found by scanning (the PPS is not monotonic in collapse risk). */
export function breakEven(i: PpsInputs, w: PpsWeights, p: PpsParams, threshold = p.band_conditional): BreakEven {
  const ok = (x: PpsInputs) => computePps(x, w, p).total >= threshold;
  let maxCost: number | null = null;
  const top = Math.max(i.litigation_cost * 10, 1_000_000);
  for (let s = 0; s <= 400; s++) {
    const c = (top * s) / 400;
    if (ok({ ...i, litigation_cost: Math.max(c, 1) })) maxCost = c;
  }
  let maxCol: number | null = null;
  for (let s = 0; s <= 100; s++) {
    const v = s / 100;
    if (ok(withCollapse24(i, v))) maxCol = v;
  }
  return {
    threshold,
    maxLitigationCost: maxCost,
    maxCollapse24: maxCol,
    costAlwaysAbove: maxCost !== null && maxCost >= top,
    collapseAlwaysAbove: maxCol === 1,
  };
}

export interface InterventionPreset {
  preset_id: string;
  name: string;
  cost_multiplier: number;
  duration_multiplier: number;
  p_collapse_override: number | null;
  p_success_override: number | null;
  recoverable_multiplier: number;
}

/** Same semantics as the `scenario` table build in notebook 05. */
export function applyPreset(base: PpsInputs, preset: InterventionPreset): PpsInputs {
  return {
    ...base,
    recoverable: base.recoverable * preset.recoverable_multiplier,
    litigation_cost: base.litigation_cost * preset.cost_multiplier,
    duration_months: base.duration_months * preset.duration_multiplier,
    p_success: preset.p_success_override ?? base.p_success,
    p_collapse_12m: preset.p_collapse_override ?? base.p_collapse_12m,
    p_collapse_24m: preset.p_collapse_override ?? base.p_collapse_24m,
  };
}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPreset, bandFor, breakEven, computePps, sensitivity, type InterventionPreset, type PpsInputs, type PpsParams, type PpsWeights } from './pps';

/**
 * Parity: the browser's live what-if engine must reproduce the batch SQL `pps_compute` exactly (SPEC 8.3).
 * The fixture is exported from the scored tables by `npm run fixture:pps` (scripts/export-pps-fixture.sh).
 */
interface Fixture {
  params_version: string;
  params: PpsParams;
  weights: PpsWeights;
  presets: InterventionPreset[];
  cases: { case_id: string; total: number; band: string; inputs: Record<string, unknown>; criteria: Record<string, number> }[];
  scenarios: { case_id: string; preset_id: string | null; inputs: Record<string, unknown>; outputs: Record<string, number | string> }[];
}

const fixture = JSON.parse(readFileSync(join(__dirname, '..', 'tests', 'fixtures', 'pps_parity.json'), 'utf8')) as Fixture;

const toInputs = (r: Record<string, unknown>): PpsInputs => ({
  recoverable: Number(r.recoverable),
  litigation_cost: Number(r.litigation_cost),
  duration_months: Number(r.duration_months),
  p_success: Number(r.p_success),
  p_collapse_12m: Number(r.p_collapse_12m),
  p_collapse_24m: Number(r.p_collapse_24m),
  consumers_affected: Number(r.consumers_affected),
  consumer_loss: Number(r.consumer_loss),
  vulnerable: Boolean(r.vulnerable),
  strategic_priority: Number(r.strategic_priority),
  months_to_limitation: Number(r.months_to_limitation),
  recent_smr: Boolean(r.recent_smr),
});

describe(`PPS parity with batch scoring (${fixture.params_version})`, () => {
  it('has cases to compare', () => expect(fixture.cases.length).toBeGreaterThan(0));

  for (const c of fixture.cases) {
    it(`case ${c.case_id}: total, band and criteria match pps_score`, () => {
      const r = computePps(toInputs(c.inputs), fixture.weights, fixture.params);
      expect(Math.abs(r.total - c.total)).toBeLessThanOrEqual(0.1);
      expect(r.band).toBe(c.band);
      for (const k of ['financial', 'success', 'harm', 'deterrence', 'urgency'] as const) {
        expect(Math.abs(r[k] - Number(c.criteria[k]))).toBeLessThanOrEqual(0.1);
      }
      expect(Math.abs(r.expected_net_recovery - Number(c.criteria.expected_net_recovery))).toBeLessThanOrEqual(1);
    });
  }

  it('reproduces the batch intervention scenarios', () => {
    const presets = new Map(fixture.presets.map((p) => [p.preset_id, p]));
    const base = new Map(fixture.cases.map((c) => [c.case_id, toInputs(c.inputs)]));
    let checked = 0;
    for (const s of fixture.scenarios) {
      const b = base.get(s.case_id);
      if (!b) continue;
      const inputs = s.preset_id ? applyPreset(b, presets.get(s.preset_id)!) : b;
      const r = computePps(inputs, fixture.weights, fixture.params);
      expect(Math.abs(r.total - Number(s.outputs.total))).toBeLessThanOrEqual(0.1);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('PPS engine behaviour', () => {
  const p = fixture.params;
  const w = fixture.weights;
  const base = toInputs(fixture.cases[0].inputs);

  it('bands use the rounded total and the spec thresholds', () => {
    expect(bandFor(70, p)).toBe('Proceed');
    expect(bandFor(69.9, p)).toBe('Proceed – conditional');
    expect(bandFor(50, p)).toBe('Proceed – conditional');
    expect(bandFor(35, p)).toBe('Consider alternatives');
    expect(bandFor(34.9, p)).toBe('Do not pursue');
  });

  it('higher litigation cost never raises the score', () => {
    const a = computePps(base, w, p).total;
    const b = computePps({ ...base, litigation_cost: base.litigation_cost * 2 }, w, p).total;
    expect(b).toBeLessThanOrEqual(a);
  });

  it('sensitivity lists every driver, largest first', () => {
    const s = sensitivity(base, w, p);
    expect(s.map((r) => r.key).sort()).toEqual(['consumer_loss', 'duration_months', 'litigation_cost', 'p_collapse', 'p_success', 'recoverable']);
    const mag = s.map((r) => Math.max(Math.abs(r.low), Math.abs(r.high)));
    expect([...mag].sort((x, y) => y - x)).toEqual(mag);
  });

  it('break-even cost keeps the case at or above the threshold', () => {
    const be = breakEven(base, w, p);
    if (be.maxLitigationCost !== null && be.maxLitigationCost > 0) {
      expect(computePps({ ...base, litigation_cost: be.maxLitigationCost }, w, p).total).toBeGreaterThanOrEqual(be.threshold);
    }
  });
});

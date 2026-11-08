import { z } from 'zod';
import { computePps, type PpsInputs, type PpsParams, type PpsWeights } from '../../shared/pps';
import { audit } from '../lib/audit';
import { getCase } from '../lib/cases';
import { HttpError, parseJson, route } from '../lib/http';
import { austracAuthorised, redactDrivers } from '../lib/restricted';
import type { Kit, Row } from '../lib/types';
import { txt } from '../lib/types';

const Inputs = z.object({
  recoverable: z.number().min(0),
  litigation_cost: z.number().positive(),
  duration_months: z.number().positive().max(240),
  p_success: z.number().min(0).max(1),
  p_collapse_12m: z.number().min(0).max(1),
  p_collapse_24m: z.number().min(0).max(1),
  consumers_affected: z.number().min(0),
  consumer_loss: z.number().min(0),
  vulnerable: z.boolean(),
  strategic_priority: z.number().min(0).max(100),
  months_to_limitation: z.number(),
  recent_smr: z.boolean(),
});
const Weights = z.object({ w_financial: z.number(), w_success: z.number(), w_harm: z.number(), w_deterrence: z.number(), w_urgency: z.number() });
const SaveScenario = z.object({ name: z.string().min(2).max(120), preset_id: z.string().max(64).nullable().optional(), inputs: Inputs, weights: Weights.optional() });
const Decision = z.object({
  decision: z.enum(['Proceed', 'Proceed – conditional', 'Consider alternatives', 'Do not pursue']),
  rationale: z.string().min(10).max(4000),
  scenario_id: z.string().uuid().nullable().optional(),
});

/** Decisions with their four-eyes approval state (latest approval action, else awaiting approval). */
export const DECISIONS_SQL = `
  SELECT d.*, u.display_name AS decided_by_name, coalesce(a.action, 'Awaiting approval') AS approval_status,
         a.note AS approval_note, a.approver, au.display_name AS approver_name, a.acted_at AS approved_at
  FROM case_app.decision d
  LEFT JOIN gold.silver_user u ON u.user_id = d.decided_by
  LEFT JOIN LATERAL (SELECT * FROM case_app.decision_approval x WHERE x.decision_id = d.decision_id ORDER BY x.acted_at DESC LIMIT 1) a ON true
  LEFT JOIN gold.silver_user au ON au.user_id = a.approver`;

const Approval = z.object({ action: z.enum(['Approved', 'Returned']), note: z.string().trim().min(5).max(2000) });

export async function loadModelContext(kit: Kit, caseId: string) {
  const [{ rows: pps }, { rows: weights }, { rows: params }, { rows: presets }] = await Promise.all([
    kit.lakebase.query(`SELECT * FROM gold.pps_score WHERE case_id = $1`, [caseId]),
    kit.lakebase.query(`SELECT * FROM gold.scoring_weights ORDER BY created_at DESC LIMIT 1`),
    kit.lakebase.query(`SELECT * FROM gold.pps_params ORDER BY created_at DESC LIMIT 1`),
    kit.lakebase.query(`SELECT * FROM gold.intervention_presets ORDER BY preset_id`),
  ]);
  const w = weights[0];
  const p = params[0];
  if (!w || !p) throw new HttpError(503, 'Scoring parameters are not available yet. Run the scoring job.');
  return {
    pps: pps[0] ?? null,
    weights: { w_financial: Number(w.w_financial), w_success: Number(w.w_success), w_harm: Number(w.w_harm), w_deterrence: Number(w.w_deterrence), w_urgency: Number(w.w_urgency) } as PpsWeights,
    weightsVersion: txt(w.weights_version),
    params: parseJson<PpsParams | null>(p.params_json, null),
    paramsVersion: txt(p.params_version),
    modelVersion: txt(p.model_version ?? ''),
    presets,
  };
}

export function registerScoringRoutes(kit: Kit) {
  kit.server.extend((app) => {
    app.get('/api/cases/:id/scoring', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      const c = await getCase(kit, actor, id);
      const ctx = await loadModelContext(kit, id);
      if (!ctx.pps) return { scored: false, case_id: id };
      const authorised = await austracAuthorised(kit, req, actor);
      const [{ rows: risk }, { rows: riskHist }, { rows: sys }, { rows: mine }, { rows: hist }, { rows: decisions }] = await Promise.all([
        kit.lakebase.query(`SELECT * FROM gold.risk_score WHERE entity_id = $1`, [c.respondent_entity_id]),
        kit.lakebase.query(`SELECT as_of_date, p_collapse_12m, p_collapse_24m, band FROM gold.risk_score_history WHERE entity_id = $1 ORDER BY as_of_date`, [c.respondent_entity_id]),
        kit.lakebase.query(`SELECT scenario_id, name, preset_id, author, inputs_json, outputs_json, model_version, weights_version, params_version, created_at FROM gold.scenario WHERE case_id = $1 ORDER BY preset_id NULLS FIRST`, [id]),
        kit.lakebase.query(
          `SELECT s.*, u.display_name AS author_name FROM case_app.scenario s LEFT JOIN gold.silver_user u ON u.user_id = s.author
           WHERE s.case_id = $1 ORDER BY s.created_at DESC`,
          [id],
        ),
        kit.lakebase.query(`SELECT as_of_date, total, band, p_collapse_12m FROM gold.pps_score_history WHERE case_id = $1 ORDER BY as_of_date`, [id]),
        kit.lakebase.query(`${DECISIONS_SQL} WHERE d.case_id = $1 ORDER BY d.decided_at DESC`, [id]),
      ]);
      const inputsRaw = parseJson<Row>(ctx.pps.inputs_json, {});
      const r = risk[0];
      return {
        scored: true,
        case_id: id,
        inputs: inputsRaw,
        criteria: parseJson(ctx.pps.criteria_json, null),
        total: Number(ctx.pps.total),
        band: ctx.pps.band,
        weights: ctx.weights,
        weights_version: ctx.weightsVersion,
        params: ctx.params,
        params_version: ctx.paramsVersion,
        model_version: ctx.pps.model_version ?? ctx.modelVersion,
        scored_at: ctx.pps.scored_at,
        as_of_date: ctx.pps.as_of_date,
        risk_defaulted: ctx.pps.risk_defaulted,
        presets: ctx.presets,
        risk: r
          ? { p_collapse_12m: r.p_collapse_12m, p_collapse_24m: r.p_collapse_24m, band: r.band, collapse_date: r.collapse_date ?? null, collapse_status: r.collapse_status ?? null, model_version: r.model_version, scored_at: r.scored_at, drivers: redactDrivers(r.drivers_json, authorised) }
          : null,
        risk_history: riskHist,
        pps_history: hist,
        system_scenarios: sys.map((s) => ({ ...s, inputs: parseJson(s.inputs_json, {}), outputs: parseJson(s.outputs_json, {}) })),
        saved_scenarios: mine.map((s) => ({ ...s, inputs: s.inputs_json, outputs: s.outputs_json })),
        decisions,
        austrac_authorised: authorised,
      };
    }));

    app.post('/api/cases/:id/scenarios', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const body = SaveScenario.parse(req.body);
      const ctx = await loadModelContext(kit, id);
      if (!ctx.params) throw new HttpError(503, 'Scoring parameters are not available');
      const weightsChanged = body.weights && JSON.stringify(body.weights) !== JSON.stringify(ctx.weights);
      if (weightsChanged && actor.persona !== 'Enforcement Lead') throw new HttpError(403, 'Only enforcement leads can change criterion weights');
      const weights = body.weights ?? ctx.weights;
      // Recompute on the server with the same engine: the stored outputs are authoritative, never the client's
      const outputs = computePps(body.inputs as PpsInputs, weights, ctx.params);
      const { rows } = await kit.lakebase.query(
        `INSERT INTO case_app.scenario (case_id, name, preset_id, inputs_json, outputs_json, weights_json, model_version, weights_version, params_version, author)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [id, body.name, body.preset_id ?? null, JSON.stringify(body.inputs), JSON.stringify(outputs), JSON.stringify(weights),
          ctx.pps?.model_version ?? ctx.modelVersion, weightsChanged ? `${ctx.weightsVersion}+custom` : ctx.weightsVersion, ctx.paramsVersion, actor.userId],
      );
      await audit(kit, actor, {
        action: `Saved scenario “${body.name}”`, objectType: 'scenario', objectId: txt(rows[0]?.scenario_id), caseId: id,
        newValue: `PPS ${outputs.total} · ${outputs.band}`, modelVersion: txt(ctx.pps?.model_version ?? ctx.modelVersion),
        detail: { params_version: ctx.paramsVersion, weights_version: ctx.weightsVersion, custom_weights: Boolean(weightsChanged) },
      });
      return rows[0];
    }));

    app.post('/api/cases/:id/decision', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      if (actor.persona === 'Investigator') throw new HttpError(403, 'Prosecution decisions are recorded by an enforcement lead or counsel');
      const body = Decision.parse(req.body);
      const ctx = await loadModelContext(kit, id);
      const { rows } = await kit.lakebase.query(
        `INSERT INTO case_app.decision (case_id, decision, rationale, scenario_id, pps_total, pps_band, params_version, decided_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [id, body.decision, body.rationale, body.scenario_id ?? null, ctx.pps?.total ?? null, ctx.pps?.band ?? null, ctx.paramsVersion, actor.userId],
      );
      await audit(kit, actor, {
        action: `Proposed decision: ${body.decision} (awaiting approval)`, objectType: 'decision', objectId: txt(rows[0]?.decision_id), caseId: id,
        newValue: body.decision, reason: body.rationale, detail: { pps: ctx.pps?.total, band: ctx.pps?.band, scenario_id: body.scenario_id },
      });
      return rows[0];
    }));

    /** Four-eyes approval: a different Enforcement Lead approves or returns a proposed decision, with a note (audited). */
    app.post('/api/decisions/:did/approval', route(kit, async (req, _res, actor) => {
      const did = Number(txt(req.params.did));
      const body = Approval.parse(req.body);
      const { rows } = await kit.lakebase.query(`${DECISIONS_SQL} WHERE d.decision_id = $1`, [did]);
      const d = rows[0];
      if (!d) throw new HttpError(404, 'Decision not found');
      await getCase(kit, actor, txt(d.case_id));
      if (actor.persona !== 'Enforcement Lead') throw new HttpError(403, 'Only an enforcement lead can approve prosecution decisions');
      if (d.decided_by === actor.userId) throw new HttpError(403, 'A decision must be approved by a different lead than the one who proposed it');
      if (d.approval_status !== 'Awaiting approval') throw new HttpError(409, `This decision is already ${txt(d.approval_status).toLowerCase()}`);
      await kit.lakebase.query(
        `INSERT INTO case_app.decision_approval (decision_id, case_id, action, note, approver) VALUES ($1, $2, $3, $4, $5)`,
        [did, d.case_id, body.action, body.note, actor.userId],
      );
      await audit(kit, actor, {
        action: `${body.action} decision: ${txt(d.decision)}`, objectType: 'decision', objectId: String(did), caseId: txt(d.case_id),
        oldValue: 'Awaiting approval', newValue: body.action, reason: body.note,
      });
      return { ok: true, approval_status: body.action };
    }));
  });
}

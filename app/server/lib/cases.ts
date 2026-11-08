import type { Actor } from './identity';
import { HttpError, seesAllTeams } from './http';
import type { Kit, Row } from './types';

/**
 * The effective case view: read-only gold inputs and scores, overlaid with app-owned state (stage, summary,
 * assignment) and cases opened from Intake that have not been scored yet.
 */
export const CASES_SQL = `
WITH base AS (
  SELECT c.case_id, c.case_number, c.title, c.case_type, c.stage, c.priority, c.team_id, c.lead_user, c.opened_at,
         c.respondent_entity_id, c.est_recoverable_aud, c.est_litigation_cost_aud, c.est_duration_months, c.cost_to_date_aud,
         c.approved_budget_aud, c.limitation_date, c.story_tag, c.consumers_affected, c.total_consumer_loss_aud
  FROM gold.gold_case_inputs c
  UNION ALL
  SELECT s.case_id, s.case_number, s.title, s.case_type, s.stage, s.priority, s.team_id, s.lead_user, s.updated_at,
         s.respondent_entity_id, NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL, NULL
  FROM case_app.case_state s WHERE s.created_from_intake IS NOT NULL
)
SELECT b.case_id, b.case_number, coalesce(st.title, b.title) AS title, b.case_type,
       coalesce(st.stage, b.stage) AS stage, coalesce(st.priority, b.priority) AS priority, b.team_id,
       coalesce(st.lead_user, b.lead_user) AS lead_user, lu.display_name AS lead_name, t.team_name, b.opened_at,
       b.respondent_entity_id, e.name AS respondent_name, b.est_recoverable_aud, b.est_litigation_cost_aud, b.est_duration_months,
       coalesce(p.cost_to_date_aud, b.cost_to_date_aud) AS cost_to_date_aud, b.approved_budget_aud, b.limitation_date, b.story_tag,
       b.consumers_affected, b.total_consumer_loss_aud,
       p.total AS pps, p.band AS pps_band, p.criteria_json, p.params_version, p.weights_version, p.model_version,
       r.p_collapse_12m, r.p_collapse_24m, r.band AS risk_band, r.collapse_date AS risk_collapse_date, r.collapse_status AS risk_collapse_status, st.summary, st.summary_ai, st.created_from_intake
FROM base b
LEFT JOIN case_app.case_state st ON st.case_id = b.case_id
LEFT JOIN gold.pps_score p ON p.case_id = b.case_id
LEFT JOIN gold.risk_score r ON r.entity_id = b.respondent_entity_id
LEFT JOIN gold.silver_entity e ON e.entity_id = b.respondent_entity_id
LEFT JOIN gold.silver_user lu ON lu.user_id = coalesce(st.lead_user, b.lead_user)
LEFT JOIN gold.silver_team t ON t.team_id = b.team_id`;

export async function listCases(kit: Kit, actor: Actor): Promise<Row[]> {
  const scoped = seesAllTeams(actor) ? '' : 'WHERE team_id = $1';
  const { rows } = await kit.lakebase.query(
    `SELECT * FROM (${CASES_SQL}) x ${scoped} ORDER BY pps DESC NULLS LAST, case_number`,
    scoped ? [actor.teamId] : [],
  );
  return rows;
}

export async function getCase(kit: Kit, actor: Actor, caseId: string): Promise<Row> {
  const { rows } = await kit.lakebase.query(`SELECT * FROM (${CASES_SQL}) x WHERE case_id = $1`, [caseId]);
  const c = rows[0];
  if (!c) throw new HttpError(404, 'Case not found');
  if (!seesAllTeams(actor) && c.team_id !== actor.teamId) throw new HttpError(403, 'This case belongs to another team');
  return c;
}

export const STAGES = ['Intake', 'Assessment', 'Investigation', 'Decision', 'Litigation / Referral', 'Outcome', 'Closed'] as const;

/** Gold stages use 'Litigation' / 'Referral'; the UI shows the spec's combined stage. */
export function stageIndex(stage: string): number {
  const s = stage === 'Litigation' || stage === 'Referral' ? 'Litigation / Referral' : stage;
  return Math.max(0, STAGES.indexOf(s as (typeof STAGES)[number]));
}

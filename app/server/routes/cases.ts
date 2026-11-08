import { z } from 'zod';
import { audit } from '../lib/audit';
import { CASES_SQL, getCase, listCases, STAGES, stageIndex } from '../lib/cases';
import { HttpError, parseJson, route, seesAllTeams } from '../lib/http';
import { statementRows, type Kit, type Row } from '../lib/types';
import { txt } from '../lib/types';

const UpdateCase = z.object({
  stage: z.enum(STAGES).optional(),
  priority: z.enum(['P1', 'P2', 'P3']).optional(),
  summary: z.string().max(8000).optional(),
  summary_ai: z.boolean().optional(),
  reason: z.string().max(2000).optional(),
});

export function registerCaseRoutes(kit: Kit) {
  kit.server.extend((app) => {
    app.get('/api/cases', route(kit, async (_req, _res, actor) => ({ cases: await listCases(kit, actor) })));

    app.get('/api/cases/:id', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      const c = await getCase(kit, actor, id);
      const [parties, events, budget, tasks, counts] = await Promise.all([
        kit.lakebase.query(
          `SELECT p.entity_id, p.entity_name, p.entity_type, p.role, p.party_kind, r.p_collapse_12m, r.band AS risk_band, r.collapse_date AS risk_collapse_date, r.collapse_status AS risk_collapse_status
           FROM gold.gold_case_party p LEFT JOIN gold.risk_score r ON r.entity_id = p.entity_id
           WHERE p.case_id = $1 ORDER BY CASE p.role WHEN 'respondent' THEN 0 WHEN 'related' THEN 1 ELSE 2 END, p.entity_name`,
          [id],
        ),
        kit.lakebase.query(
          `SELECT e.event_id, e.event_date, e.event_type, e.description, e.source, e.ai_flag, e.provenance,
                  coalesce(r.status, e.status) AS status
           FROM gold.gold_case_event e LEFT JOIN case_app.event_review r ON r.event_id = e.event_id
           WHERE e.case_id = $1 AND coalesce(r.status, e.status) = 'confirmed' ORDER BY e.event_date DESC LIMIT 6`,
          [id],
        ),
        kit.lakebase.query(
          `SELECT b.category, b.approved_budget_aud, coalesce(s.spent, 0) AS spent_aud
           FROM gold.gold_case_budget b
           LEFT JOIN (SELECT category, sum(spend_aud) AS spent FROM gold.gold_case_spend WHERE case_id = $1 GROUP BY category) s
             ON s.category = b.category
           WHERE b.case_id = $1 ORDER BY b.category`,
          [id],
        ),
        kit.lakebase.query(`SELECT count(*) FILTER (WHERE status <> 'Done') AS open_tasks FROM case_app.task WHERE case_id = $1`, [id]),
        kit.lakebase.query(
          `SELECT (SELECT count(*) FROM gold.gold_evidence_item WHERE case_id = $1) AS evidence,
                  (SELECT count(*) FROM gold.silver_evidence_extraction x
                     LEFT JOIN case_app.extraction_review r ON r.extraction_id = x.extraction_id
                   WHERE x.case_id = $1 AND r.extraction_id IS NULL) AS extractions_pending`,
          [id],
        ),
      ]);
      const nextTask = await kit.lakebase.query(
        `SELECT title, due_date FROM case_app.task WHERE case_id = $1 AND status <> 'Done' AND due_date IS NOT NULL
         ORDER BY due_date LIMIT 1`,
        [id],
      );
      const decision = await kit.lakebase.query(
        `SELECT decision, rationale, pps_total, pps_band, decided_by, decided_at FROM case_app.decision
         WHERE case_id = $1 ORDER BY decided_at DESC LIMIT 1`,
        [id],
      );
      return {
        case: { ...c, criteria: parseJson(c.criteria_json, null), stage_index: stageIndex(txt(c.stage)) },
        stages: STAGES,
        parties: parties.rows,
        recent_events: events.rows,
        budget: budget.rows,
        open_tasks: Number(tasks.rows[0]?.open_tasks ?? 0),
        evidence_count: Number(counts.rows[0]?.evidence ?? 0),
        extractions_pending: Number(counts.rows[0]?.extractions_pending ?? 0),
        next_key_date: nextTask.rows[0] ?? (c.limitation_date ? { title: 'Limitation date', due_date: c.limitation_date } : null),
        latest_decision: decision.rows[0] ?? null,
      };
    }));

    app.patch('/api/cases/:id', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      const body = UpdateCase.parse(req.body);
      const c = await getCase(kit, actor, id);
      if (body.stage && stageIndex(body.stage) < stageIndex(txt(c.stage)) && !body.reason) {
        throw new HttpError(400, 'Moving a case back a stage requires a reason');
      }
      await kit.lakebase.query(
        `INSERT INTO case_app.case_state (case_id, stage, priority, summary, summary_ai, updated_by)
         VALUES ($1, $2, $3, $4, coalesce($5, false), $6)
         ON CONFLICT (case_id) DO UPDATE SET
           stage = coalesce($2, case_app.case_state.stage), priority = coalesce($3, case_app.case_state.priority),
           summary = coalesce($4, case_app.case_state.summary), summary_ai = coalesce($5, case_app.case_state.summary_ai),
           updated_by = $6, updated_at = now()`,
        [id, body.stage ?? null, body.priority ?? null, body.summary ?? null, body.summary_ai ?? null, actor.email],
      );
      for (const field of ['stage', 'priority', 'summary'] as const) {
        if (body[field] !== undefined) {
          await audit(kit, actor, {
            action: field === 'stage' ? 'Advanced stage' : `Updated ${field}`,
            objectType: 'case', objectId: id, caseId: id, field,
            oldValue: c[field], newValue: body[field], reason: body.reason ?? null, aiFlag: field === 'summary' && body.summary_ai,
          });
        }
      }
      return getCase(kit, actor, id);
    }));

    /** S1 My Work: cases led by (or in the team of) the persona, tasks and review queues. */
    app.get('/api/my-work', route(kit, async (_req, _res, actor) => {
      const { rows: cases } = await kit.lakebase.query(
        `SELECT x.*, (SELECT min(due_date) FROM case_app.task t WHERE t.case_id = x.case_id AND t.status <> 'Done') AS next_due,
                (SELECT title FROM case_app.task t WHERE t.case_id = x.case_id AND t.status <> 'Done' ORDER BY due_date NULLS LAST LIMIT 1) AS next_task
         FROM (${CASES_SQL}) x WHERE x.team_id = $1 AND x.stage <> 'Closed'
         ORDER BY (x.lead_user = $2) DESC, x.pps DESC NULLS LAST LIMIT 25`,
        [actor.teamId, actor.userId],
      );
      const ids = cases.map((c) => c.case_id);
      const [tasks, evid, extr, updates] = await Promise.all([
        kit.lakebase.query(
          `SELECT t.*, x.title AS case_title FROM case_app.task t JOIN (${CASES_SQL}) x ON x.case_id = t.case_id
           WHERE t.status <> 'Done' AND (t.assignee = $1 OR x.team_id = $2) ORDER BY t.due_date NULLS LAST LIMIT 20`,
          [actor.userId, actor.teamId],
        ),
        kit.lakebase.query(
          `SELECT count(*) AS n, count(*) FILTER (WHERE tg.tag IS NOT NULL) AS hot FROM gold.gold_evidence_item e
           LEFT JOIN case_app.evidence_tag tg ON tg.evidence_id = e.evidence_id AND tg.category = 'hot'
           WHERE e.case_id = ANY($1) AND NOT EXISTS (SELECT 1 FROM case_app.custody_access a WHERE a.evidence_id = e.evidence_id AND a.action = 'viewed')`,
          [ids],
        ),
        kit.lakebase.query(
          `SELECT count(*) AS n, count(DISTINCT x.evidence_id) AS docs FROM gold.silver_evidence_extraction x
           LEFT JOIN case_app.extraction_review r ON r.extraction_id = x.extraction_id
           WHERE x.case_id = ANY($1) AND r.extraction_id IS NULL`,
          [ids],
        ),
        // Agency updates: recent shared-agency records and register changes for this team's respondents
        kit.lakebase.query(
          `SELECT e.event_date, e.event_type, e.description, e.case_id, x.title AS case_title, e.provenance
           FROM gold.gold_case_event e JOIN (${CASES_SQL}) x ON x.case_id = e.case_id
           WHERE x.team_id = $1 AND e.source <> 'silver_case' AND e.status = 'confirmed'
           ORDER BY e.event_date DESC LIMIT 8`,
          [actor.teamId],
        ),
      ]);
      const overdue = tasks.rows.filter((t) => t.due_date && new Date(txt(t.due_date)) < new Date()).length;
      return {
        cases,
        tasks: tasks.rows,
        kpis: {
          open_cases: cases.length,
          decision_stage: cases.filter((c) => c.stage === 'Decision').length,
          tasks_due: tasks.rows.length,
          overdue,
          evidence_unreviewed: Number(evid.rows[0]?.n ?? 0),
          evidence_hot: Number(evid.rows[0]?.hot ?? 0),
          extractions_pending: Number(extr.rows[0]?.n ?? 0),
          extraction_docs: Number(extr.rows[0]?.docs ?? 0),
          agency_updates: updates.rows.length,
        },
        activity: updates.rows,
      };
    }));

    /** S2 Portfolio: KPIs, priority matrix and movers (PPS / collapse-risk change since the previous as-of). */
    app.get('/api/portfolio', route(kit, async (_req, _res, actor) => {
      const cases = await listCases(kit, actor);
      const { rows: movers } = await kit.lakebase.query(
        `WITH h AS (
           SELECT case_id, as_of_date, total, p_collapse_12m,
                  row_number() OVER (PARTITION BY case_id ORDER BY as_of_date DESC) AS rn
           FROM gold.pps_score_history)
         SELECT cur.case_id, x.title, x.respondent_name, cur.total AS pps, prev.total AS prev_pps,
                round((cur.total - prev.total)::numeric, 1) AS pps_delta,
                round(((cur.p_collapse_12m - prev.p_collapse_12m) * 100)::numeric, 1) AS risk_delta_pts,
                prev.as_of_date AS since
         FROM h cur JOIN h prev ON prev.case_id = cur.case_id AND prev.rn = 2
         JOIN (${CASES_SQL}) x ON x.case_id = cur.case_id
         WHERE cur.rn = 1
         ORDER BY greatest(abs(cur.total - prev.total), abs(cur.p_collapse_12m - prev.p_collapse_12m) * 100) DESC LIMIT 8`,
      );
      const scope = new Set(cases.map((c) => c.case_id));
      const open = cases.filter((c) => c.stage !== 'Closed');
      const sum = (k: string) => open.reduce((a, c) => a + Number(c[k] ?? 0), 0);
      const scored = open.filter((c) => c.pps !== null && c.pps !== undefined);
      return {
        kpis: {
          open_cases: open.length,
          est_recoverable: sum('est_recoverable_aud'),
          cost_to_date: sum('cost_to_date_aud'),
          avg_pps: scored.length ? scored.reduce((a, c) => a + Number(c.pps), 0) / scored.length : null,
          high_collapse: open.filter((c) => c.risk_band === 'High' || c.risk_band === 'Critical').length,
          collapsed: open.filter((c) => c.risk_band === 'Collapsed').length,
        },
        cases: open,
        movers: movers.filter((m) => scope.has(m.case_id)),
      };
    }));

    /** S7 Executive Briefing: aggregates over the lakehouse via the SQL warehouse (Analytics), as the app. */
    app.get('/api/executive', route(kit, async () => {
      const uc = `${process.env.UC_CATALOG || 'au_pubsec_catalog'}.${process.env.UC_SCHEMA || 'asic_case_management'}`;
      const [trajectory, spend, portfolio] = await Promise.all([
        kit.analytics.query(
          `WITH s AS (SELECT case_id, as_of_date, from_json(criteria_json, 'expected_net_recovery DOUBLE, expected_recovery DOUBLE') c, total
                      FROM ${uc}.pps_score_history)
           SELECT as_of_date, count(*) AS cases, round(avg(total), 1) AS avg_pps,
                  sum(c.expected_net_recovery) AS net_return, sum(c.expected_recovery) AS gross_recovery
           FROM s GROUP BY as_of_date ORDER BY as_of_date`,
        ),
        kit.analytics.query(
          `SELECT b.category, sum(b.approved_budget_aud) AS budget, coalesce(max(s.spent), 0) AS spent
           FROM ${uc}.gold_case_budget b
           LEFT JOIN (SELECT category, sum(spend_aud) AS spent FROM ${uc}.gold_case_spend GROUP BY category) s ON s.category = b.category
           GROUP BY b.category ORDER BY b.category`,
        ),
        kit.analytics.query(
          `SELECT count(*) AS open_cases, sum(p.cost_to_date_aud) AS committed_spend,
                  sum(from_json(p.criteria_json, 'expected_recovery DOUBLE').expected_recovery) AS gross_recovery,
                  sum(from_json(p.criteria_json, 'expected_net_recovery DOUBLE').expected_net_recovery) AS net_return,
                  sum(c.approved_budget_aud) AS approved_budget,
                  sum(CASE WHEN r.band IN ('High', 'Critical') THEN 1 ELSE 0 END) AS high_collapse,
                  sum(CASE WHEN r.band = 'Collapsed' THEN 1 ELSE 0 END) AS collapsed_respondents
           FROM ${uc}.pps_score p JOIN ${uc}.gold_case_inputs c USING (case_id)
           LEFT JOIN ${uc}.risk_score r ON r.entity_id = c.respondent_entity_id`,
        ),
      ]);
      const { rows: attention } = await kit.lakebase.query(
        `WITH h AS (SELECT case_id, total, p_collapse_12m, criteria_json, row_number() OVER (PARTITION BY case_id ORDER BY as_of_date DESC) rn
                    FROM gold.pps_score_history)
         SELECT x.case_id, x.title, x.respondent_name, x.stage, x.cost_to_date_aud, x.pps, x.pps_band, x.criteria_json,
                round((cur.total - prev.total)::numeric, 1) AS pps_delta,
                round(((cur.p_collapse_12m - prev.p_collapse_12m) * 100)::numeric, 1) AS risk_delta_pts,
                x.p_collapse_12m, x.est_litigation_cost_aud
         FROM (${CASES_SQL}) x JOIN h cur ON cur.case_id = x.case_id AND cur.rn = 1
         LEFT JOIN h prev ON prev.case_id = x.case_id AND prev.rn = 2
         ORDER BY greatest(abs(coalesce(cur.total - prev.total, 0)), abs(coalesce(cur.p_collapse_12m - prev.p_collapse_12m, 0)) * 100, CASE WHEN x.pps >= 70 THEN 10 ELSE 0 END) DESC
         LIMIT 6`,
      );
      const { rows: since } = await kit.lakebase.query(
        `SELECT count(*) FILTER (WHERE action = 'Advanced stage') AS advanced,
                count(*) FILTER (WHERE object_type = 'scenario') AS scenarios,
                count(*) FILTER (WHERE object_type = 'decision') AS decisions
         FROM case_app.audit_log WHERE at > now() - interval '30 days'`,
      );
      return {
        trajectory: statementRows(trajectory),
        spend: statementRows(spend),
        portfolio: statementRows(portfolio)[0] ?? {},
        attention: attention.map((a: Row) => ({ ...a, criteria: parseJson(a.criteria_json, null) })),
        since_last: since[0] ?? {},
        generated_at: new Date().toISOString(),
      };
    }));

    app.get('/api/nav-counts', route(kit, async (_req, _res, actor) => {
      const cases = await listCases(kit, actor);
      const { rows } = await kit.lakebase.query(
        `SELECT (SELECT count(*) FROM gold.silver_breach_report b WHERE b.triage_status IN ('New', 'In triage')
                   AND NOT EXISTS (SELECT 1 FROM case_app.intake_disposition d WHERE d.intake_id = b.intake_id)) AS intake,
                (SELECT count(*) FROM gold.silver_entity) AS entities,
                (SELECT count(*) FROM case_app.weights_proposal WHERE status = 'Proposed') AS proposals,
                (SELECT count(*) FROM case_app.task WHERE status <> 'Done' AND assignee = $1) AS my_tasks`,
        [actor.userId],
      );
      const r = rows[0] ?? {};
      return {
        my_work: cases.filter((c) => c.team_id === actor.teamId).length + Number(r.my_tasks ?? 0),
        cases: cases.length,
        portfolio: cases.filter((c) => c.stage !== 'Closed').length,
        entities: Number(r.entities ?? 0),
        intake: Number(r.intake ?? 0),
        admin: Number(r.proposals ?? 0),
        all_teams: seesAllTeams(actor),
      };
    }));
  });
}

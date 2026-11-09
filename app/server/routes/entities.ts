import { z } from 'zod';
import { audit } from '../lib/audit';
import { CASES_SQL, listCases } from '../lib/cases';
import { HttpError, route, seesAllTeams } from '../lib/http';
import { loadUsers } from '../lib/identity';
import { apiGet, chat, LLM_ENDPOINT, parseJsonReply } from '../lib/llm';
import { austracAuthorised, austracSummary, redactDrivers } from '../lib/restricted';
import { statementRows, type Kit, type Row } from '../lib/types';
import { txt } from '../lib/types';

const Resolution = z.object({ decision: z.enum(['Merge', 'Not the same']), reason: z.string().max(1000).optional() });
const Disposition = z.object({
  disposition: z.enum(['Open case', 'Link to case', 'No further action']),
  reason: z.string().trim().min(5, 'A reason is required').max(2000),
  case_id: z.string().max(32).optional(),
  ai_suggestion: z.unknown().optional(),
});
const Proposal = z.object({
  weights: z.object({ w_financial: z.number(), w_success: z.number(), w_harm: z.number(), w_deterrence: z.number(), w_urgency: z.number() }),
  reason: z.string().trim().min(5).max(2000),
});

async function entitySnapshot(kit: Kit, entityId: string) {
  const [{ rows: prof }, { rows: risk }, { rows: cases }] = await Promise.all([
    kit.lakebase.query(`SELECT * FROM gold.gold_entity_profile WHERE entity_id = $1`, [entityId]),
    kit.lakebase.query(`SELECT * FROM gold.risk_score WHERE entity_id = $1`, [entityId]),
    kit.lakebase.query(`SELECT case_id, title, stage, pps FROM (${CASES_SQL}) x WHERE respondent_entity_id = $1`, [entityId]),
  ]);
  return { profile: prof[0] ?? null, risk: risk[0] ?? null, cases };
}

export function registerEntityRoutes(kit: Kit) {
  kit.server.extend((app) => {
    app.get('/api/me', route(kit, async (req, _res, actor) => ({
      ...actor,
      personas: await loadUsers(kit),
      austrac_authorised: await austracAuthorised(kit, req, actor),
      sees_all_teams: seesAllTeams(actor),
    })));

    /** Ctrl+K: cases, entities and evidence. */
    app.get('/api/search', route(kit, async (req, _res, actor) => {
      const q = txt(req.query.q ?? '').trim();
      if (q.length < 2) return { cases: [], entities: [], evidence: [] };
      const visible = await listCases(kit, actor);
      const cases = visible.filter((c) =>
        [c.title, c.case_number, c.respondent_name].some((v) => txt(v ?? '').toLowerCase().includes(q.toLowerCase())),
      ).slice(0, 6);
      const [{ rows: entities }, { rows: evidence }] = await Promise.all([
        // Rank: exact identifier, name starts with the query, a word starts with it, entities on open cases, then shorter names
        kit.lakebase.query(
          `SELECT e.entity_id, e.name, e.entity_type, e.abn_acn, e.status FROM gold.silver_entity e
           LEFT JOIN gold.gold_entity_profile p ON p.entity_id = e.entity_id
           WHERE e.name ILIKE '%' || $1 || '%' OR e.abn_acn = regexp_replace($1, '[^0-9]', '', 'g') OR e.abn = regexp_replace($1, '[^0-9]', '', 'g')
           ORDER BY (e.abn_acn = regexp_replace($1, '[^0-9]', '', 'g') OR e.abn = regexp_replace($1, '[^0-9]', '', 'g')) DESC,
                    (e.name ILIKE $1 || '%') DESC, ((' ' || e.name) ILIKE '% ' || $1 || '%') DESC,
                    coalesce(p.open_cases, 0) DESC, length(e.name) LIMIT 8`,
          [q],
        ),
        kit.lakebase.query(
          `SELECT evidence_id, case_id, filename, doc_type FROM gold.gold_evidence_item
           WHERE (filename ILIKE '%' || $1 || '%' OR evidence_id ILIKE $1 || '%') AND case_id = ANY($2) LIMIT 6`,
          [q, visible.map((c) => c.case_id)],
        ),
      ]);
      return { cases, entities, evidence };
    }));

    app.get('/api/entities', route(kit, async (req) => {
      const q = txt(req.query.q ?? '').trim();
      const { rows } = await kit.lakebase.query(
        `SELECT p.entity_id, p.name, p.entity_type, p.abn_acn, p.status, p.source_record_count, p.agencies, p.open_cases,
                r.p_collapse_12m, r.band, r.collapse_date AS risk_collapse_date, r.collapse_status AS risk_collapse_status
         FROM gold.gold_entity_profile p LEFT JOIN gold.risk_score r ON r.entity_id = p.entity_id
         WHERE ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR p.abn_acn = $1)
         ORDER BY p.open_cases DESC, r.p_collapse_12m DESC NULLS LAST LIMIT 50`,
        [q],
      );
      return { entities: rows };
    }));

    /** S5 Entity 360: identity (with confidence), shared intelligence by agency, risk, related entities and cases. */
    app.get('/api/entities/:eid', route(kit, async (req, _res, actor) => {
      const eid = txt(req.params.eid);
      const { rows: base } = await kit.lakebase.query(`SELECT * FROM gold.silver_entity WHERE entity_id = $1`, [eid]);
      if (!base[0]) throw new HttpError(404, 'Entity not found');
      const authorised = await austracAuthorised(kit, req, actor);
      const snap = await entitySnapshot(kit, eid);
      const [sources, hist, related, partyOf, review, past, officers] = await Promise.all([
        kit.lakebase.query(`SELECT source_record_id, agency, source_table, source_key, match_score, loaded_at, provenance FROM gold.silver_source_record WHERE entity_id = $1 ORDER BY agency, source_table`, [eid]),
        kit.lakebase.query(`SELECT as_of_date, p_collapse_12m, p_collapse_24m, band FROM gold.risk_score_history WHERE entity_id = $1 ORDER BY as_of_date`, [eid]),
        kit.lakebase.query(
          `SELECT n.other, n.rel_type, n.weight, n.provenance, e.name, e.entity_type, r.p_collapse_12m, r.band, r.collapse_date AS risk_collapse_date, r.collapse_status AS risk_collapse_status
           FROM (SELECT to_entity AS other, rel_type, weight, provenance FROM gold.gold_entity_network WHERE from_entity = $1
                 UNION ALL SELECT from_entity, rel_type, weight, provenance FROM gold.gold_entity_network WHERE to_entity = $1) n
           LEFT JOIN gold.silver_entity e ON e.entity_id = n.other LEFT JOIN gold.risk_score r ON r.entity_id = n.other
           ORDER BY n.weight DESC LIMIT 25`,
          [eid],
        ),
        kit.lakebase.query(
          `SELECT p.case_id, p.role, x.title, x.stage, x.pps FROM gold.gold_case_party p JOIN (${CASES_SQL}) x ON x.case_id = p.case_id WHERE p.entity_id = $1`,
          [eid],
        ),
        kit.lakebase.query(
          `SELECT v.*, d.decision, d.decided_by, d.decided_at FROM gold.silver_resolution_review v
           LEFT JOIN case_app.resolution_decision d ON d.review_id = v.review_id WHERE v.entity_id = $1 ORDER BY v.match_score DESC`,
          [eid],
        ),
        kit.lakebase.query(
          `SELECT matter_id, matter_type, filed_date, judgment_date, success, penalty_aud, recovered_amount_aud, citation, provisions, source, provenance
           FROM gold.silver_historical_matters WHERE acn = $1 ORDER BY judgment_date DESC NULLS LAST`,
          [txt(base[0].abn_acn ?? '')],
        ),
        kit.lakebase.query(
          `SELECT n.from_entity AS person_id, e.name, n.weight FROM gold.gold_entity_network n JOIN gold.silver_entity e ON e.entity_id = n.from_entity
           WHERE n.to_entity = $1 AND n.rel_type = 'officer_of' ORDER BY e.name`,
          [eid],
        ),
      ]);
      let austrac: Row | null = null;
      if (Number(snap.profile?.austrac_restricted_record_count ?? 0) > 0) {
        try {
          austrac = await austracSummary(kit, req, eid);
          if (austrac?.viewer_authorised) await audit(kit, actor, { action: 'Viewed restricted AUSTRAC detail', objectType: 'entity', objectId: eid });
        } catch (err) {
          console.warn('[entity] AUSTRAC summary unavailable', (err as Error).message);
        }
      }
      const r = snap.risk;
      return {
        entity: base[0],
        profile: snap.profile,
        risk: r ? { ...r, drivers: redactDrivers(r.drivers_json, authorised), drivers_json: undefined } : null,
        risk_history: hist.rows,
        sources: sources.rows,
        related: related.rows,
        officers: officers.rows,
        cases: partyOf.rows,
        resolution: review.rows,
        past_matters: past.rows,
        austrac: { count: Number(snap.profile?.austrac_restricted_record_count ?? 0), authorised, detail: austrac?.viewer_authorised ? austrac : null },
      };
    }));

    app.post('/api/resolution/:rid', route(kit, async (req, _res, actor) => {
      const rid = txt(req.params.rid);
      const body = Resolution.parse(req.body);
      const { rows } = await kit.lakebase.query(`SELECT entity_id, candidate_name, match_score FROM gold.silver_resolution_review WHERE review_id = $1`, [rid]);
      if (!rows[0]) throw new HttpError(404, 'Review item not found');
      await kit.lakebase.query(
        `INSERT INTO case_app.resolution_decision (review_id, entity_id, decision, reason, decided_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (review_id) DO UPDATE SET decision = $3, reason = $4, decided_by = $5, decided_at = now()`,
        [rid, rows[0].entity_id, body.decision, body.reason ?? null, actor.userId],
      );
      await audit(kit, actor, { action: `Entity resolution: ${body.decision}`, objectType: 'entity', objectId: txt(rows[0].entity_id), reason: body.reason ?? null, detail: { review_id: rid, candidate: rows[0].candidate_name, match_score: rows[0].match_score } });
      return { ok: true };
    }));

    /** S3 Intake Queue. */
    app.get('/api/intake', route(kit, async (req) => {
      const status = req.query.status === 'done' ? 'done' : 'open';
      const { rows } = await kit.lakebase.query(
        `SELECT b.intake_id, b.acn, b.report_kind, b.category, b.received_at, b.consumers_affected, b.alleged_loss_aud, b.summary, b.provenance,
                coalesce(d.disposition, b.triage_status) AS triage_status, d.reason, d.decided_by, d.decided_at, d.case_id,
                e.name AS entity_name, e.entity_id, r.p_collapse_12m, r.band, r.collapse_date AS risk_collapse_date, r.collapse_status AS risk_collapse_status, count(*) OVER () AS total
         FROM gold.silver_breach_report b
         LEFT JOIN case_app.intake_disposition d ON d.intake_id = b.intake_id
         LEFT JOIN gold.silver_entity e ON e.entity_id = 'CO-' || b.acn
         LEFT JOIN gold.risk_score r ON r.entity_id = 'CO-' || b.acn
         WHERE ${status === 'open' ? `d.intake_id IS NULL AND b.triage_status IN ('New', 'In triage')` : `d.intake_id IS NOT NULL`}
         ORDER BY ${status === 'open' ? 'b.received_at DESC' : 'd.decided_at DESC'} LIMIT 100`,
      );
      return { items: rows, total: Number(rows[0]?.total ?? 0) };
    }));

    app.get('/api/intake/:iid', route(kit, async (req) => {
      const iid = txt(req.params.iid);
      const { rows } = await kit.lakebase.query(`SELECT * FROM gold.silver_breach_report WHERE intake_id = $1`, [iid]);
      const item = rows[0];
      if (!item) throw new HttpError(404, 'Intake item not found');
      const eid = `CO-${txt(item.acn)}`;
      const snap = await entitySnapshot(kit, eid);
      const [{ rows: related }, { rows: sources }, { rows: prior }] = await Promise.all([
        kit.lakebase.query(
          `SELECT DISTINCT p.case_id, p.role, x.title, x.stage FROM gold.gold_case_party p JOIN (${CASES_SQL}) x ON x.case_id = p.case_id WHERE p.entity_id = $1`,
          [eid],
        ),
        kit.lakebase.query(`SELECT agency, count(*) AS n FROM gold.silver_source_record WHERE entity_id = $1 GROUP BY agency ORDER BY agency`, [eid]),
        kit.lakebase.query(`SELECT count(*) AS n FROM gold.silver_breach_report WHERE acn = $1 AND intake_id <> $2`, [item.acn, iid]),
      ]);
      return {
        item,
        entity_id: eid,
        profile: snap.profile,
        risk: snap.risk ? { ...snap.risk, drivers: redactDrivers(snap.risk.drivers_json, false), drivers_json: undefined } : null,
        open_cases: snap.cases,
        related_cases: related,
        sources,
        prior_reports: Number(prior[0]?.n ?? 0),
      };
    }));

    /** AI triage suggestion (labelled; a person must choose and give a reason). */
    app.post('/api/intake/:iid/suggest', route(kit, async (req, _res, actor) => {
      const iid = txt(req.params.iid);
      const { rows } = await kit.lakebase.query(`SELECT * FROM gold.silver_breach_report WHERE intake_id = $1`, [iid]);
      const item = rows[0];
      if (!item) throw new HttpError(404, 'Intake item not found');
      const snap = await entitySnapshot(kit, `CO-${txt(item.acn)}`);
      const p = snap.profile ?? {};
      const ctx = [
        `Report: ${txt(item.report_kind)}, category ${txt(item.category)}, received ${txt(item.received_at)}. ${txt(item.summary)}`,
        `Alleged loss $${txt(item.alleged_loss_aud)}; consumers affected ${txt(item.consumers_affected)}.`,
        `Entity: ${txt(p.name ?? item.acn)}, status ${txt(p.status)}, ${txt(p.open_cases ?? 0)} open cases (${snap.cases.map((c) => `${txt(c.case_id)} ${txt(c.title)}`).join('; ') || 'none'}).`,
        snap.risk?.band === 'Collapsed'
          ? `Entity is already ${snap.risk.collapse_status === 'EXAD' ? 'in external administration' : 'deregistered'} (since ${txt(snap.risk.collapse_date).slice(0, 10)}).`
          : `Insolvency risk 12m (calibrated): ${snap.risk ? `${Math.round(Number(snap.risk.p_collapse_12m) * 100)}% ${txt(snap.risk.band)}` : 'not scored'}.`,
        `ATO debt $${txt(p.ato_debt_aud ?? 'n/a')}; APRA flags ${txt(p.apra_flag_count ?? 0)}; AFCA complaints ${txt(p.afca_complaints_latest ?? 0)}; possible banned-director matches ${txt(p.directors_possible_banned_match ?? 0)} (unconfirmed).`,
      ].join('\n');
      const reply = await chat([
        { role: 'system', content: 'You help ASIC triage incoming reports. Recommend exactly one disposition: "Open case", "Link to case" (only if an open case exists for the entity; give its case_id) or "No further action". Reply ONLY with JSON: {"disposition": string, "case_id": string|null, "reasons": [string, string, string], "confidence": "low"|"medium"|"high"}. Base reasons only on the facts given.' },
        { role: 'user', content: ctx },
      ], 500);
      const suggestion = parseJsonReply<Row>(reply) ?? { disposition: null, reasons: ['The model did not return a usable suggestion.'], confidence: 'low' };
      await audit(kit, actor, { action: 'AI triage suggestion', objectType: 'intake', objectId: iid, aiFlag: true, modelVersion: LLM_ENDPOINT, detail: suggestion });
      return { ...suggestion, model: LLM_ENDPOINT, generated_at: new Date().toISOString() };
    }));

    app.post('/api/intake/:iid/disposition', route(kit, async (req, _res, actor) => {
      const iid = txt(req.params.iid);
      const body = Disposition.parse(req.body);
      const { rows } = await kit.lakebase.query(`SELECT * FROM gold.silver_breach_report WHERE intake_id = $1`, [iid]);
      const item = rows[0];
      if (!item) throw new HttpError(404, 'Intake item not found');
      let caseId: string | null = body.case_id ?? null;
      if (body.disposition === 'Link to case' && !caseId) throw new HttpError(400, 'Choose the case to link to');
      if (body.disposition === 'Open case') {
        const { rows: n } = await kit.lakebase.query(`SELECT count(*) AS n FROM case_app.case_state WHERE created_from_intake IS NOT NULL`);
        const seq = Number(n[0]?.n ?? 0) + 1;
        caseId = `N${txt(seq).padStart(5, '0')}`;
        const { rows: ent } = await kit.lakebase.query(`SELECT name FROM gold.silver_entity WHERE entity_id = $1`, [`CO-${txt(item.acn)}`]);
        await kit.lakebase.query(
          `INSERT INTO case_app.case_state (case_id, case_number, title, case_type, stage, priority, team_id, lead_user, respondent_entity_id, summary, created_from_intake, updated_by)
           VALUES ($1,$2,$3,$4,'Assessment','P2',$5,$6,$7,$8,$9,$10)`,
          [caseId, `ASIC-${new Date().getFullYear()}-N${txt(seq).padStart(3, '0')}`, `${txt(ent[0]?.name ?? item.acn)} - ${txt(item.category)}`,
            item.category === 'Unlicensed credit' ? 'Criminal referral' : 'Civil penalty', actor.teamId, actor.userId, `CO-${txt(item.acn)}`, item.summary, iid, actor.email],
        );
      }
      await kit.lakebase.query(
        `INSERT INTO case_app.intake_disposition (intake_id, disposition, reason, case_id, ai_suggestion, decided_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [iid, body.disposition, body.reason, caseId, body.ai_suggestion === undefined ? null : JSON.stringify(body.ai_suggestion), actor.userId],
      );
      await audit(kit, actor, { action: `Intake disposition: ${body.disposition}`, objectType: 'intake', objectId: iid, caseId, reason: body.reason, detail: { followed_ai: body.ai_suggestion ? (body.ai_suggestion as Row).disposition === body.disposition : null } });
      return { ok: true, case_id: caseId };
    }));

    /** S6 Admin: weights, PPS params, registered model versions, proposals. */
    app.get('/api/admin', route(kit, async () => {
      const uc = `${process.env.UC_CATALOG || 'au_pubsec_catalog'}.${process.env.UC_SCHEMA || 'asic_case_management'}`;
      const [{ rows: weights }, { rows: params }, { rows: proposals }, { rows: presets }] = await Promise.all([
        kit.lakebase.query(`SELECT * FROM gold.scoring_weights ORDER BY created_at DESC`),
        kit.lakebase.query(`SELECT * FROM gold.pps_params ORDER BY created_at DESC`),
        kit.lakebase.query(`SELECT p.*, u.display_name AS proposed_by_name FROM case_app.weights_proposal p LEFT JOIN gold.silver_user u ON u.user_id = p.proposed_by ORDER BY proposed_at DESC`),
        kit.lakebase.query(`SELECT * FROM gold.intervention_presets ORDER BY preset_id`),
      ]);
      const models: Row[] = [];
      for (const h of ['12m', '24m']) {
        const name = `${uc}.collapse_model_${h}`;
        try {
          const m = await apiGet<{ aliases?: { alias_name: string; version_num: number }[] }>(`/api/2.1/unity-catalog/models/${name}?include_aliases=true`);
          const v = await apiGet<{ model_versions?: Row[] }>(`/api/2.1/unity-catalog/models/${name}/versions?max_results=5`);
          for (const mv of v.model_versions ?? []) {
            models.push({
              model_name: name, version: mv.version, status: mv.status, created_at: mv.created_at, run_id: mv.run_id,
              aliases: (m.aliases ?? []).filter((a) => a.version_num === Number(mv.version)).map((a) => a.alias_name),
            });
          }
        } catch (err) {
          models.push({ model_name: name, error: (err as Error).message });
        }
      }
      // Validation and calibration metrics per model version (written by 04_train_collapse_model; read as the app)
      let calibration: Row[] = [];
      try {
        calibration = statementRows(await kit.analytics.query(
          `SELECT horizon_months, model_version, test_auc, ece_raw, ece_calibrated, brier_raw, brier_calibrated, population_rate,
                  sample_base_rate, n_calibration, n_evaluation, calibrated_from, evaluated_from, created_at
           FROM ${uc}.collapse_calibration QUALIFY row_number() OVER (PARTITION BY horizon_months, model_version ORDER BY created_at DESC) = 1`,
        ));
      } catch (err) {
        console.error('[admin] calibration metrics unavailable:', (err as Error).message);
      }
      const metric = new Map(calibration.map((c) => [`${txt(c.horizon_months)}m/${txt(c.model_version)}`, c]));
      for (const m of models) {
        const h = txt(m.model_name).endsWith('_24m') ? '24' : '12';
        m.metrics = metric.get(`${h}m/${txt(m.version)}`) ?? null;
        // Scoring serves the 12-month champion only; P(24m) is derived from it (SPEC 8.1)
        m.serving = h === '12' && ((m.aliases as string[]) ?? []).includes('champion');
        m.note = h === '24' ? 'Not served: P(24m) is derived from the calibrated 12-month model' : null;
      }
      return { weights, params, proposals, presets, models, uc };
    }));

    app.post('/api/admin/weights-proposals', route(kit, async (req, _res, actor) => {
      if (actor.persona !== 'Enforcement Lead') throw new HttpError(403, 'Only enforcement leads can propose weight changes');
      const body = Proposal.parse(req.body);
      const sum = Object.values(body.weights).reduce((a, b) => a + b, 0);
      if (Math.abs(sum - 1) > 0.001) throw new HttpError(400, `Weights must sum to 100% (currently ${Math.round(sum * 100)}%)`);
      const { rows } = await kit.lakebase.query(
        `INSERT INTO case_app.weights_proposal (weights, reason, proposed_by) VALUES ($1,$2,$3) RETURNING *`,
        [JSON.stringify(body.weights), body.reason, actor.userId],
      );
      await audit(kit, actor, { action: 'Proposed scoring weights', objectType: 'weights', objectId: txt(rows[0]?.proposal_id), reason: body.reason, newValue: body.weights });
      return rows[0];
    }));
  });
}

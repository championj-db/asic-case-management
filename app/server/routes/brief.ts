import type { Request } from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { getCase } from '../lib/cases';
import { HttpError, parseJson, route } from '../lib/http';
import type { Actor } from '../lib/identity';
import { chatStream, LLM_ENDPOINT } from '../lib/llm';
import { austracAuthorised, austracSummary, redactDrivers } from '../lib/restricted';
import type { Kit, Row } from '../lib/types';
import { txt } from '../lib/types';

export const BRIEF_SECTIONS = [
  'Summary',
  'Recommendation',
  'Alleged contraventions and evidence',
  'Chronology',
  'Respondents and related parties',
  'Cross-agency intelligence',
  'Prosecution Priority Score and scenarios',
  'Risks and mitigations',
  'Comparable past matters',
] as const;

const Section = z.object({ title: z.string(), body: z.string(), status: z.enum(['Draft (AI)', 'Edited', 'Reviewed']) });
const SaveBody = z.object({ sections: z.array(Section).min(1).max(20) });

const fmt = (v: unknown) => (v === null || v === undefined ? 'n/a' : typeof v === 'object' ? JSON.stringify(v) : txt(v));

/**
 * Assembles the grounded context for the brief. Every fact carries a citation token the model must reuse:
 * [EV:<evidence_id>] evidence, [EVT:<event_id>] timeline event, [SR:<entity_id>:<agency>] shared-agency record,
 * [PPS] the current score, [SCN:<scenario_id>] a scenario, [HM:<matter_id>] a past matter.
 * AUSTRAC detail is included only when Unity Catalog says the user is authorised.
 */
async function buildContext(kit: Kit, req: Request, actor: Actor, caseId: string) {
  const c = await getCase(kit, actor, caseId);
  const authorised = await austracAuthorised(kit, req, actor);
  const [parties, events, tagged, profile, risk, pps, scen, past] = await Promise.all([
    kit.lakebase.query(`SELECT entity_id, entity_name, role FROM gold.gold_case_party WHERE case_id = $1 ORDER BY role, entity_name LIMIT 30`, [caseId]),
    kit.lakebase.query(
      `SELECT e.event_id, e.event_date, e.event_type, e.description FROM gold.gold_case_event e
       LEFT JOIN case_app.event_review r ON r.event_id = e.event_id
       WHERE e.case_id = $1 AND coalesce(r.status, e.status) = 'confirmed' ORDER BY e.event_date LIMIT 60`,
      [caseId],
    ),
    kit.lakebase.query(
      `SELECT e.evidence_id, e.filename, e.doc_type, e.ai_summary, coalesce(array_agg(t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}') AS tags
       FROM gold.gold_evidence_item e LEFT JOIN case_app.evidence_tag t ON t.evidence_id = e.evidence_id
       WHERE e.case_id = $1 GROUP BY e.evidence_id, e.filename, e.doc_type, e.ai_summary
       ORDER BY count(t.tag) DESC, e.evidence_id LIMIT 25`,
      [caseId],
    ),
    kit.lakebase.query(`SELECT * FROM gold.gold_entity_profile WHERE entity_id = $1`, [c.respondent_entity_id]),
    kit.lakebase.query(`SELECT * FROM gold.risk_score WHERE entity_id = $1`, [c.respondent_entity_id]),
    kit.lakebase.query(`SELECT * FROM gold.pps_score WHERE case_id = $1`, [caseId]),
    kit.lakebase.query(
      `SELECT scenario_id::text, name, outputs_json::text AS outputs FROM case_app.scenario WHERE case_id = $1
       UNION ALL SELECT scenario_id, name, outputs_json FROM gold.scenario WHERE case_id = $1 LIMIT 12`,
      [caseId],
    ),
    kit.lakebase.query(
      `SELECT matter_id, matter_type, success, duration_months, penalty_aud, recovered_amount_aud, collapsed_before_judgment, citation, source
       FROM gold.silver_historical_matters WHERE matter_type = $1 OR source = 'judgment'
       ORDER BY (source = 'judgment') DESC, judgment_date DESC NULLS LAST LIMIT 8`,
      [c.case_type === 'Criminal referral' ? 'Criminal referral' : 'Civil penalty'],
    ),
  ]);
  const p = profile.rows[0] ?? {};
  const r = risk.rows[0];
  const austrac = authorised ? await austracSummary(kit, req, txt(c.respondent_entity_id)) : null;
  const lines: string[] = [];
  lines.push(`CASE ${txt(c.case_number)}: ${txt(c.title)}. Type ${txt(c.case_type)}; stage ${txt(c.stage)}; team ${txt(c.team_name)}; lead ${txt(c.lead_name)}.`);
  lines.push(`Estimated recoverable $${fmt(c.est_recoverable_aud)}; estimated litigation cost $${fmt(c.est_litigation_cost_aud)}; cost to date $${fmt(c.cost_to_date_aud)}; consumers affected ${fmt(c.consumers_affected)}; consumer loss $${fmt(c.total_consumer_loss_aud)}; limitation date ${fmt(c.limitation_date)}.`);
  if (c.summary) lines.push(`Investigator summary: ${txt(c.summary)}`);
  lines.push('\nPARTIES:');
  for (const x of parties.rows) lines.push(`- ${txt(x.entity_name)} (${txt(x.entity_id)}) — ${txt(x.role)}`);
  lines.push('\nCONFIRMED TIMELINE EVENTS:');
  for (const e of events.rows) lines.push(`- ${fmt(e.event_date).slice(0, 10)} ${txt(e.event_type)}: ${txt(e.description)} [EVT:${txt(e.event_id)}]`);
  lines.push('\nEVIDENCE (tags, AI summary):');
  for (const e of tagged.rows) lines.push(`- ${txt(e.filename)} (${txt(e.doc_type)}; tags: ${(e.tags as string[]).join(', ') || 'none'}): ${txt(e.ai_summary ?? '')} [EV:${txt(e.evidence_id)}]`);
  const sr = (agency: string) => `[SR:${txt(c.respondent_entity_id)}:${txt(agency)}]`;
  lines.push('\nCROSS-AGENCY INTELLIGENCE ON THE RESPONDENT:');
  lines.push(`- ASIC register: status ${fmt(p.status)}, registered ${fmt(p.reg_date)}, ${fmt(p.open_cases)} open cases, ${fmt(p.directors_possible_banned_match)} directors with possible banned-register matches (unconfirmed) ${sr('ASIC')}`);
  lines.push(`- ATO (synthetic stand-in): debt $${fmt(p.ato_debt_aud)} at ${fmt(p.ato_period)}, on-time lodgement ${fmt(p.lodgement_on_time_pct)}%, STP headcount ${fmt(p.stp_headcount)} ${sr('ATO')}`);
  if (p.ato_tt_total_income_aud) lines.push(`- ATO Corporate Tax Transparency (public): total income $${fmt(p.ato_tt_total_income_aud)}, tax payable $${fmt(p.ato_tt_tax_payable_aud)} (${fmt(p.ato_tt_income_year)}) ${sr('ATO')}`);
  lines.push(`- APRA: ${fmt(p.apra_flag_count)} prudential flags ${fmt(p.apra_flags)} ${sr('APRA')}`);
  lines.push(`- AFCA: ${fmt(p.afca_complaints_latest)} complaints in the latest year ${sr('AFCA')}`);
  lines.push(`- ABR: GST ${fmt(p.gst_status)}, ABN ${fmt(p.abn_status)} ${sr('ABR')}`);
  if (austrac) lines.push(`- AUSTRAC (restricted; reader is authorised): ${fmt(austrac.smr_count_24m)} SMRs in 24 months, ${fmt(austrac.large_flow_count)} large-flow ${sr('AUSTRAC')}`);
  else lines.push(`- AUSTRAC: ${fmt(p.austrac_restricted_record_count)} restricted records exist; detail withheld (reader not authorised). Do not speculate about their content.`);
  if (r && r.band === 'Collapsed') {
    lines.push(`- Respondent has already collapsed: ${r.collapse_status === 'EXAD' ? 'entered external administration' : 'deregistered'} on ${txt(r.collapse_date).slice(0, 10)} (ASIC register). No forward collapse probability applies; recovery is treated as if collapse is certain. [PPS]`);
  } else if (r) {
    const drivers = redactDrivers(r.drivers_json, authorised).map((d) => `${d.sentence} (${d.direction} risk)`).join('; ');
    lines.push(`- Collapse model ${txt(r.model_version)}: P(collapse 12m) ${Math.round(Number(r.p_collapse_12m) * 100)}%, 24m ${Math.round(Number(r.p_collapse_24m) * 100)}%, band ${txt(r.band)}. Top drivers: ${txt(drivers)} [PPS]`);
  }
  const ps = pps.rows[0];
  if (ps) lines.push(`\nPPS ${txt(ps.total)} (${txt(ps.band)}), params ${txt(ps.params_version)}, weights ${txt(ps.weights_version)}. Criteria: ${txt(ps.criteria_json)} [PPS]`);
  lines.push('\nSCENARIOS:');
  for (const s of scen.rows) {
    const o = parseJson<Row>(s.outputs, {});
    lines.push(`- ${txt(s.name)}: PPS ${fmt(o.total)} (${fmt(o.band)}), expected net recovery $${fmt(o.expected_net_recovery)} [SCN:${txt(s.scenario_id).slice(0, 8)}]`);
  }
  lines.push('\nCOMPARABLE PAST MATTERS (judgment rows are public decisions; others synthetic estimates):');
  for (const m of past.rows) lines.push(`- ${txt(m.matter_type)}, success ${fmt(m.success)}, ${fmt(m.duration_months)} months, penalty $${fmt(m.penalty_aud)}, recovered $${fmt(m.recovered_amount_aud)}, collapsed before judgment ${fmt(m.collapsed_before_judgment)} ${m.citation ? `(${txt(m.citation)})` : ''} [HM:${txt(m.matter_id)}]`);
  return { c, text: lines.join('\n'), authorised };
}

const SYSTEM = `You draft prosecution recommendation briefs for ASIC enforcement. Write for a Commission audience: precise, neutral, Australian English.
Rules:
- Use ONLY the facts in the CONTEXT. Never invent facts, amounts, dates or parties.
- EVERY sentence that states a fact must end with one or more citation tokens copied exactly from the context, e.g. [EV:EV-00012] [EVT:ab12] [SR:CO-123:ATO] [PPS] [SCN:1a2b3c4d] [HM:HM-00012].
- Write exactly these sections, each starting with a level-2 markdown heading: ${BRIEF_SECTIONS.map((s) => `"## ${s}"`).join(', ')}.
- In "Recommendation" state one of: Proceed, Proceed – conditional, Consider alternatives, Do not pursue — and say the score is a decision aid; the decision rests with the delegate.
- Flag synthetic or unconfirmed data (e.g. possible banned-register matches) as such. Do not speculate about restricted AUSTRAC content.
- Keep each section to 2-6 sentences or a short bullet list.
- Output only the sections: no title, preamble, classification line, horizontal rules or other headings.`;

const norm = (t: string) => t.toLowerCase().replace(/[^a-z]+/g, ' ').trim();

/**
 * Splits the draft into the template sections. Anything before the first template heading (titles, classification lines)
 * and any heading not in the template is dropped; trailing horizontal rules are removed.
 */
export function splitSections(markdown: string) {
  const wanted = new Map(BRIEF_SECTIONS.map((t) => [norm(t), t]));
  const out: { title: string; body: string; status: 'Draft (AI)' }[] = [];
  for (const part of markdown.split(/^##\s+/m).slice(1)) {
    const nl = part.indexOf('\n');
    const heading = (nl < 0 ? part : part.slice(0, nl)).replace(/[*#]/g, '').trim();
    const title = wanted.get(norm(heading)) ?? [...wanted.entries()].find(([k]) => norm(heading).startsWith(k))?.[1];
    if (!title || out.some((o) => o.title === title)) continue;
    const body = (nl < 0 ? '' : part.slice(nl + 1)).replace(/(\n\s*[-*_]{3,}\s*)+$/, '').trim();
    out.push({ title, body, status: 'Draft (AI)' });
  }
  return out;
}

export function registerBriefRoutes(kit: Kit) {
  kit.server.extend((app) => {
    app.get('/api/cases/:id/brief', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const { rows } = await kit.lakebase.query(
        `SELECT b.case_id, b.version, b.sections, b.ai_model, b.generated, b.author, b.created_at, u.display_name AS author_name
         FROM case_app.brief_version b LEFT JOIN gold.silver_user u ON u.user_id = b.author
         WHERE b.case_id = $1 ORDER BY b.version DESC`,
        [id],
      );
      // Current scores, so the UI can flag a draft written before the latest scoring run
      const { rows: pps } = await kit.lakebase.query(`SELECT total, band, scored_at, params_version FROM gold.pps_score WHERE case_id = $1`, [id]);
      return { versions: rows, sections_template: BRIEF_SECTIONS, current_pps: pps[0] ?? null };
    }));

    /** Streams the AI draft as server-sent events: {type:'delta'|'done'|'error'}. Saved as a new version on completion. */
    app.post('/api/cases/:id/brief/generate', route(kit, async (req, res, actor) => {
      const id = txt(req.params.id);
      const { text, authorised } = await buildContext(kit, req, actor, id);
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();
      const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      let full = '';
      try {
        send({ type: 'status', message: 'Context assembled from case, evidence, agency data and scenarios' });
        for await (const delta of chatStream([{ role: 'system', content: SYSTEM }, { role: 'user', content: `CONTEXT:\n${text}` }], 4000)) {
          full += delta;
          send({ type: 'delta', text: delta });
        }
        const sections = splitSections(full);
        if (!sections.length) throw new Error('The model returned an empty draft');
        const { rows } = await kit.lakebase.query(
          `INSERT INTO case_app.brief_version (case_id, version, sections, ai_model, generated, author)
           VALUES ($1, coalesce((SELECT max(version) FROM case_app.brief_version WHERE case_id = $1), 0) + 1, $2, $3, true, $4)
           RETURNING version, created_at`,
          [id, JSON.stringify(sections), LLM_ENDPOINT, actor.userId],
        );
        await audit(kit, actor, {
          action: 'Generated case brief (AI draft)', objectType: 'brief', objectId: `${txt(id)}/v${txt(rows[0]?.version)}`, caseId: id, aiFlag: true,
          modelVersion: LLM_ENDPOINT, detail: { sections: sections.length, austrac_included: authorised, context_chars: text.length },
        });
        send({ type: 'done', version: rows[0]?.version, sections, model: LLM_ENDPOINT, created_at: rows[0]?.created_at });
      } catch (err) {
        console.error('[brief] generation failed', err);
        send({ type: 'error', message: 'Brief generation failed. Try again; if it persists, check the model endpoint.' });
      }
      res.end();
      return undefined;
    }));

    app.post('/api/cases/:id/brief', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const { sections } = SaveBody.parse(req.body);
      if (sections.some((s) => s.status === 'Reviewed') && actor.persona === 'Investigator') {
        throw new HttpError(403, 'Only counsel or an enforcement lead can mark a section Reviewed');
      }
      const { rows } = await kit.lakebase.query(
        `INSERT INTO case_app.brief_version (case_id, version, sections, ai_model, generated, author)
         VALUES ($1, coalesce((SELECT max(version) FROM case_app.brief_version WHERE case_id = $1), 0) + 1, $2, NULL, false, $3)
         RETURNING version, created_at`,
        [id, JSON.stringify(sections), actor.userId],
      );
      await audit(kit, actor, {
        action: 'Saved brief version', objectType: 'brief', objectId: `${txt(id)}/v${txt(rows[0]?.version)}`, caseId: id,
        detail: { statuses: sections.map((s) => s.status) },
      });
      return rows[0];
    }));

    app.post('/api/cases/:id/brief/export', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const body = z.object({ version: z.number().int().nonnegative().optional(), format: z.enum(['doc', 'html']).optional() }).parse(req.body);
      const version = body.version ?? 0;
      const format = body.format ?? 'html';
      await audit(kit, actor, { action: `Exported brief (${format})`, objectType: 'brief', objectId: `${id}/v${version}`, caseId: id });
      return { ok: true };
    }));
  });
}

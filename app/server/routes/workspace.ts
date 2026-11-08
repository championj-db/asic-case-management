import { z } from 'zod';
import { audit } from '../lib/audit';
import { getCase } from '../lib/cases';
import { HttpError, route } from '../lib/http';
import type { Kit, Row } from '../lib/types';
import { txt } from '../lib/types';

const TaskBody = z.object({
  title: z.string().min(2).max(300),
  assignee: z.string().max(64).nullable().optional(),
  due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  link_type: z.enum(['evidence', 'event', 'entity']).nullable().optional(),
  link_id: z.string().max(128).nullable().optional(),
});
const TaskPatch = z.object({ status: z.enum(['Open', 'In progress', 'Done']).optional(), assignee: z.string().max(64).nullable().optional() });
const EventReview = z.object({ status: z.enum(['confirmed', 'rejected']) });
const Annotation = z.object({ entity_id: z.string().max(64).nullable().optional(), label: z.string().min(1).max(500) });

const MAX_NODES = 60;

export function registerWorkspaceRoutes(kit: Kit) {
  kit.server.extend((app) => {
    /** S4.3 Timeline: confirmed events by entity lane; AI-suggested events listed for review. */
    app.get('/api/cases/:id/timeline', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const { rows } = await kit.lakebase.query(
        `SELECT e.event_id, e.event_date, e.event_type, e.description, e.evidence_ids, e.entity_ids, e.source, e.ai_flag, e.provenance,
                coalesce(r.status, e.status) AS status, r.reviewer
         FROM gold.gold_case_event e LEFT JOIN case_app.event_review r ON r.event_id = e.event_id
         WHERE e.case_id = $1 ORDER BY e.event_date`,
        [id],
      );
      const entityIds = [...new Set(rows.flatMap((r) => (Array.isArray(r.entity_ids) ? (r.entity_ids as string[]) : [])))];
      const { rows: names } = await kit.lakebase.query(`SELECT entity_id, name FROM gold.silver_entity WHERE entity_id = ANY($1)`, [entityIds]);
      return {
        events: rows.filter((r) => r.status === 'confirmed'),
        suggested: rows.filter((r) => r.status === 'suggested'),
        entities: names,
      };
    }));

    app.post('/api/events/:eid/review', route(kit, async (req, _res, actor) => {
      const eid = txt(req.params.eid);
      const body = EventReview.parse(req.body);
      const { rows } = await kit.lakebase.query(`SELECT case_id, description FROM gold.gold_case_event WHERE event_id = $1`, [eid]);
      if (!rows[0]) throw new HttpError(404, 'Event not found');
      const caseId = txt(rows[0].case_id);
      await getCase(kit, actor, caseId);
      await kit.lakebase.query(
        `INSERT INTO case_app.event_review (event_id, case_id, status, reviewer) VALUES ($1,$2,$3,$4)
         ON CONFLICT (event_id) DO UPDATE SET status = $3, reviewer = $4, reviewed_at = now()`,
        [eid, caseId, body.status, actor.userId],
      );
      await audit(kit, actor, { action: `${body.status === 'confirmed' ? 'Confirmed' : 'Rejected'} suggested event`, objectType: 'event', objectId: eid, caseId, newValue: body.status, detail: { description: rows[0].description } });
      return { ok: true };
    }));

    /**
     * S4.4 Network: neighbourhood (depth ≤ 2) around the case parties, or around one entity when expanding.
     * Node size = degree centrality within the view; ring = collapse risk; identity confidence shown separately.
     */
    app.get('/api/cases/:id/network', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const depth = req.query.depth === '2' ? 2 : 1;
      const expand = typeof req.query.expand === 'string' ? req.query.expand.split(',').filter(Boolean).slice(0, 20) : [];
      const relTypes = typeof req.query.rel === 'string' && req.query.rel ? req.query.rel.split(',') : null;
      const { rows: parties } = await kit.lakebase.query(`SELECT entity_id, role FROM gold.gold_case_party WHERE case_id = $1`, [id]);
      const seeds = [...new Set([...parties.map((p) => txt(p.entity_id)), ...expand])];
      const edges = new Map<string, Row>();
      let frontier = seeds;
      const seen = new Set(seeds);
      for (let d = 0; d < depth + (expand.length ? 1 : 0) && frontier.length; d++) {
        const { rows } = await kit.lakebase.query(
          `SELECT from_entity, to_entity, rel_type, weight, provenance FROM gold.gold_entity_network
           WHERE (from_entity = ANY($1) OR to_entity = ANY($1)) AND ($2::text[] IS NULL OR rel_type = ANY($2))
           ORDER BY weight DESC LIMIT 400`,
          [frontier, relTypes],
        );
        const next: string[] = [];
        for (const e of rows) {
          const key = `${txt(e.from_entity)}|${txt(e.to_entity)}|${txt(e.rel_type)}`;
          if (edges.has(key)) continue;
          for (const n of [txt(e.from_entity), txt(e.to_entity)]) {
            if (!seen.has(n) && seen.size < MAX_NODES) {
              seen.add(n);
              next.push(n);
            }
          }
          if (seen.has(txt(e.from_entity)) && seen.has(txt(e.to_entity))) edges.set(key, e);
        }
        frontier = next;
      }
      const ids = [...seen];
      const [{ rows: ents }, { rows: risks }, { rows: notes }] = await Promise.all([
        kit.lakebase.query(`SELECT entity_id, name, entity_type, match_confidence, provenance FROM gold.silver_entity WHERE entity_id = ANY($1)`, [ids]),
        kit.lakebase.query(`SELECT entity_id, p_collapse_12m, band, collapse_date, collapse_status FROM gold.risk_score WHERE entity_id = ANY($1)`, [ids]),
        kit.lakebase.query(`SELECT annotation_id, entity_id, label, created_by, created_at FROM case_app.network_annotation WHERE case_id = $1 ORDER BY created_at`, [id]),
      ]);
      const degree = new Map<string, number>();
      for (const e of edges.values()) {
        degree.set(txt(e.from_entity), (degree.get(txt(e.from_entity)) ?? 0) + 1);
        degree.set(txt(e.to_entity), (degree.get(txt(e.to_entity)) ?? 0) + 1);
      }
      const ent = new Map(ents.map((e) => [txt(e.entity_id), e]));
      const risk = new Map(risks.map((r) => [txt(r.entity_id), r]));
      const role = new Map(parties.map((p) => [txt(p.entity_id), txt(p.role)]));
      const nodes = ids.map((n) => ({
        id: n,
        name: ent.get(n)?.name ?? (n.startsWith('BAN-') ? 'Banned register record' : n),
        type: ent.get(n)?.entity_type ?? (n.startsWith('BAN-') ? 'banned_record' : 'unknown'),
        role: role.get(n) ?? null,
        match_confidence: ent.get(n)?.match_confidence ?? null,
        p_collapse_12m: risk.get(n)?.p_collapse_12m ?? null,
        risk_band: risk.get(n)?.band ?? null,
        risk_collapse_date: risk.get(n)?.collapse_date ?? null,
        risk_collapse_status: risk.get(n)?.collapse_status ?? null,
        degree: degree.get(n) ?? 0,
        provenance: ent.get(n)?.provenance ?? 'public',
      }));
      return { nodes, edges: [...edges.values()], annotations: notes, truncated: seen.size >= MAX_NODES };
    }));

    app.post('/api/cases/:id/annotations', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const body = Annotation.parse(req.body);
      const { rows } = await kit.lakebase.query(
        `INSERT INTO case_app.network_annotation (case_id, entity_id, label, created_by) VALUES ($1,$2,$3,$4) RETURNING *`,
        [id, body.entity_id ?? null, body.label, actor.email],
      );
      await audit(kit, actor, { action: 'Added network annotation', objectType: 'annotation', objectId: txt(rows[0]?.annotation_id), caseId: id, newValue: body.label });
      return rows[0];
    }));

    app.get('/api/cases/:id/tasks', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const { rows } = await kit.lakebase.query(
        `SELECT t.*, u.display_name AS assignee_name FROM case_app.task t LEFT JOIN gold.silver_user u ON u.user_id = t.assignee
         WHERE t.case_id = $1 ORDER BY (t.status = 'Done'), t.due_date NULLS LAST, t.task_id`,
        [id],
      );
      return { tasks: rows };
    }));

    app.post('/api/cases/:id/tasks', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const b = TaskBody.parse(req.body);
      const { rows } = await kit.lakebase.query(
        `INSERT INTO case_app.task (case_id, title, assignee, due_date, link_type, link_id, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [id, b.title, b.assignee ?? null, b.due_date ?? null, b.link_type ?? null, b.link_id ?? null, actor.email],
      );
      await audit(kit, actor, { action: 'Created task', objectType: 'task', objectId: txt(rows[0]?.task_id), caseId: id, newValue: b.title });
      return rows[0];
    }));

    app.patch('/api/tasks/:tid', route(kit, async (req, _res, actor) => {
      const tid = Number(req.params.tid);
      const b = TaskPatch.parse(req.body);
      const { rows: cur } = await kit.lakebase.query(`SELECT * FROM case_app.task WHERE task_id = $1`, [tid]);
      if (!cur[0]) throw new HttpError(404, 'Task not found');
      await getCase(kit, actor, txt(cur[0].case_id));
      const { rows } = await kit.lakebase.query(
        `UPDATE case_app.task SET status = coalesce($2, status), assignee = CASE WHEN $3::boolean THEN $4 ELSE assignee END, updated_at = now()
         WHERE task_id = $1 RETURNING *`,
        [tid, b.status ?? null, b.assignee !== undefined, b.assignee ?? null],
      );
      await audit(kit, actor, { action: 'Updated task', objectType: 'task', objectId: txt(tid), caseId: txt(cur[0].case_id), field: b.status ? 'status' : 'assignee', oldValue: b.status ? cur[0].status : cur[0].assignee, newValue: b.status ?? b.assignee });
      return rows[0];
    }));

    app.get('/api/cases/:id/audit', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const { rows } = await kit.lakebase.query(
        `SELECT audit_id, at, actor, acting_as, action, object_type, object_id, field, old_value, new_value, reason, ai_flag, model_version
         FROM case_app.audit_log WHERE case_id = $1 ORDER BY at DESC LIMIT 500`,
        [id],
      );
      return { entries: rows };
    }));

    app.get('/api/cases/:id/audit/export', route(kit, async (req, res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const { rows } = await kit.lakebase.query(`SELECT * FROM case_app.audit_log WHERE case_id = $1 ORDER BY at`, [id]);
      await audit(kit, actor, { action: 'Exported audit log', objectType: 'case', objectId: id, caseId: id, detail: { rows: rows.length } });
      const cols = ['audit_id', 'at', 'actor', 'acting_as', 'action', 'object_type', 'object_id', 'field', 'old_value', 'new_value', 'reason', 'ai_flag', 'model_version'];
      const esc = (v: unknown) => `"${txt(v ?? '').replace(/"/g, '""')}"`;
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${id}-audit.csv"`);
      res.send([cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'));
      return undefined;
    }));
  });
}

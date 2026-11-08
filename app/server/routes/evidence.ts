import { createHash, randomUUID } from 'node:crypto';
import express from 'express';
import { z } from 'zod';
import { audit } from '../lib/audit';
import { getCase } from '../lib/cases';
import { HttpError, route } from '../lib/http';
import { chat, LLM_ENDPOINT } from '../lib/llm';
import type { Kit, Row } from '../lib/types';
import { txt } from '../lib/types';

type FilesApi = (key: string) => { upload(path: string, body: Buffer, opts?: { overwrite?: boolean }): Promise<void> };

const TAGS: Record<string, string> = {
  Hot: 'hot',
  Privileged: 'privileged',
  'Element: s1041H misleading conduct': 'element',
  'Element: s180 care and diligence': 'element',
  'Element: s181 good faith': 'element',
  'Element: s182 improper use of position': 'element',
  'Element: s588G insolvent trading': 'element',
  'Element: s912A licensee obligations': 'element',
  'Element: NCCP s29 unlicensed credit': 'element',
};

const TagBody = z.object({ tag: z.string().refine((t) => t in TAGS, 'Unknown tag'), on: z.boolean() });
const ReviewBody = z.object({ status: z.enum(['confirmed', 'rejected']) });
const AskBody = z.object({ question: z.string().min(3).max(1000) });

export function registerEvidenceRoutes(kit: Kit) {
  kit.server.extend((app) => {
    app.get('/api/evidence-tags', route(kit, () => Promise.resolve({ tags: Object.entries(TAGS).map(([tag, category]) => ({ tag, category })) })));

    app.get('/api/cases/:id/evidence', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const { rows } = await kit.lakebase.query(
        `SELECT e.evidence_id, e.filename, e.doc_type, e.custodian, e.source, e.document_date, e.bytes, e.page_count, e.hash_verified,
                e.provenance, e.ai_flag,
                coalesce(array_agg(DISTINCT t.tag) FILTER (WHERE t.tag IS NOT NULL), '{}') AS tags,
                count(DISTINCT x.extraction_id) FILTER (WHERE r.extraction_id IS NULL) AS pending
         FROM gold.gold_evidence_item e
         LEFT JOIN case_app.evidence_tag t ON t.evidence_id = e.evidence_id
         LEFT JOIN gold.silver_evidence_extraction x ON x.evidence_id = e.evidence_id
         LEFT JOIN case_app.extraction_review r ON r.extraction_id = x.extraction_id
         WHERE e.case_id = $1
         GROUP BY e.evidence_id, e.filename, e.doc_type, e.custodian, e.source, e.document_date, e.bytes, e.page_count,
                  e.hash_verified, e.provenance, e.ai_flag
         UNION ALL
         SELECT u.evidence_id, u.filename, 'Uploaded', u.custodian, 'App upload', u.uploaded_at, u.bytes, NULL, true, 'uploaded', false,
                coalesce((SELECT array_agg(tag) FROM case_app.evidence_tag t WHERE t.evidence_id = u.evidence_id), '{}'), 0
         FROM case_app.uploaded_evidence u WHERE u.case_id = $1
         ORDER BY document_date DESC NULLS LAST`,
        [id],
      );
      return { items: rows };
    }));

    app.get('/api/evidence/:eid', route(kit, async (req, _res, actor) => {
      const eid = txt(req.params.eid);
      const { rows } = await kit.lakebase.query(`SELECT * FROM gold.gold_evidence_item WHERE evidence_id = $1`, [eid]);
      const item = rows[0];
      if (!item) throw new HttpError(404, 'Evidence item not found');
      await getCase(kit, actor, txt(item.case_id));
      const [extractions, custody, access, tags] = await Promise.all([
        kit.lakebase.query(
          `SELECT x.extraction_id, x.kind, x.value, x.span, x.span_start, x.span_end, x.event_date, x.model, x.generated_at,
                  coalesce(r.status, 'suggested') AS status, r.reviewer, r.reviewed_at, u.display_name AS reviewer_name
           FROM gold.silver_evidence_extraction x
           LEFT JOIN case_app.extraction_review r ON r.extraction_id = x.extraction_id
           LEFT JOIN gold.silver_user u ON u.user_id = r.reviewer
           WHERE x.evidence_id = $1 ORDER BY x.span_start NULLS LAST, x.kind`,
          [eid],
        ),
        kit.lakebase.query(`SELECT actor, action, event_ts AS at, hash_after FROM gold.gold_custody_event WHERE evidence_id = $1 ORDER BY event_ts`, [eid]),
        kit.lakebase.query(`SELECT actor, action, at, sha256 FROM case_app.custody_access WHERE evidence_id = $1 ORDER BY at`, [eid]),
        kit.lakebase.query(`SELECT tag, category, created_by, created_at FROM case_app.evidence_tag WHERE evidence_id = $1 ORDER BY created_at`, [eid]),
      ]);
      // Viewing evidence is part of the chain of custody (SPEC 10)
      await kit.lakebase.query(
        `INSERT INTO case_app.custody_access (evidence_id, case_id, action, actor, sha256) VALUES ($1, $2, 'viewed', $3, $4)`,
        [eid, item.case_id, actor.email, item.sha256],
      );
      return { item, extractions: extractions.rows, custody: [...custody.rows, ...access.rows], tags: tags.rows };
    }));

    app.post('/api/evidence/:eid/tags', route(kit, async (req, _res, actor) => {
      const eid = txt(req.params.eid);
      const body = TagBody.parse(req.body);
      const { rows } = await kit.lakebase.query(
        `SELECT case_id FROM gold.gold_evidence_item WHERE evidence_id = $1
         UNION ALL SELECT case_id FROM case_app.uploaded_evidence WHERE evidence_id = $1`,
        [eid],
      );
      const caseId = rows[0]?.case_id ? txt(rows[0].case_id) : null;
      if (!caseId) throw new HttpError(404, 'Evidence item not found');
      await getCase(kit, actor, caseId);
      if (body.on) {
        await kit.lakebase.query(
          `INSERT INTO case_app.evidence_tag (evidence_id, case_id, tag, category, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
          [eid, caseId, body.tag, TAGS[body.tag], actor.email],
        );
      } else {
        await kit.lakebase.query(`DELETE FROM case_app.evidence_tag WHERE evidence_id = $1 AND tag = $2`, [eid, body.tag]);
      }
      await audit(kit, actor, { action: body.on ? 'Tagged evidence' : 'Removed evidence tag', objectType: 'evidence', objectId: eid, caseId, field: 'tag', newValue: body.tag });
      return { ok: true };
    }));

    app.post('/api/extractions/:xid/review', route(kit, async (req, _res, actor) => {
      const xid = txt(req.params.xid);
      const body = ReviewBody.parse(req.body);
      const { rows } = await kit.lakebase.query(
        `SELECT extraction_id, case_id, evidence_id, kind, value, event_date, model FROM gold.silver_evidence_extraction WHERE extraction_id = $1`,
        [xid],
      );
      const x = rows[0];
      if (!x) throw new HttpError(404, 'Extraction not found');
      await getCase(kit, actor, txt(x.case_id));
      await kit.lakebase.query(
        `INSERT INTO case_app.extraction_review (extraction_id, case_id, status, reviewer) VALUES ($1,$2,$3,$4)
         ON CONFLICT (extraction_id) DO UPDATE SET status = $3, reviewer = $4, reviewed_at = now()`,
        [xid, x.case_id, body.status, actor.userId],
      );
      // Confirming an AI-suggested event also confirms the matching timeline event (only confirmed items reach the Timeline)
      if (x.kind === 'event' && x.event_date) {
        const { rows: ev } = await kit.lakebase.query(
          `SELECT event_id FROM gold.gold_case_event WHERE case_id = $1 AND source = 'silver_evidence_extraction'
             AND event_date = $2 AND description = $3 AND evidence_ids ? $4`,
          [x.case_id, x.event_date, x.value, x.evidence_id],
        );
        for (const e of ev) {
          await kit.lakebase.query(
            `INSERT INTO case_app.event_review (event_id, case_id, status, reviewer) VALUES ($1,$2,$3,$4)
             ON CONFLICT (event_id) DO UPDATE SET status = $3, reviewer = $4, reviewed_at = now()`,
            [e.event_id, x.case_id, body.status, actor.userId],
          );
        }
      }
      await audit(kit, actor, {
        action: body.status === 'confirmed' ? 'Confirmed AI extraction' : 'Rejected AI extraction',
        objectType: 'extraction', objectId: xid, caseId: txt(x.case_id), field: 'status',
        oldValue: 'suggested', newValue: body.status, detail: { kind: x.kind, value: x.value, evidence_id: x.evidence_id }, modelVersion: txt(x.model ?? ''),
      });
      return { ok: true };
    }));

    /** Keyword (exact, Postgres) or semantic (Vector Search, scoped to the case) evidence search. */
    app.get('/api/cases/:id/evidence/search', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const q = txt(req.query.q ?? '').trim();
      const mode = req.query.mode === 'semantic' ? 'semantic' : 'keyword';
      if (q.length < 2) return { mode, results: [] };
      if (mode === 'keyword') {
        const { rows } = await kit.lakebase.query(
          `SELECT evidence_id, filename, doc_type,
                  substring(parsed_text FROM greatest(position(lower($2) IN lower(parsed_text)) - 120, 1) FOR 320) AS passage
           FROM gold.gold_evidence_item WHERE case_id = $1 AND parsed_text ILIKE '%' || $2 || '%' LIMIT 25`,
          [id, q],
        );
        return { mode, results: rows.map((r) => ({ ...r, score: null })) };
      }
      const res = await kit.aiSearch.query('evidence', { queryText: q, numResults: 12, filters: { case_id: id } });
      const ids = [...new Set(res.results.map((r) => txt(r.data.evidence_id)))];
      const { rows: names } = await kit.lakebase.query(`SELECT evidence_id, filename, doc_type FROM gold.gold_evidence_item WHERE evidence_id = ANY($1)`, [ids]);
      const byId = new Map(names.map((n) => [n.evidence_id, n]));
      return {
        mode,
        results: res.results.map((r) => ({
          evidence_id: r.data.evidence_id,
          filename: byId.get(r.data.evidence_id)?.filename,
          doc_type: r.data.doc_type,
          passage: r.data.chunk_text,
          score: r.score,
        })),
      };
    }));

    /** Ask the case's evidence: retrieval scoped to the case, answer must cite evidence ids. AI output, labelled. */
    app.post('/api/cases/:id/evidence/ask', route(kit, async (req, _res, actor) => {
      const id = txt(req.params.id);
      await getCase(kit, actor, id);
      const { question } = AskBody.parse(req.body);
      const hits = await kit.aiSearch.query('evidence', { queryText: question, numResults: 8, filters: { case_id: id } });
      const context = hits.results.map((r) => `[${txt(r.data.evidence_id)}] (${txt(r.data.doc_type)}) ${txt(r.data.chunk_text)}`).join('\n\n');
      const answer = await chat([
        {
          role: 'system',
          content:
            'You assist an ASIC investigator. Answer ONLY from the evidence passages provided. Cite every claim with the evidence id in square brackets, e.g. [EV-00012]. If the passages do not answer the question, say so plainly. Be concise and factual; do not speculate.',
        },
        { role: 'user', content: `Question: ${question}\n\nEvidence passages:\n${context || '(no passages found)'}` },
      ], 900);
      await audit(kit, actor, { action: 'Asked evidence (AI)', objectType: 'case', objectId: id, caseId: id, aiFlag: true, modelVersion: LLM_ENDPOINT, detail: { question, sources: hits.results.length } });
      return { answer, sources: hits.results.map((r) => ({ evidence_id: r.data.evidence_id, score: r.score })), model: LLM_ENDPOINT, generated_at: new Date().toISOString() };
    }));

    /** Upload: the original goes to the UC evidence volume unchanged; SHA-256 taken on receipt (SPEC 10). */
    app.post(
      '/api/cases/:id/evidence/upload',
      express.raw({ type: '*/*', limit: '25mb' }),
      route(kit, async (req, _res, actor) => {
        const id = txt(req.params.id);
        await getCase(kit, actor, id);
        const body = req.body as Buffer;
        if (!Buffer.isBuffer(body) || body.length === 0) throw new HttpError(400, 'Empty upload');
        const filename = txt(req.header('x-filename') || 'upload.bin').replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 120);
        const sha256 = createHash('sha256').update(body).digest('hex');
        const evidenceId = `UP-${randomUUID().slice(0, 8).toUpperCase()}`;
        const path = `${id}/${evidenceId}_${filename}`;
        await (kit.files as FilesApi)('files').upload(path, body, { overwrite: false });
        await kit.lakebase.query(
          `INSERT INTO case_app.uploaded_evidence (evidence_id, case_id, filename, volume_path, sha256, bytes, custodian, uploaded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [evidenceId, id, filename, path, sha256, body.length, req.header('x-custodian') || null, actor.email],
        );
        await kit.lakebase.query(
          `INSERT INTO case_app.custody_access (evidence_id, case_id, action, actor, sha256) VALUES ($1,$2,'uploaded',$3,$4)`,
          [evidenceId, id, actor.email, sha256],
        );
        await audit(kit, actor, { action: 'Uploaded evidence', objectType: 'evidence', objectId: evidenceId, caseId: id, detail: { filename, sha256, bytes: body.length } });
        const out: Row = { evidence_id: evidenceId, sha256, bytes: body.length, filename };
        return out;
      }),
    );
  });
}

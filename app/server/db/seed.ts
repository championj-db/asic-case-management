import { CASES_SQL } from '../lib/cases';
import type { Kit, Row } from '../lib/types';
import { txt } from '../lib/types';

type Who = 'investigator' | 'counsel' | 'lead';
/** Stage-appropriate work so queues are realistic on first run. Offsets are days from today (negative = overdue). */
const TEMPLATES: Record<string, { title: string; who: Who; due: number; link?: string }[]> = {
  Assessment: [
    { title: 'Complete preliminary assessment of {resp}', who: 'investigator', due: 6 },
    { title: 'Run cross-agency entity check (ATO, APRA, AFCA) for {resp}', who: 'investigator', due: 2 },
    { title: 'Decide whether to open a formal investigation', who: 'lead', due: 13 },
  ],
  Investigation: [
    { title: 'Issue s33 notice to produce books to {resp}', who: 'investigator', due: -1 },
    { title: 'Review pending AI extractions in evidence', who: 'investigator', due: 4, link: 'evidence' },
    { title: 'Conduct s19 examination of a key officer', who: 'investigator', due: 20 },
    { title: 'Obtain bank statements by s33 notice', who: 'investigator', due: 9 },
  ],
  Decision: [
    { title: 'Draft prosecution brief for the delegate', who: 'counsel', due: 6, link: 'brief' },
    { title: 'Counsel review of evidence sufficiency', who: 'counsel', due: 2 },
    { title: 'Record prosecution decision', who: 'lead', due: 13, link: 'scoring' },
  ],
  Litigation: [
    { title: 'File originating process', who: 'counsel', due: 10 },
    { title: 'Monitor {resp} solvency and consider asset preservation', who: 'investigator', due: 2, link: 'scoring' },
  ],
  Referral: [
    { title: 'Prepare evidence bundle for CDPP referral', who: 'counsel', due: 12 },
    { title: 'Brief CDPP on cross-agency intelligence', who: 'lead', due: 18 },
  ],
  Outcome: [{ title: 'Report outcome to the Commission', who: 'lead', due: 7 }],
};

const hash = (s: string) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

/** Seeds tasks once (only when the task table is empty). Runs as the app; idempotent across restarts. */
export async function seedTasks(kit: Kit) {
  const { rows: existing } = await kit.lakebase.query(`SELECT count(*)::int AS n FROM case_app.task`);
  if (Number(existing[0]?.n ?? 0) > 0) return 0;
  const [{ rows: cases }, { rows: users }] = await Promise.all([
    kit.lakebase.query(`SELECT case_id, stage, team_id, lead_user, respondent_name FROM (${CASES_SQL}) x WHERE x.stage <> 'Closed'`),
    kit.lakebase.query(`SELECT user_id, persona, team_id FROM gold.silver_user`),
  ]);
  const pick = (team: string, persona: string): string | null =>
    users.find((u: Row) => u.team_id === team && u.persona === persona)?.user_id as string | undefined ??
    users.find((u: Row) => u.persona === persona)?.user_id as string | undefined ?? null;
  const values: unknown[] = [];
  const tuples: string[] = [];
  for (const c of cases) {
    const h = hash(txt(c.case_id));
    const tpl = TEMPLATES[txt(c.stage)] ?? [];
    tpl.forEach((t, i) => {
      if ((h >>> i) % 4 === 0 && i > 0) return; // vary the workload a little per case
      const assignee =
        t.who === 'lead' ? txt(c.lead_user) || pick(txt(c.team_id), 'Enforcement Lead') : pick(txt(c.team_id), t.who === 'counsel' ? 'Legal Counsel' : 'Investigator');
      const due = t.due + ((h >>> (i + 3)) % 5) - 2;
      const title = t.title.replace('{resp}', txt(c.respondent_name ?? 'the respondent').replace(/\b\w+/g, (w) => w[0] + w.slice(1).toLowerCase()));
      const n = values.length;
      tuples.push(`($${n + 1}, $${n + 2}, $${n + 3}, current_date + $${n + 4}::int, $${n + 5}, 'system:seed')`);
      values.push(c.case_id, title, assignee, due, t.link ?? null);
    });
  }
  if (!tuples.length) return 0;
  await kit.lakebase.query(
    `INSERT INTO case_app.task (case_id, title, assignee, due_date, link_type, created_by) VALUES ${tuples.join(', ')}`,
    values,
  );
  return tuples.length;
}

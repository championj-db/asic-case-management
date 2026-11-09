import { route } from '../lib/http';
import type { Kit, Row } from '../lib/types';

/**
 * Data sources & attribution (SPEC 9.1): what is public, what is synthetic, the licence to attribute, and how each source
 * is actually used. `status` is honest: some public sources are ingested but not yet used by the app.
 */
const SOURCES = [
  { id: 'P1', name: 'ASIC Company Dataset', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Entity master; insolvency and deregistration outcomes (REGD → EXAD/DRGD)' },
  { id: 'P2', name: 'ASIC Business Names Dataset', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Business names held by each company; phoenix signal when a name is shared between related companies' },
  { id: 'P3', name: 'AFS and Credit Licensee datasets', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Licence panel; licence risk indicators' },
  { id: 'P4', name: 'Banned & Disqualified Persons / Organisations', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Possible matches only, for human review (never auto-linked to a person)' },
  { id: 'P5', name: 'ASIC Liquidator Dataset', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Registered liquidators (planned: external administrator on each insolvency)' },
  { id: 'P10', name: 'Open Australian Legal Corpus (ASIC v … judgments)', publisher: '-', provenance: 'public', licence: '-', feeds: 'Comparable past matters (facts extracted by LLM, labelled derived)' },
  { id: 'P11', name: 'ABN Bulk Extract', publisher: 'ABR via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Resolution backbone; GST status' },
  { id: 'P12', name: 'Corporate Tax Transparency', publisher: 'ATO via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'ATO panel for large corporates (income, taxable income, tax payable)' },
  { id: 'P17', name: 'Australian Sanctions Consolidated List', publisher: 'DFAT', provenance: 'public', licence: 'DFAT terms of use', feeds: 'Sanctions name screening (possible match only)' },
  { id: 'P18', name: 'ACNC Charity Register', publisher: 'ACNC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Charities and responsible persons (planned)' },
  { id: 'S1', name: 'ATO tax debt, lodgement, payroll (STP)', publisher: 'Synthetic (taxpayer secrecy)', provenance: 'synthetic', licence: '—', feeds: 'ATO panel; insolvency-risk features' },
  { id: 'S2', name: 'AUSTRAC suspicious matter reports', publisher: 'Synthetic (restricted)', provenance: 'synthetic', licence: '—', feeds: 'Restricted panel; masked unless authorised' },
  { id: 'S3', name: 'APRA prudential flags, AFCA complaints', publisher: 'Synthetic stand-ins (P13–P15 web-only)', provenance: 'synthetic', licence: '—', feeds: 'Harm and risk indicators' },
  { id: 'S4', name: 'Directors and officeholders', publisher: 'Synthetic over real companies (no public bulk data)', provenance: 'synthetic', licence: '—', feeds: 'Network; director history' },
  { id: 'S5', name: 'Cases, intake reports, evidence documents, budgets and spend', publisher: 'Synthetic (internal to ASIC)', provenance: 'synthetic', licence: '—', feeds: 'Intake queue, case workspace, executive briefing' },
];

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export function registerSourceRoutes(kit: Kit) {
  kit.server.extend((app) => {
    app.get('/api/sources', route(kit, async () => {
      const [{ rows: linked }, { rows: other }] = await Promise.all([
        kit.lakebase.query(
          `SELECT source_id, provenance, count(*) AS records, count(DISTINCT entity_id) AS entities
           FROM gold.silver_source_record GROUP BY source_id, provenance`,
        ),
        // Uses that are not source records: possible matches (review only), past matters and screening
        kit.lakebase.query(
          `SELECT (SELECT count(*) FROM gold.gold_entity_network WHERE rel_type = 'possible_match') AS p4_possible,
                  (SELECT count(*) FROM gold.gold_entity_network WHERE rel_type = 'shares_business_name') AS p2_shared,
                  (SELECT count(*) FROM gold.silver_historical_matters WHERE provenance = 'derived') AS p10_matters,
                  (SELECT count(*) FROM gold.gold_entity_profile WHERE sanctions_possible_match_refs IS NOT NULL
                     AND sanctions_possible_match_refs::text NOT IN ('[]', 'null', '')) AS p17_possible,
                  (SELECT count(*) FROM gold.gold_entity_profile WHERE ato_tt_total_income_aud IS NOT NULL) AS p12_profiles`,
        ),
      ]);
      const byId = new Map(linked.map((r: Row) => [String(r.source_id), r]));
      const o = other[0] ?? {};
      const usage: Record<string, { linked: number; entities: number; detail: string; status: 'In use' | 'Review only' | 'Not yet used' }> = {};
      for (const s of SOURCES) {
        const r = byId.get(s.id);
        const n = Number(r?.records ?? 0);
        const e = Number(r?.entities ?? 0);
        let detail = n ? `${count(n, 'record')} on ${count(e, 'entity', 'entities')}` : '';
        let status: 'In use' | 'Review only' | 'Not yet used' = n ? 'In use' : 'Not yet used';
        if (s.id === 'P2') { const sh = Number(o.p2_shared ?? 0); detail = `${detail}${detail ? ' · ' : ''}${sh ? `${count(sh, 'name')} shared between focus companies` : 'no names shared between focus companies in this slice'}`; }
        if (s.id === 'P4') { detail = `${count(Number(o.p4_possible ?? 0), 'possible match', 'possible matches')} awaiting review`; status = 'Review only'; }
        if (s.id === 'P10') { detail = `${count(Number(o.p10_matters ?? 0), 'past matter')}`; status = 'In use'; }
        if (s.id === 'P12') detail = `${detail}${detail ? ' · ' : ''}${count(Number(o.p12_profiles ?? 0), 'entity profile')}`;
        if (s.id === 'P17') { detail = `Screened in Entity 360 · ${count(Number(o.p17_possible ?? 0), 'possible match', 'possible matches')}`; status = 'Review only'; }
        if (s.id === 'S5') { detail = `${detail}${detail ? ' · ' : ''}cases, evidence and spend held in the case tables`; status = 'In use'; }
        if (!detail) detail = 'Ingested to the lakehouse; not yet used in the app';
        usage[s.id] = { linked: n, entities: e, detail, status };
      }
      return { sources: SOURCES.map((s) => ({ ...s, ...usage[s.id] })) };
    }));
  });
}

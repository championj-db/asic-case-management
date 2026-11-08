import { route } from '../lib/http';
import type { Kit } from '../lib/types';

/** Data sources & attribution (SPEC 9.1): what is public, what is synthetic, and the licence to attribute. */
const SOURCES = [
  { id: 'P1', name: 'ASIC Company Dataset', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Entity master; collapse labels (REGD → EXAD/DRGD)' },
  { id: 'P2', name: 'ASIC Business Names Dataset', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Entity resolution; phoenix signals' },
  { id: 'P3', name: 'AFS and Credit Licensee datasets', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Licence panel; licence risk indicators' },
  { id: 'P4', name: 'Banned & Disqualified Persons / Organisations', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Possible matches (human review only)' },
  { id: 'P5', name: 'ASIC Liquidator Dataset', publisher: 'ASIC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'External administrators' },
  { id: 'P10', name: 'Open Australian Legal Corpus (ASIC v … judgments)', publisher: 'Isaacus, Hugging Face', provenance: 'public', licence: 'Per source — check before production use', feeds: 'Historical matters (LLM-extracted, labelled derived)' },
  { id: 'P11', name: 'ABN Bulk Extract', publisher: 'ABR via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Resolution backbone; GST status' },
  { id: 'P12', name: 'Corporate Tax Transparency', publisher: 'ATO via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'ATO panel for large corporates' },
  { id: 'P17', name: 'Australian Sanctions Consolidated List', publisher: 'DFAT', provenance: 'public', licence: 'DFAT terms of use', feeds: 'Sanctions screening (possible match)' },
  { id: 'P18', name: 'ACNC Charity Register', publisher: 'ACNC via data.gov.au', provenance: 'public', licence: 'CC BY 3.0 AU', feeds: 'Charities and responsible persons' },
  { id: 'S1', name: 'ATO tax debt, lodgement, payroll (STP)', publisher: 'Synthetic (taxpayer secrecy)', provenance: 'synthetic', licence: '—', feeds: 'ATO panel; collapse features' },
  { id: 'S2', name: 'AUSTRAC suspicious matter reports', publisher: 'Synthetic (restricted)', provenance: 'synthetic', licence: '—', feeds: 'Restricted panel; masked unless authorised' },
  { id: 'S3', name: 'APRA prudential flags, AFCA complaints', publisher: 'Synthetic stand-ins (P13–P15 web-only)', provenance: 'synthetic', licence: '—', feeds: 'Harm and risk indicators' },
  { id: 'S4', name: 'Directors and officeholders', publisher: 'Synthetic over real companies (no public bulk data)', provenance: 'synthetic', licence: '—', feeds: 'Network; director history' },
  { id: 'S5', name: 'Cases, evidence documents, budgets and spend', publisher: 'Synthetic (internal to ASIC)', provenance: 'synthetic', licence: '—', feeds: 'Case workspace, executive briefing' },
];

export function registerSourceRoutes(kit: Kit) {
  kit.server.extend((app) => {
    app.get('/api/sources', route(kit, async () => {
      const { rows } = await kit.lakebase.query(`SELECT agency, provenance, count(*) AS records FROM gold.silver_source_record GROUP BY agency, provenance ORDER BY agency`);
      return { sources: SOURCES, record_counts: rows };
    }));
  });
}

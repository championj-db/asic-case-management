import type { Request } from 'express';
import { sql } from '@databricks/appkit';
import type { Actor } from './identity';
import { statementRows, type Kit, type Row } from './types';

/**
 * AUSTRAC-restricted data (SPEC 10). Unity Catalog decides: the check and the detail queries run on behalf of the
 * signed-in user against the secure views created by notebook 07, so a user only sees what UC lets them see.
 * Restricted detail is never synced into Lakebase; anything derived from it in synced tables is redacted here.
 */
const UC = `${process.env.UC_CATALOG || 'au_pubsec_catalog'}.${process.env.UC_SCHEMA || 'asic_case_management'}`;
const cache = new Map<string, { ok: boolean; at: number }>();

export async function austracAuthorised(kit: Kit, req: Request, actor: Actor): Promise<boolean> {
  const hit = cache.get(actor.email);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.ok;
  let ok = false;
  try {
    const rows = statementRows(await kit.asUser(req).analytics.query(`SELECT ${UC}.is_austrac_authorised() AS ok`));
    ok = rows[0]?.ok === true || rows[0]?.ok === 'true';
  } catch (err) {
    console.warn('[restricted] authorisation check failed; treating as not authorised:', (err as Error).message);
  }
  cache.set(actor.email, { ok, at: Date.now() });
  return ok;
}

export async function austracSummary(kit: Kit, req: Request, entityId: string): Promise<Row | null> {
  const rows = statementRows(
    await kit.asUser(req).analytics.query(
      `SELECT entity_id, restricted_record_count, viewer_authorised, latest_report_date, smr_count_24m, large_flow_count, smr_types
       FROM ${UC}.secure_entity_austrac WHERE entity_id = :entity_id`,
      { entity_id: sql.string(entityId) },
    ),
  );
  return rows[0] ?? null;
}

export interface Driver {
  feature: string;
  label: string;
  agency?: string;
  restricted?: boolean;
  value: number | null;
  direction: 'raises' | 'lowers';
  shap: number;
  sentence: string;
}

type RawDriver = Omit<Driver, 'sentence'>;

const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v)}%`;
const money = (v: number) => (Math.abs(v) >= 1e6 ? `$${(v / 1e6).toFixed(1)}m` : `$${Math.round(v / 1000)}k`);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** Plain-English driver sentences (SPEC 8.1), e.g. "ATO debt up 210% in 6 months". */
export function describeDriver(d: RawDriver): string {
  const v = d.value ?? 0;
  switch (d.feature) {
    case 'ato_debt_latest_aud':
      return `ATO debt of ${money(v)}`;
    case 'ato_debt_trend_6m_pct':
      return `ATO debt ${v >= 0 ? 'up' : 'down'} ${Math.abs(Math.round(v))}% in 6 months`;
    case 'lodgement_on_time_pct':
      return `${Math.round(v)}% of ASIC lodgements on time`;
    case 'stp_headcount_trend_pct':
      return `Payroll headcount ${pct(v)} (ATO Single Touch Payroll)`;
    case 'gst_cancelled':
      return v ? 'GST registration cancelled (ABR)' : 'GST registration active (ABR)';
    case 'director_prior_failed_companies':
      return `Directors linked to ${v} prior failed ${plural(v, 'company', 'companies')}`;
    case 'related_collapsed_entities':
      return `${v} related ${plural(v, 'entity has', 'entities have')} entered external administration or been deregistered`;
    case 'banned_director_count':
      return `${v} ${plural(v, 'director', 'directors')} on the ASIC banned register`;
    case 'breach_reports_12m':
      return `${v} breach ${plural(v, 'report', 'reports')} in the last 12 months`;
    case 'afca_complaints_latest':
      return `${v} AFCA complaints last year`;
    case 'afca_complaints_trend_pct':
      return `AFCA complaints ${pct(v)} year on year`;
    case 'apra_flag_count':
      return `${v} APRA prudential ${plural(v, 'flag', 'flags')}`;
    case 'enforcement_alternatives_count':
      return `${v} prior enforceable undertakings or infringement notices`;
    case 'company_age_years':
      return `Company is ${v.toFixed(1)} years old`;
    case 'is_licensee':
      return v ? 'Holds an ASIC licence' : 'Not an ASIC licensee';
    case 'smr_count_24m':
      return `${v} AUSTRAC suspicious matter reports (24 months)`;
    case 'large_flow_smr_count_24m':
      return `${v} large-flow AUSTRAC reports`;
    default:
      return `${d.label}: ${v}`;
  }
}

export function parseDrivers(raw: unknown): RawDriver[] {
  if (!raw) return [];
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as RawDriver[];
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? (raw as RawDriver[]) : [];
}

export function redactDrivers(raw: unknown, authorised: boolean): Driver[] {
  return parseDrivers(raw).map((d) => {
    const restricted = Boolean(d.restricted) || d.feature.includes('smr');
    if (restricted && !authorised) {
      return {
        ...d,
        restricted: true,
        agency: 'AUSTRAC',
        label: 'Restricted agency signal',
        value: null,
        sentence: 'Restricted agency signal (AUSTRAC) — visible to authorised users only',
      };
    }
    return { ...d, restricted, label: d.feature === 'related_collapsed_entities' ? 'Related entities insolvent or deregistered' : d.label, sentence: describeDriver(d) };
  });
}

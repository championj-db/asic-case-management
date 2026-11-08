import type { Actor } from './identity';
import type { Kit } from './types';

export interface AuditEntry {
  action: string;
  objectType: string;
  objectId?: string | null;
  caseId?: string | null;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  aiFlag?: boolean;
  modelVersion?: string | null;
  detail?: unknown;
}

const str = (v: unknown) => (v === undefined || v === null ? null : typeof v === 'string' ? v : JSON.stringify(v));

/** Append-only (enforced by a Postgres trigger). Every write, AI generation, restricted view and export calls this. */
export async function audit(kit: Kit, actor: Actor, e: AuditEntry): Promise<void> {
  await kit.lakebase.query(
    `INSERT INTO case_app.audit_log (actor, acting_as, action, object_type, object_id, case_id, field, old_value, new_value,
       reason, ai_flag, model_version, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      actor.email,
      `${actor.displayName} (${actor.persona})`,
      e.action,
      e.objectType,
      e.objectId ?? null,
      e.caseId ?? null,
      e.field ?? null,
      str(e.oldValue),
      str(e.newValue),
      e.reason ?? null,
      e.aiFlag ?? false,
      e.modelVersion ?? null,
      e.detail === undefined ? null : JSON.stringify(e.detail),
    ],
  );
}

import type { Request } from 'express';
import type { Kit, Row } from './types';
import { txt } from './types';

/**
 * Identity comes from the Databricks Apps proxy (x-forwarded-email); Databricks Apps handles authentication.
 * For demos, a signed-in user may act as one of the synthetic personas (Investigator / Lead / Counsel) via the
 * x-acting-as header. The audit log always records BOTH the real identity and the persona.
 */
export interface Actor {
  email: string;
  userId: string;
  displayName: string;
  persona: 'Investigator' | 'Enforcement Lead' | 'Legal Counsel';
  teamId: string;
}

const DEFAULT_PERSONA = 'u.lead1';
let users: Row[] | null = null;
let usersLoadedAt = 0;

export async function loadUsers(kit: Kit): Promise<Row[]> {
  if (!users || Date.now() - usersLoadedAt > 5 * 60_000) {
    users = (await kit.lakebase.query('SELECT user_id, display_name, persona, team_id FROM gold.silver_user ORDER BY user_id')).rows;
    usersLoadedAt = Date.now();
  }
  return users;
}

export async function actorFor(kit: Kit, req: Request): Promise<Actor> {
  const email = req.header('x-forwarded-email') || process.env.DEV_USER_EMAIL || 'local.developer@localhost';
  const wanted = req.header('x-acting-as') || process.env.DEV_PERSONA || DEFAULT_PERSONA;
  const all = await loadUsers(kit);
  const u = all.find((r) => r.user_id === wanted) ?? all.find((r) => r.user_id === DEFAULT_PERSONA) ?? all[0];
  return {
    email,
    userId: txt(u?.user_id ?? DEFAULT_PERSONA),
    displayName: txt(u?.display_name ?? 'Demo user'),
    persona: (u?.persona as Actor['persona']) ?? 'Enforcement Lead',
    teamId: txt(u?.team_id ?? 'T02'),
  };
}

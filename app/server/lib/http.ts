import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { actorFor, type Actor } from './identity';
import type { Kit } from './types';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Wraps a route: resolves the actor, maps validation/HTTP errors to JSON, never leaks stack traces. */
export function route(kit: Kit, fn: (req: Request, res: Response, actor: Actor) => Promise<unknown>) {
  return async (req: Request, res: Response) => {
    try {
      const actor = await actorFor(kit, req);
      const out = await fn(req, res, actor);
      if (!res.headersSent && out !== undefined) res.json(out);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof ZodError) {
        res.status(400).json({ error: 'Invalid request', issues: err.issues.map((i) => `${i.path.join('.')}: ${i.message}`) });
      } else if (err instanceof HttpError) {
        res.status(err.status).json({ error: err.message });
      } else {
        console.error(`[api] ${req.method} ${req.path}`, err);
        res.status(500).json({ error: 'Something went wrong. The error has been logged.' });
      }
    }
  };
}

export const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));
export const parseJson = <T>(v: unknown, fallback: T): T => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'object') return v as T;
  try {
    return JSON.parse(typeof v === 'string' ? v : JSON.stringify(v)) as T;
  } catch {
    return fallback;
  }
};

/** Leads oversee the whole portfolio; investigators and counsel see their team's cases (SPEC 10). */
export const seesAllTeams = (a: Actor) => a.persona === 'Enforcement Lead';

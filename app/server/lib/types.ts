import type { Application, Request } from 'express';

export type Row = Record<string, unknown>;

/** The slice of the AppKit handle the routes use (kept narrow so routes are testable with fakes). */
export interface Kit {
  lakebase: { query(text: string, params?: unknown[]): Promise<{ rows: Row[] }> };
  server: { extend(fn: (app: Application) => void): void };
  analytics: { query(sql: string, params?: Record<string, unknown>): Promise<unknown> };
  asUser(req: Request): { analytics: { query(sql: string, params?: Record<string, unknown>): Promise<unknown> } };
  aiSearch: { query(alias: string, req: Record<string, unknown>): Promise<{ results: { score: number; data: Row }[] }> };
  files: unknown;
}

/** Rows from an analytics statement result (`{ data: [...] }`). */
export function statementRows(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  if (result && typeof result === 'object' && 'data' in result && Array.isArray((result as { data: unknown }).data)) {
    return (result as { data: Row[] }).data;
  }
  return [];
}

/** Display text for an untyped row value (numbers, strings, booleans, dates; objects as JSON). */
export function txt(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (v instanceof Date) return v.toISOString();
  return JSON.stringify(v);
}

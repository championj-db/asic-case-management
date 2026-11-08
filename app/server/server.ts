import { analytics, createApp, files, lakebase, server } from '@databricks/appkit';
import { aiSearch } from '@databricks/appkit/beta';
import { SCHEMA_SQL } from './db/schema';
import type { Kit } from './lib/types';
import { registerBriefRoutes } from './routes/brief';
import { registerCaseRoutes } from './routes/cases';
import { registerEntityRoutes } from './routes/entities';
import { registerEvidenceRoutes } from './routes/evidence';
import { registerScoringRoutes } from './routes/scoring';
import { registerSourceRoutes } from './routes/sources';
import { registerWorkspaceRoutes } from './routes/workspace';

/**
 * ASIC Intelligent Case Management.
 * - Lakebase: gold tables synced from Unity Catalog (schema `gold`, read-only) + app decisions (schema `case_app`).
 * - Analytics: warehouse queries for portfolio aggregates, and on-behalf-of-user queries for AUSTRAC-restricted views.
 * - AI Search: evidence Vector Search index, always filtered to one case.
 * - Files: evidence uploads to the UC evidence volume (originals never modified).
 */
await createApp({
  plugins: [
    server(),
    analytics({}),
    lakebase(),
    files({ volumes: { files: { policy: files.policy.allowAll(), maxUploadSize: 25_000_000 } } }),
    aiSearch({
      indexes: {
        evidence: {
          columns: ['chunk_id', 'evidence_id', 'case_id', 'doc_type', 'chunk_text'],
          queryType: 'hybrid',
          numResults: 12,
        },
      },
    }),
  ],
  async onPluginsReady(appkit) {
    const kit: Kit = {
      lakebase: appkit.lakebase,
      server: appkit.server,
      analytics: appkit.analytics,
      asUser: (req) => appkit.asUser(req),
      aiSearch: appkit.aiSearch,
      files: appkit.files,
    };
    try {
      // DDL needs table ownership even when nothing changes (CREATE INDEX IF NOT EXISTS checks ownership first), and the
      // schema may be owned by the deploying user rather than the app's service principal. Only run it when tables are missing.
      const expected = [...SCHEMA_SQL.matchAll(/CREATE TABLE IF NOT EXISTS case_app\.(\w+)/g)].map((m) => m[1]);
      const { rows } = await kit.lakebase.query(
        `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'case_app' AND tablename = ANY($1)`,
        [expected],
      );
      if (Number(rows[0]?.n ?? 0) < expected.length) await kit.lakebase.query(SCHEMA_SQL);
      console.log(`[startup] case_app schema ready (${expected.length} tables)`);
    } catch (err) {
      console.error('[startup] case_app schema setup failed:', (err as Error).message);
    }
    registerCaseRoutes(kit);
    registerEvidenceRoutes(kit);
    registerWorkspaceRoutes(kit);
    registerScoringRoutes(kit);
    registerBriefRoutes(kit);
    registerEntityRoutes(kit);
    registerSourceRoutes(kit);
  },
});

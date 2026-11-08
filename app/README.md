# ASIC Intelligent Case Management — Databricks App

AppKit (React + Node/TypeScript) app for the spec in `../../SPEC.md`. The UI reproduces the Genie Design prototype
(`intelligent-case-management.html` v3): its CSS is ported verbatim into `client/src/styles/design.css`, and every
prototype region (`data-od-id`) is a React component with the same structure.

## How it fits together

| Layer | What | Where |
|---|---|---|
| Lakebase `gold` schema | Read-only copies of gold/scoring tables, synced from Unity Catalog | `../config/lakebase_synced_tables.json`, `../scripts/setup_lakebase.sh`, job task `sync_lakebase` |
| Lakebase `case_app` schema | Human and AI decisions: case state, tasks, tags, extraction reviews, scenarios, decisions, intake dispositions, brief versions, annotations, custody access, append-only audit log | `server/db/schema.ts` (created at startup) |
| SQL warehouse (Analytics) | Executive Briefing aggregates (as the app) and AUSTRAC secure views (as the signed-in user) | `server/routes/cases.ts`, `server/lib/restricted.ts` |
| Vector Search (AI Search) | Semantic evidence search and "ask the evidence", always filtered to one case | `server/routes/evidence.ts` |
| Foundation Model API | Case brief (streamed, cited), triage suggestions, evidence Q&A | `server/lib/llm.ts`, `server/routes/brief.ts` |
| UC Volume (Files) | Evidence uploads; SHA-256 taken on receipt | `server/routes/evidence.ts` |
| PPS engine | Exact TS port of SQL `pps_compute`; drives the live what-if, sensitivity and break-even | `shared/pps.ts`, parity test `shared/pps.test.ts` |

Identity comes from Databricks Apps (`x-forwarded-email`). For demos a user can act as a synthetic persona
(Investigator / Enforcement Lead / Counsel) from the user menu; the audit log records both.

## Run locally

```bash
npm install
npm run dev            # http://localhost:8000 (uses DATABRICKS_CONFIG_PROFILE in .env)
```

## Verify

```bash
npm run typecheck && npm run lint && npm run lint:ast-grep
npm run fixture:pps    # refresh the parity fixture after a scoring run
npm test               # PPS parity with batch scoring + engine behaviour
databricks apps validate --profile au-pubsec
```

## Deploy

```bash
databricks bundle deploy --profile au-pubsec          # from this folder (the app bundle)
databricks bundle run app --profile au-pubsec
databricks apps get asic-case-mgmt --profile au-pubsec
```

After the first deploy, grant the app's service principal access to the Lakebase schemas (see the root README).

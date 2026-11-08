/**
 * App-owned Postgres schema `case_app` (SPEC 9). Holds only human and AI decisions; it overlays the read-only
 * gold tables that Lakebase syncs from Unity Catalog into schema `gold`. Idempotent: safe to run at every start.
 */
export const SCHEMA_SQL = `
CREATE SCHEMA IF NOT EXISTS case_app;

-- Stage / priority / assignment overrides, and cases opened from the Intake Queue
CREATE TABLE IF NOT EXISTS case_app.case_state (
  case_id      TEXT PRIMARY KEY,
  case_number  TEXT,
  title        TEXT,
  case_type    TEXT,
  stage        TEXT,
  priority     TEXT,
  team_id      TEXT,
  lead_user    TEXT,
  respondent_entity_id TEXT,
  summary      TEXT,
  summary_ai   BOOLEAN NOT NULL DEFAULT false,
  created_from_intake TEXT,
  updated_by   TEXT NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_app.task (
  task_id      BIGSERIAL PRIMARY KEY,
  case_id      TEXT NOT NULL,
  title        TEXT NOT NULL,
  assignee     TEXT,
  due_date     DATE,
  status       TEXT NOT NULL DEFAULT 'Open',
  link_type    TEXT,
  link_id      TEXT,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS task_case_idx ON case_app.task (case_id);

CREATE TABLE IF NOT EXISTS case_app.evidence_tag (
  evidence_id  TEXT NOT NULL,
  case_id      TEXT NOT NULL,
  tag          TEXT NOT NULL,
  category     TEXT NOT NULL,          -- hot | privileged | element
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (evidence_id, tag)
);

CREATE TABLE IF NOT EXISTS case_app.note (
  note_id      BIGSERIAL PRIMARY KEY,
  case_id      TEXT NOT NULL,
  object_type  TEXT NOT NULL,
  object_id    TEXT NOT NULL,
  body         TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Human review of AI suggestions (SPEC 8.4): only confirmed items reach the Timeline and Network
CREATE TABLE IF NOT EXISTS case_app.extraction_review (
  extraction_id TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('confirmed', 'rejected')),
  reviewer     TEXT NOT NULL,
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS case_app.event_review (
  event_id     TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('confirmed', 'rejected')),
  reviewer     TEXT NOT NULL,
  reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- User-saved what-if scenarios, stamped with every version needed to reproduce them (SPEC 8.3)
CREATE TABLE IF NOT EXISTS case_app.scenario (
  scenario_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id      TEXT NOT NULL,
  name         TEXT NOT NULL,
  preset_id    TEXT,
  inputs_json  JSONB NOT NULL,
  outputs_json JSONB NOT NULL,
  weights_json JSONB NOT NULL,
  model_version   TEXT,
  weights_version TEXT,
  params_version  TEXT,
  author       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS scenario_case_idx ON case_app.scenario (case_id);

-- The prosecution decision and its rationale (a person decides; the score is a decision aid)
CREATE TABLE IF NOT EXISTS case_app.decision (
  decision_id  BIGSERIAL PRIMARY KEY,
  case_id      TEXT NOT NULL,
  decision     TEXT NOT NULL,
  rationale    TEXT NOT NULL,
  scenario_id  UUID,
  pps_total    NUMERIC,
  pps_band     TEXT,
  params_version TEXT,
  decided_by   TEXT NOT NULL,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Four-eyes approval of prosecution decisions: a different Enforcement Lead approves or returns each proposed decision
CREATE TABLE IF NOT EXISTS case_app.decision_approval (
  approval_id  BIGSERIAL PRIMARY KEY,
  decision_id  BIGINT NOT NULL,
  case_id      TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('Approved', 'Returned')),
  note         TEXT,
  approver     TEXT NOT NULL,
  acted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_app.intake_disposition (
  intake_id    TEXT PRIMARY KEY,
  disposition  TEXT NOT NULL CHECK (disposition IN ('Open case', 'Link to case', 'No further action')),
  reason       TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  case_id      TEXT,
  ai_suggestion JSONB,
  decided_by   TEXT NOT NULL,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_app.resolution_decision (
  review_id    TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK (decision IN ('Merge', 'Not the same')),
  reason       TEXT,
  decided_by   TEXT NOT NULL,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Case brief (SPEC 8.6): versioned; each section carries Draft (AI) / Edited / Reviewed status
CREATE TABLE IF NOT EXISTS case_app.brief_version (
  case_id      TEXT NOT NULL,
  version      INT NOT NULL,
  sections     JSONB NOT NULL,
  ai_model     TEXT,
  generated    BOOLEAN NOT NULL,
  author       TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, version)
);

-- Case-local network annotations: never change source data (SPEC 7 S4.4)
CREATE TABLE IF NOT EXISTS case_app.network_annotation (
  annotation_id BIGSERIAL PRIMARY KEY,
  case_id      TEXT NOT NULL,
  entity_id    TEXT,
  label        TEXT NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_app.saved_view (
  view_id      BIGSERIAL PRIMARY KEY,
  owner        TEXT NOT NULL,
  page         TEXT NOT NULL,
  name         TEXT NOT NULL,
  config       JSONB NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Proposed scoring-weight changes (Admin, S6). Reason required; applied by the scoring job, not the app.
CREATE TABLE IF NOT EXISTS case_app.weights_proposal (
  proposal_id  BIGSERIAL PRIMARY KEY,
  weights      JSONB NOT NULL,
  reason       TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  proposed_by  TEXT NOT NULL,
  proposed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT NOT NULL DEFAULT 'Proposed'
);

-- Evidence views and exports (chain of custody, SPEC 10)
CREATE TABLE IF NOT EXISTS case_app.custody_access (
  access_id    BIGSERIAL PRIMARY KEY,
  evidence_id  TEXT NOT NULL,
  case_id      TEXT,
  action       TEXT NOT NULL,          -- viewed | exported | uploaded
  actor        TEXT NOT NULL,
  sha256       TEXT,
  at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS custody_evidence_idx ON case_app.custody_access (evidence_id);

-- Evidence uploaded through the app (originals stored unchanged in the UC evidence volume)
CREATE TABLE IF NOT EXISTS case_app.uploaded_evidence (
  evidence_id  TEXT PRIMARY KEY,
  case_id      TEXT NOT NULL,
  filename     TEXT NOT NULL,
  volume_path  TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  bytes        BIGINT NOT NULL,
  custodian    TEXT,
  uploaded_by  TEXT NOT NULL,
  uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Append-only audit log (SPEC 8.7, 10). UPDATE and DELETE are rejected by trigger.
CREATE TABLE IF NOT EXISTS case_app.audit_log (
  audit_id     BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor        TEXT NOT NULL,          -- signed-in Databricks identity
  acting_as    TEXT,                   -- demo persona, when different from the identity
  action       TEXT NOT NULL,
  object_type  TEXT NOT NULL,
  object_id    TEXT,
  case_id      TEXT,
  field        TEXT,
  old_value    TEXT,
  new_value    TEXT,
  reason       TEXT,
  ai_flag      BOOLEAN NOT NULL DEFAULT false,
  model_version TEXT,
  detail       JSONB
);
CREATE INDEX IF NOT EXISTS audit_case_idx ON case_app.audit_log (case_id, at DESC);

-- Created only when missing: replacing a function or trigger needs ownership, and the schema may be owned by a
-- different role (the deploying user) than the one running the app (its service principal).
DO $$
BEGIN
  IF to_regprocedure('case_app.audit_log_immutable()') IS NULL THEN
    CREATE FUNCTION case_app.audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $f$
    BEGIN
      RAISE EXCEPTION 'audit_log is append-only (% rejected)', TG_OP;
    END $f$;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_no_change' AND tgrelid = 'case_app.audit_log'::regclass) THEN
    CREATE TRIGGER audit_log_no_change BEFORE UPDATE OR DELETE ON case_app.audit_log
      FOR EACH ROW EXECUTE FUNCTION case_app.audit_log_immutable();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'audit_log_no_truncate' AND tgrelid = 'case_app.audit_log'::regclass) THEN
    CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON case_app.audit_log
      FOR EACH STATEMENT EXECUTE FUNCTION case_app.audit_log_immutable();
  END IF;
END $$;
`;

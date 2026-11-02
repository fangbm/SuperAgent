-- v0.5 additive migration from v0.4 reference DDL; database backup required.
-- The migration is idempotent for a newly installed v0.4 baseline and is meant to run ONCE.
-- Source event and CloudEvent identity schemes are unchanged.
PRAGMA foreign_keys = ON;
BEGIN;
CREATE TABLE triage_extractions (
  triage_id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  pipeline_version TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  result_schema_version TEXT NOT NULL CHECK(result_schema_version='2.0'),
  result_json TEXT NOT NULL,
  supersedes_triage_id TEXT REFERENCES triage_extractions(triage_id),
  created_at TEXT NOT NULL,
  UNIQUE(batch_id,pipeline_version,revision)
);
CREATE TABLE feedback_items (
  feedback_item_id TEXT PRIMARY KEY,
  triage_id TEXT NOT NULL REFERENCES triage_extractions(triage_id),
  extraction_index INTEGER NOT NULL CHECK(extraction_index >= 0),
  kind TEXT NOT NULL CHECK(kind IN ('defect','suggestion')),
  category TEXT NOT NULL CHECK(
   (kind='defect' AND category IN ('bug','performance','usability')) OR
   (kind='suggestion' AND category IN ('feature_request','improvement','performance','usability'))
  ),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  confidence REAL CHECK(confidence BETWEEN 0 AND 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL,
  UNIQUE(triage_id,extraction_index)
);
CREATE TABLE feedback_item_evidence (
  feedback_item_id TEXT NOT NULL REFERENCES feedback_items(feedback_item_id),
  evidence_index INTEGER NOT NULL CHECK(evidence_index >= 0),
  event_id TEXT NOT NULL REFERENCES source_events(event_id),
  role TEXT NOT NULL CHECK(role IN ('primary','context','corroboration')),
  quote TEXT,
  span_start INTEGER,
  span_end INTEGER,
  PRIMARY KEY(feedback_item_id,evidence_index),
  CHECK((span_start IS NULL AND span_end IS NULL) OR (span_start >= 0 AND span_end >= span_start))
);
CREATE INDEX idx_feedback_item_evidence_event ON feedback_item_evidence(event_id);
CREATE TABLE suggestions (
  suggestion_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate' CHECK(status IN (
    'candidate','reviewing','accepted','planned','in_progress',
    'implemented','verified','declined','archived'
  )),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE suggestion_feedback_items (
  suggestion_id TEXT NOT NULL REFERENCES suggestions(suggestion_id),
  feedback_item_id TEXT NOT NULL REFERENCES feedback_items(feedback_item_id),
  relation TEXT NOT NULL CHECK(relation IN ('same_request','related')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(suggestion_id,feedback_item_id)
);
CREATE TABLE suggestion_status_history (
  action_id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(suggestion_id),
  old_status TEXT NOT NULL,
  new_status TEXT NOT NULL,
  actor_ref TEXT NOT NULL,
  action_source TEXT NOT NULL,
  interaction_id TEXT NOT NULL,
  rationale TEXT,
  occurred_at TEXT NOT NULL,
  UNIQUE(action_source,interaction_id)
);
-- Unified external link registry (GitHub Issue numbers may represent either defects or suggestions).
CREATE TABLE external_work_links (
  work_kind TEXT NOT NULL CHECK(work_kind IN ('defect','suggestion')),
  work_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  repository TEXT NOT NULL,
  external_issue_id TEXT NOT NULL,
  created_by_operation_id TEXT NOT NULL REFERENCES external_operations(operation_id),
  PRIMARY KEY(work_kind,work_id,provider,repository),
  UNIQUE(provider,repository,external_issue_id)
);
-- Copy legacy v0.4 bug links into unified mapping. On conflict fail loudly.
INSERT INTO external_work_links(work_kind,work_id,provider,repository,external_issue_id,created_by_operation_id)
 SELECT 'defect',internal_issue_id,provider,repository,external_issue_id,created_by_operation_id
 FROM external_issue_links;
COMMIT;
-- After migration, external_work_links is canonical; treat external_issue_links as legacy read-only.
-- Reanalyses must deactivate superseded item rows in the SAME transaction that publishes the new projection.
-- Host must validate evidence quote and text spans against the stored event content.

-- v0.4 NEW INSTALL BASELINE (not an in-place migration of deployed v0.3 data).
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS source_events (
  event_id TEXT PRIMARY KEY,                      -- Host internal UUID/ULID-like opaque id
  source_uri TEXT NOT NULL,                    -- CloudEvents source
  external_event_id TEXT NOT NULL,             -- CloudEvents id
  project_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE(source_uri, external_event_id)
);
CREATE TABLE IF NOT EXISTS event_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL REFERENCES source_events(event_id),
  handler_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  UNIQUE(event_id, handler_version)
);
CREATE TABLE IF NOT EXISTS sync_cursors (
  source_id TEXT PRIMARY KEY,
  cursor_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS external_operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('github.issue.create','github.issue.update','github.comment.create','qq.c2c.send')),
  target_ref TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  correlation_marker TEXT,
  request_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','in_flight','unknown','reconciling','succeeded','safe_retry','blocked','manual_review')),
  attempt INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_until TEXT,
  provider_object_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ext_ops_recover ON external_operations(state,updated_at);
-- Claim via one atomic UPDATE ... WHERE state IN ('prepared','safe_retry')
-- and compare returned affected row count. Expired in_flight => unknown/reconcile, NEVER blind retry.
CREATE TABLE IF NOT EXISTS external_operation_attempts (
  attempt_id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL REFERENCES external_operations(operation_id),
  attempt_number INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  transport_outcome TEXT,
  response_code TEXT,
  UNIQUE(operation_id,attempt_number)
);
CREATE TABLE IF NOT EXISTS external_issue_links (
  internal_issue_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  repository TEXT NOT NULL,
  external_issue_id TEXT NOT NULL,
  created_by_operation_id TEXT NOT NULL REFERENCES external_operations(operation_id),
  PRIMARY KEY (internal_issue_id,provider,repository),
  UNIQUE(provider,repository,external_issue_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
  delivery_id TEXT PRIMARY KEY,
  report_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES external_operations(operation_id),
  status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','rejected','blocked','unknown','manual_review')),
  provider_message_id TEXT,
  UNIQUE(report_id,channel,recipient_ref)
);

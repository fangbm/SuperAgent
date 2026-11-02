-- v0.7 additive migration: P0 incidents and alert history; run after 001/002.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS p0_incidents (
  incident_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('active','resolved')),
  first_detected_at TEXT NOT NULL,
  last_changed_at TEXT NOT NULL,
  resolved_at TEXT
);
-- One currently active P0 incident per internal issue; recovery after fix can open a new incident.
CREATE UNIQUE INDEX IF NOT EXISTS ux_active_p0_issue
  ON p0_incidents(project_id, issue_id) WHERE state='active';

CREATE TABLE IF NOT EXISTS p0_alerts (
  alert_id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES p0_incidents(incident_id),
  alert_generation INTEGER NOT NULL CHECK(alert_generation>=1),
  issue_id TEXT NOT NULL,
  title TEXT NOT NULL,
  markdown TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK(json_valid(evidence_json)),
  policy_version TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(incident_id, alert_generation)
);

CREATE TABLE IF NOT EXISTS p0_alert_deliveries (
  delivery_id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL REFERENCES p0_alerts(alert_id),
  channel TEXT NOT NULL CHECK(channel='qq-c2c'),
  recipient_ref TEXT NOT NULL,
  operation_id TEXT NOT NULL UNIQUE REFERENCES external_operations(operation_id),
  status TEXT NOT NULL CHECK(status IN ('pending','sending','accepted','rejected','blocked','unknown','manual_review')),
  provider_message_id TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(alert_id,channel,recipient_ref)
);
CREATE INDEX IF NOT EXISTS idx_p0_alerts_detected ON p0_alerts(detected_at);
-- Ingest, urgency classification, and issue evidence persistence MUST commit
-- before enqueuing P0 alert work via durable outbox/jobs. See docs/NOTIFICATION-POLICY.md.
-- Append-only alert rows; amendments should be audit events, not updates to old alert evidence.

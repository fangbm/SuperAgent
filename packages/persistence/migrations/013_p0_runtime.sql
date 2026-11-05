-- Runtime state supplements the frozen, append-only P0 alert history.
CREATE TABLE p0_assessments (
  assessment_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  issue_id TEXT NOT NULL,
  work_version INTEGER NOT NULL,
  evidence_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  model_id TEXT,
  error_code TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_p0_assessments_issue ON p0_assessments(project_id,issue_id);
CREATE TABLE p0_incident_impacts (
  incident_id TEXT NOT NULL REFERENCES p0_incidents(incident_id),
  impact TEXT NOT NULL,
  PRIMARY KEY(incident_id,impact)
);
CREATE TABLE p0_delivery_requests (
  delivery_id TEXT PRIMARY KEY REFERENCES p0_alert_deliveries(delivery_id),
  plugin_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json))
);

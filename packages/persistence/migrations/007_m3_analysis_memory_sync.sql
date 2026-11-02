CREATE TABLE analysis_requests (
  triage_id TEXT PRIMARY KEY NOT NULL, batch_id TEXT NOT NULL REFERENCES feedback_batches(batch_id),
  pipeline_version TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL,
  UNIQUE(batch_id,revision)
);
CREATE TABLE agent_runs (
  run_id TEXT PRIMARY KEY NOT NULL, job_id TEXT NOT NULL REFERENCES jobs(job_id), project_id TEXT NOT NULL,
  worker_id TEXT NOT NULL, triage_id TEXT NOT NULL REFERENCES analysis_requests(triage_id),
  attempt INTEGER NOT NULL, status TEXT NOT NULL, queued_at TEXT NOT NULL, started_at TEXT NOT NULL,
  ended_at TEXT, input_event_ids_json TEXT NOT NULL, model_id TEXT NOT NULL, error_code TEXT,
  UNIQUE(job_id,attempt)
);
CREATE TABLE model_calls (
  triage_id TEXT NOT NULL REFERENCES analysis_requests(triage_id), request_hash TEXT NOT NULL,
  call_index INTEGER NOT NULL, run_id TEXT NOT NULL REFERENCES agent_runs(run_id), schema_id TEXT NOT NULL,
  model_id TEXT NOT NULL, status TEXT NOT NULL, result_json TEXT, usage_json TEXT,
  error_code TEXT, started_at TEXT NOT NULL, ended_at TEXT,
  PRIMARY KEY(triage_id,request_hash,call_index)
);
CREATE TABLE issues (
  issue_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(project_id),
  title TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('candidate','open','investigating','fixed','verified','dismissed','merged')),
  version INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE work_metadata (
  work_kind TEXT NOT NULL CHECK(work_kind IN ('defect','suggestion')), work_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id), fingerprint TEXT NOT NULL, content_json TEXT NOT NULL,
  review_required INTEGER NOT NULL CHECK(review_required IN (0,1)), priority INTEGER NOT NULL DEFAULT 0,
  merged_into TEXT, remote_state TEXT, remote_state_reason TEXT,
  PRIMARY KEY(work_kind,work_id), UNIQUE(project_id,work_kind,fingerprint,work_id)
);
CREATE TABLE work_identity_claims (
  project_id TEXT NOT NULL, work_kind TEXT NOT NULL, fingerprint TEXT NOT NULL, work_id TEXT NOT NULL,
  PRIMARY KEY(project_id,work_kind,fingerprint)
);
CREATE TABLE agent_proposals (
  proposal_id TEXT PRIMARY KEY NOT NULL, run_id TEXT NOT NULL REFERENCES agent_runs(run_id),
  project_id TEXT NOT NULL, kind TEXT NOT NULL, change_json TEXT NOT NULL, evidence_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE work_feedback_links (
  work_kind TEXT NOT NULL, work_id TEXT NOT NULL, feedback_item_id TEXT NOT NULL REFERENCES feedback_items(feedback_item_id),
  PRIMARY KEY(work_kind,work_id,feedback_item_id),
  FOREIGN KEY(work_kind,work_id) REFERENCES work_metadata(work_kind,work_id)
);
CREATE TABLE feedback_item_metadata (
  feedback_item_id TEXT PRIMARY KEY REFERENCES feedback_items(feedback_item_id),
  project_id TEXT NOT NULL, fingerprint TEXT NOT NULL, item_json TEXT NOT NULL, model_id TEXT NOT NULL
);
CREATE TABLE feedback_primary_objects (
  feedback_item_id TEXT NOT NULL REFERENCES feedback_items(feedback_item_id), source_id TEXT NOT NULL,
  external_id TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES source_events(event_id),
  PRIMARY KEY(feedback_item_id,event_id)
);
CREATE INDEX primary_objects_source_object ON feedback_primary_objects(source_id,external_id);
CREATE TABLE work_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, work_kind TEXT NOT NULL, work_id TEXT NOT NULL,
  action TEXT NOT NULL, actor_ref TEXT NOT NULL, details_json TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE work_match_decisions (
  triage_id TEXT NOT NULL REFERENCES analysis_requests(triage_id), extraction_index INTEGER NOT NULL,
  candidate_kind TEXT NOT NULL, candidate_id TEXT NOT NULL, relationship TEXT NOT NULL,
  decision_json TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(triage_id,extraction_index,candidate_kind,candidate_id)
);
CREATE TABLE manual_work_overrides (
  project_id TEXT NOT NULL, object_keys_json TEXT NOT NULL, fingerprint TEXT NOT NULL,
  work_kind TEXT NOT NULL, work_id TEXT NOT NULL, actor_ref TEXT NOT NULL, reason TEXT NOT NULL,
  PRIMARY KEY(project_id,object_keys_json,fingerprint)
);
CREATE TABLE manual_work_commands (request_id TEXT PRIMARY KEY NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE VIRTUAL TABLE work_fts USING fts5(project_id UNINDEXED,work_kind UNINDEXED,work_id UNINDEXED,tokens);
CREATE TABLE work_embeddings (
  project_id TEXT NOT NULL, work_kind TEXT NOT NULL, work_id TEXT NOT NULL, model_id TEXT NOT NULL,
  text_hash TEXT NOT NULL, vector_json TEXT NOT NULL CHECK(json_valid(vector_json)),
  PRIMARY KEY(project_id,work_kind,work_id,model_id)
);
CREATE TABLE embedding_outbox (
  project_id TEXT NOT NULL, work_kind TEXT NOT NULL, work_id TEXT NOT NULL, text_hash TEXT NOT NULL,
  text TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY(project_id,work_kind,work_id)
);
CREATE TABLE github_sync_outbox (
  project_id TEXT NOT NULL, work_kind TEXT NOT NULL, work_id TEXT NOT NULL, repository TEXT NOT NULL,
  desired_version INTEGER NOT NULL, synced_version INTEGER NOT NULL DEFAULT 0,
  available_at TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
  PRIMARY KEY(work_kind,work_id,repository)
);
CREATE TABLE external_operation_payloads (
  operation_id TEXT PRIMARY KEY REFERENCES external_operations(operation_id), project_id TEXT NOT NULL,
  work_kind TEXT NOT NULL, work_id TEXT NOT NULL, repository TEXT NOT NULL, work_version INTEGER NOT NULL,
  payload_json TEXT NOT NULL, reconcile_attempt INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL
);
CREATE TABLE github_stats_comments (
  work_kind TEXT NOT NULL, work_id TEXT NOT NULL, repository TEXT NOT NULL, comment_id TEXT NOT NULL,
  body_hash TEXT NOT NULL, author_id TEXT NOT NULL, PRIMARY KEY(work_kind,work_id,repository)
);
CREATE TABLE github_webhook_receipts (delivery_id TEXT PRIMARY KEY NOT NULL, repository TEXT NOT NULL, payload_hash TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE INDEX sync_operations_due ON external_operation_payloads(next_attempt_at);
CREATE INDEX work_links_item ON work_feedback_links(feedback_item_id);

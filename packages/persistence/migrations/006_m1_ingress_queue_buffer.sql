CREATE TABLE projects (project_id TEXT PRIMARY KEY NOT NULL);
CREATE TABLE sources (
  source_id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(project_id),
  source_uri TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL,
  coverage TEXT NOT NULL DEFAULT 'unknown' CHECK(coverage IN ('full','partial','unknown','unavailable')),
  health_reason TEXT,
  health_checked_at TEXT
);
CREATE TRIGGER source_event_binding BEFORE INSERT ON source_events BEGIN
  SELECT RAISE(ABORT,'SOURCE_BINDING_MISMATCH') WHERE NOT EXISTS (
    SELECT 1 FROM sources s WHERE s.source_id=NEW.source_id AND s.project_id=NEW.project_id AND s.source_uri=NEW.source_uri
  );
END;
CREATE TRIGGER source_event_immutable_update BEFORE UPDATE ON source_events BEGIN SELECT RAISE(ABORT,'EVENT_IMMUTABLE'); END;
CREATE TRIGGER source_event_no_replace BEFORE INSERT ON source_events BEGIN
  SELECT RAISE(ABORT,'EVENT_ALREADY_EXISTS') WHERE EXISTS (
    SELECT 1 FROM source_events WHERE event_id=NEW.event_id OR (source_uri=NEW.source_uri AND external_event_id=NEW.external_event_id)
  );
END;
CREATE INDEX source_events_project_received ON source_events(project_id,received_at);
CREATE INDEX event_outbox_pending ON event_outbox(status,id);
CREATE TABLE source_objects (
  source_id TEXT NOT NULL REFERENCES sources(source_id), external_id TEXT NOT NULL,
  object_kind TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES source_events(event_id),
  revision TEXT NOT NULL, occurred_at TEXT NOT NULL, action_rank INTEGER NOT NULL,
  conversation_key TEXT NOT NULL, deleted INTEGER NOT NULL CHECK(deleted IN (0,1)),
  PRIMARY KEY(source_id,external_id)
);
CREATE TABLE source_reconciliations (
  event_id TEXT PRIMARY KEY REFERENCES source_events(event_id),
  current_event_id TEXT NOT NULL REFERENCES source_events(event_id),
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
);
CREATE TABLE source_event_routes (
  event_id TEXT PRIMARY KEY REFERENCES source_events(event_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id), conversation_key TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE INDEX source_event_routes_conversation ON source_event_routes(source_id,conversation_key,received_at,event_id);
CREATE TABLE jobs (
  job_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(project_id),
  kind TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  idempotency_key TEXT NOT NULL, lane TEXT NOT NULL,
  priority INTEGER NOT NULL, created_at TEXT NOT NULL, available_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','leased','running','retry_wait','completed','dead_letter','cancelled')),
  attempt INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL CHECK(max_attempts>0),
  lease_owner TEXT, lease_token TEXT, lease_until TEXT,
  last_error_code TEXT, completed_at TEXT,
  UNIQUE(project_id,idempotency_key)
);
CREATE INDEX jobs_claim ON jobs(lane,status,priority DESC,created_at);
CREATE INDEX jobs_expired ON jobs(status,lease_until);
CREATE TABLE admission_decisions (
  event_id TEXT NOT NULL REFERENCES source_events(event_id), policy_version TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('candidate','urgent_candidate','needs_context','archive_only','audit_sample')),
  rationale_code TEXT NOT NULL, decided_at TEXT NOT NULL, PRIMARY KEY(event_id,policy_version)
);
CREATE TABLE buffer_policies (policy_version TEXT PRIMARY KEY NOT NULL, policy_json TEXT NOT NULL);
CREATE TABLE conversation_segments (
  segment_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(project_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id), segment_key TEXT NOT NULL,
  policy_version TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
  state TEXT NOT NULL CHECK(state IN ('open','flushed')),
  opened_at TEXT NOT NULL, last_related_at TEXT NOT NULL, quiet_due_at TEXT NOT NULL,
  max_due_at TEXT NOT NULL, urgent_due_at TEXT, replay INTEGER NOT NULL DEFAULT 0,
  candidate_count INTEGER NOT NULL DEFAULT 0, context_omitted INTEGER NOT NULL DEFAULT 0,
  policy_json TEXT NOT NULL CHECK(json_valid(policy_json)),
  UNIQUE(source_id,segment_key,policy_version,revision)
);
CREATE UNIQUE INDEX one_open_segment ON conversation_segments(source_id,segment_key,policy_version) WHERE state='open';
CREATE INDEX segments_due ON conversation_segments(state,max_due_at,quiet_due_at);
CREATE TABLE segment_events (
  segment_id TEXT NOT NULL REFERENCES conversation_segments(segment_id),
  event_id TEXT NOT NULL REFERENCES source_events(event_id), role TEXT NOT NULL CHECK(role IN ('candidate','context')),
  PRIMARY KEY(segment_id,event_id)
);
CREATE INDEX segment_events_event_role ON segment_events(event_id,role);
CREATE TABLE feedback_batches (
  batch_id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL REFERENCES projects(project_id),
  source_id TEXT NOT NULL REFERENCES sources(source_id), policy_version TEXT NOT NULL,
  created_at TEXT NOT NULL, reason TEXT NOT NULL, batch_json TEXT NOT NULL CHECK(json_valid(batch_json)),
  context_omitted INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE batch_segments (
  batch_id TEXT NOT NULL REFERENCES feedback_batches(batch_id),
  segment_id TEXT NOT NULL UNIQUE REFERENCES conversation_segments(segment_id),
  PRIMARY KEY(batch_id,segment_id)
);
CREATE TABLE batch_events (
  batch_id TEXT NOT NULL REFERENCES feedback_batches(batch_id),
  event_id TEXT NOT NULL REFERENCES source_events(event_id), role TEXT NOT NULL CHECK(role IN ('candidate','context')),
  PRIMARY KEY(batch_id,event_id)
);
CREATE UNIQUE INDEX candidate_once ON batch_events(event_id) WHERE role='candidate';
CREATE TABLE buffer_reprocess_requests (
  request_id TEXT PRIMARY KEY NOT NULL, event_id TEXT NOT NULL REFERENCES source_events(event_id),
  policy_version TEXT NOT NULL, actor_ref TEXT NOT NULL, reason TEXT NOT NULL, requested_at TEXT NOT NULL
);

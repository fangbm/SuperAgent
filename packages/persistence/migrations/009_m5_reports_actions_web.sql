-- M5 is additive to frozen contracts and report snapshot invariants.
CREATE TABLE report_work_evidence (
  report_id TEXT NOT NULL, revision INTEGER NOT NULL, work_kind TEXT NOT NULL,
  work_id TEXT NOT NULL, ordinal INTEGER NOT NULL, event_id TEXT NOT NULL REFERENCES source_events(event_id),
  PRIMARY KEY(report_id,revision,work_kind,work_id,ordinal),
  UNIQUE(report_id,revision,work_kind,work_id,event_id),
  FOREIGN KEY(report_id,revision) REFERENCES report_revisions(report_id,revision)
);
CREATE TRIGGER report_evidence_insert_guard BEFORE INSERT ON report_work_evidence BEGIN
  SELECT RAISE(ABORT,'REPORT_ALREADY_SEALED') WHERE EXISTS(SELECT 1 FROM report_revision_seals WHERE report_id=NEW.report_id AND revision=NEW.revision);
  SELECT RAISE(ABORT,'REPORT_EVIDENCE_EXISTS') WHERE EXISTS(SELECT 1 FROM report_work_evidence WHERE report_id=NEW.report_id AND revision=NEW.revision AND work_kind=NEW.work_kind AND work_id=NEW.work_id AND (ordinal=NEW.ordinal OR event_id=NEW.event_id));
END;
CREATE TRIGGER report_evidence_no_update BEFORE UPDATE ON report_work_evidence BEGIN SELECT RAISE(ABORT,'REPORT_EVIDENCE_IMMUTABLE'); END;
CREATE TRIGGER report_evidence_no_delete BEFORE DELETE ON report_work_evidence BEGIN SELECT RAISE(ABORT,'REPORT_EVIDENCE_IMMUTABLE'); END;
CREATE TABLE report_schedules (project_id TEXT PRIMARY KEY REFERENCES projects(project_id),next_end TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE report_delivery_plans (
  plan_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, report_id TEXT NOT NULL, revision INTEGER NOT NULL,
  recipient_ref TEXT NOT NULL, stage INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'pending', operation_id TEXT,
  created_at TEXT NOT NULL, UNIQUE(report_id,revision,recipient_ref),
  FOREIGN KEY(report_id,revision) REFERENCES report_revision_seals(report_id,revision)
);
CREATE TABLE report_delivery_requests (delivery_id TEXT PRIMARY KEY,plan_id TEXT NOT NULL REFERENCES report_delivery_plans(plan_id),stage INTEGER NOT NULL,options_json TEXT NOT NULL,UNIQUE(plan_id,stage));
CREATE TABLE operator_accounts (actor_ref TEXT PRIMARY KEY,access_hash TEXT NOT NULL UNIQUE,role TEXT NOT NULL CHECK(role IN ('reader','developer')),projects_json TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE operator_sessions (session_hash TEXT PRIMARY KEY,actor_ref TEXT NOT NULL REFERENCES operator_accounts(actor_ref),csrf_hash TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE operator_tokens (
  token_hash TEXT PRIMARY KEY,actor_ref TEXT NOT NULL,project_id TEXT NOT NULL,purpose TEXT NOT NULL,
  payload_json TEXT NOT NULL,expires_at TEXT NOT NULL,consumed_at TEXT
);
CREATE TABLE operator_commands (
  command_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,actor_ref TEXT NOT NULL,source TEXT NOT NULL,
  interaction_id TEXT NOT NULL,payload_hash TEXT NOT NULL,request_json TEXT NOT NULL,result_json TEXT,
  state TEXT NOT NULL CHECK(state IN ('pending_remote','succeeded','manual_review')),created_at TEXT NOT NULL,
  UNIQUE(source,interaction_id)
);
CREATE TABLE github_action_operations (
  operation_id TEXT PRIMARY KEY REFERENCES external_operations(operation_id),command_id TEXT NOT NULL UNIQUE REFERENCES operator_commands(command_id),
  project_id TEXT NOT NULL,issue_id TEXT NOT NULL,repository TEXT NOT NULL,issue_number TEXT NOT NULL,
  expected_version INTEGER NOT NULL,action TEXT NOT NULL,desired_state TEXT NOT NULL,desired_reason TEXT,
  next_attempt_at TEXT NOT NULL
);
CREATE TABLE operator_inbox (
  inbox_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,actor_ref TEXT NOT NULL,interaction_id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,request_json TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',response_json TEXT,
  created_at TEXT NOT NULL,lease_token TEXT,lease_until TEXT
);
CREATE TABLE operator_reply_plans (
  delivery_id TEXT PRIMARY KEY,inbox_id TEXT NOT NULL UNIQUE REFERENCES operator_inbox(inbox_id),project_id TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,report_id TEXT,revision INTEGER,request_json TEXT NOT NULL,
  message_options_json TEXT NOT NULL,operation_id TEXT,
  FOREIGN KEY(report_id,revision) REFERENCES report_revision_seals(report_id,revision)
);
-- Widen the Host-private purpose enum without editing migration 008 or SDK.
ALTER TABLE plugin_delivery_requests RENAME TO _m5_old_delivery_requests;
CREATE TABLE plugin_delivery_requests (
  operation_id TEXT PRIMARY KEY REFERENCES external_operations(operation_id),plugin_id TEXT NOT NULL,
  project_id TEXT NOT NULL,recipient_ref TEXT NOT NULL,purpose TEXT NOT NULL CHECK(purpose IN ('report','acceptance','interaction')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),next_attempt_at TEXT NOT NULL
);
INSERT INTO plugin_delivery_requests SELECT * FROM _m5_old_delivery_requests;
DROP TABLE _m5_old_delivery_requests;
CREATE INDEX idx_plugin_delivery_pending ON plugin_delivery_requests(plugin_id,project_id,recipient_ref,next_attempt_at);

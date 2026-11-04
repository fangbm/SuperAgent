CREATE TABLE qq_feedback_sources(source_id TEXT PRIMARY KEY REFERENCES sources(source_id),project_id TEXT NOT NULL,config_json TEXT NOT NULL CHECK(json_valid(config_json)));
CREATE TABLE qq_explicit_feedback(event_id TEXT PRIMARY KEY REFERENCES source_events(event_id),source_id TEXT NOT NULL,project_id TEXT NOT NULL,intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),config_json TEXT NOT NULL CHECK(json_valid(config_json)),outcome TEXT,batch_id TEXT,received_at TEXT NOT NULL);
CREATE INDEX qq_explicit_scope ON qq_explicit_feedback(project_id,source_id,received_at,event_id);
CREATE TABLE qq_feedback_rate(scope TEXT NOT NULL,identity TEXT NOT NULL,window_start TEXT NOT NULL,used INTEGER NOT NULL,PRIMARY KEY(scope,identity,window_start));
CREATE TABLE queue_fairness(lane TEXT PRIMARY KEY,burst INTEGER NOT NULL);
CREATE TABLE qq_query_snapshots(snapshot_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,actor_ref TEXT NOT NULL,created_at TEXT NOT NULL,expires_at TEXT NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)));
CREATE INDEX qq_query_expiry ON qq_query_snapshots(expires_at);
CREATE TABLE qq_query_members(snapshot_id TEXT NOT NULL REFERENCES qq_query_snapshots(snapshot_id) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,ordinal INTEGER NOT NULL,kind TEXT NOT NULL,entry_id TEXT NOT NULL,payload_json TEXT NOT NULL,PRIMARY KEY(snapshot_id,ordinal),UNIQUE(snapshot_id,kind,entry_id));
CREATE INDEX qq_issue_page ON issues(project_id,updated_at DESC,issue_id DESC);
CREATE INDEX qq_suggestion_page ON suggestions(project_id,updated_at DESC,suggestion_id DESC);
CREATE INDEX qq_batch_event ON batch_events(event_id,role,batch_id);
CREATE TABLE qq_menu_deployments(operation_id TEXT PRIMARY KEY,app_ref TEXT NOT NULL,created_at TEXT NOT NULL,before_json TEXT NOT NULL,desired_json TEXT NOT NULL,state TEXT NOT NULL,error_code TEXT);
CREATE INDEX qq_menu_recent ON qq_menu_deployments(app_ref,created_at);
CREATE INDEX qq_events_received ON source_events(project_id,received_at,event_id);
CREATE INDEX qq_work_created ON work_metadata(project_id,work_kind,work_id);

CREATE INDEX qq_object_received ON source_events(source_id,json_extract(payload_json,'$.data.object.externalId'),received_at);
CREATE TABLE qq_menu_calls(app_ref TEXT NOT NULL,method TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX qq_menu_call_window ON qq_menu_calls(app_ref,method,created_at);
CREATE TABLE qq_menu_denials(identity TEXT PRIMARY KEY,actor TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX qq_denial_window ON qq_menu_denials(actor,created_at);

CREATE INDEX qq_analysis_batch_jobs ON jobs(project_id,kind,json_extract(payload_json,'$.batchId'),created_at DESC);

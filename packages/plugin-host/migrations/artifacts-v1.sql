CREATE TABLE artifact_store_binding(id INTEGER PRIMARY KEY CHECK(id=1),root_hash TEXT NOT NULL,key_hash TEXT NOT NULL);
CREATE TABLE artifacts(
 artifact_id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(project_id),source_id TEXT NOT NULL REFERENCES sources(source_id),source_uri TEXT NOT NULL,external_event_id TEXT NOT NULL,
 source_event_id TEXT REFERENCES source_events(event_id),asset_ref TEXT NOT NULL,mime_type TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','capturing','stored','unavailable','rejected')),
 sha256 TEXT,size INTEGER,storage_key TEXT,ticket_cipher TEXT,ticket_expires_at TEXT NOT NULL,
 created_at TEXT NOT NULL,captured_at TEXT,error_code TEXT,attempt INTEGER NOT NULL DEFAULT 0,next_attempt_at TEXT NOT NULL,lease_token TEXT,lease_until TEXT,
 UNIQUE(project_id,source_uri,external_event_id,asset_ref)
);
CREATE INDEX artifacts_pending ON artifacts(state,next_attempt_at);
CREATE INDEX artifacts_event ON artifacts(project_id,source_event_id);

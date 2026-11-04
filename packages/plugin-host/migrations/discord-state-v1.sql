-- Namespaced feature migration, separate from the frozen global migration sequence.
CREATE TABLE discord_modules(namespace TEXT PRIMARY KEY,module_kind TEXT NOT NULL,guild_id TEXT NOT NULL,project_id TEXT NOT NULL,source_id TEXT NOT NULL,source_uri TEXT NOT NULL,public_project_id TEXT NOT NULL,binding_hash TEXT NOT NULL);
CREATE TABLE restricted_projects(project_id TEXT PRIMARY KEY,owner_project_id TEXT NOT NULL,reason TEXT NOT NULL);
CREATE TABLE discord_module_state(namespace TEXT NOT NULL REFERENCES discord_modules(namespace),state_key TEXT NOT NULL,version INTEGER NOT NULL,value_json TEXT NOT NULL CHECK(json_valid(value_json)),updated_at TEXT NOT NULL,PRIMARY KEY(namespace,state_key));
CREATE TABLE discord_module_inbox(namespace TEXT NOT NULL REFERENCES discord_modules(namespace),event_id TEXT NOT NULL,sequence INTEGER NOT NULL,payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),status TEXT NOT NULL DEFAULT 'pending',attempt INTEGER NOT NULL DEFAULT 0,retry_at TEXT NOT NULL,error_code TEXT,created_at TEXT NOT NULL,PRIMARY KEY(namespace,event_id));
CREATE INDEX discord_inbox_pending ON discord_module_inbox(namespace,status,retry_at);

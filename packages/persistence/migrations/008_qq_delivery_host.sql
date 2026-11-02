-- Additive QQ delivery Host ledger. Platform adapters never read this table.
CREATE TABLE plugin_delivery_bindings (
  plugin_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  PRIMARY KEY(plugin_id,project_id,recipient_ref)
);
CREATE TABLE plugin_delivery_requests (
  operation_id TEXT PRIMARY KEY REFERENCES external_operations(operation_id),
  plugin_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  recipient_ref TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('report','acceptance')),
  request_json TEXT NOT NULL CHECK(json_valid(request_json)),
  result_json TEXT CHECK(result_json IS NULL OR json_valid(result_json)),
  next_attempt_at TEXT NOT NULL
);
CREATE INDEX idx_plugin_delivery_pending ON plugin_delivery_requests(plugin_id,project_id,recipient_ref,next_attempt_at);

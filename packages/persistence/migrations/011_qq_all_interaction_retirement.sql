-- Extend the lifecycle to all owned report/interaction messages without rewriting migration 010.
CREATE TABLE qq_sent_messages (
  operation_id TEXT PRIMARY KEY REFERENCES external_operations(operation_id),
  plugin_id TEXT NOT NULL, project_id TEXT NOT NULL, recipient_ref TEXT NOT NULL, binding_id TEXT NOT NULL,
  message_id TEXT NOT NULL, accepted_at TEXT NOT NULL, send_order INTEGER NOT NULL
);
CREATE INDEX idx_qq_sent_messages_scope ON qq_sent_messages(plugin_id,project_id,recipient_ref,binding_id,accepted_at,send_order);
CREATE TABLE qq_message_retirements (
  recall_id TEXT PRIMARY KEY,
  old_delivery_id TEXT NOT NULL UNIQUE REFERENCES qq_sent_messages(operation_id),
  replacement_delivery_id TEXT NOT NULL REFERENCES qq_sent_messages(operation_id),
  state TEXT NOT NULL CHECK(state IN ('prepared','in_flight','succeeded','blocked','unknown','expired')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt IN (0,1)),
  expires_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
INSERT INTO qq_sent_messages
  SELECT c.operation_id,c.plugin_id,c.project_id,c.recipient_ref,c.binding_id,c.message_id,c.accepted_at,coalesce(a.rowid,o.rowid)
  FROM qq_sent_cards c JOIN external_operations o USING(operation_id)
  LEFT JOIN external_operation_attempts a ON a.operation_id=o.operation_id AND a.attempt_number=o.attempt;
-- Carry the uncertainty barrier forward: an old attempt must never become a new DELETE.
INSERT INTO qq_message_retirements SELECT * FROM qq_card_retirements;

-- Host-private message lifecycle. Existing requests, reports and frozen contracts remain unchanged.
CREATE TABLE qq_sent_cards (
  operation_id TEXT PRIMARY KEY REFERENCES external_operations(operation_id),
  plugin_id TEXT NOT NULL, project_id TEXT NOT NULL, recipient_ref TEXT NOT NULL, binding_id TEXT NOT NULL,
  work_kind TEXT NOT NULL CHECK(work_kind IN ('defect','suggestion')), work_id TEXT NOT NULL,
  work_version INTEGER NOT NULL CHECK(work_version>0), message_id TEXT NOT NULL, accepted_at TEXT NOT NULL
);
CREATE INDEX idx_qq_sent_cards_work ON qq_sent_cards(plugin_id,project_id,recipient_ref,binding_id,work_kind,work_id,work_version);
CREATE TABLE qq_card_retirements (
  recall_id TEXT PRIMARY KEY,
  old_delivery_id TEXT NOT NULL UNIQUE REFERENCES qq_sent_cards(operation_id),
  replacement_delivery_id TEXT NOT NULL REFERENCES qq_sent_cards(operation_id),
  state TEXT NOT NULL CHECK(state IN ('prepared','in_flight','succeeded','blocked','unknown','expired')),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt IN (0,1)),
  expires_at TEXT NOT NULL, lease_owner TEXT, lease_until TEXT, last_error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

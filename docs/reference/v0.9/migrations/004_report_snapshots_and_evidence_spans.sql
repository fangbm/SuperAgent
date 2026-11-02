-- v0.8 additive migration: single canonical GitHub mapping from 002; frozen report snapshots.
-- Requires 001 + 002 + 003. Apply once after backup; invalid historical spans cause
-- INSERT into checked replacement to fail, rolling the transaction back.
PRAGMA foreign_keys = ON;
BEGIN IMMEDIATE;

-- SQLite cannot ALTER a CHECK directly; rebuild this table in the same transaction.
CREATE TABLE feedback_item_evidence_v08 (
  feedback_item_id TEXT NOT NULL REFERENCES feedback_items(feedback_item_id),
  evidence_index INTEGER NOT NULL CHECK(evidence_index >= 0),
  event_id TEXT NOT NULL REFERENCES source_events(event_id),
  role TEXT NOT NULL CHECK(role IN ('primary','context','corroboration')),
  quote TEXT,
  span_start INTEGER,
  span_end INTEGER,
  PRIMARY KEY(feedback_item_id,evidence_index),
  CHECK (
    (span_start IS NULL AND span_end IS NULL) OR
    (span_start IS NOT NULL AND span_end IS NOT NULL AND span_start >= 0 AND span_end > span_start)
  )
);
INSERT INTO feedback_item_evidence_v08
  (feedback_item_id,evidence_index,event_id,role,quote,span_start,span_end)
SELECT feedback_item_id,evidence_index,event_id,role,quote,span_start,span_end
  FROM feedback_item_evidence;
DROP TABLE feedback_item_evidence;
ALTER TABLE feedback_item_evidence_v08 RENAME TO feedback_item_evidence;
CREATE INDEX idx_feedback_item_evidence_event ON feedback_item_evidence(event_id);

-- New canonical report store, snapshot immutable (see triggers below).
CREATE TABLE report_revisions (
  report_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision >= 1),
  project_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  schema_version TEXT NOT NULL CHECK(schema_version='2.1'),
  snapshot_cutoff_at TEXT NOT NULL,
  generated_at TEXT NOT NULL,
  supersedes_revision INTEGER,
  report_json TEXT NOT NULL CHECK(json_valid(report_json)),
  PRIMARY KEY(report_id,revision),
  UNIQUE(project_id,window_start,window_end,revision),
  CHECK((revision=1 AND supersedes_revision IS NULL) OR
        (revision > 1 AND supersedes_revision=revision-1)),
  FOREIGN KEY(report_id,supersedes_revision) REFERENCES report_revisions(report_id,revision)
);

-- Frozen navigation items: Bug/suggestion lists do NOT consult mutable Issue state.
CREATE TABLE report_snapshot_entries (
  report_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  section TEXT NOT NULL CHECK(section IN ('bugs','suggestions')),
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  entity_id TEXT NOT NULL,
  entry_json TEXT NOT NULL CHECK(json_valid(entry_json)),
  PRIMARY KEY(report_id,revision,section,ordinal),
  UNIQUE(report_id,revision,section,entity_id),
  FOREIGN KEY(report_id,revision) REFERENCES report_revisions(report_id,revision)
);

-- One Steam review per report revision; pointer to a chosen, immutable source revision.
-- The selected event could be a later edit in the report window. Trigger ids stored
-- separately to preserve all update evidence and prohibit dupes within the revision.
CREATE TABLE report_steam_negative_reviews (
  report_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
  source_id TEXT NOT NULL,
  review_external_id TEXT NOT NULL,
  evidence_event_id TEXT NOT NULL REFERENCES source_events(event_id),
  observed_at TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  updated_in_window INTEGER NOT NULL CHECK(updated_in_window IN (0,1)),
  sentiment_at_snapshot TEXT NOT NULL CHECK(sentiment_at_snapshot='negative'),
  original_url TEXT,
  PRIMARY KEY(report_id,revision,source_id,review_external_id),
  UNIQUE(report_id,revision,ordinal),
  FOREIGN KEY(report_id,revision) REFERENCES report_revisions(report_id,revision)
);
CREATE TABLE report_steam_review_trigger_events (
  report_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source_id TEXT NOT NULL,
  review_external_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES source_events(event_id),
  PRIMARY KEY(report_id,revision,source_id,review_external_id,event_id),
  FOREIGN KEY(report_id,revision,source_id,review_external_id)
    REFERENCES report_steam_negative_reviews(report_id,revision,source_id,review_external_id)
);

-- Ensure snapshot pointers belong to same source and project. Application also
-- verifies platform, received time, negative sentiment, and temporal cutoff.
CREATE TRIGGER report_steam_evidence_identity_insert BEFORE INSERT ON report_steam_negative_reviews
BEGIN
  SELECT RAISE(ABORT,'STEAM_EVIDENCE_IDENTITY_MISMATCH') WHERE NOT EXISTS (
    SELECT 1 FROM source_events e JOIN report_revisions r
      ON r.report_id=NEW.report_id AND r.revision=NEW.revision
    WHERE e.event_id=NEW.evidence_event_id
      AND e.source_id=NEW.source_id AND e.project_id=r.project_id
  );
END;
CREATE TRIGGER report_steam_trigger_identity_insert BEFORE INSERT ON report_steam_review_trigger_events
BEGIN
  SELECT RAISE(ABORT,'STEAM_TRIGGER_IDENTITY_MISMATCH') WHERE NOT EXISTS (
    SELECT 1 FROM source_events e JOIN report_revisions r
      ON r.report_id=NEW.report_id AND r.revision=NEW.revision
    WHERE e.event_id=NEW.event_id
      AND e.source_id=NEW.source_id AND e.project_id=r.project_id
  );
END;

-- No new data may be added to a report once its immutable seal was committed.
-- Host MUST publish report revision + every member + its seal + outbox in ONE transaction.
CREATE TABLE report_revision_seals (
  report_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  published_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY(report_id,revision),
  FOREIGN KEY(report_id,revision) REFERENCES report_revisions(report_id,revision)
);
CREATE TRIGGER report_seal_immutable_update BEFORE UPDATE ON report_revision_seals
BEGIN SELECT RAISE(ABORT,'REPORT_SEAL_IMMUTABLE'); END;
CREATE TRIGGER report_seal_immutable_delete BEFORE DELETE ON report_revision_seals
BEGIN SELECT RAISE(ABORT,'REPORT_SEAL_IMMUTABLE'); END;
CREATE TRIGGER report_member_no_insert_after_seal BEFORE INSERT ON report_snapshot_entries
BEGIN
 SELECT RAISE(ABORT,'REPORT_ALREADY_SEALED') WHERE EXISTS (
  SELECT 1 FROM report_revision_seals s WHERE s.report_id=NEW.report_id AND s.revision=NEW.revision
 );
END;
CREATE TRIGGER report_steam_no_insert_after_seal BEFORE INSERT ON report_steam_negative_reviews
BEGIN
 SELECT RAISE(ABORT,'REPORT_ALREADY_SEALED') WHERE EXISTS (
  SELECT 1 FROM report_revision_seals s WHERE s.report_id=NEW.report_id AND s.revision=NEW.revision
 );
END;
CREATE TRIGGER report_trigger_no_insert_after_seal BEFORE INSERT ON report_steam_review_trigger_events
BEGIN
 SELECT RAISE(ABORT,'REPORT_ALREADY_SEALED') WHERE EXISTS (
  SELECT 1 FROM report_revision_seals s WHERE s.report_id=NEW.report_id AND s.revision=NEW.revision
 );
END;

-- Hard guard against residual writes to the v0.4 legacy GitHub mapping.
-- Historical rows remain readable for migration audit; 002 copied them already.
CREATE TRIGGER legacy_link_readonly_insert BEFORE INSERT ON external_issue_links
BEGIN SELECT RAISE(ABORT,'LEGACY_LINK_READ_ONLY'); END;
CREATE TRIGGER legacy_link_readonly_update BEFORE UPDATE ON external_issue_links
BEGIN SELECT RAISE(ABORT,'LEGACY_LINK_READ_ONLY'); END;
CREATE TRIGGER legacy_link_readonly_delete BEFORE DELETE ON external_issue_links
BEGIN SELECT RAISE(ABORT,'LEGACY_LINK_READ_ONLY'); END;

-- Published revisions are append-only; correction means a NEW revision.
CREATE TRIGGER report_revision_immutable_update BEFORE UPDATE ON report_revisions
BEGIN SELECT RAISE(ABORT,'REPORT_REVISION_IMMUTABLE'); END;
CREATE TRIGGER report_revision_immutable_delete BEFORE DELETE ON report_revisions
BEGIN SELECT RAISE(ABORT,'REPORT_REVISION_IMMUTABLE'); END;
CREATE TRIGGER report_snapshot_entry_immutable_update BEFORE UPDATE ON report_snapshot_entries
BEGIN SELECT RAISE(ABORT,'REPORT_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER report_snapshot_entry_immutable_delete BEFORE DELETE ON report_snapshot_entries
BEGIN SELECT RAISE(ABORT,'REPORT_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER report_steam_immutable_update BEFORE UPDATE ON report_steam_negative_reviews
BEGIN SELECT RAISE(ABORT,'REPORT_STEAM_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER report_steam_immutable_delete BEFORE DELETE ON report_steam_negative_reviews
BEGIN SELECT RAISE(ABORT,'REPORT_STEAM_SNAPSHOT_IMMUTABLE'); END;
CREATE TRIGGER report_steam_trigger_immutable_delete BEFORE DELETE ON report_steam_review_trigger_events
BEGIN SELECT RAISE(ABORT,'REPORT_STEAM_TRIGGER_IMMUTABLE'); END;
CREATE TRIGGER report_steam_trigger_immutable_update BEFORE UPDATE ON report_steam_review_trigger_events
BEGIN SELECT RAISE(ABORT,'REPORT_STEAM_TRIGGER_IMMUTABLE'); END;

COMMIT;
-- GitHub mapping: external_work_links only (migration 002), no writes to legacy external_issue_links.
-- Domain validator MUST check frozen report JSON matches normalized membership tables.
-- Reads/QQ delivery MUST query only SEALED revisions.
-- Historical report v2.0 has no reconstructable member list: keep read-only until
-- audited backfill; never synthesize members from live review state.

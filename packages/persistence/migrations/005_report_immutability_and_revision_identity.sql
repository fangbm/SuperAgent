-- v0.9 hardening; requires 001..004 applied, FK enabled.
-- All report writes are append-only, even with PRAGMA recursive_triggers=OFF
-- and INSERT OR REPLACE. Migration aborts on preexisting identity/chain conflicts.
PRAGMA foreign_keys=ON;
BEGIN IMMEDIATE;

-- Canonical report identity. A logical report belongs to exactly one project/window.
CREATE TABLE report_series (
  report_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  window_start TEXT NOT NULL,
  window_end TEXT NOT NULL,
  UNIQUE(project_id,window_start,window_end),
  CHECK(window_start < window_end)
);
-- DISTINCT reveals violations instead of picking one matching revision silently.
INSERT INTO report_series(report_id,project_id,window_start,window_end)
SELECT DISTINCT report_id,project_id,window_start,window_end FROM report_revisions;

-- Refuse migration if existing revisions have NULL-chain loopholes, missing prior
-- revisions, unsealed predecessor revisions or mismatched report identity.
CREATE TABLE _report_v09_integrity_gate (ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO _report_v09_integrity_gate(ok)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM report_revisions r
  LEFT JOIN report_series s ON s.report_id=r.report_id
  WHERE s.report_id IS NULL
     OR s.project_id<>r.project_id OR s.window_start<>r.window_start
     OR s.window_end<>r.window_end
     OR (r.revision=1 AND r.supersedes_revision IS NOT NULL)
     OR (r.revision>1 AND (r.supersedes_revision IS NULL
                             OR r.supersedes_revision<>r.revision-1
                             OR NOT EXISTS (
                                SELECT 1 FROM report_revision_seals p
                                WHERE p.report_id=r.report_id AND p.revision=r.revision-1)))
) THEN 0 ELSE 1 END;
DROP TABLE _report_v09_integrity_gate;

CREATE TRIGGER report_series_no_conflicting_insert
BEFORE INSERT ON report_series
BEGIN
  SELECT RAISE(ABORT,'REPORT_SERIES_EXISTS') WHERE EXISTS (
    SELECT 1 FROM report_series s WHERE s.report_id=NEW.report_id OR
     (s.project_id=NEW.project_id AND s.window_start=NEW.window_start
      AND s.window_end=NEW.window_end)
  );
END;
CREATE TRIGGER report_series_no_update BEFORE UPDATE ON report_series
BEGIN SELECT RAISE(ABORT,'REPORT_SERIES_IMMUTABLE'); END;
CREATE TRIGGER report_series_no_delete BEFORE DELETE ON report_series
BEGIN SELECT RAISE(ABORT,'REPORT_SERIES_IMMUTABLE'); END;

CREATE TRIGGER report_revision_v09_insert_guard
BEFORE INSERT ON report_revisions
BEGIN
  -- protect against REPLACE of PK and other unique identity (not just PK).
  SELECT RAISE(ABORT,'REPORT_REVISION_EXISTS') WHERE EXISTS (
    SELECT 1 FROM report_revisions r WHERE
      (r.report_id=NEW.report_id AND r.revision=NEW.revision) OR
      (r.project_id=NEW.project_id AND r.window_start=NEW.window_start
         AND r.window_end=NEW.window_end AND r.revision=NEW.revision)
  );
  SELECT RAISE(ABORT,'REPORT_IDENTITY_MISMATCH') WHERE NOT EXISTS (
    SELECT 1 FROM report_series s WHERE s.report_id=NEW.report_id
      AND s.project_id=NEW.project_id AND s.window_start=NEW.window_start
      AND s.window_end=NEW.window_end
  );
  SELECT RAISE(ABORT,'REPORT_REVISION_CHAIN_INVALID')
   WHERE (NEW.revision=1 AND NEW.supersedes_revision IS NOT NULL) OR
     (NEW.revision>1 AND (NEW.supersedes_revision IS NULL
                          OR NEW.supersedes_revision <> NEW.revision-1));
  SELECT RAISE(ABORT,'REPORT_PREDECESSOR_NOT_SEALED')
    WHERE NEW.revision>1 AND NOT EXISTS (
      SELECT 1 FROM report_revision_seals p
      WHERE p.report_id=NEW.report_id AND p.revision=NEW.revision-1
    );
END;

CREATE TRIGGER report_snapshot_entry_no_conflicting_insert
BEFORE INSERT ON report_snapshot_entries
BEGIN
  SELECT RAISE(ABORT,'REPORT_ENTRY_EXISTS') WHERE EXISTS (
    SELECT 1 FROM report_snapshot_entries x WHERE
       (x.report_id=NEW.report_id AND x.revision=NEW.revision
        AND x.section=NEW.section AND x.ordinal=NEW.ordinal)
       OR
       (x.report_id=NEW.report_id AND x.revision=NEW.revision
        AND x.section=NEW.section AND x.entity_id=NEW.entity_id)
  );
END;

CREATE TRIGGER report_steam_no_conflicting_insert
BEFORE INSERT ON report_steam_negative_reviews
BEGIN
  SELECT RAISE(ABORT,'REPORT_STEAM_EXISTS') WHERE EXISTS (
    SELECT 1 FROM report_steam_negative_reviews x WHERE
      (x.report_id=NEW.report_id AND x.revision=NEW.revision
       AND x.source_id=NEW.source_id AND x.review_external_id=NEW.review_external_id)
      OR
      (x.report_id=NEW.report_id AND x.revision=NEW.revision AND x.ordinal=NEW.ordinal)
  );
END;

CREATE TRIGGER report_steam_trigger_no_conflicting_insert
BEFORE INSERT ON report_steam_review_trigger_events
BEGIN
  SELECT RAISE(ABORT,'REPORT_STEAM_TRIGGER_EXISTS') WHERE EXISTS (
    SELECT 1 FROM report_steam_review_trigger_events x WHERE
     x.report_id=NEW.report_id AND x.revision=NEW.revision
     AND x.source_id=NEW.source_id AND x.review_external_id=NEW.review_external_id
     AND x.event_id=NEW.event_id
  );
END;

CREATE TRIGGER report_seal_no_conflicting_insert
BEFORE INSERT ON report_revision_seals
BEGIN
  SELECT RAISE(ABORT,'REPORT_SEAL_EXISTS') WHERE EXISTS (
    SELECT 1 FROM report_revision_seals x WHERE
     x.report_id=NEW.report_id AND x.revision=NEW.revision
  );
END;
COMMIT;

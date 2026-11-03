-- Keep the existing QQ delivery migration008 unchanged.
CREATE TABLE source_policies (
  source_id TEXT PRIMARY KEY NOT NULL REFERENCES sources(source_id),
  processing_mode TEXT NOT NULL CHECK(processing_mode IN ('standard','archive_only')),
  visibility TEXT NOT NULL CHECK(visibility IN ('public','staff')),
  updated_at TEXT NOT NULL,
  CHECK(visibility <> 'staff' OR processing_mode = 'archive_only')
);

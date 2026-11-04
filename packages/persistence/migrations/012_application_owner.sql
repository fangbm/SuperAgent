-- Main-program ownership only; no platform policy or private-ticket schema.
CREATE TABLE application_owner (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  token TEXT NOT NULL,
  hostname TEXT NOT NULL,
  pid INTEGER NOT NULL CHECK(pid>0),
  acquired_at TEXT NOT NULL
);

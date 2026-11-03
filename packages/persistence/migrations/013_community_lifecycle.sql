-- Community entity state shares the existing archive database.
CREATE TABLE community_state (
  namespace TEXT NOT NULL CHECK(length(namespace)>0),
  state_key TEXT NOT NULL CHECK(length(state_key)>0),
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(namespace,state_key)
) WITHOUT ROWID;

CREATE TABLE community_leases (
  namespace TEXT PRIMARY KEY NOT NULL CHECK(length(namespace)>0),
  owner TEXT NOT NULL CHECK(length(owner)>0),
  lease_until TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK(generation>0),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

"""v0.9 SQLite regression: immutable report identity, revision chains and REPLACE."""
from pathlib import Path
import sqlite3, json
from typing import Optional

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = [
  '001_core_id_and_external_effects.sql',
  '002_feedback_items_and_suggestions.sql',
  '003_p0_alerts_and_notifications.sql',
  '004_report_snapshots_and_evidence_spans.sql',
  '005_report_immutability_and_revision_identity.sql',
]

def make_db(upto=5):
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    db.execute('PRAGMA recursive_triggers=OFF')  # Vulnerable default being tested.
    for f in MIGRATIONS[:upto]:
        db.executescript((ROOT/'migrations'/f).read_text())
    return db

def must_fail(db, sql, params=()):
    try:
        db.execute(sql, params)
    except sqlite3.IntegrityError:
        return
    raise AssertionError('unexpected SUCCESS: '+sql)

def insert_revision(db, rid, rev, project='game-a', start='2026-11-02T00:00:00Z', end='2026-11-02T10:00:00Z', pred=None):
    db.execute('''INSERT INTO report_revisions(report_id,revision,project_id,window_start,window_end,schema_version,snapshot_cutoff_at,generated_at,supersedes_revision,report_json)
      VALUES(?,?,?,?,?,'2.1','2026-11-02T10:00:00Z','2026-11-02T10:01:00Z',?,?)''',
      (rid,rev,project,start,end,pred,json.dumps({'reportId':rid,'revision':rev})))

# Identity + sealed snapshot + every potential REPLACE target.
db=make_db()
assert db.execute('PRAGMA recursive_triggers').fetchone() == (0,)
db.execute("INSERT INTO source_events(event_id,source_uri,external_event_id,project_id,source_id,event_type,payload_json,received_at) VALUES('ev1','urn:steam','e1','game-a','steam-main','com.superagent.feedback.review.created.v1','{}','now')")
db.execute("INSERT INTO report_series VALUES('report-a','game-a','2026-11-02T00:00:00Z','2026-11-02T10:00:00Z')")
insert_revision(db,'report-a',1)
db.execute('''INSERT INTO report_snapshot_entries VALUES('report-a',1,'bugs',0,'BUG-1','{"title":"original"}')''')
db.execute('''INSERT INTO report_steam_negative_reviews(report_id,revision,ordinal,source_id,review_external_id,evidence_event_id,observed_at,occurred_at,updated_in_window,sentiment_at_snapshot) VALUES('report-a',1,0,'steam-main','review-1','ev1','now','now',0,'negative')''')
db.execute("INSERT INTO report_steam_review_trigger_events VALUES('report-a',1,'steam-main','review-1','ev1')")
db.execute("INSERT INTO report_revision_seals VALUES('report-a',1,'now','hash-original')")
db.commit()

snapshot = {}
for table in ('report_series','report_revisions','report_snapshot_entries','report_steam_negative_reviews','report_steam_review_trigger_events','report_revision_seals'):
    snapshot[table]=db.execute('SELECT * FROM '+table+' ORDER BY 1,2').fetchall()

# UPDATE/DELETE guards existed in v0.8; new INSERT guards must stop REPLACE.
replace_sqls = [
 "INSERT OR REPLACE INTO report_series VALUES('report-a','game-x','2026-11-02T00:00:00Z','2026-11-02T10:00:00Z')",
 "INSERT OR REPLACE INTO report_revisions(report_id,revision,project_id,window_start,window_end,schema_version,snapshot_cutoff_at,generated_at,report_json) VALUES('report-a',1,'game-a','2026-11-02T00:00:00Z','2026-11-02T10:00:00Z','2.1','now','now','{\"tamper\":1}')",
 "INSERT OR REPLACE INTO report_snapshot_entries VALUES('report-a',1,'bugs',0,'BUG-1','{\"title\":\"changed\"}')",
 "INSERT OR REPLACE INTO report_snapshot_entries VALUES('report-a',1,'bugs',1,'BUG-1','{\"title\":\"changed\"}')", # alternate UNIQUE key
 "INSERT OR REPLACE INTO report_steam_negative_reviews(report_id,revision,ordinal,source_id,review_external_id,evidence_event_id,observed_at,occurred_at,updated_in_window,sentiment_at_snapshot) VALUES('report-a',1,0,'steam-main','review-1','ev1','new','new',1,'negative')",
 "INSERT OR REPLACE INTO report_steam_negative_reviews(report_id,revision,ordinal,source_id,review_external_id,evidence_event_id,observed_at,occurred_at,updated_in_window,sentiment_at_snapshot) VALUES('report-a',1,0,'steam-main','review-2','ev1','new','new',1,'negative')", # alternate UNIQUE key
 "INSERT OR REPLACE INTO report_steam_review_trigger_events VALUES('report-a',1,'steam-main','review-1','ev1')",
 "INSERT OR REPLACE INTO report_revision_seals VALUES('report-a',1,'later','tampered')",
]
for sql in replace_sqls:
    must_fail(db,sql)
for table, expected in snapshot.items():
    assert db.execute('SELECT * FROM '+table+' ORDER BY 1,2').fetchall()==expected,table

# Identity and chain: cannot cross project or window; NULL predecessor is not accepted.
must_fail(db,"INSERT OR REPLACE INTO report_series VALUES('report-b','game-a','2026-11-02T00:00:00Z','2026-11-02T10:00:00Z')")
for args in [
 ('report-a',2,'game-a','2026-11-02T00:00:00Z','2026-11-02T10:00:00Z',None),
 ('report-a',2,'game-a','2026-11-02T00:00:00Z','2026-11-02T10:00:00Z',0),
 ('report-a',2,'game-b','2026-11-02T00:00:00Z','2026-11-02T10:00:00Z',1),
 ('report-a',2,'game-a','2026-11-02T01:00:00Z','2026-11-02T10:00:00Z',1),
 ('report-a',3,'game-a','2026-11-02T00:00:00Z','2026-11-02T10:00:00Z',2),
]:
    must_fail(db,'''INSERT INTO report_revisions(report_id,revision,project_id,window_start,window_end,schema_version,snapshot_cutoff_at,generated_at,supersedes_revision,report_json)
      VALUES(?,?,?,?,?,'2.1','now','now',?,'{}')''',args)
# Legit revision2 after rev1 sealed.
insert_revision(db,'report-a',2,pred=1)
db.execute("INSERT INTO report_revision_seals VALUES('report-a',2,'now','hash-r2')")
assert db.execute("SELECT revision,supersedes_revision FROM report_revisions WHERE report_id='report-a' ORDER BY revision").fetchall()==[(1,None),(2,1)]

# Prior draft is unsealed: cannot advance a revision.
db.execute("INSERT INTO report_series VALUES('draft','game-a','2026-11-01T00:00:00Z','2026-11-01T10:00:00Z')")
insert_revision(db,'draft',1,start='2026-11-01T00:00:00Z',end='2026-11-01T10:00:00Z')
must_fail(db,'''INSERT INTO report_revisions(report_id,revision,project_id,window_start,window_end,schema_version,snapshot_cutoff_at,generated_at,supersedes_revision,report_json) VALUES('draft',2,'game-a','2026-11-01T00:00:00Z','2026-11-01T10:00:00Z','2.1','now','now',1,'{}')''')

# Illegal legacy cross-project revisions: migration MUST fail, not silently choose.
old=make_db(4)
old.execute("INSERT INTO report_revisions(report_id,revision,project_id,window_start,window_end,schema_version,snapshot_cutoff_at,generated_at,report_json) VALUES('bad',1,'game-a','a','b','2.1','now','now','{}')")
old.execute("INSERT INTO report_revision_seals VALUES('bad',1,'now','hash')")
old.execute("INSERT INTO report_revisions(report_id,revision,project_id,window_start,window_end,schema_version,snapshot_cutoff_at,generated_at,supersedes_revision,report_json) VALUES('bad',2,'game-b','a','b','2.1','now','now',1,'{}')")
old.commit()
try:
    old.executescript((ROOT/'migrations'/MIGRATIONS[4]).read_text())
except sqlite3.IntegrityError:
    old.rollback()
else:
    raise AssertionError('corrupt legacy identity migrated')
assert old.execute("SELECT COUNT(*) FROM report_revisions WHERE report_id='bad'").fetchone()[0] == 2
assert old.execute("SELECT name FROM sqlite_master WHERE name='report_series'").fetchone() is None

# Illegal legacy null predecessor bug in CHECK with SQLite UNKNOWN semantics.
old2=make_db(4)
old2.execute("INSERT INTO report_revisions(report_id,revision,project_id,window_start,window_end,schema_version,snapshot_cutoff_at,generated_at,supersedes_revision,report_json) VALUES('bad',2,'game-a','a','b','2.1','now','now',NULL,'{}')")
old2.commit()
try:
    old2.executescript((ROOT/'migrations'/MIGRATIONS[4]).read_text())
except sqlite3.IntegrityError:
    old2.rollback()
else:
    raise AssertionError('corrupt legacy predecessor migrated')
assert old2.execute("SELECT revision,supersedes_revision FROM report_revisions").fetchone() == (2,None)
assert old2.execute("SELECT name FROM sqlite_master WHERE name='report_series'").fetchone() is None

print('PASS v0.9: REPLACE under recursive_triggers=OFF; alternate unique collisions; revision lineage; project/window identity; corrupt legacy rollback')

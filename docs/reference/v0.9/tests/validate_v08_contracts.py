from pathlib import Path
import copy, json, sqlite3
from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
read = lambda path: (ROOT / path).read_text(encoding='utf-8')
schema = json.loads(read('schemas/report-v2.schema.json'))
Draft202012Validator.check_schema(schema)
validator = Draft202012Validator(schema, format_checker=FormatChecker())
base = json.loads(read('fixtures/report-v2.1-with-steam.json'))
rev2 = json.loads(read('fixtures/report-v2.1-revision2.json'))
for good in (base, rev2):
    errors = list(validator.iter_errors(good))
    assert not errors, errors
for key in ('revision', 'snapshotCutoffAt', 'steamNegativeReviews'):
    bad = copy.deepcopy(base); bad.pop(key)
    assert not validator.is_valid(bad), 'Missing required ' + key
bad=copy.deepcopy(base); bad['schemaVersion']='2.0'
assert not validator.is_valid(bad)
bad=copy.deepcopy(base); bad['revision']=2
assert not validator.is_valid(bad), 'revision2 requires supersedesRevision'
bad=copy.deepcopy(base); bad['supersedesRevision']=0
assert not validator.is_valid(bad), 'revision1 cannot supersede'
bad=copy.deepcopy(base); bad['steamNegativeReviews'][0]['sentimentAtSnapshot']='positive'
assert not validator.is_valid(bad)
bad=copy.deepcopy(base); bad['steamNegativeReviews'][0].pop('evidenceEventId')
assert not validator.is_valid(bad)
bad=copy.deepcopy(base); bad['steamNegativeReviews'][0]['triggerEventIds']=[]
assert not validator.is_valid(bad)

schema_ddl=[read(f'migrations/00{x}_{suffix}.sql') for x,suffix in [
    (1,'core_id_and_external_effects'),(2,'feedback_items_and_suggestions'),
    (3,'p0_alerts_and_notifications'),(4,'report_snapshots_and_evidence_spans')]]

def setup_db():
    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys = ON')
    for sql in schema_ddl[:3]: db.executescript(sql)
    return db

def add_event(db, eid, external, source='steam-main', project='game-a'):
    db.execute('INSERT INTO source_events(event_id,source_uri,external_event_id,project_id,source_id,event_type,payload_json,received_at) VALUES(?,?,?,?,?,?,?,?)',
              (eid,'urn:steam',external,project,source,'com.superagent.feedback.review.created.v1','{}','2026-11-02T09:58:00Z'))

# clean upgrade, original data, and unified links
with setup_db() as db:
    db.execute("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,created_at,updated_at) VALUES('op-b','github.issue.create','BUG-42','key-b','h','unknown','now','now')")
    db.execute("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,created_at,updated_at) VALUES('op-s','github.issue.create','REQ-8','key-s','h','unknown','now','now')")
    db.execute("INSERT INTO external_issue_links(internal_issue_id,provider,repository,external_issue_id,created_by_operation_id) VALUES('BUG-42','github','o/r','42','op-b')")
    # Copy existing legacy mapping via 002 is tested separately after baseline

with sqlite3.connect(':memory:') as db:
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript(schema_ddl[0])
    db.execute("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,created_at,updated_at) VALUES('op-b','github.issue.create','BUG-42','key-b','h','unknown','now','now')")
    db.execute("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,created_at,updated_at) VALUES('op-s','github.issue.create','REQ-8','key-s','h','unknown','now','now')")
    db.execute("INSERT INTO external_issue_links(internal_issue_id,provider,repository,external_issue_id,created_by_operation_id) VALUES('BUG-42','github','o/r','42','op-b')")
    db.executescript(schema_ddl[1]); db.executescript(schema_ddl[2])
    assert db.execute('SELECT work_kind,work_id FROM external_work_links').fetchone()==('defect','BUG-42')
    add_event(db,'host-ev-1','review-345')
    add_event(db,'host-ev-2','review-345-v2')
    add_event(db,'host-bad','wrong-source','other-source')
    db.execute("INSERT INTO triage_extractions(triage_id,batch_id,pipeline_version,revision,result_schema_version,result_json,created_at) VALUES('triage1','batch1','p',1,'2.0','{}','now')")
    db.execute("INSERT INTO feedback_items(feedback_item_id,triage_id,extraction_index,kind,category,title,description,created_at) VALUES('i','triage1',0,'defect','bug','x','x','now')")
    db.execute("INSERT INTO feedback_item_evidence(feedback_item_id,evidence_index,event_id,role,span_start,span_end) VALUES('i',0,'host-ev-1','primary',0,6)")
    db.commit()
    db.executescript(schema_ddl[3])
    assert db.execute('SELECT span_start,span_end FROM feedback_item_evidence').fetchone()==(0,6)
    for i,ss,se in [(1,1,None),(2,None,5),(3,-1,3),(4,5,5)]:
        try:
            db.execute('INSERT INTO feedback_item_evidence(feedback_item_id,evidence_index,event_id,role,span_start,span_end) VALUES(?,?,?,?,?,?)',('i',i,'host-ev-1','context',ss,se))
        except sqlite3.IntegrityError:
            pass
        else:
            raise AssertionError(f'Invalid span accepted: {ss},{se}')
    db.execute("INSERT INTO feedback_item_evidence(feedback_item_id,evidence_index,event_id,role) VALUES('i',6,'host-ev-1','context')")
    db.execute("INSERT INTO feedback_item_evidence(feedback_item_id,evidence_index,event_id,role,span_start,span_end) VALUES('i',7,'host-ev-1','context',2,4)")

    # GitHub recovered CREATE must write unified mapping and operation atomically.
    db.execute('BEGIN' if not db.in_transaction else 'SAVEPOINT recover')
    db.execute("INSERT INTO external_work_links(work_kind,work_id,provider,repository,external_issue_id,created_by_operation_id) VALUES('suggestion','REQ-8','github','o/r','53','op-s')")
    db.execute("UPDATE external_operations SET state='succeeded',provider_object_id='53' WHERE operation_id='op-s'")
    if db.in_transaction: db.execute('RELEASE recover')
    assert db.execute("SELECT COUNT(*) FROM external_issue_links").fetchone()[0]==1
    assert db.execute("SELECT COUNT(*) FROM external_work_links").fetchone()[0]==2

    r=json.dumps(base)
    db.execute("INSERT INTO report_revisions(report_id,revision,project_id,window_start,window_end,schema_version,snapshot_cutoff_at,generated_at,report_json) VALUES(?,?,?,?,?,?,?,?,?)",
        (base['reportId'],1,'game-a',base['window']['startInclusive'],base['window']['endExclusive'],'2.1',base['snapshotCutoffAt'],base['generatedAt'],r))
    db.execute("INSERT INTO report_snapshot_entries(report_id,revision,section,ordinal,entity_id,entry_json) VALUES(?,?,?,?,?,?)",(base['reportId'],1,'bugs',0,'BUG-42',json.dumps({'kind':'bug','id':'BUG-42','title':'x','newFeedbackCount':1})))
    db.execute("INSERT INTO report_snapshot_entries(report_id,revision,section,ordinal,entity_id,entry_json) VALUES(?,?,?,?,?,?)",(base['reportId'],1,'suggestions',0,'REQ-8',json.dumps({'kind':'suggestion','id':'REQ-8','title':'x','newFeedbackCount':1,'status':'reviewing'})))
    db.execute("INSERT INTO report_steam_negative_reviews(report_id,revision,ordinal,source_id,review_external_id,evidence_event_id,observed_at,occurred_at,updated_in_window,sentiment_at_snapshot,original_url) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        (base['reportId'],1,0,'steam-main','steam-review-345','host-ev-1','2026-11-02T09:58:00Z','2026-11-02T09:57:00Z',0,'negative',base['steamNegativeReviews'][0]['originalUrl']))
    db.execute("INSERT INTO report_steam_review_trigger_events(report_id,revision,source_id,review_external_id,event_id) VALUES(?,?,?,?,?)",(base['reportId'],1,'steam-main','steam-review-345','host-ev-1'))
    for q in [
        "INSERT INTO report_steam_negative_reviews(report_id,revision,ordinal,source_id,review_external_id,evidence_event_id,observed_at,occurred_at,updated_in_window,sentiment_at_snapshot) VALUES('report-20261102-1800',1,1,'steam-main','steam-review-345','host-ev-1','now','now',0,'negative')",
        "INSERT INTO report_steam_negative_reviews(report_id,revision,ordinal,source_id,review_external_id,evidence_event_id,observed_at,occurred_at,updated_in_window,sentiment_at_snapshot) VALUES('report-20261102-1800',1,1,'steam-main','other-review','host-bad','now','now',0,'negative')",
        "UPDATE report_revisions SET report_json='{}' WHERE revision=1",
        "DELETE FROM report_steam_negative_reviews WHERE report_id='report-20261102-1800' AND revision=1",
    ]:
        try: db.execute(q)
        except sqlite3.IntegrityError: pass
        else: raise AssertionError('Snapshot invariant failed: '+q)
    # Domain-level snapshot correspondence (JSON Schema cannot assert relational equality).
    rows = db.execute('SELECT section,entity_id FROM report_snapshot_entries WHERE report_id=? AND revision=?',(base['reportId'],1)).fetchall()
    assert sorted(rows) == [('bugs','BUG-42'),('suggestions','REQ-8')]
    steam = db.execute('SELECT source_id,review_external_id,evidence_event_id,original_url FROM report_steam_negative_reviews WHERE report_id=? AND revision=?',(base['reportId'],1)).fetchall()
    assert steam == [(m['sourceId'],m['reviewExternalId'],m['evidenceEventId'],m['originalUrl']) for m in base['steamNegativeReviews']]
    triggers = db.execute('SELECT event_id FROM report_steam_review_trigger_events WHERE report_id=? AND revision=?',(base['reportId'],1)).fetchall()
    assert [x[0] for x in triggers] == base['steamNegativeReviews'][0]['triggerEventIds']
    db.execute("INSERT INTO report_revision_seals(report_id,revision,published_at,content_hash) VALUES(?,?,?,?)",(base['reportId'],1,'now','sha256-r1'))
    for query in [
      "INSERT INTO report_snapshot_entries(report_id,revision,section,ordinal,entity_id,entry_json) VALUES('report-20261102-1800',1,'suggestions',1,'REQ-8','{}')",
      "INSERT INTO report_steam_review_trigger_events(report_id,revision,source_id,review_external_id,event_id) VALUES('report-20261102-1800',1,'steam-main','steam-review-345','host-ev-2')",
      "INSERT INTO external_issue_links(internal_issue_id,provider,repository,external_issue_id,created_by_operation_id) VALUES('BUG-99','github','o/r','99','op-b')",
      "UPDATE external_issue_links SET external_issue_id='99' WHERE external_issue_id='42'"
    ]:
      try: db.execute(query)
      except sqlite3.IntegrityError: pass
      else: raise AssertionError('Published snapshot or legacy table allowed mutation: '+query)
    db.execute("INSERT INTO report_revisions(report_id,revision,project_id,window_start,window_end,schema_version,snapshot_cutoff_at,generated_at,supersedes_revision,report_json) VALUES(?,?,?,?,?,?,?,?,?,?)",
        (rev2['reportId'],2,'game-a',rev2['window']['startInclusive'],rev2['window']['endExclusive'],'2.1',rev2['snapshotCutoffAt'],rev2['generatedAt'],1,json.dumps(rev2)))
    db.execute("INSERT INTO report_revision_seals(report_id,revision,published_at,content_hash) VALUES(?,?,?,?)",(rev2['reportId'],2,'now','sha256-r2'))
    assert db.execute('SELECT COUNT(*) FROM report_revisions').fetchone()[0] == 2
    assert db.execute('SELECT COUNT(*) FROM report_steam_negative_reviews WHERE revision=1').fetchone()[0] == 1
    assert db.execute('SELECT COUNT(*) FROM report_steam_negative_reviews WHERE revision=2').fetchone()[0] == 0

# Real v0.7 gap: partial span was accepted. v0.8 migration must NOT silently drop it.
db=setup_db()
add_event(db,'event-corrupt','external-corrupt')
db.execute("INSERT INTO triage_extractions(triage_id,batch_id,pipeline_version,revision,result_schema_version,result_json,created_at) VALUES('t','b','p',1,'2.0','{}','now')")
db.execute("INSERT INTO feedback_items(feedback_item_id,triage_id,extraction_index,kind,category,title,description,created_at) VALUES('f','t',0,'defect','bug','x','x','now')")
db.execute("INSERT INTO feedback_item_evidence(feedback_item_id,evidence_index,event_id,role,span_start) VALUES('f',0,'event-corrupt','primary',3)")
db.commit()
try:
    db.executescript(schema_ddl[3])
except sqlite3.IntegrityError:
    db.rollback()
else:
    raise AssertionError('Migration unexpectedly allowed partial span')
assert db.execute("SELECT span_start,span_end FROM feedback_item_evidence").fetchone()==(3,None)
assert db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='report_revisions'").fetchone() is None
print('PASS v0.8: ReportV2 schema, revisions, Steam members, frozen snapshot constraints, legacy GitHub link recovery, span migration fail-safe')

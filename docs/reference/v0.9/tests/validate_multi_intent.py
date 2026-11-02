#!/usr/bin/env python3
from pathlib import Path
import copy,json,sqlite3
from jsonschema import Draft202012Validator
ROOT=Path(__file__).resolve().parents[1]
schema=json.loads((ROOT/'schemas/triage-result-v2.schema.json').read_text())
report_schema=json.loads((ROOT/'schemas/report-v2.schema.json').read_text())
Draft202012Validator.check_schema(schema); Draft202012Validator.check_schema(report_schema)
v=Draft202012Validator(schema)
for x in ['triage-mixed-intent-v2.json','triage-question-only-v2.json','triage-two-suggestions-v2.json']:
  data=json.loads((ROOT/'fixtures'/x).read_text()); assert v.is_valid(data),(x,list(v.iter_errors(data)))
for x in ['invalid-defect-category-v2.json','invalid-suggestion-category-v2.json','invalid-empty-triage-v2.json']:
  data=json.loads((ROOT/'fixtures'/x).read_text()); assert not v.is_valid(data), x
mixed=json.loads((ROOT/'fixtures/triage-mixed-intent-v2.json').read_text())
assert len(mixed['items'])==2
assert mixed['items'][0]['evidence'][0]['eventId']==mixed['items'][1]['evidence'][0]['eventId']
with sqlite3.connect(':memory:') as db:
  db.executescript((ROOT/'migrations/001_core_id_and_external_effects.sql').read_text())
  db.executescript((ROOT/'migrations/002_feedback_items_and_suggestions.sql').read_text())
  db.execute("INSERT INTO source_events(event_id,source_uri,external_event_id,project_id,source_id,event_type,payload_json,received_at) VALUES('host-event-01','urn:qq','qq1','p','s','message','{}','now')")
  db.execute("INSERT INTO triage_extractions(triage_id,batch_id,pipeline_version,revision,result_schema_version,result_json,created_at) VALUES('t1','b','v2',1,'2.0','{}','now')")
  for idx,kind,category in [(0,'defect','bug'),(1,'suggestion','feature_request')]:
    db.execute('INSERT INTO feedback_items(feedback_item_id,triage_id,extraction_index,kind,category,title,description,confidence,created_at) VALUES(?,?,?,?,?,?,?,?,?)', (f'item{idx}','t1',idx,kind,category,'title','desc',0.9,'now'))
    db.execute('INSERT INTO feedback_item_evidence(feedback_item_id,evidence_index,event_id,role) VALUES(?,?,?,?)', (f'item{idx}',0,'host-event-01','primary'))
  try:
    db.execute("INSERT INTO feedback_items(feedback_item_id,triage_id,extraction_index,kind,category,title,description,created_at) VALUES('dup','t1',0,'defect','bug','x','x','now')")
  except sqlite3.IntegrityError: pass
  else: raise AssertionError('duplicate extraction index accepted')
  try:
    db.execute("INSERT INTO feedback_items(feedback_item_id,triage_id,extraction_index,kind,category,title,description,created_at) VALUES('bad','t1',3,'suggestion','bug','x','x','now')")
  except sqlite3.IntegrityError: pass
  else: raise AssertionError('mismatched suggestion category accepted')
  assert db.execute("SELECT COUNT(DISTINCT event_id) FROM feedback_item_evidence").fetchone()[0]==1
  assert db.execute("SELECT COUNT(*) FROM feedback_items").fetchone()[0]==2
  db.execute("INSERT INTO suggestions(suggestion_id,project_id,title,summary,status,created_at,updated_at) VALUES('sug1','p','auto reconnect','desc','candidate','now','now')")
  assert db.execute("UPDATE suggestions SET status='reviewing',version=version+1 WHERE suggestion_id='sug1' AND version=1").rowcount==1
  assert db.execute("UPDATE suggestions SET status='accepted',version=version+1 WHERE suggestion_id='sug1' AND version=1").rowcount==0
print('PASS: v0.5 schemas, multi-intent evidence count, database constraints & version guard')

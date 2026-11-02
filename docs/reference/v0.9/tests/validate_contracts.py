#!/usr/bin/env python3
"""v0.4 schema and new install DDL checks (does not test remote APIs)."""
from pathlib import Path
import json,sqlite3,sys
from jsonschema import Draft202012Validator, FormatChecker
ROOT=Path(__file__).resolve().parents[1]
S=json.loads((ROOT/'schemas/normalized-event-v1.schema.json').read_text())
Draft202012Validator.check_schema(S)
v=Draft202012Validator(S,format_checker=FormatChecker())
valid=json.loads((ROOT/'fixtures/qq-message-created.json').read_text())
assert v.is_valid(valid), list(v.iter_errors(valid))
assert not v.is_valid(json.loads((ROOT/'fixtures/invalid-type-data.json').read_text()))
for kind in ('message','review','thread','comment'):
    for action in ('created','updated','deleted'):
        e=json.loads(json.dumps(valid))
        e['type']=f'com.superagent.feedback.{kind}.{action}.v1'
        e['data']['object']['kind']=kind
        assert v.is_valid(e), (kind,action,list(v.iter_errors(e)))
        e['data']['object']['kind']='review' if kind!='review' else 'message'
        assert not v.is_valid(e), (kind, action, 'invalid kind accepted')
c=json.loads(json.dumps(valid))
c['type']='com.superagent.source.coverage.changed.v1'
c['data']={'schemaVersion':'1.0','projectId':'p','sourceId':'s','platform':'qq-official','coverage':'full'}
assert v.is_valid(c)
c['data']['object']=valid['data']['object']
assert not v.is_valid(c)
with sqlite3.connect(':memory:') as db:
    db.executescript((ROOT/'migrations/001_core_id_and_external_effects.sql').read_text())
    sql="INSERT INTO source_events(event_id,source_uri,external_event_id,project_id,source_id,event_type,payload_json,received_at) VALUES(?,?,?,?,?,?,?,?)"
    db.execute(sql,('host-1','urn:source:1','ev-1','p','s','message','{}','2026-11-02T00:00:00Z'))
    try:
        db.execute(sql,('host-2','urn:source:1','ev-1','p','s','message','{}','2026-11-02T00:00:00Z'))
    except sqlite3.IntegrityError: pass
    else: raise AssertionError('duplicate source event accepted')
    db.execute(sql,('host-3','urn:source:2','ev-1','p','s2','message','{}','2026-11-02T00:00:00Z'))
    db.execute("INSERT INTO external_operations(operation_id,kind,target_ref,idempotency_key,request_hash,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)", ('op-1','github.issue.create','p/repo','github:p:issue42','hash-1','prepared','now','now'))
    claim = db.execute("UPDATE external_operations SET state='in_flight',lease_owner='worker-a',lease_until='tomorrow',attempt=attempt+1 WHERE operation_id='op-1' AND state IN ('prepared','safe_retry')").rowcount
    lost = db.execute("UPDATE external_operations SET state='in_flight',lease_owner='worker-b',lease_until='tomorrow',attempt=attempt+1 WHERE operation_id='op-1' AND state IN ('prepared','safe_retry')").rowcount
    assert (claim,lost)==(1,0), 'second worker claimed the same outbound operation'
print('PASS: 13 event variants, invalid type/data combinations, SQLite internal ID uniqueness and external write lease claim')

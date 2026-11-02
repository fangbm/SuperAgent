from pathlib import Path
import copy, json, sqlite3
from jsonschema import Draft202012Validator
R=Path(__file__).resolve().parents[1]
load=lambda p: json.loads((R/p).read_text())
policy=load('notifications.default.json')['notifications']
assert policy['allowedRealtime']=={'kind':'defect','severity':'P0'}
assert policy['nonP0']['individualImmediatePush'] is False
assert policy['digest']['includeP0'] is True
assert policy['digest']['scheduleTimes']==['00:00','18:00']

dec_s=load('schemas/notification-routing-decision-v1.schema.json')
alert_s=load('schemas/p0-alert-v1.schema.json')
for schema in [dec_s,alert_s]: Draft202012Validator.check_schema(schema)
vd=Draft202012Validator(dec_s); va=Draft202012Validator(alert_s)
p0=load('fixtures/decision-p0-realtime.json'); steam=load('fixtures/decision-steam-digest.json'); a=load('fixtures/p0-alert.json')
assert vd.is_valid(p0) and vd.is_valid(steam) and va.is_valid(a)
bad=copy.deepcopy(p0);bad['severity']='P1';assert not vd.is_valid(bad)
bad=copy.deepcopy(steam);bad['severity']='P0';assert not vd.is_valid(bad)
bad=copy.deepcopy(a);bad['severity']='P2';assert not va.is_valid(bad)
bad=copy.deepcopy(a);bad['evidence']=[];assert not va.is_valid(bad)

# This test function is an executable illustration of the policy, not the Agent runtime.
def route(kind,severity=None):
  return 'p0_realtime' if kind=='defect' and severity=='P0' else 'digest_only'
assert route('defect','P0')=='p0_realtime'
for kind,severity in [('defect','P1'),('defect','P2'),('defect','P3'),('defect','unknown'),('suggestion',None),('steam_negative_review',None)]:
  assert route(kind,severity)=='digest_only'

conn=sqlite3.connect(':memory:')
conn.execute('PRAGMA foreign_keys=ON')
conn.executescript((R/'migrations/001_core_id_and_external_effects.sql').read_text())
conn.executescript((R/'migrations/003_p0_alerts_and_notifications.sql').read_text())
conn.execute('INSERT INTO p0_incidents VALUES (?,?,?,?,?,?,?)',('inc1','g','BUG-1','active','2026-11-02T00:00Z','2026-11-02T00:00Z',None))
try:
  conn.execute('INSERT INTO p0_incidents VALUES (?,?,?,?,?,?,?)',('inc2','g','BUG-1','active','2026-11-02T00:00Z','2026-11-02T00:00Z',None))
  raise AssertionError('same issue had two active incidents')
except sqlite3.IntegrityError: pass
conn.execute('INSERT INTO p0_alerts VALUES (?,?,?,?,?,?,?,?,?,?)',('a1','inc1',1,'BUG-1','Title','Text','[]','v1','2026-11-02T00:00Z','2026-11-02T00:00Z'))
try:
  conn.execute('INSERT INTO p0_alerts VALUES (?,?,?,?,?,?,?,?,?,?)',('a2','inc1',1,'BUG-1','Title','Text','[]','v1','2026-11-02T00:00Z','2026-11-02T00:00Z'))
  raise AssertionError('duplicated generation')
except sqlite3.IntegrityError: pass
conn.execute('INSERT INTO external_operations (operation_id,kind,target_ref,idempotency_key,request_hash,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',('op1','qq.c2c.send','qq-allowed-user','p0:inc1:g1:qq-allowed-user','hash','prepared','2026-11-02T00:00Z','2026-11-02T00:00Z'))
conn.execute('INSERT INTO p0_alert_deliveries VALUES (?,?,?,?,?,?,?,?)',('del1','a1','qq-c2c','qq-allowed-user','op1','unknown',None,'2026-11-02T00:01Z'))
try:
  conn.execute('INSERT INTO p0_alert_deliveries VALUES (?,?,?,?,?,?,?,?)',('del2','a1','qq-c2c','qq-allowed-user','op1','pending',None,'2026-11-02T00:02Z'))
  raise AssertionError('duplicate pending delivery')
except sqlite3.IntegrityError: pass
print('PASS notification policy: P0-only realtime, JSON schema, incident/alert/delivery uniqueness')

from pathlib import Path
import json,copy
from jsonschema import Draft202012Validator
R=Path(__file__).resolve().parents[1]
s=json.loads((R/'schemas/report-presentation-v1.schema.json').read_text())
Draft202012Validator.check_schema(s)
v=Draft202012Validator(s)
f=json.loads((R/'fixtures/report-presentation-markdown-qq.json').read_text())
assert v.is_valid(f),list(v.iter_errors(f))
bad=copy.deepcopy(f);bad['actions'][2]['section']='bugs'
assert not v.is_valid(bad)
bad=copy.deepcopy(f);bad['actions']=bad['actions'][:2]
assert not v.is_valid(bad)
bad=copy.deepcopy(f);bad['format']='ark'
assert not v.is_valid(bad)
print('PASS: report presentation: fixed ordered 3 actions, markdown only, no ARK')

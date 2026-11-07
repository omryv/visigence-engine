"""Run a reproducible asset script through a locally connected Codex Blender Bridge.

The connection folder/session are supplied explicitly. Credentials are read from
session.json and never written into the repository or printed by this client.
"""
import argparse
import json
import time
import uuid
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('method', choices=['ping', 'scene', 'execute'])
parser.add_argument('--connection', type=Path, required=True)
parser.add_argument('--session', required=True)
parser.add_argument('--script', type=Path)
parser.add_argument('--workspace', type=Path, default=Path(__file__).resolve().parents[2])
args = parser.parse_args()
if args.method == 'execute' and not args.script:
    parser.error('execute requires --script')
if not args.session.isalnum():
    parser.error('session must be an alphanumeric identifier')
root = args.connection / 'sessions' / args.session
session = json.loads((root / 'session.json').read_text())
if not session['connected'] or time.time() - session['heartbeat_at'] > 15:
    raise SystemExit('Blender Bridge is disconnected')
request_id = uuid.uuid4().hex
params = {}
if args.script:
    params['code'] = 'VISIGAMES_ROOT = ' + repr(str(args.workspace.resolve())) + '\n' + args.script.read_text()
request = {'id': request_id, 'protocol': 1, 'token': session['token'],
           'expires_at': time.time() + 900, 'method': args.method, 'params': params}
temporary = root / 'requests' / ('.' + request_id + '.tmp')
temporary.write_text(json.dumps(request))
temporary.replace(root / 'requests' / (request_id + '.json'))
print('Submitted Blender request ' + request_id, flush=True)
response = root / 'responses' / (request_id + '.json')
for _ in range(1800):
    if response.exists():
        result = json.loads(response.read_text())
        print(json.dumps({k:v for k,v in result.items() if k!='result'} | ({'result':result['result'].get('result'),'log_tail':result['result'].get('output','')[-1600:]} if result.get('ok') else {}),indent=2))
        raise SystemExit(0 if result['ok'] else 1)
    time.sleep(.5)
raise SystemExit('Blender request still running: ' + request_id)

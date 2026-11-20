"""Mock SSH; exercise the actual watch incident/recovery state machine. No mail."""
import copy
import json
import pathlib
import subprocess
import time
from datetime import datetime, timezone
from unittest.mock import patch
import gps_watch as watch

cfg=copy.deepcopy(watch.DEFAULTS)
now=time.time()
def sample(severity,codes):
    return subprocess.CompletedProcess([],{'ok':0,'warning':1,'critical':2}[severity],
        json.dumps({'severity':severity,'alerts':codes,'checked_at':datetime.now(timezone.utc).isoformat()}),'private stderr')
with patch.object(watch.subprocess,'run',return_value=sample('critical',['worker_stale'])) as run:
    result=watch.probe_notice_queue('gps-notice-monitor',10)
    assert result==(False,'worker_stale')
    assert run.call_args.args[0][-1]=='gps-notice-monitor' and 'shell' not in run.call_args.kwargs
state={};events=[]
for i in range(3):events+=watch.decide(state,{'notice_queue':(*result,1)},True,now+i*60,cfg)
assert [e['kind'] for e in events]==['opened']
assert not watch.decide(state,{'notice_queue':(*result,1)},True,now+180,cfg)
assert watch.decide(state,{'notice_queue':(*result,1)},True,now+3800,cfg)[0]['kind']=='reminder'
with patch.object(watch.subprocess,'run',return_value=sample('ok',[])):
    recovery=watch.probe_notice_queue('gps-notice-monitor',10)
assert recovery==(True,'queue healthy')
assert not watch.decide(state,{'notice_queue':(*recovery,1)},True,now+3860,cfg)
assert watch.decide(state,{'notice_queue':(*recovery,1)},True,now+3920,cfg)[0]['kind']=='closed'
for output in ['credential=must-not-print',json.dumps({'severity':'ok','alerts':[],'checked_at':'2020-01-01T00:00:00Z'}),json.dumps({'severity':'ok','alerts':['worker_stale'],'checked_at':datetime.now(timezone.utc).isoformat()})]:
    with patch.object(watch.subprocess,'run',return_value=subprocess.CompletedProcess([],0,output,'')):
        assert watch.probe_notice_queue('gps-notice-monitor',10)==(False,'queue probe unavailable or stale')
with patch.object(watch.subprocess,'run') as run:
    assert not watch.probe_notice_queue('-oProxyCommand=bad',10)[0];run.assert_not_called()
assert watch.DEFAULTS['checks']['notice_queue_ssh']==''
report={'mock_ssh_only':True,'no_mail_or_external_send':True,'critical_after_three_checks':True,'repeat_after_one_hour':True,'recover_after_two_checks':True,'invalid_stale_or_secret_output_redacted':True,'default_disabled':True}
print(json.dumps(report))

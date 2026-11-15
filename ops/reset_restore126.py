"""Re-create only the disposable restore clone, then probe immediately."""
import json
import time
import verify_runtime126 as v
from runtime121_control import job

v.stop_api()
for name in ('baseline126.json','stats126-after-baseline.json'):
    path=v.ROOT/'out'/name
    if path.exists():path.rename(path.with_name('initial-'+name))
name='gps_cumulative_restore'
job('recovery',action='drop',database=name)
job('recovery',action='create',database=name)
job('recovery',action='pre',database=name)
t=time.monotonic()
job('recovery',action='restore',database=name)
job('recovery',action='post',database=name)
v.load.save('repeat-restore126',dict(seconds=time.monotonic()-t,database=name,api_budget_seconds=20))
v.snapshot('repeat-fresh',json.loads(v.CONTEXT.read_text())['dsn'])
v.baseline()
import profile_runtime126 as p
p.profile('before-plan',analyze=False)
p.profile('before-default')
p.profile('before-jit-off',jit=False)

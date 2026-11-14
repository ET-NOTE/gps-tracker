"""Run isolated mock-provider tests while probing the API sharing that database."""
import hashlib
import json
import pathlib
import subprocess
import time
import urllib.request

job = pathlib.Path(__file__).resolve().parent
assert str(job) == '/home/etcom-hub/build/gps-provision22-20261108d'
api = json.loads(subprocess.check_output(['docker','inspect','gps-provision22-api-20261108d']))[0]
net = 'gps-provision22-test-20261108d'
assert json.loads(subprocess.check_output(['docker','network','inspect',net]))[0]['Internal']
url = 'http://' + api['NetworkSettings']['Networks'][net]['IPAddress'] + ':3043/gps-tracker/health'
latency = []
failures = 0
with (job/'out/external-all.log').open('w') as log:
    proc = subprocess.Popen(['bash',str(job/'dev22.sh'),'external-all'],stdout=log,stderr=subprocess.STDOUT)
    while proc.poll() is None:
        at = time.monotonic()
        try:
            with urllib.request.urlopen(url,timeout=3) as response:
                assert json.load(response)['db']
            latency.append((time.monotonic()-at)*1000)
        except Exception:
            failures += 1
        time.sleep(.2)
    assert proc.returncode == 0, 'isolated Rust integration failed; inspect external-all.log'
text = (job/'out/external-all.log').read_text()
report = json.loads(text.split('QUEUE_LOAD_REPORT=',1)[1].splitlines()[0])
latency.sort()
report.update(api_sha256=hashlib.sha256((job/'out/gps-tracker-api').read_bytes()).hexdigest(),
              api_health_samples=len(latency),api_health_failures=failures,
              api_health_p95_ms=latency[int((len(latency)-1)*.95)],api_health_max_ms=max(latency))
assert failures == 0 and report['api_health_p95_ms'] < 500
(job/'out/queue-load.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))

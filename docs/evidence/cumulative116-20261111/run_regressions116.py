"""Existing consent oracle, mapping budget and seven real DB boundary tests on112."""
import json
import pathlib
import subprocess

JOB = pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111cumulative116')
assert pathlib.Path(__file__).resolve().parent == JOB
TAG = '20261111cumulative116'
assert json.loads((JOB / 'out/cumulative116.json').read_text())['runtime_ready_for_regressions']
assert all(r['exit'] == 0 for r in json.loads((JOB / 'out/regressions116.json').read_text()))
code = (JOB / 'src/ops/test_subject_ancestry109.py').read_text().replace('20261108cumulative109', TAG)
code = code.replace("one('SELECT max(version) FROM _sqlx_migrations')==109", "one('SELECT max(version) FROM _sqlx_migrations')==112")
code = code.replace('[108,109]', '[108,112]').replace('populated108->109:', 'populated108->112:')
(JOB / 'test_subject_ancestry109.py').write_text(code)
code = (JOB / 'src/ops/benchmark_subject_queries109.py').read_text().replace('20261108cumulative109', TAG).replace("'schema':109", "'schema':112")
(JOB / 'benchmark_subject_queries109.py').write_text(code)
results = []
for name, args in [('ancestry109-on112', ['suite', 'test_subject_ancestry109.py']),
                   ('mapping109-on112', ['suite', 'benchmark_subject_queries109.py']),
                   ('external-all', ['external-all']), ('external-boundary', ['external-boundary'])]:
    with (JOB / 'out' / (name + '.log')).open('w') as log:
        result = subprocess.run(['bash', str(JOB / 'dev22.sh'), *args], stdout=log, stderr=subprocess.STDOUT)
    results.append({'check': name, 'exit': result.returncode})
    (JOB / 'out/additional116-tests.json').write_text(json.dumps(results, indent=2) + '\n')
    assert result.returncode == 0, name
    print('PASS', name, flush=True)

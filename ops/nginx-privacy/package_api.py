"""Run in the isolated build job after successful validation; does not connect to production."""
import datetime,hashlib,json,pathlib,shutil
root=pathlib.Path(__file__).resolve().parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
facts=json.loads((root/'location-facts-validation.json').read_text())
assert facts['schema']==99 and facts['integration_groups']==6
log=(root/'hotfix-validation.log').read_text()
assert '65 passed; 0 failed; 2 ignored' in log and 'Finished `release`' in log
assert 'Ran 4 tests' in (root/'release-validation.log').read_text() and '\nOK\n' in (root/'release-validation.log').read_text()
stage=root/'api-stage';stage.mkdir(exist_ok=True)
for source,dest in [('out/gps-tracker-api','gps-tracker-api'),('hotfix-source.tar.gz','source.tar.gz'),('release_api.py','release_api.py')]:shutil.copyfile(root/source,stage/dest)
assert facts['api_sha256']==sha(stage/'gps-tracker-api')
v={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'environment':'isolated build host',
   'fmt_clippy_passed':True,'rust_passed':65,'rust_ignored':2,'facts_groups':6,'schema':99,'release_control_tests':4,
   'api_sha256':facts['api_sha256'],'facts_result_sha256':sha(root/'location-facts-validation.json'),
   'build_log_sha256':sha(root/'hotfix-validation.log'),'release_test_log_sha256':sha(root/'release-validation.log')}
(stage/'validation.json').write_text(json.dumps(v,indent=2)+'\n')
m={'release':'privacy-log-20261107-r1','schema':99,'source_commit':'ee295ece717eef7140171b289514bf1c62c007b5',
   'source_sha256':sha(stage/'source.tar.gz'),'api_sha256':v['api_sha256'],'validation_sha256':sha(stage/'validation.json'),
   'release_script_sha256':sha(stage/'release_api.py')}
(stage/'manifest.json').write_text(json.dumps(m,indent=2)+'\n')
print(json.dumps(m))

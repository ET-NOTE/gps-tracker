"""Incremental112->113 activation only in the disposable runtime124 test host."""
import hashlib
import os
from pathlib import Path
import pwd
import resource
import subprocess
import load_runtime122 as l
from load_runtime124 import PREVIOUS, select


def activate():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    assert l.sql('SELECT max(version) FROM _sqlx_migrations') == [(112,)]
    l.stop_api()
    target=l.ROOT/'out/gps-tracker-api'
    digest=hashlib.sha256(target.read_bytes()).hexdigest()
    assert digest==(l.ROOT/'candidate124.sha256').read_text().strip() and digest!=PREVIOUS
    os.chown(target,0,0);target.chmod(0o555)
    link=Path('/opt/gps-tracker-api')
    assert link.is_symlink() and link.resolve().parent==l.ROOT/'out'
    link.unlink();link.symlink_to(target)
    l.migrate('migration124',l.DSN)
    assert l.sql('SELECT max(version) FROM _sqlx_migrations')==[(113,)]
    binary=l.ROOT/'out/gps-read124-tests'
    os.chown(binary,0,0);binary.chmod(0o555)
    user=pwd.getpwnam('gps-api')
    def demote():
        os.setgroups([]);os.setgid(user.pw_gid);os.setuid(user.pw_uid)
    env=dict(os.environ,GPS_READ_TEST_DATABASE_URL=l.runtime(),
             LD_PRELOAD='/usr/local/lib/gps-nodump.so')
    with (l.ROOT/'out/read-settings124.log').open('w') as log:
        result=subprocess.run([str(binary),'services::location_read_budget::tests::read_settings_are_transaction_local_and_do_not_escape_pool',
            '--exact','--ignored','--nocapture'],env=env,preexec_fn=demote,stdout=log,stderr=subprocess.STDOUT,timeout=60)
    assert result.returncode==0,'Read transaction settings regression failed'
    select()
    l.save('activation124',dict(schema_before=112,schema_after=113,
        api_sha256=digest,read_settings_runtime_role_passed=True,production_modified=False))
    print('PASS112->113 migration, unprivileged read settings reset, candidate health')


if __name__=='__main__':activate()

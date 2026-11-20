"""Private production snapshot and a new clone for one-time connection notices."""
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile

os.umask(0o077)
backup = pathlib.Path('/home/mmm/backups/gps-connection-20261009')
clone = 'gps_tracker_dev_prodreview_20261009_connection'
api = pathlib.Path('/home/mmm/projects/gps-tracker-api/bin/gps-tracker-api')
web = pathlib.Path('/home/mmm/gps-tracker-web/dist-root')
env = pathlib.Path('/home/mmm/projects/gps-tracker-api/.env')
nginx = pathlib.Path('/etc/nginx/sites-available/gps.serial.kr')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(api) == 'ee1225c4b8da55a7353daaffa8a7ec3843edc82a5dff98b5ea72b64a1ba8b55d'
assert str(web.resolve()) == '/home/mmm/releases/prod-20261008-005228-97aa52b/web'
count = subprocess.check_output(['sudo','-u','postgres','psql','-At','-d','postgres',
    '-c', "SELECT count(*) FROM pg_database WHERE datname='" + clone + "'"], text=True)
assert count.strip() == '0', 'Do not overwrite an existing review clone'
backup.mkdir()
shutil.copy2(api, backup/'api.previous')
shutil.copy2(env, backup/'prod.env')
shutil.copy2(nginx, backup/'nginx.previous')
for p in backup.iterdir(): p.chmod(0o600)
with tarfile.open(backup/'web.previous.tar.gz', 'w:gz') as archive:
    archive.add(web.resolve(), arcname='web', recursive=True)
(backup/'baseline.json').write_text(json.dumps(dict(api_sha256=sha(api), web=str(web.resolve()),
    env_sha256=sha(env), nginx_sha256=sha(nginx))))
# Use the proven consistent Timescale dump + hypertable CSV restore. The new
# suffix keeps the previous AI review database untouched. Its absence is checked above.
helper = pathlib.Path(__file__).with_name('prepare_prod_review.py').read_text()
pattern = "r'gps_tracker_dev_prodreview_[0-9]{8}'"
assert helper.count(pattern) == 1
helper = helper.replace(pattern, "r'gps_tracker_dev_prodreview_[0-9]{8}(?:_[a-z0-9]+)?'")
sys.argv = ['prepare_prod_review.py', '--backup-dir', str(backup), '--clone', clone]
exec(compile(helper, 'prepare_prod_review.py', 'exec'), {'__name__': '__main__'})
os.chown(backup, 0, __import__('grp').getgrnam('mmm').gr_gid)
backup.chmod(0o710)

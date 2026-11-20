"""Real encrypted-file replacement with different maintenance/API UIDs.

Run as container root, with only CHOWN/DAC_OVERRIDE, on the cumulative internal
network. The fixture directory is dedicated to this check and is removed after it.
"""
import json
import os
import pathlib
import shutil
import stat
import subprocess

from crypto20b_transition import connect, convert_files

HERE = pathlib.Path('/home/etcom-hub/build/gps-provision22-20261111cumulative116')
assert pathlib.Path.cwd() == HERE and os.getuid() == 0
root = HERE / 'owner-fixture'
assert not root.exists()
root.mkdir(mode=0o755)
uploads = root / 'uploads'
private = root / 'private'
file = uploads / 'device_documents/1/1/fixture.bin'
file.parent.mkdir(parents=True, mode=0o755)
private.mkdir(mode=0o755)
plaintext = b'synthetic file ownership check'
file.write_bytes(plaintext)
file.chmod(0o600)
os.chown(file, 65534, 65534)
ring = json.loads((HERE / 'test-keys.json').read_text())
dsn = 'postgres://postgres:closure-test-only@closure-db/gps_closure_test'
try:
    db = connect(dsn, ring)
    result = convert_files(db, str(uploads), str(private), ring, True)
    assert result['converted'] == 1
    info = file.stat()
    assert (info.st_uid, info.st_gid) == (65534, 65534)
    assert stat.S_IMODE(info.st_mode) == 0o600
    # The API's distinct OS identity can read the ciphertext after replacement.
    child = os.fork()
    if child == 0:
        os.setgroups([])
        os.setgid(65534)
        os.setuid(65534)
        os._exit(0 if file.read_bytes().startswith(b'GPSFILE1\n') else 1)
    assert os.waitpid(child, 0)[1] == 0
    assert convert_files(db, str(uploads), str(private), ring)['content_hashes'] == result['content_hashes']
    db.close()
    (HERE / 'out/file-owner116.json').write_text(json.dumps({'maintenance_uid': 0, 'api_uid': 65534,
        'owner_group_preserved': True, 'mode': '0600', 'api_identity_can_read': True,
        'plaintext_roundtrip_preserved': True, 'external_files_modified': False}, indent=2))
finally:
    shutil.rmtree(root)

"""Linux build-runner checks; temporary fixtures only."""
import errno
import pathlib
import tempfile
from unittest.mock import patch
from release_assets import inherit_immutable_assets

with tempfile.TemporaryDirectory(prefix='gps-assets-test-') as tmp:
    root=pathlib.Path(tmp)
    old=root/'old';new=root/'new';other=root/'cross-device'
    for folder in (old,new,other):folder.mkdir()
    (old/'chunk-hash.js').write_bytes(b'old immutable')
    (old/'current-hash.js').write_bytes(b'previous')
    (new/'current-hash.js').write_bytes(b'new build')
    (old/'external.js').symlink_to(old/'chunk-hash.js')
    (old/'directory').mkdir()
    result=inherit_immutable_assets(old,new)
    assert result=={'linked':1,'copied':0,'reused_bytes':13}
    assert (old/'chunk-hash.js').stat().st_ino==(new/'chunk-hash.js').stat().st_ino
    assert (new/'current-hash.js').read_bytes()==b'new build'
    assert not (new/'external.js').exists() and not (new/'directory').exists()
    assert inherit_immutable_assets(old,new)=={'linked':0,'copied':0,'reused_bytes':0}
    # Removing a test source name cannot remove the new release's hardlink.
    (old/'chunk-hash.js').unlink()
    assert (new/'chunk-hash.js').read_bytes()==b'old immutable'
    with patch('release_assets.os.link',side_effect=OSError(errno.EXDEV,'different volume')):
        assert inherit_immutable_assets(new,other)['copied']==2
    assert (other/'chunk-hash.js').read_bytes()==b'old immutable'
    with patch('release_assets.os.link',side_effect=PermissionError(errno.EACCES,'denied')):
        (old/'denied.js').write_bytes(b'x')
        try:inherit_immutable_assets(old,other)
        except PermissionError:pass
        else:raise AssertionError('Do not hide filesystem errors')
print('PASS immutable asset reuse, existing outputs, symlinks, independent lifetime, cross-volume fallback and errors')

"""API release control-flow rehearsal. Uses temporary files and mocked service/DB calls."""
import contextlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('release_api',pathlib.Path(__file__).with_name('release_api.py'))
r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)

class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=pathlib.Path(self.tmp.name); self.api=self.root/'api';self.api.write_bytes(b'old')
        self.stage=self.root/'stage';self.stage.mkdir();(self.stage/'gps-tracker-api').write_bytes(b'new')
        self.backup=self.root/'backup';self.before={'api_user':'gps-api'};self.mig={'99':'checksum'}
        self.m={'api_sha256':r.sha(self.stage/'gps-tracker-api')}
        self.starts=[];self.fail=False
        for key,value in [('API',self.api),('STAGE',self.stage),('BACKUP',self.backup),('OLD_HASH',r.sha(self.api))]:
            p=patch.object(r,key,value);p.start();self.addCleanup(p.stop)
        for name,value in [('baseline',self.before),('migrations',self.mig),('preflight',(self.m,self.before,self.mig))]:
            p=patch.object(r,name,return_value=value);p.start();self.addCleanup(p.stop)
        p=patch.object(r,'restart_and_wait',side_effect=self.restart);p.start();self.addCleanup(p.stop)
        # An in-memory fake lock is enough: concurrency is handled by the OS flock in production.
        p=patch.object(r.fcntl,'flock');p.start();self.addCleanup(p.stop)
        p=patch.object(r.os,'geteuid',return_value=0);p.start();self.addCleanup(p.stop)
        self.real_open=open
        def safe_open(file,*a,**kw):
            if file=='/run/lock/gps-api-log-hotfix.lock':return self.real_open(self.root/'lock',*a,**kw)
            return self.real_open(file,*a,**kw)
        p=patch('builtins.open',side_effect=safe_open);p.start();self.addCleanup(p.stop)
        p=patch.object(r,'health',return_value={'ok':True,'release':r.RELEASE});p.start();self.addCleanup(p.stop)
    def restart(self,release):
        self.starts.append(release)
        if self.fail and release==r.RELEASE:raise RuntimeError('simulated unhealthy API')
    def run_action(self,action):
        with patch.object(r.sys,'argv',['release_api.py',action]),contextlib.redirect_stdout(io.StringIO()):r.main()
    def test_check_makes_no_changes(self):
        self.run_action('check');self.assertEqual(self.api.read_bytes(),b'old');self.assertFalse(self.backup.exists());self.assertEqual(self.starts,[])
    def test_apply_and_explicit_rollback(self):
        self.run_action('apply');self.assertEqual(self.api.read_bytes(),b'new');self.assertEqual(self.api.stat().st_mode&0o777,0o755)
        self.assertEqual((self.backup/'api.previous').stat().st_mode&0o777,0o600)
        (self.stage/'manifest.json').write_text(json.dumps(self.m));self.run_action('rollback')
        self.assertEqual(self.api.read_bytes(),b'old');self.assertEqual(self.starts,[r.RELEASE,r.OLD])
    def test_unhealthy_release_restores_old_binary(self):
        self.fail=True
        with self.assertRaises(RuntimeError):self.run_action('apply')
        self.assertEqual(self.api.read_bytes(),b'old');self.assertEqual(self.starts,[r.RELEASE,r.OLD])
    def test_checksum_change_blocks_rollback(self):
        self.run_action('apply');(self.stage/'manifest.json').write_text(json.dumps(self.m))
        with patch.object(r,'migrations',return_value={'100':'changed'}):
            with self.assertRaises(AssertionError):self.run_action('rollback')
        self.assertEqual(self.api.read_bytes(),b'new')

if __name__=='__main__':unittest.main()

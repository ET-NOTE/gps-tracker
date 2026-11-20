"""Read-only GPS build artifact inventory; no rotation or deletion."""
from datetime import datetime,timezone
import json
from pathlib import Path
import shutil
import subprocess

ROOT=Path('/home/etcom-hub/build')


def size(path):
    return int(subprocess.check_output(['du','-sx','-B1',str(path)],text=True).split()[0])


def run():
    assert subprocess.check_output(['hostname'],text=True).strip()=='etcom-hub'
    rows=[dict(name=p.name,allocated_bytes=size(p)) for p in ROOT.glob('gps-*') if p.is_dir() and not p.is_symlink()]
    cache=ROOT/'gps-tracker/cache'
    data=dict(captured_at=datetime.now(timezone.utc).isoformat(),read_only=True,
        disk_free_bytes=shutil.disk_usage(ROOT).free,directories=sorted(rows,key=lambda r:r['allocated_bytes'],reverse=True),
        cache={p.name:size(p) for p in cache.iterdir() if p.is_dir() and not p.is_symlink()},
        action='inventory only; no deletion or retention policy activation')
    (ROOT/'gps-runtime120-20261113/out/build-storage.json').write_text(json.dumps(data,indent=2))
    print(json.dumps(dict(gps_directory_count=len(rows),gps_allocated_gib=round(sum(r['allocated_bytes'] for r in rows)/1024**3,2),
                         cache_gib=round(size(cache)/1024**3,2),disk_free_gib=round(data['disk_free_bytes']/1024**3,2))))


if __name__=='__main__':run()

"""Generate the candidate PDF/global-memory units. No production install action.

The existing pdf_service.py is kept as the historical round-1 installer. These
units require the new renderer's `service` mode and API status-8 support.
"""
from pathlib import Path
import pdf_service

SLICE = 'gps-workload-pdf.slice'
LOCK = '/run/gps-pdf-budget/render.lock'
PDF_BUDGET = 896 * 1024**2


def files(site, total_mib=4096):
    assert 3072 <= total_mib <= 8192
    result = pdf_service.files(site)
    proof = site.units / pdf_service.PROOF_UNIT
    result[proof] = result[proof].replace('[Service]', '[Service]\nSlice='+SLICE)
    socket = site.units / pdf_service.SOCKET_UNIT
    result[socket] = result[socket].replace('Requires=', 'Requires=gps-pdf-budget.service ')
    result[socket] = result[socket].replace('After=', 'After=gps-pdf-budget.service ')
    worker = site.units / pdf_service.RENDER_UNIT
    result[worker] = result[worker].replace('CollectMode=',
        'BindsTo=gps-pdf-render.socket gps-pdf-budget.service\nAfter=gps-pdf-budget.service\nPartOf=gps-pdf-render.socket\nCollectMode=')
    result[worker] = result[worker].replace('ExecStart='+str(site.renderer), 'ExecStart='+str(site.renderer)+' service')
    result[worker] = result[worker].replace('[Service]', '[Service]\nSlice='+SLICE+'\nKillMode=control-group')
    result[worker] += 'BindReadOnlyPaths='+LOCK+'\n'
    result[site.units/'gps-workload.slice'] = f'''[Unit]
Description=GPS total workload budget (candidate; capacity acceptance required)
[Slice]
MemoryAccounting=yes
MemoryMax={total_mib}M
MemorySwapMax=0
TasksMax=256
'''
    result[site.units/SLICE] = f'''[Unit]
Description=GPS PDF aggregate budget, including supervisors and self-test
[Slice]
MemoryAccounting=yes
MemoryMax={PDF_BUDGET}
MemorySwapMax=0
TasksMax=48
'''
    # /run is reset on reboot, but NOT on service restart. Never replace the
    # inode of a live flock; otherwise old and new workers could both enter.
    result[site.units/'gps-pdf-budget.service'] = '''[Unit]
Description=GPS PDF stable admission lock
Before=gps-pdf-render.socket
[Service]
Type=oneshot
RemainAfterExit=yes
User=root
Group=gps-pdf
RuntimeDirectory=gps-pdf-budget
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
ExecStart=/usr/bin/python3 /usr/local/lib/pdf_budget120.py
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/run/gps-pdf-budget
PrivateNetwork=yes
MemoryMax=32M
MemorySwapMax=0
LimitCORE=0
Slice=gps-workload-pdf.slice
'''
    return result


def budget_script():
    return '''import grp, os, stat
from pathlib import Path
base=Path('/run/gps-pdf-budget')
assert base.is_dir() and not base.is_symlink()
s=base.stat()
assert s.st_uid==0 and not s.st_mode & 0o022
p=base/'render.lock'
try:
    fd=os.open(p, os.O_RDONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW, 0o440)
except FileExistsError:
    fd=os.open(p, os.O_RDONLY|os.O_NOFOLLOW)
try:
    s=os.fstat(fd)
    assert stat.S_ISREG(s.st_mode) and s.st_uid==0 and s.st_nlink==1 and s.st_size==0 and not s.st_mode & 0o022
    os.fchown(fd, 0, grp.getgrnam('gps-pdf').gr_gid)
    os.fchmod(fd, 0o440)
finally:
    os.close(fd)
'''

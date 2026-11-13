"""Real socket/systemd lifetime tests; run only inside the labelled 120 host."""
import concurrent.futures
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import socket
import struct
import subprocess
import time

ADDRESS='/run/gps-pdf-render/render.sock'
LOCK=Path('/run/gps-pdf-budget/render.lock')
MAGIC=b'GPSPDF1\n'
RESULTS=[]


def cmd(*args,check=True):
    return subprocess.run(args,capture_output=True,text=True,check=check).stdout.strip()


def processes():
    result={}
    for p in Path('/proc').glob('[0-9]*'):
        try:
            if (p/'comm').read_text().strip()!='gps-pdf-render':continue
            status=dict(line.split(':',1) for line in (p/'status').read_text().splitlines() if ':' in line)
            result[int(p.name)]=dict(ppid=int(status['PPid']),state=status['State'].strip(),
                seccomp=int(status['Seccomp']),filters=int(status.get('Seccomp_filters','0')),
                caps=status['CapEff'].strip())
        except FileNotFoundError:pass
    return result


def wait(predicate,seconds=3):
    until=time.monotonic()+seconds
    while time.monotonic()<until:
        value=predicate()
        if value:return value
        time.sleep(.02)
    raise AssertionError(('condition timed out',processes()))


def idle():wait(lambda:not processes())


def check(name,**details):
    RESULTS.append(dict(name=name,**details));print('PASS '+name,flush=True)


def connect():
    s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM);s.settimeout(20);s.connect(ADDRESS);return s


def hold():
    s=connect();wait(lambda:len(processes())==2)
    ps=processes();child=next(pid for pid,v in ps.items() if v['ppid'] in ps)
    parent=ps[child]['ppid'];return s,parent,child


def response(s):
    data=b''
    try:
        while True:
            part=s.recv(65536)
            if not part:break
            data+=part
    except ConnectionResetError:
        assert data==MAGIC+struct.pack('>I',8),data[:32]
    return data


def document():
    content='1 0 0 rg 0 0 100 100 re f'
    bodies=['<</Type/Catalog/Pages 2 0 R>>','<</Type/Pages/Kids[3 0 R]/Count 1>>',
            '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>',
            f'<</Length {len(content)}>>\nstream\n{content}\nendstream']
    data=b'%PDF-1.5\n';offsets=[]
    for i,body in enumerate(bodies,1):
        offsets.append(len(data));data+=f'{i} 0 obj\n{body}\nendobj\n'.encode()
    xref=len(data);data+=b'xref\n0 5\n0000000000 65535 f \n'+b''.join(f'{o:010} 00000 n \n'.encode() for o in offsets)
    return data+f'trailer\n<</Size 5/Root 1 0 R>>\nstartxref\n{xref}\n%%EOF\n'.encode()


def page():
    idle();body=document()
    with connect() as s:
        s.sendall(MAGIC+struct.pack('>II',1,len(body))+body);s.shutdown(socket.SHUT_WR);reply=response(s)
    assert reply[:12]==MAGIC+bytes(4),reply[:32]
    width,height,pages,_,_=struct.unpack('>IIIII',reply[12:32])
    assert pages==1 and len(reply)==32+width*height*3
    assert reply[32:35]==bytes([255,0,0])
    assert reply[32+(width-1)*3:35+(width-1)*3]==bytes([255,255,255])
    idle();return width,height


def summary():
    cg=cmd('systemctl','show','gps-workload-pdf.slice','-p','ControlGroup','--value')
    path=Path('/sys/fs/cgroup'+cg)
    return {k:(path/k).read_text().strip() for k in ('memory.max','memory.peak','memory.events','memory.swap.max','memory.swap.current','pids.max') if (path/k).exists()}


def run():
    assert Path('/.dockerenv').exists() and Path('/etc/runtime120-test-only').read_text()=='synthetic'
    assert cmd('systemctl','is-active','gps-pdf-render.socket')=='active'
    check('normal write half-close renders exact red and white pixels',size=page())
    inode=LOCK.stat().st_ino
    s,parent,child=hold();ps=processes()
    assert ps[child]['filters']>ps[parent]['filters'] and ps[child]['caps']=='0000000000000000',ps
    with LOCK.open('rb') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:pass
        else:raise AssertionError('worker has no global lock')
    # Independent connections cannot enter, even before any PDF bytes arrive.
    def busy(_):
        start=time.monotonic()
        with connect() as other:
            other.sendall(b'GPSPDF1\n');r=response(other)
        assert r==MAGIC+struct.pack('>I',8),r
        return round(time.monotonic()-start,3)
    for _ in range(3):
        with concurrent.futures.ThreadPoolExecutor(2) as pool:times=list(pool.map(busy,range(2)))
        assert child in processes() and all(t<2 for t in times),times
    check('global lock rejects six independent requests; worker has stricter seccomp',worker=ps[child],max_busy_seconds=max(times))
    start=time.monotonic();s.close();idle()
    check('disconnect during request read kills and reaps worker',seconds=round(time.monotonic()-start,3))
    page()
    # Freeze the sandboxed child, then finish sending and cancel while work is
    # outstanding. Unlike a fast PDF this makes lifetime assertions deterministic.
    s,parent,child=hold();os.kill(child,signal.SIGSTOP)
    body=document();s.sendall(MAGIC+struct.pack('>II',1,len(body))+body);s.shutdown(socket.SHUT_WR)
    time.sleep(.1);assert child in processes()
    start=time.monotonic();s.close();idle();page()
    check('disconnect with pending page kills a stopped worker and permits recovery',seconds=round(time.monotonic()-start,3))
    s,parent,child=hold();start=time.monotonic();r=response(s);s.close();idle();assert not r,r
    elapsed=time.monotonic()-start;assert 12<=elapsed<15,elapsed
    check('slow open peer is terminated by 13-second deadline',seconds=round(elapsed,3));page()
    s,parent,child=hold();os.kill(child,signal.SIGSTOP);os.kill(parent,signal.SIGKILL)
    wait(lambda:child not in processes());s.close();idle();page()
    check('supervisor SIGKILL kills stopped child; inherited lock cannot leak')
    s,parent,child=hold();cmd('systemctl','stop','gps-pdf-render.socket');idle();s.close()
    cmd('systemctl','start','gps-pdf-render.socket');assert LOCK.stat().st_ino==inode;page()
    check('socket stop cancels whole unit; restart preserves lock inode')
    s,parent,child=hold();cmd('systemctl','restart','gps-pdf-budget.service');idle();s.close()
    cmd('systemctl','start','gps-pdf-render.socket');assert LOCK.stat().st_ino==inode;page()
    check('budget restart terminates active work without replacing live lock')
    cmd('systemctl','stop','gps-pdf-render.socket');LOCK.chmod(0o660)
    # Starting an instance with an unsafe lock fails without reading a PDF.
    cmd('systemctl','start','gps-pdf-render.socket')
    with connect() as s:r=response(s)
    assert not r;idle();LOCK.chmod(0o440);page()
    check('writable lock is rejected; safe permissions restore service')
    check('all lifetime cases finish without residual renderers',resources=summary())
    Path('/tmp/runtime120-service-results.json').write_text(json.dumps(dict(cases=RESULTS,renderer_sha256=hashlib.sha256(Path('/opt/gps-pdf-render').read_bytes()).hexdigest()),indent=2))


if __name__=='__main__':run()

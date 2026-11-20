#!/usr/bin/env python3
"""Real TCP checks in two isolated namespaces, using the reviewed filter snapshot."""
import ipaddress, json, os, pathlib, socket, subprocess, sys

ROOT=pathlib.Path('/var/lib/gps-security113-20261111')
def run(*args):return subprocess.run(args,check=True,capture_output=True,text=True)

def client(office):
    print(os.getpid(),flush=True);input()  # parent moves only its private veth
    for args in [('link','set','lo','up'),('link','set','s113peer','up'),
                 ('addr','add',office+'/32','dev','s113peer'),
                 ('addr','add','192.0.2.20/32','dev','s113peer'),
                 ('addr','add','2001:db8:113::2/64','dev','s113peer','nodad'),
                 ('route','add','192.0.2.10/32','dev','s113peer')]:run('ip',*args)
    cases=[(office,22,True),('192.0.2.20',22,False),
           (office,80,True),('192.0.2.20',80,True),
           (office,443,True),('192.0.2.20',443,True),
           (office,5432,True),('192.0.2.20',5432,False),
           ('2001:db8:113::2',22,False),('2001:db8:113::2',443,True),
           ('2001:db8:113::2',5432,False)]
    results=[]
    for source,port,expected in cases:
        v6=':' in source;dest='2001:db8:113::1' if v6 else '192.0.2.10'
        s=socket.socket(socket.AF_INET6 if v6 else socket.AF_INET,socket.SOCK_STREAM)
        s.settimeout(1);s.bind((source,0))
        try:s.connect((dest,port));accepted=True;detail='connected'
        except socket.timeout:accepted=False;detail='timed out (DROP)'
        except OSError as e:raise RuntimeError('unexpected socket error, not a DROP proof') from e
        finally:s.close()
        results.append({'source':source,'port':port,'expected_allowed':expected,'actual_allowed':accepted,'detail':detail})
    print(json.dumps(results),flush=True)

def main():
    plan=json.loads((ROOT/'plan.json').read_text());office=plan['office']
    assert os.geteuid()==0 and os.readlink('/proc/self/ns/net')!=plan['netns']
    if len(sys.argv)>1 and sys.argv[1]=='client':return client(office)
    run('ip','link','set','lo','up')
    for tool,name in [('iptables-restore','4'),('ip6tables-restore','6')]:
        subprocess.run([tool,'--wait','5'],input=(ROOT/f'kernel{name}.after').read_text(),text=True,check=True)
    run('ip','link','add','s113server','type','veth','peer','name','s113peer')
    proc=subprocess.Popen(['unshare','-n','python3',__file__,'client'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    listeners=[]
    try:
        pid=int(proc.stdout.readline().strip());run('ip','link','set','s113peer','netns',str(pid))
        for args in [('link','set','s113server','up'),('addr','add','192.0.2.10/32','dev','s113server'),
                     ('addr','add','2001:db8:113::1/64','dev','s113server','nodad'),
                     ('route','add',office+'/32','dev','s113server'),('route','add','192.0.2.20/32','dev','s113server')]:run('ip',*args)
        for v6 in (False,True):
            for port in (22,80,443,5432):
                s=socket.socket(socket.AF_INET6 if v6 else socket.AF_INET,socket.SOCK_STREAM)
                if v6:s.setsockopt(socket.IPPROTO_IPV6,socket.IPV6_V6ONLY,1)
                s.bind(('2001:db8:113::1' if v6 else '192.0.2.10',port));s.listen(20);listeners.append(s)
        output,error=proc.communicate('ready\n',timeout=25)
        assert proc.returncode==0,error
        results=json.loads(output);assert all(x['expected_allowed']==x['actual_allowed'] for x in results),results
        print(json.dumps({'scope':'two isolated network namespaces; real TCP; no packets sent to external hosts','pass':True,'cases':results},indent=2))
    finally:
        if proc.poll() is None:proc.kill();proc.wait()
        for s in listeners:s.close()

if __name__=='__main__':main()

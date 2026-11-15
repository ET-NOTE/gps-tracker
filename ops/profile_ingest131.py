"""Allowlisted numeric stages from one exact synthetic API invocation."""
import json
import re
import load_runtime131 as l

FIELDS=('total_ms','admission_ms','parse_ms','pool_begin_ms','auth_ms','hardware_lock_ms',
        'sim_lock_ms','device_lock_ms','privacy_ms','collection_ms','metadata_ms','batch_ms',
        'store_ms','publish_ms','geofence_ms','lifecycle_ms','command_ms','binding_ms','sign_ms','commit_ms')


def capture(label):
    invocation=l.command('systemctl','show','gps121-api','-p','InvocationID','--value')
    rows=[]
    for line in l.command('journalctl','_SYSTEMD_INVOCATION_ID='+invocation,'-o','cat','--no-pager').splitlines():
        if 'device ingest phases' not in line:continue
        line=re.sub(r'\x1b\[[0-9;]*m','',line)
        row=dict(completed=re.search(r'\bcompleted=(true|false)',line)[1]=='true',
            last_phase=re.search(r'\blast_phase=([A-Za-z]+)',line)[1])
        for key in FIELDS:
            row[key]=float(re.search(r'\b'+key+r'=([0-9.eE+-]+)',line)[1]);assert row[key]>=0
        rows.append(row)
    assert rows,'Instrumented API required'
    done=[r for r in rows if r['completed']]
    value=dict(service_invocation=invocation,rows=rows,completed=len(done),unfinished=len(rows)-len(done),
        stages={key:l.b.stats([r[key] for r in done]) for key in FIELDS},
        slowest=sorted(done,key=lambda r:r['total_ms'],reverse=True)[:30],
        scope='Exclusive wall-clock stages including awaits. pool_begin includes BEGIN; store includes triggers and commit. Never add component percentiles.',
        captured_before_quiet_queries=True,production_modified=False)
    l.save('ingest-profile131-'+label,value)
    print('PASS131 fixed numeric ingest profile',label,len(rows),flush=True)

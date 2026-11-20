"""Audit recorded load failures without changing the original acceptance gate."""
from collections import Counter
import hashlib
import json
import re
import sys
import load_runtime130 as l


def audit(label):
    assert label.startswith(('baseline-','candidate-'))
    x=json.loads((l.ROOT/'out'/f'{label}-130.json').read_text())
    requests=x['ingest']['requests'];sent=[r for r in requests if not r['missed']]
    missed=[r for r in requests if r['missed']]
    pairs=[(r['device'],r['slot']) for r in requests]
    assert len(pairs)==len(set(pairs))
    unaccounted=x['ingest']['planned']-len(requests)
    assert unaccounted>=0 and all(0<=d<8 and 0<=s<x['seconds'] for d,s in pairs)
    assert not x['errors'] and all(r['status']==200 for r in sent)
    ids=[r['device_id'] for r in x['saved_ingest']];assert len(ids)==8
    counters=[]
    for i,did in enumerate(ids):
        expected=sorted(r['slot']+1 for r in sent if r['device']==i)
        actual=[r[0] for r in l.sql('SELECT device_uptime_s FROM location_records WHERE device_id=%s ORDER BY device_uptime_s',(did,))]
        assert actual==expected,(label,i,len(actual),len(expected))
        assert len(actual)==x['saved_ingest'][i]['rows']
        counters.append(dict(device=i,device_id=did,stored=len(actual),
            exact_sent_counter_set_matches=True,counter_sha256=hashlib.sha256(json.dumps(actual).encode()).hexdigest()))
    assert x['services_before']==x['services_after']
    events={}
    for name in set(x['before'])&set(x['after']):
        parse=lambda v:dict((k,int(n)) for k,n in (line.split() for line in v.splitlines()))
        before=parse(x['before'][name]['memory.events']);after=parse(x['after'][name]['memory.events'])
        events[name]={k:after[k]-before[k] for k in before}
        assert events[name]['oom']==events[name]['oom_kill']==0
        assert x['after'][name]['memory.swap.current']=='0'
    assert x['health']['statuses'].keys()=={'200'}
    assert x['pdf']['completed']>=10 and x['cleanup']['completed']>=10
    assert x['full_month_traversals'] and all(w['points']==89280 and w['pages']==18 for w in x['full_month_traversals'])
    assert all(set(v['statuses'])<={'200','429'} and v['latency']['count']>0 for v in x['per_route'].values())
    if x['workers']==8:assert set(x['per_route'])=={name for name,_ in l.b.routes(l.b.fixture()['devices'][0]['device_id'])}
    temp=json.loads((l.ROOT/'out'/('temp130-'+label+'.json')).read_text())
    assert temp['peak_bytes']<temp['cap_bytes']

    # Use the recorded service invocation, including one that has already stopped.
    invocation=x['services_before']['gps121-api']['InvocationID'];rows=[]
    for line in l.command('journalctl','_SYSTEMD_INVOCATION_ID='+invocation,'-o','cat','--no-pager').splitlines():
        if 'location read phases' not in line:continue
        line=re.sub(r'\x1b\[[0-9;]*m','',line);row={}
        for key in ('class','outcome','last_phase'):row[key]=re.search(r'\b'+key+r'="([a-z]+)"',line)[1]
        for key in ('admission_ms','pool_ms','setup_ms','scope_ms'):
            row[key]=float(re.search(r'\b'+key+r'=([0-9.eE+-]+)',line)[1]);assert row[key]>=0
        rows.append(row)
    assert rows
    timing_path=l.ROOT/'out'/('timings124-'+label+'-130.json')
    # A successful load already captured timings before its quiet equivalence
    # queries, even when capacity fails. Preserve that capture; a later audit
    # must not mix quiet queries into the measured load.
    existing_timing=timing_path.exists()
    if not existing_timing:
        l.save('timings124-'+label+'-130',dict(rows=rows,service_invocation=invocation,
            allowlisted_numeric_fields_only=True,scope_note='Transaction-held scope, not pure SQL; excludes background cancel cleanup'))
    result=dict(label=label,planned=x['ingest']['planned'],sent=len(sent),missed=len(missed),unaccounted=unaccounted,
        all_sent_stored=True,devices=counters,capacity_passed=len(sent)==x['ingest']['planned'] and not missed and not unaccounted,
        original_acceptance_gate_unchanged=True,services_unchanged=True,memory_event_delta=events,
        timing_capture_preserved=existing_timing,
        temp_peak_bytes=temp['peak_bytes'],health_pdf_cleanup_guards_passed=True,
        full_month_traversals=len(x['full_month_traversals']),production_modified=False)
    l.save('audit130-'+label,result)
    print('PASS130 integrity/guards audit; capacity_passed=',result['capacity_passed'],label,
        'planned/sent/missed/unaccounted',result['planned'],len(sent),len(missed),unaccounted,flush=True)


if __name__=='__main__':audit(sys.argv[1])

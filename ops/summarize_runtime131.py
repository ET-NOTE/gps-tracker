"""Summarize actual131 output; preserve retry, scheduling and simulation limits."""
from collections import Counter
import json
from pathlib import Path
import sys


def percentile(values):
    return sorted(values)[int((len(values)-1)*.95)] if values else None


def summarize(root):
    result=dict(schema=114,loads=[],api=[],ingest_profiles=[],production_admitted=False,limitations=[
        'Synthetic internal localhost TLS1.2; no physical terminal or external LTE path.',
        'Sequential300-second baseline/candidate runs with warm host cache; single samples, no statistical superiority claim.',
        'Other service memory/DB/IO and AV memory/CPU are simulators, not actual apps or malware scans.',
        'Existing300-second shared6GiB scenario only; no expanded duration/concurrency or dedicated rerun. Actual VPS sizing deferred to migration.',
        'Final429 and retry delays are not successes; no agreed production latency SLA is inferred.',
        'Query HTTP success timing includes retries; percentiles of timer components must not be added.',
        'Ingest stages are exclusive wall-clock intervals including awaits; pool_begin includes BEGIN and store includes triggers/commit.',
        'Phase timing alone does not identify WAL, CPU scheduling or physical I/O as the unique cause.'])
    for label in ('baseline-shared','candidate-shared'):
        path=root/(label+'-131.json')
        if not path.exists():continue
        x=json.loads(path.read_text());temp=json.loads((root/('temp131-'+label+'.json')).read_text())
        audit=json.loads((root/('audit131-'+label+'.json')).read_text())
        result['loads'].append(dict(label=label,seconds=x['seconds'],elapsed=x['elapsed'],workers=x['workers'],
            capacity_passed=audit['capacity_passed'],unaccounted_slots=audit['unaccounted'],
            exact_sent_counter_sets_match=audit['all_sent_stored'],
            successful_reads=x['statuses'].get('200',0),final429=x['statuses'].get('429',0),http=x['attempts'],
            final429_percent=100*x['statuses'].get('429',0)/sum(x['statuses'].values()),
            routes=x['per_route'],ingest={k:v for k,v in x['ingest'].items() if k!='requests'},
            saved_ingest=x['saved_ingest'],health=x['health'],pdf=x['pdf'],cleanup=x['cleanup'],
            traversals=len(x['full_month_traversals']),temp_peak_bytes=temp['peak_bytes'],
            db_io_delta=x['db_io_delta'],errors=x['errors'],api_memory_peak_bytes=int(x['after']['api']['memory.peak'])))
        profile=json.loads((root/('ingest-profile131-'+label+'.json')).read_text())
        done=[r for r in profile['rows'] if r['completed']]
        phases=[k for k in profile['stages'] if k!='total_ms']
        slow=[r for r in done if r['total_ms']>=1000]
        result['ingest_profiles'].append(dict(label=label,completed=profile['completed'],unfinished=profile['unfinished'],
            stages=profile['stages'],requests_over_one_second=len(slow),
            largest_stage_over_one_second=dict(Counter(max(phases,key=lambda k:r[k]) for r in slow)),
            stage_sum_ms={k:sum(r[k] for r in done) for k in phases},
            captured_before_quiet_queries=profile['captured_before_quiet_queries']))
        timing=root/('timings124-'+label+'-131.json')
        if not timing.exists():continue
        groups={}
        for row in json.loads(timing.read_text())['rows']:groups.setdefault((row['class'],row['outcome']),[]).append(row)
        for (kind,outcome),rows in groups.items():
            result['api'].append(dict(label=label,kind=kind,outcome=outcome,count=len(rows),
                p95_ms={k:percentile([r[k] for r in rows]) for k in ('admission_ms','pool_ms','setup_ms','scope_ms')}))
    (root/'summary131.json').write_text(json.dumps(result,indent=2)+'\n')
    for x in result['loads']:
        print(x['label'],x['successful_reads'],x['final429'],round(x['final429_percent'],2),
            'ingest',x['ingest']['statuses'],'missed',x['ingest']['missed_slots'],
            'saved',sum(r['rows'] for r in x['saved_ingest']),'temp_MiB',x['temp_peak_bytes']/1024**2)


if __name__=='__main__':summarize(Path(sys.argv[1]))

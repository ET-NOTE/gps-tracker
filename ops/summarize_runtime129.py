"""Summarize actual129 output; preserve retry, scheduling and simulation limits."""
from collections import Counter
import json
from pathlib import Path
import sys


def percentile(values):
    return sorted(values)[int((len(values)-1)*.95)] if values else None


def summarize(root):
    result=dict(schema=114,loads=[],api=[],production_admitted=False,limitations=[
        'Synthetic internal localhost TLS1.2; no physical terminal or external LTE path.',
        'Two sequential300-second conditions, same candidate and warm host cache; no statistical superiority claim.',
        'Other service memory/DB/IO and AV memory/CPU are simulators, not actual apps or malware scans.',
        'Dedicated4GiB/shared6GiB candidate budgets do not admit current3GiB production.',
        'Final429 and retry delays are not successes; no agreed production latency SLA is inferred.',
        'HTTP success timing includes retries; percentiles of timer components must not be added.',
        'The original shared-low API phase capture includes subsequent quiet equivalence queries; preserve it as raw evidence but exclude it from API phase percentiles. Client load timings remain separate.'])
    for label in ('dedicated','shared','shared-low'):
        path=root/(label+'-129.json')
        if not path.exists():continue
        x=json.loads(path.read_text());temp=json.loads((root/('temp129-'+label+'.json')).read_text())
        audit=json.loads((root/('audit129-'+label+'.json')).read_text())
        result['loads'].append(dict(label=label,seconds=x['seconds'],elapsed=x['elapsed'],workers=x['workers'],
            capacity_passed=audit['capacity_passed'],unaccounted_slots=audit['unaccounted'],
            exact_sent_counter_sets_match=audit['all_sent_stored'],
            successful_reads=x['statuses'].get('200',0),final429=x['statuses'].get('429',0),http=x['attempts'],
            final429_percent=100*x['statuses'].get('429',0)/sum(x['statuses'].values()),
            routes=x['per_route'],ingest={k:v for k,v in x['ingest'].items() if k!='requests'},
            saved_ingest=x['saved_ingest'],health=x['health'],pdf=x['pdf'],cleanup=x['cleanup'],
            traversals=len(x['full_month_traversals']),temp_peak_bytes=temp['peak_bytes'],
            db_io_delta=x['db_io_delta'],errors=x['errors'],api_memory_peak_bytes=int(x['after']['api']['memory.peak'])))
        timing=root/('timings124-'+label+'-129.json')
        if not timing.exists() or label=='shared-low':continue
        groups={}
        for row in json.loads(timing.read_text())['rows']:groups.setdefault((row['class'],row['outcome']),[]).append(row)
        for (kind,outcome),rows in groups.items():
            result['api'].append(dict(label=label,kind=kind,outcome=outcome,count=len(rows),
                p95_ms={k:percentile([r[k] for r in rows]) for k in ('admission_ms','pool_ms','setup_ms','scope_ms')}))
    (root/'summary129.json').write_text(json.dumps(result,indent=2)+'\n')
    for x in result['loads']:
        print(x['label'],x['successful_reads'],x['final429'],round(x['final429_percent'],2),
            'ingest',x['ingest']['statuses'],'missed',x['ingest']['missed_slots'],
            'saved',sum(r['rows'] for r in x['saved_ingest']),'temp_MiB',x['temp_peak_bytes']/1024**2)


if __name__=='__main__':summarize(Path(sys.argv[1]))

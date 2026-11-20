"""Produce auditable numeric summaries; never sum overlapping timer layers."""
import json
from pathlib import Path
import statistics
import sys


def percentile(values, p=.95):
    return sorted(values)[min(len(values)-1,int((len(values)-1)*p))] if values else None


def summarize(root):
    output=dict(loads=[],sql=[],api=[],limitations=[
        'SQL execution includes decryption; function time is not added to SQL time.',
        'API scope includes SQL, transfer and application work, not background cancellation cleanup.',
        'Client successful latency includes HTTP attempts and retry waits; p95 components are not additive.',
        'Two sequential300-second runs per dedicated variant; one shared pair, not statistical confidence.',
        'Warm synthetic DB on a shared build host; not current3GiB production capacity acceptance.'])
    for label in ['baseline-1','baseline-2','shared-before','candidate-1','candidate-2','shared-after']:
        x=json.loads((root/(label+'-124.json')).read_text())
        assert not x['errors']
        counts=x['statuses'];total=sum(counts.values())
        output['loads'].append(dict(label=label,seconds=x['seconds'],elapsed=x['elapsed'],
            success=counts.get('200',0),exhausted429=counts.get('429',0),
            exhausted429_percent=100*counts.get('429',0)/total,
            routes=x['per_route'],ingest=x['ingest'],saved_ingest=x['saved_ingest'],
            pdf=x['pdf'],cleanup=x['cleanup'],walks=len(x['full_month_traversals']),
            db_io_delta=x['db_io_delta']))
    for label in ['before','after']:
        x=json.loads((root/('profile124-'+label+'.json')).read_text())
        groups={}
        for r in x['results']:
            groups.setdefault((r['route'],r['plan_mode']),[]).append(r)
        for (route,mode),rows in groups.items():
            def fn(r,name,key):return sum(f[key] for f in r['functions'] if f['name']==name)
            output['sql'].append(dict(label=label,route=route,mode=mode,repeats=len(rows),
                sql_ms_median=statistics.median(r['plan']['Execution Time'] for r in rows),
                open_cell_ms_median=statistics.median(fn(r,'gps_open_cell','total_ms') for r in rows),
                open_cell_calls=sorted(set(fn(r,'gps_open_cell','calls') for r in rows)),
                pgp_ms_median=statistics.median(fn(r,'pgp_sym_decrypt','total_ms') for r in rows),
                temp_read_blocks_median=statistics.median(r['plan']['Plan'].get('Temp Read Blocks',0) for r in rows),
                temp_written_blocks_median=statistics.median(r['plan']['Plan'].get('Temp Written Blocks',0) for r in rows)))
    for label in ['candidate-1','candidate-2','shared-after']:
        x=json.loads((root/('timings124-'+label+'.json')).read_text())
        groups={}
        for row in x['rows']:groups.setdefault((row['class'],row['outcome']),[]).append(row)
        for (kind,outcome),rows in groups.items():
            output['api'].append(dict(label=label,kind=kind,outcome=outcome,count=len(rows),
                phases={key:dict(median=statistics.median(r[key] for r in rows),
                                p95=percentile([r[key] for r in rows]))
                        for key in ['admission_ms','pool_ms','setup_ms','scope_ms']}))
    path=root/'summary124.json';path.write_text(json.dumps(output,indent=2)+'\n')
    for x in output['loads']:
        print(x['label'],x['success'],x['exhausted429'],round(x['exhausted429_percent'],1),
              {k:round(v['latency']['p95'],3) for k,v in x['routes'].items()})


if __name__=='__main__':summarize(Path(sys.argv[1]))

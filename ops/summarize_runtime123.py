"""Derive round123 performance/resource metrics from immutable raw results."""
import json
from pathlib import Path
import statistics
import sys


def summarize(directory):
    result={}
    for name in ('baseline-4g','dedicated-123','shared-123'):
        raw=json.loads((directory/(name+'.json')).read_text())
        statuses=raw['statuses']; total=sum(statuses.values())
        memory={}
        for group in ('container','gps','db','api','pdf','other','av'):
            points=[(x['seconds'],int(x['cgroups'][group]['memory.current'])/1024**2)
                    for x in raw['resources'] if group in x['cgroups']]
            if not points:continue
            n=max(1,len(points)//4)
            memory[group]=dict(samples=len(points),max_mib=max(v for _,v in points),
                first_quarter_median_mib=statistics.median(v for _,v in points[:n]),
                last_quarter_median_mib=statistics.median(v for _,v in points[-n:]),
                end_mib=int(raw['after'].get(group,{}).get('memory.current','0'))/1024**2)
        result[name]=dict(seconds=raw['seconds'],elapsed=raw['elapsed'],statuses=statuses,
            attempt_statuses=raw['attempts'],final_429_fraction=statuses.get('429',0)/total,
            successful_reads_per_second=statuses.get('200',0)/raw['elapsed'],
            per_route=raw['per_route'],ingest=raw['ingest'],saved_ingest=raw['saved_ingest'],
            health=raw['health'],pdf=raw['pdf'],cleanup=raw['cleanup'],
            full_month_traversals=len(raw['full_month_traversals']),memory=memory,errors=raw['errors'])
    output=dict(results=result,interpretation_limits=[
        'One sequential run per configuration, baseline300s and candidate900s; not a controlled repeated statistical estimate',
        'Warm database, synthetic other services and small PDF; not production qualification',
        'Quarter medians and peaks describe observed memory, do not prove absence of long-term leaks'])
    (directory/'summary123.json').write_text(json.dumps(output,indent=2)+'\n')
    for name,r in result.items():
        print(name,r['statuses'],'success/s',round(r['successful_reads_per_second'],3),
              '429%',round(r['final_429_fraction']*100,1),'ingest',r['saved_ingest'],
              'history_p95',r['per_route']['month_history']['latency'].get('p95'),
              'page_p95',r['per_route']['month_page']['latency'].get('p95'))


if __name__=='__main__':summarize(Path(sys.argv[1]))

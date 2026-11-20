import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../../api';
import {businessDate} from '../../lib/business';
import {kstDateTime} from '../../lib/businessExport';
import {corporateVehicleName} from '../../lib/corporateOverview';
import {recordedTripNotices} from '../../lib/fleetNotifications';
import {BusinessButton,BusinessError} from './BusinessWorkspace';
import {useBusinessSubscription} from './useBusinessData';

// Use the report endpoint for GPS-derived activity. Its projection, vehicle scope
// and data-quality checks also apply here. Read only when the section is open.
export default function FleetNotificationTrips({devices,now,onVehicle}) {
  const [open,setOpen]=useState(false),[limit,setLimit]=useState(20);
  const subscription=useBusinessSubscription('corporate');
  const available=subscription.data?.active===true;
  const today=businessDate(now),yesterday=businessDate(now-86400000);
  const ids=devices.map(d=>d.id).slice(0,limit);
  const query=useQuery({queryKey:['fleet-notification-recorded-trips',today,ids],enabled:open&&available,
    staleTime:30000,queryFn:async({signal})=>{
      let cursor=0,errorCount=0;
      const byId=new Map(devices.map(d=>[d.id,d])),records=[];
      const since=Date.parse(today+'T00:00:00+09:00');
      async function load() {
        while(cursor<ids.length&&!signal.aborted){
          const id=ids[cursor++];
          try {
            const trips=await api.listFleetVehicleTrips(id,{from:yesterday,to:today},{signal});
            records.push(...recordedTripNotices(trips,byId.get(id),since,Date.now()));
          } catch(e) {if(signal.aborted)throw e;errorCount++;}
        }
      }
      await Promise.all(Array.from({length:Math.min(ids.length,2)},load));
      return {items:records.sort((a,b)=>b.at-a.at).slice(0,20),errorCount};
    }});
  if(!available||!devices.length)return null;
  return <details className="fleet-recorded-notices" open={open} onToggle={e=>setOpen(e.currentTarget.open)}>
    <summary>오늘의 운행기록 알림</summary>
    {open&&<div>{query.isPending?<p role="status">단말기 운행기록을 조회하는 중…</p>:<>
      {(query.isError||query.data?.errorCount>0)&&<BusinessError onRetry={query.refetch}>일부 차량의 운행기록을 조회하지 못했습니다.</BusinessError>}
      {query.data?.items.map(event=><button key={event.id} type="button" onClick={()=>onVehicle(event.device)}>
        <strong>{event.label}</strong><small>{corporateVehicleName(event.device)} · {kstDateTime(event.at)}</small></button>)}
      {query.data&&!query.data.errorCount&&!query.data.items.length&&<p>조회한 차량의 오늘 운행기록이 없습니다.</p>}
      {devices.length>ids.length&&<BusinessButton onClick={()=>setLimit(limit+20)}>다음 {Math.min(20,devices.length-ids.length)}대 확인</BusinessButton>}
    </>}</div>}
  </details>;
}

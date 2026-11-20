import { useState } from 'react';
import { Modal } from '../ui';
import { corporateVehicleName, terminalName } from '../../lib/corporateOverview';
import FleetNotificationList from './FleetNotificationList';
import { useBusinessClock } from './useBusinessData';

export default function FleetQuickPanel({mode,tabs,groups,sections,devices,vehicleStatus,onVisit,onVehicle,onClose}) {
  const [query,setQuery]=useState('');
  const now=useBusinessClock();
  const search=mode==='search';
  if(!search) return <Modal open title="운영 알림" onClose={onClose}>
    <FleetNotificationList devices={devices} vehicleStatus={vehicleStatus} now={now} canOpenSettings={tabs.some(p=>p.id==='settings')}
      onVehicle={d=>{onClose();onVehicle(d);}} onVisit={(page,id)=>{onClose();onVisit(page,id);}}/>
  </Modal>;
  const needle=query.trim().toLocaleLowerCase();
  const matches=item=>[item.label,item.hint].join(' ').toLocaleLowerCase().includes(needle);
  const destinations=tabs.flatMap(page=>{
    const hint=groups.find(g=>g.id===page.group)?.label;
    return sections?.[page.id]?.length
      ? sections[page.id].map(([id,label])=>({id:page.id+'/'+id,label,hint,run:()=>onVisit(page.id,id)}))
      : [{id:page.id,label:page.label,hint,run:()=>onVisit(page.id)}];
  });
  const vehicles=devices.map(device=>({id:device.id,label:corporateVehicleName(device),
    hint:[device.car_plate || device.license_plate,device.has_primary_terminal && terminalName(device),device.department].filter(Boolean).join(' · '),
    run:()=>onVehicle(device)}));
  const groupsToShow=[['메뉴',destinations.filter(matches)],['차량',vehicles.filter(matches)]];
  return <Modal open title="차량·메뉴 검색" onClose={onClose}>
    <div className="fleet-quick-panel">
      <input autoFocus type="search" aria-label="메뉴·차량·단말명 검색" placeholder="메뉴·차량·단말명 검색" value={query} onChange={e=>setQuery(e.target.value)}/>
      {groupsToShow.map(([title,items])=>items.length>0&&<section key={title}>{title&&<h3>{title}</h3>}
        {items.map(item=><button key={item.id} type="button" onClick={()=>{onClose();item.run();}}><strong>{item.label}</strong>{item.hint&&item.label!==item.hint&&<small>{item.hint}</small>}</button>)}</section>)}
      {vehicleStatus!=='ready' ? <p role="status">{vehicleStatus==='error'?'차량 정보를 불러오지 못했습니다.':'차량 정보를 확인하고 있습니다.'}</p>
        : groupsToShow.every(([,items])=>!items.length)&&<p role="status">일치하는 차량이나 메뉴가 없습니다.</p>}
    </div>
  </Modal>;
}

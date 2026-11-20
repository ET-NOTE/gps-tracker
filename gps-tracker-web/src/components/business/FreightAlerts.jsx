import {useState} from 'react';
import Icon from '../Icon';
import BusinessDrawer from './BusinessDrawer';
import {epoch} from '../../lib/freightWorkflow';
import {FreightButton} from './FreightKit';

export function freightTasks(data,ships,fleet,terminals,now) {
  const active=ships.filter(s=>!['delivered','cancelled'].includes(s.status));
  const pending=active.filter(s=>s.status==='requested');
  const overdue=pending.filter(s=>now-epoch(s.events?.at(-1)?.at || s.start)>data.policies.acceptTimeoutMinutes*60000).length;
  return [
    ['dispatchNotice','배차 수락 대기',pending.length,'cargo-dispatch',overdue?'대기 기준 초과 '+overdue+'건':''],
    ['delayNotice','예정 시간이 지난 운송',active.filter(s=>epoch(s.end)<now).length,'cargo-shipments'],
    ['delayNotice','처리 중인 지연·사고',data.incidents.filter(i=>i.status==='open'&&fleet.some(v=>v.id===i.vehicleId)).length,'cargo-incidents'],
    ['proofNotice','인수증 확인 필요',ships.filter(s=>s.status==='delivered'&&s.proof?.status!=='approved').length,'cargo-proofs'],
    ['connectionNotice','단말 수신 확인',terminals.filter(d=>!d.last_seen_at||now-Date.parse(d.last_seen_at)>data.policies.offlineMinutes*60000).length,'cargo-devices']
  ].filter(([pref])=>data.integrations[pref]);
}
export default function FreightAlerts({data,devices,onPage}){
  const [open,setOpen]=useState(false),tasks=freightTasks(data,data.shipments,data.vehicles,devices,Date.now()).filter(([, ,n])=>n>0);
  const visit=p=>{setOpen(false);onPage(p);};
  return <><button type="button" className="rnt-icon" aria-label={'업무 알림 '+tasks.reduce((n,t)=>n+t[2],0)+'건'} onClick={()=>setOpen(true)}><Icon name="bell" size={19}/></button>
    {open&&<BusinessDrawer title="업무 알림" onClose={()=>setOpen(false)}><div className="fr-page">
      {tasks.map(([,label,count,to,hint])=><button type="button" className="fr-pick" key={label} onClick={()=>visit(to)}>{label} <strong>{count}건</strong>{hint&&<small>{hint}</small>}</button>)}
      {!tasks.length&&<p className="fr-empty">현재 확인할 알림이 없습니다.</p>}
      <FreightButton onClick={()=>visit('cargo-integrations')}>알림 설정</FreightButton>
    </div></BusinessDrawer>}</>;
}

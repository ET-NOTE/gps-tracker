import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { authScope } from '../authSession';
import { freightMenu, freightPages } from '../lib/freightMenu';
import RentalWorkspace from './business/RentalWorkspace';
import RentalStaffDesk from './business/RentalStaffDesk';
import RentalTeam from './business/RentalTeam';
import FreightOffice from './business/FreightOffice';
import FreightWorkflow from './business/FreightWorkflow';
import FreightOverview from './business/FreightOverview';
import FreightDashboard from './business/FreightDashboard';
import { qk } from '../state/keys';
import FreightAlerts from './business/FreightAlerts';
import FreightAdmin from './business/FreightAdmin';
import FreightReports from './business/FreightReports';
import FreightIncidents from './business/FreightIncidents';
import { BusinessError } from './business/BusinessWorkspace';

const workflows = new Set(['cargo-orders','cargo-recurring','cargo-dispatch','cargo-schedule','cargo-shipments','cargo-proofs']);
const office = new Set(['cargo-vehicles','cargo-drivers','cargo-maintenance','cargo-devices','cargo-shippers','cargo-carriers','cargo-locations','cargo-rates','cargo-billing','cargo-payables','cargo-charges']);
const reports = new Set(['cargo-reports','cargo-utilization','cargo-profit']);

function OwnerWorkspace({page,onPage,devices,onMap,onNavigate,destinations,onRegisterDevice}) {
  const qc=useQueryClient(), key=['cargo-workspace',authScope()], lock=useRef(false);
  const [epoch,reset]=useState(0), [message,setMessage]=useState('');
  const [dispatchOrderId,setDispatchOrderId]=useState('');
  const [requestedBranch,setRequestedBranch]=useState(null);
  useEffect(()=>{if(page!=='cargo-shipments')setRequestedBranch(null);},[page]);
  const q=useQuery({queryKey:key,queryFn:api.cargoWorkspace,staleTime:0,refetchOnWindowFocus:false,refetchOnReconnect:false,refetchInterval:(!page||page==='cargo-live'||page==='cargo-dashboard')?30000:false,retry:false});
  const snapshot=q.data;
  async function save(next){
    if(lock.current) throw Error('이전 변경을 저장하고 있습니다.');
    if(qc.getQueryData(key)?.revision!==snapshot.revision) throw Error('자료가 변경되었습니다. 화면을 다시 열어 주세요.');
    lock.current=true;
    try {
      const {revision}=await api.saveCargoWorkspace(snapshot.revision,next);
      qc.setQueryData(key,{revision,data:next});setMessage('');
      if(page==='organization') await qc.invalidateQueries({queryKey:['cargo-team',authScope()]});
    } catch(e) {
      if(e.status===409){
        const fresh=await api.cargoWorkspace();
        if(fresh.revision!==snapshot.revision){
          qc.setQueryData(key,fresh);reset(n=>n+1);
          setMessage('다른 화면에서 먼저 저장해 최신 자료를 불러왔습니다. 변경할 내용을 다시 확인해 주세요.');
        }
      }
      throw e;
    } finally {lock.current=false;}
  }
  function startDispatch(orderId) {
    setDispatchOrderId(orderId);
    onPage('cargo-dispatch');
  }
  function openRequested(branch) {
    setRequestedBranch(branch);
    onPage('cargo-shipments');
  }
  const id=freightPages.has(page)?page:'cargo-dashboard', props={page:id,data:snapshot?.data,save,onPage,devices,onMap,onRegisterDevice,startDispatch,dispatchOrderId,setDispatchOrderId,openRequested,requestedBranch};
  let body;
  if(q.isPending) body=<p role="status">화물배차 정보를 불러오는 중…</p>;
  else if(q.error) body=<BusinessError onRetry={q.refetch}>화물배차 정보를 불러올 수 없습니다.</BusinessError>;
  else if(workflows.has(id)) body=<FreightWorkflow {...props}/>;
  else if(office.has(id)) body=<FreightOffice {...props}/>;
  else if(reports.has(id)) body=<FreightReports {...props}/>;
  else if(id==='cargo-incidents') body=<FreightIncidents {...props}/>;
  else if(id==='cargo-dashboard') body=<FreightDashboard {...props}/>;
  else if(id==='cargo-live') body=<FreightOverview {...props} refreshing={q.isFetching} onRefresh={()=>Promise.all([q.refetch(),qc.invalidateQueries({queryKey:qk.devices()})])}/>;
  else if(id==='users'||id==='permissions') body=<RentalTeam cargo page={id==='users'?'staff':'groups'} onTab={p=>onPage(({branches:'organization',groups:'permissions',staff:'users'})[p])}/>;
  else body=<FreightAdmin {...props}/>;
  return <RentalWorkspace page={id} onTab={onPage} menu={freightMenu} headerAction={snapshot&&<FreightAlerts data={snapshot.data} devices={devices} onPage={onPage}/>} heading="화물배차" serviceLabel="화물배차" widthKey="cargo.area.width" devices={devices} onSearchDevice={d=>onMap(d.id)} onNavigate={onNavigate} destinations={destinations}>
    {message&&<p role="alert" className="fr-note">{message}</p>}<div key={id+'-'+epoch}>{body}</div>
  </RentalWorkspace>;
}
export default function DeliveryPanel(props) {
  return props.page==='staff-desk'?<RentalStaffDesk cargo onHome={()=>props.onNavigate('home')}/>:<OwnerWorkspace {...props}/>;
}

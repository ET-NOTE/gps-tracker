import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { kstDateTime } from '../../lib/businessExport';
import { BusinessButton, BusinessEmpty, BusinessError } from './BusinessWorkspace';
import { Modal } from '../ui';
import './rental-team.css';

import { shipStates, timeLabel } from '../../lib/freightWorkflow';
const statuses={draft:'예약',active:'대여 중',overdue:'반납 지연',returned:'반납 완료',cancelled:'취소'};
const kinds={cleaning:'세차',inspection:'점검',maintenance:'정비',accident:'사고',breakdown:'고장'};
function BranchDesk({owner,cargo}) {
  const team=cargo?api.cargoTeam:api.rentalTeam;
  const qc=useQueryClient(), key=[cargo?'cargo-staff-desk':'rental-staff-desk',authScope(),owner];
  const q=useQuery({queryKey:key,queryFn:()=>team('GET','/desk/'+owner),refetchInterval:30000,retry:false});
  const [contract,setContract]=useState(null),[text,setText]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  async function save(e){
    e.preventDefault();if(busy)return;setBusy(true);setError('');
    try{await team('POST','/desk/'+owner+'/'+contract+'/notes',{body:text});setContract(null);setText('');await qc.invalidateQueries({queryKey:key});}
    catch(e){setError(e.message);if(e.status===403){setContract(null);q.refetch();}}
    finally{setBusy(false);}
  }
  if(q.isPending)return <p role="status">지점 정보를 불러오는 중…</p>;
  if(q.error)return <BusinessError onRetry={q.refetch}>지점 접근 권한을 확인할 수 없습니다.</BusinessError>;
  const d=q.data;
  return <><p>{d.branch} · {d.group}</p>
    {d.permissions.includes('dispatch_read')&&<section><header><h2>지점 배차 목록</h2></header>
      {cargo&&d.shipments.map(c=><article key={c.id}><div><strong>{c.number} · {shipStates[c.status]}</strong><small>{timeLabel(c.start)} ~ {timeLabel(c.end)}</small>{c.notes.map((n,i)=><small key={i}>{n.body}</small>)}</div>{d.permissions.includes('handover_note')&&<BusinessButton onClick={()=>{setError('');setText('');setContract(c.id);}}>메모 작성</BusinessButton>}</article>)}
      {!cargo&&d.contracts.map(c=><article key={c.id}><div><strong>{c.renter_name} · {c.license_plate||'미배차'}</strong><small>{kstDateTime(c.starts_at)} ~ {kstDateTime(c.ends_at)} · {statuses[c.status]}</small>
        {c.notes.map((n,i)=><small key={i}>{n.body}</small>)}</div>{d.permissions.includes('handover_note')&&<BusinessButton onClick={()=>{setError('');setText('');setContract(c.id);}}>메모 작성</BusinessButton>}</article>)}
      {!(cargo?d.shipments:d.contracts).length&&<BusinessEmpty title="지점에 배정된 예약이 없습니다."/>}
    </section>}
    {cargo&&d.permissions.includes('fleet_read')&&<section><header><h2>지점 차량</h2></header>{d.vehicles.map(v=><article key={v.id}><strong>{v.plate}</strong><small>{v.type} · {({ready:'배차 가능',hold:'배차 제한',service:'정비 중'})[v.readiness]||'상태 확인'}</small></article>)}{!d.vehicles.length&&<BusinessEmpty title="지점 차량이 없습니다."/>}</section>}
    {d.permissions.includes('service_read')&&<section><header><h2>지점 차량 작업</h2></header>
      {d.work.map(w=><article key={w.id}><div><strong>{kinds[w.kind]} · {w.license_plate||'차량번호 미등록'}</strong><small>{kstDateTime(w.starts_at)} · {w.closed_at?'완료':'진행 예정·진행 중'}</small></div></article>)}
      {!d.work.length&&<BusinessEmpty title="지점 차량의 작업 기록이 없습니다."/>}</section>}
    {!d.permissions.length&&<BusinessEmpty title="허용된 업무가 없습니다.">소속 지점 관리자에게 권한을 확인해 주세요.</BusinessEmpty>}
    {contract&&<Modal open title="인수인계 메모" onClose={()=>setContract(null)}><form className="rnt-team-form" onSubmit={save}><label>메모<textarea required maxLength={500} value={text} onChange={e=>setText(e.target.value)}/></label>{error&&<p role="alert">{error}</p>}<button disabled={busy} className="business-button is-primary">저장</button></form></Modal>}
  </>;
}
export default function RentalStaffDesk({onHome,cargo=false}) {
  const team=cargo?api.cargoTeam:api.rentalTeam;
  const qc=useQueryClient(), key=[cargo?'cargo-memberships':'rental-memberships',authScope()];
  const memberships=useQuery({queryKey:key,queryFn:()=>team('GET','/memberships'),refetchInterval:30000});
  const [selected,setSelected]=useState(''),[code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const items=memberships.data||[], owner=items.find(i=>String(i.owner_id)===selected)?.owner_id||items[0]?.owner_id;
  async function join(e){
    e.preventDefault();if(busy)return;setError('');setBusy(true);
    try{const r=await team('POST','/join',{code:code.trim()});setSelected(String(r.owner_id));setCode('');await qc.invalidateQueries({queryKey:key});}
    catch{setError('로그인 이메일과 초대 코드의 유효기간을 확인해 주세요.');}finally{setBusy(false);}
  }
  return <main className="gps-user-panel rnt-staff-shell"><div className="rnt-team"><div className="rnt-staff-heading"><h1>{cargo?"화물배차":"렌트카"} 직원 업무</h1><BusinessButton onClick={onHome}>내 계정으로</BusinessButton></div>
    <form className="rnt-team-form rnt-join" onSubmit={join}><label>초대 코드<input required maxLength={32} value={code} onChange={e=>setCode(e.target.value)} autoComplete="off"/></label><button className="business-button" disabled={busy}>초대 수락</button>{error&&<p role="alert">{error}</p>}</form>
    {memberships.isPending?<p role="status">소속 지점을 조회하는 중…</p>:memberships.error?<BusinessError onRetry={memberships.refetch}/>:owner?
      <><label className="rnt-company-choice">소속 선택<select value={owner} onChange={e=>setSelected(e.target.value)}>{items.map(i=><option key={i.owner_id} value={i.owner_id}>{i.company} · {i.branch}</option>)}</select></label><BranchDesk cargo={cargo} key={owner} owner={owner}/></>:
      <BusinessEmpty title="연결된 지점이 없습니다.">소유자가 발급한 초대 코드를 입력해 주세요.</BusinessEmpty>}
  </div></main>;
}

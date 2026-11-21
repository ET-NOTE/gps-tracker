import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { businessDate, businessPeriod } from '../../lib/business';
import { kstDateTime, rentalReport } from '../../lib/businessExport';
import { fillTemplate } from '../../lib/rentalOffice';
import { officeBookKey, officeCatalogKey } from './rentalOfficeKeys';
import { profileKey } from './RentalFleetProfiles';
import { agreementTotal, rentalMilestones, rentalStageNames, workflowRows, workflowStatus } from '../../lib/rentalWorkflow';
import { useUpdateRental, qk } from '../../state';
import { confirmDialog } from '../Dialog';
import { Button, FormField, Input, Modal, Select, Textarea } from '../ui';
import { RentalDialog, HandoffTokenDialog, SettlementSummary } from '../RentcarPanel';
import { useRentalCatalog } from './RentalBookingForm';
import { BusinessButton, BusinessError } from './BusinessWorkspace';
import { useBusinessClock, useRentalOperations } from './useBusinessData';
import ExportButtons from './ExportButtons';
import RentalStageTable, {StageBadge} from './RentalStageTable';
import { LedgerEditor } from './RentalOfficeBook';
import { policyKey } from './RentalPolicy';
import ReturnWizard from './ReturnWizard';
import PhotoGalleryModal from './PhotoGalleryModal';
import BusinessDrawer from './BusinessDrawer';
import './rental-workflow.css';

const templateText = c => (c.rental_terms?.template_body || '').replaceAll('{{고객연락처}}',c.renter_phone || '—');
const won = value => Number(value || 0).toLocaleString('ko-KR')+'원';
const carLabel = c => c.license_plate || c.device_name || (c.device_id ? '차량 '+c.device_id : '차량 미배정');
const baseFilters = {query:'',status:'',branch:'',from:'',to:'',device:'',model:'',channel:'',subset:''};
const stageTabs = {
  checkout:[['','전체 출고 예정'],['pickup','오늘 출고']],
  active:[['','전체 대여 중'],['due','오늘 반납'],['late','반납 지연']],
  returns:[['','전체'],['open','반납 대기'],['returned','반납 완료']],
};

function bookQuery(period) {
  return {queryKey:officeBookKey(period),queryFn:()=>api.rentalOffice('GET','/book?'+new URLSearchParams(period)),staleTime:15000};
}

function ContractLedger({contract,onClose}) {
  const day=businessDate(contract.starts_at);
  const query=useQuery(bookQuery({from:day,to:day}));
  const current=query.data?.contracts.find(c=>c.id===contract.id);
  if (current) return <LedgerEditor book={{contracts:[current]}} initial={{contract:current}} close={onClose}/>;
  return <Modal open title="결제·보증금 기록" onClose={onClose}>{query.isLoading?<p role="status">결제 내역을 불러오는 중…</p>:
    <BusinessError onRetry={query.refetch}>이 계약의 청구액과 수납 내역을 확인하지 못했습니다.</BusinessError>}</Modal>;
}

export default function RentalWorkflow({ stage='reservations', devices=[], branches: configuredBranches=[], request }) {
  const now=useBusinessClock(), qc=useQueryClient(), update=useUpdateRental();
  const [filters,setFilters]=useState(baseFilters), [detail,setDetail]=useState(null), [dialog,setDialog]=useState(null), [error,setError]=useState('');
  const invalid=filters.from && filters.to && filters.from>filters.to;
  const period=filters.from && filters.to && !invalid ? {from:filters.from+'T00:00:00+09:00',to:new Date(Date.parse(filters.to+'T00:00:00+09:00')+86400000).toISOString()}:null;
  const result=useRentalOperations(now,period,!invalid), all=result.data || [];
  const defaultPeriod=businessPeriod(now);
  const bookPeriod={from:filters.from || businessDate(defaultPeriod.from),to:filters.to || businessDate(Date.parse(defaultPeriod.to)-1)};
  const bookRange=Date.parse(bookPeriod.to)-Date.parse(bookPeriod.from);
  const book=useQuery({...bookQuery(bookPeriod),enabled:!invalid && bookRange>=0 && bookRange<=366*86400000});
  const policy=useQuery({queryKey:policyKey(),queryFn:api.rentalOperatingPolicy,enabled:stage==='checkout'});
  const balances=new Map((book.data?.contracts || []).map(c=>[c.id,c]));
  function checksFor(c) {
    const p=policy.data,terms=c.rental_terms || {},balance=balances.get(c.id);
    if (!p || (p.require_payment && !balance)) return null;
    return [!c.device_id && '차량 배정',p.require_license && !terms.license_checked && '면허 확인',
      p.require_contract && !terms.confirmed_at && '계약 확인',p.require_payment && balance.paid_krw<agreementTotal(c) && '대여료 수납'].filter(Boolean);
  }
  useEffect(()=>{
    const initial={...baseFilters,device:request?.deviceId || ''};
    initial.status=({overdue:'반납 지연',returned:'반납 완료',active:'대여 중',draft:'예약 접수'})[request?.status] || '';
    setFilters(initial);setError('');setDialog(null);setDetail(null);
    if(request?.new)setDialog({kind:'edit',deviceId:request.deviceId,date:request.day});
    else if(request?.returning)setDialog({kind:'return',contract:request.returning});
    else if(request?.contract)setDetail(request.contract);
  },[stage,request]);
  const focused=detail ? all.find(c=>c.id===detail.id) || detail:null;
  const shown=workflowRows(all,stage,filters,now);
  const stageRows=workflowRows(all,stage,{},now), states=[...new Set(stageRows.map(c=>workflowStatus(c,now)))];
  const branches=[...new Set([...configuredBranches.map(b=>typeof b==='string'?b:b.name),...all.map(c=>c.pickup_location)].filter(Boolean))].sort();
  function change(key,value) {setFilters(v=>({...v,[key]:value}));}
  const open=(kind,c)=>{setError('');setDialog({kind,contract:c});};
  const close=()=>setDialog(null);
  async function refreshed(saved) {
    close();
    if (saved?.id) setDetail(saved);
    await Promise.all([qk.rentals(),officeBookKey(),officeCatalogKey(true),profileKey()].map(queryKey=>qc.invalidateQueries({queryKey})));
  }
  async function cancel(c) {
    if (!await confirmDialog({title:'예약 취소',body:c.renter_name+'님의 예약을 취소하고 배정한 차량을 해제할까요?',danger:true})) return;
    try {const saved=await update.mutateAsync({id:c.id,body:{...c,status:'cancelled'}});await refreshed(saved);}
    catch(e){setError(e.message);}
  }
  const day=businessDate(now), count=fn=>shown.filter(fn).length;
  const unpaid=items=>items.every(c=>balances.has(c.id)) ? items.reduce((sum,c)=>{
    const b=balances.get(c.id);return sum+Math.max(0,b.billed_krw-b.paid_krw);
  },0):null;
  const assigned=count(c=>c.device_id!=null && c.status==='draft');
  const ready=stage==='checkout' && shown.every(c=>checksFor(c)!=null) ? count(c=>checksFor(c).length===0):null;
  const metrics={
    reservations:[['조회 예약',shown.length],['미배정 예약',count(c=>!c.device_id && c.status==='draft')],['출고 준비',assigned],['예약 대여료',shown.filter(c=>c.status!=='cancelled').reduce((sum,c)=>sum+agreementTotal(c),0),'원']],
    contracts:[['조회 계약',shown.length],['계약 확인 전',count(c=>c.status==='draft' && !c.rental_terms?.confirmed_at)],['대여 중',count(c=>['active','overdue'].includes(c.status))],['대여료 미수',unpaid(shown),'원']],
    checkout:[['출고 예정',shown.length],['오늘 인수 예정',count(c=>businessDate(c.starts_at)===day)],['사전 확인 완료',ready],['확인 필요',ready==null?null:shown.length-ready]],
    active:[['대여 중',shown.length],['오늘 반납 예정',count(c=>businessDate(c.ends_at)===day)],['반납 지연',count(c=>workflowStatus(c,now)==='반납 지연')],['대여료 미수',unpaid(shown),'원']],
    returns:[['조회 반납 대상',shown.length],['반납 대기',count(c=>c.status!=='returned')],['반납 완료',count(c=>c.status==='returned')],['반납 후 대여료 미수',unpaid(shown.filter(c=>c.status==='returned')),'원']],
    dispatch:[['조회 대여 일정',shown.length],['배차 대기',count(c=>!c.device_id)],['배차 완료',count(c=>!!c.device_id)]],
  }[stage];
  const action=focused && <>
    {focused.status==='draft' && <><BusinessButton onClick={()=>open('edit',focused)}>{focused.device_id?'예약·배차 변경':'차량 배정'}</BusinessButton>
      {focused.rental_terms && <><BusinessButton onClick={()=>open('review',focused)}>계약·면허 확인</BusinessButton><BusinessButton primary disabled={!focused.device_id} onClick={()=>open('checkout',focused)}>출고 점검</BusinessButton></>}
      <BusinessButton disabled={update.isPending} onClick={()=>cancel(focused)}>예약 취소</BusinessButton></>}
    {['active','overdue'].includes(focused.status) && <><BusinessButton onClick={()=>open('edit',focused)}>기간 연장</BusinessButton><BusinessButton primary onClick={()=>open('return',focused)}>반납 접수</BusinessButton></>}
    {focused.device_id && ['draft','active','overdue'].includes(focused.status) && <BusinessButton onClick={()=>open('handoff',focused)}>인수·반납 링크</BusinessButton>}
    <BusinessButton onClick={()=>open('photos',focused)}>인수·반납 사진</BusinessButton>
    <BusinessButton onClick={()=>open('ledger',focused)}>결제·보증금 기록</BusinessButton>
  </>;
  const recipient=focused?.rental_terms?.driver_name || focused?.renter_name;
  const milestones=focused ? rentalMilestones(focused) : [];
  return <div className="rental-workflow">
    <div className="rental-stage-metrics">{metrics.map(([label,value,unit])=><div key={label}><span>{label}</span><strong>{result.isLoading || result.error || invalid || value==null ? "—" : <>{value.toLocaleString("ko-KR")}<small>{unit || "건"}</small></>}</strong></div>)}</div>
    <div className="rental-workflow-toolbar">
      {stageTabs[stage] ? <div className="rental-stage-tabs" aria-label="업무 범위">{stageTabs[stage].map(([key,label])=><button type="button" key={key} aria-pressed={filters.subset===key} onClick={()=>change("subset",key)}>{label}</button>)}</div> : <span>{shown.length.toLocaleString()}건 조회</span>}
      <div><ExportButtons report={rentalReport(shown,{now,filterText:rentalStageNames[stage],settlement:stage==="returns" && (filters.status==="반납 완료" || filters.subset==="returned")})} disabled={!!result.error || invalid || result.isLoading}/>
        {["reservations","dispatch","contracts"].includes(stage) && <BusinessButton primary icon="plus" onClick={()=>open("edit",null)}>예약 등록</BusinessButton>}</div></div>
    <div className="rental-workflow-filters">
      <fieldset className="rental-stage-period"><legend>이용 기간</legend><div><input type="date" aria-label="조회 시작일" value={filters.from} onChange={e=>change("from",e.target.value)}/><span>–</span><input type="date" aria-label="조회 종료일" value={filters.to} onChange={e=>change("to",e.target.value)}/></div></fieldset>
      <label>인수 지점<select value={filters.branch} onChange={e=>change("branch",e.target.value)}><option value="">전체 지점</option>{branches.map(x=><option key={x}>{x}</option>)}</select></label>
      <label>차종<select value={filters.model} onChange={e=>change("model",e.target.value)}><option value="">전체 차종</option>{[...new Set(stageRows.map(c=>c.rental_terms?.requested_model).filter(Boolean))].sort().map(x=><option key={x}>{x}</option>)}</select></label>
      <label>진행 상태<select value={filters.status} onChange={e=>change("status",e.target.value)}><option value="">전체 상태</option>{[...new Set([...states,...(filters.status?[filters.status]:[])])].map(x=><option key={x}>{x}</option>)}</select></label>
      {stage==="reservations" && <label>예약 경로<select value={filters.channel} onChange={e=>change("channel",e.target.value)}><option value="">전체 경로</option>{[...new Set(stageRows.map(c=>c.rental_terms?.channel).filter(Boolean))].sort().map(x=><option key={x}>{x}</option>)}</select></label>}
      <label className="rental-stage-search">검색<input type="search" value={filters.query} onChange={e=>change("query",e.target.value)} placeholder="고객, 운전자, 차량, 예약번호"/></label>
      <BusinessButton onClick={()=>setFilters(baseFilters)}>조건 초기화</BusinessButton>
    </div>
    <section className="rental-workflow-box">
      {invalid?<p className="business-error" role="alert">조회 종료일이 시작일보다 빠릅니다.</p>:result.error?<BusinessError onRetry={result.refetch}>대여 내역을 불러오지 못했습니다.</BusinessError>:result.isLoading?<p role="status">대여 내역을 불러오는 중…</p>:
        <RentalStageTable stage={stage} rows={shown} now={now} balances={balances} devices={devices} checksFor={checksFor} onDetail={setDetail} onAction={(kind,c)=>{setDetail(c);open(kind,c);}}/>
        }
    </section>
    {focused && !dialog && <BusinessDrawer title="대여 계약 상세" subtitle={'예약 R-'+focused.id} onClose={()=>setDetail(null)}>
      <div className="rental-detail"><div className="rental-detail-top"><h3>{carLabel(focused)}</h3><StageBadge contract={focused} now={now}/></div>
        <dl>{[['계약 고객',focused.renter_name],['실운전자',recipient],['인수 예정',kstDateTime(focused.starts_at)],['반납 예정',kstDateTime(focused.ends_at)],['인수 / 반납 지점',(focused.pickup_location || '미지정')+' / '+(focused.return_location || '미지정')],['약정 대여료',won(agreementTotal(focused))],['약정 보증금',won(focused.deposit_krw)],['계약 확인',focused.rental_terms?.confirmed_at?kstDateTime(focused.rental_terms.confirmed_at):'확인 전'],['메모',focused.note || '없음']].map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
        {focused.rental_terms?.template_body && <details><summary>확인한 계약 내용</summary><p className="rental-terms-text">{templateText(focused)}</p></details>}
        {focused.pickup_odometer_km!=null && <section><h3>인도 점검</h3><p>{focused.pickup_odometer_km.toLocaleString()} km {focused.rental_terms?.pickup_fuel!=null?' · 연료·충전량 '+focused.rental_terms.pickup_fuel+'%':''}</p>{focused.rental_terms?.pickup_note && <p>{focused.rental_terms.pickup_note}</p>}</section>}
        {focused.status==='returned' && <section><h3>반납 정산</h3><SettlementSummary c={focused}/></section>}
        {milestones.length>0 && <section><h3>계약 진행 기록</h3><ol className="rental-milestones">{milestones.map(([label,time])=>
          <li key={label}><span>{label}</span><time dateTime={time}>{kstDateTime(time)}</time></li>)}</ol></section>}
        {error && <p className="business-error" role="alert">{error}</p>}<div className="rental-detail-actions">{action}</div>
      </div>
    </BusinessDrawer>}
    {dialog?.kind==='ledger' && <ContractLedger contract={dialog.contract} onClose={close}/>}
    {dialog?.kind==='edit' && <RentalDialog init={dialog.contract} devices={devices} branches={configuredBranches} presetDate={dialog.date} presetDeviceId={dialog.deviceId} onClose={close} onSaved={refreshed}/>}
    {dialog?.kind==='return' && <ReturnWizard contract={dialog.contract} onClose={close} onDone={()=>refreshed()}/>}
    {dialog?.kind==='handoff' && <HandoffTokenDialog contract={dialog.contract} onClose={close}/>}
    {dialog?.kind==='photos' && <PhotoGalleryModal contract={dialog.contract} onClose={close}/>}
    {['checkout','review'].includes(dialog?.kind) && <WorkflowAction kind={dialog.kind} c={dialog.contract} onClose={close} onSaved={()=>refreshed()}/>}
  </div>;
}

function WorkflowAction({kind,c,onClose,onSaved}) {
  const review=kind==='review', terms=c.rental_terms || {}, cat=useRentalCatalog();
  const company=useQuery({queryKey:qk.corporateInfo(),queryFn:api.getCorporateInfo,enabled:review});
  const [license,setLicense]=useState(!!terms.license_checked),[confirmed,setConfirmed]=useState(!!terms.confirmed_at);
  const [body,setBody]=useState(templateText(c)),[odometer,setOdometer]=useState(String(c.pickup_odometer_km ?? ''));
  const [fuel,setFuel]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save() {
    if (busy) return;
    if(!review && (!odometer || !Number.isInteger(Number(odometer)) || Number(odometer)<0 || (fuel!=='' && (!Number.isInteger(Number(fuel)) || Number(fuel)<0 || Number(fuel)>100)))) {setError('계기판 주행거리와 연료·충전량을 확인해 주세요.');return;}
    setBusy(true);setError('');
    try{if(review) await api.reviewRental(c.id,{license_checked:license,contract_confirmed:confirmed,template_body:body.trim() || null});
      else await api.checkoutRental(c.id,{odometer_km:Number(odometer),fuel_percent:fuel===''?null:Number(fuel),note:note.trim() || null});
      await onSaved();
    }catch(e){setError(e.message || '저장하지 못했습니다.');}finally{setBusy(false);}
  }
  return <Modal open title={review?'계약·면허 확인':'출고 점검'} subtitle={'예약 R-'+c.id+' · '+carLabel(c)} onClose={busy?undefined:onClose}
    footer={<><Button onClick={onClose} disabled={busy}>닫기</Button><Button variant="primary" busy={busy} onClick={save}>{review?'확인 저장':'차량 인도 완료'}</Button></>}>
    <div className="rental-form-sections">
      {error && <p role="alert" className="business-error">{error}</p>}
      {review?<><p>실운전자 <strong>{terms.driver_name || c.renter_name}</strong></p>
        <label className="rental-check"><input type="checkbox" checked={license} onChange={e=>setLicense(e.target.checked)}/>실운전자 면허를 확인했습니다</label>
        {!!cat.data?.templates?.length && <FormField label="계약서 양식"><Select defaultValue="" onChange={e=>{const t=cat.data.templates.find(x=>String(x.id)===e.target.value);if(t){setBody(fillTemplate(t.body,{...c,vehicle_name:carLabel(c),requested_model:terms.requested_model,billed_krw:agreementTotal(c)},company.data?.company_name));setConfirmed(false);}}}><option value="">양식 선택</option>{cat.data.templates.filter(x=>x.active!==false).map(t=><option key={t.id} value={t.id}>{t.name}</option>)}</Select></FormField>}
        <FormField label="계약 조건"><Textarea value={body} onChange={e=>{setBody(e.target.value);setConfirmed(false);}} maxLength={20000}/></FormField>
        <label className="rental-check"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>고객과 계약 조건을 확인했습니다</label></>:
        <><FormField label="인수 계기판 (km)"><Input type="number" min="0" step="1" value={odometer} onChange={e=>setOdometer(e.target.value)}/></FormField>
          <FormField label="연료·충전량 (%)"><Input type="number" min="0" max="100" step="1" value={fuel} onChange={e=>setFuel(e.target.value)}/></FormField>
          <FormField label="인도 점검 메모"><Textarea value={note} onChange={e=>setNote(e.target.value)} maxLength={1000}/></FormField></>}
    </div>
  </Modal>;
}

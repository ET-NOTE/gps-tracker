import {useRef,useState} from 'react';
import FreightDetail from './FreightDetail';
import FreightOrderForm from './FreightOrderForm';
import {FreightActionForm,FreightAssignForm,FreightProofForm} from './FreightShipmentForms';
import {DispatchView,ScheduleView,WorkflowTable} from './FreightWorkflowViews';
import {FreightButton,FreightField,FreightFilters,FreightForm,FreightOptions,FreightStats} from './FreightKit';
import {epoch,firstOrder,getRow,inputTime,makeOrder,nameOf,orderStates,proofStates,record,routeName,shipStates,stamp,timeLabel,vehicleName,weekdays} from '../../lib/freightWorkflow';
import {freightHeaders,importOrders} from '../../lib/freightCsv';
import {csvCell} from '../../lib/businessExport';
import {saveBlob} from '../../lib/fileDownload';
const allFilters={status:'',scope:'',branch:'',shipper:'',type:'',carrier:'',start:'',end:'',query:''};
const names={orders:'운송 주문',recurring:'정기 주문',dispatch:'배차 관제',schedule:'배차 일정',shipments:'운송 현황',proofs:'인수증·완료 확인'};
function downloadCsv(name,rows){
  const content='\uFEFF'+rows.map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
  return saveBlob(new Blob([content],{type:'text/csv;charset=utf-8'}),name+'.csv');
}
function BulkForm({commit,onClose}){
  const [source,setSource]=useState(''),[error,setError]=useState('');
  return <FreightForm title="운송 주문 일괄 등록" onClose={onClose} submitLabel="일괄 등록" onSubmit={()=>commit(next=>importOrders(next,source))}>
    <p className="fr-note">등록 서식에 화주·지점·상하차지 이름을 입력해 주세요. 최대 100건까지 등록할 수 있습니다.</p>
    <div><FreightButton onClick={async()=>{try{await downloadCsv('화물주문_등록서식',[freightHeaders]);}catch(e){setError(e.message);}}}>등록 서식 다운로드</FreightButton></div>
    <FreightField wide label="CSV 파일"><input type="file" accept=".csv,text/csv" onChange={async e=>{
      const file=e.target.files[0];if(!file)return;
      try{if(file.size>1024*1024)throw Error('1MB 이하의 파일을 선택해 주세요.');setSource(await file.text());setError('');}catch(err){setError(err.message);}
    }}/></FreightField>
    {error&&<p role="alert" className="fr-note fr-error">{error}</p>}
    <FreightField wide label="CSV 내용"><textarea required rows="8" value={source} onChange={e=>setSource(e.target.value)}/></FreightField>
  </FreightForm>;
}
function OrderActionForm({action,row,commit,onClose}){
  const title={cancelOrder:'운송 주문 취소',generate:'정기 운송 주문 생성',deleteTemplate:'정기 주문 삭제'}[action];
  return <FreightForm size="md" title={title} subtitle={row.number||row.name} onClose={onClose} submitLabel={{generate:'주문 생성',cancelOrder:'주문 취소',deleteTemplate:'삭제'}[action]} onSubmit={form=>commit(next=>{
    if(action==='cancelOrder'){
      const o=getRow(next,'orders',row.id),reason=String(form.get('reason')||'').trim();
      if(!o||o.status!=='open'||!reason)throw Error('미배차 주문과 취소 사유를 확인해 주세요.');
      o.status='cancelled';record(next,o,'주문 취소 · '+reason);return;
    }
    const r=getRow(next,'recurring',row.id);
    if(action==='deleteTemplate'){
      if(next.orders.some(o=>o.recurringId===r.id))throw Error('생성된 주문이 있는 정기 주문은 사용 중지할 수 있습니다.');
      next.recurring=next.recurring.filter(v=>v.id!==r.id);record(next,null,'정기 주문 삭제 · '+r.name);return;
    }
    const date=form.get('date');
    if(!r.active||!r.weekdays.includes(new Date(date+'T12:00:00Z').getUTCDay()))throw Error('사용 중인 정기 주문의 반복 요일을 선택해 주세요.');
    if(next.orders.some(o=>o.recurringId===r.id&&o.recurringDate===date))throw Error('해당 날짜의 정기 주문이 이미 생성되어 있습니다.');
    const fields=['shipperId','branchId','pickupLocationId','dropoffLocationId','cargoName','quantity','unit','weightKg','capacityKg','vehicleType','temperature','tripType','mixedAllowed','sellAmount','buyAmount','note'];
    const cargo=Object.fromEntries(fields.map(key=>[key,r[key]]));
    makeOrder(next,{...cargo,start:date+'T'+r.startTime,end:date+'T'+r.endTime,externalRef:'',userId:'',recurringId:r.id,recurringDate:date});
    r.lastGenerated=date;record(next,r,'정기 주문 생성 · '+date);
  })}>
    {action==='cancelOrder'?<FreightField wide label="취소 사유"><textarea name="reason" required maxLength={500}/></FreightField>:
      action==='generate'?<><FreightField wide label="운송일"><input name="date" type="date" required defaultValue={stamp().slice(0,10)}/></FreightField><p className="fr-note">반복 요일 · {row.weekdays.map(v=>weekdays[v]).join(' · ')}</p></>:
      <p className="fr-note">이 정기 주문을 삭제할까요?</p>}
  </FreightForm>;
}

export function FreightRecordActions({data,save,onPage,children}) {
  const [detail,setDetail]=useState(null),[dialog,setDialog]=useState(null),[feedback,setFeedback]=useState('');
  const currentData=useRef(data);currentData.current=data;
  const open=(kind,id)=>setDetail({kind,id});
  const form=(action,kind,id,vehicle)=>{setFeedback('');setDialog({action,kind,id,vehicle,base:data});};
  const close=()=>setDialog(null);
  const navigate=p=>{close();setDetail(null);onPage(p);};
  async function commit(recipe){
    if(!dialog||dialog.base!==currentData.current)throw Error('다른 변경 사항이 반영됐습니다. 양식을 다시 열어 주세요.');
    const next=structuredClone(dialog.base);recipe(next);
    await save(next);
    if(dialog.action==='deleteTemplate')setDetail(null);
    close();setFeedback('저장했습니다.');
  }
  const chosen=detail&&getRow(data,detail.kind,detail.id),d=dialog,r=d&&getRow(data,d.kind,d.id);
  return <>{children({open,form,navigate,feedback,setFeedback})}
    {chosen&&!d&&<FreightDetail kind={detail.kind} row={chosen} data={data} form={form} open={open} onClose={()=>setDetail(null)} onPage={navigate}/>}
    {d&&(['new','edit'].includes(d.action)?<FreightOrderForm data={data} row={r} recurring={d.kind==='recurring'} onClose={close} commit={commit} onPage={navigate}/>:
      d.action==='assign'?<FreightAssignForm data={data} order={d.kind==='orders'?r:firstOrder(data,r)} shipment={d.kind==='shipments'?r:null} initialVehicle={d.vehicle} onClose={close} commit={commit}/>:
      d.action==='proof'?<FreightProofForm shipment={r} onClose={close} commit={commit}/>:
      d.action==='import'?<BulkForm onClose={close} commit={commit}/>:
      ['cancelOrder','generate','deleteTemplate'].includes(d.action)?<OrderActionForm action={d.action} row={r} commit={commit} onClose={close}/>:
      <FreightActionForm action={d.action} data={data} shipment={r} onClose={close} commit={commit}/>)}
  </>;
}

export default function FreightWorkflow({page,...props}) {
  const key=page.replace(/^cargo-/, '');
  return <FreightRecordActions key={key} {...props}>{actions=><WorkflowPage page={key} data={props.data} {...actions}/>}</FreightRecordActions>;
}
function WorkflowPage({page,data,open,form,navigate,feedback,setFeedback}) {
  const [filters,setFilters]=useState(allFilters);
  const isOrder=page==='orders'||page==='dispatch',recurring=page==='recurring',isShipment=!recurring&&!isOrder,proofs=page==='proofs',schedule=page==='schedule';
  const stateLabels=proofs?proofStates:recurring?{active:'사용 중',inactive:'사용 중지'}:isOrder?orderStates:shipStates;
  const shipList=page==='shipments';
  const tabs=shipList?{today:'오늘 상차',active:'운송 진행',late:'하차 지연'}:stateLabels;
  const tabKey=shipList?'scope':'status';
  const f=filters;
  const contains=(...parts)=>parts.some(v=>String(v||'').toLocaleLowerCase().includes(f.query.trim().toLocaleLowerCase()));
  const change=(name,value)=>setFilters(v=>({...v,[name]:value}));
  const source=data[recurring?'recurring':isOrder?'orders':'shipments'];
  const rows=source.filter(r=>{
    const o=isShipment?firstOrder(data,r):r;
    if(!o)return false;
    const state=proofs?r.proof.status:recurring?r.active?'active':'inactive':r.status;
    const date=inputTime(proofs?r.events.findLast(e=>e.type==='delivered')?.at||r.end:r.start).slice(0,10);
    if(schedule&&r.status==='cancelled')return false;
    if(f.scope==='today'&&date!==stamp().slice(0,10))return false;
    if(f.scope==='active'&&!['confirmed','loading','in_transit'].includes(r.status))return false;
    if(f.scope==='late'&&(['delivered','cancelled'].includes(r.status)||epoch(r.end)>=Date.now()))return false;
    return (page!=='dispatch'||r.status==='open')&&(!proofs||r.status==='delivered')&&(!f.status||f.status===state)
      &&(!f.branch||r.branchId===f.branch)&&(!f.shipper||o.shipperId===f.shipper)&&(!f.type||o.vehicleType===f.type)&&(!f.carrier||(f.carrier==='own'?!r.carrierId:r.carrierId===f.carrier))
      &&(!f.start||date>=f.start)&&(!f.end||date<=f.end)&&contains(r.number,r.name,o.number,o.externalRef,o.cargoName,routeName(data,o),nameOf(data,'shippers',o.shipperId),vehicleName(data,r.vehicleId),nameOf(data,'drivers',r.driverId),r.proof?.receiver);
  });
  if(!recurring)rows.sort((a,b)=>epoch(a.start)-epoch(b.start));
  const requests=page==='dispatch'?data.shipments.filter(s=>{
    const o=firstOrder(data,s);
    return s.status==='requested' && (!f.branch||s.branchId===f.branch) && (!f.shipper||o?.shipperId===f.shipper)
      && (!f.type||o?.vehicleType===f.type) && (!f.scope||inputTime(s.start).slice(0,10)===stamp().slice(0,10))
      && contains(s.number,o?.number,o?.cargoName,nameOf(data,'shippers',o?.shipperId),routeName(data,o),vehicleName(data,s.vehicleId),nameOf(data,'drivers',s.driverId));
  }):[];
  const services=schedule&&!f.status?data.services.filter(s=>(!f.branch||getRow(data,'vehicles',s.vehicleId)?.branchId===f.branch)&&contains(s.type,vehicleName(data,s.vehicleId),s.note)):[];
  const count=status=>rows.filter(r=>r.status===status).length;
  const summary=recurring?[['정기 주문',rows.length],['사용 중',rows.filter(r=>r.active).length],['사용 중지',rows.filter(r=>!r.active).length]]:
    isOrder?[['조회 주문',rows.length],['미배차',count('open')],['배차 진행',count('assigned')],['운임 미정',rows.filter(r=>r.sellAmount==null||r.buyAmount==null).length]]:
    proofs?Object.entries(proofStates).map(([key,label])=>[label,rows.filter(r=>r.proof.status===key).length]):
    [['조회 운송',rows.length],['수락 대기',count('requested')],['운송 진행',rows.filter(r=>['confirmed','loading','in_transit'].includes(r.status)).length],['하차 완료',count('delivered')]];
  async function exportRows(){
    const header=recurring?['정기 주문','화주','구간','반복 요일','상·하차 시간','사용 여부']:isOrder?['주문번호','화주','구간','상차','하차','차량 형태','중량kg','청구 운임','지급 운임','상태']:['운송번호','화주','구간','상차','하차','차량','기사','운송 상태','인수증 상태','수령인'];
    const body=rows.map(r=>{
      const o=isShipment?firstOrder(data,r):r,shipper=nameOf(data,'shippers',o.shipperId),route=routeName(data,o);
      return recurring?[r.name,shipper,route,r.weekdays.map(v=>weekdays[v]).join('/'),r.startTime+' ~ '+r.endTime,r.active?'사용 중':'중지']:
        isOrder?[r.number,shipper,route,timeLabel(r.start),timeLabel(r.end),r.vehicleType,r.weightKg,r.sellAmount,r.buyAmount,orderStates[r.status]]:
        [r.number,shipper,route,timeLabel(r.start),timeLabel(r.end),vehicleName(data,r.vehicleId),nameOf(data,'drivers',r.driverId),shipStates[r.status],proofStates[r.proof.status],r.proof.receiver];
    });
    try{await downloadCsv(names[page]+'_'+stamp().slice(0,10),[header,...body]);}catch(e){setFeedback(e.message);}
  }
  const setup=(rows,key,label)=><FreightField label={label}><select value={f[key]} onChange={e=>change(key,e.target.value)}><FreightOptions rows={rows} blank={key==='branch'?'전체 지점':'전체 '+label}/></select></FreightField>;
  const filterBar=<FreightFilters onReset={()=>setFilters(allFilters)} query={f.query} onQuery={q=>change('query',q)} placeholder={recurring?'정기 주문·화주·화물 검색':'주문·화주·차량·기사 검색'}>
      {!recurring&&!schedule&&page!=='dispatch'&&<fieldset className="rental-stage-period"><legend>{proofs?'하차 완료 기간':'상차 예정 기간'}</legend><div><input type="date" aria-label="조회 시작일" max={f.end||undefined} value={f.start} onChange={e=>change('start',e.target.value)}/><span>–</span><input type="date" aria-label="조회 종료일" min={f.start||undefined} value={f.end} onChange={e=>change('end',e.target.value)}/></div></fieldset>}
      {setup(data.branches,'branch','담당 지점')}{(recurring||isOrder)&&setup(data.shippers,'shipper','화주')}
      {recurring&&<FreightField label="사용 여부"><select aria-label="사용 여부" value={f.status} onChange={e=>change('status',e.target.value)}><option value="">전체</option><option value="active">사용 중</option><option value="inactive">사용 중지</option></select></FreightField>}
      {isOrder&&<FreightField label="필요 차량"><select value={f.type} onChange={e=>change('type',e.target.value)}><option value="">전체 차량 형태</option>{data.codes.vehicleTypes.map(t=><option key={t}>{t}</option>)}</select></FreightField>}
      {page==='shipments'&&<FreightField label="운송사"><select value={f.carrier} onChange={e=>change('carrier',e.target.value)}><option value="">전체</option><option value="own">직영</option><FreightOptions rows={data.carriers}/></select></FreightField>}
      {(schedule||shipList)&&<FreightField label="운송 단계"><select value={f.status} onChange={e=>change('status',e.target.value)}><option value="">전체</option>{Object.entries(shipStates).filter(([k])=>!schedule||k!=='cancelled').map(([key,val])=><option key={key} value={key}>{val}</option>)}</select></FreightField>}
    </FreightFilters>;
  return <div className="fr-page fr-workflow">
    {!schedule&&!recurring&&page!=='dispatch'&&<FreightStats items={summary} unit="건"/>}
    {!schedule&&<div className="fr-toolbar">{recurring&&<span className="fr-recurring-summary">{summary.map(([label,count])=>label+' '+count.toLocaleString('ko-KR')+'건').join(' · ')}</span>}{page==='dispatch'&&<div className="fr-tabs"><button type="button" className="fr-tab" aria-pressed={!f.scope} onClick={()=>change('scope','')}>전체 미배차</button><button type="button" className="fr-tab" aria-pressed={f.scope==='today'} onClick={()=>change('scope','today')}>오늘 상차</button></div>}{page!=='dispatch'&&!schedule&&!recurring&&<div className="fr-tabs"><button className="fr-tab" aria-pressed={!f[tabKey]} onClick={()=>change(tabKey,'')}>전체</button>{Object.entries(tabs).map(([k,l])=><button key={k} className="fr-tab" aria-pressed={f[tabKey]===k} onClick={()=>change(tabKey,k)}>{l}</button>)}</div>}
      <div className="fr-actions">{!schedule&&<FreightButton icon="download" onClick={exportRows}>CSV 다운로드</FreightButton>}{page==='orders'&&<FreightButton icon="upload" onClick={()=>form('import','orders')}>일괄 등록</FreightButton>}
        {(isOrder||recurring)&&<FreightButton primary icon="plus" onClick={()=>form('new',recurring?'recurring':'orders')}>{recurring?'정기 주문 등록':'주문 등록'}</FreightButton>}</div>
    </div>}
    {!schedule&&filterBar}
    {feedback&&<p role="status" className="fr-note">{feedback}</p>}
    {page==='dispatch'?<DispatchView data={data} orders={rows} requests={requests} form={form} open={open}/>:schedule?<ScheduleView filters={filterBar} data={data} rows={rows} services={services} open={open} onDispatch={()=>navigate('cargo-dispatch')} onExport={async(week,entries)=>{
      try{await downloadCsv('배차일정_'+week,[['구분','운송번호 / 작업','구간 / 차량','시작','종료'],...entries.map(e=>[e.kind==='services'?'정비·보험':'운송',e.title,e.info,timeLabel(e.row.start),timeLabel(e.row.end)])]);}catch(e){setFeedback(e.message);}
    }}/>:<WorkflowTable page={page} data={data} rows={rows} open={open} form={form}/>}
  </div>;
}

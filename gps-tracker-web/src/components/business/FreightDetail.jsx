import {useState} from 'react';
import Icon from '../Icon';
import truckArt from './freight-truck.svg';
import {FreightBadge,FreightButton,FreightDrawer,FreightFacts,Status} from './FreightKit';
import {FreightCatalogDialogs} from './FreightCatalog';
import {FreightPhotos} from './FreightShipmentForms';
import useFreightStaff from './useFreightStaff';
import {costLabel,firstOrder,getRow,invoiceLabel,nameOf,orderStates,proofStates,shipStates,stepMap,timeLabel,vehicleName,weekdays} from '../../lib/freightWorkflow';
import {shipmentFinance} from '../../lib/freightFinance';

const eventLabels={requested:'배차 요청',confirmed:'배차 확정',arrived:'상차지 도착',loaded:'상차 완료',delivered:'하차 완료',reassigned:'배차 변경',cancelled:'배차 취소',declined:'배차 거절'};

export {Status,tone} from './FreightKit';
export function nextAction(s){
  if(s.status==='requested')return ['accept','수락 확인'];
  if(stepMap[s.status])return [stepMap[s.status].type,stepMap[s.status].label];
  if(s.status==='delivered'){
    if(['missing','rework'].includes(s.proof.status))return ['proof','인수증 제출'];
    if(s.proof.status==='submitted')return ['approved','인수증 확인'];
  }
  return null;
}

function Block({title,children}) {
  return <section className="fr-record-block"><h3>{title}</h3>{children}</section>;
}

export default function FreightDetail({data,kind,row:r,onClose,form,open,onPage,onDispatch,save}){
  const shipment=kind==='shipments'?r:null,order=shipment?firstOrder(data,shipment):r;
  const recurring=kind==='recurring',service=kind==='services';
  const staff=useFreightStaff(!!order?.userId && !service);
  const [related,setRelated]=useState(null);
  const next=shipment&&nextAction(shipment);
  const beforeStart=shipment&&['requested','confirmed'].includes(shipment.status);
  const mayReassign=beforeStart&&shipment.invoiceStatus!=='issued'&&shipment.payableStatus!=='confirmed'&&!data.payments.some(p=>p.shipmentId===shipment.id);
  const orders=shipment?(shipment.orderIds||[]).map(id=>getRow(data,'orders',id)).filter(Boolean):[];
  const finance=shipment&&shipmentFinance(data,shipment);
  const generated=recurring?data.orders.filter(o=>o.recurringId===r.id):[];
  const shipments=kind==='orders'?data.shipments.filter(s=>s.id===r.shipmentId||s.orderIds?.includes(r.id)):[];
  const title={shipments:'배차·운송 상세',orders:'운송 주문 상세',recurring:'정기 주문 상세',services:'정비·보험 일정'}[kind];
  const close=<FreightButton onClick={onClose}>닫기</FreightButton>;

  function catalogButton(key,id,label,icon) {
    if(!getRow(data,key,id))return null;
    return <FreightButton icon={icon} onClick={()=>setRelated({kind:key,id,action:'detail'})}>{label}</FreightButton>;
  }
  function setRelatedView(view) {
    setRelated(previous=>view?{...previous,...view}:null);
  }
  const actions=<div className="fr-actions">
    {service&&<FreightButton onClick={()=>onPage('cargo-maintenance')}>정비·보험 관리</FreightButton>}
    {recurring&&<><FreightButton disabled={!!generated.length} onClick={()=>form('deleteTemplate',kind,r.id)}>삭제</FreightButton>
      <FreightButton onClick={()=>form('edit',kind,r.id)}>수정</FreightButton>
      <FreightButton primary disabled={!r.active} onClick={()=>form('generate',kind,r.id)}>주문 생성</FreightButton></>}
    {kind==='orders'&&(r.status==='open'?<>
      <FreightButton onClick={()=>form('cancelOrder',kind,r.id)}>주문 취소</FreightButton>
      <FreightButton icon="edit" onClick={()=>form('edit',kind,r.id)}>주문 수정</FreightButton>
      <FreightButton primary icon="car" onClick={()=>onDispatch(r.id)}>차량·기사 배차</FreightButton>
    </>:close)}
    {next&&<FreightButton primary onClick={()=>form(next[0],kind,r.id)}>{next[1]}</FreightButton>}
    {shipment?.status==='requested'&&<FreightButton onClick={()=>form('decline',kind,r.id)}>배차 거절</FreightButton>}
    {mayReassign&&<><FreightButton onClick={()=>form('assign',kind,r.id)}>재배차</FreightButton><FreightButton onClick={()=>form('release',kind,r.id)}>배차 해제</FreightButton></>}
    {shipment?.status==='delivered'&&shipment.proof.status==='submitted'&&<><FreightButton onClick={()=>form('rework',kind,r.id)}>보완 요청</FreightButton><FreightButton onClick={()=>form('proof',kind,r.id)}>인수증 수정</FreightButton></>}
    {shipment&&<FreightButton onClick={()=>open('finance',r.id)}>운임·정산</FreightButton>}
  </div>;
  const staffName=order?.userId?(staff.rows.find(p=>String(p.id)===String(order.userId))?.name||'기존 담당자'):'운영 관리자';
  const branchName=nameOf(data,'branches',r.branchId);
  const cargoConditions=<Block title="화물·차량 조건"><FreightFacts items={[
    ['화물',order?.cargoName],['수량',order?.quantity==null?'—':order.quantity.toLocaleString('ko-KR')+' '+(order.unit||'')],
    ['화물 중량',order?.weightKg==null?'—':order.weightKg.toLocaleString('ko-KR')+' kg'],
    ['요청 차량',[order?.vehicleType,order?.capacityKg!=null&&order.capacityKg.toLocaleString('ko-KR')+' kg 이상'].filter(Boolean).join(' · ')||'—'],
    ['온도 / 운송 형태',[order?.temperature,order?.tripType].filter(Boolean).join(' / ')||'—'],['혼적 허용',order?.mixedAllowed?'허용 조건으로 접수':'단독 운송'],
  ]}/></Block>;
  const orderExtras=<>{cargoConditions}
    <Block title="합의 운임"><FreightFacts items={[[ '화주 운임',costLabel(r.sellAmount)],['운송 원가',costLabel(r.buyAmount)]]}/></Block>
    <div className="fr-actions fr-record-shortcuts">{catalogButton('shippers',order?.shipperId,'화주 정보','office')}
      {catalogButton('locations',order?.pickupLocationId,'상차지 안내','mapPin')}{catalogButton('locations',order?.dropoffLocationId,'하차지 안내','mapPin')}</div>
    <Block title="작업 요청사항"><p className="fr-record-note">{r.note||'등록된 요청사항이 없습니다.'}</p></Block>
  </>;
  return <>
    <FreightDrawer title={title} subtitle={r.number||r.name||r.type} onClose={onClose} footer={actions}>
      {service?<FreightFacts items={[[ '차량',vehicleName(data,r.vehicleId)],['시작',timeLabel(r.start)],['종료',timeLabel(r.end)],['상태',r.status==='done'?'완료':'예정'],['메모',r.note||'—']]}/>:<>
        <div className="fr-record-heading">{shipment?<div className="fr-record-vehicle"><img src={truckArt} width="56" height="34" alt=""/>
          <div><strong>{vehicleName(data,r.vehicleId)}</strong><small>{nameOf(data,'drivers',r.driverId)}</small></div></div>:<strong>{nameOf(data,'shippers',order?.shipperId)}</strong>}
          {recurring?<FreightBadge>{r.active?'사용 중':'사용 중지'}</FreightBadge>:<Status value={r.status} labels={shipment?shipStates:orderStates}/>}</div>
        <div className="fr-record-route"><span>{nameOf(data,'locations',order?.pickupLocationId)}</span><Icon name="chevron-right" size={15}/><span>{nameOf(data,'locations',order?.dropoffLocationId)}</span></div>
        {shipment?<><FreightFacts items={[[ '상차 / 하차 예정',timeLabel(r.start)+' / '+timeLabel(r.end)],['소속 운송사',r.carrierId?nameOf(data,'carriers',r.carrierId):'자사 차량'],['담당 지점',branchName]]}/>
          <div className="fr-actions fr-record-shortcuts">{catalogButton('vehicles',r.vehicleId,'차량 정보','car')}{catalogButton('drivers',r.driverId,'기사 정보','user')}{catalogButton('carriers',r.carrierId,'운송사 정보','office')}</div>
        </>:<><FreightFacts items={[
          ...(recurring?[['반복 요일',r.weekdays.map(d=>weekdays[d]).join(' · ')],['상차 / 하차 시간',r.startTime+' / '+r.endTime],['최근 주문 생성',r.lastGenerated||'—']]:[['상차 예정',timeLabel(r.start)],['하차 예정',timeLabel(r.end)]]),
          ['화주 주문번호',r.externalRef||'—'],recurring?['담당 지점',branchName]:['담당 지점 / 직원',branchName+' / '+staffName],
        ]}/>{orderExtras}</>}
        {kind==='orders'&&<Block title="연결된 배차·운송">{shipments.length?shipments.map(s=><button type="button" key={s.id} className="fr-record-link" onClick={()=>open('shipments',s.id)}>
          <span>{s.number}<small>{vehicleName(data,s.vehicleId)} · {nameOf(data,'drivers',s.driverId)}</small></span><Status value={s.status} labels={shipStates}/></button>):<p className="fr-record-note">아직 배차되지 않았습니다.</p>}</Block>}
        {shipment&&<><Block title="연결 주문">{orders.map(o=><button type="button" className="fr-record-link" key={o.id} onClick={()=>open('orders',o.id)}><span>{o.number} · {nameOf(data,'shippers',o.shipperId)}<small>{o.cargoName} · {o.weightKg==null?'—':o.weightKg.toLocaleString('ko-KR')+' kg'}</small></span><Icon name="chevron-right" size={14}/></button>)}</Block>
          <Block title="운임·정산"><FreightFacts items={[
            ['화주 청구 예정',costLabel(finance.sell)],['운송 지급 예정',costLabel(finance.buy)],['운임 차익',costLabel(finance.margin)],
            ['화주 순수납',costLabel(finance.received)],['운송비 순지급',costLabel(finance.paid)],
            ['화주 청구 상태',invoiceLabel(r)],['운송비 정산',r.payableStatus==='confirmed'?'금액 확인 완료':'금액 확인 전'],
          ]}/></Block>
          <Block title="운송 진행">{r.events?.length?<ol className="fr-record-history">{r.events.map((event,i)=><li key={i}>{eventLabels[event.type]||event.type}<small>{timeLabel(event.at)}</small>{event.note&&<p className="fr-record-note">{event.note}</p>}</li>)}</ol>:<p className="fr-record-note">진행 기록이 없습니다.</p>}</Block>
          <Block title="인수증·수령 확인"><FreightFacts items={[
            ['확인 상태',<Status value={r.proof.status} labels={proofStates}/>],['수령인',r.proof.receiver||'—'],['수령 확인',timeLabel(r.proof.at)],['수령 메모',r.proof.note||'—'],
            ...(r.proof.reviewedAt?[['검토 일시',timeLabel(r.proof.reviewedAt)],['검토 메모',r.proof.reviewNote||'—']]:[]),
          ]}/><FreightPhotos files={r.proof.files}/></Block>
          <Block title="배차 전달사항"><p className="fr-record-note">{r.note||'등록된 전달사항이 없습니다.'}</p></Block>
          <details className="fr-record-more"><summary>주문 조건·요청사항</summary><FreightFacts items={[[ '배차 담당자',staffName]]}/>{orderExtras}</details></>}
        {!!generated.length&&<Block title="생성한 주문">{generated.map(o=><button type="button" className="fr-record-link" key={o.id} onClick={()=>open('orders',o.id)}>{o.number}<Status value={o.status} labels={orderStates}/></button>)}</Block>}
        <Block title="처리 이력">{r.history?.length?<ul className="fr-record-history">{r.history.map((h,i)=><li key={i}>{h.text}<small>{timeLabel(h.at)}</small></li>)}</ul>:<p className="fr-record-note">등록된 이력이 없습니다.</p>}</Block>
      </>}
    </FreightDrawer>
    {related&&<FreightCatalogDialogs kind={related.kind} data={data} save={save} view={related} setView={setRelatedView}
      onOpenRecord={(kind,id)=>{setRelated(null);open(kind,id);}}/>}
  </>;
}

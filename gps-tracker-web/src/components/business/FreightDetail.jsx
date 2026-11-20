import BusinessDrawer from './BusinessDrawer';
import {FreightBadge,FreightButton,FreightFacts} from './FreightKit';
import {FreightPhotos} from './FreightShipmentForms';
import useFreightStaff from './useFreightStaff';
import {costLabel,firstOrder,nameOf,orderStates,proofStates,routeName,shipStates,stepMap,timeLabel,vehicleName,weekdays} from '../../lib/freightWorkflow';

export const tone=k=>({open:'amber',requested:'amber',loading:'amber',assigned:'blue',confirmed:'blue',in_transit:'blue',submitted:'blue',approved:'green',delivered:'green',completed:'green',cancelled:'red',rework:'red'}[k]||'neutral');
export function Status({value,labels}){return <FreightBadge tone={tone(value)}>{labels[value]||'—'}</FreightBadge>;}
export function nextAction(s){
  if(s.status==='requested')return ['accept','배차 수락'];
  if(stepMap[s.status])return [stepMap[s.status].type,stepMap[s.status].label];
  if(s.status==='delivered'){
    if(['missing','rework'].includes(s.proof.status))return ['proof','인수증 제출'];
    if(s.proof.status==='submitted')return ['approved','인수증 확인'];
  }
  return null;
}
export default function FreightDetail({data,kind,row:r,onClose,form,open,onPage}){
  const s=kind==='shipments'?r:null,o=s?firstOrder(data,s):r, recurring=kind==='recurring',service=kind==='services';
  const staff=useFreightStaff(!!o?.userId && !service);
  const next=s&&nextAction(s), linked=s?.orderIds||[];
  const beforeStart=s&&['requested','confirmed'].includes(s.status);
  const mayReassign=beforeStart&&s.invoiceStatus!=='issued'&&s.payableStatus!=='confirmed'&&!data.payments.some(p=>p.shipmentId===s.id);
  const recurringOrders=recurring?data.orders.filter(o=>o.recurringId===r.id):[];
  const title={shipments:'운송 상세',orders:'운송 주문 상세',recurring:'정기 주문 상세',services:'정비·보험 일정'}[kind];
  return <BusinessDrawer title={title} subtitle={r.number||r.name||r.type} onClose={onClose}><div className="fr-section">
    {service?<><FreightFacts items={[['차량',vehicleName(data,r.vehicleId)],['시작',timeLabel(r.start)],['종료',timeLabel(r.end)],['상태',r.status==='done'?'완료':'예정'],['메모',r.note||'—']]}/><div><FreightButton onClick={()=>onPage('cargo-maintenance')}>정비·보험 관리</FreightButton></div></>:<>
      <div className="fr-toolbar"><strong>{routeName(data,o)}</strong>{recurring?<FreightBadge>{r.active?'사용 중':'사용 중지'}</FreightBadge>:<Status value={r.status} labels={s?shipStates:orderStates}/>}</div>
      <FreightFacts items={[
        ['화주',nameOf(data,'shippers',o?.shipperId)],['담당 지점',nameOf(data,'branches',r.branchId)],
        ...(!recurring?[['배차 담당자',o?.userId?(staff.rows.find(p=>String(p.id)===String(o.userId))?.name||'기존 담당자'):'운영 관리자']]:[]),
        ...(recurring?[['반복 요일',r.weekdays.map(d=>weekdays[d]).join(' · ')],['상차 / 하차 시간',r.startTime+' / '+r.endTime],['최근 주문 생성',r.lastGenerated||'—']]:[['상차 예정',timeLabel(r.start)],['하차 예정',timeLabel(r.end)]]),
        ['화물',o?.cargoName],['수량 / 중량',(o?.quantity??'—')+' '+(o?.unit||'')+' / '+(o?.weightKg??'—')+' kg'],
        ['필요 차량',o?.vehicleType+' · '+o?.capacityKg+' kg'],['운송 조건',[o?.temperature,o?.tripType,o?.mixedAllowed?'혼적 허용':'단독'].join(' · ')],
        ...(s?[['배차 차량',vehicleName(data,s.vehicleId)],['운행 기사',nameOf(data,'drivers',s.driverId)],['운송사',s.carrierId?nameOf(data,'carriers',s.carrierId):'직영']]:[['화주 주문번호',r.externalRef||'—']]),
        ['화주 합의 운임',costLabel(r.sellAmount)],['운송 합의 원가',costLabel(r.buyAmount)],['메모',r.note||'—'],
      ]}/>
      {s&&<><section className="fr-section"><h3>인수증·수령 확인</h3><FreightFacts items={[
        ['확인 상태',<Status value={s.proof.status} labels={proofStates}/>],['수령인',s.proof.receiver||'—'],['수령 확인',timeLabel(s.proof.at)],['수령 메모',s.proof.note||'—'],
        ...(s.proof.reviewedAt?[['검토 일시',timeLabel(s.proof.reviewedAt)],['검토 메모',s.proof.reviewNote||'—']]:[]),
      ]}/><FreightPhotos files={s.proof.files}/></section>
      <div className="fr-actions">{linked.map(id=><FreightButton key={id} onClick={()=>open('orders',id)}>{data.orders.find(o=>o.id===id)?.number||'연결 주문'}</FreightButton>)}</div></>}
      {r.history?.length>0&&<section className="fr-section"><h3>처리 이력</h3><ul className="fr-history">{r.history.map((item,i)=><li key={i}>{timeLabel(item.at)} · {item.text}</li>)}</ul></section>}
      {recurringOrders.length>0&&<section className="fr-section"><h3>생성한 주문</h3><div className="fr-actions">{recurringOrders.map(o=><FreightButton key={o.id} onClick={()=>open('orders',o.id)}>{o.number}</FreightButton>)}</div></section>}
      <div className="fr-actions">
        {recurring&&<><FreightButton primary disabled={!r.active} onClick={()=>form('generate',kind,r.id)}>주문 생성</FreightButton><FreightButton onClick={()=>form('edit',kind,r.id)}>수정</FreightButton>
          <FreightButton disabled={!!recurringOrders.length} onClick={()=>form('deleteTemplate',kind,r.id)}>삭제</FreightButton></>}
        {kind==='orders'&&(r.status==='open'?<><FreightButton primary onClick={()=>form('assign',kind,r.id)}>배차 등록</FreightButton><FreightButton onClick={()=>form('edit',kind,r.id)}>주문 수정</FreightButton><FreightButton onClick={()=>form('cancelOrder',kind,r.id)}>주문 취소</FreightButton></>:r.shipmentId&&<FreightButton onClick={()=>open('shipments',r.shipmentId)}>연결된 운송 보기</FreightButton>)}
        {next&&<FreightButton primary onClick={()=>form(next[0],kind,r.id)}>{next[1]}</FreightButton>}
        {s?.status==='requested'&&<FreightButton onClick={()=>form('decline',kind,r.id)}>배차 거절</FreightButton>}
        {mayReassign&&<><FreightButton onClick={()=>form('assign',kind,r.id)}>재배차</FreightButton><FreightButton onClick={()=>form('release',kind,r.id)}>배차 해제</FreightButton></>}
        {s?.status==='delivered'&&s.proof.status==='submitted'&&<><FreightButton onClick={()=>form('rework',kind,r.id)}>보완 요청</FreightButton><FreightButton onClick={()=>form('proof',kind,r.id)}>인수증 수정</FreightButton></>}
      </div>
    </>}
  </div></BusinessDrawer>;
}

import {useState} from 'react';
import truckArt from './freight-truck.svg';
import {FreightBadge,FreightButton,FreightField,FreightTable} from './FreightKit';
import {nextAction,Status} from './FreightDetail';
import {addDays,candidate,costLabel,epoch,firstOrder,invoiceLabel,nameOf,orderStates,proofStates,routeName,shipStates,stamp,timeLabel,vehicleName,weekdays,weekOf} from '../../lib/freightWorkflow';
const num=n=>Number(n).toLocaleString('ko-KR');
const mainCell=(main,detail)=><>{main}<small>{detail}</small></>;
function detailLink(label,click){return <button className="fr-link" onClick={click}>{label}</button>;}

export function WorkflowTable({page,data,rows,open,form,mockup=false}){
  const orders=page==='orders',recurring=page==='recurring',proofs=page==='proofs';
  if(orders||recurring)return <FreightTable columns={recurring?['정기 주문 / 화주','상·하차 구간','반복 요일','상차 / 하차 시간','차량·화물','사용 여부','주문 생성']:(mockup?['주문 / 화주','상·하차 구간','상차 / 하차 예정','화물 / 요청 차량','합의 운임','상태']:['주문 / 화주','상·하차 구간','상차 / 하차 예정','화물 / 요청 차량','청구 / 지급 운임','상태','업무 처리'])} empty={recurring?'조회된 정기 주문이 없습니다.':'조회된 운송 주문이 없습니다.'} rows={rows.map(o=>({
    id:o.id,onOpen:()=>open(page,o.id),cells:[mainCell(detailLink(recurring?o.name:o.number,()=>open(page,o.id)),nameOf(data,'shippers',o.shipperId)),routeName(data,o),
      ...(recurring?[o.weekdays.map(d=>weekdays[d]).join(' · '),o.startTime+' / '+o.endTime]:[mainCell(timeLabel(o.start),timeLabel(o.end))]),
      mainCell(o.cargoName,o.vehicleType+' · '+num(o.weightKg)+' kg'),...(!recurring?[mockup?costLabel(o.sellAmount):mainCell(costLabel(o.sellAmount),costLabel(o.buyAmount))]:[]),
      recurring?<FreightBadge tone={o.active?'blue':'neutral'}>{o.active?'사용 중':'중지'}</FreightBadge>:<Status value={o.status} labels={orderStates}/>,
      ...(mockup&&orders?[]:[<div className="fr-actions">{recurring?<FreightButton disabled={!o.active} onClick={()=>form('generate',page,o.id)}>주문 생성</FreightButton>:
        o.status==='open'?<FreightButton onClick={()=>form('assign',page,o.id)}>배차 등록</FreightButton>:<FreightButton onClick={()=>open(page,o.id)}>상세</FreightButton>}</div>])]
  }))}/>;
  return <FreightTable columns={proofs?['운송 / 화주','운송 구간','차량 / 기사','수령 확인','증빙 상태','청구 상태','업무 처리']:['운송 / 화주','운송 구간','차량 / 기사','상차 / 하차 예정','운송 단계','인수증','업무 처리']} empty={proofs?'하차를 완료한 운송이 없습니다.':'조회된 운송이 없습니다.'} rows={rows.map(s=>{
    const o=firstOrder(data,s),next=nextAction(s);
    const proofLabel={missing:'인수증 등록',rework:'보완 등록',submitted:'증빙 확인'};
    return {id:s.id,onOpen:()=>open('shipments',s.id),cells:[mainCell(detailLink(s.number,()=>open('shipments',s.id)),nameOf(data,'shippers',o?.shipperId)),routeName(data,o),mainCell(vehicleName(data,s.vehicleId),nameOf(data,'drivers',s.driverId)),
      proofs?mainCell(s.proof.receiver||(s.proof.files?.length?'사진 첨부':'미등록'),timeLabel(s.proof.at)):mainCell(timeLabel(s.start),timeLabel(s.end)),...(!proofs?[<Status value={s.status} labels={shipStates}/>]:[]),<Status value={s.proof.status} labels={proofStates}/>,
      ...(proofs?[<FreightBadge tone={s.invoiceStatus==='issued'?'blue':'neutral'}>{invoiceLabel(s)}</FreightBadge>]:[]),
      <div className="fr-actions">{next?<FreightButton onClick={()=>form(next[0],'shipments',s.id)}>{proofs?proofLabel[s.proof.status]:next[1]}</FreightButton>:
        proofs&&s.proof.status==='approved'?<FreightButton icon="wallet" onClick={()=>open('finance',s.id)}>정산 확인</FreightButton>:<FreightButton onClick={()=>open('shipments',s.id)}>상세</FreightButton>}
        {proofs&&s.proof.status==='submitted'&&<FreightButton onClick={()=>form('rework','shipments',s.id)}>보완 요청</FreightButton>}</div>]};
  })}/>;
}

export function DispatchView({data,orders:shown,requests,form,open,orderId,setOrderId,onAllRequests}){
  const [owner,setOwner]=useState(''),[possible,setPossible]=useState(false);
  const order=shown.find(o=>o.id===orderId)||shown[0];
  const candidates=order?data.vehicles.map(v=>candidate(data,order,v)).filter(c=>(!owner||(owner==='own')===!c.vehicle.carrierId)&&(!possible||!c.reason)).sort((a,b)=>Number(!!a.reason)-Number(!!b.reason)):[];
  return <>
    <div className="fr-split fr-dispatch">
      <section className="fr-card"><header className="fr-dispatch-heading"><div><h3>미배차 주문</h3><p>주문을 선택하면 차량 후보를 확인합니다.</p></div><FreightBadge>{shown.length}건</FreightBadge></header>
        <div className="fr-order-picks">{shown.map(o=><button type="button" className="fr-pick" key={o.id} aria-pressed={order?.id===o.id} onClick={()=>setOrderId(o.id)}>
          <span>{nameOf(data,'shippers',o.shipperId)}<small title={timeLabel(o.start)}>{timeLabel(o.start).replace(/^\d{4}-(\d{2})-/, '$1.')}</small></span><strong>{routeName(data,o)}</strong>
          <span>{o.vehicleType} · {num(o.weightKg)} kg<small>{costLabel(o.sellAmount)}</small></span>
        </button>)}{!shown.length&&<p className="fr-empty">미배차 주문이 없습니다.</p>}</div>
      </section>
      <section className="fr-card"><header className="fr-dispatch-heading"><div><h3>차량·기사 후보</h3><p>차량 조건과 기존 일정을 함께 확인합니다.</p></div>{order&&<FreightButton icon="file" aria-label="선택 주문 상세" onClick={()=>open('orders',order.id)}>주문 정보</FreightButton>}</header>
        {order&&<><div className="fr-selected-order"><strong>{routeName(data,order)}</strong>
          <small>{timeLabel(order.start)} ~ {timeLabel(order.end)} · {order.vehicleType} · {num(Math.max(order.weightKg||0,order.capacityKg||0))} kg 이상</small></div>
          <div className="fr-candidate-filters"><FreightField label="차량 소속"><select value={owner} onChange={e=>setOwner(e.target.value)}><option value="">전체 소속</option><option value="own">자사 차량</option><option value="partner">협력 차량</option></select></FreightField>
            <FreightField label="가능 여부"><select aria-label="가능 여부" value={possible?'possible':''} onChange={e=>setPossible(!!e.target.value)}><option value="">전체 후보</option><option value="possible">배차 가능</option></select></FreightField></div>
          <ul className="fr-candidate-list" aria-label="차량·기사 배차 후보">{candidates.map(({vehicle:v,driver,reason})=><li key={v.id}>
            <div className="fr-candidate-main"><img src={truckArt} width="85" height="46" alt=""/><div><div><strong>{v.plate}</strong><FreightBadge tone={reason?'neutral':'green'}>{reason?'조건 확인':'배차 가능'}</FreightBadge></div>
              <p>{v.type} · {num(v.capacityKg)} kg · {driver?.name||'기사 미지정'}</p>
              <small>{v.carrierId?nameOf(data,'carriers',v.carrierId):'자사 차량'} · {nameOf(data,'branches',v.branchId)}</small></div></div>
            <footer><span>{reason||'차량·기사 일정과 적재 조건 충족'}</span><FreightButton onClick={()=>form('assign','orders',order.id,v.id)}>{reason?'조합 확인':'배차 선택'}</FreightButton></footer>
          </li>)}</ul>{!candidates.length&&<p className="fr-empty">표시할 차량 후보가 없습니다. 소속·가능 여부 필터를 변경하거나 차량·기사 정보를 확인해 주세요.</p>}</>}
        {!order&&<p className="fr-empty">주문을 먼저 선택해 주세요. 왼쪽에서 미배차 주문을 선택할 수 있습니다.</p>}
      </section>
    </div>
    <section className="fr-dashboard-card fr-dispatch-requests"><header><div><h2>배차 수락 대기</h2><p className="fr-setting-description">현재 담당 지점 기준 · 기사·운송사의 응답을 확인합니다.</p></div><button type="button" className="fr-link" aria-label="배차 수락 대기 더보기" onClick={onAllRequests}>더보기</button></header>
      <FreightTable columns={['운송번호','운송 구간','차량 / 기사','상차 예정','응답']} empty="수락 대기 중인 배차가 없습니다." rows={requests.slice(0,4).map(s=>{
        const o=firstOrder(data,s);
        return {id:s.id,onOpen:()=>open('shipments',s.id),cells:[mainCell(detailLink(s.number,()=>open('shipments',s.id)),nameOf(data,'shippers',o?.shipperId)),routeName(data,o),
          mainCell(vehicleName(data,s.vehicleId),nameOf(data,'drivers',s.driverId)),timeLabel(s.start),
          <div className="fr-actions"><FreightButton primary onClick={()=>form('accept','shipments',s.id)}>수락 확인</FreightButton><FreightButton onClick={()=>form('decline','shipments',s.id)}>거절 기록</FreightButton></div>]};
      })}/>
    </section>
  </>;
}

export function ScheduleView({data,rows,services,filters,open,onExport,onDispatch}){
  const today=stamp().slice(0,10);
  const [week,setWeek]=useState(()=>weekOf(today));
  const days=Array.from({length:7},(_,i)=>addDays(week,i));
  const entries=[...rows.map(s=>({row:s,kind:'shipments',title:s.number,info:routeName(data,firstOrder(data,s))})),
    ...services.map(s=>({row:s,kind:'services',title:s.type,info:vehicleName(data,s.vehicleId)}))]
    .filter(e=>epoch(e.row.start)<epoch(addDays(week,7)+'T00:00')&&epoch(e.row.end)>epoch(week+'T00:00')).sort((a,b)=>epoch(a.row.start)-epoch(b.row.start));
  return <><div className="fr-toolbar fr-week-toolbar"><div className="fr-week-controls"><FreightButton onClick={()=>setWeek(addDays(week,-7))}>이전 주</FreightButton>
    <span>{days[0].replaceAll('-','.')} – {days[6].replaceAll('-','.')}</span><FreightButton onClick={()=>setWeek(addDays(week,7))}>다음 주</FreightButton>
    <FreightButton onClick={()=>setWeek(weekOf(today))}>이번 주</FreightButton></div>
    <div className="fr-actions"><FreightButton icon="download" onClick={()=>onExport(week,entries)}>CSV 다운로드</FreightButton><FreightButton primary onClick={onDispatch}>통합 배차</FreightButton></div></div>
    {filters}
    <div className="fr-week fr-schedule-grid" role="region" aria-label="주간 운송·정비 일정" tabIndex={0}>{days.map((day,i)=>{
      const relevant=entries.filter(e=>epoch(e.row.start)<epoch(addDays(day,1)+'T00:00')&&epoch(e.row.end)>epoch(day+'T00:00'));
      return <section key={day} className="fr-day"><h3><span aria-current={day===today?'date':undefined}>{Number(day.slice(8))}일 {weekdays[(i+1)%7]}</span><small>{relevant.length}건</small></h3>
        {relevant.map(e=><button type="button" key={e.kind+e.row.id} className="fr-pick" data-kind={e.kind} title={timeLabel(e.row.start)+' ~ '+timeLabel(e.row.end)} onClick={()=>open(e.kind,e.row.id)}>
          <strong>{vehicleName(data,e.row.vehicleId)}</strong><small>{e.kind==='services'?e.row.type:e.info}</small>
          <small>{timeLabel(e.row.start).slice(-5)}–{timeLabel(e.row.end).slice(-5)}{e.kind==='shipments'?' · '+nameOf(data,'drivers',e.row.driverId):''}</small>
          <small>{e.kind==='shipments'?e.title+' · '+shipStates[e.row.status]:e.row.status==='done'?'완료':'예정'}</small></button>)}
        {!relevant.length&&<small>일정 없음</small>}</section>;
    })}</div></>;
}

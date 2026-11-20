import {useState} from 'react';
import {FreightBadge,FreightButton,FreightField,FreightTable} from './FreightKit';
import {nextAction,Status} from './FreightDetail';
import {addDays,candidate,costLabel,epoch,firstOrder,nameOf,orderStates,proofStates,routeName,shipStates,stamp,timeLabel,vehicleName,weekdays,weekOf} from '../../lib/freightWorkflow';
const num=n=>Number(n).toLocaleString('ko-KR');
const mainCell=(main,detail)=><>{main}<small>{detail}</small></>;
function detailLink(label,click){return <button className="fr-link" onClick={click}>{label}</button>;}

export function WorkflowTable({page,data,rows,open,form}){
  const orders=page==='orders',recurring=page==='recurring',proofs=page==='proofs';
  if(orders||recurring)return <FreightTable columns={recurring?['정기 주문 / 화주','운송 구간','반복 일정','화물 / 차량','상태','업무 처리']:['주문번호 / 화주','운송 구간','상차 / 하차 예정','화물 / 차량','청구 / 지급 운임','상태','업무 처리']} empty={recurring?'조회된 정기 주문이 없습니다.':'조회된 운송 주문이 없습니다.'} rows={rows.map(o=>({
    id:o.id,cells:[mainCell(detailLink(recurring?o.name:o.number,()=>open(page,o.id)),nameOf(data,'shippers',o.shipperId)),routeName(data,o),
      recurring?mainCell(o.weekdays.map(d=>weekdays[d]).join(' · '),o.startTime+' ~ '+o.endTime):mainCell(timeLabel(o.start),timeLabel(o.end)),
      mainCell(o.cargoName,o.vehicleType+' · '+num(o.weightKg)+' kg'),...(!recurring?[mainCell(costLabel(o.sellAmount),costLabel(o.buyAmount))]:[]),
      recurring?<FreightBadge tone={o.active?'blue':'neutral'}>{o.active?'사용 중':'중지'}</FreightBadge>:<Status value={o.status} labels={orderStates}/>,
      <div className="fr-actions">{recurring?<FreightButton disabled={!o.active} onClick={()=>form('generate',page,o.id)}>주문 생성</FreightButton>:
        o.status==='open'?<FreightButton onClick={()=>form('assign',page,o.id)}>배차 등록</FreightButton>:<FreightButton onClick={()=>open(page,o.id)}>상세</FreightButton>}</div>]
  }))}/>;
  return <FreightTable columns={proofs?['운송 / 화주','운송 구간','차량 / 기사','수령인 / 확인 시각','인수증','업무 처리']:['운송 / 화주','운송 구간','차량 / 기사','상차 / 하차 예정','운송 단계','인수증','업무 처리']} empty={proofs?'하차를 완료한 운송이 없습니다.':'조회된 운송이 없습니다.'} rows={rows.map(s=>{
    const o=firstOrder(data,s),next=nextAction(s);
    return {id:s.id,cells:[mainCell(detailLink(s.number,()=>open('shipments',s.id)),nameOf(data,'shippers',o?.shipperId)),routeName(data,o),mainCell(vehicleName(data,s.vehicleId),nameOf(data,'drivers',s.driverId)),
      proofs?mainCell(s.proof.receiver||'—',timeLabel(s.proof.at)):mainCell(timeLabel(s.start),timeLabel(s.end)),...(!proofs?[<Status value={s.status} labels={shipStates}/>]:[]),<Status value={s.proof.status} labels={proofStates}/>,
      <div className="fr-actions">{next?<FreightButton onClick={()=>form(next[0],'shipments',s.id)}>{next[1]}</FreightButton>:<FreightButton onClick={()=>open('shipments',s.id)}>상세</FreightButton>}{proofs&&s.proof.status==='submitted'&&<FreightButton onClick={()=>form('rework','shipments',s.id)}>보완 요청</FreightButton>}</div>]};
  })}/>;
}

export function DispatchView({data,orders:shown,scope,setScope,form,open}){
  const [orderId,setOrderId]=useState(''),[owner,setOwner]=useState(''),[possible,setPossible]=useState(false);
  const order=shown.find(o=>o.id===orderId)||shown[0];
  const candidates=order?data.vehicles.map(v=>candidate(data,order,v)).filter(c=>(!owner||(owner==='own')===!c.vehicle.carrierId)&&(!possible||!c.reason)).sort((a,b)=>Number(!!a.reason)-Number(!!b.reason)):[];
  return <>
    <div className="fr-tabs"><button className="fr-tab" aria-pressed={!scope} onClick={()=>setScope('')}>전체 미배차</button><button className="fr-tab" aria-pressed={!!scope} onClick={()=>setScope('today')}>오늘 상차</button></div>
    <div className="fr-split">
      <section className="fr-card"><h3>미배차 주문 <small>{shown.length}건</small></h3>
        {shown.map(o=><button type="button" className="fr-pick" key={o.id} aria-pressed={order?.id===o.id} onClick={()=>setOrderId(o.id)}>
          <small>{nameOf(data,'shippers',o.shipperId)} · {timeLabel(o.start)}</small><strong>{routeName(data,o)}</strong><small>{o.vehicleType} · {num(o.weightKg)} kg · {costLabel(o.sellAmount)}</small>
        </button>)}{!shown.length&&<p className="fr-empty">미배차 주문이 없습니다.</p>}
      </section>
      <section className="fr-card fr-section"><div className="fr-toolbar"><h3>차량·기사 후보</h3>{order&&<FreightButton onClick={()=>open('orders',order.id)}>선택 주문 상세</FreightButton>}</div>
        {order&&<><div className="fr-actions"><FreightField label="차량 소속"><select value={owner} onChange={e=>setOwner(e.target.value)}><option value="">전체</option><option value="own">직영</option><option value="partner">협력 운송사</option></select></FreightField>
          <label className="fr-checks"><input type="checkbox" checked={possible} onChange={e=>setPossible(e.target.checked)}/>배차 가능만</label></div>
        <FreightTable columns={['차량 / 소속','기사','배차 가능 여부','업무 처리']} empty="해당하는 차량이 없습니다." rows={candidates.map(({vehicle:v,driver,reason})=>({id:v.id,cells:[
          mainCell(v.plate,v.carrierId?nameOf(data,'carriers',v.carrierId):'직영'),driver?.name||'미지정',reason||<FreightBadge tone="green">가능</FreightBadge>,<FreightButton disabled={!!reason} onClick={()=>form('assign','orders',order.id,v.id)}>배차</FreightButton>
        ]}))}/></>}
        {!order&&<p className="fr-empty">주문을 선택하면 후보 차량을 확인할 수 있습니다.</p>}
      </section>
    </div>
  </>;
}

export function ScheduleView({data,rows,services,open,onExport,onDispatch}){
  const today=stamp().slice(0,10);
  const [week,setWeek]=useState(()=>weekOf(today));
  const days=Array.from({length:7},(_,i)=>addDays(week,i));
  const entries=[...rows.map(s=>({row:s,kind:'shipments',title:s.number,info:routeName(data,firstOrder(data,s))})),
    ...services.map(s=>({row:s,kind:'services',title:s.type,info:vehicleName(data,s.vehicleId)}))]
    .filter(e=>epoch(e.row.start)<epoch(addDays(week,7)+'T00:00')&&epoch(e.row.end)>epoch(week+'T00:00')).sort((a,b)=>epoch(a.row.start)-epoch(b.row.start));
  return <><div className="fr-toolbar"><strong>{days[0]} ~ {days[6]}</strong><div className="fr-actions"><FreightButton onClick={()=>setWeek(addDays(week,-7))}>이전 주</FreightButton><FreightButton onClick={()=>setWeek(weekOf(today))}>이번 주</FreightButton><FreightButton onClick={()=>setWeek(addDays(week,7))}>다음 주</FreightButton></div></div>
    <div className="fr-actions"><FreightButton onClick={()=>onExport(week,entries)}>일정 다운로드</FreightButton><FreightButton primary onClick={onDispatch}>통합 배차</FreightButton></div>
    <div className="fr-week">{days.map((day,i)=>{
      const relevant=entries.filter(e=>epoch(e.row.start)<epoch(addDays(day,1)+'T00:00')&&epoch(e.row.end)>epoch(day+'T00:00'));
      return <section key={day} className="fr-day"><h3>{day.slice(5)} ({weekdays[(i+1)%7]}) {day===today&&<FreightBadge tone="blue">오늘</FreightBadge>}</h3>
        {relevant.map(e=><button key={e.kind+e.row.id} className="fr-pick" onClick={()=>open(e.kind,e.row.id)}><strong>{e.title}</strong><small>{e.info}</small><small>{timeLabel(e.row.start)} ~ {timeLabel(e.row.end)}</small></button>)}
        {!relevant.length&&<small>일정 없음</small>}</section>;
    })}</div></>;
}

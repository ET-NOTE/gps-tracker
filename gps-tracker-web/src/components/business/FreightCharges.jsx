import { useState } from 'react';
import FreightChargeDialogs,{amounts,tones} from './FreightChargeDialogs';
import { FreightBadge, FreightButton, FreightFilters, FreightStats, FreightTable } from './FreightKit';
import { choices, choicesFrom, downloadRows, OfficeFilter } from './FreightOfficeFields';
import { currentPeriod, inPeriod, PeriodFilter } from './FreightLedger';
import { chargeStates } from '../../lib/freightFinance';
import { costLabel, timeLabel } from '../../lib/freightWorkflow';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';

export default function FreightCharges({data,save,onPage,onOpenFinance}) {
  const mockup=!useCorporatePhone()&&hideOutsideMockup;
  const [query,setQuery]=useState(''),[period,setPeriod]=useState(currentPeriod),[state,setState]=useState(''),[kind,setKind]=useState(''),[branch,setBranch]=useState(''),[view,setView]=useState(null);
  const shipments=new Map(data.shipments.map(s=>[s.id,s]));
  const orderShippers=new Map(data.orders.map(o=>[o.id,o.shipperId]));
  const shipperNames=new Map(data.shippers.map(s=>[s.id,s.name]));
  const parties=new Map(data.shipments.map(s=>[s.id,[...new Set((s.orderIds||[]).map(id=>shipperNames.get(orderShippers.get(id))).filter(Boolean))].join(', ')]));
  const search=query.trim().toLowerCase();
  const matching=data.charges.filter(x=>inPeriod(x.at,period)&&(!branch||shipments.get(x.shipmentId)?.branchId===branch)&&
    (!kind||x.kind===kind)&&[shipments.get(x.shipmentId)?.number,parties.get(x.shipmentId),x.kind,x.note].join(' ').toLowerCase().includes(search));
  const counts={pending:0,approved:0,rejected:0};
  for(const charge of matching) if(Object.hasOwn(counts,charge.status))counts[charge.status]++;
  const rows=matching.filter(x=>!state||x.status===state).sort((a,b)=>b.at.localeCompare(a.at));
  const totals={sellAmount:0,buyAmount:0,companyCost:0};
  for(const charge of rows) if(charge.status==='approved'){
    for(const [key] of amounts)totals[key]+=Number(charge[key]??0);
  }
  const statusOptions=Object.fromEntries(Object.entries(chargeStates).map(([key,label])=>[key,label+' ('+counts[key]+'건)']));
  function reset(){setQuery('');setPeriod(currentPeriod());setBranch('');setKind('');setState('');}
  const headings=['운송번호','비용 항목','발생 일시',...amounts.map(([,l])=>l),'상태'];
  const values=x=>[shipments.get(x.shipmentId)?.number||'—',x.kind,timeLabel(x.at),...amounts.map(([k])=>costLabel(x[k])),chargeStates[x.status]];
  return <section className="fr-section fr-admin-list fr-charge-list">
    <FreightStats items={[['확인 대기',<>{state&&state!=='pending'?0:counts.pending}<small className="fr-stat-unit">건</small></>],['승인 화주 추가액',costLabel(totals.sellAmount)],['승인 운송비 추가액',costLabel(totals.buyAmount)],['승인 회사 부담액',costLabel(totals.companyCost)]]}/>
    <FreightFilters admin resetLabel={mockup?'초기화':undefined} query={query} onQuery={setQuery} placeholder="운송번호·화주·비용 항목·사유 검색" onReset={reset}><PeriodFilter label="조회 기간" period={period} setPeriod={setPeriod}/>
      <OfficeFilter label="지점" value={branch} onChange={setBranch} options={choicesFrom(data.branches)}/>
      <OfficeFilter label="비용 항목" value={kind} onChange={setKind} options={choices(data.codes.chargeTypes)}/>
      <OfficeFilter label={mockup?'확인 상태':'상태'} value={state} onChange={setState} options={statusOptions}/>
    </FreightFilters>
    <div className="fr-toolbar"><span className="fr-toolbar-caption">승인한 비용만 정산 합계에 포함됩니다.</span><div className="fr-actions"><FreightButton icon="download" onClick={()=>downloadRows('추가 비용',headings,rows.map(values))} disabled={!rows.length}>CSV 다운로드</FreightButton>
      <FreightButton primary icon="plus" disabled={!data.shipments.length||!data.codes.chargeTypes.length} onClick={()=>setView({action:'form'})}>추가 비용 등록</FreightButton></div></div>
    {!data.shipments.length&&<div className="fr-card fr-toolbar"><span>배차한 운송 건에 추가 비용을 등록할 수 있습니다.</span><FreightButton onClick={()=>onPage('cargo-dispatch')}>통합 배차</FreightButton></div>}
    <FreightTable columns={['운송번호 / 화주','항목 / 발생 일시','화주 청구액','운송비 지급액','회사 부담액','확인 상태']} rows={rows.map(x=>({id:x.id,onOpen:()=>setView({id:x.id,action:'detail'}),cells:[
      <><button className="fr-link" onClick={()=>setView({action:'detail',id:x.id})}>{shipments.get(x.shipmentId)?.number||'—'}</button><small>{parties.get(x.shipmentId)||'—'}</small></>,
      <>{x.kind}<small>{timeLabel(x.at)}</small></>,...amounts.map(([key])=>costLabel(x[key])),<FreightBadge tone={tones[x.status]}>{chargeStates[x.status]}</FreightBadge>
    ]}))} empty="조회 조건에 해당하는 추가 비용이 없습니다."/>
    {view&&<FreightChargeDialogs {...{data,save,view,setView,onOpenFinance}}/>}
  </section>;
}

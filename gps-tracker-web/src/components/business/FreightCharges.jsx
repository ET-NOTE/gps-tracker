import { useState } from 'react';
import FreightChargeDialogs,{amounts,tones} from './FreightChargeDialogs';
import { FreightBadge, FreightButton, FreightFilters, FreightStats, FreightTable } from './FreightKit';
import { choices, choicesFrom, downloadRows, OfficeFilter } from './FreightOfficeFields';
import { currentPeriod, inPeriod, PeriodFilter } from './FreightLedger';
import { chargeStates } from '../../lib/freightFinance';
import { costLabel, timeLabel } from '../../lib/freightWorkflow';

export default function FreightCharges({data,save,onPage}) {
  const [query,setQuery]=useState(''),[period,setPeriod]=useState(currentPeriod),[state,setState]=useState(''),[kind,setKind]=useState(''),[branch,setBranch]=useState(''),[view,setView]=useState(null);
  const shipments=new Map(data.shipments.map(s=>[s.id,s]));
  const rows=data.charges.filter(x=>inPeriod(x.at,period)&&(!branch||shipments.get(x.shipmentId)?.branchId===branch)&&(!state||x.status===state)&&
    (!kind||x.kind===kind)&&[shipments.get(x.shipmentId)?.number,x.kind,x.note].join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>b.at.localeCompare(a.at));
  const headings=['운송번호','비용 항목','발생 일시',...amounts.map(([,l])=>l),'상태'];
  const values=x=>[shipments.get(x.shipmentId)?.number||'—',x.kind,timeLabel(x.at),...amounts.map(([k])=>costLabel(x[k])),chargeStates[x.status]];
  return <section className="fr-section">
    <FreightStats items={Object.entries(chargeStates).map(([k,label])=>[label,rows.filter(x=>x.status===k).length+'건'])}/>
    <FreightFilters query={query} onQuery={setQuery} placeholder="운송번호·비용 항목·사유 검색"><PeriodFilter period={period} setPeriod={setPeriod}/>
      <OfficeFilter label="지점" value={branch} onChange={setBranch} options={choicesFrom(data.branches)}/>
      <OfficeFilter label="비용 항목" value={kind} onChange={setKind} options={choices(data.codes.chargeTypes)}/>
      <OfficeFilter label="상태" value={state} onChange={setState} options={chargeStates}/>
    </FreightFilters>
    <div className="fr-toolbar"><strong>추가 비용 {rows.length}건</strong><div className="fr-actions"><FreightButton onClick={()=>downloadRows('추가 비용',headings,rows.map(values))} disabled={!rows.length}>CSV 다운로드</FreightButton>
      <FreightButton primary disabled={!data.shipments.length||!data.codes.chargeTypes.length} onClick={()=>setView({action:'form'})}>추가 비용 등록</FreightButton></div></div>
    {!data.shipments.length&&<div className="fr-card fr-toolbar"><span>배차한 운송 건에 추가 비용을 등록할 수 있습니다.</span><FreightButton onClick={()=>onPage('cargo-dispatch')}>통합 배차</FreightButton></div>}
    <FreightTable columns={headings} rows={rows.map(x=>{const cells=values(x);
      cells[0]=<button className="fr-link" onClick={()=>setView({action:'detail',id:x.id})}>{cells[0]}</button>;cells[cells.length-1]=<FreightBadge tone={tones[x.status]}>{chargeStates[x.status]}</FreightBadge>;return {id:x.id,onOpen:()=>setView({id:x.id,action:'detail'}),cells};
    })} empty="조회 조건에 해당하는 추가 비용이 없습니다."/>
    {view&&<FreightChargeDialogs {...{data,save,view,setView}}/>}
  </section>;
}

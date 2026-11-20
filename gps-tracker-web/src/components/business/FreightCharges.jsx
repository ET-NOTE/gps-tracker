import { useState } from 'react';
import { Modal } from '../ui';
import { FreightBadge, FreightButton, FreightFacts, FreightFilters, FreightForm, FreightStats, FreightTable } from './FreightKit';
import { choices, choicesFrom, downloadRows, FormField, formValues, OfficeFilter } from './FreightOfficeFields';
import { currentPeriod, inPeriod, PeriodFilter } from './FreightLedger';
import { chargeStates, reviewCharge, saveCharge } from '../../lib/freightFinance';
import { costLabel, getRow, stamp, timeLabel } from '../../lib/freightWorkflow';

const amounts=[['sellAmount','화주 추가 청구액'],['buyAmount','운송사 추가 지급액'],['companyCost','회사 부담액']];
const tones={pending:'amber',approved:'green',rejected:'red'};
export default function FreightCharges({data,save,onPage}) {
  const [query,setQuery]=useState(''),[period,setPeriod]=useState(currentPeriod),[state,setState]=useState(''),[kind,setKind]=useState(''),[branch,setBranch]=useState(''),[view,setView]=useState(null);
  const shipments=new Map(data.shipments.map(s=>[s.id,s]));
  const rows=data.charges.filter(x=>inPeriod(x.at,period)&&(!branch||shipments.get(x.shipmentId)?.branchId===branch)&&(!state||x.status===state)&&
    (!kind||x.kind===kind)&&[shipments.get(x.shipmentId)?.number,x.kind,x.note].join(' ').toLowerCase().includes(query.trim().toLowerCase())).sort((a,b)=>b.at.localeCompare(a.at));
  const headings=['운송번호','비용 항목','발생 일시',...amounts.map(([,l])=>l),'상태'];
  const values=x=>[shipments.get(x.shipmentId)?.number||'—',x.kind,timeLabel(x.at),...amounts.map(([k])=>costLabel(x[k])),chargeStates[x.status]];
  const row=view?.id&&getRow(data,'charges',view.id);
  const fields=[{key:'shipmentId',label:'운송 건',options:choicesFrom(data.shipments,'number'),required:true,wide:true},
    {key:'kind',label:'비용 항목',options:choices(data.codes.chargeTypes),required:true},{key:'at',label:'발생 일시',type:'datetime-local',defaultValue:stamp(),required:true},
    ...amounts.map(([key,label])=>({key,label:label+' (원)',type:'number',defaultValue:0,min:0,max:1e9,required:true})),
    {key:'note',label:'발생 사유',type:'textarea',maxLength:500,required:true}];
  const close=()=>setView(null), detail=()=>row?setView({action:'detail',id:row.id}):close();
  async function submit(form) {
    const next=structuredClone(data), old=row?getRow(next,'charges',row.id):null;
    if(view.action==='form')saveCharge(next,old,formValues(form,fields));
    else reviewCharge(next,old,view.action,String(form.get('note')||''));
    await save(next);setView({action:'detail',id:old?.id||next.charges[0].id});
  }
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
      cells[0]=<button className="fr-link" onClick={()=>setView({action:'detail',id:x.id})}>{cells[0]}</button>;cells[cells.length-1]=<FreightBadge tone={tones[x.status]}>{chargeStates[x.status]}</FreightBadge>;return {id:x.id,cells};
    })} empty="조회 조건에 해당하는 추가 비용이 없습니다."/>
    {row&&view.action==='detail'&&<Modal open title="추가 비용 상세" subtitle={shipments.get(row.shipmentId)?.number+' · '+row.kind} onClose={close} footer={<div className="fr-actions">
      <FreightButton onClick={close}>닫기</FreightButton>{row.status!=='approved'&&<FreightButton onClick={()=>setView({action:'form',id:row.id})}>정보 수정</FreightButton>}
      {row.status==='pending'&&<><FreightButton onClick={()=>setView({action:'rejected',id:row.id})}>반려</FreightButton><FreightButton primary onClick={()=>setView({action:'approved',id:row.id})}>승인</FreightButton></>}</div>}>
      <FreightFacts items={[['상태',chargeStates[row.status]],['발생 일시',timeLabel(row.at)],...amounts.map(([k,l])=>[l,costLabel(row[k])]),['발생 사유',row.note],
        ...(row.reviewedAt?[['검토 일시',timeLabel(row.reviewedAt)],['검토 메모',row.reviewNote||'—']]:[])]}/>
    </Modal>}
    {view?.action==='form'&&<FreightForm title={'추가 비용 '+(row?'수정':'등록')} onClose={detail} onSubmit={submit}>{fields.map(f=><FormField key={f.key} field={f} initial={row||{}}/>)}</FreightForm>}
    {row&&['approved','rejected'].includes(view?.action)&&<FreightForm title={'추가 비용 '+chargeStates[view.action]} subtitle={row.kind} onClose={detail} onSubmit={submit} submitLabel={chargeStates[view.action]}>
      <p className="fr-note">{amounts.map(([k,l])=>l+' '+costLabel(row[k])).join(' · ')}</p><FormField field={{key:'note',label:view.action==='rejected'?'반려 사유':'검토 메모',type:'textarea',maxLength:500,required:view.action==='rejected'}}/>
    </FreightForm>}
  </section>;
}

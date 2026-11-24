import { useId, useRef, useState } from 'react';
import { Modal } from '../ui';
import Icon from '../Icon';
import BusinessDrawer from './BusinessDrawer';
import { shipStates } from '../../lib/freightWorkflow';
import './freight.css';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';

// Desktop design: a trailing unit ('원', '건') is set small after the number; an optional icon leads the label.
const statUnit=/^([-−]?[\d,.]+)\s*(원|명|건|대|곳|%|시간|km)$/;

export function FreightButton({primary=false, children, icon, ...rest}) {
  return <button type="button" className={'fr-btn'+(primary?' is-primary':'')} {...rest}>{icon&&<Icon name={icon} size={15}/>} {children}</button>;
}
export function FreightField({label,wide,children}) {
  return <label className={'fr-field'+(wide?' is-wide':'')}><span>{label}</span>{children}</label>;
}
export function FreightForm({title,subtitle,onClose,onSubmit,submitLabel='저장',children,size='lg'}) {
  const id=useId(), lock=useRef(false), [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(e){
    e.preventDefault();
    if(lock.current)return;
    lock.current=true;setBusy(true);setError('');
    try {await onSubmit(new FormData(e.currentTarget));}
    catch(e){setError(e.message || '저장하지 못했습니다.');}
    finally{lock.current=false;setBusy(false);}
  }
  return <Modal open mobileForm title={title} subtitle={subtitle} size={size} onClose={busy?undefined:onClose} footer={<div className="service-form-actions">
    <FreightButton disabled={busy} onClick={onClose}>취소</FreightButton><button className="fr-btn is-primary" type="submit" form={id} disabled={busy}>{busy?'저장 중…':submitLabel}</button>
  </div>}>
    {error&&<p role="alert" className="fr-error">{error}</p>}
    <form id={id} onSubmit={submit} className="fr-form">{children}</form>
  </Modal>;
}
export function FreightStats({items,unit}){
  const desk=!useCorporatePhone()&&hideOutsideMockup;
  // Freight amounts always keep '원' attached at full size (design C.money); only counts get the small unit.
  const show=value=>{const m=desk&&!unit&&typeof value==='string'&&value.match(statUnit);return m&&m[2]!=='원'?<>{m[1]}<small className="fr-stat-unit">{m[2]}</small></>:value;};
  return <dl className="fr-stats">{items.map(([label,value,note,icon])=><div key={label}><dt>{desk&&icon&&<Icon name={icon} size={15}/>}{label}</dt><dd>{show(value)}{unit&&<small className="fr-stat-unit">{unit}</small>}{note&&<small className="fr-metric-note">{note}</small>}</dd></div>)}</dl>;
}
export function FreightBadge({children,tone='neutral'}) {
  return <span className={'fr-badge is-'+tone}>{children}</span>;
}
export const tone=k=>({open:'amber',requested:'amber',loading:'amber',assigned:'blue',confirmed:'blue',in_transit:'blue',submitted:'blue',approved:'green',delivered:'green',completed:'green',cancelled:'red',rework:'red'}[k]||'neutral');
export function Status({value,labels}){return <FreightBadge tone={tone(value)}>{labels[value]||'—'}</FreightBadge>;}
export function FreightFacts({items}){
  return <dl className="fr-facts">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value??'—'}</dd></div>)}</dl>;
}
export function FreightDrawer({title,subtitle,onClose,footer,children}) {
  return <BusinessDrawer title={title} subtitle={subtitle} onClose={onClose}>
    <div className="fr-drawer-inner"><div>{children}</div><footer>{footer}</footer></div>
  </BusinessDrawer>;
}
// `inPanel`: the table already sits in a card, so the desktop empty block keeps the given title without its own frame.
export function FreightTable({columns,rows,empty='조회된 내역이 없습니다.',deskEmpty='조회된 내역이 없습니다.',inPanel=false}){
  const desk=!useCorporatePhone()&&hideOutsideMockup;
  if(desk&&!rows.length)return <div className={'mockup-empty'+(inPanel?'':' is-panel')} role="status"><Icon name="search" size={31}/><strong>{inPanel?empty:deskEmpty}</strong><small>조회 조건을 바꾸거나 새 항목을 등록해 주세요.</small></div>;
  return <div className="fr-list" role="region" aria-label={columns[0]+'별 목록'} tabIndex={0}><table className="fr-table"><thead><tr>{columns.map(c=><th scope="col" key={c}>{c}</th>)}</tr></thead>
    <tbody>{rows.map(({id,cells,onOpen})=><tr key={id} className={onOpen?'fr-open-row':undefined} onClick={onOpen?event=>{
      if(!event.target.closest('button,a,input,select,textarea,label')&&!window.getSelection()?.toString())onOpen();
    }:undefined}>{cells.map((cell,i)=><td data-label={columns[i]} key={columns[i]}>{cell}</td>)}</tr>)}</tbody></table>
    {!rows.length&&<p className="fr-empty">{empty}</p>}
  </div>;
}
export function FleetResourceFilters({query,onQuery,placeholder,children,onReset,total,count,extraFilter,extraLabel}){
  const [expanded,setExpanded]=useState(false);
  const extraId=useId();
  return <div className="fr-filters fr-resource-filters">
    <div className="fr-resource-fields">
      <label className="fr-resource-search"><Icon name="search" size={15}/><input type="search" aria-label={placeholder} placeholder={placeholder} value={query} onChange={e=>onQuery(e.target.value)}/></label>
      {children}
    </div>
    <div className="fr-resource-filter-meta"><span>{extraFilter?'전체 '+total.toLocaleString('ko-KR')+' · 조회 '+count.toLocaleString('ko-KR'):'전체 '+total.toLocaleString('ko-KR')+'건 중 '+count.toLocaleString('ko-KR')+'건 조회'}</span>
      {extraFilter&&<button type="button" aria-controls={extraId} aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>{extraLabel}</button>}
      <button type="button" onClick={()=>{onReset();setExpanded(false);}}>조건 초기화</button>
    </div>
    {extraFilter&&<div id={extraId} className="fr-resource-extra" hidden={!expanded}>{extraFilter}</div>}
  </div>;
}
export function FreightFilters({query,onQuery,placeholder,children,onReset,admin=false,resetLabel='조건 초기화',searchFirst=false}){
  if(admin)return <div className="fr-filters"><div className="fr-admin-fields">
    {children}
    <FreightField label="검색" wide><span className="fr-resource-search"><Icon name="search" size={15}/><input type="search" value={query} onChange={e=>onQuery(e.target.value)} placeholder={placeholder}/></span></FreightField>
  </div><FreightButton className="fleet-filter-reset-link" icon="refresh" onClick={onReset}>{resetLabel}</FreightButton></div>;
  const search=<FreightField label="검색" wide>
    <input type="search" value={query} onChange={e=>onQuery(e.target.value)} placeholder={placeholder}/></FreightField>;
  return <div className="fr-filters" data-search-first={searchFirst||undefined}>{searchFirst&&search}{children}{!searchFirst&&search}{onReset&&<FreightButton className="fleet-filter-reset-link" icon="refresh" onClick={onReset}>{resetLabel}</FreightButton>}</div>;
}
export function FreightOptions({rows,blank,label='name'}){
  return <>{blank!==undefined&&<option value="">{blank}</option>}{rows.map(r=><option key={r.id} value={r.id}>{r[label]||r.id}</option>)}</>;
}

export function FreightStageChart({ships}) {
  const desk=!useCorporatePhone()&&hideOutsideMockup;
  const counts = Object.entries(shipStates).filter(([status])=>status!=='cancelled').map(([status,label])=>({status,label,count:ships.filter(s=>s.status===status).length}));
  const max = Math.max(1,...counts.map(item=>item.count));
  return <ul className="fr-stage-chart" aria-label="운송 단계별 건수">
    {counts.map(({status,label,count})=><li key={status}><span>{label}</span><span>{count}{desk?' 건':'건'}</span>
      <div className="fr-stage-track" aria-hidden="true"><i style={{width: (100*count/max)+'%'}}/></div></li>)}
  </ul>;
}

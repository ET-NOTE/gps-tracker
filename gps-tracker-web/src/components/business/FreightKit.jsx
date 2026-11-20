import { useId, useRef, useState } from 'react';
import { Modal } from '../ui';
import Icon from '../Icon';
import './freight.css';

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
  return <Modal open mobileForm title={title} subtitle={subtitle} size={size} onClose={busy?undefined:onClose} footer={<div className="fr-actions fr-form-footer">
    <FreightButton disabled={busy} onClick={onClose}>닫기</FreightButton><button className="fr-btn is-primary" type="submit" form={id} disabled={busy}>{busy?'저장 중…':submitLabel}</button>
  </div>}>
    {error&&<p role="alert" className="fr-error">{error}</p>}
    <form id={id} onSubmit={submit} className="fr-form">{children}</form>
  </Modal>;
}
export function FreightStats({items}){
  return <dl className="fr-stats">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function FreightBadge({children,tone='neutral'}) {
  return <span className={'fr-badge is-'+tone}>{children}</span>;
}
export function FreightFacts({items}){
  return <dl className="fr-facts">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value??'—'}</dd></div>)}</dl>;
}
export function FreightTable({columns,rows,empty='조회된 내역이 없습니다.'}){
  return <div className="fr-list"><table className="fr-table"><thead><tr>{columns.map(c=><th scope="col" key={c}>{c}</th>)}</tr></thead>
    <tbody>{rows.map(({id,cells})=><tr key={id}>{cells.map((cell,i)=><td data-label={columns[i]} key={columns[i]}>{cell}</td>)}</tr>)}</tbody></table>
    {!rows.length&&<p className="fr-empty">{empty}</p>}
  </div>;
}
export function FreightFilters({query,onQuery,placeholder,children}){
  return <div className="fr-filters">{children}<FreightField label="검색" wide>
    <input type="search" value={query} onChange={e=>onQuery(e.target.value)} placeholder={placeholder}/></FreightField></div>;
}
export function FreightOptions({rows,blank,label='name'}){
  return <>{blank!==undefined&&<option value="">{blank}</option>}{rows.map(r=><option key={r.id} value={r.id}>{r[label]||r.id}</option>)}</>;
}

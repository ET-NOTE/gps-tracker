import React, {useState} from 'react';
import {Button, Modal} from '../ui';
import Icon from '../Icon';

export function Field({label,children,wide=false}) {
  const labelId=React.useId();
  return <label className={'ro-field'+(wide?' ro-wide':'')}><span id={labelId}>{label}</span>{React.Children.map(children,child=>{
    if (!React.isValidElement(child)||!['input','select','textarea'].includes(child.type)||child.props['aria-label']) return child;
    return React.cloneElement(child,{'aria-labelledby':labelId});
  })}</label>;
}
export function Options({items}) {
  return Object.entries(items).map(([value,label])=><option key={value} value={value}>{label}</option>);
}
export function Table({columns,rows,empty,onRecord}) {
  return <div className="ro-table-box" role="region" aria-label={columns[0][0]+'별 목록'} tabIndex={0}><table className="ro-table"><thead><tr>{columns.map(([label])=><th key={label} scope="col">{label}</th>)}</tr></thead>
    <tbody>{rows.length ? rows.map(row=><tr key={row.id} data-record={onRecord?true:undefined} onClick={onRecord?event=>{
      if (!event.target.closest('button,a,input,select,textarea,label')) {
        event.currentTarget.querySelector('.ro-detail-link')?.focus({preventScroll:true});
        onRecord(row);
      }
    }:undefined}>{columns.map(([label,render])=><td key={label} data-label={label}><div>{render(row) ?? '—'}</div></td>)}</tr>) :
      <tr><td className="rental-list-empty" colSpan={columns.length}>{empty}</td></tr>}</tbody></table></div>;
}
export function Toolbar({count,unit='건',children}) {
  return <div className="ro-toolbar"><strong>{count.toLocaleString('ko-KR')}{unit}</strong><div>{children}</div></div>;
}
export function Search({value,setValue,label}) {
  return <Field label="검색"><span className="ro-search-control"><Icon name="search" size={15}/>
    <input type="search" value={value} onChange={e=>setValue(e.target.value)} placeholder={label} aria-label={label}/>
  </span></Field>;
}
export function PeriodFields({period,onChange}) {
  return <div className="ro-period">{[['from','조회 시작일'],['to','조회 종료일']].map(([key,label])=><Field label={label} key={key}><input type="date" value={period[key]} onChange={e=>onChange({...period,[key]:e.target.value})}/></Field>)}</div>;
}
export function Metrics({items}) {
  return <dl className="ro-metrics">{items.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
export function FormModal({title,onClose,save,children,canSave=true,size=720,submitLabel='저장'}) {
  const [busy,setBusy] = useState(false), [error,setError] = useState('');
  const formId=React.useId();
  const lock=React.useRef(false);
  async function submit(e) {
    e.preventDefault();
    if (lock.current || !canSave) return;
    lock.current=true;setBusy(true);setError('');
    try { await save();onClose(); }
    catch(e){ setError(e?.message || '저장하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    finally { lock.current=false;setBusy(false); }
  }
  return <Modal open size={size} mobileForm title={title} onClose={busy?undefined:onClose} closeOnEsc={!busy} closeOnBackdrop={!busy}
    footer={<div className="service-form-actions"><Button variant="ghost" onClick={onClose} disabled={busy}>취소</Button>
      <Button variant="primary" type="submit" form={formId} busy={busy} disabled={!canSave}>{submitLabel}</Button></div>}>
    <form id={formId} className="ro-modal" onSubmit={submit}><fieldset disabled={busy} className="ro-form-grid">{children}</fieldset>
      {error && <p role="alert" className="ro-error">{error}</p>}
    </form>
  </Modal>;
}

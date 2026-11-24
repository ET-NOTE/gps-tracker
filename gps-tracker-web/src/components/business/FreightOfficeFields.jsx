import { FreightField } from './FreightKit';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';
import { csvCell } from '../../lib/businessExport';

export const choices=values=>Object.fromEntries(values.map(x=>[x,x]));
export const choicesFrom=(rows,label='name')=>Object.fromEntries(rows.map(x=>[x.id,x[label]]));
export function FormField({field,initial={}}) {
  const {key,label,type='text',options,wide,required,maxLength,min,max,readOnly,defaultValue}=field;
  const value=initial[key]??defaultValue??'';
  const attrs={name:key,required,readOnly};
  if (options) return <FreightField label={label} wide={wide}><select {...attrs} defaultValue={value || (Object.hasOwn(options,'')?'':Object.keys(options)[0])}>{Object.entries(options).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></FreightField>;
  if (type==='checkbox') return <label className="fr-checks"><input name={key} type="checkbox" defaultChecked={Boolean(value)}/>{label}</label>;
  if (type==='textarea') return <FreightField label={label} wide><textarea {...attrs} defaultValue={value} rows={3} maxLength={maxLength||1000}/></FreightField>;
  return <FreightField label={label} wide={wide}><input {...attrs} defaultValue={value} type={type} maxLength={maxLength} min={min} max={max} step={type==='number'?1:undefined}/></FreightField>;
}
export function formValues(form,fields) {
  const values={};
  for(const f of fields) {
    const raw=form.get(f.key);
    if (f.type==='checkbox') values[f.key]=raw==='on';
    else if (f.type==='number') values[f.key]=raw==null||raw===''?null:Number(raw);
    else values[f.key]=String(raw??'').trim();
  }
  return values;
}
// Desktop design: the empty choice names what it covers ('전체 지점'); the value stays ''.
const deskAll={'지점':'전체 지점','운영 지점':'전체 지점','차량 형태':'전체 형태','소속':'전체 소속','운영 상태':'전체 상태','정산 방식':'전체 방식','지역':'전체 지역','화주':'전체 화주','지급 대상':'전체 지급 대상','정산 상태':'전체 상태','비용 항목':'전체 항목','확인 상태':'전체 상태'};
export function OfficeFilter({label,options,value,onChange,all}) {
  const desk=!useCorporatePhone()&&hideOutsideMockup;
  return <FreightField label={label}><select value={value||''} onChange={e=>onChange(e.target.value)}>
    <option value="">{all||(desk&&deskAll[label])||'전체'}</option>{Object.entries(options).filter(([k])=>k!=='').map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></FreightField>;
}
export function downloadRows(title,headings,rows) {
  const csv='\uFEFF'+[headings,...rows].map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
  const url=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
  const link=document.createElement('a');
  link.href=url;link.download=title+'.csv';document.body.append(link);link.click();link.remove();
  window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}

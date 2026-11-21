import {createContext,useContext} from 'react';
import Icon from '../Icon';
import './workspace-header.css';

export const WorkspaceHeaderContext=createContext(null);
export const WorkspaceCompanyContext=createContext(null);

export function WorkspaceScope({fallback=null,ownName}) {
  const member=useContext(WorkspaceHeaderContext),company=useContext(WorkspaceCompanyContext);
  if(!member&&!company)return fallback;
  const options=company?[...(member?.options.filter(o=>o.value==='personal')||[]),...company.options]:
    member.options.map(o=>o.value==='company'&&ownName?{...o,label:ownName}:o);
  const selected=company?.selected||member?.selected;
  if(!options.length)return null;
  return <label className="ws-scope" title={options.find(o=>o.value===selected)?.label}><select aria-label="조회 범위" value={selected} onChange={e=>{
    const value=e.target.value;
    if(company && value!=='personal')company.onChange(value);
    else member?.onChange(value);
  }}>{options.map(o=><option key={o.value} value={o.value}>{o.label}</option>)}</select><Icon name="chevron-down" size={13}/></label>;
}

export function WorkspaceAvatar({label,onClick,expanded}) {
  const member=useContext(WorkspaceHeaderContext);
  const name=member?.name||'내정보';
  return <button type="button" className="ws-avatar" aria-label={label} title={name} aria-haspopup="dialog" aria-expanded={expanded} onClick={onClick}>
    {member?.name?Array.from(name)[0]:<Icon name="user" size={14}/>}
  </button>;
}

export function WorkspaceBreadcrumb({service,group,page}) {
  return <nav className="ws-crumb" aria-label="현재 위치" data-has-page={!!page&&page!==group} title={[service,group,page!==group&&page].filter(Boolean).join(' › ')}>
    <span className="ws-crumb-service">{service}</span><span className="ws-crumb-service" aria-hidden="true"><Icon name="chevron-right" size={13}/></span>
    <span className="ws-crumb-group">{group}</span>{page&&page!==group&&<><Icon name="chevron-right" size={13}/><span aria-current="page" title={page}>{page}</span></>}
  </nav>;
}

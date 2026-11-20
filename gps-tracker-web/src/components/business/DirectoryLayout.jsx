import React from 'react';
import './directory-layout.css';

export function DirectoryLayout({sidebar,children}){
 return <div className="fleet-directory-layout"><aside className="fleet-directory-sidebar">{sidebar}</aside><div className="fleet-directory-content">{children}</div></div>;
}

export function DirectoryGroups({title,items,value,onChange,action,footer,'aria-label':label}){
 return <section className="fleet-directory-groups" aria-label={label||`${title}별 조회`}>
  <div className="fleet-directory-heading"><h2>{title}</h2>{action}</div>
  <div className="fleet-directory-group-list">{items.map(item=><button type="button" className="fleet-directory-group" key={item.id} aria-pressed={String(value)===String(item.id)} disabled={item.disabled} onClick={()=>onChange(item.id)}><span>{item.label}</span><span className="fleet-directory-group-count">{item.count??'—'}</span></button>)}</div>
  {footer&&<div className="fleet-directory-group-footer">{footer}</div>}
 </section>;
}

export default DirectoryLayout;

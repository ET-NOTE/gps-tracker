import { useEffect, useRef, useState } from 'react';
import Icon from '../Icon';
import { Modal } from '../ui';
import { vehicleName } from '../../lib/business';
import { useBusinessVehicle } from './BusinessWorkspace';
import BusinessDrawer from './BusinessDrawer';
import './rental-workspace.css';
import './fleet-workspace-layout.css';

import { rentalMenu, rentalPageHeadings, rentalPageDescriptions } from '../../lib/rentalMenu';
import { freightPageHeadings } from '../../lib/freightMenu';
export { rentalMenu, rentalPages } from '../../lib/rentalMenu';

function WorkspaceNav({page, group, onTab, menu, label}) {
  const [expanded, setExpanded] = useState(() => new Set([group.id]));
  useEffect(() => setExpanded(previous => new Set([...previous, group.id])), [group.id]);
  function toggle(id) {
    setExpanded(previous => {
      const next = new Set(previous);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  return <nav aria-label={label + ' 메뉴'} className="rnt-nav">{menu.map(g => {
    const branch = g.pages.length > 1, open = expanded.has(g.id);
    return <div key={g.id}><button type="button" className="rnt-group" data-active={group.id === g.id}
      aria-expanded={branch ? open : undefined} aria-current={!branch && group.id === g.id ? 'page' : undefined}
      onClick={() => branch ? toggle(g.id) : onTab(g.pages[0][0])}>
      <Icon name={g.icon}/><span>{g.label}</span>{branch && <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14}/>}
    </button>
      {branch && open && <div className="rnt-subnav">{g.pages.map(([id,label]) =>
        <button className="rnt-subitem" type="button" key={id} aria-current={id === page ? 'page' : undefined} onClick={() => onTab(id)}>{label}</button>)}</div>}
    </div>;
  })}</nav>;
}

function WorkspaceSearch({devices, onTab, onClose, menu, onDevice}) {
  const [query,setQuery] = useState('');
  const openVehicle = useBusinessVehicle();
  const q = query.trim().toLocaleLowerCase();
  const pages = menu.flatMap(g => g.pages.filter(([,label]) => (g.label+' '+label).includes(q)).map(([id,label]) => ({id,label,group:g.label})));
  const matches = devices.filter(d => [vehicleName(d), d.car_plate, d.display_name].some(v => v?.toLocaleLowerCase().includes(q)));
  return <Modal open title="차량·메뉴 검색" onClose={onClose}><div className="rnt-search-results">
    <input type="search" autoFocus value={query} onChange={e=>setQuery(e.target.value)} aria-label="차량 또는 메뉴명" placeholder="차량번호, 차량명 또는 메뉴명"/>
    {pages.map(p=><button className="rnt-search-match" key={p.id} onClick={()=>{onClose();onTab(p.id);}}><span>{p.label}</span><small>{p.group}</small></button>)}
    {matches.map(d=><button className="rnt-search-match" key={d.id} onClick={()=>{onClose();(onDevice || openVehicle)?.(d);}}><span>{vehicleName(d)}</span><small>차량</small></button>)}
    {!pages.length && !matches.length && <p>일치하는 차량이나 메뉴가 없습니다.</p>}
  </div></Modal>;
}

export default function RentalWorkspace({page,onTab,onNavigate,destinations,devices,children,menu=rentalMenu,serviceLabel='렌트카',heading='렌트카 운영',widthKey='rental.area.width',onSearchDevice,headerAction}) {
  const landing=menu[0].pages[0][0];
  const group = menu.find(g => g.pages.some(([id])=>id===page)) || menu[0];
  const pageLabel = group.pages.find(([id]) => id === page)?.[1];
  const title = (menu === rentalMenu ? rentalPageHeadings[page] : freightPageHeadings[page]?.title) || pageLabel;
  const description = menu === rentalMenu
    ? rentalPageDescriptions[page]
    : freightPageHeadings[page]?.description;
  const today = new Date().toLocaleDateString('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'long',day:'numeric',weekday:'long'});
  const [dialog,setDialog] = useState(null);
  const [wide,setWide] = useState(()=>{try{return localStorage.getItem(widthKey)==='wide';}catch{return false;}});
  const content = useRef(null);
  useEffect(()=>{content.current?.scrollTo({top:0});},[page]);
  useEffect(()=>{
    const key=e=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'&&(!document.querySelector('[aria-modal="true"]')||dialog==='search')){
      e.preventDefault();e.stopImmediatePropagation();setDialog(dialog==='search'?null:'search');}};
    window.addEventListener('keydown',key,true);
    return ()=>window.removeEventListener('keydown',key,true);
  },[dialog]);
  const choose=id=>{setDialog(null);onTab(id);};
  const nav = <WorkspaceNav menu={menu} label={serviceLabel} group={group} page={page} onTab={choose}/>;
  const accountLinks = (destinations || [{id:'home',label:'전체 지도',icon:'map'},{id:'devices',label:'내 단말기',icon:'antenna'},{id:'profile',label:'내 정보',icon:'user'}]).map(item=>
    <button className="rnt-group" key={item.id} onClick={()=>{setDialog(null);onNavigate?.(item.id);}}><Icon name={item.icon}/>{item.id==='home'?'전체 지도':item.label}</button>);
  return <section className="gps-user-panel gps-business-panel rnt-shell" data-workspace={widthKey} data-page={page} data-wide={wide}>
    <aside className="rnt-sidebar no-print"><button className="rnt-brand" onClick={()=>choose(landing)}><i><Icon name="car"/></i><span>{heading}</span></button>
      <small className="rnt-service-name">시리얼링크 · 업무 공간</small>
      {nav}
      {onNavigate&&<button className="rnt-account" onClick={()=>setDialog('account')}><Icon name="user"/>계정 메뉴<Icon name="chevron-right" size={15}/></button>}
    </aside>
    <div className="rnt-main"><header className="rnt-top no-print">
      <button className="rnt-menu-trigger rnt-icon" aria-label="전체 메뉴" onClick={()=>setDialog('nav')}><Icon name="menu"/></button>
      <div className="rnt-breadcrumb"><span>{heading}</span><Icon name="chevron-right" size={13}/><strong>{group.label}</strong>{group.pages.length>1&&<span className="rnt-leaf"><Icon name="chevron-right" size={13}/>{group.pages.find(([id])=>id===page)?.[1]}</span>}</div>
      <div className="rnt-width" role="group" aria-label="화면 폭"><span>화면 폭</span>{[[false,'기본'],[true,'넓게']].map(([v,s])=><button className="rnt-width-option" key={s} aria-pressed={v===wide} onClick={()=>{setWide(v);try{localStorage.setItem(widthKey,v?'wide':'normal');}catch{/* private browser */}}}>{s}</button>)}</div>
      <button className="rnt-search" onClick={()=>setDialog('search')} aria-label="차량·메뉴 검색"><Icon name="search" size={17}/><span>차량·메뉴 검색</span></button>
      {headerAction}<button className="rnt-icon" aria-label="계정 메뉴 열기" onClick={()=>setDialog('account')}><Icon name="user"/></button>
    </header><div className="rnt-scroller" ref={content}><div className="rnt-content">
      <div className="rnt-title"><div><h1>{title}</h1>{description && <p>{description}</p>}</div><div className="rnt-title-actions"><time>{today}</time></div></div>
      {children}
    </div></div></div>
    {dialog==='nav'&&<BusinessDrawer navigation title={heading} onClose={()=>setDialog(null)}>{nav}</BusinessDrawer>}
    {dialog==='account'&&<BusinessDrawer title="계정 메뉴" onClose={()=>setDialog(null)}><div className="rnt-nav">{accountLinks}</div></BusinessDrawer>}
    {dialog==='search'&&<WorkspaceSearch menu={menu} onDevice={onSearchDevice} devices={devices} onTab={choose} onClose={()=>setDialog(null)}/>}
  </section>;
}

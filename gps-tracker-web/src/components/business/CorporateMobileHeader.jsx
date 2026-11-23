import { useState } from 'react';
import Icon from '../Icon';
import BusinessDrawer from './BusinessDrawer';
import {WorkspaceAvatar,WorkspaceBreadcrumb,WorkspaceHeaderActions,WorkspaceScope,WorkspaceWidthControl} from './WorkspaceHeader';
import './corporate-mobile-shell.css';

export default function CorporateMobileHeader({ active, groups, tabs, sections = {}, section, onTab, toolbar, destinations, onNavigate, onQuick, company, wide, onWidth }) {
  const [panel, setPanel] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const groupId = active.group || active.id;
  const groupsToShow = groups || tabs;
  const group = groupsToShow.find(item => item.id === groupId) || active;
  const sectionLabel = sections[active.id]?.find(([id]) => id === section)?.[1];
  const pageLabel = sectionLabel || active.label;
  const crumb = pageLabel.startsWith(group.label + ' ') ? pageLabel.slice(group.label.length + 1) : pageLabel;
  const map = destinations.find(item => item.id === 'home');
  const close = () => setPanel(null);
  function openMenu() {
    setExpanded(groupId);
    setPanel('navigation');
  }
  function visit(pageId, sectionId) {
    onTab(pageId, sectionId);
    close();
  }
  function leave(id) {
    close();
    onNavigate(id);
  }
  return <>
    <header className="corporate-phone-header ws-member-top no-print">
      <button type="button" className="ws-icon ws-menu" aria-label="전체 메뉴" aria-haspopup="dialog" aria-expanded={panel === 'navigation'} onClick={openMenu}><Icon name="menu" size={17}/></button>
      <WorkspaceBreadcrumb service="법인운행" group={group.label} page={crumb}/>
      <WorkspaceHeaderActions scope={<WorkspaceScope/>}
        widthControl={onWidth && <WorkspaceWidthControl className="fleet-width" wide={wide} onChange={onWidth}/>}
        search={<><button type="button" className="ws-wide-search" aria-label="차량·메뉴 검색" onClick={()=>onQuick('search')}><Icon name="search" size={16}/></button>
          {onNavigate && map && <button type="button" className="ws-icon ws-secondary" aria-label={map.label} onClick={() => leave(map.id)}><Icon name="map" size={16}/></button>}</>}
        alerts={<button type="button" className="ws-icon" aria-label="운영 알림" onClick={()=>onQuick('alerts')}><Icon name="bell" size={17}/></button>}/>
      <WorkspaceAvatar label="회사 및 계정 메뉴" expanded={panel==='account'} onClick={()=>setPanel('account')}/>
    </header>
    {panel === 'navigation' && <BusinessDrawer title="법인운행" subtitle={company && company+' · 업무 공간'} navigation onHome={()=>visit(tabs[0].id)} onClose={close}>
      <nav className="corporate-phone-links" aria-label="법인차 화면 이동">
        {groupsToShow.map(item => {
          const pages = tabs.filter(t => (t.group || t.id) === item.id);
          const links = pages.flatMap(page => sections[page.id]?.length
            ? sections[page.id].map(([id, label]) => ({pageId:page.id, sectionId:id, label}))
            : [{pageId:page.id, label:page.label}]);
          const nested = links.length > 1;
          const open = expanded === item.id;
          return <div key={item.id}>
            <button type="button" className="corporate-phone-destination"
              data-active={groupId === item.id} aria-current={!nested && groupId === item.id ? 'page' : undefined}
              aria-expanded={nested ? open : undefined}
              onClick={() => nested ? setExpanded(open ? null : item.id) : visit(links[0].pageId, links[0].sectionId)}>
              <Icon name={item.id === 'vehicles' ? 'car' : item.icon} size={20}/><span>{item.label}</span>
              {nested && <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16}/>}
            </button>
            {nested && open && <div className="corporate-phone-children">
              {links.map(link => <button type="button" className="corporate-phone-subpage" key={link.pageId+(link.sectionId||'')}
                aria-current={active.id === link.pageId && (!link.sectionId || link.sectionId === section) ? 'page' : undefined}
                onClick={() => visit(link.pageId, link.sectionId)}>{link.label}</button>)}
            </div>}
          </div>;
        })}
      </nav>
      {onNavigate && map && <button type="button" className="corporate-phone-map" onClick={() => leave(map.id)}><Icon name="mapPin" size={20}/>{map.label}</button>}
      <button type="button" className="ws-nav-search" onClick={()=>{close();onQuick('search');}}><Icon name="search" size={17}/>차량·메뉴 검색</button>
      {onNavigate && <button type="button" className="ws-nav-account" onClick={()=>setPanel('account')}><Icon name="user" size={16}/>회사 및 계정 메뉴</button>}
    </BusinessDrawer>}
    {panel === 'account' && <BusinessDrawer title="회사 및 계정" onClose={close}>
      <div className="corporate-phone-account">{toolbar}
        <button type="button" className="business-button" onClick={() => {close(); onQuick('alerts');}}><Icon name="bell" size={18}/>운영 알림</button>
        {onNavigate && destinations.filter(item => item.id !== 'home').map(item =>
          <button type="button" className="business-button" key={item.id} onClick={() => leave(item.id)}><Icon name={item.icon} size={18}/>{item.label}</button>)}
      </div>
    </BusinessDrawer>}
  </>;
}

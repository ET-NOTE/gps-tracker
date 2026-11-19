import { useState } from 'react';
import Icon from '../Icon';
import { openPalette } from '../ui/CommandPalette';
import BusinessDrawer from './BusinessDrawer';
import './corporate-mobile-shell.css';

export default function CorporateMobileHeader({ active, groups, tabs, sections = {}, section, onSection, onTab, toolbar, destinations, onNavigate }) {
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
    onTab(pageId);
    if (sectionId) onSection(pageId, sectionId);
    close();
  }
  function leave(id) {
    close();
    onNavigate(id);
  }
  return <>
    <header className="corporate-phone-header no-print">
      <button type="button" className="corporate-phone-tool" aria-label="전체 메뉴" aria-haspopup="dialog" aria-expanded={panel === 'navigation'} onClick={openMenu}><Icon name="menu" size={22}/></button>
      {active.id === 'overview' ? <h1 className="corporate-phone-brand">Serial<span>Link</span></h1>
        : <h1 className="corporate-phone-location"><Icon name={groupId === 'vehicles' ? 'car' : group.icon} size={17}/><span>{group.label}</span>
          {crumb !== group.label && <><Icon name="chevron-right" size={13}/><strong>{crumb}</strong></>}
        </h1>}
      {onNavigate && map && <button type="button" className="corporate-phone-tool" aria-label={map.label} onClick={() => leave(map.id)}><Icon name="map" size={21}/></button>}
      <button type="button" className="corporate-phone-tool" aria-label="회사 및 계정 메뉴" aria-haspopup="dialog" aria-expanded={panel === 'account'} onClick={() => setPanel('account')}><Icon name="more" size={22}/></button>
    </header>
    {panel === 'navigation' && <BusinessDrawer title="전체 메뉴" navigation onClose={close}>
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
              aria-current={!nested && groupId === item.id ? 'page' : undefined}
              aria-expanded={nested ? open : undefined}
              onClick={() => nested ? setExpanded(open ? null : item.id) : visit(links[0].pageId, links[0].sectionId)}>
              <Icon name={item.id === 'vehicles' ? 'car' : item.icon} size={20}/><span>{item.label}</span>
              {nested && <Icon name={open ? 'chevron-up' : 'chevron-down'} size={16}/>}
            </button>
            {nested && open && <div className="corporate-phone-children">
              {links.map(link => <button type="button" className="corporate-phone-subpage" key={link.sectionId || link.pageId}
                aria-current={active.id === link.pageId && (!link.sectionId || link.sectionId === section) ? 'page' : undefined}
                onClick={() => visit(link.pageId, link.sectionId)}>{link.label}</button>)}
            </div>}
          </div>;
        })}
      </nav>
      {onNavigate && map && <button type="button" className="corporate-phone-map" onClick={() => leave(map.id)}><Icon name="mapPin" size={20}/>{map.label}</button>}
    </BusinessDrawer>}
    {panel === 'account' && <BusinessDrawer title="회사 및 계정" onClose={close}>
      <div className="corporate-phone-account">{toolbar}
        <button type="button" className="business-button" onClick={() => {close(); openPalette();}}><Icon name="search" size={18}/>차량·메뉴 검색</button>
        {onNavigate && destinations.filter(item => item.id !== 'home').map(item =>
          <button type="button" className="business-button" key={item.id} onClick={() => leave(item.id)}><Icon name={item.icon} size={18}/>{item.label}</button>)}
      </div>
    </BusinessDrawer>}
  </>;
}

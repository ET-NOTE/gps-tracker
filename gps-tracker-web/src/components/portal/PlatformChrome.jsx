import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Icon from '../Icon';
import Modal from '../ui/Modal';
import { useAccountType } from '../../state';
import { clearTokens } from '../../api';
import { terminalName } from '../../lib/corporateOverview';
import { corporateTabs } from '../../lib/corporateNavigation';
import { freightMenu } from '../../lib/freightMenu';
import { rentalMenu } from '../../lib/rentalMenu';
import TerminalAlerts from './TerminalAlerts';
import { CORE_LINKS, SERVICES, deviceMatches, ownerServices } from './platformModel';

const SETTINGS_PATH = '/profile?tab=services';
const ADMIN = { view: 'admin', path: '/admin', label: '관리자', icon: 'settings' };

function enabledLinks(available, paths) {
  return SERVICES.filter(s => available.includes(s.key)).map(s => ({ ...s, path: paths[s.key] || s.path }));
}

function RailItem({ item, active }) {
  return <Link className="pt-rail-link" to={item.path} aria-current={active ? 'page' : undefined}>
    <Icon name={item.icon} size={20}/><span>{item.label}</span>
  </Link>;
}

export function PlatformRail({ view, availableServices = [], servicePaths = {}, isAdmin, onLogout, onShowGuide }) {
  const [help, setHelp] = useState(false);
  const activeServices = enabledLinks(availableServices, servicePaths);
  return <aside className="pt-rail" aria-label="시리얼링크">
    <Link to="/" className="pt-mark" aria-label="시리얼링크 홈"><Icon name="mapPin" size={23}/></Link>
    <nav className="pt-rail-group" aria-label="공통 메뉴">
      {CORE_LINKS.map(item => <RailItem key={item.view} item={item} active={view === item.view}/>)}
    </nav>
    <nav className="pt-rail-group pt-rail-services" aria-label="업무 서비스">
      {activeServices.map(item => <RailItem key={item.view} item={item} active={view === item.view}/>)}
      <Link className="pt-rail-link" to={SETTINGS_PATH} aria-label="이용 서비스 설정"><Icon name="plus" size={18}/><span>서비스</span></Link>
      {isAdmin && <RailItem item={ADMIN} active={view === 'admin'}/>}
    </nav>
    <div className="pt-rail-foot">
      <button type="button" className="pt-rail-link" onClick={() => setHelp(true)}><Icon name="info"/><span>도움말</span></button>
      {onLogout && <button type="button" className="pt-rail-link" onClick={() => { clearTokens(); onLogout(); }}><Icon name="logout"/><span>로그아웃</span></button>}
    </div>
    <Modal open={help} onClose={() => setHelp(false)} title="이용 도움말">
      <dl className="pt-help"><dt>지도 홈</dt><dd>단말기를 선택해 마지막 위치와 이동 기록을 확인하세요.</dd><dt>단말기</dt><dd>단말기를 등록하고 통신 상태와 배터리를 확인하세요.</dd><dt>이용 서비스</dt><dd>내정보에서 업무 서비스와 로그인 후 시작 화면을 설정하세요.</dd></dl>
      <Link className="pt-button" to={SETTINGS_PATH} onClick={() => setHelp(false)}>이용 서비스 열기</Link>
      {onShowGuide && <button type="button" className="pt-button" onClick={() => {setHelp(false); onShowGuide();}}>기본 사용법</button>}
    </Modal>
  </aside>;
}

const OWNER_PAGES = {
  corporate_fleet: corporateTabs.map(item => [item.id, item.label]),
  rentcar: rentalMenu.flatMap(group => group.pages),
  delivery: freightMenu.flatMap(group => group.pages),
};

export function ScopeSelect({ scope, scopeOptions = [], onScopeChange, labelled = false }) {
  if (!scopeOptions.length) return null;
  const current = scopeOptions.find(option => String(option.value) === String(scope)) || scopeOptions[0];
  return <label className={'pt-scope' + (labelled ? ' pt-scope-field' : '')}>
    {labelled ? <span>현재 조회 범위</span> : <Icon name={current.value === 'personal' ? 'user' : 'office'} size={15}/>}
    <select value={current.value} aria-label="조회 범위" onChange={e => onScopeChange?.(e.target.value)}>
      {scopeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </label>;
}

function GlobalSearch({ services, owned, devices, isAdmin, onDevice, onClose }) {
  const [text, setText] = useState('');
  const query = text.trim().toLocaleLowerCase();
  const shortcuts = [...CORE_LINKS, { label: '이용 서비스 설정', path: SETTINGS_PATH, icon: 'settings' },
    ...services, ...(isAdmin ? [ADMIN] : [])];
  if (query) {
    for (const service of services) {
      if (!owned.includes(service.key) || service.path.includes('?')) continue;
      for (const [page, label] of OWNER_PAGES[service.key]) {
        shortcuts.push({ label, context: service.label, icon: service.icon, path: service.path + '?page=' + encodeURIComponent(page) });
      }
    }
  }
  const links = shortcuts.filter(s => !query || [s.label, s.context].filter(Boolean).join(' ').toLocaleLowerCase().includes(query));
  const matches = query ? devices.filter(device => deviceMatches(device, text)) : [];
  return <Modal open title="통합 검색" onClose={onClose} size="lg"
    footer={<div className="pt-dialog-actions"><button className="pt-button" type="button" aria-label="통합 검색 닫기" onClick={onClose}>닫기</button></div>}>
    <label className="pt-search-field"><Icon name="search" size={17}/><input type="search" value={text} onChange={e => setText(e.target.value)} autoComplete="off" placeholder="메뉴, 단말기 이름 또는 차량번호" aria-label="단말기와 메뉴 검색"/></label>
    <div className="pt-search-results">
      {links.length > 0 && <h3>메뉴</h3>}
      {links.map(item => <Link key={item.path} to={item.path} onClick={onClose}><Icon name={item.icon}/><span>{item.label}</span>{item.context && <small>{item.context}</small>}</Link>)}
      {matches.length > 0 && <h3>단말기</h3>}
      {matches.map(device => <button type="button" key={device.id} onClick={() => { onClose(); onDevice(device.id); }}>
        <Icon name="antenna"/><span>{terminalName(device)}</span>{device.device_uid && <small>{device.device_uid}</small>}
      </button>)}
      {!links.length && !matches.length && <p className="pt-empty">일치하는 단말기나 메뉴가 없습니다.</p>}
    </div>
  </Modal>;
}

export function PlatformHeader({ view, availableServices = [], servicePaths = {}, isAdmin, me, devices = [], meta = {},
  scope, scopeOptions, onScopeChange, onDevice }) {
  const [panel, setPanel] = useState('');
  const { data: account } = useAccountType();
  const navigate = useNavigate();
  const links = enabledLinks(availableServices, servicePaths);
  const current = [...CORE_LINKS, ...links, ADMIN].find(item => item.view === view);
  const name = me?.display_name?.trim() || me?.email || '내정보';
  const openDevice = id => onDevice ? onDevice(id) : navigate('/devices');
  useEffect(() => {
    const shortcut = event => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'k' || event.isComposing) return;
      event.preventDefault();
      if (document.querySelector('[role="dialog"]')) return;
      setPanel('search');
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, []);
  return <header className="pt-header">
    <div className="pt-crumb"><span>위치관리</span><Icon name="chevron-right" size={13}/><strong>{current?.label || '홈'}</strong></div>
    <div className="pt-header-actions">
      <ScopeSelect {...{scope, scopeOptions, onScopeChange}}/>
      <button type="button" className="pt-search-trigger" onClick={() => setPanel('search')} aria-label="통합 검색" aria-haspopup="dialog" aria-keyshortcuts="Control+k Meta+k"><Icon name="search" size={17}/><span>메뉴·단말기 검색</span><kbd>Ctrl K</kbd></button>
      <TerminalAlerts devices={devices} meta={meta} onDevice={openDevice}/>
      <Link className="pt-avatar" aria-label="내 계정" title={name} to="/profile?tab=account">{Array.from(name)[0]}</Link>
    </div>
    {panel === 'search' && <GlobalSearch services={links} owned={ownerServices(account)} {...{devices,isAdmin}} onDevice={openDevice} onClose={() => setPanel('')}/>}
  </header>;
}

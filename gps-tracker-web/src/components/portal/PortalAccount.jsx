import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { api, clearTokens } from '../../api';
import { qk, useAccountType, useMe, useChatUnread } from '../../state';
import { rememberFleetOwner } from '../../lib/fleetSession';
import Icon from '../Icon';
import Modal from '../ui/Modal';
import Switch from '../ui/Switch';
import ProfilePanel from '../ProfilePanel';
import { FleetJoin } from '../business/FleetAccess';
import { ScopeSelect } from './PlatformChrome';
import { SERVICES, ownerServices } from './platformModel';

const MAIN_TABS = [['account','계정','users'], ['services','이용 서비스','grid'], ['notif','알림','bell']];
const EXTRA_TABS = [['credit','포인트'], ['chat','관리자 채팅'], ['theme','화면 테마'], ['lab','연구소'], ['privacy','개인정보 요청']];

function CompanyCard({ scope, scopeOptions, onScopeChange }) {
  const [joining, setJoining] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const companies = scopeOptions.filter(option => option.value !== 'personal');
  const selected = companies.find(option => option.value === scope) || companies[0];
  return <section className="pt-panel">
    <div className="pt-section-head"><h3>회사 연결</h3>{companies.length > 0 && <span className="pt-tag">{companies.length}개 업무 공간</span>}</div>
    <div className="pt-company-row"><span className="pt-service-icon"><Icon name="office" size={21}/></span>
      <div><strong>{selected?.label || '연결된 회사가 없습니다'}</strong>
        <p>{selected ? '현재 계정으로 이용할 수 있는 업무 공간입니다.' : '관리자에게 받은 초대 코드로 회사에 참여하세요.'}</p>
      </div>
    </div>
    {companies.length > 0 && <ScopeSelect labelled {...{scope,scopeOptions,onScopeChange}}/>}
    <div className="pt-panel-foot"><span>회사 구성원과 권한은 사용자 메뉴에서 관리합니다.</span><button type="button" className="pt-text-button" onClick={() => setJoining(true)}>초대 코드 연결</button></div>
    {joining && <FleetJoin onClose={() => setJoining(false)} onJoined={async id => {
      rememberFleetOwner(id);
      await qc.invalidateQueries({ queryKey:['fleet-memberships'] });
      setJoining(false);
      navigate('/corporate');
    }}/>}
  </section>;
}

function ServicesPanel({ settings, availableServices, servicePaths, update, busy, ...scopeProps }) {
  const [detail, setDetail] = useState(null);
  const own = ownerServices(settings);
  return <>
    <div className="pt-section-head pt-services-heading"><div><h2>이용 서비스</h2><p>사용 설정을 켜면 왼쪽 메뉴에 해당 서비스가 나타납니다.</p></div><span>{availableServices.length}개 이용 중</span></div>
    <section className="pt-base-service">
      <span className="pt-service-icon"><Icon name="mapPin" size={22}/></span>
      <div><h3>기본 위치관리 <span className="pt-tag">기본 제공</span></h3><p>단말기 위치와 이동 기록, 통신 상태를 확인합니다.</p></div>
      <Link to="/" className="pt-button">지도 열기</Link>
    </section>
    <div className="pt-services-grid">
      {SERVICES.map(service => {
        const enabled = own.includes(service.key);
        const accessible = enabled || availableServices.includes(service.key);
        return <article className="pt-service-card" key={service.key} data-service={service.key} data-enabled={accessible}>
          <div className="pt-section-head"><span className="pt-service-icon"><Icon name={service.icon} size={22}/></span>
            <span className={'pt-tag' + (accessible ? ' pt-tag-active' : '')}>{enabled ? '사용 중' : accessible ? '직원 권한' : '사용 가능'}</span></div>
          <h3><button type="button" className="pt-service-title" aria-label={service.label + ' 기능 보기'} onClick={() => setDetail(service)}>{service.label}</button></h3><p>{service.description}</p>
          <ul className="pt-service-tags" aria-label={service.label + ' 주요 기능'}>{service.tags.map(tag => <li key={tag}>{tag}</li>)}</ul>
          <div className="pt-card-actions"><span className="pt-toggle"><Switch label={service.label + ' 사용 설정'}
            checked={enabled} disabled={busy} onChange={value => update({service:service.key, enabled:value})}/>{accessible && !enabled ? '내 사업장 사용' : '사용'}</span>
            {accessible
              ? <Link to={servicePaths[service.key] || service.path} className="pt-button">서비스 열기</Link>
              : <button type="button" className="pt-button" onClick={() => setDetail(service)}>기능 보기</button>}
          </div>
        </article>;
      })}
    </div>
    <p className="pt-services-note"><Icon name="info" size={14}/>여러 업무 서비스를 함께 사용할 수 있습니다.</p>
    <div className="pt-account-bottom">
      <CompanyCard {...scopeProps}/>
      <section className="pt-panel"><div className="pt-section-head"><h3>로그인 후 시작 화면</h3><Icon name="map" size={18}/></div>
        <label className="pt-start-field">시작할 화면
          <select value={settings.start_route || '/'} disabled={busy} onChange={e => update({start_route:e.target.value})}>
            <option value="/">지도 홈</option><option value="last">마지막 사용 화면</option>
            {SERVICES.filter(service => own.includes(service.key)).map(service => <option key={service.key} value={service.path}>{service.label}</option>)}
          </select>
        </label>
      </section>
    </div>
    <Modal open={!!detail} className="pt-standard-dialog" size={530} title={detail?.label} subtitle={detail?.description} onClose={() => setDetail(null)}
      footer={detail && <div className="pt-dialog-actions"><button type="button" className="pt-button" onClick={() => setDetail(null)}>닫기</button>{availableServices.includes(detail.key) || own.includes(detail.key)
          ? <Link to={servicePaths[detail.key] || detail.path} className="pt-button pt-primary" onClick={() => setDetail(null)}>서비스 열기</Link>
          : <button type="button" className="pt-button pt-primary" disabled={busy} onClick={async () => {
          setDetail(null); await update({service:detail.key, enabled:true});
        }}>서비스 사용하기</button>}</div>}>
      {detail && <ul className="pt-feature-list pt-feature-checks">{detail.features.map(feature => <li key={feature}><Icon name="check" size={16}/>{feature}</li>)}</ul>}
    </Modal>
  </>;
}

export default function PortalAccount({ availableServices = [], servicePaths = {}, onLogout, scope, scopeOptions = [], onScopeChange }) {
  const [query, setQuery] = useSearchParams();
  const meQuery = useMe();
  const settings = useAccountType();
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [extra, setExtra] = useState(false);
  const me = meQuery.data;
  const additional = EXTRA_TABS.filter(([id]) => id !== 'chat' || me?.role !== 'admin');
  const { data: unread = 0 } = useChatUnread(!!me && me.role !== 'admin');
  const requested = query.get('tab');
  const tab = [...MAIN_TABS, ...additional].some(([id]) => id === requested) ? requested : 'services';
  const extraTitle = additional.find(([id]) => id === tab)?.[1];
  const changeTab = id => {
    const params = new URLSearchParams(query);
    params.set('tab', id);
    setExtra(false);
    setQuery(params);
  };
  async function update(patch) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      const data = await api.patchPlatformSettings(patch);
      qc.setQueryData(qk.accountType(), data);
    } catch (e) {
      setError(e.message || '설정을 저장하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  if (!me) return <div className="pt-empty" role="status">{meQuery.error ? '계정 정보를 불러오지 못했습니다.' : '계정 정보를 확인하고 있습니다.'}
    {meQuery.error && <button type="button" className="pt-text-button" onClick={() => meQuery.refetch()}>다시 시도</button>}</div>;
  const name = me.display_name?.trim() || me.email;
  return <section className="pt-account" aria-label="내정보">
    <div className="pt-account-inner"><header className="pt-account-heading"><h1>내정보</h1><p>계정과 이용 서비스를 한곳에서 관리하세요.</p></header>
      <section className="pt-account-summary" aria-label="계정 요약">
        <span className="pt-summary-avatar">{Array.from(name || '내')[0]}</span>
        <div className="pt-account-person"><h2>{me.display_name?.trim() || '내 계정'}</h2><p>{me.email}</p></div>
        <div className="pt-summary-tags"><span className="pt-tag pt-tag-active">기본 위치관리</span><span className="pt-tag">업무 서비스 {availableServices.length}개</span></div>
        {onLogout && <button type="button" className="pt-text-button pt-logout" onClick={() => {clearTokens(); onLogout();}}><Icon name="power" size={15}/>로그아웃</button>}
      </section>
      <nav className="pt-account-tabs" aria-label="내정보 메뉴">
        {MAIN_TABS.map(([id,label,icon]) => <Link key={id} className="pt-account-tab" to={'/profile?tab=' + id} aria-current={tab === id ? 'page' : undefined}><Icon name={icon} size={15}/>{label}</Link>)}
        <button className="pt-account-tab pt-more-tabs" type="button" aria-current={extraTitle ? 'page' : undefined} onClick={() => setExtra(true)}>
          {extraTitle || '더보기'}{unread > 0 && <span className="pt-unread" aria-label={'읽지 않은 메시지 ' + unread + '개'}>{unread}</span>}<Icon name="chevron-down" size={13}/>
        </button>
      </nav>
      {error && <p role="alert" className="pt-error">{error}</p>}
      {tab === 'services' ? settings.data ? <ServicesPanel settings={settings.data} {...{availableServices,servicePaths,update,busy,scope,scopeOptions,onScopeChange}}/>
        : <div className="pt-empty" role="status">{settings.error ? <>서비스 설정을 불러오지 못했습니다. <button className="pt-text-button" onClick={() => settings.refetch()}>다시 시도</button></> : '서비스 설정을 확인하고 있습니다.'}</div>
        : <>{(tab === 'account' || tab === 'notif') && <div className="pt-section-head pt-services-heading"><div><h2>{tab === 'account' ? '내 계정 정보' : '단말기 알림'}</h2><p>{tab === 'account' ? '프로필과 연락처를 관리하세요.' : '알림을 받을 상황을 선택하세요.'}</p></div></div>}<ProfilePanel portalTab={tab} onPortalTab={changeTab} onLogout={onLogout} companySection={<CompanyCard {...{scope,scopeOptions,onScopeChange}}/>}/></>}
    </div>
    <Modal open={extra} onClose={() => setExtra(false)} title="추가 계정 메뉴"><div className="pt-search-results">
      {additional.map(([id,label]) => <button key={id} type="button" onClick={() => changeTab(id)}><span>{label}{id === 'chat' && unread > 0 ? ' (' + unread + ')' : ''}</span><Icon name="chevron-right" size={15}/></button>)}
    </div></Modal>
  </section>;
}

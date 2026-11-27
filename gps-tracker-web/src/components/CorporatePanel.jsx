import { subjectReport, subjectScopeNote } from '../lib/subjectReport';
import {summarizeMonthlyTrips,monthlyDistance,monthlyPercentages,monthlyStatus} from '../lib/monthlySummary';
import FleetIncompleteTrips from './business/FleetIncompleteTrips';
import {tripNeedsDetails} from '../lib/incompleteTrips';
import TripQualitySummary from './business/TripQualitySummary';
import {TripEvidence,TripCorrection,TripCorrectionHistory} from './business/FleetTripQuality';
import {qualityLabel,reportIncluded,tripTimeRange} from '../lib/tripQuality';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import useCorporatePhone from '../useCorporatePhone';
import { hideOutsideMockup } from '../lib/mockupHidden';
import { api } from '../api';
import Icon from './Icon';
import ExportButtons from './business/ExportButtons';
import FleetRecordMetrics from './business/FleetRecordMetrics';
import ReservationApproval from './business/ReservationApproval';
import CompanyPurposePicker from './business/CompanyPurposePicker';
import StaffTab from './business/FleetPeople';
import {CompanySubjectMappings} from './SubjectProvision';
import FleetSites from './business/FleetSites';
import FleetExpenses from './business/FleetExpenses';
import FleetAnalytics from './business/FleetAnalytics';
import MockupLineChart from './business/MockupLineChart';
// Desktop design date '2026.11.21 09:00' (display only).
const dotDateTime=value=>kstDateTime(value).replace(/^(\d{4})-(\d{2})-(\d{2})/,'$1.$2.$3');
import FleetLive from './business/FleetLive';
import FleetOperatingPolicy, { useOperatingPolicy } from './business/FleetReservationPolicy';
import FleetTripPurposes from './business/FleetTripPurposes';
import FleetTripLog from './business/FleetTripLog';
import FleetServiceUsage from './business/FleetServiceUsage';
import FleetNotificationSettings from './business/FleetNotificationSettings';
import FleetBookingHours from './business/FleetBookingHours';
import {TripAssignmentModal,TripRulesModal,TripAssignmentHistory} from './business/FleetTripAssignments';
import {tripAssignmentKey,canAssignTrip} from '../lib/tripAssignments';
import {FleetAccountScope,useFleetAccess,staffCanDrive} from './business/FleetAccess';
import { BusinessCompanyInfo as InfoTab, BusinessSubscription as SubTab } from './business/BusinessPreferences';
import { filterTrips, tripReport, tripDistance, monthlyReport, monthDateBounds, purposeLabel } from '../lib/businessExport';
import { BusinessWorkspace, BusinessLocation, useBusinessVehicle, BusinessButton, BusinessError, BusinessEmpty, BusinessSection, BusinessMetrics, BusinessTask, BusinessSettings, BusinessVehicles } from './business/BusinessWorkspace';
import { tripCompleteness } from '../lib/businessWorkspace';
import { corporateAttention, corporateVehicleName, terminalName, missingMaintenance } from '../lib/corporateOverview';
import { corporateGroups, corporateTabs, corporateSections } from '../lib/corporateNavigation';
import { ntsTripReport, reportVehicleLabel } from '../lib/ntsReport';
import { validateOdometerInput, odometerSummary } from '../lib/tripOdometer';
import { classifyDevice, ageString, setSignalLossMinutes } from '../colors';
import { deviceBattery } from '../lib/battery';
import { kstDateTime } from '../lib/businessExport';
import { useBusinessClock, useBusinessSubscription } from './business/useBusinessData';
import { calendarDate, businessDate, businessPeriod, maintenanceTasks, vehicleName } from '../lib/business';
import { confirmDialog, alertDialog } from './Dialog';
import { StatCard, StatCardGrid } from './shared/StatCard';
import CarImage from './CarImage';
import sedanArt from './entry/login-vehicle.png';

const receptionTones={active:'good',sleeping:'info',gps_loss:'warning',signal_loss:'warning',low_batt:'warning',offline:'urgent',lost:'urgent',critical_batt:'urgent',overcharge:'urgent'};
const receptionToneOf=status=>receptionTones[status?.id]||'';
import {FleetAssets,FleetAssetForm,FleetAssetDetail,useFleetAssets,projectFleetAssets,fleetAssetsKey,useAssetStats as useFleetStats,useFleetReservations as useReservations,useCreateFleetReservation as useCreateReservation,useUpdateFleetReservation as useUpdateReservation,useCancelFleetReservation as useDeleteReservation} from './business/FleetAssets';
import { Modal, FormField, Input, Select, Textarea, Button, SkeletonList } from './ui';
import {
  useCorporateInfo, useStaff,
  qk,
} from '../state';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import './business/corporate-console.css';
import './business/corporate-trips-cartax.css';
import './business/corporate-record-dialogs.css';
import './business/directory-layout.css';
import './business/fleet-design-shell.css';
import './business/fleet-member.css';
import './business/fleet-reference-records.css';
import './business/fleet-mockup-sync.css';

const PURPOSE_LABEL = {
  commute:     '출퇴근',
  business:    '업무',
  other:       '기타',
  unspecified: '미지정',
};

function reportPeriodError(from, to) {
  const dayStart = value => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return NaN;
    const time = Date.parse(`${value}T00:00:00+09:00`);
    return Number.isFinite(time) && new Date(time + 9 * 3600000).toISOString().slice(0, 10) === value ? time : NaN;
  };
  const start = dayStart(from), lastDay = dayStart(to);
  if (!Number.isFinite(start) || !Number.isFinite(lastDay) || lastDay < start) return '조회 시작일과 종료일을 올바르게 선택해 주세요.';
  // The API includes the final Korean date through 23:59:59, up to 366 days.
  if (lastDay + 86400000 - 1000 - start > 366 * 86400000) return '조회 기간은 시작일과 종료일을 포함해 최대 366일입니다. 기간을 줄여 주세요.';
  return '';
}

function reportMonthError(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) return '다운로드할 월을 선택해 주세요.';
  const year = Number(month.slice(0, 4));
  return year < 2000 || year > 2100 ? '다운로드 월은 2000년 1월부터 2100년 12월까지 선택할 수 있습니다.' : '';
}

function CorporatePanel({ devices: personalDevices, onMap: personalMap, onDevice, onVehiclesChange, onNavigate, globalNavigation, meta: personalMeta, toolbar, companyLabel, routeSearch, onRoute, mapReturn, onMapReturnUsed }) {
  const access=useFleetAccess();
  // PC 화면은 시안에 없는 요소를 숨긴다(기능·경로는 유지). 휴대폰은 모든 진입 경로를 유지한다.
  const mockupDesk=!useCorporatePhone()&&hideOutsideMockup;
  // 회사 운영 정책의 수신 지연 기준을 이 화면의 단말 상태 판단에 적용한다.
  const offlineMinutes=useOperatingPolicy().data?.offline_minutes;
  useEffect(()=>{setSignalLossMinutes(offlineMinutes);return ()=>setSignalLossMinutes();},[offlineMinutes]);
  const terminals=useQuery({queryKey:['fleet-terminals'],queryFn:()=>api.fleetTerminals(),refetchInterval:30000,structuralSharing:false});
  const subjectScoped=Boolean(terminals.data?.subjectScope);
  const rawDevices=terminals.data||[],rawMeta=access.billing&&!subjectScoped?personalMeta:{},rawOnMap=access.billing&&!subjectScoped?personalMap:undefined;
  const assets=useFleetAssets();
  const terminalsReady=!terminals.isPending&&!terminals.error;
  const vehiclesReady=!assets.isPending&&!assets.error;
  const devices=useMemo(()=>vehiclesReady&&terminalsReady?projectFleetAssets(assets.data||[],rawDevices):[],[vehiclesReady,terminalsReady,assets.data,rawDevices]);
  const meta=Object.fromEntries(devices.map(d=>[d.id,rawMeta?.[d.source_device_id]]));
  const onMap=id=>{const sim=devices.find(v=>v.id===id)?.source_device_id;if(sim)rawOnMap?.(sim);};
  const [restored, setRestored] = useState(() => mapReturn && mapReturn.ownerId === access.owner_id && mapReturn.actorId === access.actor_id ? mapReturn : null);
  const managerRole=['owner','admin','department_manager'].includes(access.role);
  const canReviewExpenses=access.review_expenses ?? managerRole;
  const canReviewReservations=access.review_reservations ?? managerRole;
  const canReview=canReviewExpenses || canReviewReservations;
  const visibleTabs=canReview ? corporateTabs : corporateTabs.filter(t=>t.id!=='approvals');
  const [localTab, setLocalTab] = useState(() => {
    const search = globalThis.location?.search;
    const requested = restored?.page || (search && new URLSearchParams(search).get('page'));
    return visibleTabs.some(item => item.id === requested) ? requested : 'overview';
  });
  const params = onRoute ? new URLSearchParams(routeSearch) : null;
  const requestedTab = params?.get('page') || restored?.page || 'overview';
  const tab = onRoute ? (visibleTabs.some(item => item.id === requestedTab) ? requestedTab : 'overview') : localTab;
  const [missingSchedulesOnly,setMissingSchedulesOnly]=useState(restored?.missingSchedulesOnly || false);
  useEffect(() => { if (mapReturn) onMapReturnUsed?.(); }, [mapReturn, onMapReturnUsed]);
  useEffect(() => { if (restored && restored.page !== tab) setRestored(null); }, [restored, tab]);
  const openDetailMap = rawOnMap && ((sim, detail) => rawOnMap(sim, {
    ...detail, page: tab, section:sectionTabs[tab], missingSchedulesOnly, ownerId: access.owner_id, actorId: access.actor_id,
  }));
  const [initialCreate,setInitialCreate]=useState(false);
  const openVehicles=(missingOnly=false,create=false)=>{setInitialCreate(create);setMissingSchedulesOnly(missingOnly);setTab('vehicles');};
  const defaults = {staff:'users',sites:'sites',settings:'company',analytics:'trips'};
  const [lastSections, setLastSections] = useState(() => ({...defaults, ...(restored?.section ? {[restored.page]:restored.section} : {})}));
  const sectionNavigation = corporateSections(access.manage_team);
  const routeSection = params?.get('section') || (!params?.has('page') && restored?.section);
  const sectionTabs = onRoute ? {...lastSections,[tab]:sectionNavigation[tab]?.some(([id])=>id===routeSection) ? routeSection : defaults[tab]} : lastSections;
  const [expenseDrill,setExpenseDrill]=useState(null);
  function setTab(page, requestedSection, expenseSelection=null) {
    if (!visibleTabs.some(item=>item.id===page)) return;
    if (page!=='analytics') setExpenseDrill(expenseSelection);
    const value = requestedSection || lastSections[page];
    const section = sectionNavigation[page]?.some(([id])=>id===value) ? value : defaults[page];
    if (section) setLastSections(previous=>previous[page]===section ? previous : {...previous,[page]:section});
    if (onRoute) onRoute(page,section);
    else setLocalTab(page);
  }
  const selectSection = value => setTab(tab,value);
  const [request, setRequest] = useState(null);
  const [reportDevice, setReportDevice] = useState(null);
  const [reportFilter,setReportFilter]=useState(null);
  const [analyticsPeriod,setAnalyticsPeriod]=useState(null);
  const subscription = useBusinessSubscription('corporate');
  const qc = useQueryClient();
  const updateSub = value => qc.setQueryData(qk.businessSubscription('corporate'), value);
  const reserve = value => { setRequest(value); setTab('reservations'); };
  const report = (device,filter=null) => { setReportDevice(device.id); setReportFilter(filter); setTab('report'); };
  const terminalError = terminals.error;
  const terminalNotice = terminalError && <BusinessError onRetry={terminals.refetch}>단말기 상태를 불러오지 못했습니다.</BusinessError>;
  if (terminalError) {
    const {status, name} = terminalError;
    const unavailable = status == null ? name === 'TypeError' : [0, 408, 429].includes(status) || status >= 500;
    // Keep the company access gate on denied or unrecognized responses.
    if (!unavailable) return <div className="fleet-access-error">{toolbar}{terminalNotice}{access.manage_team&&<CompanySubjectMappings/>}</div>;
  }
  const needsVehicles=tab!=='expense-categories';
  const vehicleNotice = terminalNotice || (terminalsReady && assets.error && <BusinessError onRetry={assets.refetch}>등록 차량을 불러오지 못했습니다.</BusinessError>);
  return <BusinessWorkspace initialVehicleId={(restored?.workspaceDetail || ['overview','live'].includes(restored?.page)) ? restored.vehicleId : null} renderVehicleDetail={(device,close)=><FleetAssetDetail meta={meta[device.id]} asset={device.asset} devices={rawDevices} onClose={close} onChanged={assets.refetch} onMap={openDetailMap && ((sim,detail)=>openDetailMap(sim,{...detail,workspaceDetail:true}))} onReport={report} onReserve={id=>reserve({new:true,vehicleId:id})} initialTab={device.id===restored?.vehicleId ? restored.detailTab : undefined}/>} title="법인차 운영" tabs={visibleTabs} groups={corporateGroups} tab={tab} onTab={(value,nextSection) => { setRequest(null); setReportFilter(null); setAnalyticsPeriod(null); setInitialCreate(false); setMissingSchedulesOnly(false); setTab(value,nextSection); }} devices={devices} kind="corporate" onMap={onMap} onVehicleAction={report} onManageVehicle={onDevice} onNavigate={onNavigate} onVehiclesChange={onVehiclesChange} meta={meta}
    vehicleStatus={vehiclesReady&&terminalsReady?'ready':vehicleNotice?'error':'loading'} toolbar={toolbar} globalNavigation={globalNavigation} section={sectionTabs[tab]} sections={sectionNavigation} companyLabel={companyLabel}
    >
    {subjectScoped && tab!=='report' && <p className="business-note" role="status">{subjectScopeNote}</p>}
    {needsVehicles&&(!terminalsReady||!vehiclesReady) ? (vehicleNotice || <SkeletonList count={3} itemHeight={140}/>) : <>
    {tab === 'overview' && <CorporateOverview devices={devices} onMap={onMap} onDevice={onDevice} onReport={report} onReserve={reserve} onMissingSchedules={()=>openVehicles(true)}
      onCreate={access.manage_vehicles ? ()=>openVehicles(false,true) : undefined} onVehicles={()=>openVehicles()} onExpenses={()=>setTab(canReviewExpenses?'approvals':'expenses')} onLive={()=>setTab('live')} onWeeklyReport={()=>{const now=Date.now();setAnalyticsPeriod({from:businessDate(now-6*86400000),to:businessDate(now)});setTab('analytics','trips');}}
      setup={access.manage_vehicles && <details className="corporate-setup"><summary>회사 시작하기</summary><div className="fleet-onboarding" aria-label="회사 시작하기"><BusinessButton onClick={()=>setTab('settings')}>회사 정보</BusinessButton><BusinessButton onClick={()=>openVehicles()}>차량 등록·단말기 연결</BusinessButton><BusinessButton onClick={()=>setTab('staff')}>사용자 배정</BusinessButton></div></details>}/>}
    {tab === 'live' && <FleetLive devices={devices} onRefresh={()=>Promise.all([terminals.refetch(),assets.refetch()])} initialId={restored?.page==='live' ? restored.vehicleId : null}/>}
    {['vehicles','devices','maintenance'].includes(tab) && <FleetAssets key={tab+(missingSchedulesOnly?'missing-schedules':'all')} mode={tab} canRegisterTerminal={access.billing && !subjectScoped && !!onNavigate} onReserve={id=>reserve({new:true,vehicleId:id})} initialCreate={initialCreate} initialMissingSchedules={missingSchedulesOnly} mapReturn={!restored?.workspaceDetail && restored?.page===tab ? restored : null} onReport={report} meta={meta} assets={assets.data||[]} devices={rawDevices} onMap={openDetailMap} onChanged={assets.refetch} />}
    {tab === 'reservations' && <ReservationsTab devices={devices} request={request} />}
    {tab === 'staff' && <><StaffTab activeTab={sectionTabs.staff} onTab={selectSection} onSites={()=>setTab('sites','sites')} sites={<FleetSites/>} hideNavigation />{access.manage_team&&sectionTabs.staff==='users'&&!mockupDesk&&<details className="corporate-admin-details"><summary>계정·단말기 연결 설정</summary><CompanySubjectMappings/></details>}</>}
    {tab === 'sites' && <FleetSites activeTab={sectionTabs.sites} onTab={selectSection} hideNavigation />}
    {['expenses','expense-categories'].includes(tab) && <FleetExpenses categoriesOnly={tab==='expense-categories'} initialScope={expenseDrill?.ledger} onOpenCategories={()=>setTab('expense-categories')}/>}
    {tab==='approvals'&&canReview&&<FleetExpenses approvalsOnly reservationInbox={canReviewReservations ? <ReservationsTab devices={devices} requestsOnly/> : null}/>}
    {tab==='analytics'&&sectionTabs.analytics==='costs'&&<FleetAnalytics key="costs" section="costs" devices={devices} initialView={expenseDrill?.view} onExpenses={selection=>setTab('expenses',undefined,selection)}/>}
    {(['report','monthly'].includes(tab)||(tab==='analytics' && sectionTabs.analytics==='trips')) && <>
      {subscription.error ? <BusinessError onRetry={subscription.refetch}>이용권 상태를 확인하지 못했습니다. 다시 조회해 주세요.</BusinessError>
        : !subscription.data ? <SkeletonList count={2} itemHeight={140} />
        : !subscription.data.active ? <><div className="fleet-report-access"><span>이 회사의 리포트 이용권이 필요합니다.</span><a href={(import.meta.env?.BASE_URL||'/')+'demo/corporate?view='+(tab==='analytics'?'trip-stats':'trips')} target="_blank" rel="noopener noreferrer">예시 리포트 미리보기 ↗</a></div><SubTab canBuy={access.billing} sub={subscription.data} onChange={updateSub} report /></>
        : tab==='analytics' ? <FleetAnalytics key="trips" section="trips" initialPeriod={analyticsPeriod} devices={devices} onReport={report}/> : tab === 'report' ? <TripLogTab key={String(reportDevice)+JSON.stringify(reportFilter)} devices={devices} initialDeviceId={reportDevice} initialFilter={reportFilter} /> : <MonthlyReportTab devices={devices} />}</>}
    {tab==='settings' && sectionTabs.settings==='policy' && <FleetOperatingPolicy desk={mockupDesk}/>}
    {tab==='settings' && sectionTabs.settings==='purposes' && <FleetTripPurposes access={access}/>}
    {tab==='settings' && sectionTabs.settings==='notifications' && <FleetNotificationSettings onPolicy={()=>setTab('settings','policy')}/>}
    {tab === 'settings' && sectionTabs.settings==='company' && <div className="fleet-company-service"><section aria-label="회사 정보"><InfoTab readOnly={!access.manage_team} /></section><section aria-label="서비스 이용 현황"><FleetServiceUsage subscription={subscription.data}/>{subscription.error ? <BusinessError onRetry={subscription.refetch}>이용권 정보를 불러오지 못했습니다.</BusinessError> : <SubTab canBuy={access.billing} sub={subscription.data} onChange={updateSub} />}</section></div>}
    {tab === 'settings' && sectionTabs.settings==='subscription' && <BusinessSettings activeTab={sectionTabs.settings} onTab={selectSection} hideNavigation company={<InfoTab readOnly={!access.manage_team} />} subscription={subscription.error ? <BusinessError onRetry={subscription.refetch}>이용권 정보를 불러오지 못했습니다.</BusinessError> : <SubTab canBuy={access.billing} sub={subscription.data} onChange={updateSub} />} />}
    </>}
  </BusinessWorkspace>;
}
export default function CorporateAccountPanel({defaultOwner,allowedMemberships,...props}){
  return <FleetAccountScope defaultOwner={defaultOwner} allowedMemberships={allowedMemberships}>
    {(toolbar,companyLabel)=><CorporatePanel {...props} toolbar={toolbar} companyLabel={companyLabel}/>}
  </FleetAccountScope>;
}

function CorporateOverview({ devices, onMap, onReport, onReserve, onMissingSchedules, onVehicles, onExpenses, onLive, onWeeklyReport, onCreate, setup }) {
  const deskOverview=!useCorporatePhone()&&hideOutsideMockup, companyName=useCorporateInfo()?.data?.company_name?.trim();
  const now=useBusinessClock(), period=businessPeriod(now), openVehicle=useBusinessVehicle();
  const tasksRef=useRef(null), [weekly,setWeekly]=useState(null), [showVehicles,setShowVehicles]=useState(false);
  const reservations=useReservations({from:period.todayStart,to:period.todayEnd},{refetchInterval:60000});
  const expenseFilters={from:period.day.slice(0,7)+'-01',to:period.day,status:'pending'};
  const expenses=useQuery({queryKey:['fleet-expenses',expenseFilters],queryFn:()=>api.listExpenses(expenseFilters),staleTime:60000});
  const pending=expenses.error?null:expenses.data?.items?.filter(item=>item.status==='pending').length;
  const reserved=reservations.error?null:reservations.data?.filter(r=>['planned','in_progress'].includes(r.status)).length;
  const summary=weekly?.day===period.day&&weekly.ids===devices.map(d=>d.id).join(',')?weekly:null;
  const stats=useFleetStats(devices), maintenance=maintenanceTasks(devices,now), missing=missingMaintenance(devices);
  const staff=useStaff()?.data||[];
  const available=devices.filter(d=>d.enabled!==false).length;
  const tasks=corporateAttention(devices,now,{classify:classifyDevice,battery:deviceBattery});
  const attention=summary?.complete&&pending!=null?tasks.length+missing.length+pending+summary.missing:null;
  // Desktop design: three attention items (trip records, expense approvals, terminal reception) and their total.
  const signalCount=tasks.filter(t=>t.id.startsWith('signal-')).length;
  const deskAttention=summary?.complete&&pending!=null?summary.missing+pending+signalCount:null;
  const running=summary?.complete?summary.running:null, inService=devices.filter(d=>d.enabled===false).length;
  const todayBookings=reservations.error?null:reservations.data?.filter(r=>!['cancelled','rejected'].includes(r.status)).length;
  const cards=[
    {label:'전체 차량',value:devices.length,unit:'대',icon:'car',note:'등록된 법인 차량',onClick:onVehicles},
    {label:'운행 중',value:summary?.complete?summary.running:null,unit:'대',icon:'route',tone:'green',note:'운행 기록 기준',onClick:onLive},
    {label:'오늘 예약',value:deskOverview?todayBookings:reserved,unit:'건',icon:'calendar',note:deskOverview?'취소·반려 예약 제외':'예정·이용 중 예약',onClick:()=>onReserve({})},
    {label:'확인할 일',value:deskOverview?deskAttention:attention,unit:'건',icon:'warn',tone:'amber',note:'운행 확인 · 결재 · 수신',onClick:()=>{tasksRef.current?.focus({preventScroll:true});tasksRef.current?.scrollIntoView({block:'nearest'});}},
  ];
  const days=Array.from({length:7},(_,i)=>businessDate(now-(6-i)*86400000));
  const distanceLabel=stats.error?'조회 실패':stats.loading?'조회 중':stats.todayKm!=null?stats.todayKm.toLocaleString()+' km':stats.pending?'집계 대기':'수신 없음';
  return <div className="business-overview fleet-dashboard">
    <div className="fleet-dashboard-toolbar">
      <div><time dateTime={period.day}><Icon name="calendar" size={15}/>{period.day.replaceAll('-','.')} · 오늘</time>{deskOverview&&companyName&&<span className="pill">{companyName}</span>}</div>
      <div>{onWeeklyReport&&<BusinessButton icon="bar" onClick={onWeeklyReport}>운행 리포트</BusinessButton>}{onCreate&&<BusinessButton primary icon="plus" onClick={onCreate}>차량 등록</BusinessButton>}</div>
    </div>
    <div className="fleet-dashboard-metrics">{cards.map(card=><button type="button" key={card.label} className={card.tone||''} onClick={card.onClick} disabled={!card.onClick}>
      <span><i><Icon name={card.icon} size={15}/></i>{card.label}<span className="fleet-metric-more">더보기 <Icon name="chevron-right" size={12}/></span></span><strong>{card.value??'—'}{card.value!=null&&<small>{card.unit}</small>}</strong>{card.note&&<em className="fleet-metric-note">{card.note}</em>}
    </button>)}</div>
    <div className="business-overview-grid fleet-dashboard-grid">
      <BusinessLocation devices={devices} onLive={onLive} fleetSummary={deskOverview?{running,idle:running==null?null:Math.max(0,devices.length-running-inService),check:signalCount}:undefined}/>
      {deskOverview?<div className="fleet-dashboard-tasks" tabIndex={-1} ref={tasksRef}><BusinessSection title="확인할 일" action={<div className="row">{deskAttention!=null&&<span className="business-badge warning">{deskAttention}건</span>}<button type="button" className="fleet-dashboard-link" onClick={onWeeklyReport||onLive}>더보기 <Icon name="chevron-right" size={14}/></button></div>}>
        <div hidden><FleetIncompleteTrips devices={devices} onReport={onReport} now={now} onSummary={setWeekly}/></div>
        <div className="attention-list">
          <button type="button" className="attention-item" onClick={onWeeklyReport||onLive}><span className="attention-icon"><Icon name="route" size={18}/></span><span><div className="attention-item-title">운행 기록 확인</div><div className="attention-item-desc">운전자·운행 목적을 확인해 주세요.</div></span><span className="business-badge warning">{summary?.complete?summary.missing:'—'}건</span></button>
          {onExpenses&&<button type="button" className="attention-item" onClick={onExpenses}><span className="attention-icon is-blue"><Icon name="wallet" size={18}/></span><span><div className="attention-item-title">지출 승인 요청</div><div className="attention-item-desc">증빙을 확인하고 요청을 처리하세요.</div></span><span className="business-badge info">{pending==null?'—':pending}건</span></button>}
          <button type="button" className="attention-item" onClick={onLive}><span className="attention-icon"><Icon name="wifi" size={18}/></span><span><div className="attention-item-title">단말기 수신 확인</div><div className="attention-item-desc">마지막 수신 시각과 연결을 확인하세요.</div></span><span className="business-badge warning">{signalCount}대</span></button>
        </div>
        {expenses.error&&<BusinessError onRetry={expenses.refetch}>승인 대기 건수를 불러오지 못했습니다.</BusinessError>}
      </BusinessSection></div>
      :<div className="fleet-dashboard-tasks" tabIndex={-1} ref={tasksRef}><BusinessSection title="확인할 일" action={attention>0&&<span className="business-badge warning fleet-dashboard-task-count">{attention}건</span>}>
        <FleetIncompleteTrips devices={devices} onReport={onReport} now={now} onSummary={setWeekly}/>
        {onExpenses&&<BusinessTask icon="coin" title="지출 승인 요청" description="이번 달 승인 대기" label={pending==null?'—':pending+'건'} action="지출 보기" onClick={onExpenses}/>}
        {expenses.error&&<BusinessError onRetry={expenses.refetch}>승인 대기 건수를 불러오지 못했습니다.</BusinessError>}
        {tasks.length>0&&<details className="fleet-dashboard-issues"><summary><Icon name="antenna" size={18}/><span>단말기·점검 확인</span><b>{tasks.length}건</b></summary>{tasks.map(t=><BusinessTask key={t.id} title={corporateVehicleName(t.device)+' · '+terminalName(t.device)} description={t.description+(t.id.startsWith('signal-')&&t.device.last_seen_at?' · 마지막 통신 '+ageString(t.device.last_seen_at):'')+(t.id.startsWith('battery-')&&(t.device.last_battery_at||t.device.last_seen_at)?' · '+kstDateTime(t.device.last_battery_at||t.device.last_seen_at):'')} label={t.label} tone={t.tone} action="차량 확인" onClick={()=>openVehicle(t.device)}/>)}</details>}
        {missing.length>0&&<BusinessTask icon="wrench" title="점검 일정 미등록" description="정비·보험·검사" label={missing.length+'대'} action="미등록 차량 보기" onClick={onMissingSchedules}/>}
      </BusinessSection></div>}
    </div>
    {reservations.error&&<BusinessError onRetry={reservations.refetch}>오늘 예약 수를 불러오지 못했습니다.</BusinessError>}
    <div className="fleet-dashboard-grid fleet-dashboard-bottom">
      <BusinessSection title="차량 목록" description={'등록 차량 '+devices.length+'대'+(devices.length>3?' 중 3대 미리보기':deskOverview?' 미리보기':'')} action={onVehicles&&<button type="button" className="fleet-dashboard-link" onClick={onVehicles}>더보기 <Icon name="chevron-right" size={14}/></button>}>
        <div className="fleet-dashboard-vehicles"><div className="fleet-dashboard-row-head" aria-hidden="true"><span>차량</span><span>담당자</span><span>운영 상태</span><span>이번 달 거리</span><span>단말 수신</span></div>{devices.slice(0,3).map(d=>{
          const month=stats.byVehicle?.get(d.id)?.total_distance_m;
          return <button type="button" key={d.id} onClick={()=>openVehicle(d)}>
            <span className="fleet-dashboard-vehicle-name"><i><CarImage vehicleId={d.fleet_vehicle_id} deviceId={d.source_device_id||d.id} version={d.car_image_url} fallback={<Icon name="car" size={20}/>}/></i><span><strong>{d.car_plate||corporateVehicleName(d)}</strong><small>{d.car_model||terminalName(d)}</small></span></span>
            <span className="fleet-dashboard-manager">{staff.find(s=>s.id===d.asset?.manager_staff_id)?.name||'미지정'}<small>{d.department||''}</small></span>
            <span>{deskOverview?(([label,tone])=><small className={'fleet-dashboard-availability business-badge '+tone}>{label}</small>)(d.enabled===false?['점검 중','warning']:d.has_primary_terminal&&['active','gps_loss','low_batt','critical_batt','overcharge'].includes(classifyDevice(d,undefined,now).id)?['운행 중','good']:['대기','']):<small className={'fleet-dashboard-availability business-badge '+(d.enabled===false?'':'good')}>{d.enabled===false?'사용 정지':'사용 가능'}</small>}</span>
            <span className="fleet-dashboard-km">{Number.isFinite(month)?<>{(month/1000).toLocaleString('ko-KR',{maximumFractionDigits:1})}{deskOverview?<span className="caption"> km</span>:' km'}</>:'—'}</span>
            <span className="fleet-dashboard-reception">{deskOverview?<small className={'business-badge '+(d.has_primary_terminal&&['active','sleeping'].includes(classifyDevice(d,undefined,now).id)?'good':'warning')}>{!d.has_primary_terminal?'미연결':['active','sleeping'].includes(classifyDevice(d,undefined,now).id)?'정상 수신':'수신 확인'}</small>:<small className={'business-badge '+(!d.has_primary_terminal||d.terminal_status_label?'':receptionToneOf(classifyDevice(d,undefined,now)))}>{!d.has_primary_terminal?'미연결':d.terminal_status_label||classifyDevice(d,undefined,now).label}</small>}</span>
          </button>;
        })}</div>
        {!devices.length&&<BusinessEmpty compact title="등록된 차량이 없습니다."/>}
        {!!devices.length&&!deskOverview&&<button type="button" className="fleet-dashboard-search-toggle" aria-expanded={showVehicles} onClick={()=>setShowVehicles(v=>!v)}><Icon name="search" size={15}/>{showVehicles?'차량 검색 닫기':'차량 검색·위치 조회'}</button>}
      </BusinessSection>
      <BusinessSection title="최근 7일 운행" description={deskOverview?'완료 운행의 일별 주행거리':'운행기록부 반영 거리'} action={onWeeklyReport&&<button type="button" className="fleet-dashboard-link" onClick={onWeeklyReport}>{deskOverview?'더보기':'리포트'} <Icon name="chevron-right" size={14}/></button>}>
        {summary?.checked>0?<FleetWeekChart days={days} distances={summary.days}/>:<BusinessEmpty compact title={!summary?.finished?'운행 조회 중…':!devices.length?'등록된 차량이 없습니다.':'운행 기록을 조회하지 못했습니다.'}/>}
        {summary?.checked>0&&!summary.complete&&<p className="fleet-dashboard-partial">조회된 {summary.checked}/{summary.total}대 기준</p>}
        {!deskOverview&&<div className="fleet-dashboard-totals"><span>오늘 운행거리{stats.partial?' (일부)':''}<b>{distanceLabel}</b></span><span>점검 예정<b>{maintenance.length}건</b></span><span>사용 가능<b>{available}대</b></span></div>}
        {stats.error&&<BusinessError onRetry={stats.refetch}>운행 통계를 불러오지 못했습니다.</BusinessError>}
      </BusinessSection>
    </div>
    {showVehicles&&<BusinessVehicles separateTerminal localMap devices={devices} onMap={onMap} onDetail={onReport} detailLabel="운행 리포트"/>}
  </div>;
}
function FleetWeekChart({days,distances}){
  const values=days.map(day=>(distances[day]||0)/1000), max=Math.max(1,...values);
  // Desktop design: the shared line chart with a y axis and point tooltips instead of per-point labels.
  if(!useCorporatePhone()&&hideOutsideMockup)return <MockupLineChart points={days.map((day,i)=>({day,value:values[i]}))} unit="km" format={v=>v.toLocaleString('ko-KR',{maximumFractionDigits:1})} height={150} label="최근 7일 운행"/>;
  const points=values.map((km,i)=>[12+i*49,68-km/max*52]);
  const line=points.map(p=>p.join(',')).join(' ');
  return <div className="fleet-week-chart"><svg viewBox="0 0 318 80" preserveAspectRatio="none" aria-hidden="true">
    {[16,42,68].map(y=><line key={y} x1="6" y1={y} x2="312" y2={y} stroke="var(--border)" strokeDasharray="3 4"/>)}
    <polygon points={'12,68 '+line+' 306,68'} fill="var(--primary)" opacity=".08"/>
    <polyline points={line} fill="none" stroke="var(--primary)" strokeWidth="2" vectorEffect="non-scaling-stroke"/>
    {points.map(([x,y])=><circle key={x} cx={x} cy={y} r="2.5" fill="var(--primary)"/>)}
  </svg><ol>{days.map((day,i)=><li key={day}><strong>{values[i].toLocaleString('ko-KR',{maximumFractionDigits:1})}<small> km</small></strong><time dateTime={day}>{day.slice(5).replace('-','.')}</time></li>)}</ol></div>;
}

// ════════════════════════════════════════════════════════
// 운행 리포트 — 차량별 운행기록과 내보내기.
// ════════════════════════════════════════════════════════
const tripViews = [
  {id:'running',label:'운행 중',matches:t=>t.quality?.status==='running'},
  {id:'ended',label:'종료',matches:t=>Boolean(t.ended_at)},
  {id:'review',label:'확인 필요',matches:t=>!reportIncluded(t)&&t.quality?.status!=='running'},
  {id:'confirmed',label:'기록 확정',matches:reportIncluded},
];
function TripLogTab({ devices, initialDeviceId, initialFilter }) {
  const [opened,setOpened]=useState(initialDeviceId!=null?{id:initialDeviceId,filter:initialFilter}:null);
  if(!opened) return <FleetTripLog devices={devices} onOpenVehicle={(id,filter)=>setOpened({id,filter})}/>;
  return <><button type="button" className="fleet-trip-log-back no-print" onClick={()=>setOpened(null)}><Icon name="prev" size={14}/>전체 운행</button>
    <ReportTab key={opened.id} devices={devices} initialDeviceId={opened.id} initialFilter={opened.filter}/></>;
}
function ReportTab({ devices, initialDeviceId, initialFilter }) {
  const access=useFleetAccess();
  const mobile=useCorporatePhone();
  const [toolsOpen,setToolsOpen]=useState(false);
  const showTools=!mobile||toolsOpen;
  const [selected,setSelected]=useState(new Set()),[assignment,setAssignment]=useState(null),[showRules,setShowRules]=useState(false),[showHistory,setShowHistory]=useState(false),[assignmentStatus,setAssignmentStatus]=useState('');
  const today = businessDate();
  const monthAgo = `${today.slice(0, 7)}-01`;

  const [deviceId, setDeviceId] = useState(initialDeviceId || devices[0]?.id || null);
  // hard refresh 시 useState 초기값은 첫 렌더의 devices(=[])를 캡처해서 deviceId=null 로 박힘.
  // devices 가 나중에 도착하면 deviceId 자동 채움 (사용자가 직접 안 골라도 첫 디바이스 선택).
  useEffect(() => {
    if (deviceId == null && devices.length > 0) setDeviceId(devices[0].id);
  }, [devices, deviceId]);
  const [from, setFrom] = useState(initialFilter?.from||monthAgo);
  const [to,   setTo]   = useState(initialFilter?.to||today);
  const [datesOpen,setDatesOpen]=useState(false);
  const [onlyIncomplete,setOnlyIncomplete]=useState(Boolean(initialFilter?.incomplete));
  const [tripView,setTripView]=useState(initialFilter?.confirmed?'confirmed':'all');
  const [trips, setTrips] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [evidence,setEvidence]=useState(null),[correction,setCorrection]=useState(null),[qualityHistory,setQualityHistory]=useState(false),[onlyReview,setOnlyReview]=useState(false);
  const [editing, setEditing] = useState(null);   // 편집 중인 trip {trip, deviceId}
  const [xlsxRequest, setXlsxRequest] = useState(null);
  const [printing, setPrinting] = useState(false);
  const printRequest = useRef(false);
  // 추가 필터 — 운전자별 / 용무별 / 최소 운행 시간(시간). all/'' 이면 미적용. AND.
  const [driverFilter,  setDriverFilter]  = useState(initialFilter?.driver||'all');
  const [purposeFilter, setPurposeFilter] = useState('all');
  const [minHours,      setMinHours]      = useState('');
  const [vehicleSearch,setVehicleSearch]=useState('');
  const [filterDraft,setFilterDraft]=useState(null);
  const draftHoursInvalid=filterDraft&&filterDraft.minHours!==''&&(!Number.isFinite(Number(filterDraft.minHours))||Number(filterDraft.minHours)<0);
  const visibleVehicles=devices.filter(d=>`${reportVehicleLabel(d)} ${d.department||''}`.toLocaleLowerCase().includes(vehicleSearch.trim().toLocaleLowerCase()));
  const openFilters=()=>setFilterDraft({driver:driverFilter,purpose:purposeFilter,minHours,onlyIncomplete,onlyReview});
  const applyFilters=()=>{if(draftHoursInvalid)return;setDriverFilter(filterDraft.driver);setPurposeFilter(filterDraft.purpose);setMinHours(filterDraft.minHours);setOnlyIncomplete(filterDraft.onlyIncomplete);setOnlyReview(filterDraft.onlyReview);setFilterDraft(null);};

  const device = devices.find(d => d.id === deviceId);
  // 과거 기록 조회에는 비활성 운전자도 포함한다. 신규 배정은 별도 권한/활성 검증을 유지한다.
  const { data: staffAll } = useStaff();
  const staff = staffAll || [];
  const { data: info } = useCorporateInfo();
  const periodError = reportPeriodError(from, to);

  const loadId = useRef(0);
  async function load() {
    if (!deviceId) return;
    const id = ++loadId.current;
    setSelected(new Set());setAssignment(null);setEvidence(null);setCorrection(null);
    if (periodError) { setTrips(null); setLoading(false); setError(periodError); return; }
    setLoading(true); setError(null); setTrips(null);
    try {
      const t = await api.listFleetVehicleTrips(deviceId, { from, to });
      if (id === loadId.current) setTrips(t || []);
    } catch {
      if (id === loadId.current) setError('운행기록을 불러오지 못했습니다. 다시 시도해 주세요.');
    } finally { if (id === loadId.current) setLoading(false); }
  }
  useEffect(() => { load(); return () => { loadId.current++; }; }, [deviceId, from, to]);  // eslint-disable-line

  // 추가 필터 적용된 trip 목록 — 운전자/용무/최소시간 AND.
  const currentTripView=tripViews.find(v=>v.id===tripView);
  const companyPurposes=new Map((trips||[]).filter(t=>t.annotation?.company_purpose_id!=null).map(t=>['company:'+t.annotation.company_purpose_id,t.annotation.company_purpose_name]));
  const selectTrips=React.useCallback(rows=>filterTrips(rows,{driver:driverFilter,purpose:purposeFilter,minHours})
    .filter(t=>(!onlyReview||!reportIncluded(t))&&(!onlyIncomplete||tripNeedsDetails(t))&&(!currentTripView||currentTripView.matches(t))),
  [driverFilter,purposeFilter,minHours,onlyReview,onlyIncomplete,currentTripView]);
  const filteredTrips = useMemo(()=>trips?selectTrips(trips):null,[trips,selectTrips]);
  useEffect(()=>{setSelected(new Set());setAssignment(null);setAssignmentStatus('');},[deviceId,from,to,selectTrips]);
  const subjectScoped=Boolean(trips?.subjectScope);
  const eligible=subjectScoped||access.write_trips===false?[]:(filteredTrips||[]).filter(t=>canAssignTrip(t,access));
  const chosen=eligible.filter(t=>selected.has(tripAssignmentKey(t)));
  const toggleTrip=t=>{setAssignmentStatus('');setSelected(previous=>{const next=new Set(previous),key=tripAssignmentKey(t);if(next.has(key))next.delete(key);else if(next.size<100)next.add(key);return next;});};
  const completeness = trips ? tripCompleteness(trips) : null;
  const exportData = filteredTrips ? tripReport(filteredTrips, {device,info,from,to,
    filterText: `운전자: ${driverFilter==='all'?'전체':driverFilter==='unassigned'?'미지정':staff.find(s=>String(s.id)===driverFilter)?.name || driverFilter.replace(/^name:/,'')} · 용무: ${companyPurposes.get(purposeFilter) || purposeLabel[purposeFilter] || '전체'} · 최소 운행: ${Number(minHours) || 0}시간${onlyReview?' · 미확정만':''}${onlyIncomplete?' · 미작성만':''}${currentTripView?' · '+currentTripView.label:''}`,
  }) : null;
  const csvData = filteredTrips ? ntsTripReport(filteredTrips, {device,info,from,to,
    filtered: tripView!=='all' || onlyIncomplete || onlyReview || driverFilter !== 'all' || purposeFilter !== 'all' || Number(minHours) > 0,
  }) : null;

  const exportConditions=JSON.stringify([deviceId,from,to,driverFilter,purposeFilter,minHours,onlyReview,onlyIncomplete,tripView]);
  const exportConditionsRef=useRef(exportConditions);
  exportConditionsRef.current=exportConditions;
  async function freshTrips(format) {
    const generation=loadId.current;
    const fresh=await api.listFleetVehicleTrips(deviceId,{from,to,download:format});
    if(generation!==loadId.current || exportConditions!==exportConditionsRef.current) throw new Error('조회 조건이 바뀌었습니다. 다시 내려받아 주세요.');
    setTrips(fresh||[]);
    return fresh||[];
  }
  async function prepareExport(format) {
    const fresh=await freshTrips(format);
    const selected=selectTrips(fresh);
    return subjectReport(ntsTripReport(selected,{device,info,from,to,filtered:filterActive}),fresh.subjectScope);
  }
  async function printFresh() {
    if (printRequest.current) return;
    printRequest.current = true;
    setPrinting(true);
    const generation=loadId.current;
    try { await freshTrips('print'); await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))); if(generation!==loadId.current || exportConditions!==exportConditionsRef.current) return; window.print(); }
    catch(e) {
      if(generation!==loadId.current || exportConditions!==exportConditionsRef.current) return;
      setError(e.message);setTrips(null);
    }
    finally { printRequest.current = false; setPrinting(false); }
  }
  // 일자별 누적거리 — 화면에 보이는(필터된) 운행 기준으로 계산.
  const dailyDistance = useMemo(() => {
    if (!filteredTrips) return new Map();
    const m = new Map();
    for (const t of filteredTrips) {
      const d = kstDate(t.started_at);
      if (reportIncluded(t)) m.set(d, (m.get(d) || 0) + t.distance_m);
    }
    return m;
  }, [filteredTrips]);

  const filterActive = tripView!=='all' || onlyIncomplete || onlyReview || driverFilter !== 'all' || purposeFilter !== 'all' || (parseFloat(minHours) > 0);
  function resetFilters() {
    setOnlyReview(false); setOnlyIncomplete(false); setTripView('all');
    setDriverFilter('all');
    setPurposeFilter('all');
    setMinHours('');
  }

  return (
    <div className="fleet-directory-layout corporate-report-layout">
    <aside className="fleet-directory-sidebar corporate-report-vehicle-sidebar no-print" aria-label="운행 차량 목록">
     <div className="fleet-directory-heading"><h2>운행 차량</h2><span className="fleet-directory-group-count">{devices.length}대</span></div>
     <label className="corporate-report-vehicle-search"><Icon name="search" size={16}/><input type="search" aria-label="운행 차량 검색" placeholder="차량명·번호 검색" value={vehicleSearch} onChange={e=>setVehicleSearch(e.target.value)}/></label>
     <div className="corporate-report-vehicle-list">{visibleVehicles.map(d=><button className="corporate-report-vehicle-option" type="button" key={d.id} aria-label={`${reportVehicleLabel(d)} 운행 조회`} aria-pressed={d.id===deviceId} onClick={()=>setDeviceId(d.id)}><strong>{d.license_plate||d.car_plate||'번호 미등록'}</strong><span>{d.vehicle_name||d.asset?.name||d.car_model||d.display_name||`차량 ${d.id}`}</span>{d.department&&<small>{d.department}</small>}</button>)}</div>
     {!visibleVehicles.length&&<p className="business-note">{devices.length?'검색된 차량이 없습니다.':'등록된 차량이 없습니다.'}</p>}
     <div className="fleet-directory-group-footer"><BusinessButton icon="download" disabled={!devices.length||!!periodError} onClick={()=>setXlsxRequest({month:from.slice(0,7),vehicleIds:devices.map(d=>d.id),from,to})}>전체 차량 엑셀</BusinessButton></div>
    </aside>
    <div className="fleet-directory-content">
    <div className="corporate-report-page" data-tools-open={toolsOpen}>
      <div className="corporate-report-heading no-print"><h2>{device?`${reportVehicleLabel(device)} 운행기록`:'운행기록부'}</h2><span>차량별 조회</span></div>
      <FleetRecordMetrics label="조회된 운행 요약" items={[
        {name:'조회된 운행',value:filteredTrips?.length,unit:'건',icon:'route'},
        {name:'운행 중',value:filteredTrips?.filter(t=>t.quality?.status==='running').length,unit:'건',tone:'blue'},
        {name:'확인 필요',value:filteredTrips?.filter(t=>!reportIncluded(t)&&t.quality?.status!=='running').length,unit:'건',tone:'amber'},
        {name:'확정 주행거리',value:filteredTrips?tripDistance([...dailyDistance.values()].reduce((sum,meters)=>sum+meters,0)):null,unit:'km',tone:'green'},
      ]}/>
      <div className="corporate-report-controls no-print">
      <div className="corporate-report-control-row">
        <select aria-label="운행 차량" value={deviceId || ''} onChange={e => setDeviceId(parseInt(e.target.value, 10) || null)}
          className="corporate-report-vehicle">
          {devices.map(d => (
            <option key={d.id} value={d.id}>
              {reportVehicleLabel(d)}
            </option>
          ))}
        </select>
        {mobile&&<button type="button" className="corporate-trip-period" aria-label="운행 조회 기간 변경" aria-expanded={datesOpen} onClick={()=>setDatesOpen(!datesOpen)}>
          <Icon name="clock" size={18}/><span>{from||'시작일'} ~ {to||'종료일'}</span><Icon name={datesOpen?'chevron-up':'chevron-down'} size={16}/>
        </button>}
        <div className="corporate-report-date-range" data-expanded={datesOpen}>
          <label><span>시작일</span><input aria-label="운행 조회 시작일" type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
          <span aria-hidden="true">~</span>
          <label><span>종료일</span><input aria-label="운행 조회 종료일" type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        </div>
        <BusinessButton icon="filter" aria-haspopup="dialog" aria-expanded={!!filterDraft} onClick={openFilters}>필터{filterActive && <span className="corporate-report-dot" aria-label="필터 적용 중"/>}</BusinessButton>
        {mobile&&<BusinessButton icon="settings" aria-label="운행 도구" aria-expanded={toolsOpen} onClick={()=>setToolsOpen(!toolsOpen)}>도구</BusinessButton>}
        {filterDraft&&<Modal open title="운행 필터" size={640} onClose={()=>setFilterDraft(null)} footer={<div className="corporate-report-filter-footer"><BusinessButton onClick={()=>setFilterDraft({driver:'all',purpose:'all',minHours:'',onlyIncomplete:false,onlyReview:false})}>초기화</BusinessButton><div><BusinessButton onClick={()=>setFilterDraft(null)}>취소</BusinessButton><BusinessButton primary disabled={draftHoursInvalid} onClick={applyFilters}>적용</BusinessButton></div></div>}>
          <div className="corporate-report-filter-dialog">
            <label>운전자<select aria-label="운전자 필터" value={filterDraft.driver} onChange={e => setFilterDraft(d=>({...d,driver:e.target.value}))}>
              <option value="all">운전자 전체</option><option value="unassigned">미지정</option>
              {filterDraft.driver.startsWith('name:')&&<option value={filterDraft.driver}>{filterDraft.driver.slice(5)}</option>}
              {staff.map(s => <option key={s.id} value={String(s.id)}>{s.name}{s.active === false ? ' (비활성)' : ''}</option>)}
            </select></label>
            <label>용무<select aria-label="용무 필터" value={filterDraft.purpose} onChange={e => setFilterDraft(d=>({...d,purpose:e.target.value}))}>
              <option value="all">용무 전체</option><option value="commute">출퇴근</option><option value="business">업무</option><option value="other">기타</option><option value="unspecified">미지정</option>
              {companyPurposes.size>0&&<optgroup label="회사 운행 목적">{Array.from(companyPurposes,([id,name])=><option key={id} value={id}>{name}</option>)}</optgroup>}
            </select></label>
            <label>최소 운행시간 (시간)<input aria-label="최소 운행시간" type="number" placeholder="제한 없음" value={filterDraft.minHours} step="0.5" min="0" onChange={e => setFilterDraft(d=>({...d,minHours:e.target.value}))}/></label>
            {draftHoursInvalid&&<p role="alert">최소 운행시간은 0 이상의 숫자로 입력해 주세요.</p>}
            <div className="corporate-report-filter-checks"><label className="corporate-report-check"><input type="checkbox" checked={filterDraft.onlyIncomplete} onChange={e=>setFilterDraft(d=>({...d,onlyIncomplete:e.target.checked}))}/>미작성만 보기</label><label className="corporate-report-check"><input type="checkbox" checked={filterDraft.onlyReview} onChange={e=>setFilterDraft(d=>({...d,onlyReview:e.target.checked}))}/>미확정만 보기</label></div>
            <small className="corporate-report-filter-counts">조회 기간 전체 · 용무 미지정 {completeness?.missingPurpose ?? '—'}건 / 운전자 미지정 {completeness?.missingDriver ?? '—'}건</small>
            <div className="corporate-report-filter-shortcuts"><BusinessButton disabled={!completeness?.missingPurpose} onClick={() => setFilterDraft({driver:'all',purpose:'unspecified',minHours:'',onlyIncomplete:false,onlyReview:false})}>용무 미지정</BusinessButton>
            <BusinessButton disabled={!completeness?.missingDriver} onClick={() => setFilterDraft({driver:'unassigned',purpose:'all',minHours:'',onlyIncomplete:false,onlyReview:false})}>운전자 미지정</BusinessButton></div>
          </div>
        </Modal>}
        {showTools&&<><button onClick={load} style={st.btnGhost} disabled={loading || !!periodError}>
          <Icon name="refresh" size={12} /> 새로고침
        </button>
        <details className="corporate-report-menu corporate-report-download">
        <summary><Icon name="download" size={13}/> 다운로드</summary>
        <div className="corporate-report-menu-body">
        <ExportButtons report={exportData} csvReport={csvData} pdfReport={csvData} prepareExport={prepareExport} csvLabel="운행기록부 CSV" pdfLabel="인쇄용 PDF" disabled={loading || !!error || !!periodError || !deviceId} />
        <BusinessButton icon="download" disabled={loading || !!error || !!periodError || !device}
          onClick={() => setXlsxRequest({month:from.slice(0,7),vehicleIds:[deviceId],from,to})}>월간 엑셀(XLSX)</BusinessButton>
          <BusinessButton icon="download" disabled={!devices.length||!!periodError} onClick={()=>setXlsxRequest({month:from.slice(0,7),vehicleIds:devices.map(d=>d.id),from,to})}>전체 차량 월간 엑셀</BusinessButton>
        <button onClick={printFresh} style={st.btnGhost} disabled={printing || loading || !!error || !!periodError || !trips}>
          <Icon name="share" size={12} /> {printing ? '인쇄 준비 중...' : '화면 인쇄'}
        </button>
        </div>
        </details></>}
      </div>
      <div className="corporate-report-control-row">
        <div className="corporate-report-status-tabs" aria-label="운행 작성 상태">
          <button className="corporate-report-status-option" type="button" aria-pressed={!filterActive} onClick={resetFilters}>전체 ({trips?.length ?? '—'})</button>
          {tripViews.map(v=><button key={v.id} className="corporate-report-status-option" type="button" aria-pressed={tripView===v.id} onClick={()=>{setOnlyReview(false);setOnlyIncomplete(false);setTripView(v.id);}}>{v.label} ({trips?.filter(v.matches).length??'—'})</button>)}
          <button className="corporate-report-status-option" type="button" aria-pressed={onlyIncomplete} onClick={()=>{resetFilters();setOnlyIncomplete(true);}}>미작성 ({trips?.filter(tripNeedsDetails).length ?? '—'})</button>
        </div>
        {showTools&&<div className="corporate-report-counts" aria-label="조회 기간 전체 작성 현황">
          <span>기간 전체</span>
          <span>작성률 <strong>{completeness?.percent ?? '—'}%</strong></span>
          <span>입력 주유비 <strong>{completeness?.fuelEntries ? `${completeness.fuelCost.toLocaleString()}원` : '—'}</strong></span>
        </div>}
        <span className="corporate-report-result-count">{filteredTrips ? (mobile?`총 ${filteredTrips.length}건`:`${filteredTrips.length}건 표시`) : ''}</span>
      </div>
      {showTools&&<TripQualitySummary trips={filteredTrips} loading={loading} error={error} vehicleSelected={Boolean(device)} onlyReview={onlyReview} onReviewChange={setOnlyReview}/>}
      </div>
      {subjectScoped && <p className="business-note" role="status">{subjectScopeNote}</p>}
      {showTools&&access.write_trips!==false&&<div className="fleet-assignment-toolbar corporate-report-assignment no-print">
        <span role="status">{assignmentStatus || `${chosen.length}건 선택 · 한 번에 100건까지`}</span>
        <details className="corporate-report-menu corporate-report-management">
        <summary><Icon name="wrench" size={13}/> 운행 관리</summary>
        <div className="corporate-report-menu-body">
        <BusinessButton disabled={!chosen.length||loading} onClick={()=>setAssignment('manual')}>일괄 지정</BusinessButton>
        <BusinessButton disabled={!chosen.length||loading} onClick={()=>setAssignment('suggest')}>예약·규칙 적용</BusinessButton>
        <BusinessButton disabled={!device} onClick={()=>setShowRules(true)}>기본 운전자·반복 규칙</BusinessButton>
        {access.manage_reports&&<><BusinessButton disabled={chosen.length!==2||chosen.some(t=>t.correction_id)} onClick={()=>setCorrection(chosen)}>선택한 2건 병합</BusinessButton><BusinessButton disabled={!device||subjectScoped} onClick={()=>setQualityHistory(true)}>보정 이력</BusinessButton><BusinessButton disabled={!device||subjectScoped} onClick={()=>setShowHistory(true)}>지정 이력</BusinessButton></>}
        </div>
        </details>
      </div>}
      {assignment&&<TripAssignmentModal mode={assignment} trips={chosen} vehicle={device} from={from} to={to} staff={staffAll||[]} onClose={()=>setAssignment(null)} onSaved={result=>{setAssignment(null);setAssignmentStatus(`${result.applied}건 변경 · ${result.skipped}건 제외`);load();}}/>}
      {showRules&&device&&<TripRulesModal vehicle={device} staff={staffAll||[]} onClose={()=>setShowRules(false)}/>}
      {showHistory&&device&&<TripAssignmentHistory vehicle={device} onClose={()=>setShowHistory(false)}/>}
      {evidence&&<TripEvidence vehicle={device} trip={evidence} from={from} to={to} canManage={access.manage_reports&&access.write_trips!==false} onClose={()=>setEvidence(null)} onCorrect={()=>{setCorrection([evidence]);setEvidence(null);}}/>}
      {correction&&<TripCorrection vehicle={device} trips={correction} from={from} to={to} onClose={()=>setCorrection(null)} onSaved={()=>{setCorrection(null);load();}}/>}
      {qualityHistory&&device&&<TripCorrectionHistory vehicle={device} onClose={()=>setQualityHistory(false)} onRestored={load}/>}
      {/* 리포트 본문 — 인쇄 영역 */}
      <div className="report-area" style={st.reportArea}>
        <ReportHeader info={info} device={device} from={from} to={to} />
        {loading && <div style={st.muted}>운행 데이터 로딩 중...</div>}
        {error && <BusinessError onRetry={periodError ? undefined : load}>{error}</BusinessError>}
        {trips && trips.length === 0 && !loading && (
          <div style={st.muted}>이 기간에 운행 기록이 없습니다.</div>
        )}
        {trips && trips.length > 0 && filteredTrips.length === 0 && (
          <div style={st.muted}>필터 조건에 맞는 운행이 없습니다.</div>
        )}
        {filteredTrips && filteredTrips.length > 0 && (
          <TripsTable trips={filteredTrips} mobile={mobile} selectionOpen={toolsOpen} vehicleLabel={reportVehicleLabel(device)} dailyDistance={dailyDistance} selected={selected} onSelect={toggleTrip} eligible={eligible} onSelectAll={()=>{setAssignmentStatus('');setSelected(chosen.length===Math.min(100,eligible.length)?new Set():new Set(eligible.slice(0,100).map(tripAssignmentKey)));}}
            onEvidence={subjectScoped?undefined:setEvidence} onEdit={subjectScoped||access.write_trips===false?undefined:(t) => setEditing(t)} />
        )}
      </div>

      {editing && (
        <TripEditorModal trip={editing} staff={(staffAll||[]).filter(s=>staffCanDrive(s,device)||s.id===editing.annotation?.driver_staff_id)} deviceId={deviceId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
      {xlsxRequest && <DownloadDialog ym={xlsxRequest.month} devices={devices} initialVehicleIds={xlsxRequest.vehicleIds}
        sourcePeriod={xlsxRequest} onClose={() => setXlsxRequest(null)} />}
    </div>
    </div>
    </div>
  );
}

function ReportHeader({ info, device, from, to }) {
  const company = info?.company_name || '—';
  const biznum  = info?.business_number || '—';
  const dev     = reportVehicleLabel(device);
  return (
    <div className="corporate-report-print-heading" style={st.reportHead}>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>법인 차량 운행 일지</div>
      <table style={st.headerTable}>
        <tbody>
          <tr>
            <th style={st.th}>회사명</th><td style={st.td}>{company}</td>
            <th style={st.th}>사업자번호</th><td style={st.td}>{biznum}</td>
          </tr>
          <tr>
            <th style={st.th}>차량</th><td style={st.td}>{dev}</td>
            <th style={st.th}>차량번호</th><td style={st.td}>{device?.license_plate || device?.car_plate || '—'}</td>
          </tr>
          <tr>
            <th style={st.th}>기간</th>
            <td style={st.td} colSpan={3}>{from} ~ {to}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TripsTable({ trips, mobile, selectionOpen, vehicleLabel, dailyDistance, onEdit, onEvidence, selected, onSelect, eligible, onSelectAll }) {
  const byDay=useMemo(()=>{
    const groups=new Map();
    for(const trip of trips){
      const day=kstDate(trip.started_at);
      if(!groups.has(day))groups.set(day,[]);
      groups.get(day).push(trip);
    }
    return groups;
  },[trips]);
  const dayKm=day=>dailyDistance.has(day)?`${tripDistance(dailyDistance.get(day))} km`:'—';
  const row=(t,day,card=false)=><TripRow key={tripAssignmentKey(t)} t={t} card={card} selectionOpen={selectionOpen} vehicleLabel={vehicleLabel}
    selected={selected.has(tripAssignmentKey(t))} onSelect={()=>onSelect(t)} selectionFull={selected.size>=100}
    date={day} dailyKm={byDay.get(day)[0]===t?dayKm(day):''}
    onEvidence={onEvidence?()=>onEvidence(t):undefined} onEdit={onEdit?()=>onEdit(t):undefined}/>;
  const selectAll=<input className="fleet-trip-select" type="checkbox" aria-label="현재 운행 최대 100건 선택"
    checked={eligible.length>0&&selected.size===Math.min(100,eligible.length)} disabled={!eligible.length} onChange={onSelectAll}/>;
  return (
    <>
    {mobile&&<section className="corporate-trip-days no-print" aria-label="운행 내역">
      {selectionOpen&&<label className="trip-mobile-select-all">{selectAll} 전체 선택</label>}
      {[...byDay].map(([day,items])=><section key={day} className="trip-mobile-day">
        <header><h3><time dateTime={day}>{day}</time></h3><span>일별 누적 <strong>{dayKm(day)}</strong></span></header>
        {items.map(t=>row(t,day,true))}
      </section>)}
    </section>}
    <div className="corporate-trip-table-scroll" role="region" aria-label="운행기록 목록 · 좌우 스크롤" tabIndex={0} style={st.tripsTableScroll}>
    <table className="corporate-trip-table" style={st.tripsTable}>
      <thead>
        <tr>
          <th style={st.th} className="no-print">{selectAll}</th>
          <th style={st.th}>날짜</th>
          <th style={st.th}>시간</th><th style={st.th}>기록 상태</th>
          <th style={st.th}>용무</th>
          <th style={st.th}>출발지</th>
          <th style={st.th}>도착지</th>
          <th style={st.th} className="trip-number">주행거리</th>
          <th style={st.th} className="trip-number">일별 누적</th>
          <th style={st.th}>유류</th>
          <th style={st.th}>운전자</th>
          <th style={{ ...st.th, width: 36 }} className="no-print">작업</th>
        </tr>
      </thead>
      <tbody>
        {trips.map(t=>row(t,kstDate(t.started_at)))}
      </tbody>
    </table>
    </div>
    </>
  );
}

function TripRow({ t, date, dailyKm, onEdit, onEvidence, selected, onSelect, selectionFull, card, selectionOpen, vehicleLabel }) {
  const access=useFleetAccess();
  const ann = t.annotation || {};
  const purpose = ann.purpose || 'unspecified';
  const km = tripDistance(t.distance_m);
  const time = tripTimeRange(t);
  const checkbox=<input className="fleet-trip-select" type="checkbox" aria-label={`${date} ${time} 운행 선택`} checked={selected} disabled={!!t.quality?.subject_mapping_id||!canAssignTrip(t,access)||(!selected&&selectionFull)} onChange={onSelect}/>;
  const editDisabled=!onEdit||t.allocation_status==='boundary_review'||(!access.manage_reports&&ann.driver_staff_id!=null&&ann.driver_staff_id!==access.staff_id);
  const status=<span className="fleet-quality-status" data-state={t.quality?.status}>{qualityLabel(t)}{t.correction_id?' · 보정':''}</span>;
  if(card){
    const minutes=t.duration_min;
    const fuel=[ann.fuel_liters!=null&&`${ann.fuel_liters}L`,ann.fuel_cost!=null&&`${ann.fuel_cost.toLocaleString()}원`].filter(Boolean).join(' / ');
    return <article className="trip-mobile-card">
      <header><div><strong>{vehicleLabel}</strong><span>{ann.driver_name||'운전자 미지정'}</span></div>{selectionOpen&&<label>{checkbox}</label>}</header>
      <ol className="trip-mobile-route">
        {[['출발',t.started_at,t.start_address,t.start_sites,t.start_lat,t.start_lng],['도착',t.ended_at,t.end_address,t.end_sites,t.end_lat,t.end_lng]].map(([label,instant,address,sites,lat,lng])=><li key={label}>
          <div><span>{label}</span> <time dateTime={instant||undefined}>{instant?(kstDate(instant)===date?'':kstDate(instant)+' ')+kstTime(instant):'종료 미수신'}</time></div>
          <p>{!!sites?.length&&<strong>{sites.map(s=>s.name).join(' · ')}</strong>}{address||(lat!=null&&lng!=null?`${lat.toFixed(5)}, ${lng.toFixed(5)}`:!sites?.length?'위치 정보 없음':'')}</p>
        </li>)}
      </ol>
      <div className="trip-mobile-metrics"><span>{typeof minutes==='number'&&Number.isFinite(minutes)&&`${minutes}분 · `}{[PURPOSE_LABEL[purpose]||'미지정',ann.company_purpose_name].filter(Boolean).join(' · ')}</span><strong>{km}{km!=='—'&&<small> km</small>}</strong></div>
      <details className="trip-mobile-more"><summary>{status}{!reportIncluded(t)&&<small>합계 제외</small>}<span>운행 상세</span></summary>
        <dl>{[['용무 설명',purpose==='other'&&ann.purpose_note],['계기판',odometerSummary(ann)],['거리 배분',t.allocation_note],['유류',fuel],['출발 좌표',t.start_lat!=null&&t.start_lng!=null&&`${t.start_lat.toFixed(5)}, ${t.start_lng.toFixed(5)}`],['도착 좌표',t.end_lat!=null&&t.end_lng!=null&&`${t.end_lat.toFixed(5)}, ${t.end_lng.toFixed(5)}`]].filter(([,value])=>value).map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
        <div className="trip-mobile-actions"><BusinessButton disabled={!onEvidence} onClick={onEvidence}>근거</BusinessButton><BusinessButton icon="edit" disabled={editDisabled} onClick={onEdit}>용무·운전자 수정</BusinessButton></div>
      </details>
    </article>;
  }

  return (
    <tr>
      <td style={st.td} className="no-print">{checkbox}</td>
      <td style={st.td}>{date}</td>
      <td style={st.td}>{time}</td><td style={st.td}>{status}{!reportIncluded(t)&&<small style={{display:"block"}}>합계 제외</small>}</td>
      <td style={st.td}>
        {PURPOSE_LABEL[purpose] || '미지정'}
        {ann.company_purpose_name&&<div className="corporate-trip-note">{ann.company_purpose_name}</div>}
        {purpose === 'other' && ann.purpose_note && (
          <div className="corporate-trip-note" style={{ fontSize: 10, color: 'var(--text-3)' }}>{ann.purpose_note}</div>
        )}
      </td>
      <td style={st.td}>
        {!!t.start_sites?.length&&<strong>{t.start_sites.map(s=>s.name).join(' · ')}</strong>}
        <div>{t.start_address || '—'}</div>
        {t.start_lat != null && (
          <div className="corporate-trip-coordinates" style={{ fontSize: 9, color: 'var(--text-3)' }}>
            {t.start_lat.toFixed(5)}, {t.start_lng.toFixed(5)}
          </div>
        )}
      </td>
      <td style={st.td}>
        {!!t.end_sites?.length&&<strong>{t.end_sites.map(s=>s.name).join(' · ')}</strong>}
        <div>{t.end_address || '—'}</div>
        {t.end_lat != null && (
          <div className="corporate-trip-coordinates" style={{ fontSize: 9, color: 'var(--text-3)' }}>
            {t.end_lat.toFixed(5)}, {t.end_lng.toFixed(5)}
          </div>
        )}
      </td>
      <td style={{ ...st.td, textAlign: 'right' }}>
        <span className="corporate-trip-distance">{km}{km !== '—' ? ' km' : ''}</span>
        {(ann.odometer_before_km != null || ann.odometer_after_km != null) && <small className="corporate-trip-odometer">{odometerSummary(ann)}</small>}
        {t.allocation_note && <small className="corporate-trip-distance-note">{t.allocation_note}</small>}
      </td>
      <td style={{ ...st.td, textAlign: 'right' }}>{dailyKm}</td>
      <td style={st.td}>
        {ann.fuel_liters ? `${ann.fuel_liters}L` : '—'}
        {ann.fuel_cost ? ` / ${ann.fuel_cost.toLocaleString()}원` : ''}
      </td>
      <td style={st.td}>{ann.driver_name || '—'}</td>
      <td style={{ ...st.td, padding: 4 }} className="no-print"><div className="fleet-quality-row-actions"><BusinessButton disabled={!onEvidence} onClick={onEvidence}>근거</BusinessButton>
        <button className="corporate-trip-edit" onClick={onEdit} disabled={editDisabled} style={{
          width: 48, height: 48, borderRadius: 4,
          background: 'var(--surface-2)', color: 'var(--text-2)',
          border: '1px solid var(--border)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }} title="용무·운전자 수정" aria-label="용무·운전자 수정">
          <Icon name="edit" size={16} />
        </button></div>
      </td>
    </tr>
  );
}

// ─── 운행 편집 모달 — 한 화면에서 용무/운전자/유류 전부 입력 ──
function TripEditorModal({ trip, staff, deviceId, onClose, onSaved }) {
  const ann = trip.annotation || {};
  const [purpose, setPurpose]      = useState(ann.purpose || 'unspecified');
  const [purposeNote, setPurposeNote] = useState(ann.purpose_note || '');
  const [companyPurposeId,setCompanyPurposeId]=useState(ann.company_purpose_id??'');
  const access=useFleetAccess();
  const [driverId, setDriverId]    = useState(ann.driver_staff_id || (!access.manage_reports?access.staff_id:''));
  const [fuelLiters, setFuelLiters] = useState(ann.fuel_liters != null ? String(ann.fuel_liters) : '');
  const [fuelCost, setFuelCost]    = useState(ann.fuel_cost != null ? String(ann.fuel_cost) : '');
  const [note, setNote]            = useState(ann.note || '');
  const [odometerBefore, setOdometerBefore] = useState(ann.odometer_before_km != null ? String(ann.odometer_before_km) : '');
  const [odometerAfter, setOdometerAfter] = useState(ann.odometer_after_km != null ? String(ann.odometer_after_km) : '');
  const odometerLocked = !!trip.correction_id;
  const odometer = validateOdometerInput(odometerBefore, odometerAfter);
  const odometerChanged = odometerBefore !== String(ann.odometer_before_km ?? '') || odometerAfter !== String(ann.odometer_after_km ?? '');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const close = () => { if (!saving.current) onClose(); };

  async function save() {
    if (saving.current || !mounted.current) return;
    if (!odometerLocked && odometer.error) return;
    saving.current = true;
    setBusy(true);
    try {
      await api.annotateFleetVehicleTrip(deviceId, {
        binding_id:trip.binding_id, source_device_id:trip.source_device_id,
        trip_started_at: trip.source_started_at || trip.started_at,
        expected_version: ann.updated_at || "new",
        purpose,
        purpose_note: purpose === 'other' ? (purposeNote.trim() || null) : null,
        company_purpose_id: companyPurposeId ? Number(companyPurposeId) : null,
        driver_staff_id: driverId ? parseInt(driverId, 10) : null,
        fuel_liters: fuelLiters.trim() ? parseFloat(fuelLiters) : null,
        fuel_cost:   ann.fuel_expense_id ? null : fuelCost.trim() ? parseInt(fuelCost, 10) : null,
        note: note.trim() || null,
        ...(!odometerLocked && odometerChanged ? odometer.payload : {}),
      });
      if (mounted.current) onSaved?.();
    } catch (e) {
      if (mounted.current) await alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    } finally { saving.current = false; if (mounted.current) setBusy(false); }
  }

  const km = tripDistance(trip.distance_m);

  return (
    // 외부 클릭으로 닫히지 않음 — 편집 중 데이터 손실 방지. X / 취소 버튼만 닫기.
    <Modal open title="운행 기록 수정" size={820} onClose={busy ? undefined : close} closeOnBackdrop={false} footer={<div className="corporate-editor-footer">
      <BusinessButton onClick={close} disabled={busy}>취소</BusinessButton>
      <BusinessButton primary onClick={save} disabled={busy || (!odometerLocked && !!odometer.error)}>{busy ? '저장 중...' : '저장'}</BusinessButton>
    </div>}>
        {/* 헤더 — 운행 요약 */}
        <div className="corporate-trip-editor-summary">
          <div>
            <strong>
              {kstDate(trip.started_at)} · {tripTimeRange(trip)}
            </strong>
            <p>
              {trip.start_address || '—'} → {trip.end_address || '—'} · {km}{km !== '—' ? ' km' : ''}
            </p>
          </div>

        </div>

        <fieldset className="corporate-editor-fields" disabled={busy} aria-busy={busy}>
          {/* 용무 */}
          <Field label="용무">
            <div className="corporate-editor-options">
              {[
                ['unspecified', '미지정'],
                ['commute',     '출퇴근'],
                ['business',    '업무'],
                ['other',       '기타'],
              ].map(([id, label]) => {
                const on = purpose === id;
                return (
                  <button className="corporate-editor-option" type="button" key={id} onClick={() => setPurpose(id)} aria-pressed={on}>{label}</button>
                );
              })}
            </div>
            {purpose === 'other' && (
              <input value={purposeNote} onChange={e => setPurposeNote(e.target.value)}
                placeholder="예: 거래처 미팅, 외근, 출장..."
                autoFocus />
            )}
          </Field>

          <CompanyPurposePicker value={companyPurposeId} onChange={setCompanyPurposeId} initialId={ann.company_purpose_id} initialName={ann.company_purpose_name}/>
          {/* 운전자 */}
          <Field label="운전자">
            {staff.length === 0 ? (
              <p className="corporate-editor-help">
                사용자 메뉴에서 등록할 수 있습니다.
              </p>
            ) : (
              <select value={driverId} onChange={e => setDriverId(e.target.value)}>
                {access.manage_reports&&<option value="">— 미지정 —</option>}
                {staff.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.role ? ` (${s.role})` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <section className="corporate-editor-odometer" aria-label="계기판 거리">
            <h3>계기판 거리 <span>(선택)</span></h3>
            <div className="corporate-editor-odometer-fields">
              <FormField label="주행 전 계기판 (km)">
                <Input type="text" inputMode="decimal" maxLength={10} value={odometerBefore} disabled={odometerLocked}
                  aria-label="주행 전 계기판 (km)" aria-invalid={!odometerLocked && !!odometer.error} aria-describedby="trip-odometer-help"
                  onChange={e=>setOdometerBefore(e.target.value)} placeholder="예: 12500" />
              </FormField>
              <FormField label="주행 후 계기판 (km)">
                <Input type="text" inputMode="decimal" maxLength={10} value={odometerAfter} disabled={odometerLocked}
                  aria-label="주행 후 계기판 (km)" aria-invalid={!odometerLocked && !!odometer.error} aria-describedby="trip-odometer-help"
                  onChange={e=>setOdometerAfter(e.target.value)} placeholder="예: 12512.5" />
              </FormField>
            </div>
            <p className="corporate-editor-help" id="trip-odometer-help">실제 차량의 누적 계기판 값을 입력하세요. 입력하면 국세청 형식 보고서의 주행거리에 전·후 차이를 반영하며, GPS 원본 거리는 유지합니다.</p>
            {!odometerLocked && odometer.error ? <p className="corporate-editor-odometer-error" role="alert">{odometer.error}</p> : odometer.distanceKm != null && <p className="corporate-editor-odometer-result" role="status">계기판 기준 주행거리 <strong>{odometer.distanceKm.toLocaleString('ko-KR', {maximumFractionDigits:2})} km</strong><span>운행기록 거리 {km}{km !== '—' ? ' km' : ''}</span></p>}
            {odometerLocked&&<p className="corporate-editor-help">보정된 운행은 보정 이력에서 원본으로 복원한 뒤 계기판 값을 수정할 수 있습니다.</p>}
          </section>

          {/* 유류 */}
          <Field label="유류">
            <div className="corporate-editor-fuel-fields">
              <div>
                <input type="number" step="0.1" value={fuelLiters}
                  onChange={e => setFuelLiters(e.target.value)}
                  placeholder="리터 (L)" aria-label="유류량 (리터)" />
                <div className="corporate-editor-help">리터</div>
              </div>
              <div>
                <input type="number" value={fuelCost} disabled={!!ann.fuel_expense_id}
                  onChange={e => setFuelCost(e.target.value)}
                  placeholder="비용 (원)" aria-label="유류비 (원)" />
                <div className="corporate-editor-help">원</div>
                {ann.fuel_expense_id&&<p className="business-note">지출 #{ann.fuel_expense_id}에서 관리 · 승인된 금액만 반영</p>}
              </div>
            </div>
          </Field>

          {/* 비고 */}
          <Field label="비고 (선택)">
            <input value={note} onChange={e => setNote(e.target.value)}
              placeholder="메모" />
          </Field>
        </fieldset>

    </Modal>
  );
}

// ════════════════════════════════════════════════════════
// 차량 관리
// ════════════════════════════════════════════════════════
function FilterChip({ active, onClick, label, count, tone = 'default' }) {
  const c = tone === 'success' ? 'var(--accent)' : tone === 'warn' ? 'var(--warning)' : 'var(--primary)';
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 999,
      background: active ? c : 'var(--surface-2)',
      color: active ? 'white' : 'var(--text-2)',
      border: 'none', cursor: 'pointer',
      fontSize: 12, fontWeight: 700,
      display: 'flex', alignItems: 'center', gap: 6,
    }}>
      {label}
      <span style={{
        fontSize: 10, padding: '1px 6px', borderRadius: 999,
        background: active ? 'rgba(255,255,255,0.25)' : 'var(--surface)',
        color: active ? 'white' : 'var(--text-3)',
        fontWeight: 700,
      }}>{count}</span>
    </button>
  );
}

// ═══════════════════════════════════════════════════════
// (2026-07-28 Stage-4F-1) 차량 예약 — cartax 스타일.
// 리스트 + 상태 chip 필터 + 생성/편집 다이얼로그.
// ═══════════════════════════════════════════════════════
const RESV_STATUS = {
  pending:     { label:'승인 대기',color:'var(--warning)',bg:'color-mix(in srgb,var(--warning) 12%,transparent)' },
  rejected:    { label:'반려',color:'var(--danger)',bg:'color-mix(in srgb,var(--danger) 12%,transparent)' },
  planned:     { label: '예정',   color: 'var(--primary)', bg: 'color-mix(in srgb, var(--primary) 12%, transparent)' },
  in_progress: { label: '진행중', color: 'var(--accent)',  bg: 'color-mix(in srgb, var(--accent) 15%, transparent)' },
  completed:   { label: '완료',   color: 'var(--text-3)',  bg: 'var(--surface-2)' },
  cancelled:   { label: '취소',   color: 'var(--danger)',  bg: 'color-mix(in srgb, var(--danger) 12%, transparent)' },
};
// Desktop design badges (list, detail, week and month views).
const RESV_STATUS_DESK = {
  pending:     { label:'승인 대기', color:'#b77923', bg:'#fff5e5' },
  rejected:    { label:'반려',     color:'#b94e59', bg:'#fff0f1' },
  planned:     { label:'예약 승인', color:'#26856b', bg:'#eaf6f0' },
  in_progress: { label:'이용 중',  color:'#26856b', bg:'#eaf6f0' },
  completed:   { label:'이용 완료', color:'#7b8593', bg:'#f0f2f6' },
  cancelled:   { label:'예약 취소', color:'#7b8593', bg:'#f0f2f6' },
};
const resvState=(status,desk)=>(desk?RESV_STATUS_DESK:RESV_STATUS)[status]||(desk?RESV_STATUS_DESK:RESV_STATUS).planned;

function shiftBookingDay(day, days) {
  const date = new Date(day + 'T00:00:00Z');
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0,10);
}
function bookingWeekStart(day) {
  return shiftBookingDay(day,-((new Date(day+'T00:00:00Z').getUTCDay()+6)%7));
}
function bookingsOn(list, day) {
  const start = Date.parse(day+'T00:00:00+09:00');
  return list.filter(r=>Date.parse(r.starts_at)<start+86400_000 && Date.parse(r.ends_at)>start);
}

function bookingPurpose(row) {
  return [row.company_purpose_name,row.purpose].filter(Boolean).join(' · ');
}
function ReservationsTab({ devices, request,requestsOnly=false }) {
  const mockupDesk=!useCorporatePhone()&&hideOutsideMockup;
  const access=useFleetAccess(),canWrite=access.write_reservations!==false;
  const [statusFilter, setStatusFilter] = useState(requestsOnly?'pending':'all');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);   // null | 'new' | {id, ...} | {new: 'YYYY-MM-DD'}
  const [opened, setOpened] = useState(null);
  useEffect(() => { if (request?.new&&canWrite) setEditing({new:true,vehicleId:request.vehicleId}); else if (request?.reservation) setEditing(request.reservation); }, [request,canWrite]);
  // (2026-07-28) Stage-4F-2: 뷰 모드 (리스트 / 캘린더).
  const [viewMode, setViewMode] = useState(() => requestsOnly?'list':localStorage.getItem('resv_view') || 'list');
  const setViewPersist = (v) => { setViewMode(v); try { localStorage.setItem('resv_view', v); } catch {} };
  const reservationDay = businessDate(useBusinessClock());
  const [calYm, setCalYm] = useState(() => businessDate().slice(0, 7));
  const [week,setWeek] = useState(()=>bookingWeekStart(reservationDay));
  const [dates,setDates] = useState(()=>({from:shiftBookingDay(reservationDay,-7),to:shiftBookingDay(reservationDay,60)}));
  const [filtersOpen,setFiltersOpen] = useState(true);
  const [vehicleFilter,setVehicleFilter] = useState('');
  const [driverFilter,setDriverFilter] = useState('');
  const [driverDepartment,setDriverDepartment]=useState('');
  const [purposeFilter,setPurposeFilter]=useState('');
  const [usageFilter,setUsageFilter]=useState('');
  const rangeDays=(Date.parse(dates.to)-Date.parse(dates.from))/86400_000;
  const invalidPeriod=viewMode==='list'&&(!Number.isFinite(rangeDays)||rangeDays<0||rangeDays>=366);

  // (F2-c) useStaff hook — active 만 필터.
  const { data: staffAll } = useStaff();
  const staff = useMemo(() => (staffAll || []).filter(x => x.active), [staffAll]);
  const deleteResvMut = useDeleteReservation();
  const cancelInFlight=useRef(false);
  async function cancelBooking(r) {
    if(cancelInFlight.current||!canWrite||r.can_edit===false||['cancelled','rejected'].includes(r.status))return false;
    cancelInFlight.current=true;
    try{
      const completed=r.status==='completed';
      if(!await confirmDialog({title:completed?'완료된 예약 취소':'예약 취소',body:completed?'이용이 완료된 예약을 취소 상태로 변경할까요? 기존 예약과 처리 이력이 유지됩니다.':'예약을 취소할까요? 기존 내역은 유지됩니다.',danger:true}))return false;
      await deleteResvMut.mutateAsync(r.id);
      return true;
    }catch(e){await alertDialog({title:'예약 취소 실패',body:e.message,tone:'danger'});return false;}
    finally{cancelInFlight.current=false;}
  }

  // (F2-c) useReservations hook — params key 안정화.
  const resvParams = useMemo(() => {
    let from, to;
    if (viewMode === 'calendar') {
      const [year,month]=calYm.split('-').map(Number);
      const monthStart=Date.UTC(year,month-1,1)-9*3600_000, monthEnd=Date.UTC(year,month,1)-9*3600_000;
      from = new Date(monthStart-7*86400_000).toISOString();
      to = new Date(monthEnd+7*86400_000).toISOString();
    } else if (viewMode==='week') {
      from = new Date(week+'T00:00:00+09:00').toISOString();
      to = new Date(shiftBookingDay(week,7)+'T00:00:00+09:00').toISOString();
    } else if (!invalidPeriod) {
      from = new Date(dates.from+'T00:00:00+09:00').toISOString();
      to = new Date(shiftBookingDay(dates.to,1)+'T00:00:00+09:00').toISOString();
    }
    return { from, to };
  }, [viewMode, calYm, week, dates, invalidPeriod]);
  const { data: allReservations, isLoading: loading, error: qError, refetch } = useReservations(resvParams, {enabled:!invalidPeriod,refetchInterval: 60_000});
  const detail = opened && (allReservations?.find(r=>r.id===opened.id) || opened);
  const driverDepartments=useMemo(()=>new Map((staffAll||[]).map(person=>[person.id,person.department||''])),[staffAll]);
  const departmentOptions=[...new Set(driverDepartments.values())].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ko'));
  const purposeOptions=[...new Set((allReservations||[]).map(bookingPurpose))].filter(Boolean).sort((a,b)=>a.localeCompare(b,'ko'));
  // Desktop design: the filter lists company trip purposes only (the visit place is found through search).
  // Same cache key as CompanyPurposePicker's purpose list.
  const companyPurposes=useQuery({queryKey:['fleet-trip-purposes'],queryFn:()=>api.fleetTripPurposes(),enabled:mockupDesk})?.data;
  const deskPurposes=mockupDesk?[...(companyPurposes||[]).map(p=>({id:String(p.id),name:p.name+(p.active===false?' (사용 안 함)':'')})),
    ...[...new Map((allReservations||[]).filter(r=>r.company_purpose_id!=null&&!(companyPurposes||[]).some(p=>p.id===r.company_purpose_id)).map(r=>[String(r.company_purpose_id),r.company_purpose_name||'운행목적 #'+r.company_purpose_id])).entries()].map(([id,name])=>({id,name}))]:[];
  const purposeMatch=r=>!purposeFilter||(mockupDesk?(purposeFilter==='none'?r.company_purpose_id==null:String(r.company_purpose_id)===purposeFilter):bookingPurpose(r)===purposeFilter);
  const searched = allReservations?.filter(r => (!requestsOnly||(r.approval_required&&r.can_review))&&(!vehicleFilter||String(r.vehicle_id)===vehicleFilter) &&
    (!driverDepartment||driverDepartments.get(r.driver_staff_id)===driverDepartment) && purposeMatch(r) && (!usageFilter||(usageFilter==='none'?!r.report_purpose:r.report_purpose===usageFilter)) &&
    (!driverFilter||(driverFilter==='unassigned'?r.driver_staff_id==null:String(r.driver_staff_id)===driverFilter)) &&
    [r.vehicle_name,r.device_name,r.license_plate,r.driver_name,bookingPurpose(r),r.destination_address,r.note].join(' ').toLocaleLowerCase('ko-KR').includes(query.trim().toLocaleLowerCase('ko-KR')));
  const list = searched?.filter(r => viewMode !== 'list' || statusFilter === 'all' || (statusFilter === 'active' ? ['planned', 'in_progress'].includes(r.status) : r.status === statusFilter));
  const error = qError?.message || null;

  const activeCount    = (searched || []).filter(r => r.status === 'planned' || r.status === 'in_progress').length;
  const completedCount = (searched || []).filter(r => r.status === 'completed').length;
  const cancelledCount = (searched || []).filter(r => r.status === 'cancelled').length;

  const known = !qError && !invalidPeriod && !!allReservations;
  const shown=known?list:null;
  const report=shown&&{
    title:'차량 예약',filename:`차량_예약_${businessDate(resvParams.from)}_${businessDate(Date.parse(resvParams.to)-1)}`,
    columns:[['vehicle','차량'],['plate','차량번호'],['driver','운전자'],['start','시작 일시'],['end','종료 일시'],['companyPurpose','운행목적'],['purpose','방문 장소'],['address','주소'],['note','메모'],['status','상태']].map(([key,label])=>({key,label})),
    rows:shown.map(r=>({vehicle:r.vehicle_name||r.device_name,plate:r.license_plate,driver:r.driver_name,start:kstDateTime(r.starts_at),end:kstDateTime(r.ends_at),companyPurpose:r.company_purpose_name,purpose:r.purpose,address:r.destination_address,note:r.note,status:RESV_STATUS[r.status]?.label||r.status})),
  };
  return (
    <div className="corporate-reservations">
      <FleetRecordMetrics label="조회된 예약 요약" items={[
        {name:'조회된 예약',value:shown?.length,unit:'건',icon:'clock'},
        {name:'승인 대기',value:known?searched.filter(r=>r.status==='pending').length:null,unit:'건',tone:'amber'},
        {name:'오늘 이용 예정',value:shown&&bookingsOn(shown,reservationDay).filter(r=>['planned','in_progress','completed'].includes(r.status)).length,unit:'건',tone:'blue'},
        {name:'이용 완료',value:shown?.filter(r=>r.status==='completed').length,unit:'건',tone:'green'},
      ]}/>
      <div className="fleet-booking-query">
        <div className="fleet-record-toolbar">
          {!requestsOnly&&<div className="corporate-view-switch" role="group" aria-label="예약 보기 방식">
            <button type="button" className="corporate-view-option" aria-pressed={viewMode==='list'} onClick={()=>setViewPersist('list')}><Icon name="list" size={16}/>예약 목록</button>
            <button type="button" className="corporate-view-option" aria-pressed={viewMode==='week'} onClick={()=>setViewPersist('week')}>주간 일정</button>
            {!mockupDesk&&<button type="button" className="corporate-view-option" aria-pressed={viewMode==='calendar'} onClick={()=>setViewPersist('calendar')}><Icon name="clock" size={16}/>캘린더</button>}
          </div>}
          <div className="fleet-record-actions">{viewMode==='calendar' && <input className="corporate-reservation-month" type="month" aria-label="예약 조회 월" value={calYm} onChange={e=>setCalYm(e.target.value||calYm)}/>}
          <ExportButtons csvOnly report={report} disabled={!shown?.length}/>
          {canWrite&&!requestsOnly&&<BusinessButton primary icon="plus" onClick={()=>setEditing('new')}>차량 예약</BusinessButton>}</div>
        </div>
        {filtersOpen&&<div className="fleet-record-fields fleet-booking-query-fields">
          {viewMode==='list'&&<div className="fleet-date-field"><span>이용 기간</span><div>
            <label className="fleet-date-endpoint"><span>시작일</span><input type="date" aria-label="예약 조회 시작일" value={dates.from} max={dates.to} onChange={e=>setDates({...dates,from:e.target.value})}/></label><span aria-hidden="true">~</span>
            <label className="fleet-date-endpoint"><span>종료일</span><input type="date" aria-label="예약 조회 종료일" value={dates.to} min={dates.from} onChange={e=>setDates({...dates,to:e.target.value})}/></label>
          </div></div>}
          {viewMode==='list'&&<label>예약 상태<select aria-label="예약 상태 필터" value={statusFilter} onChange={e=>setStatusFilter(e.target.value)}>{[['all','전체',searched?.length],['pending','승인 대기',searched?.filter(r=>r.status==='pending').length],['active',mockupDesk?'예약 승인':'예정·진행',activeCount],['completed',mockupDesk?'이용 완료':'완료',completedCount],['rejected','반려',searched?.filter(r=>r.status==='rejected').length],['cancelled',mockupDesk?'예약 취소':'취소',cancelledCount]].map(([value,label,count])=><option key={value} value={value}>{mockupDesk&&value==='all'?'전체 상태':label+' ('+(known?count:'—')+')'}</option>)}</select></label>}
          <label>차량<select value={vehicleFilter} onChange={e=>setVehicleFilter(e.target.value)}><option value="">전체 차량</option>{devices.map(d=><option key={d.id} value={d.id}>{reportVehicleLabel(d)}</option>)}</select></label>
          <label>예약 운전자<select value={driverFilter} onChange={e=>setDriverFilter(e.target.value)}><option value="">전체 예약 운전자</option><option value="unassigned">미지정</option>{staffAll?.map(s=><option value={s.id} key={s.id}>{s.name}{s.active===false?' (비활성)':''}</option>)}</select></label>
          <label>예약 운전자 부서<select value={driverDepartment} onChange={e=>setDriverDepartment(e.target.value)}><option value="">전체 부서</option>{departmentOptions.map(name=><option key={name}>{name}</option>)}</select></label>
        </div>}
        <div className="fleet-record-filterfoot fleet-booking-query-foot">{filtersOpen&&<><label>운행목적<select value={purposeFilter} onChange={e=>setPurposeFilter(e.target.value)}><option value="">전체 운행목적</option>{mockupDesk?<><option value="none">미분류</option>{deskPurposes.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</>:<>{purposeOptions.includes(purposeFilter)||!purposeFilter?null:<option>{purposeFilter}</option>}{purposeOptions.map(name=><option key={name}>{name}</option>)}</>}</select></label><label>이용 구분<select aria-label="이용 구분 필터" value={usageFilter} onChange={e=>setUsageFilter(e.target.value)}><option value="">전체 이용 구분</option><option value="business">업무</option><option value="commute">출퇴근</option><option value="other">기타</option><option value="none">미지정</option></select></label></>}<label className="fleet-inline-search"><Icon name="search" size={16}/><input type="search" aria-label="예약 차량·사용자 검색" placeholder="차량, 운전자, 방문 장소 검색" value={query} onChange={e=>setQuery(e.target.value)}/></label><div>
          {!mockupDesk&&<BusinessButton icon="filter" aria-expanded={filtersOpen} onClick={()=>setFiltersOpen(!filtersOpen)}>필터</BusinessButton>}
          <button type="button" className="fleet-filter-reset-link" onClick={()=>{setVehicleFilter('');setDriverFilter('');setDriverDepartment('');setPurposeFilter('');setUsageFilter('');setQuery('');setStatusFilter(requestsOnly?'pending':'all');if(viewMode==='list')setDates({from:shiftBookingDay(reservationDay,-7),to:shiftBookingDay(reservationDay,60)});}}><Icon name="refresh" size={13}/>조건 초기화</button>
        </div></div>
      </div>
      {error && <BusinessError onRetry={refetch}>예약 정보를 불러오지 못했습니다.</BusinessError>}
      {loading && !list && !invalidPeriod && <SkeletonList count={3} itemHeight={64}/>}
      {invalidPeriod&&<BusinessError>시작일과 종료일을 1년 이내로 선택해 주세요.</BusinessError>}
      {!error && !invalidPeriod && viewMode==='list' && list && <section className="corporate-reservation-ledger">
        <div className="corporate-reservation-scroll" role="region" aria-label="차량 예약 목록 · 좌우 스크롤" tabIndex={0}>
          {!(mockupDesk&&!list.length)&&<table className="corporate-reservation-table"><thead><tr><th scope="col">차량</th><th scope="col">운전자</th><th scope="col">이용 일정</th><th scope="col">{mockupDesk?'운행목적 / 방문 장소':'운행목적 / 메모'}</th><th scope="col">상태</th></tr></thead>
            <tbody>{list.map(r=><ReservationRow key={r.id} r={r} onOpen={()=>setOpened(r)}/>)}</tbody>
          </table>}
          {!list.length&&mockupDesk&&<BusinessEmpty mockup title="조회된 내역이 없습니다">기간이나 검색 조건을 변경해 보세요.</BusinessEmpty>}{!list.length&&!mockupDesk&&<BusinessEmpty title={query?'검색 결과가 없습니다.':requestsOnly?'조회된 승인 요청이 없습니다.':'예약이 없습니다.'}>{requestsOnly||!canWrite?'조회 기간이나 상태를 변경해 주세요.':query?'검색어나 상태를 변경해 주세요.':'새 예약을 등록하거나 조회 상태를 변경해 주세요.'}</BusinessEmpty>}
        </div>
        <footer className="corporate-reservation-footer">{list.length}건</footer>
      </section>}
      {!error && viewMode==='calendar' && <ReservationCalendar ym={calYm} list={list||[]} onDayClick={canWrite?dateStr=>setEditing({new:dateStr}):undefined} onEventClick={setOpened}/>}
      {!error && viewMode==='week' && <ReservationWeek week={week} today={reservationDay} list={shown} setWeek={setWeek} onNew={canWrite?day=>setEditing({new:day}):undefined} onOpen={setOpened}/>}
      {detail && <ReservationDetails row={detail} onEdit={()=>setEditing(detail)} onCancel={cancelBooking} onClose={()=>setOpened(null)}/>}
      {editing && <ReservationDialog init={editing==='new'||editing?.new?null:editing} devices={devices} staff={staff} presetVehicleId={editing?.vehicleId} presetDate={typeof editing?.new==='string'?editing.new:null} onCancel={cancelBooking} onClose={()=>setEditing(null)} onSaved={saved=>{if(saved?.status==='pending')setStatusFilter('pending');setEditing(null);setOpened(null);}}/>}
    </div>
  );
}

function ReservationWeek({week,today,list,setWeek,onNew,onOpen}) {
  const desk=!useCorporatePhone()&&hideOutsideMockup;
  const weekdays=['월','화','수','목','금','토','일'];
  return <section className="fleet-booking-week" aria-label="주간 차량 예약">
    <header>
      <BusinessButton aria-label="이전 주" onClick={()=>setWeek(shiftBookingDay(week,-7))}><Icon name="chevron-left" size={16}/></BusinessButton>
      <strong>{week} ~ {shiftBookingDay(week,6)}</strong>
      <BusinessButton aria-label="다음 주" onClick={()=>setWeek(shiftBookingDay(week,7))}><Icon name="chevron-right" size={16}/></BusinessButton>
      <BusinessButton onClick={()=>setWeek(bookingWeekStart(today))}>이번 주</BusinessButton>
    </header>
    {list&&<div className="fleet-booking-week-days">{weekdays.map((name,i)=>{
      const day=shiftBookingDay(week,i), bookings=bookingsOn(list,day).sort((a,b)=>a.starts_at.localeCompare(b.starts_at));
      return <section key={day} data-today={day===today}><h3><button type="button" disabled={!onNew} aria-label={onNew?day+' 새 예약':day} onClick={()=>onNew?.(day)}>{Number(day.slice(-2))}일 {name}<span>{bookings.length}건</span></button></h3>
        {bookings.map(r=><button type="button" className="fleet-week-event" key={r.id} aria-label={`예약 ${r.id} 상세·수정`} onClick={()=>onOpen(r)}>
          <strong>{r.license_plate||r.vehicle_name||r.device_name||'차량'}</strong>
          <small>{businessDate(r.starts_at)<day?'이전날부터':kstTime(r.starts_at)} ~ {businessDate(Date.parse(r.ends_at)-1)>day?'다음날까지':kstTime(r.ends_at)}</small>
          <small>{r.driver_name||'미지정'} · {(desk?RESV_STATUS_DESK:RESV_STATUS)[r.status]?.label||r.status}</small>
        </button>)}
        {!bookings.length&&<p>예약 없음</p>}
      </section>;
    })}</div>}
  </section>;
}

function ReservationDetails({row:r,onEdit,onCancel,onClose}) {
  const access=useFleetAccess();
  const desk=!useCorporatePhone()&&hideOutsideMockup;
  const writable=access.write_reservations!==false && r.can_edit!==false;
  const editable=writable && !(r.approval_required && ['rejected','cancelled','completed'].includes(r.status));
  const cancellable=writable && !['cancelled','rejected'].includes(r.status);
  const reviewable=access.review_reservations!==false;
  const reviewNow=desk && r.approval_required && r.can_review && reviewable && r.status==='pending';
  const [decision,setDecision]=useState(null);
  const state=resvState(r.status,desk);
  const details=desk?[['운전자',r.driver_name || '미지정'],['이용 구분',{commute:'출퇴근',business:'업무',other:'기타'}[r.report_purpose] || '미지정'],['운행목적',r.company_purpose_name || '미지정'],
    ['시작 시간',dotDateTime(r.starts_at)],['종료 시간',dotDateTime(r.ends_at)],['방문 장소',r.purpose || '—'],['목적지 주소',r.destination_address || '미등록'],['요청일',r.created_at?dotDateTime(r.created_at).slice(0,10):'—']]:[['운전자',r.driver_name || '미지정'],['운행 목적',bookingPurpose(r) || '미지정'],['시작 시간',kstDateTime(r.starts_at)],
    ['종료 시간',kstDateTime(r.ends_at)],['운행기록부 용무',{commute:'출퇴근',business:'업무',other:'기타'}[r.report_purpose] || '미지정'],['메모',r.note || '—']];
  const cancel=async()=>{if(await onCancel(r))onClose();};
  return <Modal open placement="end" size={470} title="예약 상세" subtitle={(desk?dotDateTime(r.starts_at).slice(0,10):kstDateTime(r.starts_at))+' · '+(r.driver_name||'운전자 미지정')} onClose={onClose}
    footer={desk?<div className="corporate-detail-actions booking-detail-actions">
      {reviewNow&&<><BusinessButton className="business-button booking-reject" onClick={()=>setDecision('reject')}>반려</BusinessButton><BusinessButton primary icon="check" onClick={()=>setDecision('approve')}>승인</BusinessButton></>}
      {editable && <BusinessButton icon="pencil" onClick={onEdit}>변경</BusinessButton>}
      {cancellable && <BusinessButton className="business-button booking-cancel-link" onClick={cancel}>예약 취소</BusinessButton>}
    </div>:<div className="corporate-detail-actions">
      {writable && !['cancelled','rejected'].includes(r.status) && <BusinessButton onClick={async()=>{if(await onCancel(r))onClose();}}>예약 취소</BusinessButton>}
      <BusinessButton onClick={onClose}>닫기</BusinessButton>{editable && <BusinessButton primary icon="edit" onClick={onEdit}>예약 변경</BusinessButton>}
    </div>}>
    <div className="corporate-record-body"><div className="booking-detail-vehicle">{desk&&<img className="booking-detail-car" src={sedanArt} alt=""/>}<div><strong>{r.license_plate||r.vehicle_name||r.device_name||'차량'}</strong>
      {r.license_plate && r.vehicle_name && r.vehicle_name!==r.license_plate && <small>{r.vehicle_name}</small>}</div>
      <span className="corporate-reservation-badge" style={{color:state.color,background:state.bg}}>{state.label}</span></div>
      <dl>{details.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {desk&&r.note&&<div className="corporate-booking-note"><h3>메모</h3><p>{r.note}</p></div>}
      {r.approval_required && (desk?<ReservationApproval compact row={r} reviewable={reviewable} decision={decision} onDecision={setDecision} onFinished={onClose}/>:<ReservationApproval row={r} reviewable={reviewable} onFinished={onClose}/>)}
    </div>
  </Modal>;
}

function ReservationRow({r,onOpen}) {
  const deskDates=!useCorporatePhone()&&hideOutsideMockup;
  const state=resvState(r.status,deskDates);
  const untilStart=Math.round((Date.parse(r.starts_at)-Date.now())/60000),untilEnd=Math.round((Date.parse(r.ends_at)-Date.now())/60000);
  const imminent=r.status==='planned'&&untilStart>=0&&untilStart<=60;
  const returning=r.status==='in_progress'&&untilEnd>=0&&untilEnd<=60;
  return <tr className="booking-detail-row" onClick={event=>{
    if(!event.target.closest('button')){event.currentTarget.querySelector('.booking-detail-link')?.focus({preventScroll:true});onOpen();}
  }}>
    <td data-label="차량" className="corporate-reservation-vehicle">{deskDates?<img className="corporate-reservation-car" src={sedanArt} alt=""/>:<i className="corporate-reservation-thumb" aria-hidden="true"><Icon name="car" size={18}/></i>}<span><button type="button" className="booking-detail-link" onClick={onOpen} aria-label={`예약 ${r.id} 보기`}>{r.license_plate||r.vehicle_name||r.device_name||'차량'}</button>{r.license_plate&&r.vehicle_name&&r.vehicle_name!==r.license_plate&&<small>{r.vehicle_name}</small>}</span></td>
    <td data-label="운전자">{r.driver_name||'미지정'}</td><td data-label="이용 일정">{deskDates?<>{dotDateTime(r.starts_at)}<small>{dotDateTime(r.ends_at)} 종료</small></>:<>{kstDateTime(r.starts_at)}<small>~ {kstDateTime(r.ends_at)}</small></>}</td>
    {deskDates?<td data-label="운행목적 / 방문 장소"><span>{r.company_purpose_name||'—'}</span>{r.purpose&&<small>{r.purpose}</small>}</td>:<td data-label="운행목적 / 메모"><span>{bookingPurpose(r)||'—'}</span>{r.note&&<small>{r.note}</small>}</td>}
    <td data-label="상태"><span className="corporate-reservation-badge" style={{color:state.color,background:state.bg}}>{state.label}</span>{imminent&&<small className="corporate-reservation-alert">{untilStart===0?'지금 시작':untilStart+'분 후 시작'}</small>}{returning&&<small className="corporate-reservation-alert">{untilEnd===0?'지금 반납':untilEnd+'분 후 반납'}</small>}</td>
  </tr>;
}


// (2026-07-28) Stage-4F-2: 월 캘린더 뷰. 7x6 grid, 각 셀 = 하루.
// 각 날짜에는 두 건을 먼저 표시하고 같은 날의 나머지 예약은 목록에서 연다.
function ReservationCalendar({ ym, list, onDayClick, onEventClick }) {
  const desk=!useCorporatePhone()&&hideOutsideMockup;
  const [openDay, setOpenDay] = useState(null);
  const [y, m] = ym.split('-').map(Number);
  const monthStart = new Date(y, m - 1, 1);
  const monthEnd   = new Date(y, m, 0);   // 마지막날
  const startDay   = monthStart.getDay(); // 0=Sun
  const daysInMonth = monthEnd.getDate();
  const todayStr = businessDate();

  // 셀 구성 — 이전달 잔여 + 이번달 + 다음달 첫주 padding. 7x6 = 42 cells.
  const cells = [];
  for (let i = 0; i < startDay; i++) {
    const d = new Date(y, m - 1, i - startDay + 1);
    cells.push({ date: d, currentMonth: false });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    cells.push({ date: new Date(y, m - 1, d), currentMonth: true });
  }
  while (cells.length < 42) {
    const last = cells[cells.length - 1].date;
    cells.push({ date: new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1), currentMonth: false });
  }

  const DOW = ['일', '월', '화', '수', '목', '금', '토'];
  const openBookings = openDay ? bookingsOn(list,openDay) : [];
  function showBooking(event, booking) {
    event.currentTarget.focus({ preventScroll: true });
    onEventClick(booking);
  }

  return (
    <>
    <div className="corporate-reservation-calendar" role="region" aria-label="월간 차량 예약">
      {/* DoW header */}
      <div className="corporate-calendar-weekdays">
        {DOW.map((d, i) => (
          <div key={d} style={{
            color: i === 0 ? 'var(--danger)' : i === 6 ? 'var(--primary)' : 'var(--text-2)',
          }}>{d}</div>
        ))}
      </div>
      <div className="corporate-calendar-days">
        {cells.map(c => {
          const dStr = calendarDate(c.date);
          const dayResv = bookingsOn(list,dStr);
          const isToday = dStr === todayStr;
          const dow = c.date.getDay();
          const MAX_BADGES = 2;
          return (
            <div className="corporate-calendar-day" key={dStr} style={{
              '--day-color': !c.currentMonth ? 'var(--text-3)' : isToday || dow === 6 ? 'var(--primary)' : dow === 0 ? 'var(--danger)' : 'var(--text)',
              background: isToday
                ? 'color-mix(in srgb, var(--primary) 8%, transparent)'
                : c.currentMonth ? 'var(--surface)' : 'var(--surface-2)',
              border: '1px solid ' + (isToday ? 'var(--primary)' : 'var(--border)'),
              opacity: c.currentMonth ? 1 : 0.4,
              cursor: c.currentMonth ? 'pointer' : 'default',
            }}>
              <button type="button" className="corporate-calendar-compact" aria-current={isToday?'date':undefined} aria-haspopup="dialog"
                disabled={!dayResv.length && (!c.currentMonth || !onDayClick)}
                aria-label={dayResv.length ? `${dStr} 예약 ${dayResv.length}건` : `${dStr} ${c.currentMonth && onDayClick ? '예약 등록' : '예약 없음'}`}
                onClick={event => {
                  event.currentTarget.focus({preventScroll:true});
                  if (dayResv.length) setOpenDay(dStr);
                  else onDayClick?.(dStr);
                }}>
                <span>{c.date.getDate()}</span>
                {dayResv.length > 0 && <small>{dayResv.length}건</small>}
              </button>
              <button type="button" className="corporate-calendar-date" disabled={!c.currentMonth||!onDayClick}
                aria-label={c.currentMonth ? `${dStr} 새 예약` : dStr} onClick={event => {
                  event.currentTarget.focus({ preventScroll: true });
                  onDayClick?.(dStr);
                }}>
                {c.date.getDate()}
              </button>
              {dayResv.slice(0, MAX_BADGES).map(r => {
                const s = resvState(r.status, desk);
                return (
                  <button type="button" className="corporate-calendar-event" key={r.id} aria-haspopup="dialog"
                    onClick={event => showBooking(event, r)} style={{
                    background: s.bg, color: s.color,
                  }} title={`${r.license_plate || r.device_name || ''} · ${bookingPurpose(r)} · ${s.label}`}>
                    {['pending','rejected'].includes(r.status)&&<strong>{s.label} · </strong>}
                    {[r.license_plate,r.vehicle_name].filter(Boolean).join(' · ') || '차량'}
                  </button>
                );
              })}
              {dayResv.length > MAX_BADGES && (
                <button type="button" className="corporate-calendar-more" aria-haspopup="dialog"
                  aria-label={`${dStr} 예약 전체 ${dayResv.length}건 보기`} onClick={event => {
                    event.currentTarget.focus({ preventScroll: true });
                    setOpenDay(dStr);
                  }}>
                  +{dayResv.length - MAX_BADGES}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
    {openDay && <Modal open title={`${openDay} 예약`} subtitle={`총 ${openBookings.length}건`} size="lg" onClose={() => setOpenDay(null)}
      footer={<div className="service-form-actions"><BusinessButton onClick={() => setOpenDay(null)}>닫기</BusinessButton>
        {onDayClick && openDay.startsWith(ym+'-') && <BusinessButton primary onClick={() => onDayClick(openDay)}>이 날짜에 예약</BusinessButton>}
      </div>}>
      {openBookings.length ? <ul className="corporate-calendar-bookings">{openBookings.map(r => {
        const state = resvState(r.status, desk);
        const plate = r.license_plate?.trim();
        const vehicle = (r.vehicle_name || r.device_name)?.trim();
        const vehicleLabel = vehicle && plate && vehicle.replace(/\s/g, '') === plate.replace(/\s/g, '')
          ? plate : [vehicle, plate].filter(Boolean).join(' · ') || '차량';
        const times = [r.starts_at, r.ends_at].map(value => {
          const kst = kstDateTime(value);
          return kst.startsWith(openDay) ? kst.slice(11) : kst;
        });
        return <li key={r.id}><button type="button" className="corporate-calendar-booking" aria-haspopup="dialog" onClick={event => showBooking(event, r)}>
          <span className="business-sr-only">예약 {r.id} 상세·수정</span>
          <strong>{times.join(' ~ ')}</strong>
          <span className="corporate-reservation-badge" style={{ color: state.color, background: state.bg }}>{state.label}</span>
          <span className="corporate-calendar-booking-vehicle">{vehicleLabel}</span>
          <span className="corporate-calendar-booking-driver">사용자 {r.driver_name || '미지정'}</span>
          {bookingPurpose(r) && <span className="corporate-calendar-booking-purpose">목적 {bookingPurpose(r)}</span>}
        </button></li>;
      })}</ul> : <BusinessEmpty title="이 날짜에 표시할 예약이 없습니다."/>}
    </Modal>}
    </>
  );
}


// Reservation inputs and list dates share Korean time, independent of browser timezone.
function localToIso(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || '')) return null;
  const at = Date.parse(`${value}+09:00`);
  return Number.isFinite(at) && isoToLocal(new Date(at).toISOString()) === value ? new Date(at).toISOString() : null;
}
function isoToLocal(iso) {
  return kstDateTime(iso).replace(' ', 'T');
}

function ReservationDialog({ init, presetDate, presetVehicleId, devices, staff, onCancel, onClose, onSaved }) {
  const access=useFleetAccess();
  const desk=!useCorporatePhone()&&hideOutsideMockup;
  const locked=Boolean(access.write_reservations===false||init?.can_edit===false||(init?.approval_required&&['rejected','cancelled','completed'].includes(init.status)));
  const policy=useQuery({queryKey:['fleet-reservation-policy'],queryFn:()=>api.fleetReservationPolicy(),enabled:!init});
  const approvalRequired=init?init.approval_required:policy?.data?.approval_required;
  // init null = 신규. presetDate 'YYYY-MM-DD' 있으면 그 날 09:00~10:00 기본.
  // 아니면 다음 정시부터 +1h.
  const defaultStart = () => {
    if (presetDate) return new Date(`${presetDate}T09:00:00+09:00`);
    return new Date((Math.floor(Date.now() / 3600_000) + 1) * 3600_000);
  };
  const options=(devices||[]).filter(d=>d.enabled!==false||d.id===init?.vehicle_id);
  const [deviceId, setDeviceId] = useState(init?.vehicle_id ?? presetVehicleId ?? (desk ? '' : options[0]?.id ?? ''));
  const vehicleAllowed=options.some(d=>String(d.id)===String(deviceId));
  const [driverId, setDriverId] = useState(init?.driver_staff_id ?? (!access.manage_reports?access.staff_id:''));
  const [startsAt, setStartsAt] = useState(init ? isoToLocal(init.starts_at) : isoToLocal(defaultStart().toISOString()));
  const [endsAt,   setEndsAt]   = useState(init ? isoToLocal(init.ends_at)   : isoToLocal(new Date(defaultStart().getTime() + 3600_000).toISOString()));
  const [purpose,  setPurpose]  = useState(init?.purpose ?? '');
  const [address,  setAddress]  = useState(init?.destination_address ?? '');
  const [reportPurpose,setReportPurpose]=useState(init?.report_purpose || '');
  const [companyPurposeId,setCompanyPurposeId]=useState(init?.company_purpose_id??'');
  const [note,     setNote]     = useState(init?.note ?? '');
  const [status,   setStatus]   = useState(init?.status ?? 'planned');
  // (F2-c) mutations — 성공 시 자동 invalidate.
  const createMut = useCreateReservation();
  const updateMut = useUpdateReservation();
  const [submitting, setSubmitting] = useState(false);
  const saving = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const busy = submitting || createMut.isPending || updateMut.isPending;
  const close = () => { if (!saving.current) onClose(); };

  async function save() {
    if (locked || saving.current || busy || !mounted.current) return;
    if (!vehicleAllowed) { alertDialog({ title: '차량 선택 필요', body: '예약 가능한 차량을 선택해 주세요.', tone: 'danger' }); return; }
    if (desk && !purpose.trim()) { alertDialog({ title: '방문 장소 입력 필요', body: '방문할 장소명을 입력해 주세요.', tone: 'danger' }); return; }
    if (!startsAt || !endsAt) { alertDialog({ title: '시간 입력 필요', body: '', tone: 'danger' }); return; }
    const start = init && isoToLocal(init.starts_at)===startsAt ? new Date(init.starts_at).toISOString() : localToIso(startsAt);
    const end = init && isoToLocal(init.ends_at)===endsAt ? new Date(init.ends_at).toISOString() : localToIso(endsAt);
    if (!start || !end || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 366 * 86400_000) {
      alertDialog({ title: '예약 시간 확인', body: '종료 시간을 시작 시간 이후로 선택해 주세요. 최대 1년까지 예약할 수 있습니다.', tone: 'danger' });
      return;
    }
    saving.current = true;
    setSubmitting(true);
    const body = {
      vehicle_id:      Number(deviceId),
      driver_staff_id: driverId ? Number(driverId) : null,
      starts_at:       start,
      ends_at:         end,
      purpose:         purpose.trim() || null,
      // Phones do not show the address, so their saves leave the stored value alone.
      ...(desk?{destination_address: address.trim() || null}:{}),
      report_purpose: reportPurpose || null,
      company_purpose_id: companyPurposeId ? Number(companyPurposeId) : null,
      note:            note.trim() || null,
      status,
      ...(init?.updated_at?{updated_at:init.updated_at}:{}),
    };
    try {
      const saved=init?.id?await updateMut.mutateAsync({id:init.id,body}):await createMut.mutateAsync(body);
      if (mounted.current) onSaved(saved);
    } catch (e) {
      if (mounted.current) await alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    } finally { saving.current = false; if (mounted.current) setSubmitting(false); }
  }

  return (
    <Modal open mobileForm onClose={busy ? undefined : close} size={720} title={init?.id ? (locked?'예약 상세':'예약 편집') : desk?'차량 예약':'새 예약'} subtitle={desk?'차량과 운행 목적을 선택하고 이용 일정을 등록합니다.':'차량과 운전자를 선택하고 이용 일정을 확인하세요.'} footer={<div className="service-form-actions booking-form-actions">
      {onCancel&&init?.status==='completed'&&access.write_reservations!==false&&init.can_edit!==false&&<Button disabled={busy} variant="ghost" onClick={async()=>{if(await onCancel(init)&&mounted.current)onClose();}}>완료된 예약 취소</Button>}
      <Button onClick={close} disabled={busy} variant="ghost" size="lg">{locked?'닫기':'취소'}</Button>
      {!locked&&<Button onClick={save} busy={busy} disabled={busy||(!desk&&!vehicleAllowed)} variant="primary" size="lg">
        {busy ? '저장 중...' : !init&&desk?'예약 등록':!init&&approvalRequired?'승인 요청':'저장'}
      </Button>}
    </div>}>
        {init?.approval_required&&<ReservationApproval row={init} reviewable={access.review_reservations!==false} onFinished={onSaved}/>}
        {!init&&approvalRequired&&!desk&&<p className="business-note">승인 대기 중에도 이 차량의 이용 시간이 확보됩니다. 반려하거나 취소하면 같은 시간에 다시 예약할 수 있습니다.</p>}
        {!init&&policy?.error&&<p className="business-note" role="status">승인 정책을 조회하지 못했습니다. 저장 시 회사의 현재 정책이 적용됩니다.</p>}
        {init?.approval_required&&init.status==='planned'&&!locked&&<p className="business-note">예약 내용을 수정하면 다시 승인을 받아야 합니다.</p>}
        <fieldset className="corporate-booking-fields" disabled={busy||locked} aria-busy={busy}>
        <FormField label={desk?'차량 *':'차량'}>
          <select aria-label="예약 차량" value={vehicleAllowed?deviceId:''} onChange={e => {setDeviceId(e.target.value);setDriverId(access.manage_reports?'':access.staff_id);}}>
            {!vehicleAllowed&&<option value="">{desk?'차량을 선택하세요':'예약 가능한 차량 선택'}</option>}
            {options.map(d => (
              <option key={d.id} value={d.id}>
                {reportVehicleLabel(d)}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label={desk?'운전자':'운전자 (선택)'}>
          <select value={driverId} onChange={e => setDriverId(e.target.value)}>
            {access.manage_reports&&<option value="">{desk?'미지정':'— 미지정 —'}</option>}
            {staff.filter(s=>staffCanDrive(s,devices.find(d=>d.id===Number(deviceId)))).map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` (${s.role})` : ''}</option>)}
          </select>
        </FormField>

        {desk?<div className="corporate-booking-wide"><FormField label="이용 구분">
          <Select aria-label="이용 구분" value={reportPurpose} onChange={e=>setReportPurpose(e.target.value)}><option value="">미지정</option><option value="business">업무</option><option value="commute">출퇴근</option><option value="other">기타</option></Select>
        </FormField></div>:<p className="business-note">예약 일시는 한국시간(KST) 기준입니다.</p>}
        {!locked && <FleetBookingHours hintOnly start={startsAt} end={endsAt}
          checkInterval={!init || init.vehicle_id!==Number(deviceId) || isoToLocal(init.starts_at)!==startsAt || isoToLocal(init.ends_at)!==endsAt}/>}
        <div className="business-datetime-fields">
          <FormField label={desk?'시작 시간 *':'시작'}>
            <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} />
          </FormField>
          <FormField label={desk?'종료 시간 *':'종료'}>
            <input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} />
          </FormField>
        </div>

        {!desk&&<FormField label="운행기록부 용무 (선택)">
          <Select value={reportPurpose} onChange={e=>setReportPurpose(e.target.value)}><option value="">미지정</option><option value="commute">출퇴근</option><option value="business">업무</option><option value="other">기타</option></Select>
        </FormField>}
        <CompanyPurposePicker label={desk?'운행목적':undefined} value={companyPurposeId} onChange={setCompanyPurposeId} initialId={init?.company_purpose_id} initialName={init?.company_purpose_name}/>
        <div className="corporate-booking-purpose"><FormField label={desk?'방문 장소 *':'예약 목적'}>
          <input value={purpose} onChange={e => setPurpose(e.target.value)}
            placeholder={desk?'예: A사 본사':'거래처 방문, 외근...'} />
        </FormField></div>
        {desk&&<div className="corporate-booking-wide"><FormField label="목적지 주소">
          <input value={address} maxLength={200} onChange={e => setAddress(e.target.value)} placeholder="예: 서울특별시 강남구 테헤란로 123" />
        </FormField></div>}

        <FormField label={desk?'메모':'메모 (선택)'}>
          <textarea value={note} onChange={e => setNote(e.target.value)}
            placeholder={desk?'동승자나 준비 사항을 남겨 주세요.':'예약 관련 내용을 입력하세요.'} />
        </FormField>
        {desk&&!locked&&<p className="corporate-booking-hint">{!init&&(approvalRequired?'등록하거나 변경한 예약은 관리자 승인 후 이용할 수 있습니다. ':'등록하면 바로 예약이 확정됩니다. ')}예약 일시는 한국시간(KST) 기준입니다.</p>}

        {init?.id && (
          <div className="corporate-editor-field">
            <div className="corporate-editor-label">상태</div>
            <div className="corporate-editor-options">
              {Object.entries(RESV_STATUS).filter(([id])=>init.approval_required?
                (init.status==='pending'?['pending','cancelled']:init.status==='planned'?['planned','in_progress','completed','cancelled']:init.status==='in_progress'?['in_progress','completed','cancelled']:[init.status]).includes(id):
                !['pending','rejected'].includes(id)).map(([id, meta]) => (
                <button className="corporate-editor-option" type="button" key={id} onClick={() => setStatus(id)} aria-pressed={status === id} style={{
                  background: status === id ? meta.color : 'var(--surface-2)',
                  color:      status === id ? 'white'    : 'var(--text)',
                  borderColor: status === id ? meta.color : 'var(--border)',
                }}>{meta.label}</button>
              ))}
            </div>
          </div>
        )}
        </fieldset>
    </Modal>
  );
}

// ─── 월간 리포트 (2026-07-28 Stage-3A) ─────────────────
// 참조: 첨부 이미지 4 (월간 · 업무/개인 분리 · 유류비 추정 · 차량별 bar).
// 데이터: 병렬 listTrips + trip_annotations 로 client-side aggregate.
// 유류비 = km ÷ fuel_efficiency_kmpl × FUEL_PRICE[fuel_type]. 연비 미입력 device 는
// "연비 설정" pill 로 유도. Trip 별 fuel_cost 수기 입력값이 있으면 우선 (annotation.fuel_cost).
//
// 백엔드는 devices.fuel_efficiency_kmpl / fuel_type 컬럼 (migration 0044) + PATCH
// /devices/:id/fuel-info endpoint 만 제공. 유가 상수는 클라이언트 (환경 관계 없이).
// (2026-07-28) Stage-4D: 오피넷 서버 캐시 fetch. useFuelPrices 훅 실패 or 로딩 중이면 이 default.
const DEFAULT_FUEL_PRICE_KRW = {
  gasoline: 1700, diesel: 1600, lpg: 1000, ev: 0, hybrid: 1700, hydrogen: 0,
};
// mutable — useFuelPrices 훅이 채워넣음. estimateFuelCost 는 이걸 참조.
// eslint-disable-next-line prefer-const
let FUEL_PRICE_KRW = { ...DEFAULT_FUEL_PRICE_KRW };
const FUEL_LABEL = {
  gasoline: '휘발유', diesel: '경유', lpg: 'LPG', ev: '전기', hybrid: '하이브리드', hydrogen: '수소',
};

function ymKST(d = new Date()) {
  const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 7);
}
function monthBounds(ym) {
  return monthDateBounds(ym);
}

function MonthlyReportTab({ devices }) {
  const qc=useQueryClient(), {data:staff=[]}=useStaff();
  const reportKey = JSON.stringify(devices.map(d => [d.id, d.vehicle_name, d.car_model, d.asset?.updated_at, d.display_name, d.license_plate, d.fuel_efficiency_kmpl, d.fuel_type, d.model_year, d.engine_cc, d.purchase_price_krw, d.acquired_at, d.department, d.vehicle_type]));
  const reportDevices = useMemo(() => devices, [reportKey]);
  const [ym, setYm] = useState(ymKST());
  const [rows, setRows] = useState(null);   // per-device aggregate
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // 연비 편집 대상 device
  const [tick, setTick] = useState(0);
  const [dlOpen, setDlOpen] = useState(false);    // (2026-07-28) Stage-4C-2 다운로드 다이얼로그
  const [fuelPrices, setFuelPrices] = useState(null);  // (2026-07-28) Stage-4D 오피넷
  // (2026-07-28) Stage-4G 부서 필터. null = 전체. Set<string> = 선택한 부서명 (또는 '(부서없음)').
  const [depFilter, setDepFilter] = useState(null);

  // 오피넷 유가 fetch — mount 시 1회. 실패해도 default 로 fallback.
  // fetch 성공 시 모듈 전역 FUEL_PRICE_KRW 갱신 → estimateFuelCost 즉시 반영.
  useEffect(() => {
    api.getFuelPrices().then(p => {
      setFuelPrices(p);
      FUEL_PRICE_KRW = {
        gasoline: p.gasoline, diesel: p.diesel, lpg: p.lpg, ev: 0, hybrid: p.gasoline, hydrogen: 0,
      };
      setTick(t => t + 1);   // 재계산 트리거
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!reportDevices.length) { setRows([]); setLoading(false); setError(null); return; }
    setLoading(true); setError(null); setRows(null);
    const { from, to } = monthBounds(ym);
    Promise.all(reportDevices.map(d =>
      api.listFleetVehicleTrips(d.id, { from, to })
    )).then(perDevice => {
      if (cancelled) return;
      const out = reportDevices.map((d, i) => {
        const trips = perDevice[i] || [];
        return {
          id: d.id,
          label: reportVehicleLabel(d),
          asset: d.asset,
          fuel_efficiency_kmpl: d.fuel_efficiency_kmpl,
          fuel_type: d.fuel_type,
          // (2026-07-28) Stage-4B-1 국세청 + 우리 전용 필드 (편집 다이얼로그 전달용)
          license_plate:      d.license_plate,
          model_year:         d.model_year,
          engine_cc:          d.engine_cc,
          purchase_price_krw: d.purchase_price_krw,
          acquired_at:        d.acquired_at,
          department:         d.department,
          vehicle_type:       d.vehicle_type,
          ...summarizeMonthlyTrips(trips),
        };
      });
      setRows(out); setLoading(false);
    }).catch(e => {
      if (cancelled) return;
      setError(e.message); setLoading(false);
    });
    return () => { cancelled = true; };
  }, [reportDevices, ym, tick]);

  // (2026-07-28) Stage-4G 부서 목록 (rows 에서 자동 발견) + 부서 필터 적용된 row.
  const departments = useMemo(() => {
    if (!rows) return [];
    const s = new Set();
    for (const r of rows) s.add(r.department || '(부서없음)');
    return Array.from(s).sort();
  }, [rows]);
  const filteredRows = useMemo(() => {
    if (!rows || !depFilter || depFilter.size === 0) return rows;
    return rows.filter(r => depFilter.has(r.department || '(부서없음)'));
  }, [rows, depFilter]);

  // 월간 합계는 부서 필터를 적용한 차량만 포함한다.
  const totals = useMemo(() => {
    const use = filteredRows || rows;
    if (!use) return { totalKm: 0, businessKm: 0, personalKm: 0, fuelCost: 0, depreciation: 0, includedCount: 0, excludedCount: 0 };
    let totalKm = 0, businessKm = 0, personalKm = 0, fuelCost = 0, depreciation = 0, includedCount = 0, excludedCount = 0;
    for (const r of use) {
      includedCount += r.includedCount; excludedCount += r.excludedCount;
      totalKm    += r.totalKm;
      businessKm += r.businessKm;
      personalKm += r.personalKm;
      fuelCost   += estimateFuelCost(r);
      depreciation += estimateDepreciation(r);
    }
    return { totalKm, businessKm, personalKm, fuelCost, depreciation, includedCount, excludedCount };
  }, [rows, filteredRows]);

  const exportGeneration=useRef(0);
  useEffect(()=>{exportGeneration.current++;return ()=>{exportGeneration.current++;};},[reportDevices,ym,depFilter]);
  async function prepareMonthlyExport(format) {
    const generation=exportGeneration.current;
    const {from,to}=monthBounds(ym);
    const selected=reportDevices.filter(d=>!depFilter?.size||depFilter.has(d.department||'(부서없음)'));
    const perVehicle=await Promise.all(selected.map(d=>api.listFleetVehicleTrips(d.id,{from,to,download:format})));
    if(generation!==exportGeneration.current)throw new Error('조회 조건이 바뀌었습니다. 다시 내려받아 주세요.');
    const fresh=selected.map((d,i)=>({...d,label:reportVehicleLabel(d),...summarizeMonthlyTrips(perVehicle[i]||[])}));
    return subjectReport(monthlyReport(fresh,{month:ym,estimateFuelCost,estimateDepreciation}),perVehicle.some(t=>t.subjectScope));
  }
  const fmtKm = n => monthlyDistance(n, totals.includedCount);
  const fmtWon = (n) => n.toLocaleString() + '원';

  return (
    <div className="corporate-monthly-page">
      <div className="corporate-report-controls no-print">
      <div className="corporate-report-control-row">
        <input aria-label="월간 조회월" type="month" value={ym} onChange={e => setYm(e.target.value || ymKST())}/>
        <details className="corporate-report-menu corporate-monthly-departments">
          <summary><Icon name="filter" size={13}/> 부서{depFilter?.size ? ` (${depFilter.size})` : ' 전체'}</summary>
          <div className="corporate-report-menu-body">
            <label className="corporate-report-check"><input type="checkbox" checked={!depFilter?.size} onChange={()=>setDepFilter(null)}/>전체 부서</label>
            {departments.map(dep=><label className="corporate-report-check" key={dep}><input type="checkbox" checked={!!depFilter?.has(dep)} onChange={()=>setDepFilter(prev=>{const next=new Set(prev??[]);if(next.has(dep))next.delete(dep);else next.add(dep);return next.size?next:null;})}/>{dep} ({(rows||[]).filter(r=>(r.department||'(부서없음)')===dep).length})</label>)}
          </div>
        </details>
        <FuelPriceBadge prices={fuelPrices} />
        <details className="corporate-report-menu corporate-report-download">
        <summary><Icon name="download" size={13}/> 다운로드</summary>
        <div className="corporate-report-menu-body">
        <BusinessButton icon="download" onClick={() => setDlOpen(true)}>운행기록부 엑셀(XLSX)</BusinessButton>
        <ExportButtons prepareExport={prepareMonthlyExport} report={filteredRows ? monthlyReport(filteredRows,{month:ym,estimateFuelCost,estimateDepreciation}) : null} disabled={loading || !!error} />
        </div>
        </details>
      </div>
      <div className="corporate-monthly-totals" aria-label="월간 운행 합계">
        <span>총 주행거리<strong>{loading || error ? '—' : fmtKm(totals.totalKm)}<small>km</small></strong></span>
        <span>업무거리<strong>{loading || error ? '—' : fmtKm(totals.businessKm)}<small>km</small></strong></span>
        <span>기타·미분류 거리<strong>{loading || error ? '—' : fmtKm(totals.personalKm)}<small>km</small></strong></span>
        <span>유류비 추정<strong>{loading || error ? '—' : fmtWon(Math.round(totals.fuelCost))}</strong></span>
        <span>감가상각 인정<strong>{loading || error ? '—' : fmtWon(Math.round(totals.depreciation))}</strong></span>
      </div>
      </div>
      <div className="corporate-monthly-notes">
        <span>{!loading && !error ? `차량 ${filteredRows?.length ?? 0}대 · 확정 ${totals.includedCount}건 · 합계 제외 ${totals.excludedCount}건` : '월간 운행 집계'}</span>
        <details><summary>계산 기준</summary><p>미확정 거리는 합계에서 제외하며 입력한 주유비는 유지합니다. 유류비 추정은 연비 미입력 차량을 제외합니다. 감가상각 인정액은 5년 정액법 × 업무비율 기준이며 연 800만원 한도를 표시합니다.</p></details>
      </div>

      <>{error && <BusinessError onRetry={() => setTick(t => t + 1)}>일부 차량의 운행기록을 불러오지 못해 월간 합계를 표시하지 않았습니다.</BusinessError>}</>
      {loading && !rows && <div style={st.muted}>월간 데이터 로딩 중...</div>}
      {rows && rows.length === 0 && <div style={st.muted}>차량이 없습니다.</div>}

      {rows && rows.length > 0 && (
        <div className="corporate-monthly-ledger">
          {(filteredRows || rows).length === 0 && (
            <div style={st.muted}>선택한 부서에 차량이 없습니다.</div>
          )}
          <div className="corporate-monthly-table-scroll" role="region" aria-label="월간 운행 요약 목록 · 좌우 스크롤" tabIndex={0}>
          <table className="corporate-monthly-table"><thead><tr><th>차량</th><th>부서</th><th>운행 상태</th><th>총 주행거리</th><th>업무거리 · 비율</th><th>기타·미분류</th><th>유류비 추정</th><th>감가상각 인정</th><th>관리</th></tr></thead><tbody>
          {(filteredRows || rows).map(r => (
            <MonthlyDeviceRow key={r.id} row={r} onEdit={() => setEditing(r)} />
          ))}
          </tbody></table>
          </div>
          <div className="corporate-monthly-footer">{(filteredRows || rows).length}대 · {ym} 월간 운행 요약</div>
        </div>
      )}

      {editing && (
        <FleetAssetForm asset={editing.asset} staff={staff}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); qc.invalidateQueries({queryKey:fleetAssetsKey}); setTick(t => t + 1); }} />
      )}

      {dlOpen && (
        <DownloadDialog ym={ym} devices={devices}
          initialDepartments={depFilter ? Array.from(depFilter) : null}
          onClose={() => setDlOpen(false)} />
      )}
    </div>
  );
}

// (2026-07-28) Stage-4D: 유가 배지 — 오피넷 실 데이터 or fallback 표시.
function FuelPriceBadge({ prices }) {
  const isLive = prices?.source === 'opinet';
  const at = prices?.updated_at ? new Date(prices.updated_at).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' }) : '';
  return (
    <div className="corporate-monthly-fuel-prices" style={{
      marginLeft: 'auto',
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 10px', borderRadius: 8,
      background: isLive
        ? 'color-mix(in srgb, var(--accent) 10%, transparent)'
        : 'var(--surface-2)',
      fontSize: 10, color: 'var(--text-2)',
    }}
    title={isLive ? `오피넷 실시간 (${at})` : '기준 유가 적용'}>
      <span style={{
        width: 6, height: 6, borderRadius: '50%',
        background: isLive ? 'var(--accent)' : 'var(--text-3)',
      }} />
      <span style={{ fontWeight: 700 }}>유가</span>
      {prices ? (
        <>
          <span>휘{Math.round(prices.gasoline).toLocaleString()}</span>
          <span>·경{Math.round(prices.diesel).toLocaleString()}</span>
          <span>·L{Math.round(prices.lpg).toLocaleString()}</span>
          {isLive && <span style={{ color: 'var(--accent)', fontWeight: 700 }}>실시간</span>}
        </>
      ) : (
        <span style={{ color: 'var(--text-3)' }}>로딩...</span>
      )}
    </div>
  );
}

// (2026-07-28) Stage-4C-2: 운행일지 다운로드 다이얼로그.
// 이미지 1 (cartax) 스타일: 양식 선택 + 차량 선택 + 기간 + 운행목적 필터.
// 백엔드 /corporate/report.xlsx?type=&month=&device_ids=&purposes= 로 전송.
const PURPOSE_ALL = [
  { id: 'business',    label: '업무' },
  { id: 'commute',     label: '출퇴근' },
  { id: 'other',       label: '기타' },
  { id: 'unspecified', label: '미지정' },
];

function DownloadDialog({ ym, devices, initialDepartments, initialVehicleIds, sourcePeriod, onClose }) {
  const companyInfo = useCorporateInfo({refetchOnMount:'always'});
  const access = useFleetAccess();
  const [kind, setKind] = useState('nts');
  const [exportMonth, setExportMonth] = useState(ym);
  // null = 전체. Set<number> = 선택 차량 id.
  const [selectedDevs, setSelectedDevs] = useState(() => initialVehicleIds ? new Set(initialVehicleIds) : null);
  // null = 전체. Set<string> = 선택 목적.
  const [selectedPurps, setSelectedPurps] = useState(null);
  // null = 전체. Set<string> = 선택 부서. (Stage-4G, MonthlyReport 부서 필터 초기값 승계)
  const [selectedDeps, setSelectedDeps] = useState(initialDepartments ? new Set(initialDepartments) : null);
  const [busy, setBusy] = useState(false);
  const [downloadError, setDownloadError] = useState('');
  const busyRef = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { setDownloadError(''); }, [kind, exportMonth, selectedDevs, selectedDeps, selectedPurps]);

  const departmentOptions = useMemo(() => {
    const s = new Set();
    for (const d of devices || []) s.add(d.department || '(부서없음)');
    return Array.from(s).sort();
  }, [devices]);

  const isAllDev = selectedDevs == null;
  const applicableVehicles = (devices || []).filter(d => (selectedDevs == null || selectedDevs.has(d.id))
    && (selectedDeps == null || selectedDeps.has(d.department || '(부서없음)')));
  const entered = value => typeof value === 'string' && value.trim().length > 0;
  const companyChecking = Boolean(companyInfo.isPending || companyInfo.isFetching || (!companyInfo.error && companyInfo.data === undefined));
  const companyFailed = !companyChecking && Boolean(companyInfo.error);
  const missingCompany = companyChecking || companyFailed ? [] : [['company_name','회사명'],['business_number','사업자등록번호']]
    .filter(([key])=>!entered(companyInfo.data?.[key])).map(([,label])=>label);
  const missingVehicles = applicableVehicles.map(d=>({id:d.id,label:reportVehicleLabel(d),missing:[
    !entered(d.car_model ?? d.asset?.car_model) && '차종',
    ![d.car_plate,d.license_plate,d.asset?.license_plate].some(entered) && '차량번호',
  ].filter(Boolean)})).filter(d=>d.missing.length);
  const metadataMissing = missingCompany.length > 0 || missingVehicles.length > 0;
  const monthError = reportMonthError(exportMonth);
  const validationError = monthError
    || (!devices?.length ? '다운로드할 차량이 없습니다. 차량을 등록한 뒤 다시 시도해 주세요.' : '')
    || (selectedDevs?.size === 0 ? '차량을 하나 이상 선택해 주세요.' : '')
    || (selectedDeps?.size === 0 ? '부서를 하나 이상 선택해 주세요.' : '')
    || (selectedPurps?.size === 0 ? '운행목적을 하나 이상 선택해 주세요.' : '')
    || (!applicableVehicles.length ? '선택한 차량과 부서에 함께 해당하는 차량이 없습니다. 차량 또는 부서 선택을 확인해 주세요.' : '');

  function toggleDev(id) {
    setSelectedDevs(prev => {
      const s = new Set(prev ?? []);
      if (s.has(id)) s.delete(id); else s.add(id);
      return s;
    });
  }
  function togglePurp(p) {
    setSelectedPurps(prev => {
      const s = new Set(prev ?? []);
      if (s.has(p)) s.delete(p); else s.add(p);
      return s;
    });
  }

  async function download() {
    if (busyRef.current || validationError) return;
    busyRef.current = true;
    setBusy(true);
    setDownloadError('');
    try {
      const params = { type: kind, month: exportMonth };
      params.scope='vehicles';
      if (selectedDevs) params.vehicle_ids = Array.from(selectedDevs);
      if (selectedPurps && selectedPurps.size < PURPOSE_ALL.length) {
        params.purposes = Array.from(selectedPurps);
      }
      if (selectedDeps) {
        params.departments = Array.from(selectedDeps);
      }
      const { blob, filename } = await api.reportXlsx(params);
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (e) {
      if (mounted.current) setDownloadError(e.message || '파일을 생성하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <Modal open title="운행기록부 XLSX 다운로드" size={900} onClose={busy ? undefined : onClose} footer={
      <div className="corporate-export-footer">
        <p className="corporate-export-summary" role="status">{exportMonth || '월 미선택'} · 적용 차량 {applicableVehicles.length}대 · {kind === 'nts' ? '업무용승용차 운행기록부' : '우리 양식'}</p>
        {(validationError || downloadError) && <p className="corporate-export-error" role="alert">{validationError || downloadError}</p>}
        {downloadError && !validationError && <p className="business-note">선택한 조건을 유지했습니다. 연결 상태를 확인한 뒤 다시 다운로드해 주세요.</p>}
        <div className="corporate-export-actions">
          <button onClick={onClose} disabled={busy} style={{ ...st.btnGhost, flex: 1 }}>취소</button>
          <button onClick={download} disabled={busy || !!validationError} style={{ ...st.btnPrimary, flex: 2, padding: '12px', fontSize: 18, gap: 8 }}>
            <Icon name="share" size={14} />{busy ? '생성 중...' : downloadError ? '다시 다운로드' : 'XLSX 다운로드'}
          </button>
        </div>
      </div>
    }>
      <div className="corporate-export-dialog">
        <div>
          <div style={{ fontSize: 22, fontWeight: 800 }}>운행일지 다운로드</div>
          <div style={{ fontSize: 16, color: 'var(--text-3)', marginTop: 3 }}>
            {exportMonth || '월 미선택'} · 적용 차량 {applicableVehicles.length}대 · XLSX
          </div>
        </div>

        {sourcePeriod && <div className="business-note" role="note">
          <p>화면 조회기간({sourcePeriod.from} ~ {sourcePeriod.to})과 별도로, 선택한 월의 전체 기간을 엑셀로 내보냅니다.</p>
          <p>운전자·최소 운행시간·미작성·미확정 필터는 적용하지 않습니다. 차량·부서·운행목적은 아래 선택을 사용합니다.</p>
        </div>}

        <fieldset className="corporate-export-fields" aria-label="엑셀 다운로드 조건" disabled={busy} aria-busy={busy}>
        {/* 양식 */}
        <FieldSection label="양식">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%,240px), 1fr))', gap: 8 }}>
            {[
              { id: 'nts',  title: '업무용승용차 운행기록부', hint: '첨부 서식 항목 · 저장된 계기판 거리 반영' },
              { id: 'ours', title: '우리 양식',         hint: '요약 + 차량별 상세 · 실무용' },
            ].map(o => {
              const on = kind === o.id;
              return (
                <button key={o.id} onClick={() => setKind(o.id)} style={{
                  padding: '18px', borderRadius: 4, cursor: 'pointer',
                  textAlign: 'left', border: '2px solid ' + (on ? 'var(--primary)' : 'var(--border)'),
                  background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface)',
                }}>
                  <div style={{ fontWeight: 700, fontSize: 18, color: on ? 'var(--primary)' : 'var(--text)' }}>
                    {o.title}
                  </div>
                  <div style={{ fontSize: 16, color: 'var(--text-3)', marginTop: 3 }}>{o.hint}</div>
                </button>
              );
            })}
          </div>
        </FieldSection>

        {/* 차량 */}
        <FieldSection label="차량" trailing={
          <button onClick={() => setSelectedDevs(isAllDev ? new Set() : null)}
            style={{ ...st.btnGhost, fontSize: 16 }}>
            {isAllDev ? '개별 선택' : '전체'}
          </button>
        }>
          {isAllDev ? (
            <div style={{
              padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 8,
              fontSize: 18, color: 'var(--text-2)',
            }}>
              전체 {devices?.length || 0}대
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 260, overflowY: 'auto' }}>
              {(devices || []).map(d => {
                const on = selectedDevs?.has(d.id);
                return (
                  <label className="corporate-export-choice" key={d.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '12px 16px', borderRadius: 8, cursor: 'pointer',
                    background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface-2)',
                  }}>
                    <input type="checkbox" checked={!!on} onChange={() => toggleDev(d.id)} />
                    <span style={{ fontSize: 18, fontWeight: 600 }}>
                      {reportVehicleLabel(d)}
                    </span>
                    {d.department && (
                      <span style={{ fontSize: 16, color: 'var(--text-3)' }}>· {d.department}</span>
                    )}
                  </label>
                );
              })}
              <div style={{ fontSize: 16, color: 'var(--text-3)', paddingLeft: 12 }}>
                {selectedDevs?.size || 0} / {devices?.length || 0} 선택
              </div>
            </div>
          )}
        </FieldSection>

        {/* 운행기록부에서는 시작월을 기본으로 선택하고, 월간 요약에서는 조회월을 유지. */}
        <FieldSection label="기간">
          {sourcePeriod ? <label style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
            <span>다운로드 월</span><input aria-label="엑셀 다운로드 월" type="month" min="2000-01" max="2100-12" value={exportMonth} aria-invalid={!!monthError}
              onChange={e => setExportMonth(e.target.value)} style={st.dateInput} />
            <span className="business-note">선택한 월의 1일부터 말일까지</span>
          </label> :
          <div style={{
            padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 8,
            fontSize: 18, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Icon name="clock" size={12} />
            {exportMonth} (한 달)
            <span style={{ marginLeft: 'auto', fontSize: 16, color: 'var(--text-3)' }}>
              다른 달은 리포트 상단 월 선택으로 변경
            </span>
          </div>}
        </FieldSection>

        {/* (Stage-4G) 부서 — 부서 옵션이 2개 이상일 때만 표시 */}
        {(departmentOptions.length >= 2 || selectedDeps != null) && (
          <FieldSection label="부서" trailing={
            <button onClick={() => setSelectedDeps(prev => prev == null ? new Set() : null)}
              style={{ ...st.btnGhost, fontSize: 16 }}>
              {selectedDeps == null ? '개별 선택' : '전체'}
            </button>
          }>
            {selectedDeps == null ? (
              <div style={{
                padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 8,
                fontSize: 18, color: 'var(--text-2)',
              }}>
                전체 {departmentOptions.length}개 부서
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%,180px), 1fr))', gap: 4 }}>
                {departmentOptions.map(dep => {
                  const on = selectedDeps?.has(dep);
                  return (
                    <label className="corporate-export-choice" key={dep} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '12px 16px', borderRadius: 8, cursor: 'pointer',
                      background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface-2)',
                      fontSize: 18, fontWeight: 600,
                    }}>
                      <input type="checkbox" checked={!!on} onChange={() => setSelectedDeps(prev => {
                        const s = new Set(prev ?? []);
                        if (s.has(dep)) s.delete(dep); else s.add(dep);
                        return s;
                      })} />
                      {dep}
                    </label>
                  );
                })}
              </div>
            )}
          </FieldSection>
        )}

        {/* 운행목적 */}
        <FieldSection label="운행목적" trailing={
          <button onClick={() => setSelectedPurps(prev => prev == null ? new Set() : null)}
            style={{ ...st.btnGhost, fontSize: 16 }}>
            {selectedPurps == null ? '개별 선택' : '전체'}
          </button>
        }>
          {selectedPurps == null ? (
            <div style={{
              padding: '14px 16px', background: 'var(--surface-2)', borderRadius: 8,
              fontSize: 18, color: 'var(--text-2)',
            }}>
              전체 (업무·출퇴근·기타·미지정)
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 4 }}>
              {PURPOSE_ALL.map(p => {
                const on = selectedPurps?.has(p.id);
                return (
                  <label className="corporate-export-choice" key={p.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '12px 16px', borderRadius: 8, cursor: 'pointer',
                    background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface-2)',
                    fontSize: 18, fontWeight: 600,
                  }}>
                    <input type="checkbox" checked={!!on} onChange={() => togglePurp(p.id)} />
                    {p.label}
                  </label>
                );
              })}
            </div>
          )}
        </FieldSection>

        {kind === 'nts' && <p className="business-note">저장된 주행 전·후 계기판 거리의 차이를 우선 사용합니다. 계기판이 미입력된 운행은 GPS 계산 또는 검토·보정된 운행기록 거리를 사용하며 파일에 기준을 표시합니다. 계기판 값은 운행 기록 수정에서 입력할 수 있습니다. 사용자 부서는 운전자 배정 당시 기록을 사용하므로 실제 차량 이용자가 다르면 파일의 사용자 성명·부서를 보완해 주세요. 과세기간도 확인해 주세요. 종료 미수신 등 미확정 운행은 합계에서 제외됩니다.</p>}
        </fieldset>
        <section className="corporate-export-readiness" aria-label="다운로드 전 정보 확인" aria-busy={companyChecking}>
          <header><h3>다운로드 전 정보 확인</h3><span>선택 차량 {applicableVehicles.length}대 기준</span></header>
          {!applicableVehicles.length ? <p>차량을 선택하면 회사·차량의 누락 정보를 확인할 수 있습니다.</p> : <>
            {companyChecking ? <p role="status">회사 정보를 확인하는 중입니다. 아직 회사 정보의 누락 여부를 확인하지 못했습니다.</p>
              : companyFailed ? <div className="corporate-export-company-error" role="alert"><p>회사 정보를 불러오지 못해 회사명·사업자등록번호의 누락 여부를 확인하지 못했습니다.</p>{companyInfo.refetch&&<BusinessButton disabled={busy} onClick={()=>companyInfo.refetch()}>회사 정보 다시 조회</BusinessButton>}</div>
              : missingCompany.length > 0 && <p className="corporate-export-missing-company"><strong>회사 정보 미입력</strong><span>{missingCompany.join(' · ')}</span></p>}
            {missingVehicles.length > 0 && <div className="corporate-export-missing-vehicles" role="region" aria-label="선택 차량의 미입력 항목" tabIndex={0}><table><thead><tr><th scope="col">차량</th><th scope="col">미입력 항목</th></tr></thead><tbody>{missingVehicles.map(d=><tr key={d.id}><td>{d.label}</td><td>{d.missing.join(' · ')}</td></tr>)}</tbody></table></div>}
            {!companyChecking&&!companyFailed&&!metadataMissing&&<p role="status">회사명·사업자등록번호와 선택한 차량의 차종·차량번호가 입력되어 있습니다.</p>}
            {(metadataMissing||companyChecking||companyFailed)&&<p className="corporate-export-readiness-note">다운로드는 가능합니다. 미입력 정보는 비어 있을 수 있으니 파일을 사용하기 전에 확인·보완해 주세요.</p>}
            {(missingCompany.length>0||companyFailed)&&<p className="corporate-export-repair-guide">회사 정보는 <strong>시스템 설정 → 회사 정보</strong>에서 보완하세요.{!access.manage_team&&' 수정 권한이 있는 회사 관리자에게 요청할 수 있습니다.'}</p>}
            {missingVehicles.length>0&&<p className="corporate-export-repair-guide">차량 정보는 <strong>차량 → 차량 관리 → 차량 선택 → 차량·점검 정보 수정</strong>에서 보완하세요.{!access.manage_vehicles&&' 수정 권한이 있는 회사 관리자에게 요청할 수 있습니다.'}</p>}
          </>}
        </section>
      </div>
    </Modal>
  );
}

function FieldSection({ label, trailing, children }) {
  return (
    <div className="corporate-export-section">
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 16, fontWeight: 600, color: 'var(--text-2)', marginBottom: 10, gap: 12, flexWrap: 'wrap',
        letterSpacing: '0.04em', textTransform: 'uppercase',
      }}>
        <span>{label}</span>
        {trailing}
      </div>
      {children}
    </div>
  );
}

function estimateFuelCost(r) {
  // 사용자가 직접 trip_annotations 에 입력한 비용이 있으면 그것 우선.
  if (r.annotationCost > 0) return r.annotationCost;
  if (!r.fuel_efficiency_kmpl || !r.fuel_type) return 0;
  const price = FUEL_PRICE_KRW[r.fuel_type] ?? 0;
  if (price === 0) return 0;
  return (r.totalKm / r.fuel_efficiency_kmpl) * price;
}

// (2026-07-28) Stage-4E: 감가상각 인정액 (월 · 업무비율 반영).
// 국세청 기준: 5년 정액법 (연 20%). 잔존가액 없음.
//   월 감가상각액 = 취득가액 / 5년 / 12월
//   인정 감가상각 = 월 감가상각 × 업무비율
// 참고: 800만원/년 한도 (2020년 세법 개정) 이월 규정은 복잡 → 하이라이트만 표시.
const YEARLY_BIZ_LIMIT_KRW = 8_000_000;   // 연 800만원 한도 (참고)
function estimateDepreciation(r) {
  if (!r.purchase_price_krw || r.purchase_price_krw <= 0) return 0;
  const monthlyDep = r.purchase_price_krw / 5 / 12;
  const total = r.totalKm || 0;
  const bizRate = total > 0 ? (r.businessKm / total) : 0;
  return monthlyDep * bizRate;
}

function MonthlyDeviceRow({ row, onEdit }) {
  const access=useFleetAccess();
  const cost=estimateFuelCost(row),dep=estimateDepreciation(row);
  const {business:bizPct,other:perPct}=monthlyPercentages(row);
  const fmtKm=n=>monthlyDistance(n,row.includedCount);
  const overLimit=dep>(YEARLY_BIZ_LIMIT_KRW/12);
  return <tr>
    <td><strong>{row.label}</strong><details className="corporate-monthly-vehicle-info"><summary>차량 정보</summary><div>
      {row.license_plate&&<span>{row.license_plate}</span>}
      <span>{row.fuel_efficiency_kmpl?`${FUEL_LABEL[row.fuel_type]||'?'} · ${row.fuel_efficiency_kmpl}km/L`:'연비 미입력'}</span>
      {row.model_year&&<span>{row.model_year}년식</span>}{row.engine_cc>0&&<span>{row.engine_cc.toLocaleString()}cc</span>}
      {row.annotationCount>0&&<span>실 입력비 반영</span>}
    </div></details></td>
    <td>{row.department||'—'}</td>
    <td><span className="corporate-monthly-record-status">{monthlyStatus(row)}</span></td>
    <td className="number">{fmtKm(row.totalKm)} km</td>
    <td className="number">{fmtKm(row.businessKm)} km<small>{bizPct==null?'확정 거리 없음':bizPct+'%'}</small></td>
    <td className="number">{fmtKm(row.personalKm)} km<small>{perPct==null?'비율 산정 제외':perPct+'%'}</small></td>
    <td className="number">{cost>0?Math.round(cost).toLocaleString()+'원':'—'}{row.annotationCount>0&&<small>실 입력비 반영</small>}</td>
    <td className="number">{row.purchase_price_krw>0?<><span>{Math.round(dep).toLocaleString()}원</span><small>{bizPct==null?'확정 거리 없음':'월 '+Math.round(row.purchase_price_krw/60).toLocaleString()+' × '+bizPct+'%'}</small>{overLimit&&<small className="corporate-monthly-limit" title="연 800만원 한도 초과분은 이월 처리">한도 초과</small>}</>:'—'}</td>
    <td><BusinessButton disabled={!access.manage_vehicles} onClick={onEdit}>정보 편집</BusinessButton></td>
  </tr>;
}

// (2026-07-28) Stage-4B-1: FuelInfoDialog → VehicleInfoDialog 로 확장.
// 국세청 별지 제73호 헤더 필드 (번호판/연식/배기량/취득가액/취득일) + 우리 전용 (부서/차종)
// + 연비/연료 (Stage-3A) 을 한 화면에서 편집. 저장 시 두 endpoint (fuel-info, vehicle-info)
// 를 병렬 호출 (별개 트랜잭션이지만 UX 는 한 번의 저장).
const VEHICLE_TYPE_LABEL = { sedan: '승용', van: '승합', truck: '화물', special: '특수', ev: '전기' };

function FleetSummary({ devices }) {
  const s = useFleetStats(devices);
  const fmt = (n) => (n == null ? '–' : n.toLocaleString());
  return (
    <div className="no-print">
      <StatCardGrid>
        <StatCard icon="list"   label="전체 차량"       value={fmt(s.totalCount)} unit="대" tone="default" loading={s.loading} />
        <StatCard icon="route"  label="최근 통신"       value={fmt(s.connectedCount)} unit="대" tone="success" loading={s.loading} />
        <StatCard icon="mapPin" label="오늘 운행거리"   value={s.error ? '—' : fmt(s.todayKm)} unit="km" tone="primary" loading={s.loading} />
        <StatCard icon="bar"    label="이번달 운행거리" value={s.error ? '—' : fmt(s.monthKm)} unit="km" tone="default" loading={s.loading} />
      </StatCardGrid>
      {s.error && <BusinessError onRetry={s.refetch}>운행 통계를 불러오지 못했습니다.</BusinessError>}
    </div>
  );
}

// ─── 공용 sub-컴포넌트 ─────────────────────────────────
function Card({ title, children }) {
  return (
    <div style={st.card}>
      {title && <div style={st.cardTitle}>{title}</div>}
      {children}
    </div>
  );
}

// 사용처 두 군데:
//  1) value/onChange 받으면 단순 input (info/staff form 용)
//  2) children 받으면 children 그대로 (TripEditorModal 의 복합 필드용)
function Field({ label, value, onChange, placeholder, children }) {
  return (
    <div className="corporate-editor-field">
      <div className="corporate-editor-label">{label}</div>
      {children != null ? children : (
        <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          style={st.input} />
      )}
    </div>
  );
}

function kstDate(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function kstTime(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(11, 16);
}

const st = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  tabBar: {
    display: 'flex', overflowX: 'auto', flexShrink: 0,
    background: 'var(--surface)', borderBottom: '1px solid var(--border)',
  },
  tabBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '10px 14px', fontSize: 12, cursor: 'pointer',
    background: 'transparent', border: 'none',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 },
  card: {
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 10, padding: 12, marginBottom: 10,
  },
  cardTitle: {
    fontWeight: 700, fontSize: 11, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8,
  },
  // (2026-07-28) 트렌디 리팩터 — 넓은 카드 + 헤더 (Staff/Info tab 등 재사용)
  sectionCard: {
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 14, overflow: 'hidden',
  },
  sectionCardHeader: {
    padding: '12px 16px', borderBottom: '1px solid var(--border)',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    fontSize: 13, fontWeight: 700, color: 'var(--text)',
    background: 'var(--surface-2)',
  },
  input: {
    display: 'block', width: '100%', padding: '8px 10px',
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', fontSize: 13, boxSizing: 'border-box',
  },
  controls: {
    display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
    marginBottom: 12, padding: '0 4px',
  },
  filters: {
    display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
    marginBottom: 12, padding: '0 4px',
  },
  select: {
    flex: 1, minWidth: 160, padding: '8px 10px',
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6, fontSize: 13,
  },
  dateInput: {
    padding: '7px 10px', fontSize: 13,
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
  },
  btnPrimary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '8px 14px',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 6, cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
  },
  btnGhost: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '6px 10px', fontSize: 11,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
  },
  reportArea: {
    background: 'var(--surface)', padding: 16,
    border: '1px solid var(--border)', borderRadius: 8,
  },
  reportHead: { marginBottom: 16 },
  headerTable: {
    width: '100%', borderCollapse: 'collapse', fontSize: 12,
  },
  tripsTableScroll: {
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    marginTop: 8,
  },
  tripsTable: {
    width: '100%', minWidth: 720,
    borderCollapse: 'collapse', fontSize: 11,
  },
  th: {
    background: 'var(--surface-2)', fontWeight: 700,
    padding: '6px 8px', textAlign: 'left',
    border: '1px solid var(--border)', whiteSpace: 'nowrap',
  },
  td: {
    padding: '6px 8px', border: '1px solid var(--border)',
    verticalAlign: 'top',
  },
  muted: { color: 'var(--text-3)', fontSize: 12, padding: 16, textAlign: 'center' },
};

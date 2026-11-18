import {saveBlob} from '../lib/fileDownload';
import { subjectReport, subjectScopeNote } from '../lib/subjectReport';
import {summarizeMonthlyTrips,monthlyDistance,monthlyPercentages,monthlyStatus} from '../lib/monthlySummary';
import FleetIncompleteTrips from './business/FleetIncompleteTrips';
import {tripNeedsDetails} from '../lib/incompleteTrips';
import TripQualitySummary from './business/TripQualitySummary';
import {TripEvidence,TripCorrection,TripCorrectionHistory} from './business/FleetTripQuality';
import {qualityLabel,reportIncluded,tripTimeRange} from '../lib/tripQuality';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';
import ExportButtons from './business/ExportButtons';
import StaffTab from './business/FleetPeople';
import {CompanySubjectMappings} from './SubjectProvision';
import FleetSites from './business/FleetSites';
import FleetExpenses from './business/FleetExpenses';
import {TripAssignmentModal,TripRulesModal,TripAssignmentHistory} from './business/FleetTripAssignments';
import {tripAssignmentKey,canAssignTrip} from '../lib/tripAssignments';
import {FleetAccountScope,useFleetAccess,staffCanDrive} from './business/FleetAccess';
import { BusinessCompanyInfo as InfoTab, BusinessSubscription as SubTab } from './business/BusinessPreferences';
import { filterTrips, tripReport, tripDistance, monthlyReport, monthDateBounds, purposeLabel } from '../lib/businessExport';
import { BusinessWorkspace, BusinessLocation, useBusinessVehicle, BusinessButton, BusinessError, BusinessEmpty, BusinessSection, BusinessMetrics, BusinessTask, BusinessSettings, BusinessVehicles } from './business/BusinessWorkspace';
import { tripCompleteness } from '../lib/businessWorkspace';
import { corporateAttention, corporateVehicleName, terminalName, missingMaintenance } from '../lib/corporateOverview';
import { corporateGroups, corporateTabs } from '../lib/corporateNavigation';
import { ntsTripReport, reportVehicleLabel } from '../lib/ntsReport';
import { validateOdometerInput, odometerSummary } from '../lib/tripOdometer';
import { classifyDevice, ageString } from '../colors';
import { deviceBattery } from '../lib/battery';
import { kstDateTime } from '../lib/businessExport';
import { useBusinessClock, useBusinessSubscription } from './business/useBusinessData';
import { calendarDate, businessDate, businessPeriod, maintenanceTasks, vehicleName } from '../lib/business';
import { confirmDialog, alertDialog } from './Dialog';
import { StatCard, StatCardGrid } from './shared/StatCard';
import {FleetAssets,FleetAssetForm,FleetAssetDetail,useFleetAssets,projectFleetAssets,fleetAssetsKey,useAssetStats as useFleetStats,useFleetReservations as useReservations,useCreateFleetReservation as useCreateReservation,useUpdateFleetReservation as useUpdateReservation,useCancelFleetReservation as useDeleteReservation} from './business/FleetAssets';
import { Modal, FormField, Input, Select, Textarea, Button, SkeletonList } from './ui';
import {
  useCorporateInfo, useStaff,
  qk,
} from '../state';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import './business/corporate-console.css';
import './business/corporate-trips-cartax.css';
import './business/directory-layout.css';

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

function CorporatePanel({ devices: personalDevices, onMap: personalMap, onDevice, onVehiclesChange, onNavigate, globalNavigation, meta: personalMeta, toolbar }) {
  const access=useFleetAccess();
  const terminals=useQuery({queryKey:['fleet-terminals'],queryFn:()=>api.fleetTerminals(),refetchInterval:30000,structuralSharing:false});
  const subjectScoped=Boolean(terminals.data?.subjectScope);
  const rawDevices=terminals.data||[],rawMeta=access.billing&&!subjectScoped?personalMeta:{},rawOnMap=access.billing&&!subjectScoped?personalMap:undefined;
  const assets=useFleetAssets();
  const terminalsReady=!terminals.isPending&&!terminals.error;
  const vehiclesReady=!assets.isPending&&!assets.error;
  const devices=useMemo(()=>vehiclesReady&&terminalsReady?projectFleetAssets(assets.data||[],rawDevices):[],[vehiclesReady,terminalsReady,assets.data,rawDevices]);
  const meta=Object.fromEntries(devices.map(d=>[d.id,rawMeta?.[d.source_device_id]]));
  const onMap=id=>{const sim=devices.find(v=>v.id===id)?.source_device_id;if(sim)rawOnMap?.(sim);};
  const [editAsset,setEditAsset]=useState(null);
  const staff=useStaff();
  const [tab, setTab] = useState('overview');
  const [sectionTabs,setSectionTabs] = useState({staff:'users',sites:'sites',settings:'company'});
  const selectSection = value => setSectionTabs(previous=>({...previous,[tab]:value}));
  const sectionNavigation = {
    staff: [['users','사용자 목록'],['organization','부서·직책'],...(access.manage_team?[['audit','변경 이력']]:[])],
    sites: [['sites','지점 목록'],['visits','방문 기록'],...(access.manage_team?[['groups','그룹 관리']]:[])],
    settings: [['company','회사 정보'],['subscription','이용권 관리']],
  };
  const [request, setRequest] = useState(null);
  const [reportDevice, setReportDevice] = useState(null);
  const [reportFilter,setReportFilter]=useState(null);
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
  return <BusinessWorkspace renderVehicleDetail={(device,close)=><FleetAssetDetail meta={meta[device.id]} asset={device.asset} devices={rawDevices} onClose={close} onChanged={assets.refetch} onEdit={()=>{close();setEditAsset(device.asset);}} onMap={rawOnMap} onReport={report}/>} title="법인차 운영" tabs={corporateTabs} groups={corporateGroups} tab={tab} onTab={value => { setRequest(null); setReportFilter(null); setTab(value); }} devices={devices} kind="corporate" onMap={onMap} onVehicleAction={report} onManageVehicle={onDevice} onNavigate={onNavigate} onVehiclesChange={onVehiclesChange} meta={meta}
    toolbar={toolbar} globalNavigation={globalNavigation}
    headerNavigation={sectionNavigation[tab]&&<nav className="business-subnav no-print" aria-label={`${corporateTabs.find(item=>item.id===tab)?.label} 하위 메뉴`}>{sectionNavigation[tab].map(([id,label])=><button type="button" className="business-subnav-item" key={id} aria-current={sectionTabs[tab]===id?'page':undefined} onClick={()=>selectSection(id)}>{label}</button>)}</nav>}
    mobileAction={<BusinessButton icon="user" onClick={()=>setTab('staff')}>사용자</BusinessButton>}
    >
    {subjectScoped && tab!=='report' && <p className="business-note" role="status">{subjectScopeNote}</p>}
    {needsVehicles&&(!terminalsReady||!vehiclesReady) ? (vehicleNotice || <SkeletonList count={3} itemHeight={140}/>) : <>
    {tab === 'overview' && access.manage_vehicles && <details className="corporate-setup"><summary>회사 시작하기</summary><div className="fleet-onboarding" aria-label="회사 시작하기"><BusinessButton onClick={()=>setTab('settings')}>회사 정보</BusinessButton><BusinessButton onClick={()=>setTab('vehicles')}>차량 등록·단말기 연결</BusinessButton><BusinessButton onClick={()=>setTab('staff')}>사용자 배정</BusinessButton></div></details>}
    {tab === 'overview' && <CorporateOverview devices={devices} onMap={onMap} onDevice={onDevice} onReport={report} onReserve={reserve} onVehicles={()=>setTab('vehicles')} />}
    {tab === 'vehicles' && <FleetAssets onReport={report} meta={meta} assets={assets.data||[]} devices={rawDevices} onMap={rawOnMap} onChanged={assets.refetch} />}
    {tab === 'reservations' && <ReservationsTab devices={devices} request={request} />}
    {tab === 'staff' && <><StaffTab activeTab={sectionTabs.staff} onTab={selectSection} hideNavigation />{access.manage_team&&<details className="corporate-admin-details"><summary>계정·단말기 연결 설정</summary><CompanySubjectMappings/></details>}</>}
    {tab === 'sites' && <FleetSites activeTab={sectionTabs.sites} onTab={selectSection} hideNavigation />}
    {['expenses','expense-categories'].includes(tab) && <FleetExpenses categoriesOnly={tab==='expense-categories'} onOpenCategories={()=>setTab('expense-categories')}/>}
    {['report','monthly'].includes(tab) && <>
      {subscription.error ? <BusinessError onRetry={subscription.refetch}>이용권 상태를 확인하지 못했습니다. 다시 조회해 주세요.</BusinessError>
        : !subscription.data ? <SkeletonList count={2} itemHeight={140} />
        : !subscription.data.active ? <SubTab canBuy={access.billing} sub={subscription.data} onChange={updateSub} report />
        : tab === 'report' ? <ReportTab devices={devices} initialDeviceId={reportDevice} initialFilter={reportFilter} /> : <MonthlyReportTab devices={devices} />}</>}
    {tab === 'settings' && <BusinessSettings activeTab={sectionTabs.settings} onTab={selectSection} hideNavigation company={<InfoTab readOnly={!access.manage_team} />} subscription={subscription.error ? <BusinessError onRetry={subscription.refetch}>이용권 정보를 불러오지 못했습니다.</BusinessError> : <SubTab canBuy={access.billing} sub={subscription.data} onChange={updateSub} />} />}
    {vehiclesReady&&editAsset&&<FleetAssetForm asset={editAsset} staff={staff.data||[]} onClose={()=>setEditAsset(null)} onSaved={()=>{setEditAsset(null);assets.refetch();}}/>}
    </>}
  </BusinessWorkspace>;
}
export default function CorporateAccountPanel(props){return <FleetAccountScope>{toolbar=><CorporatePanel {...props} toolbar={toolbar}/>}</FleetAccountScope>;}

function CorporateOverview({ devices, onMap, onReport, onReserve, onVehicles }) {
  const now = useBusinessClock(), openVehicle = useBusinessVehicle(), [showAll, setShowAll] = useState(false);
  const period = businessPeriod(now), reservations = useReservations({ from: period.todayStart, to: period.todayEnd }, { refetchInterval: 60_000 });
  const stats = useFleetStats(devices);
  const active = (reservations.data || []).filter(r => ['planned', 'in_progress'].includes(r.status)).sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at));
  const maintenance = maintenanceTasks(devices, now), missing = missingMaintenance(devices);
  const tasks = corporateAttention(devices, now, { classify: classifyDevice, battery: deviceBattery });
  const shown = showAll ? tasks : tasks.slice(0,6);
  const distanceHint = stats.loading ? '집계 조회 중' : stats.error ? '집계 조회 실패' : !devices.length ? '등록 차량 없음' : stats.measured ? `${stats.measured}/${devices.length}대 집계${stats.partial ? ' · 일부 집계' : ''}${stats.lastFixAt ? ` · 마지막 위치 ${kstDateTime(stats.lastFixAt)}` : ''}` : stats.pending ? `집계 대기 ${stats.pending}대${stats.noData ? ` · 오늘 위치 없음 ${stats.noData}대` : ''}` : '오늘 수신된 위치 없음';
  return <div className="business-overview">
    <BusinessMetrics items={[
      { label: '등록 차량', value: devices.length, unit: '대', hint: '차량 목록에 등록된 전체 차량', icon: 'list' },
      { label: '사용 가능', value: devices.filter(d=>d.enabled !== false).length, unit: '대', hint: '차량 운영 상태 · 통신 상태와 별도', icon: 'check', tone: 'good' },
      { label: '오늘 운행거리', value: stats.error || stats.loading ? null : stats.todayKm, unit: 'km', hint: distanceHint + ' · 연결 변경일은 합계 제외', icon: 'route' },
      { label: '점검 예정', value: maintenance.length, unit: '건', hint: devices.length ? `30일 이내·기한 경과${missing.length ? ` · 일정 미등록 ${missing.length}대` : ' · 일정 등록 완료'}` : '등록 차량이 없습니다', tone: maintenance.some(t=>t.overdue) ? 'urgent' : '', icon: 'wrench' },
    ]} />
    {stats.error && <BusinessError onRetry={stats.refetch}>운행 통계를 불러오지 못했습니다.</BusinessError>}
    <div className="business-overview-grid"><BusinessLocation devices={devices} />
      <BusinessSection title="오늘 확인할 일" description={`통신·배터리·점검 ${tasks.length}건 · 미작성 운행 확인`}>
        {shown.map(t=><BusinessTask key={t.id} title={`${corporateVehicleName(t.device)} · ${terminalName(t.device)}`} description={`${t.description}${t.id.startsWith('signal-') && t.device.last_seen_at ? ` · 마지막 통신 ${ageString(t.device.last_seen_at)}` : ''}${t.id.startsWith('battery-') && (t.device.last_battery_at || t.device.last_seen_at) ? ` · ${kstDateTime(t.device.last_battery_at || t.device.last_seen_at)}` : ''}`} label={t.label} tone={t.tone} action="차량 확인" onClick={()=>openVehicle(t.device)} />)}
        {tasks.length > 6 && <div className="business-section-footer"><BusinessButton onClick={()=>setShowAll(v=>!v)}>{showAll ? '접기' : `나머지 ${tasks.length-6}건 보기`}</BusinessButton></div>}
        {missing.length > 0 && <BusinessTask title={`점검 일정 미등록 ${missing.length}대`} description="정비·보험·검사 중 등록하지 않은 일정이 있습니다." label="일정 등록" action="차량 관리" onClick={onVehicles} />}
        {!tasks.length && !missing.length && <BusinessEmpty compact title="현재 확인할 통신·배터리·점검 항목이 없습니다." />}
        <FleetIncompleteTrips devices={devices} onReport={onReport} now={now}/>
      </BusinessSection>
    </div>
    <div className="business-reservation-summary"><span>오늘 예약 <strong>{reservations.error || !reservations.data ? '—' : active.length}건</strong></span><BusinessButton onClick={()=>onReserve({})}>예약 보기</BusinessButton></div>
    {reservations.error && <BusinessError onRetry={reservations.refetch}>오늘 예약 수를 불러오지 못했습니다.</BusinessError>}
    <BusinessVehicles separateTerminal localMap devices={devices} onMap={onMap} onDetail={onReport} detailLabel="운행 리포트" />
  </div>;
}

// ════════════════════════════════════════════════════════
// 운행 리포트 — 차량별 운행기록과 내보내기.
// ════════════════════════════════════════════════════════
function ReportTab({ devices, initialDeviceId, initialFilter }) {
  const access=useFleetAccess();
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
  const [onlyIncomplete,setOnlyIncomplete]=useState(Boolean(initialFilter?.incomplete));
  const [trips, setTrips] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [evidence,setEvidence]=useState(null),[correction,setCorrection]=useState(null),[qualityHistory,setQualityHistory]=useState(false),[onlyReview,setOnlyReview]=useState(false);
  const [editing, setEditing] = useState(null);   // 편집 중인 trip {trip, deviceId}
  const [xlsxRequest, setXlsxRequest] = useState(null);
  const [printing, setPrinting] = useState(false);
  const printRequest = useRef(false);
  // 추가 필터 — 운전자별 / 용무별 / 최소 운행 시간(시간). all/'' 이면 미적용. AND.
  const [driverFilter,  setDriverFilter]  = useState('all');
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
  const filteredTrips = useMemo(() => trips ? filterTrips(trips, {driver:driverFilter,purpose:purposeFilter,minHours}).filter(t=>!onlyReview||!reportIncluded(t)).filter(t=>!onlyIncomplete||tripNeedsDetails(t)) : null, [trips, driverFilter, purposeFilter, minHours,onlyReview,onlyIncomplete]);
  useEffect(()=>{setSelected(new Set());setAssignment(null);setAssignmentStatus('');},[deviceId,from,to,driverFilter,purposeFilter,minHours,onlyReview,onlyIncomplete]);
  const subjectScoped=Boolean(trips?.subjectScope);
  const eligible=subjectScoped?[]:(filteredTrips||[]).filter(t=>canAssignTrip(t,access));
  const chosen=eligible.filter(t=>selected.has(tripAssignmentKey(t)));
  const toggleTrip=t=>{setAssignmentStatus('');setSelected(previous=>{const next=new Set(previous),key=tripAssignmentKey(t);if(next.has(key))next.delete(key);else if(next.size<100)next.add(key);return next;});};
  const completeness = trips ? tripCompleteness(trips) : null;
  const exportData = filteredTrips ? tripReport(filteredTrips, {device,info,from,to,
    filterText: `운전자: ${driverFilter==='all'?'전체':driverFilter==='unassigned'?'미지정':staff.find(s=>String(s.id)===driverFilter)?.name || driverFilter} · 용무: ${purposeLabel[purposeFilter] || '전체'} · 최소 운행: ${Number(minHours) || 0}시간${onlyReview?' · 미확정만':''}${onlyIncomplete?' · 미작성만':''}`,
  }) : null;
  const csvData = filteredTrips ? ntsTripReport(filteredTrips, {device,info,from,to,
    filtered: onlyIncomplete || onlyReview || driverFilter !== 'all' || purposeFilter !== 'all' || Number(minHours) > 0,
  }) : null;

  const exportConditions=JSON.stringify([deviceId,from,to,driverFilter,purposeFilter,minHours,onlyReview,onlyIncomplete]);
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
    const selected=filterTrips(fresh,{driver:driverFilter,purpose:purposeFilter,minHours}).filter(t=>!onlyReview||!reportIncluded(t)).filter(t=>!onlyIncomplete||tripNeedsDetails(t));
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

  const filterActive = onlyIncomplete || onlyReview || driverFilter !== 'all' || purposeFilter !== 'all' || (parseFloat(minHours) > 0);
  function resetFilters() {
    setOnlyReview(false); setOnlyIncomplete(false);
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
    <div className="corporate-report-page">
      <div className="corporate-report-heading no-print"><h2>{device?`${reportVehicleLabel(device)} 운행기록`:'운행기록부'}</h2><span>차량별 조회</span></div>
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
        <div className="corporate-report-date-range">
        <input aria-label="운행 조회 시작일" type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <span>~</span>
        <input aria-label="운행 조회 종료일" type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <BusinessButton icon="filter" aria-haspopup="dialog" aria-expanded={!!filterDraft} onClick={openFilters}>필터{filterActive && <span className="corporate-report-dot" aria-label="필터 적용 중"/>}</BusinessButton>
        {filterDraft&&<Modal open title="운행 필터" size={640} onClose={()=>setFilterDraft(null)} footer={<div className="corporate-report-filter-footer"><BusinessButton onClick={()=>setFilterDraft({driver:'all',purpose:'all',minHours:'',onlyIncomplete:false,onlyReview:false})}>초기화</BusinessButton><div><BusinessButton onClick={()=>setFilterDraft(null)}>취소</BusinessButton><BusinessButton primary disabled={draftHoursInvalid} onClick={applyFilters}>적용</BusinessButton></div></div>}>
          <div className="corporate-report-filter-dialog">
            <label>운전자<select aria-label="운전자 필터" value={filterDraft.driver} onChange={e => setFilterDraft(d=>({...d,driver:e.target.value}))}>
              <option value="all">운전자 전체</option><option value="unassigned">미지정</option>
              {staff.map(s => <option key={s.id} value={String(s.id)}>{s.name}{s.active === false ? ' (비활성)' : ''}</option>)}
            </select></label>
            <label>용무<select aria-label="용무 필터" value={filterDraft.purpose} onChange={e => setFilterDraft(d=>({...d,purpose:e.target.value}))}>
              <option value="all">용무 전체</option><option value="commute">출퇴근</option><option value="business">업무</option><option value="other">기타</option><option value="unspecified">미지정</option>
            </select></label>
            <label>최소 운행시간 (시간)<input aria-label="최소 운행시간" type="number" placeholder="제한 없음" value={filterDraft.minHours} step="0.5" min="0" onChange={e => setFilterDraft(d=>({...d,minHours:e.target.value}))}/></label>
            {draftHoursInvalid&&<p role="alert">최소 운행시간은 0 이상의 숫자로 입력해 주세요.</p>}
            <div className="corporate-report-filter-checks"><label className="corporate-report-check"><input type="checkbox" checked={filterDraft.onlyIncomplete} onChange={e=>setFilterDraft(d=>({...d,onlyIncomplete:e.target.checked}))}/>미작성만 보기</label><label className="corporate-report-check"><input type="checkbox" checked={filterDraft.onlyReview} onChange={e=>setFilterDraft(d=>({...d,onlyReview:e.target.checked}))}/>미확정만 보기</label></div>
            <small className="corporate-report-filter-counts">조회 기간 전체 · 용무 미지정 {completeness?.missingPurpose ?? '—'}건 / 운전자 미지정 {completeness?.missingDriver ?? '—'}건</small>
            <div className="corporate-report-filter-shortcuts"><BusinessButton disabled={!completeness?.missingPurpose} onClick={() => setFilterDraft({driver:'all',purpose:'unspecified',minHours:'',onlyIncomplete:false,onlyReview:false})}>용무 미지정</BusinessButton>
            <BusinessButton disabled={!completeness?.missingDriver} onClick={() => setFilterDraft({driver:'unassigned',purpose:'all',minHours:'',onlyIncomplete:false,onlyReview:false})}>운전자 미지정</BusinessButton></div>
          </div>
        </Modal>}
        <button onClick={load} style={st.btnGhost} disabled={loading || !!periodError}>
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
        </details>
      </div>
      <div className="corporate-report-control-row">
        <div className="corporate-report-status-tabs" aria-label="운행 작성 상태">
          <button className="corporate-report-status-option" type="button" aria-pressed={!filterActive} onClick={resetFilters}>전체 ({trips?.length ?? '—'})</button>
          <button className="corporate-report-status-option" type="button" aria-pressed={onlyIncomplete} onClick={()=>{resetFilters();setOnlyIncomplete(true);}}>미작성 ({trips?.filter(tripNeedsDetails).length ?? '—'})</button>
        </div>
        <div className="corporate-report-counts" aria-label="조회 기간 전체 작성 현황">
          <span>기간 전체</span>
          <span>작성률 <strong>{completeness?.percent ?? '—'}%</strong></span>
          <span>입력 주유비 <strong>{completeness?.fuelEntries ? `${completeness.fuelCost.toLocaleString()}원` : '—'}</strong></span>
        </div>
        <span className="corporate-report-result-count">{filteredTrips ? `${filteredTrips.length}건 표시` : ''}</span>
      </div>
      <TripQualitySummary trips={filteredTrips} loading={loading} error={error} vehicleSelected={Boolean(device)} onlyReview={onlyReview} onReviewChange={setOnlyReview}/>
      </div>
      {subjectScoped && <p className="business-note" role="status">{subjectScopeNote}</p>}
      <div className="fleet-assignment-toolbar corporate-report-assignment no-print">
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
      </div>
      {assignment&&<TripAssignmentModal mode={assignment} trips={chosen} vehicle={device} from={from} to={to} staff={staffAll||[]} onClose={()=>setAssignment(null)} onSaved={result=>{setAssignment(null);setAssignmentStatus(`${result.applied}건 변경 · ${result.skipped}건 제외`);load();}}/>}
      {showRules&&device&&<TripRulesModal vehicle={device} staff={staffAll||[]} onClose={()=>setShowRules(false)}/>}
      {showHistory&&device&&<TripAssignmentHistory vehicle={device} onClose={()=>setShowHistory(false)}/>}
      {evidence&&<TripEvidence vehicle={device} trip={evidence} from={from} to={to} canManage={access.manage_reports} onClose={()=>setEvidence(null)} onCorrect={()=>{setCorrection([evidence]);setEvidence(null);}}/>}
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
          <TripsTable trips={filteredTrips} dailyDistance={dailyDistance} selected={selected} onSelect={toggleTrip} eligible={eligible} onSelectAll={()=>{setAssignmentStatus('');setSelected(chosen.length===Math.min(100,eligible.length)?new Set():new Set(eligible.slice(0,100).map(tripAssignmentKey)));}}
            onEvidence={subjectScoped?undefined:setEvidence} onEdit={subjectScoped?undefined:(t) => setEditing(t)} />
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

function TripsTable({ trips, dailyDistance, onEdit, onEvidence, selected, onSelect, eligible, onSelectAll }) {
  return (
    // 모바일 — 운행 표가 좁은 폭을 넘김. 가로 스크롤 컨테이너로 감쌈.
    // 인쇄 시 @media print 가 nav/sidebar 만 숨기고 reportArea 는 그대로 노출, 인쇄 페이지 폭에 맞춤.
    <div className="corporate-trip-table-scroll" role="region" aria-label="운행기록 목록 · 좌우 스크롤" tabIndex={0} style={st.tripsTableScroll}>
    <table className="corporate-trip-table" style={st.tripsTable}>
      <thead>
        <tr>
          <th style={st.th} className="no-print"><input className="fleet-trip-select" type="checkbox" aria-label="현재 운행 최대 100건 선택" checked={eligible.length>0&&selected.size===Math.min(100,eligible.length)} disabled={!eligible.length} onChange={onSelectAll}/></th>
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
        {trips.map((t, i) => {
          const d = kstDate(t.started_at);
          const dailyKm = dailyDistance.has(d) ? `${tripDistance(dailyDistance.get(d))} km` : '—';
          const firstOfDay = !trips.slice(0, i).some(x => kstDate(x.started_at) === d);
          return (
            <TripRow key={tripAssignmentKey(t)} t={t} selected={selected.has(tripAssignmentKey(t))} onSelect={()=>onSelect(t)} selectionFull={selected.size>=100}
              date={d} dailyKm={firstOfDay ? dailyKm : ''}
              onEvidence={onEvidence?()=>onEvidence(t):undefined} onEdit={onEdit?() => onEdit(t):undefined} />
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function TripRow({ t, date, dailyKm, onEdit, onEvidence, selected, onSelect, selectionFull }) {
  const access=useFleetAccess();
  const ann = t.annotation || {};
  const purpose = ann.purpose || 'unspecified';
  const km = tripDistance(t.distance_m);
  const time = tripTimeRange(t);

  return (
    <tr>
      <td style={st.td} className="no-print"><input className="fleet-trip-select" type="checkbox" aria-label={`${date} ${time} 운행 선택`} checked={selected} disabled={!!t.quality?.subject_mapping_id||!canAssignTrip(t,access)||(!selected&&selectionFull)} onChange={onSelect}/></td>
      <td style={st.td}>{date}</td>
      <td style={st.td}>{time}</td><td style={st.td}><span className="fleet-quality-status" data-state={t.quality?.status}>{qualityLabel(t)}{t.correction_id?" · 보정":""}</span>{!reportIncluded(t)&&<small style={{display:"block"}}>합계 제외</small>}</td>
      <td style={st.td}>
        {PURPOSE_LABEL[purpose] || '미지정'}
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
        <button className="corporate-trip-edit" onClick={onEdit} disabled={!onEdit||t.allocation_status==='boundary_review'||(!access.manage_reports&&t.annotation?.driver_staff_id!=null&&t.annotation.driver_staff_id!==access.staff_id)} style={{
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
  planned:     { label: '예정',   color: 'var(--primary)', bg: 'color-mix(in srgb, var(--primary) 12%, transparent)' },
  in_progress: { label: '진행중', color: 'var(--accent)',  bg: 'color-mix(in srgb, var(--accent) 15%, transparent)' },
  completed:   { label: '완료',   color: 'var(--text-3)',  bg: 'var(--surface-2)' },
  cancelled:   { label: '취소',   color: 'var(--danger)',  bg: 'color-mix(in srgb, var(--danger) 12%, transparent)' },
};

function ReservationsTab({ devices, request }) {
  const [statusFilter, setStatusFilter] = useState('active');   // active | all | completed | cancelled
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(null);   // null | 'new' | {id, ...} | {new: 'YYYY-MM-DD'}
  useEffect(() => { if (request?.new) setEditing('new'); else if (request?.reservation) setEditing(request.reservation); }, [request]);
  // (2026-07-28) Stage-4F-2: 뷰 모드 (리스트 / 캘린더).
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('resv_view') || 'list');
  const setViewPersist = (v) => { setViewMode(v); try { localStorage.setItem('resv_view', v); } catch {} };
  const reservationDay = businessDate(useBusinessClock());
  const [calYm, setCalYm] = useState(() => businessDate().slice(0, 7));

  // (F2-c) useStaff hook — active 만 필터.
  const { data: staffAll } = useStaff();
  const staff = useMemo(() => (staffAll || []).filter(x => x.active), [staffAll]);
  const deleteResvMut = useDeleteReservation();

  // (F2-c) useReservations hook — params key 안정화.
  const resvParams = useMemo(() => {
    let from, to;
    if (viewMode === 'calendar') {
      const [y, m] = calYm.split('-').map(Number);
      const start = Date.UTC(y, m - 1, 1) - 9 * 3600_000;
      const end   = Date.UTC(y, m, 1) - 9 * 3600_000;
      from = new Date(start - 7 * 86400_000).toISOString();
      to   = new Date(end   + 7 * 86400_000).toISOString();
    } else {
      const start = Date.parse(`${reservationDay}T00:00:00+09:00`);
      from = new Date(start - 7 * 86400_000).toISOString();
      to   = new Date(start + 61 * 86400_000).toISOString();
    }
    return { from, to };
  }, [viewMode, calYm, reservationDay]);
  const { data: allReservations, isLoading: loading, error: qError, refetch } = useReservations(resvParams, {refetchInterval: 60_000});
  const searched = allReservations?.filter(r => [r.vehicle_name,r.device_name,r.license_plate,r.driver_name].join(' ').toLocaleLowerCase('ko-KR').includes(query.trim().toLocaleLowerCase('ko-KR')));
  const list = searched?.filter(r => viewMode === 'calendar' || statusFilter === 'all' || (statusFilter === 'active' ? ['planned', 'in_progress'].includes(r.status) : r.status === statusFilter));
  const error = qError?.message || null;

  const activeCount    = (searched || []).filter(r => r.status === 'planned' || r.status === 'in_progress').length;
  const completedCount = (searched || []).filter(r => r.status === 'completed').length;
  const cancelledCount = (searched || []).filter(r => r.status === 'cancelled').length;

  const known = !qError && !!allReservations;
  return (
    <div className="corporate-reservations">
      <div className="corporate-reservation-tools">
        <div className="corporate-reservation-tool-row">
          <div className="corporate-view-switch" role="group" aria-label="예약 보기 방식">
            <button type="button" className="corporate-view-option" aria-pressed={viewMode==='list'} onClick={()=>setViewPersist('list')}><Icon name="list" size={16}/>목록</button>
            <button type="button" className="corporate-view-option" aria-pressed={viewMode==='calendar'} onClick={()=>setViewPersist('calendar')}><Icon name="clock" size={16}/>캘린더</button>
          </div>
          <label className="corporate-reservation-search"><Icon name="search" size={16}/><input type="search" aria-label="예약 차량·사용자 검색" placeholder="차량·사용자 검색" value={query} onChange={e=>setQuery(e.target.value)}/></label>
          {viewMode==='calendar' && <input className="corporate-reservation-month" type="month" aria-label="예약 조회 월" value={calYm} onChange={e=>setCalYm(e.target.value||calYm)}/>}
          <BusinessButton primary icon="plus" onClick={()=>setEditing('new')}>새 예약</BusinessButton>
        </div>
        <div className="corporate-reservation-tool-row">
          {viewMode==='list' ? <div className="corporate-reservation-status" role="group" aria-label="예약 상태 필터">
            {[['all','전체',searched?.length],['active','예정·진행',activeCount],['completed','완료',completedCount],['cancelled','취소',cancelledCount]].map(([value,label,count])=><button type="button" className="corporate-status-option" key={value} aria-pressed={statusFilter===value} onClick={()=>setStatusFilter(value)}>{label} <span>({known?count:'—'})</span></button>)}
          </div> : <span className="corporate-reservation-hint">날짜를 선택해 예약하고, 예약을 선택해 상세 내용을 확인하세요.</span>}
          <span className="corporate-reservation-hint">{viewMode==='list'?'최근 7일 ~ 향후 60일':'선택한 달과 전후 7일'} · 등록 차량 {devices.length}대</span>
        </div>
      </div>
      {error && <BusinessError onRetry={refetch}>예약 정보를 불러오지 못했습니다.</BusinessError>}
      {loading && !list && <SkeletonList count={3} itemHeight={64}/>}
      {!error && viewMode==='list' && list && <section className="corporate-reservation-ledger">
        <div className="corporate-reservation-scroll" role="region" aria-label="차량 예약 목록 · 좌우 스크롤" tabIndex={0}>
          <table className="corporate-reservation-table"><thead><tr><th scope="col">상태</th><th scope="col">차량</th><th scope="col">사용자</th><th scope="col">시작 일시</th><th scope="col">종료 일시</th><th scope="col">목적·메모</th><th scope="col">관리</th></tr></thead>
            <tbody>{list.map(r=><ReservationRow key={r.id} r={r} onEdit={()=>setEditing(r)} onDelete={async()=>{
              const ok=await confirmDialog({title:'예약 취소',body:'예약을 취소할까요? 기존 내역은 유지됩니다.',danger:true});
              if(!ok)return;
              try{await deleteResvMut.mutateAsync(r.id);}catch(e){await alertDialog({title:'예약 취소 실패',body:e.message,tone:'danger'});}
            }}/>)}</tbody>
          </table>
          {!list.length&&<BusinessEmpty title={query?'검색 결과가 없습니다.':'예약이 없습니다.'}>{query?'검색어나 상태를 변경해 주세요.':'새 예약을 등록하거나 조회 상태를 변경해 주세요.'}</BusinessEmpty>}
        </div>
        <footer className="corporate-reservation-footer">{list.length}건</footer>
      </section>}
      {!error && viewMode==='calendar' && <ReservationCalendar ym={calYm} list={list||[]} onDayClick={dateStr=>setEditing({new:dateStr})} onEventClick={r=>setEditing(r)}/>}
      {editing && <ReservationDialog init={editing==='new'||editing?.new?null:editing} devices={devices} staff={staff} presetDate={editing?.new||null} onClose={()=>setEditing(null)} onSaved={()=>setEditing(null)}/>}
    </div>
  );
}

function ReservationRow({r,onEdit,onDelete}) {
  const state=RESV_STATUS[r.status]||RESV_STATUS.planned;
  const untilStart=Math.round((Date.parse(r.starts_at)-Date.now())/60000),untilEnd=Math.round((Date.parse(r.ends_at)-Date.now())/60000);
  const imminent=r.status==='planned'&&untilStart>=0&&untilStart<=60;
  const returning=r.status==='in_progress'&&untilEnd>=0&&untilEnd<=60;
  return <tr>
    <td><span className="corporate-reservation-badge" style={{color:state.color,background:state.bg}}>{state.label}</span>{imminent&&<small className="corporate-reservation-alert">{untilStart===0?'지금 시작':untilStart+'분 후 시작'}</small>}{returning&&<small className="corporate-reservation-alert">{untilEnd===0?'지금 반납':untilEnd+'분 후 반납'}</small>}</td>
    <td><strong>{r.vehicle_name||r.device_name||'차량'}</strong>{r.license_plate&&<small>{r.license_plate}</small>}</td>
    <td>{r.driver_name||'미지정'}</td><td>{kstDateTime(r.starts_at)}</td><td>{kstDateTime(r.ends_at)}</td>
    <td><span>{r.purpose||'—'}</span>{r.note&&<small>{r.note}</small>}</td>
    <td><div className="corporate-reservation-row-actions"><BusinessButton onClick={onEdit} aria-label={`예약 ${r.id} 상세·수정`}>상세·수정</BusinessButton>{r.status!=='cancelled'&&<BusinessButton onClick={onDelete} aria-label={`예약 ${r.id} 취소`}>취소</BusinessButton>}</div></td>
  </tr>;
}


// (2026-07-28) Stage-4F-2: 월 캘린더 뷰. 7x6 grid, 각 셀 = 하루.
// 예약은 그 날 시간대에 걸치는 것들 (status 색으로 구분). 최대 3개 표시 + "N+ more".
function ReservationCalendar({ ym, list, onDayClick, onEventClick }) {
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

  function reservationsOn(date) {
    const dStr = calendarDate(date);
    return (list || []).filter(r => {
      const s = businessDate(r.starts_at);
      const e = businessDate(r.ends_at);
      return dStr >= s && dStr <= e;
    });
  }

  const DOW = ['일', '월', '화', '수', '목', '금', '토'];

  return (
    <div className="corporate-reservation-calendar" role="region" aria-label="월간 차량 예약 · 좌우 스크롤" tabIndex={0}>
      {/* DoW header */}
      <div className="corporate-calendar-weekdays">
        {DOW.map((d, i) => (
          <div key={d} style={{
            color: i === 0 ? 'var(--danger)' : i === 6 ? 'var(--primary)' : 'var(--text-2)',
          }}>{d}</div>
        ))}
      </div>
      <div className="corporate-calendar-days">
        {cells.map((c, i) => {
          const dStr = calendarDate(c.date);
          const dayResv = reservationsOn(c.date);
          const isToday = dStr === todayStr;
          const dow = c.date.getDay();
          const MAX_BADGES = 2;   // 모바일 대응: 셀 폭 좁을 때 3개는 넘침
          return (
            <div className="corporate-calendar-day" key={i} onClick={() => c.currentMonth && onDayClick(dStr)} style={{
              minHeight: 'clamp(128px, 12vw, 160px)',
              background: isToday
                ? 'color-mix(in srgb, var(--primary) 8%, transparent)'
                : c.currentMonth ? 'var(--surface)' : 'var(--surface-2)',
              border: '1px solid ' + (isToday ? 'var(--primary)' : 'var(--border)'),
              opacity: c.currentMonth ? 1 : 0.4,
              cursor: c.currentMonth ? 'pointer' : 'default',
            }}>
              <div className="corporate-calendar-date" style={{
                color: !c.currentMonth ? 'var(--text-3)'
                     : isToday ? 'var(--primary)'
                     : dow === 0 ? 'var(--danger)'
                     : dow === 6 ? 'var(--primary)'
                     : 'var(--text)',
              }}>
                {c.date.getDate()}
              </div>
              {dayResv.slice(0, MAX_BADGES).map(r => {
                const s = RESV_STATUS[r.status] || RESV_STATUS.planned;
                return (
                  <div className="corporate-calendar-event" key={r.id} onClick={(e) => { e.stopPropagation(); onEventClick(r); }} style={{
                    background: s.bg, color: s.color,
                  }} title={`${r.license_plate || r.device_name || ''} · ${r.purpose || ''} · ${s.label}`}>
                    {[r.license_plate,r.vehicle_name].filter(Boolean).join(' · ') || '차량'}
                  </div>
                );
              })}
              {dayResv.length > MAX_BADGES && (
                <div className="corporate-calendar-more">
                  +{dayResv.length - MAX_BADGES}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
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

function ReservationDialog({ init, presetDate, devices, staff, onClose, onSaved }) {
  const access=useFleetAccess();
  // init null = 신규. presetDate 'YYYY-MM-DD' 있으면 그 날 09:00~10:00 기본.
  // 아니면 다음 정시부터 +1h.
  const defaultStart = () => {
    if (presetDate) return new Date(`${presetDate}T09:00:00+09:00`);
    return new Date((Math.floor(Date.now() / 3600_000) + 1) * 3600_000);
  };
  const [deviceId, setDeviceId] = useState(init?.vehicle_id ?? devices?.[0]?.id ?? '');
  const [driverId, setDriverId] = useState(init?.driver_staff_id ?? (!access.manage_reports?access.staff_id:''));
  const [startsAt, setStartsAt] = useState(init ? isoToLocal(init.starts_at) : isoToLocal(defaultStart().toISOString()));
  const [endsAt,   setEndsAt]   = useState(init ? isoToLocal(init.ends_at)   : isoToLocal(new Date(defaultStart().getTime() + 3600_000).toISOString()));
  const [purpose,  setPurpose]  = useState(init?.purpose ?? '');
  const [reportPurpose,setReportPurpose]=useState(init?.report_purpose || '');
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
    if (saving.current || busy || !mounted.current) return;
    if (!deviceId) { alertDialog({ title: '차량 선택 필요', body: '', tone: 'danger' }); return; }
    if (!startsAt || !endsAt) { alertDialog({ title: '시간 입력 필요', body: '', tone: 'danger' }); return; }
    const start = localToIso(startsAt), end = localToIso(endsAt);
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
      report_purpose: reportPurpose || null,
      note:            note.trim() || null,
      status,
    };
    try {
      if (init?.id) await updateMut.mutateAsync({ id: init.id, body });
      else          await createMut.mutateAsync(body);
      if (mounted.current) onSaved();
    } catch (e) {
      if (mounted.current) await alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    } finally { saving.current = false; if (mounted.current) setSubmitting(false); }
  }

  return (
    <Modal open onClose={busy ? undefined : close} size={720} title={init?.id ? '예약 편집' : '새 예약'} footer={<div className="corporate-editor-footer">
      <Button onClick={close} disabled={busy} variant="ghost" size="lg">취소</Button>
      <Button onClick={save} busy={busy} disabled={busy} variant="primary" size="lg">
        {busy ? '저장 중...' : '저장'}
      </Button>
    </div>}>
        <fieldset className="corporate-editor-fields" disabled={busy} aria-busy={busy}>
        <FormField label="차량">
          <select value={deviceId} onChange={e => {setDeviceId(e.target.value);setDriverId(access.manage_reports?'':access.staff_id);}}>
            {(devices || []).map(d => (
              <option key={d.id} value={d.id}>
                {reportVehicleLabel(d)}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="운전자 (선택)">
          <select value={driverId} onChange={e => setDriverId(e.target.value)}>
            {access.manage_reports&&<option value="">— 미지정 —</option>}
            {staff.filter(s=>staffCanDrive(s,devices.find(d=>d.id===Number(deviceId)))).map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` (${s.role})` : ''}</option>)}
          </select>
        </FormField>

        <p className="business-note">예약 일시는 한국시간(KST) 기준입니다.</p>
        <div className="business-datetime-fields">
          <FormField label="시작">
            <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} />
          </FormField>
          <FormField label="종료">
            <input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} />
          </FormField>
        </div>

        <FormField label="운행기록부 용무 (선택)">
          <Select value={reportPurpose} onChange={e=>setReportPurpose(e.target.value)}><option value="">미지정</option><option value="commute">출퇴근</option><option value="business">업무</option><option value="other">기타</option></Select>
        </FormField>
        <FormField label="예약 목적">
          <input value={purpose} onChange={e => setPurpose(e.target.value)}
            placeholder="거래처 방문, 외근..." />
        </FormField>

        <FormField label="메모 (선택)">
          <textarea value={note} onChange={e => setNote(e.target.value)}
            placeholder="예약 관련 내용을 입력하세요." />
        </FormField>

        {init?.id && (
          <div className="corporate-editor-field">
            <div className="corporate-editor-label">상태</div>
            <div className="corporate-editor-options">
              {Object.entries(RESV_STATUS).map(([id, meta]) => (
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
  gasoline: 1700, diesel: 1600, lpg: 1000, ev: 0,
};
// mutable — useFuelPrices 훅이 채워넣음. estimateFuelCost 는 이걸 참조.
// eslint-disable-next-line prefer-const
let FUEL_PRICE_KRW = { ...DEFAULT_FUEL_PRICE_KRW };
const FUEL_LABEL = {
  gasoline: '휘발유', diesel: '경유', lpg: 'LPG', ev: '전기',
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
        gasoline: p.gasoline, diesel: p.diesel, lpg: p.lpg, ev: 0,
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
      const result = await saveBlob(blob, filename);
      if (!mounted.current || result.status === 'cancelled') return;
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

import TripQualitySummary from './business/TripQualitySummary';
import {TripEvidence,TripCorrection,TripCorrectionHistory} from './business/FleetTripQuality';
import {qualityLabel,reportIncluded,tripTimeRange} from '../lib/tripQuality';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';
import ExportButtons from './business/ExportButtons';
import StaffTab from './business/FleetPeople';
import FleetSites from './business/FleetSites';
import FleetExpenses from './business/FleetExpenses';
import {TripAssignmentModal,TripRulesModal,TripAssignmentHistory} from './business/FleetTripAssignments';
import {tripAssignmentKey,canAssignTrip} from '../lib/tripAssignments';
import {FleetAccountScope,useFleetAccess,staffCanDrive} from './business/FleetAccess';
import { BusinessCompanyInfo as InfoTab, BusinessSubscription as SubTab } from './business/BusinessPreferences';
import { filterTrips, tripReport, monthlyReport, monthDateBounds, purposeLabel } from '../lib/businessExport';
import { BusinessWorkspace, BusinessLocation, useBusinessVehicle, BusinessButton, BusinessError, BusinessEmpty, BusinessSection, BusinessMetrics, BusinessTask, BusinessSettings, BusinessVehicles } from './business/BusinessWorkspace';
import { tripCompleteness } from '../lib/businessWorkspace';
import { corporateAttention, corporateVehicleName, terminalName, missingMaintenance } from '../lib/corporateOverview';
import { corporateGroups, corporateTabs } from '../lib/corporateNavigation';
import { ntsTripReport, reportVehicleLabel } from '../lib/ntsReport';
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

const PURPOSE_LABEL = {
  commute:     '출퇴근',
  business:    '업무',
  other:       '기타',
  unspecified: '미지정',
};

function CorporatePanel({ devices: personalDevices, onMap: personalMap, onDevice, onVehiclesChange, onNavigate, meta: personalMeta, toolbar }) {
  const access=useFleetAccess();
  const terminals=useQuery({queryKey:['fleet-terminals'],queryFn:()=>api.fleetTerminals(),refetchInterval:30000});
  const rawDevices=terminals.data||[],rawMeta=access.billing?personalMeta:{},rawOnMap=access.billing?personalMap:undefined;
  const assets=useFleetAssets();
  const devices=useMemo(()=>projectFleetAssets(assets.data||[],rawDevices),[assets.data,rawDevices]);
  const meta=Object.fromEntries(devices.map(d=>[d.id,rawMeta?.[d.source_device_id]]));
  const onMap=id=>{const sim=devices.find(v=>v.id===id)?.source_device_id;if(sim)rawOnMap?.(sim);};
  const [editAsset,setEditAsset]=useState(null);
  const staff=useStaff();
  const [tab, setTab] = useState('overview');
  const [request, setRequest] = useState(null);
  const [reportDevice, setReportDevice] = useState(null);
  const subscription = useBusinessSubscription('corporate');
  const qc = useQueryClient();
  const updateSub = value => qc.setQueryData(qk.businessSubscription('corporate'), value);
  const reserve = value => { setRequest(value); setTab('reservations'); };
  const report = device => { setReportDevice(device.id); setTab('report'); };
  if(assets.isPending||terminals.isPending)return <SkeletonList count={3} itemHeight={140}/>;
  if(assets.error)return <BusinessError onRetry={assets.refetch}>등록 차량을 불러오지 못했습니다.</BusinessError>;
  if(terminals.error)return <div className="fleet-access-error">{toolbar}<BusinessError onRetry={terminals.refetch}>단말기 상태를 불러오지 못했습니다.</BusinessError></div>;
  return <BusinessWorkspace renderVehicleDetail={(device,close)=><FleetAssetDetail meta={meta[device.id]} asset={device.asset} devices={rawDevices} onClose={close} onChanged={assets.refetch} onEdit={()=>{close();setEditAsset(device.asset);}} onMap={rawOnMap} onReport={report}/>} title="법인차 운영" tabs={corporateTabs} groups={corporateGroups} tab={tab} onTab={value => { setRequest(null); setTab(value); }} devices={devices} kind="corporate" onMap={onMap} onVehicleAction={report} onManageVehicle={onDevice} onNavigate={onNavigate} onVehiclesChange={onVehiclesChange} meta={meta}
    mobileAction={<BusinessButton icon="user" onClick={()=>setTab('staff')}>사용자</BusinessButton>}
    action={tab === 'reservations' ? <BusinessButton primary icon="plus" onClick={() => reserve({ new: true })}>차량 예약</BusinessButton> : null}>
    {toolbar}
    {tab === 'overview' && access.manage_vehicles && <div className="fleet-onboarding" aria-label="회사 시작하기"><BusinessButton onClick={()=>setTab('settings')}>1 회사 정보</BusinessButton><BusinessButton onClick={()=>setTab('vehicles')}>2 차량 등록</BusinessButton><BusinessButton onClick={()=>setTab('vehicles')}>3 단말기 연결</BusinessButton><BusinessButton onClick={()=>setTab('staff')}>4 사용자 배정</BusinessButton></div>}
    {tab === 'overview' && <CorporateOverview devices={devices} onMap={onMap} onDevice={onDevice} onReport={report} onReserve={reserve} onVehicles={()=>setTab('vehicles')} />}
    {tab === 'vehicles' && <FleetAssets onReport={report} meta={meta} assets={assets.data||[]} devices={rawDevices} onMap={rawOnMap} onChanged={assets.refetch} />}
    {tab === 'reservations' && <ReservationsTab devices={devices} request={request} />}
    {tab === 'staff' && <StaffTab />}
    {tab === 'sites' && <FleetSites />}
    {['expenses','expense-categories'].includes(tab) && <FleetExpenses categoriesOnly={tab==='expense-categories'}/>}
    {['report','monthly'].includes(tab) && <>
      {subscription.error ? <BusinessError onRetry={subscription.refetch}>이용권 상태를 확인하지 못했습니다. 다시 조회해 주세요.</BusinessError>
        : !subscription.data ? <SkeletonList count={2} itemHeight={140} />
        : !subscription.data.active ? <SubTab canBuy={access.billing} sub={subscription.data} onChange={updateSub} report />
        : tab === 'report' ? <ReportTab devices={devices} initialDeviceId={reportDevice} /> : <MonthlyReportTab devices={devices} />}</>}
    {tab === 'settings' && <BusinessSettings company={<InfoTab readOnly={!access.manage_team} />} subscription={subscription.error ? <BusinessError onRetry={subscription.refetch}>이용권 정보를 불러오지 못했습니다.</BusinessError> : <SubTab canBuy={access.billing} sub={subscription.data} onChange={updateSub} />} />}
    {editAsset&&<FleetAssetForm asset={editAsset} staff={staff.data||[]} onClose={()=>setEditAsset(null)} onSaved={()=>{setEditAsset(null);assets.refetch();}}/>}
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
      { label: '점검 예정', value: maintenance.length, unit: '건', hint: `30일 이내·기한 경과${missing.length ? ` · 일정 미등록 ${missing.length}대` : ' · 일정 등록 완료'}`, tone: maintenance.some(t=>t.overdue) ? 'urgent' : '', icon: 'wrench' },
    ]} />
    {stats.error && <BusinessError onRetry={stats.refetch}>운행 통계를 불러오지 못했습니다.</BusinessError>}
    <div className="business-overview-grid"><BusinessLocation devices={devices} />
      <BusinessSection title="오늘 확인할 일" description={`통신·배터리·점검 ${tasks.length}건`}>
        {shown.map(t=><BusinessTask key={t.id} title={`${corporateVehicleName(t.device)} · ${terminalName(t.device)}`} description={`${t.description}${t.id.startsWith('signal-') && t.device.last_seen_at ? ` · 마지막 통신 ${ageString(t.device.last_seen_at)}` : ''}${t.id.startsWith('battery-') && (t.device.last_battery_at || t.device.last_seen_at) ? ` · ${kstDateTime(t.device.last_battery_at || t.device.last_seen_at)}` : ''}`} label={t.label} tone={t.tone} action="차량 확인" onClick={()=>openVehicle(t.device)} />)}
        {tasks.length > 6 && <div className="business-section-footer"><BusinessButton onClick={()=>setShowAll(v=>!v)}>{showAll ? '접기' : `나머지 ${tasks.length-6}건 보기`}</BusinessButton></div>}
        {missing.length > 0 && <BusinessTask title={`점검 일정 미등록 ${missing.length}대`} description="정비·보험·검사 중 등록하지 않은 일정이 있습니다." label="일정 등록" action="차량 관리" onClick={onVehicles} />}
        {!tasks.length && !missing.length && <BusinessEmpty compact title="현재 확인할 통신·배터리·점검 항목이 없습니다." />}
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
function ReportTab({ devices, initialDeviceId }) {
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
  const [from, setFrom] = useState(monthAgo);
  const [to,   setTo]   = useState(today);
  const [trips, setTrips] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [evidence,setEvidence]=useState(null),[correction,setCorrection]=useState(null),[qualityHistory,setQualityHistory]=useState(false),[onlyReview,setOnlyReview]=useState(false);
  const [editing, setEditing] = useState(null);   // 편집 중인 trip {trip, deviceId}
  // 추가 필터 — 운전자별 / 용무별 / 최소 운행 시간(시간). all/'' 이면 미적용. AND.
  const [driverFilter,  setDriverFilter]  = useState('all');
  const [purposeFilter, setPurposeFilter] = useState('all');
  const [minHours,      setMinHours]      = useState('');

  const device = devices.find(d => d.id === deviceId);
  // (F2-c) 훅으로 이전. staff active-filter 는 로컬.
  const { data: staffAll } = useStaff();
  const staff = useMemo(() => (staffAll || []).filter(x => x.active), [staffAll]);
  const { data: info } = useCorporateInfo();

  const loadId = useRef(0);
  async function load() {
    if (!deviceId) return;
    const id = ++loadId.current;
    setSelected(new Set());setAssignment(null);setEvidence(null);setCorrection(null);
    if (!from || !to || from > to) { setTrips(null); setLoading(false); setError('조회 시작일과 종료일을 올바르게 선택해 주세요.'); return; }
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
  const filteredTrips = useMemo(() => trips ? filterTrips(trips, {driver:driverFilter,purpose:purposeFilter,minHours}).filter(t=>!onlyReview||!reportIncluded(t)) : null, [trips, driverFilter, purposeFilter, minHours,onlyReview]);
  useEffect(()=>{setSelected(new Set());setAssignment(null);setAssignmentStatus('');},[deviceId,from,to,driverFilter,purposeFilter,minHours,onlyReview]);
  const eligible=(filteredTrips||[]).filter(t=>canAssignTrip(t,access));
  const chosen=eligible.filter(t=>selected.has(tripAssignmentKey(t)));
  const toggleTrip=t=>{setAssignmentStatus('');setSelected(previous=>{const next=new Set(previous),key=tripAssignmentKey(t);if(next.has(key))next.delete(key);else if(next.size<100)next.add(key);return next;});};
  const completeness = trips ? tripCompleteness(trips) : null;
  const exportData = filteredTrips ? tripReport(filteredTrips, {device,info,from,to,
    filterText: `운전자: ${driverFilter==='all'?'전체':driverFilter==='unassigned'?'미지정':staff.find(s=>String(s.id)===driverFilter)?.name || driverFilter} · 용무: ${purposeLabel[purposeFilter] || '전체'} · 최소 운행: ${Number(minHours) || 0}시간${onlyReview?' · 미확정만':''}`,
  }) : null;
  const csvData = filteredTrips ? ntsTripReport(filteredTrips, {device,info,from,to,
    filtered: onlyReview || driverFilter !== 'all' || purposeFilter !== 'all' || Number(minHours) > 0,
  }) : null;

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

  const filterActive = onlyReview || driverFilter !== 'all' || purposeFilter !== 'all' || (parseFloat(minHours) > 0);
  function resetFilters() {
    setOnlyReview(false);
    setDriverFilter('all');
    setPurposeFilter('all');
    setMinHours('');
  }

  return (
    <>
      {/* (2026-07-28) Fleet 요약 — 상단 stat card 4개 (첨부 이미지 스타일).
          fleet-wide 지표 (총 차량 / 운행중 / 오늘 km / 이번달 km) 로 device drill-down 위에 배치.
          운행중 판정: devices.last_event_kind === 'wake'. km: 병렬 listTrips 집계. */}

      {/* 컨트롤 — 인쇄 시 숨김 */}
      <div className="no-print" style={st.controls}>
        <select aria-label="운행 차량" value={deviceId || ''} onChange={e => setDeviceId(parseInt(e.target.value, 10) || null)}
          style={st.select}>
          {devices.map(d => (
            <option key={d.id} value={d.id}>
              {reportVehicleLabel(d)}
            </option>
          ))}
        </select>
        <input aria-label="운행 조회 시작일" type="date" value={from} onChange={e => setFrom(e.target.value)} style={st.dateInput} />
        <span style={{ color: 'var(--text-3)' }}>~</span>
        <input aria-label="운행 조회 종료일" type="date" value={to} onChange={e => setTo(e.target.value)} style={st.dateInput} />
        <button onClick={load} style={st.btnGhost} disabled={loading}>
          <Icon name="refresh" size={12} /> 새로고침
        </button>
        <ExportButtons report={exportData} csvReport={csvData} pdfReport={csvData} csvLabel="운행기록부 CSV" disabled={loading || !!error || !deviceId} />
        <button onClick={() => window.print()} style={st.btnGhost} disabled={loading || !!error || !trips}>
          <Icon name="share" size={12} /> 인쇄
        </button>
      </div>

      <div className="business-report-progress no-print"><BusinessMetrics items={[
        { label: '운행일지 작성률', value: completeness?.percent, unit: '%', hint: completeness ? `${completeness.complete} / ${completeness.total}건 · 운전자와 용무 모두 입력` : '선택한 차량·조회 기간 기준', icon: 'check' },
        { label: '용무 미지정', value: completeness?.missingPurpose, unit: '건', hint: '운행 목적을 기록해 주세요', icon: 'list', tone: completeness?.missingPurpose ? 'urgent' : '' },
        { label: '운전자 미지정', value: completeness?.missingDriver, unit: '건', hint: '운행 담당자를 기록해 주세요', icon: 'user' },
        { label: '입력된 주유비', value: completeness?.fuelEntries ? completeness.fuelCost.toLocaleString() : null, unit: '원', hint: completeness ? `${completeness.fuelEntries}건 입력 · 미입력 금액 제외` : '직접 입력한 주유비 합계', icon: 'bar' },
      ]} /><div className="business-filter-bar"><BusinessButton disabled={!completeness?.missingPurpose} onClick={() => { resetFilters(); setPurposeFilter('unspecified'); }}>용무 미지정만 보기</BusinessButton><BusinessButton disabled={!completeness?.missingDriver} onClick={() => { resetFilters(); setDriverFilter('unassigned'); }}>운전자 미지정만 보기</BusinessButton><span className="business-note">위 지표는 아래 필터 적용 전, 선택 차량의 조회 기간 전체 기준입니다.</span></div></div>
      {/* 추가 필터 row — 운전자 / 용무 / 최소시간. AND, 초기화 버튼. */}
      <div className="no-print" style={st.filters}>
        <select aria-label="운전자 필터" value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={st.select}>
          <option value="all">운전자 전체</option>
          <option value="unassigned">미지정</option>
          {staff.map(s => (
            <option key={s.id} value={String(s.id)}>{s.name}</option>
          ))}
        </select>
        <select aria-label="용무 필터" value={purposeFilter} onChange={e => setPurposeFilter(e.target.value)} style={st.select}>
          <option value="all">용무 전체</option>
          <option value="commute">출퇴근</option>
          <option value="business">업무</option>
          <option value="other">기타</option>
          <option value="unspecified">미지정</option>
        </select>
        <input type="number" placeholder="최소 시간(h)"
          value={minHours} step="0.5" min="0"
          onChange={e => setMinHours(e.target.value)}
          style={{ ...st.dateInput, minWidth: 110 }} />
        {filterActive && (
          <button onClick={resetFilters} style={st.btnGhost}>
            <Icon name="close" size={12} /> 필터 초기화
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
          {trips && filteredTrips
            ? (filterActive
                ? `${filteredTrips.length} / ${trips.length}건`
                : `${trips.length}건`)
            : ''}
        </span>
      </div>

      <TripQualitySummary trips={filteredTrips} loading={loading} error={error} onlyReview={onlyReview} onReviewChange={setOnlyReview}/>
      <div className="fleet-assignment-toolbar no-print">
        <span role="status">{assignmentStatus || `${chosen.length}건 선택 · 한 번에 100건까지`}</span>
        <BusinessButton disabled={!chosen.length||loading} onClick={()=>setAssignment('manual')}>일괄 지정</BusinessButton>
        <BusinessButton disabled={!chosen.length||loading} onClick={()=>setAssignment('suggest')}>예약·규칙 적용</BusinessButton>
        <BusinessButton disabled={!device} onClick={()=>setShowRules(true)}>기본 운전자·반복 규칙</BusinessButton>
        {access.manage_reports&&<><BusinessButton disabled={chosen.length!==2||chosen.some(t=>t.correction_id)} onClick={()=>setCorrection(chosen)}>선택한 2건 병합</BusinessButton><BusinessButton disabled={!device} onClick={()=>setQualityHistory(true)}>보정 이력</BusinessButton><BusinessButton disabled={!device} onClick={()=>setShowHistory(true)}>지정 이력</BusinessButton></>}
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
        {error && <BusinessError onRetry={load}>{error}</BusinessError>}
        {trips && trips.length === 0 && !loading && (
          <div style={st.muted}>이 기간에 운행 기록이 없습니다.</div>
        )}
        {trips && trips.length > 0 && filteredTrips.length === 0 && (
          <div style={st.muted}>필터 조건에 맞는 운행이 없습니다.</div>
        )}
        {filteredTrips && filteredTrips.length > 0 && (
          <TripsTable trips={filteredTrips} dailyDistance={dailyDistance} selected={selected} onSelect={toggleTrip} eligible={eligible} onSelectAll={()=>{setAssignmentStatus('');setSelected(chosen.length===Math.min(100,eligible.length)?new Set():new Set(eligible.slice(0,100).map(tripAssignmentKey)));}}
            onEvidence={setEvidence} onEdit={(t) => setEditing(t)} />
        )}
      </div>

      {editing && (
        <TripEditorModal trip={editing} staff={(staffAll||[]).filter(s=>staffCanDrive(s,device)||s.id===editing.annotation?.driver_staff_id)} deviceId={deviceId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </>
  );
}

function ReportHeader({ info, device, from, to }) {
  const company = info?.company_name || '—';
  const biznum  = info?.business_number || '—';
  const dev     = reportVehicleLabel(device);
  return (
    <div style={st.reportHead}>
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
    // 모바일 — 9열 표가 좁은 폭을 넘김. 가로 스크롤 컨테이너로 감쌈.
    // 인쇄 시 @media print 가 nav/sidebar 만 숨기고 reportArea 는 그대로 노출, 인쇄 페이지 폭에 맞춤.
    <div style={st.tripsTableScroll}>
    <table style={st.tripsTable}>
      <thead>
        <tr>
          <th style={st.th} className="no-print"><input className="fleet-trip-select" type="checkbox" aria-label="현재 운행 최대 100건 선택" checked={eligible.length>0&&selected.size===Math.min(100,eligible.length)} disabled={!eligible.length} onChange={onSelectAll}/></th>
          <th style={st.th}>날짜</th>
          <th style={st.th}>시간</th><th style={st.th}>기록 상태</th>
          <th style={st.th}>용무</th>
          <th style={st.th}>출발지</th>
          <th style={st.th}>도착지</th>
          <th style={st.th}>주행거리</th>
          <th style={st.th}>일별 누적</th>
          <th style={st.th}>유류</th>
          <th style={st.th}>운전자</th>
          <th style={{ ...st.th, width: 36 }} className="no-print"></th>
        </tr>
      </thead>
      <tbody>
        {trips.map((t, i) => {
          const d = kstDate(t.started_at);
          const dailyKm = dailyDistance.has(d) ? `${(dailyDistance.get(d) / 1000).toFixed(1)} km` : '—';
          const firstOfDay = !trips.slice(0, i).some(x => kstDate(x.started_at) === d);
          return (
            <TripRow key={tripAssignmentKey(t)} t={t} selected={selected.has(tripAssignmentKey(t))} onSelect={()=>onSelect(t)} selectionFull={selected.size>=100}
              date={d} dailyKm={firstOfDay ? dailyKm : ''}
              onEvidence={()=>onEvidence(t)} onEdit={() => onEdit(t)} />
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
  const km = t.distance_m == null ? '—' : (t.distance_m / 1000).toFixed(1);
  const time = tripTimeRange(t);

  return (
    <tr>
      <td style={st.td} className="no-print"><input className="fleet-trip-select" type="checkbox" aria-label={`${date} ${time} 운행 선택`} checked={selected} disabled={!canAssignTrip(t,access)||(!selected&&selectionFull)} onChange={onSelect}/></td>
      <td style={st.td}>{date}</td>
      <td style={st.td}>{time}</td><td style={st.td}><span className="fleet-quality-status" data-state={t.quality?.status}>{qualityLabel(t)}{t.correction_id?" · 보정":""}</span>{!reportIncluded(t)&&<small style={{display:"block"}}>합계 제외</small>}</td>
      <td style={st.td}>
        {PURPOSE_LABEL[purpose] || '미지정'}
        {purpose === 'other' && ann.purpose_note && (
          <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{ann.purpose_note}</div>
        )}
      </td>
      <td style={st.td}>
        {!!t.start_sites?.length&&<strong>{t.start_sites.map(s=>s.name).join(' · ')}</strong>}
        <div>{t.start_address || '—'}</div>
        {t.start_lat != null && (
          <div style={{ fontSize: 9, color: 'var(--text-3)' }}>
            {t.start_lat.toFixed(5)}, {t.start_lng.toFixed(5)}
          </div>
        )}
      </td>
      <td style={st.td}>
        {!!t.end_sites?.length&&<strong>{t.end_sites.map(s=>s.name).join(' · ')}</strong>}
        <div>{t.end_address || '—'}</div>
        {t.end_lat != null && (
          <div style={{ fontSize: 9, color: 'var(--text-3)' }}>
            {t.end_lat.toFixed(5)}, {t.end_lng.toFixed(5)}
          </div>
        )}
      </td>
      <td style={{ ...st.td, textAlign: 'right' }}>{km}{t.distance_m != null ? ' km' : ''}{t.allocation_note&&<small>{t.allocation_note}</small>}</td>
      <td style={{ ...st.td, textAlign: 'right' }}>{dailyKm}</td>
      <td style={st.td}>
        {ann.fuel_liters ? `${ann.fuel_liters}L` : '—'}
        {ann.fuel_cost ? ` / ${ann.fuel_cost.toLocaleString()}원` : ''}
      </td>
      <td style={st.td}>{ann.driver_name || '—'}</td>
      <td style={{ ...st.td, padding: 4 }} className="no-print"><div className="fleet-quality-row-actions"><BusinessButton onClick={onEvidence}>근거</BusinessButton>
        <button onClick={onEdit} disabled={t.allocation_status==='boundary_review'||(!access.manage_reports&&t.annotation?.driver_staff_id!=null&&t.annotation.driver_staff_id!==access.staff_id)} style={{
          width: 26, height: 26, borderRadius: 6,
          background: 'var(--surface-2)', color: 'var(--text-2)',
          border: '1px solid var(--border)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }} title="용무·운전자 수정" aria-label="용무·운전자 수정">
          <Icon name="edit" size={12} />
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
  const [busy, setBusy] = useState(false);

  async function save() {
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
      });
      onSaved?.();
    } catch (e) {
      await alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  const km = (trip.distance_m / 1000).toFixed(1);

  return (
    // 외부 클릭으로 닫히지 않음 — 편집 중 데이터 손실 방지. X / 취소 버튼만 닫기.
    <Modal open title="운행 기록 수정" size="lg" onClose={onClose} closeOnBackdrop={false}>
        {/* 헤더 — 운행 요약 */}
        <div style={mst.header}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {kstDate(trip.started_at)} · {tripTimeRange(trip)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {trip.start_address || '—'} → {trip.end_address || '—'} · {km} km
            </div>
          </div>

        </div>

        <div style={mst.body}>
          {/* 용무 */}
          <Field label="용무">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: 6 }}>
              {[
                ['unspecified', '미지정'],
                ['commute',     '출퇴근'],
                ['business',    '업무'],
                ['other',       '기타'],
              ].map(([id, label]) => {
                const on = purpose === id;
                return (
                  <button key={id} onClick={() => setPurpose(id)}
                    style={{
                      padding: '8px 4px',
                      background: on ? 'var(--primary)' : 'var(--surface-2)',
                      color:      on ? 'white' : 'var(--text)',
                      border: '1px solid ' + (on ? 'var(--primary)' : 'var(--border)'),
                      borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: on ? 700 : 500,
                    }}>{label}</button>
                );
              })}
            </div>
            {purpose === 'other' && (
              <input value={purposeNote} onChange={e => setPurposeNote(e.target.value)}
                placeholder="예: 거래처 미팅, 외근, 출장..."
                style={{ ...mst.input, marginTop: 6 }} autoFocus />
            )}
          </Field>

          {/* 운전자 */}
          <Field label="운전자">
            {staff.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                사용자 메뉴에서 등록할 수 있습니다.
              </div>
            ) : (
              <select value={driverId} onChange={e => setDriverId(e.target.value)}
                style={mst.input}>
                {access.manage_reports&&<option value="">— 미지정 —</option>}
                {staff.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.role ? ` (${s.role})` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {/* 유류 */}
          <Field label="유류">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 6 }}>
              <div>
                <input type="number" step="0.1" value={fuelLiters}
                  onChange={e => setFuelLiters(e.target.value)}
                  placeholder="리터 (L)" style={mst.input} />
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>리터</div>
              </div>
              <div>
                <input type="number" value={fuelCost} disabled={!!ann.fuel_expense_id}
                  onChange={e => setFuelCost(e.target.value)}
                  placeholder="비용 (원)" style={mst.input} />
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>원</div>
                {ann.fuel_expense_id&&<p className="business-note">지출 #{ann.fuel_expense_id}에서 관리 · 승인된 금액만 반영</p>}
              </div>
            </div>
          </Field>

          {/* 비고 */}
          <Field label="비고 (선택)">
            <input value={note} onChange={e => setNote(e.target.value)}
              placeholder="메모"
              style={mst.input} />
          </Field>
        </div>

        <div style={mst.actions}>
          <button onClick={onClose} style={mst.btnSecondary}>취소</button>
          <button onClick={save} disabled={busy} style={mst.btnPrimary}>
            {busy ? '저장 중...' : '저장'}
          </button>
        </div>
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
  const [editing, setEditing] = useState(null);   // null | 'new' | {id, ...} | {new: 'YYYY-MM-DD'}
  useEffect(() => { if (request?.new) setEditing('new'); else if (request?.reservation) setEditing(request.reservation); }, [request]);
  // (2026-07-28) Stage-4F-2: 뷰 모드 (리스트 / 캘린더).
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('resv_view') || 'list');
  const setViewPersist = (v) => { setViewMode(v); try { localStorage.setItem('resv_view', v); } catch {} };
  const [calYm, setCalYm] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });

  // (F2-c) useStaff hook — active 만 필터.
  const { data: staffAll } = useStaff();
  const staff = useMemo(() => (staffAll || []).filter(x => x.active), [staffAll]);
  const deleteResvMut = useDeleteReservation();

  // (F2-c) useReservations hook — params key 안정화.
  const resvParams = useMemo(() => {
    let from, to;
    if (viewMode === 'calendar') {
      const [y, m] = calYm.split('-').map(Number);
      const start = new Date(y, m - 1, 1);
      const end   = new Date(y, m, 1);
      from = new Date(start.getTime() - 7 * 86400_000).toISOString();
      to   = new Date(end.getTime()   + 7 * 86400_000).toISOString();
    } else {
      const now = new Date();
      from = new Date(now.getTime() - 7 * 86400_000).toISOString();
      to   = new Date(now.getTime() + 60 * 86400_000).toISOString();
    }
    return { from, to };
  }, [viewMode, calYm]);
  const { data: allReservations, isLoading: loading, error: qError, refetch } = useReservations(resvParams, {refetchInterval: 60_000});
  const list = allReservations?.filter(r => viewMode === 'calendar' || statusFilter === 'all' || (statusFilter === 'active' ? ['planned', 'in_progress'].includes(r.status) : r.status === statusFilter));
  const error = qError?.message || null;

  const activeCount    = (allReservations || []).filter(r => r.status === 'planned' || r.status === 'in_progress').length;
  const completedCount = (allReservations || []).filter(r => r.status === 'completed').length;
  const cancelledCount = (allReservations || []).filter(r => r.status === 'cancelled').length;

  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <StatCardGrid>
        <StatCard icon="clock" label="예정/진행중"  value={qError || !allReservations ? '—' : activeCount}    unit="건" tone="primary" />
        <StatCard icon="route" label="완료"         value={qError || !allReservations ? '—' : completedCount} unit="건" tone="success" />
        <StatCard icon="close" label="취소"         value={qError || !allReservations ? '—' : cancelledCount} unit="건" tone="default" />
        <StatCard icon="list"  label="전체 차량"    value={devices?.length ?? 0} unit="대" tone="default" />
      </StatCardGrid>

      {/* 뷰 mode 토글 + 필터/추가 */}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{
          display: 'flex', gap: 0, padding: 3,
          background: 'var(--surface-2)', borderRadius: 999,
        }}>
          <ViewToggleBtn active={viewMode==='list'}     onClick={() => setViewPersist('list')}     label="리스트" icon="list" />
          <ViewToggleBtn active={viewMode==='calendar'} onClick={() => setViewPersist('calendar')} label="캘린더" icon="clock" />
        </div>
        {viewMode === 'list' && (
          <>
            <FilterChip active={statusFilter==='active'}    onClick={() => setStatusFilter('active')}    label="예정+진행" count={qError || !allReservations ? '—' : activeCount} tone="primary" />
            <FilterChip active={statusFilter==='completed'} onClick={() => setStatusFilter('completed')} label="완료"     count={qError || !allReservations ? '—' : completedCount} tone="success" />
            <FilterChip active={statusFilter==='cancelled'} onClick={() => setStatusFilter('cancelled')} label="취소"     count={qError || !allReservations ? '—' : cancelledCount} tone="warn" />
            <FilterChip active={statusFilter==='all'}       onClick={() => setStatusFilter('all')}       label="전체"     count={qError || !allReservations ? '—' : allReservations.length} />
          </>
        )}
        {viewMode === 'calendar' && (
          <input type="month" value={calYm} onChange={e => setCalYm(e.target.value || calYm)}
            style={{ ...st.dateInput, minWidth: 130 }} />
        )}
        <button onClick={() => setEditing('new')} style={{
          marginLeft: 'auto', ...st.btnPrimary, display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Icon name="plus" size={13} /> 새 예약
        </button>
      </div>

      <>{error && <BusinessError onRetry={refetch}>예약 정보를 불러오지 못했습니다.</BusinessError>}</>
      {loading && !list && <SkeletonList count={3} itemHeight={80} />}
      {!error && list && list.length === 0 && viewMode === 'list' && <div style={st.muted}>예약이 없습니다.</div>}

      {viewMode === 'list' && list && list.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 320px), 1fr))', gap: 8 }}>
          {list.map(r => (
            <ReservationCard key={r.id} r={r} onEdit={() => setEditing(r)}
              onDelete={async () => {
                const ok = await confirmDialog({ title: '예약 취소', body: '예약을 취소할까요? 기존 내역은 유지됩니다.', danger: true });
                if (!ok) return;
                try { await deleteResvMut.mutateAsync(r.id); }
                catch (e) { await alertDialog({ title: '삭제 실패', body: e.message, tone: 'danger' }); }
              }} />
          ))}
        </div>
      )}

      {viewMode === 'calendar' && (
        <ReservationCalendar ym={calYm} list={list || []}
          onDayClick={(dateStr) => setEditing({ new: dateStr })}
          onEventClick={(r) => setEditing(r)} />
      )}

      {editing && (
        <ReservationDialog init={editing === 'new' ? null : editing} devices={devices} staff={staff}
          presetDate={editing?.new || null}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)} />
      )}
    </div>
  );
}

function ViewToggleBtn({ active, onClick, label, icon }) {
  return (
    <button onClick={onClick} style={{
      padding: '6px 12px', borderRadius: 999, border: 'none', cursor: 'pointer',
      background: active ? 'var(--surface)' : 'transparent',
      color: active ? 'var(--text)' : 'var(--text-3)',
      fontSize: 12, fontWeight: 700,
      boxShadow: active ? '0 1px 3px rgba(0,0,0,0.08)' : 'none',
      display: 'flex', alignItems: 'center', gap: 5,
      transition: 'all .15s',
    }}>
      <Icon name={icon} size={12} /> {label}
    </button>
  );
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
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 8,
    }}>
      {/* DoW header */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
        {DOW.map((d, i) => (
          <div key={d} style={{
            fontSize: 11, fontWeight: 700, padding: '6px 2px',
            textAlign: 'center',
            color: i === 0 ? 'var(--danger)' : i === 6 ? 'var(--primary)' : 'var(--text-2)',
          }}>{d}</div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
        {cells.map((c, i) => {
          const dStr = calendarDate(c.date);
          const dayResv = reservationsOn(c.date);
          const isToday = dStr === todayStr;
          const dow = c.date.getDay();
          const MAX_BADGES = 2;   // 모바일 대응: 셀 폭 좁을 때 3개는 넘침
          return (
            <div key={i} onClick={() => c.currentMonth && onDayClick(dStr)} style={{
              minHeight: 'clamp(56px, 12vw, 84px)',
              padding: 3,
              background: isToday
                ? 'color-mix(in srgb, var(--primary) 8%, transparent)'
                : c.currentMonth ? 'var(--surface)' : 'var(--surface-2)',
              border: '1px solid ' + (isToday ? 'var(--primary)' : 'var(--border)'),
              borderRadius: 6,
              opacity: c.currentMonth ? 1 : 0.4,
              cursor: c.currentMonth ? 'pointer' : 'default',
              display: 'flex', flexDirection: 'column', gap: 2,
              overflow: 'hidden',
              minWidth: 0,
            }}>
              <div style={{
                fontSize: 11, fontWeight: 700,
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
                  <div key={r.id} onClick={(e) => { e.stopPropagation(); onEventClick(r); }} style={{
                    fontSize: 10, fontWeight: 600,
                    padding: '1px 3px', borderRadius: 3,
                    background: s.bg, color: s.color,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                    cursor: 'pointer',
                    minWidth: 0,
                  }} title={`${r.license_plate || r.device_name || ''} · ${r.purpose || ''} · ${s.label}`}>
                    {[r.vehicle_name,r.license_plate].filter(Boolean).join(' · ') || '차량'}
                  </div>
                );
              })}
              {dayResv.length > MAX_BADGES && (
                <div style={{ fontSize: 9, color: 'var(--text-3)', textAlign: 'center' }}>
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

function ReservationCard({ r, onEdit, onDelete }) {
  const s = RESV_STATUS[r.status] || RESV_STATUS.planned;
  const start = new Date(r.starts_at);
  const end   = new Date(r.ends_at);
  const fmtDT = d => d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const sameDay = start.toDateString() === end.toDateString();
  // (2026-07-28) Stage-4H-1/2: 임박 표시.
  const minsUntilStart = Math.round((start.getTime() - Date.now()) / 60_000);
  const minsUntilEnd   = Math.round((end.getTime()   - Date.now()) / 60_000);
  const isImminent  = r.status === 'planned'     && minsUntilStart >= 0 && minsUntilStart <= 60;
  const isReturning = r.status === 'in_progress' && minsUntilEnd   >= 0 && minsUntilEnd   <= 60;
  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{
          fontSize: 10, padding: '3px 8px', borderRadius: 999,
          background: s.bg, color: s.color, fontWeight: 700,
        }}>{s.label}</span>
        {isImminent && (
          <span style={{
            fontSize: 10, padding: '3px 8px', borderRadius: 999,
            background: 'color-mix(in srgb, var(--warning) 20%, transparent)',
            color: 'var(--warning)', fontWeight: 800,
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }} title={`${minsUntilStart}분 후 예약이 시작됩니다`}>
            🔔 {minsUntilStart === 0 ? '지금 시작' : `${minsUntilStart}분 후 시작`}
          </span>
        )}
        {isReturning && (
          <span style={{
            fontSize: 10, padding: '3px 8px', borderRadius: 999,
            background: 'color-mix(in srgb, var(--danger) 20%, transparent)',
            color: 'var(--danger)', fontWeight: 800,
            display: 'inline-flex', alignItems: 'center', gap: 4,
          }} title={`${minsUntilEnd}분 후 반납 — 30분 전 알림`}>
            🔔 {minsUntilEnd === 0 ? '지금 반납' : `${minsUntilEnd}분 후 반납`}
          </span>
        )}
        <span style={{ fontWeight: 700, fontSize: 14 }}>
          {[r.vehicle_name,r.license_plate].filter(Boolean).join(' · ') || '차량'}
        </span>
        {r.driver_name && (
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 4,
            background: 'var(--surface-2)', color: 'var(--text-2)', fontWeight: 600,
          }}>👤 {r.driver_name}</span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button onClick={onEdit} style={{ ...st.btnGhost, padding: '4px 8px' }} title="편집">
            <Icon name="edit" size={12} />
          </button>
          <button onClick={onDelete} style={{ ...st.btnGhost, padding: '4px 8px', color: 'var(--danger)' }} title="예약 취소">
            <Icon name="trash2" size={12} />
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 4 }}>
        <Icon name="clock" size={12} />
        {sameDay
          ? `${start.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })} ${start.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })} ~ ${end.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}`
          : `${fmtDT(start)} ~ ${fmtDT(end)}`}
      </div>
      {r.purpose && (
        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
          <span style={{ color: 'var(--text-3)' }}>목적</span>
          <span style={{ marginLeft: 6 }}>{r.purpose}</span>
        </div>
      )}
      {r.note && (
        <div style={{
          fontSize: 11, color: 'var(--text-2)',
          padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 6,
        }}>📝 {r.note}</div>
      )}
    </div>
  );
}

// datetime-local input value 는 'YYYY-MM-DDTHH:MM' 로컬 시간 문자열.
// ISO 로 변환 (Date 는 로컬 문자열을 로컬 시간으로 파싱 → toISOString 은 UTC).
function localToIso(v) { return v ? new Date(v).toISOString() : null; }
function isoToLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ReservationDialog({ init, presetDate, devices, staff, onClose, onSaved }) {
  const access=useFleetAccess();
  // init null = 신규. presetDate 'YYYY-MM-DD' 있으면 그 날 09:00~10:00 기본.
  // 아니면 다음 정시부터 +1h.
  const defaultStart = () => {
    if (presetDate) return new Date(`${presetDate}T09:00:00`);
    const d = new Date(); d.setMinutes(0, 0, 0); d.setHours(d.getHours() + 1); return d;
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
  const busy = createMut.isPending || updateMut.isPending;

  async function save() {
    if (!deviceId) { alertDialog({ title: '차량 선택 필요', body: '', tone: 'danger' }); return; }
    if (!startsAt || !endsAt) { alertDialog({ title: '시간 입력 필요', body: '', tone: 'danger' }); return; }
    const body = {
      vehicle_id:      Number(deviceId),
      driver_staff_id: driverId ? Number(driverId) : null,
      starts_at:       localToIso(startsAt),
      ends_at:         localToIso(endsAt),
      purpose:         purpose.trim() || null,
      report_purpose: reportPurpose || null,
      note:            note.trim() || null,
      status,
    };
    try {
      if (init?.id) await updateMut.mutateAsync({ id: init.id, body });
      else          await createMut.mutateAsync(body);
      onSaved();
    } catch (e) {
      alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    }
  }

  return (
    <Modal open onClose={onClose} size="md" title={init?.id ? '예약 편집' : '새 예약'} footer={<>
      <Button onClick={onClose} disabled={busy} variant="ghost" size="lg" style={{ flex: 1 }}>취소</Button>
      <Button onClick={save} busy={busy} variant="primary" size="lg" style={{ flex: 2 }}>
        {busy ? '저장 중...' : '저장'}
      </Button>
    </>}>

        <FormField label="차량">
          <select value={deviceId} onChange={e => {setDeviceId(e.target.value);setDriverId(access.manage_reports?'':access.staff_id);}} style={st.input}>
            {(devices || []).map(d => (
              <option key={d.id} value={d.id}>
                {reportVehicleLabel(d)}
              </option>
            ))}
          </select>
        </FormField>

        <FormField label="운전자 (선택)">
          <select value={driverId} onChange={e => setDriverId(e.target.value)} style={st.input}>
            {access.manage_reports&&<option value="">— 미지정 —</option>}
            {staff.filter(s=>staffCanDrive(s,devices.find(d=>d.id===Number(deviceId)))).map(s => <option key={s.id} value={s.id}>{s.name}{s.role ? ` (${s.role})` : ''}</option>)}
          </select>
        </FormField>

        <div className="business-datetime-fields">
          <FormField label="시작">
            <input type="datetime-local" value={startsAt} onChange={e => setStartsAt(e.target.value)} style={st.input} />
          </FormField>
          <FormField label="종료">
            <input type="datetime-local" value={endsAt} onChange={e => setEndsAt(e.target.value)} style={st.input} />
          </FormField>
        </div>

        <FormField label="운행기록부 용무 (선택)">
          <Select value={reportPurpose} onChange={e=>setReportPurpose(e.target.value)}><option value="">미지정</option><option value="commute">출퇴근</option><option value="business">업무</option><option value="other">기타</option></Select>
        </FormField>
        <FormField label="예약 목적">
          <input value={purpose} onChange={e => setPurpose(e.target.value)}
            placeholder="거래처 방문, 외근..." style={st.input} />
        </FormField>

        <FormField label="메모 (선택)">
          <textarea value={note} onChange={e => setNote(e.target.value)}
            placeholder="예약 관련 내용을 입력하세요." style={{ ...st.input, minHeight: 80, resize: 'vertical', fontFamily: 'inherit' }} />
        </FormField>

        {init?.id && (
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>상태</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(72px, 1fr))', gap: 4 }}>
              {Object.entries(RESV_STATUS).map(([id, meta]) => (
                <button key={id} onClick={() => setStatus(id)} style={{
                  padding: '8px 4px', fontSize: 11, borderRadius: 8, cursor: 'pointer',
                  background: status === id ? meta.color : 'var(--surface-2)',
                  color:      status === id ? 'white'    : 'var(--text)',
                  border: 'none', fontWeight: status === id ? 700 : 500,
                }}>{meta.label}</button>
              ))}
            </div>
          </div>
        )}

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
const BUSINESS_PURPOSES = new Set(['business','commute']);

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
        let totalM = 0, businessM = 0, personalM = 0;
        let annCostSum = 0, annCostCount = 0;
        for (const t of trips) {
          if (typeof t.annotation?.fuel_cost === 'number') {
            annCostSum += t.annotation.fuel_cost;
            annCostCount++;
          }
          if(!reportIncluded(t)) continue;
          if(!t.ended_at || t.distance_m == null)continue;
          const dist = t.distance_m || 0;
          totalM += dist;
          const purpose = t.annotation?.purpose || 'unspecified';
          if (BUSINESS_PURPOSES.has(purpose)) businessM += dist;
          else personalM += dist;
        }
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
          totalKm:    totalM / 1000,
          businessKm: businessM / 1000,
          personalKm: personalM / 1000,
          annotationCost: annCostSum,           // 사용자가 직접 입력한 비용 합계 (있으면 우선)
          annotationCount: annCostCount,
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

  // fleet 총계 — stat card 5개. (부서 필터 적용된 filteredRows 사용)
  const totals = useMemo(() => {
    const use = filteredRows || rows;
    if (!use) return { totalKm: 0, businessKm: 0, personalKm: 0, fuelCost: 0, depreciation: 0 };
    let totalKm = 0, businessKm = 0, personalKm = 0, fuelCost = 0, depreciation = 0;
    for (const r of use) {
      totalKm    += r.totalKm;
      businessKm += r.businessKm;
      personalKm += r.personalKm;
      fuelCost   += estimateFuelCost(r);
      depreciation += estimateDepreciation(r);
    }
    return { totalKm, businessKm, personalKm, fuelCost, depreciation };
  }, [rows, filteredRows]);

  const fmtKm  = (n) => n < 1 ? '0' : n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString();
  const fmtWon = (n) => n.toLocaleString() + '원';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="no-print" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input type="month" value={ym} onChange={e => setYm(e.target.value || ymKST())}
          style={{ ...st.dateInput, minWidth: 130 }} />
        <button onClick={() => setDlOpen(true)} style={{
          ...st.btnPrimary, display: 'flex', alignItems: 'center', gap: 6,
        }}>
          <Icon name="share" size={13} /> 운행일지 다운로드
        </button>
        <FuelPriceBadge prices={fuelPrices} />
        <ExportButtons report={filteredRows ? monthlyReport(filteredRows,{month:ym,estimateFuelCost,estimateDepreciation}) : null} disabled={loading || !!error} />
      </div>

      <StatCardGrid>
        <StatCard icon="bar"    label="총 주행거리"   value={fmtKm(totals.totalKm)}    unit="km" tone="default" loading={loading || !!error} />
        <StatCard icon="route"  label="업무거리"     value={fmtKm(totals.businessKm)} unit="km" tone="primary" loading={loading || !!error} />
        <StatCard icon="mapPin" label="기타·미분류 거리"     value={fmtKm(totals.personalKm)} unit="km" tone="default" loading={loading || !!error} />
        <StatCard icon="coin"   label="유류비 추정"   value={fmtWon(Math.round(totals.fuelCost))} tone="warn" loading={loading || !!error}
          hint="연비 미입력 차량은 제외" />
        <StatCard icon="bar"    label="감가상각 인정" value={fmtWon(Math.round(totals.depreciation))} tone="primary" loading={loading || !!error}
          hint="5년 정액법 × 업무비율 · 한도 800만/년" />
      </StatCardGrid>

      {/* (Stage-4G) 부서 필터 chips — 부서가 2개 이상일 때만 표시 */}
      {departments.length >= 2 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 700, marginRight: 4 }}>부서</span>
          <FilterChip active={!depFilter || depFilter.size === 0} onClick={() => setDepFilter(null)}
            label="전체" count={rows?.length ?? 0} />
          {departments.map(dep => {
            const cnt = (rows || []).filter(r => (r.department || '(부서없음)') === dep).length;
            const on = depFilter?.has(dep);
            return (
              <FilterChip key={dep} active={on}
                onClick={() => setDepFilter(prev => {
                  const s = new Set(prev ?? []);
                  if (s.has(dep)) s.delete(dep); else s.add(dep);
                  return s.size === 0 ? null : s;
                })}
                label={dep} count={cnt} tone={on ? 'success' : 'default'} />
            );
          })}
        </div>
      )}

      <>{error && <BusinessError onRetry={() => setTick(t => t + 1)}>일부 차량의 운행기록을 불러오지 못해 월간 합계를 표시하지 않았습니다.</BusinessError>}</>
      {loading && !rows && <div style={st.muted}>월간 데이터 로딩 중...</div>}
      {rows && rows.length === 0 && <div style={st.muted}>차량이 없습니다.</div>}

      {rows && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {(filteredRows || rows).length === 0 && (
            <div style={st.muted}>선택한 부서에 차량이 없습니다.</div>
          )}
          {(filteredRows || rows).map(r => (
            <MonthlyDeviceRow key={r.id} row={r} onEdit={() => setEditing(r)} />
          ))}
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
    <div style={{
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

function DownloadDialog({ ym, devices, initialDepartments, onClose }) {
  const [kind, setKind] = useState('nts');
  // null = 전체. Set<number> = 선택 차량 id.
  const [selectedDevs, setSelectedDevs] = useState(null);
  // null = 전체. Set<string> = 선택 목적.
  const [selectedPurps, setSelectedPurps] = useState(null);
  // null = 전체. Set<string> = 선택 부서. (Stage-4G, MonthlyReport 부서 필터 초기값 승계)
  const [selectedDeps, setSelectedDeps] = useState(initialDepartments ? new Set(initialDepartments) : null);
  const [busy, setBusy] = useState(false);

  const departmentOptions = useMemo(() => {
    const s = new Set();
    for (const d of devices || []) s.add(d.department || '(부서없음)');
    return Array.from(s).sort();
  }, [devices]);

  const allDevIds = useMemo(() => new Set((devices || []).map(d => d.id)), [devices]);
  const isAllDev = !selectedDevs || selectedDevs.size === allDevIds.size;

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
    if (selectedDevs?.size === 0 || selectedPurps?.size === 0 || selectedDeps?.size === 0) {
      await alertDialog({title:'선택 항목 확인',body:'차량·용무·부서를 각각 하나 이상 선택해 주세요.'});
      return;
    }
    setBusy(true);
    try {
      const params = { type: kind, month: ym };
      params.scope='vehicles';
      if (selectedDevs && !isAllDev) params.vehicle_ids = Array.from(selectedDevs);
      if (selectedPurps && selectedPurps.size > 0 && selectedPurps.size < PURPOSE_ALL.length) {
        params.purposes = Array.from(selectedPurps);
      }
      if (selectedDeps && selectedDeps.size > 0 && selectedDeps.size < departmentOptions.length) {
        params.departments = Array.from(selectedDeps);
      }
      const { blob, filename } = await api.reportXlsx(params);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      onClose();
    } catch (e) {
      alertDialog({ title: '다운로드 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  return (
    <Modal open title="운행기록부 XLSX 다운로드" size="lg" onClose={busy ? () => {} : onClose}>
      <div style={{display:'flex',flexDirection:'column',gap:14}}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 800 }}>운행일지 다운로드</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
            {ym} · {devices?.length || 0}대 차량 · XLSX
          </div>
        </div>

        {/* 양식 */}
        <FieldSection label="양식">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 }}>
            {[
              { id: 'nts',  title: '업무용승용차 운행기록부', hint: '첨부 서식 항목 · 계기판 거리 보완 필요' },
              { id: 'ours', title: '우리 양식',         hint: '요약 + 차량별 상세 · 실무용' },
            ].map(o => {
              const on = kind === o.id;
              return (
                <button key={o.id} onClick={() => setKind(o.id)} style={{
                  padding: '12px', borderRadius: 10, cursor: 'pointer',
                  textAlign: 'left', border: '2px solid ' + (on ? 'var(--primary)' : 'var(--border)'),
                  background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface)',
                }}>
                  <div style={{ fontWeight: 700, fontSize: 13, color: on ? 'var(--primary)' : 'var(--text)' }}>
                    {o.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>{o.hint}</div>
                </button>
              );
            })}
          </div>
        </FieldSection>

        {/* 차량 */}
        <FieldSection label="차량" trailing={
          <button onClick={() => setSelectedDevs(isAllDev ? new Set() : null)}
            style={{ ...st.btnGhost, fontSize: 11 }}>
            {isAllDev ? '개별 선택' : '전체'}
          </button>
        }>
          {isAllDev ? (
            <div style={{
              padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8,
              fontSize: 12, color: 'var(--text-2)',
            }}>
              전체 {devices?.length || 0}대
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto' }}>
              {(devices || []).map(d => {
                const on = selectedDevs?.has(d.id);
                return (
                  <label key={d.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                    background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface-2)',
                  }}>
                    <input type="checkbox" checked={!!on} onChange={() => toggleDev(d.id)} />
                    <span style={{ fontSize: 12, fontWeight: 600 }}>
                      {reportVehicleLabel(d)}
                    </span>
                    {d.department && (
                      <span style={{ fontSize: 10, color: 'var(--text-3)' }}>· {d.department}</span>
                    )}
                  </label>
                );
              })}
              <div style={{ fontSize: 11, color: 'var(--text-3)', paddingLeft: 12 }}>
                {selectedDevs?.size || 0} / {devices?.length || 0} 선택
              </div>
            </div>
          )}
        </FieldSection>

        {/* 기간 (readonly, 상단 month picker 로 조정) */}
        <FieldSection label="기간">
          <div style={{
            padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8,
            fontSize: 12, color: 'var(--text-2)', display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <Icon name="clock" size={12} />
            {ym} (한 달)
            <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-3)' }}>
              다른 달은 리포트 상단 월 선택으로 변경
            </span>
          </div>
        </FieldSection>

        {/* (Stage-4G) 부서 — 부서 옵션이 2개 이상일 때만 표시 */}
        {departmentOptions.length >= 2 && (
          <FieldSection label="부서" trailing={
            <button onClick={() => setSelectedDeps(prev => prev == null ? new Set() : null)}
              style={{ ...st.btnGhost, fontSize: 11 }}>
              {selectedDeps == null ? '개별 선택' : '전체'}
            </button>
          }>
            {selectedDeps == null ? (
              <div style={{
                padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8,
                fontSize: 12, color: 'var(--text-2)',
              }}>
                전체 {departmentOptions.length}개 부서
              </div>
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 4 }}>
                {departmentOptions.map(dep => {
                  const on = selectedDeps?.has(dep);
                  return (
                    <label key={dep} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                      background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface-2)',
                      fontSize: 12, fontWeight: 600,
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
            style={{ ...st.btnGhost, fontSize: 11 }}>
            {selectedPurps == null ? '개별 선택' : '전체'}
          </button>
        }>
          {selectedPurps == null ? (
            <div style={{
              padding: '10px 14px', background: 'var(--surface-2)', borderRadius: 8,
              fontSize: 12, color: 'var(--text-2)',
            }}>
              전체 (업무·출퇴근·기타·미지정)
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4 }}>
              {PURPOSE_ALL.map(p => {
                const on = selectedPurps?.has(p.id);
                return (
                  <label key={p.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px', borderRadius: 8, cursor: 'pointer',
                    background: on ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'var(--surface-2)',
                    fontSize: 12, fontWeight: 600,
                  }}>
                    <input type="checkbox" checked={!!on} onChange={() => togglePurp(p.id)} />
                    {p.label}
                  </label>
                );
              })}
            </div>
          )}
        </FieldSection>

        {kind === 'nts' && <p className="business-note">GPS 거리를 사용하며 사용자 부서와 계기판 거리는 비워 둡니다. 회사·차량 정보와 과세기간을 확인하고 누락 항목을 보완해 주세요. 종료 미수신 운행은 합계에서 제외됩니다.</p>}
        {/* 액션 */}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button onClick={onClose} disabled={busy} style={{ ...st.btnGhost, flex: 1 }}>취소</button>
          <button onClick={download} disabled={busy} style={{
            ...st.btnPrimary, flex: 2, padding: '12px', fontSize: 13, gap: 8,
          }}>
            <Icon name="share" size={14} />
            {busy ? '생성 중...' : 'XLSX 다운로드'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function FieldSection({ label, trailing, children }) {
  return (
    <div>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        fontSize: 11, fontWeight: 700, color: 'var(--text-2)', marginBottom: 6,
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
  const cost = estimateFuelCost(row);
  const dep  = estimateDepreciation(row);
  const total = row.totalKm || 1;   // divide-by-zero 방지
  const bizPct = Math.round((row.businessKm / total) * 100);
  const perPct = 100 - bizPct;
  const fmtKm = (n) => n < 1 ? '0' : n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString();
  // 감가상각 연 800만 한도 초과 여부 힌트 (월 66.7만 초과 = 연 800만 override)
  const overLimit = dep > (YEARLY_BIZ_LIMIT_KRW / 12);

  return (
    <div style={{
      background: 'var(--surface)', border: '1px solid var(--border)',
      borderRadius: 12, padding: 14, display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>{row.label}</span>
            {row.license_plate && (
              <span style={{
                fontSize: 10, padding: '2px 6px', borderRadius: 4,
                background: 'var(--surface-2)', color: 'var(--text-2)', fontWeight: 700,
                letterSpacing: '0.02em',
              }}>{row.license_plate}</span>
            )}
            {row.department && (
              <span style={{
                fontSize: 10, padding: '2px 6px', borderRadius: 4,
                background: 'color-mix(in srgb, var(--primary) 12%, transparent)',
                color: 'var(--primary)', fontWeight: 600,
              }}>{row.department}</span>
            )}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            {row.fuel_efficiency_kmpl
              ? `${FUEL_LABEL[row.fuel_type] || '?'} · ${row.fuel_efficiency_kmpl}km/L`
              : <span style={{ color: 'var(--warning)' }}>연비 미입력</span>}
            {row.model_year && ` · ${row.model_year}년식`}
            {row.engine_cc  && ` · ${row.engine_cc.toLocaleString()}cc`}
            {row.annotationCount > 0 && ' · 실 입력비 반영'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontWeight: 700, fontSize: 15, fontVariantNumeric: 'tabular-nums' }}>
            {fmtKm(row.totalKm)}<span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 3 }}>km</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--primary)', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
            {cost > 0 ? Math.round(cost).toLocaleString() + '원' : '–'}
          </div>
        </div>
        <button disabled={!access.manage_vehicles} onClick={onEdit} style={{
          fontSize: 11, padding: '6px 10px', borderRadius: 8,
          background: 'var(--surface-2)', border: '1px solid var(--border)',
          color: 'var(--text-2)', cursor: 'pointer', fontWeight: 600,
        }}>
          정보 편집
        </button>
      </div>

      {/* stacked bar: business (primary) + personal (accent muted) */}
      <div style={{ height: 8, borderRadius: 4, background: 'var(--surface-2)', overflow: 'hidden', display: 'flex' }}>
        {row.businessKm > 0 && (
          <div style={{ width: `${bizPct}%`, background: 'var(--primary)' }} title={`업무 ${fmtKm(row.businessKm)}km`} />
        )}
        {row.personalKm > 0 && (
          <div style={{ width: `${perPct}%`, background: 'var(--accent)', opacity: 0.6 }} title={`개인 ${fmtKm(row.personalKm)}km`} />
        )}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text-3)' }}>
        <span>업무 {fmtKm(row.businessKm)}km · {bizPct}%</span>
        <span>개인 {fmtKm(row.personalKm)}km · {perPct}%</span>
      </div>

      {/* (2026-07-28) Stage-4E 감가상각 인정액 (취득가액 입력된 경우만) */}
      {row.purchase_price_krw > 0 && (
        <div style={{
          fontSize: 11, color: 'var(--text-2)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '6px 10px', background: 'var(--surface-2)', borderRadius: 6, marginTop: 2,
        }}>
          <span>
            <span style={{ color: 'var(--text-3)' }}>감가상각 인정</span>
            <span style={{ marginLeft: 6, fontWeight: 700, color: 'var(--primary)' }}>
              {Math.round(dep).toLocaleString()}원
            </span>
            <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 4 }}>
              (월 {Math.round(row.purchase_price_krw / 60).toLocaleString()} × {bizPct}%)
            </span>
          </span>
          {overLimit && (
            <span style={{
              fontSize: 10, padding: '2px 6px', borderRadius: 4,
              background: 'color-mix(in srgb, var(--warning) 15%, transparent)',
              color: 'var(--warning)', fontWeight: 700,
            }} title="연 800만원 한도 초과분은 이월 처리 (세법 개정 2020)">
              한도 초과
            </span>
          )}
        </div>
      )}
    </div>
  );
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
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {children != null ? children : (
        <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          style={st.input} />
      )}
    </div>
  );
}

// ─── TripEditorModal 전용 스타일 ─────────────────────
const mst = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 900,
    background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
    animation: 'fadeInUp .15s ease-out',
  },
  modal: {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 14,
    width: '100%', maxWidth: 460, overflow: 'hidden',
    boxShadow: '0 20px 60px rgba(0,0,0,.4)',
    animation: 'fadeInUp .18s ease-out',
    display: 'flex', flexDirection: 'column',
    maxHeight: '90vh',
  },
  header: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    padding: '14px 16px', borderBottom: '1px solid var(--border)',
  },
  closeBtn: {
    width: 28, height: 28, borderRadius: 6,
    background: 'transparent', color: 'var(--text-3)',
    border: 'none', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  body: {
    padding: 16, overflowY: 'auto', flex: 1,
  },
  input: {
    display: 'block', width: '100%', padding: '8px 10px',
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 13, boxSizing: 'border-box', outline: 'none',
  },
  actions: {
    display: 'flex', gap: 8, padding: '12px 16px',
    borderTop: '1px solid var(--border)',
  },
  btnPrimary: {
    flex: 1, padding: '10px 16px',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 8,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  btnSecondary: {
    flex: 1, padding: '10px 16px',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 13, cursor: 'pointer',
  },
};

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

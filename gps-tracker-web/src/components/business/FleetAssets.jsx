import {useFleetAccess,useFleetOrganization} from './FleetAccess';
import React,{useEffect,useId,useMemo,useRef,useState} from 'react';
import {useQuery,useQueryClient,useMutation} from '@tanstack/react-query';
import {api} from '../../api';
import {useStaff} from '../../state';
import {Modal,FormField,Input,Select,Textarea,Button} from '../ui';
import FleetAssetMedia from './FleetAssetMedia';
import FleetBatchBindings from './FleetBatchBindings';
import FleetOperations from './FleetOperations';
import {downloadReport} from '../../lib/downloadReport';
import BusinessDrawer from './BusinessDrawer';
import {fleetDistance} from '../../lib/corporateOverview';
import {useBusinessClock} from './useBusinessData';
import {kstDateTime} from '../../lib/businessExport';
import {projectFleetAssets,fleetAssetLabel} from '../../lib/fleetAssets';
import {emptyAssetFilters,maintenanceScheduleFields,missingScheduleFields,filterFleetAssets,assetFilterError,assetOdometer,assetRegistrationDay} from '../../lib/fleetAssetFilters';
import {classifyDevice,ageString} from '../../colors';
import {deviceBattery} from '../../lib/battery';
import BatteryStatus from '../BatteryStatus';
import CarImage from '../CarImage';
import BusinessMap from './BusinessMap';
import {DirectoryLayout,DirectoryGroups} from './DirectoryLayout';
import useCorporatePhone from '../../useCorporatePhone';
import {useVehicleGroups,VehicleGroupForm} from './FleetVehicleGroups';
import Icon from '../Icon';
import './fleet-assets-cartax.css';
import './fleet-reference-vehicles.css';

export const fleetAssetsKey=['business','corporate','vehicles'];
export function useFleetAssets() {return useQuery({queryKey:fleetAssetsKey,queryFn:()=>api.listFleetVehicles(),staleTime:15000});}
export {projectFleetAssets} from '../../lib/fleetAssets';
const vehicleDepartmentKey=asset=>asset.department_id!=null?`department:${asset.department_id}`:asset.department?.trim()?`department-name:${asset.department.trim()}`:'unassigned';
const emptyVehicleLabels=new Set(['','-','—','미등록','차량정보미등록','차량번호미등록','차종미등록']);
function mobileVehicleLabels(vehicle,manager){
  const labels=new Map();
  const add=value=>{
    const label=value?.trim()||'';
    const key=label.normalize('NFKC').replace(/\s+/g,'').toLowerCase();
    if(!emptyVehicleLabels.has(key)&&!labels.has(key))labels.set(key,label);
  };
  add(vehicle.license_plate);
  add(vehicle.name);
  if(!labels.size)labels.set('차량정보미등록','차량 정보 미등록');
  add(vehicle.car_model);
  add(manager?.trim()||vehicle.department);
  return [...labels.values()];
}
export function FleetAssets({assets,devices,onChanged,onMap,meta={},onReport,onReserve,initialMissingSchedules=false,mapReturn,initialCreate=false,mode='vehicles',canRegisterTerminal=false}) {
  const access=useFleetAccess();
  const mobile=useCorporatePhone();
  const [edit,setEdit]=useState(()=>initialCreate&&access.manage_vehicles?{}:null),[detail,setDetail]=useState(mapReturn?.vehicleId ?? null),[query,setQuery]=useState(mapReturn?.directory?.query ?? ''),[group,setGroup]=useState(mapReturn?.directory?.group ?? 'all'),[sort,setSort]=useState(mapReturn?.directory?.sort ?? 'name');
  const groups=useVehicleGroups(mode==='vehicles');
  const [addGroup,setAddGroup]=useState(false);
  const [department,setDepartment]=useState(mapReturn?.directory?.department || '');
  const [availability,setAvailability]=useState(mapReturn?.directory?.availability || '');
  const [exportError,setExportError]=useState(''),[exporting,setExporting]=useState(false);
  const [requestedTerminal,setRequestedTerminal]=useState(null);
  const [detailTab,setDetailTab]=useState(mapReturn?.detailTab ?? 'status');
  const openDetail=(id,tab='status',terminal=null)=>{setRequestedTerminal(terminal);setDetailTab(tab);setDetail(id);};
  const [filters,setFilters]=useState(()=>({...emptyAssetFilters,missingSchedulesOnly:initialMissingSchedules,...mapReturn?.directory?.filters}));
  const [scheduleAsset,setScheduleAsset]=useState(null);
  const [filterOpen,setFilterOpen]=useState(false),[draft,setDraft]=useState({...emptyAssetFilters});
  const filterError=assetFilterError(draft);
  const advancedActive=Object.keys(emptyAssetFilters).some(key=>filters[key]!==emptyAssetFilters[key]);
  const filtered=advancedActive||query.trim()||group!=='all'||department||availability;
  const reset=()=>{setQuery('');setGroup('all');setDepartment('');setAvailability('');setSort('name');setFilters({...emptyAssetFilters});};
  const changeFilter=(key,value)=>setDraft(f=>({...f,[key]:value,...(key==='distance'&&value==='missing'?{minKm:'',maxKm:''}:{})}));
  const openFilters=()=>{setDraft({...filters});setFilterOpen(true);};
  const {data:staff=[]}=useStaff();
  const selected=assets.find(v=>v.id===detail);
  const scope=useMemo(()=>filterFleetAssets(assets,{query,sort,...filters},staff),[assets,query,sort,filters,staff]);
  const departments=useMemo(()=>{
    const groups=new Map();
    for(const asset of assets){const id=vehicleDepartmentKey(asset);if(id!=='unassigned')groups.set(id,{id,label:asset.department?.trim()||'이름 없는 부서'});}
    return [...groups.values()].sort((a,b)=>a.label.localeCompare(b.label,'ko',{numeric:true}));
  },[assets]);
  const filteredScope=useMemo(()=>scope.filter(v=>(!department || vehicleDepartmentKey(v)===department) && (!availability || v.enabled===(availability==='enabled'))),[scope,department,availability]);
  const groupItems=useMemo(()=>{
    const counts=new Map();
    for(const v of filteredScope) counts.set(v.group_id,(counts.get(v.group_id)||0)+1);
    return [{id:'all',label:'전체 차량',count:filteredScope.length},...(groups.data||[]).map(g=>({id:String(g.id),label:g.name,count:counts.get(g.id)||0})),{id:'unassigned',label:'그룹 미지정',count:filteredScope.filter(v=>v.group_id==null).length}];
  },[groups.data,filteredScope]);
  const rows=useMemo(()=>filteredScope.filter(v=>group==='all'||(group==='unassigned'?v.group_id==null:String(v.group_id)===group)),[filteredScope,group]);
  const inGroup=scope.filter(v=>group==='all'||(group==='unassigned'?v.group_id==null:String(v.group_id)===group));
  const stateScope=inGroup.filter(v=>!department||vehicleDepartmentKey(v)===department);
  const departmentCounts=new Map();
  for(const v of inGroup) if(!availability || v.enabled===(availability==='enabled')) {
    const key=vehicleDepartmentKey(v);departmentCounts.set(key,(departmentCounts.get(key)||0)+1);
  }
  const createInGroup=()=>setEdit({group_id:groups.data?.find(g=>String(g.id)===group)?.id || null});
  const groupButton=access.manage_vehicles&&<button type="button" className="business-button fleet-add-group" aria-label="차량 그룹 추가" title="차량 그룹 추가" onClick={()=>setAddGroup(true)}><Icon name="plus" size={15}/><span>그룹 추가</span></button>;
  const statusSelect=<select aria-label="등록 차량 운영 상태" value={availability} onChange={e=>setAvailability(e.target.value)}><option value="">전체 상태</option><option value="enabled">사용 가능 ({stateScope.filter(v=>v.enabled).length})</option><option value="disabled">사용 정지 ({stateScope.filter(v=>!v.enabled).length})</option></select>;
  const projected=useMemo(()=>projectFleetAssets(assets,devices),[assets,devices]);
  const byVehicle=useMemo(()=>new Map(projected.map(d=>[d.id,d])),[projected]);
  const stats=useAssetStats(projected);
  async function exportVehicles(){
    setExporting(true);setExportError('');
    const columns=[['plate','차량번호'],['name','차량명'],['model','차종'],['department','부서'],['manager','담당자'],['enabled','운영 상태'],['terminal','대표 단말기'],['distance','계기판 거리(km)'],['registered','등록일']].map(([key,label])=>({key,label}));
    try{
      await downloadReport({filename:'법인차_차량목록',columns,rows:rows.map(v=>({plate:v.license_plate,name:v.name,model:v.car_model,department:v.department,manager:staff.find(s=>s.id===v.manager_staff_id)?.name,enabled:v.enabled?'사용 가능':'사용 정지',terminal:byVehicle.get(v.id)?.display_name,distance:assetOdometer(v),registered:assetRegistrationDay(v.created_at)}))},'csv');
    }catch(error){setExportError(error.message||'차량 목록을 내려받지 못했습니다.');}
    finally{setExporting(false);}
  }
  const exportButton=<button type="button" className="business-button" disabled={!rows.length||exporting} onClick={exportVehicles}><Icon name="download" size={15}/>CSV 다운로드</button>;

  const closeEdit=()=>{setEdit(null);setScheduleAsset(null);};
  const saved=()=>{closeEdit();onChanged();};
  const countLabel=`${filters.missingSchedulesOnly?'점검 일정 미등록 ':'총 '}${rows.length}대${filtered?` · 전체 등록 ${assets.length}대`:''}`;
  const sortOptions=<><option value="name">차량 이름순</option><option value="created">최근 등록순</option><option value="distanceAsc">계기판 거리 낮은순</option><option value="distanceDesc">계기판 거리 높은순</option></>;
  const empty=!rows.length&&<div className="business-empty"><strong>{assets.length?'조건에 맞는 차량이 없습니다.':'차량을 먼저 등록해 주세요.'}</strong><p>{assets.length?'검색어나 필터를 변경해 주세요.':'단말기는 나중에 연결할 수 있습니다.'}</p></div>;
  return <div className="fleet-assets-list">
    {mode!=='vehicles'?<FleetOperations mode={mode} canRegisterTerminal={canRegisterTerminal} assets={assets} devices={devices} canManage={access.manage_vehicles} openDetail={openDetail} editSchedule={setScheduleAsset} refreshAssets={onChanged}/>:<>
    <div className="fleet-record-toolbar" aria-label="차량 목록 조회">
      <div className="fleet-record-query">
        <label className="fleet-inline-search"><Icon name="search" size={15}/><input type="search" aria-label="등록 차량 검색" placeholder="차량번호, 모델, 담당자 검색" value={query} onChange={e=>setQuery(e.target.value)}/></label>
        {statusSelect}
      </div>
      <div className="fleet-record-actions">{exportButton}{access.manage_vehicles&&<button className="business-button is-primary" type="button" onClick={createInGroup}><Icon name="plus" size={15}/>차량 등록</button>}</div>
    </div>
    <section className="fleet-record-filterbox" aria-label="차량 필터 조건">
      <div className="fleet-record-fields">
        <label>차량 소속 부서<select aria-label="등록 차량 부서" value={department} onChange={e=>setDepartment(e.target.value)}><option value="">전체 부서</option>{departments.map(d=><option key={d.id} value={d.id}>{d.label} ({departmentCounts.get(d.id)||0})</option>)}<option value="unassigned">부서 미지정 ({departmentCounts.get('unassigned')||0})</option></select></label>
        <label>정렬<select aria-label="등록 차량 정렬" value={sort} onChange={e=>setSort(e.target.value)}>{sortOptions}</select></label>
        <label>계기판 거리<select aria-label="차량 목록 계기판 거리" value={filters.distance} onChange={e=>setFilters(f=>({...f,distance:e.target.value,...(e.target.value==='missing'?{minKm:'',maxKm:''}:{})}))}><option value="all">전체 차량</option><option value="recorded">거리 등록</option><option value="missing">거리 미등록</option></select></label>
      </div>
      <div className="fleet-record-filterfoot"><span>전체 {assets.length}대 중 {rows.length}대 조회</span><div>
        {access.manage_vehicles&&<FleetBatchBindings assets={assets} devices={devices} onChanged={onChanged}/>}
        <button className="business-button" type="button" aria-expanded={filterOpen} onClick={openFilters}><Icon name="filter" size={14}/>필터</button>
        {(filtered||sort!=='name')&&<button className="business-button" type="button" onClick={reset}>필터 초기화</button>}
      </div></div>
    </section>
    <DirectoryLayout sidebar={<DirectoryGroups title="차량 그룹" aria-label="차량 그룹 조회" items={groupItems} value={group} onChange={setGroup} action={groupButton}/>}>
    <div className="fleet-assets-content">
    <section className="fleet-assets-ledger" aria-label="차량 목록">
      <header className="fleet-assets-table-heading"><h2>{groupItems.find(item=>item.id===group)?.label||'차량 목록'}</h2><span>{rows.length}대</span></header>
      {mobile?<>
      <div className="fleet-mobile-table-scroll" role="region" aria-label="차량 목록 · 좌우 스크롤" tabIndex={0}><div className="fleet-mobile-vehicle-columns" aria-hidden="true"><span>차량</span><span>운영 상태</span><span>단말기</span><span>계기판 거리</span></div><ul className="mobile-fleet-rows">{rows.map(v=>{
        const distance=assetOdometer(v),manager=staff.find(s=>s.id===v.manager_staff_id)?.name;
        const [title,...description]=mobileVehicleLabels(v,manager);
        const device=byVehicle.get(v.id);
        const terminalNames=v.bindings.filter(b=>!b.ended_at&&!b.is_primary).map(b=>b.terminal_name||'연결된 단말기');
        if(device.has_primary_terminal)terminalNames.unshift(device.display_name);
        const terminalStatus=device.has_primary_terminal&&device.source_device_id==null?' · 통신 정보 확인 불가':'';
        return <li key={v.id}>
          <button type="button" className="mobile-fleet-row mobile-vehicle-row"
            aria-label={`${fleetAssetLabel(v)} 상세`} onClick={()=>openDetail(v.id)}>
            <span className="fleet-mobile-vehicle-photo" aria-hidden="true"><CarImage vehicleId={v.id} version={v.profile?.car_image_url} fallback={<Icon name="car" size={21}/>}/></span>
            <span className="mobile-fleet-row-main">
              <span className="mobile-vehicle-title">
                <strong className="mobile-fleet-row-title">{title}</strong>
              </span>
              {description.length>0&&<span className="mobile-fleet-row-copy">{description.join(' · ')}</span>}
            </span>
            <span className={`mobile-fleet-pill ${v.enabled?'is-primary':''}`}>{v.enabled?'사용 가능':'사용 정지'}</span>
            <span className="mobile-vehicle-terminal">단말 {terminalNames.join(' · ')||'미연결'}{terminalStatus}</span>
              <span className="mobile-vehicle-distance">계기판 거리 {distance==null?'미등록':`${distance.toLocaleString()} km`}</span>

          </button>
          {filters.missingSchedulesOnly&&<div className="mobile-vehicle-schedule">
            <span>{missingScheduleFields(v.profile).map(([,label])=>label).join(' · ')} 미등록</span>
            {access.manage_vehicles&&<button className="business-button" type="button" aria-label={`${fleetAssetLabel(v)} 점검 일정 등록`} onClick={()=>setScheduleAsset(v)}>일정 등록</button>}
          </div>}
        </li>;
      })}</ul></div>{empty}
      </>:<>
      <div className="fleet-asset-table-wrap" role="region" aria-label="차량 목록 표" tabIndex={0}><table className="fleet-asset-table fleet-assets-cartax-table"><thead><tr>{['차량','부서·담당자','단말기·수신','이번 달 운행거리','계기판 거리','등록일',...(filters.missingSchedulesOnly?['미등록 일정']:[]),'운영 상태','관리'].map(h=><th key={h} scope="col">{h}</th>)}</tr></thead><tbody>{rows.map(v=><tr key={v.id} tabIndex={0} aria-label={`${fleetAssetLabel(v)} 상세 열기`} onClick={e=>{if(!e.target.closest('button,a,input,select,textarea,label'))openDetail(v.id);}} onKeyDown={e=>{if(e.target===e.currentTarget&&(e.key==='Enter'||e.key===' ')){e.preventDefault();openDetail(v.id);}}}>
        <td><div className="fleet-assets-identity"><span className="fleet-assets-thumbnail" aria-hidden="true"><CarImage vehicleId={v.id} version={v.profile?.car_image_url} fallback={<Icon name="car" size={24}/>}/></span><div><button type="button" className="business-link" aria-label={`${fleetAssetLabel(v)} 상세`} onClick={()=>openDetail(v.id)}>{v.license_plate||v.name||'차량 정보 미등록'}</button><small>{[...new Set([v.car_model,v.name].filter(x=>x&&x!==(v.license_plate||v.name)))].join(' · ')||''}</small></div></div></td>
        <td>{v.department||'—'}<small>{staff.find(s=>s.id===v.manager_staff_id)?.name||'담당자 미지정'}</small></td>
        <td>{v.bindings.some(b=>!b.ended_at)?v.bindings.filter(b=>!b.ended_at).map(b=><div key={b.id}>{b.terminal_name}{b.is_primary&&<span className="business-badge">대표</span>}</div>):'미연결'}{byVehicle.get(v.id)?.has_primary_terminal&&<small>{byVehicle.get(v.id).terminal_status_label||classifyDevice(byVehicle.get(v.id),meta[v.id]).label}</small>}</td>
        <td className="is-number">{Number.isFinite(stats.byVehicle.get(v.id)?.total_distance_m)?(stats.byVehicle.get(v.id).total_distance_m/1000).toLocaleString("ko-KR",{maximumFractionDigits:1})+" km":"—"}</td>
        <td className="is-number">{assetOdometer(v)==null?'미등록':`${assetOdometer(v).toLocaleString()} km`}</td><td>{assetRegistrationDay(v.created_at)||'미등록'}</td>
        {filters.missingSchedulesOnly&&<td>{access.manage_vehicles&&<button type="button" className="business-link" aria-label={`${fleetAssetLabel(v)} 점검 일정 등록`} onClick={()=>setScheduleAsset(v)}>일정 등록</button>}<small>{missingScheduleFields(v.profile).map(([,label])=>label).join(' · ')}</small></td>}
        <td><span className={`business-badge ${v.enabled?'good':''}`}>{v.enabled?'사용 가능':'사용 정지'}</span></td>
        <td>{access.manage_vehicles?<div className="fleet-assets-row-actions"><button type="button" className="fleet-assets-connect-button" aria-label={`${fleetAssetLabel(v)} 단말 연결`} onClick={()=>openDetail(v.id,'connections')}>단말 연결</button><button type="button" className="fleet-assets-edit-button" aria-label={`${fleetAssetLabel(v)} 수정`} title="차량 정보 수정" onClick={()=>setEdit(v)}><Icon name="edit" size={16}/></button></div>:<span className="fleet-assets-row-arrow" aria-hidden="true"><Icon name="chevron-right" size={16}/></span>}</td>
      </tr>)}</tbody></table></div>{empty}
      </>}
      <footer className="fleet-assets-footer"><span role="status">{countLabel}</span></footer>
    </section>
    </div>
    </DirectoryLayout></>}
    {groups.error&&<div role="alert" className="business-error">차량 그룹을 불러오지 못했습니다. <button type="button" onClick={()=>groups.refetch()}>다시 조회</button></div>}
    {addGroup&&<VehicleGroupForm onClose={()=>setAddGroup(false)} onCreated={g=>{setGroup(String(g.id));setAddGroup(false);}}/>}
    {exportError&&<p role="alert" className="business-error">{exportError}</p>}
    {filterOpen&&<Modal open title="차량 필터" size="lg" onClose={()=>setFilterOpen(false)} footer={<div className="fleet-assets-filter-footer"><button type="button" className="business-button" onClick={()=>setDraft({...emptyAssetFilters})}>초기화</button><div><button type="button" className="business-button" onClick={()=>setFilterOpen(false)}>취소</button><button type="button" className="business-button is-primary" disabled={!!filterError} onClick={()=>{if(!filterError){setFilters({...draft});setFilterOpen(false);}}}>적용</button></div></div>}>
      <div className="fleet-asset-filter-grid fleet-assets-filter-dialog">
        <fieldset><legend>계기판 누적거리 (km)</legend><select aria-label="계기판 거리 등록 여부" value={draft.distance} onChange={e=>changeFilter('distance',e.target.value)}><option value="all">전체</option><option value="recorded">거리 등록</option><option value="missing">거리 미등록</option></select><div className="fleet-asset-range">{[['minKm','최소 거리'],['maxKm','최대 거리']].map(([key,label])=><label key={key}>{label}<input aria-label={label} type="number" min="0" max="10000000" step="any" placeholder="제한 없음" disabled={draft.distance==='missing'} value={draft[key]} onChange={e=>changeFilter(key,e.target.value)}/></label>)}</div><p>직접 입력한 계기판 값 기준입니다. 거리 범위를 지정하면 미등록 차량은 제외됩니다.</p></fieldset>
        <fieldset><legend>점검 일정</legend><select aria-label="점검 일정 등록 여부" value={draft.missingSchedulesOnly?'missing':'all'} onChange={e=>changeFilter('missingSchedulesOnly',e.target.value==='missing')}><option value="all">전체</option><option value="missing">미등록 일정이 있는 차량</option></select></fieldset>
        <fieldset><legend>차량 등록일 (한국 시간)</legend><div className="fleet-asset-range">{[['from','등록 시작일'],['to','등록 종료일']].map(([key,label])=><label key={key}>{label}<input aria-label={label} type="date" value={draft[key]} onChange={e=>changeFilter(key,e.target.value)}/></label>)}</div><p>시작일과 종료일을 모두 포함합니다.</p></fieldset>
      </div>{filterError&&<p className="fleet-assets-filter-error" role="alert">{filterError}</p>}
    </Modal>}
    {(edit||scheduleAsset)&&<FleetAssetForm asset={edit||scheduleAsset} scheduleOnly={!!scheduleAsset} staff={staff} onClose={closeEdit} onSaved={saved}/>}
    {selected&&<FleetAssetDetail key={selected.id} initialTab={detailTab} suggestedTerminalId={requestedTerminal} meta={meta[selected.id]} asset={selected} devices={devices} onClose={()=>setDetail(null)} onChanged={onChanged} onMap={onMap && ((sim,origin)=>onMap(sim,{...origin,directory:{query,group,department,availability,sort,filters}}))} onReport={onReport} onReserve={onReserve}/>}
  </div>;
}
export function FleetAssetForm({asset,staff=[],onClose,onSaved,scheduleOnly=false}) {
  const formId=useId();
  const org=useFleetOrganization();
  const groups=useVehicleGroups(!scheduleOnly);
  const scheduleFields=scheduleOnly?missingScheduleFields(asset.profile):maintenanceScheduleFields;
  const queryClient=useQueryClient();
  const [form,setForm]=useState({name:asset.name||'',license_plate:asset.license_plate||'',car_model:asset.car_model||'',department:scheduleOnly&&!asset.department_id?asset.department||'':'',department_id:asset.department_id||'',group_id:asset.group_id||'',manager_staff_id:asset.manager_staff_id||'',enabled:asset.enabled!==false,profile:{...asset.profile}}),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const pending=useRef(false),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  const close=()=>{if(!pending.current)onClose();};
  const field=(key,value)=>setForm(p=>({...p,[key]:value}));
  const profile=(key,value)=>setForm(p=>({...p,profile:{...p.profile,[key]:value}}));
  const hasChanges=!scheduleOnly||scheduleFields.some(([key])=>Boolean(form.profile[key]));
  async function save(e){
    e.preventDefault();
    if(pending.current||!mounted.current||!hasChanges)return;
    pending.current=true;setSaving(true);setError('');
    try{
      const p={...form,profile:{...form.profile},department_id:Number(form.department_id)||null,manager_staff_id:form.manager_staff_id?Number(form.manager_staff_id):null,updated_at:asset.updated_at};
      if(scheduleOnly || !groups.data) delete p.group_id;
      else p.group_id=Number(form.group_id)||null;
      for(const key of ['odometer_km','next_service_km','model_year','engine_cc','purchase_price_krw','fuel_efficiency_kmpl']){
        const value=p.profile[key];
        if(typeof value==='string') p.profile[key]=value.trim()===''?null:Number(value);
      }
      if(asset.id)await api.updateFleetVehicle(asset.id,p);else await api.createFleetVehicle(p);
      if(mounted.current)onSaved();else queryClient.invalidateQueries({queryKey:fleetAssetsKey});
    }catch(e){if(mounted.current)setError(e.message||'차량을 저장하지 못했습니다.');}
    finally{pending.current=false;if(mounted.current)setSaving(false);}
  }
  return <Modal open size={scheduleOnly?'md':720} title={scheduleOnly?'점검 일정 등록':asset.id?'차량 정보 수정':'차량 등록'} subtitle={scheduleOnly||asset.id?fleetAssetLabel(asset):undefined} onClose={saving?undefined:close}
    footer={<div className="fleet-editor-footer"><Button type="button" variant="ghost" onClick={close} disabled={saving}>취소</Button><Button type="submit" form={formId} disabled={saving||!hasChanges}>{saving?'저장 중…':'저장'}</Button></div>}>
    <form id={formId} onSubmit={save} aria-busy={saving}><fieldset className="fleet-asset-form fleet-assets-editor" disabled={saving} style={{border:0,margin:0,padding:0,minWidth:0}}>
    {!scheduleOnly&&<fieldset><legend>차량 기본 정보</legend><div className="fleet-asset-fields"><FormField label="차량명 (필수)"><Input required maxLength={120} value={form.name} onChange={e=>field('name',e.target.value)}/></FormField><FormField label="차량번호"><Input maxLength={32} value={form.license_plate} onChange={e=>field('license_plate',e.target.value)}/></FormField><FormField label="차종"><Input maxLength={120} value={form.car_model} onChange={e=>field('car_model',e.target.value)}/></FormField><FormField label="부서"><Select value={form.department_id} onChange={e=>field('department_id',e.target.value)}><option value="">미지정</option>{(org.data||[]).filter(i=>i.kind==='department'&&(i.active||i.id===asset.department_id)).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</Select></FormField><FormField label="담당자"><Select value={form.manager_staff_id} onChange={e=>field('manager_staff_id',e.target.value)}><option value="">미지정</option>{staff.filter(s=>s.active||s.id===asset.manager_staff_id).map(s=><option key={s.id} value={s.id}>{s.name}{!s.active?' (비활성)':''}</option>)}</Select></FormField><FormField label="차량 그룹"><Select disabled={!groups.data} value={form.group_id} onChange={e=>field('group_id',e.target.value)}><option value="">{groups.error?'그룹 조회 실패':groups.isPending?'그룹 조회 중…':'그룹 미지정'}</option>{groups.data?.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</Select></FormField><FormField label="계기판 누적거리 (km)"><Input type="number" min="0" step="0.1" value={form.profile.odometer_km??''} onChange={e=>profile('odometer_km',e.target.value)}/></FormField></div></fieldset>}
    <fieldset><legend>{scheduleOnly?'미등록 일정':'점검 일정'}</legend><div className="fleet-asset-fields">{scheduleFields.map(([key,label])=><FormField key={key} label={label}><Input type="date" name={key} value={form.profile[key]||''} onChange={e=>profile(key,e.target.value)}/></FormField>)}{!scheduleOnly&&<FormField label="다음 정비 주행거리 (km)"><Input type="number" min="0" value={form.profile.next_service_km??''} onChange={e=>profile('next_service_km',e.target.value)}/></FormField>}</div></fieldset>
    {!scheduleOnly&&<><details><summary>연식·취득·연료 정보</summary><div className="fleet-asset-fields">{[['model_year','연식'],['engine_cc','배기량 (cc)'],['purchase_price_krw','취득가액 (원)'],['fuel_efficiency_kmpl','연비 (km/L)']].map(([key,label])=><FormField key={key} label={label}><Input type="number" min="0" step={key==='fuel_efficiency_kmpl'?'0.1':'1'} value={form.profile[key]??''} onChange={e=>profile(key,e.target.value)}/></FormField>)}<FormField label="취득일"><Input type="date" value={form.profile.acquired_at||''} onChange={e=>profile('acquired_at',e.target.value)}/></FormField><FormField label="차량 유형"><Select value={form.profile.vehicle_type||''} onChange={e=>profile('vehicle_type',e.target.value)}><option value="">미지정</option>{[['sedan','승용'],['van','승합'],['truck','화물'],['special','특수'],['ev','전기']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></FormField><FormField label="연료"><Select value={form.profile.fuel_type||''} onChange={e=>profile('fuel_type',e.target.value)}><option value="">미지정</option>{[['gasoline','휘발유'],['diesel','경유'],['lpg','LPG'],['ev','전기']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></FormField></div></details>
    <FormField label="메모"><Textarea maxLength={2000} value={form.profile.note||''} onChange={e=>profile('note',e.target.value)}/></FormField><label className="fleet-asset-toggle"><input type="checkbox" checked={form.enabled} onChange={e=>field('enabled',e.target.checked)}/>사용 가능</label></>}
    {error&&<p role="alert" className="business-error">{error}</p>}
  </fieldset></form></Modal>;
}
export function FleetAssetDetail({asset,devices,onClose,onChanged,onMap,meta,onReport,onReserve,initialTab='status',suggestedTerminalId}) {
  const access=useFleetAccess();
  const mobile=useCorporatePhone();
  const {data:staff=[]}=useStaff();
  const qc=useQueryClient();
  const all=useFleetAssets().data||[];
  const assignedElsewhere=id=>all.find(v=>v.id!==asset.id&&v.bindings.some(b=>b.device_id===id));
  const [requestedTab,setTab]=useState(initialTab);
  const canOpen=key=>key==='status'||(key==='files'?access.manage_reports:access.manage_vehicles);
  const tab=canOpen(requestedTab)?requestedTab:'status';
  const [editing,setEditing]=useState(null);
  function openEditor(event){
    event.currentTarget.focus({preventScroll:true});
    setEditing(asset);
  }
  const [bindingDraft,setBindingDraft]=useState(()=>{
    if(!access.manage_vehicles||!suggestedTerminalId)return null;
    const ids=asset.bindings.filter(b=>!b.ended_at).map(b=>b.device_id);
    return {selected:[...new Set([...ids,suggestedTerminalId])],primary:asset.bindings.find(b=>b.is_primary&&!b.ended_at)?.device_id||suggestedTerminalId,version:asset.updated_at};
  });
  const bindings=bindingDraft||{selected:asset.bindings.map(b=>b.device_id),primary:asset.bindings.find(b=>b.is_primary)?.device_id||'',version:asset.updated_at};
  const {selected,primary,version}=bindings;
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const device=projectFleetAssets([asset],devices)[0];
  const monthDistance=useVehicleStatsQuery().data?.per_device?.find(row=>Number(row.device_id)===Number(asset.id))?.total_distance_m;
  const status=classifyDevice(device,meta);
  const missingTerminalData=device.has_primary_terminal && device.source_device_id==null;
  const communication=device.terminal_status_label || status.label;
  const missingReading=missingTerminalData ? '확인 불가' : '수신 이력 없음';
  const missingSchedules=missingScheduleFields(asset.profile).length;
  const history=useQuery({queryKey:[...fleetAssetsKey,asset.id,'bindings',asset.updated_at],queryFn:()=>api.fleetVehicleBindings(asset.id),enabled:tab==='history'});
  async function save(){
    setSaving(true);setError('');
    try {
      await api.connectFleetVehicle(asset.id,{device_ids:selected,primary_device_id:primary?Number(primary):null,updated_at:version});
      await qc.invalidateQueries({queryKey:fleetAssetsKey});onChanged();onClose();
    } catch(e){setError(e.message||'연결을 저장하지 못했습니다.');}
    finally{setSaving(false);}
  }
  return <><BusinessDrawer title={asset.license_plate||asset.name||'차량 정보 미등록'} subtitle={[asset.name!==asset.license_plate&&asset.license_plate&&asset.name,asset.car_model,asset.department].filter(Boolean).join(' · ')||undefined} onClose={onClose}>
    <div className="fleet-assets-detail">
    <div className="business-switch fleet-assets-detail-tabs" role="group" aria-label="차량 상세 메뉴">{[['status','상태·위치'],['connections','단말기 연결'],['files','사진·서류'],['history','연결 이력']].filter(([key])=>canOpen(key)).map(([key,label])=><button type="button" key={key} className="business-switch-item" aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
    {tab==='status'&&<>
      <div className="fleet-vehicle-status-scroll">
        <div className="fleet-vehicle-hero">
          <div className="fleet-vehicle-hero-image"><CarImage vehicleId={asset.id} version={asset.profile?.car_image_url} alt={asset.car_model||'등록 차량'} fallback={<Icon name="car" size={48}/>}/></div>
          <dl><div><dt>이번 달 운행거리</dt><dd>{Number.isFinite(monthDistance)?(monthDistance/1000).toLocaleString('ko-KR',{maximumFractionDigits:1}):'—'}{Number.isFinite(monthDistance)&&<small> km</small>}</dd></div>
          <div><dt>계기판 누적거리</dt><dd>{assetOdometer(asset)?.toLocaleString()??'미등록'}{assetOdometer(asset)!=null&&<small> km</small>}</dd></div></dl>
        </div>
        <section className="fleet-assets-detail-section" aria-label="차량 기본 정보">
        <header><h3>차량 정보</h3><div className="fleet-assets-detail-heading-actions">
          <span className={`business-badge ${asset.enabled?'good':''}`}>{asset.enabled?'사용 가능':'사용 정지'}</span>
          {mobile&&access.manage_vehicles&&<button type="button" className="business-button" aria-label="차량·점검 정보 수정" onClick={openEditor}>수정</button>}
        </div></header>
        <dl className="business-detail-facts">
          <div><dt>차종</dt><dd>{asset.car_model||'미등록'}</dd></div>
          <div><dt>부서</dt><dd>{asset.department||'미지정'}</dd></div>
          <div><dt>담당자</dt><dd>{staff.find(s=>s.id===asset.manager_staff_id)?.name||'미지정'}</dd></div>
          <div><dt>등록일</dt><dd>{assetRegistrationDay(asset.created_at)||'미등록'}</dd></div>
          {asset.profile?.fuel_type&&<div><dt>유종</dt><dd>{{gasoline:'휘발유',diesel:'경유',lpg:'LPG',ev:'전기'}[asset.profile.fuel_type]||asset.profile.fuel_type}</dd></div>}
          {asset.profile?.fuel_efficiency_kmpl!=null&&<div><dt>등록 연비</dt><dd>{asset.profile.fuel_efficiency_kmpl} km/L</dd></div>}
        </dl>
        </section>
        <details className="fleet-assets-detail-section fleet-vehicle-collapse" aria-label="차량 점검 일정">
        <summary><Icon name="wrench" size={16}/>정비·보험 일정{missingSchedules>0&&<span className="fleet-assets-detail-meta">일정 미등록 {missingSchedules}건</span>}</summary>
        <dl className="business-detail-facts">{maintenanceScheduleFields.map(([key,label])=><div key={key}><dt>{label}</dt><dd className={!asset.profile?.[key]?'is-missing':undefined}>{asset.profile?.[key]||'일정 미등록'}</dd></div>)}<div><dt>다음 정비 주행거리</dt><dd>{Number.isFinite(asset.profile?.next_service_km)&&asset.profile.next_service_km>=0?`${asset.profile.next_service_km.toLocaleString()} km`:'미등록'}</dd></div></dl>
        </details>
        <section className="fleet-assets-detail-section" aria-label="단말기 통신과 위치">
        <header><h3>단말기·위치</h3></header>
        <dl className="business-detail-facts">
          <div><dt>대표 단말기</dt><dd>{device.display_name}</dd></div>
          <div><dt>단말기 통신 상태</dt><dd>{communication}</dd></div>
          <div><dt>최근 통신</dt><dd>{device.last_seen_at?ageString(device.last_seen_at):missingReading}</dd></div>
          <div><dt>마지막 위치 수신</dt><dd>{device.last_fix_at?kstDateTime(device.last_fix_at):missingReading}</dd></div>
        </dl>
        {device.source_device_id&&<BatteryStatus reading={deviceBattery(device,meta)}/>}
        {device.source_device_id&&<BusinessMap devices={[device]}/>}
        </section>
        {asset.profile?.note&&<section className="fleet-assets-detail-section"><header><h3>메모</h3></header><p className="fleet-vehicle-note">{asset.profile.note}</p></section>}
      </div>
      <div className="fleet-assets-detail-actions">
      <button type="button" className="business-button" onClick={onClose}>닫기</button>
      {asset.enabled&&access.write_reservations!==false&&onReserve&&<button type="button" className="business-button" onClick={()=>{onClose();onReserve(asset.id);}}><Icon name="clock" size={15}/>차량 예약</button>}
      {!mobile&&access.manage_vehicles&&<button className="business-button" onClick={openEditor}>차량·점검 정보 수정</button>}
      {onReport&&<button className="business-button is-primary" onClick={()=>{onClose();onReport(asset);}}>운행기록부 보기</button>}
      {onMap&&device.source_device_id&&<button className="business-button" onClick={()=>onMap(device.source_device_id,{vehicleId:asset.id,detailTab:tab})}>전체 지도 보기</button>}
      </div>
    </>}
    {tab==='connections'&&<>
      <p className="business-note">대표 단말기의 위치와 운행거리를 사용합니다. 연결 해제 후에도 기존 기록은 유지됩니다.</p>
      <div className="fleet-connection-list">{devices.map(d=><label key={d.id}><input type="checkbox" checked={selected.includes(d.id)} disabled={saving||!!assignedElsewhere(d.id)} onChange={e=>{
        const ids=e.target.checked?[...selected,d.id]:selected.filter(id=>id!==d.id);
        const nextPrimary=e.target.checked?(primary||d.id):(primary===d.id?'':primary);
        setBindingDraft({selected:ids,primary:nextPrimary,version});
      }}/>{d.display_name||d.device_uid}{assignedElsewhere(d.id)&&<small> · {assignedElsewhere(d.id).name} 연결 중</small>}</label>)}</div>
      {!devices.length&&<p>단말기 메뉴에서 SIM을 먼저 등록해 주세요.</p>}
      <FormField label="대표 단말기"><Select value={primary} disabled={saving||!selected.length} onChange={e=>setBindingDraft({...bindings,primary:Number(e.target.value)||''})}><option value="">선택</option>{devices.filter(d=>selected.includes(d.id)).map(d=><option key={d.id} value={d.id}>{d.display_name||d.device_uid}</option>)}</Select></FormField>
      {error&&<p role="alert" className="business-error">{error}</p>}
      <button className="business-button is-primary" disabled={saving||(selected.length>0&&!primary)} onClick={save}>{saving?'저장 중…':'연결 저장'}</button>
    </>}
    {tab==='files'&&<FleetAssetMedia asset={asset} onChanged={onChanged}/>}
    {tab==='history'&&(history.isPending?<p>불러오는 중…</p>:history.error?<div role="alert">이력을 불러오지 못했습니다.<button className="business-button" onClick={()=>history.refetch()}>다시 시도</button></div>:history.data?.length?history.data.map(b=><article className="business-history-item" key={b.id}><strong>{b.terminal_name} {b.is_primary?'· 대표':''}</strong><p>{b.reason==='legacy_import'?'기존 기록부터':kstDateTime(b.started_at)} → {b.ended_at?kstDateTime(b.ended_at):'현재 연결'}</p></article>):<p>연결 이력이 없습니다.</p>)}
    </div>
  </BusinessDrawer>
    {editing&&access.manage_vehicles&&<FleetAssetForm asset={editing} staff={staff} onClose={()=>setEditing(null)} onSaved={()=>{setEditing(null);onChanged();}}/>}
  </>;
}

const reservationsKey=['business','corporate','vehicle-reservations'];
export function useFleetReservations(params,options={}){return useQuery({queryKey:[...reservationsKey,params],queryFn:()=>api.listFleetReservations(params),...options});}
function useBookingMutation(fn){const qc=useQueryClient();return useMutation({mutationFn:fn,onSuccess:()=>qc.invalidateQueries({queryKey:reservationsKey})});}
export const useCreateFleetReservation=()=>useBookingMutation(body=>api.createFleetReservation(body));
export const useUpdateFleetReservation=()=>useBookingMutation(({id,body})=>api.updateFleetReservation(id,body));
export const useCancelFleetReservation=()=>useBookingMutation(id=>api.cancelFleetReservation(id));
function useVehicleStatsQuery(){return useQuery({queryKey:[...fleetAssetsKey,'stats'],queryFn:()=>api.fleetVehicleStats(),staleTime:60000,refetchInterval:60000});}
export function useAssetStats(devices){const now=useBusinessClock(),q=useVehicleStatsQuery();const byVehicle=useMemo(()=>new Map((q.data?.per_device||[]).map(row=>[Number(row.device_id),row])),[q.data]);return {...fleetDistance(devices,q.data?.per_device,now),byVehicle,loading:q.isLoading,error:q.error,refetch:q.refetch};}

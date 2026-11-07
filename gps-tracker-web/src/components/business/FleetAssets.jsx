import {useFleetAccess,useFleetOrganization} from './FleetAccess';
import React,{useState,useMemo} from 'react';
import {useQuery,useQueryClient,useMutation} from '@tanstack/react-query';
import {api} from '../../api';
import {useStaff} from '../../state';
import {Modal,FormField,Input,Select,Textarea,Button} from '../ui';
import FleetAssetMedia from './FleetAssetMedia';
import BusinessDrawer from './BusinessDrawer';
import {fleetDistance} from '../../lib/corporateOverview';
import {useBusinessClock} from './useBusinessData';
import {kstDateTime} from '../../lib/businessExport';
import {projectFleetAssets,fleetAssetLabel} from '../../lib/fleetAssets';
import {emptyAssetFilters,filterFleetAssets,assetFilterError,assetOdometer,assetRegistrationDay} from '../../lib/fleetAssetFilters';
import {classifyDevice,ageString} from '../../colors';
import {deviceBattery} from '../../lib/battery';
import BatteryStatus from '../BatteryStatus';
import BusinessMap from './BusinessMap';

export const fleetAssetsKey=['business','corporate','vehicles'];
export function useFleetAssets() {return useQuery({queryKey:fleetAssetsKey,queryFn:()=>api.listFleetVehicles(),staleTime:15000});}
export {projectFleetAssets} from '../../lib/fleetAssets';
export function FleetAssets({assets,devices,onChanged,onMap,meta={},onReport}) {
  const access=useFleetAccess();
  const [edit,setEdit]=useState(null),[detail,setDetail]=useState(null),[query,setQuery]=useState(''),[status,setStatus]=useState('all'),[sort,setSort]=useState('name');
  const [filters,setFilters]=useState({...emptyAssetFilters});
  const filterError=assetFilterError(filters);
  const advancedActive=Object.keys(emptyAssetFilters).some(key=>filters[key]!==emptyAssetFilters[key]);
  const filtered=advancedActive||query.trim()||status!=='all';
  const reset=()=>{setQuery('');setStatus('all');setSort('name');setFilters({...emptyAssetFilters});};
  const changeFilter=(key,value)=>setFilters(f=>({...f,[key]:value,...(key==='distance'&&value==='missing'?{minKm:'',maxKm:''}:{})}));
  const {data:staff=[]}=useStaff();
  const selected=assets.find(v=>v.id===detail);
  const rows=useMemo(()=>filterFleetAssets(assets,{query,status,sort,...filters},staff),[assets,query,status,sort,filters,staff]);
  const saved=()=>{setEdit(null);onChanged();};
  return <>
    <div className="business-metrics fleet-asset-metrics">{[['등록 차량',assets.length],['사용 가능',assets.filter(v=>v.enabled).length],['사용 정지',assets.filter(v=>!v.enabled).length]].map(([label,n])=><div className="business-metric" key={label}><span>{label}</span><strong>{n}<small>대</small></strong></div>)}</div>
    <section className="business-section"><div className="business-section-title"><h3>차량 목록</h3>{access.manage_vehicles&&<button className="business-button is-primary" onClick={()=>setEdit({})}>+ 차량 등록</button>}</div>
      <div className="business-list-filters"><input aria-label="등록 차량 검색" placeholder="차량·단말기·부서·담당자" value={query} onChange={e=>setQuery(e.target.value)}/><select aria-label="등록 차량 상태" value={status} onChange={e=>setStatus(e.target.value)}><option value="all">전체 상태</option><option value="enabled">사용 가능</option><option value="disabled">사용 정지</option></select><select aria-label="등록 차량 정렬" value={sort} onChange={e=>setSort(e.target.value)}><option value="name">차량 이름순</option><option value="created">최근 등록순</option><option value="distanceAsc">계기판 거리 낮은순</option><option value="distanceDesc">계기판 거리 높은순</option></select></div>
      <details className="fleet-asset-filters"><summary>거리·등록일 필터{advancedActive&&<span className="business-badge">적용 중</span>}</summary><div className="fleet-asset-filter-grid">
        <fieldset><legend>계기판 누적거리 (km)</legend><select aria-label="계기판 거리 등록 여부" value={filters.distance} onChange={e=>changeFilter('distance',e.target.value)}><option value="all">전체</option><option value="recorded">거리 등록</option><option value="missing">거리 미등록</option></select><div className="fleet-asset-range">{[['minKm','최소 거리'],['maxKm','최대 거리']].map(([key,label])=><label key={key}>{label}<input aria-label={label} type="number" min="0" max="10000000" step="any" placeholder="제한 없음" disabled={filters.distance==='missing'} value={filters[key]} onChange={e=>changeFilter(key,e.target.value)}/></label>)}</div><p>직접 입력한 계기판 값 기준입니다. 거리 범위를 지정하면 미등록 차량은 제외됩니다.</p></fieldset>
        <fieldset><legend>차량 등록일 (한국 시간)</legend><div className="fleet-asset-range">{[['from','등록 시작일'],['to','등록 종료일']].map(([key,label])=><label key={key}>{label}<input aria-label={label} type="date" value={filters[key]} onChange={e=>changeFilter(key,e.target.value)}/></label>)}</div><p>시작일과 종료일을 모두 포함합니다.</p></fieldset>
      </div></details>
      <div className="fleet-asset-filter-result"><span role="status">{filterError?'조회 조건을 확인해 주세요.':`${rows.length} / ${assets.length}대${filtered?' · 필터 적용':''}`}</span>{(filtered||sort!=='name')&&<button className="business-button" onClick={reset}>필터 초기화</button>}</div>
      {filterError&&<p className="fleet-asset-filter-error" role="alert">{filterError}</p>}
      <div className="fleet-asset-table-wrap"><table className="fleet-asset-table"><thead><tr>{['차량','부서·담당자','연결 단말기','계기판 거리','등록일','상태','작업'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(v=><tr key={v.id}>
        <td><button className="business-link" aria-label={`${fleetAssetLabel(v)} 상세`} onClick={()=>setDetail(v.id)}>{v.name||'차량 정보 미등록'}</button><small>{v.license_plate||'차량번호 미등록'}</small></td>
        <td>{v.department||'—'}<small>{staff.find(s=>s.id===v.manager_staff_id)?.name||'담당자 미지정'}</small></td>
        <td>{v.bindings.length?v.bindings.map(b=><div key={b.id}>{b.terminal_name}{b.is_primary&&<span className="business-badge">대표</span>}</div>):'미연결'}</td>
        <td className="is-number">{assetOdometer(v)==null?'미등록':`${assetOdometer(v).toLocaleString()} km`}</td><td>{assetRegistrationDay(v.created_at)||'미등록'}</td>
        <td><span className={`business-badge ${v.enabled?'good':''}`}>{v.enabled?'사용 가능':'사용 정지'}</span></td>
        <td><button className="business-button" onClick={()=>setDetail(v.id)}>상세·연결</button>{access.manage_vehicles&&<button className="business-button" onClick={()=>setEdit(v)}>수정</button>}</td>
      </tr>)}</tbody></table></div>{!rows.length&&!filterError&&<div className="business-empty"><strong>{assets.length?'조건에 맞는 차량이 없습니다.':'차량을 먼저 등록해 주세요.'}</strong><p>{assets.length?'검색어나 필터를 변경해 주세요.':'단말기는 나중에 연결할 수 있습니다.'}</p></div>}
    </section>
    {edit&&<FleetAssetForm asset={edit} staff={staff} onClose={()=>setEdit(null)} onSaved={saved}/>}
    {selected&&<FleetAssetDetail meta={meta[selected.id]} asset={selected} devices={devices} onClose={()=>setDetail(null)} onChanged={onChanged} onEdit={()=>{setDetail(null);setEdit(selected);}} onMap={onMap} onReport={onReport}/>}
  </>;
}
export function FleetAssetForm({asset,staff=[],onClose,onSaved}) {
  const org=useFleetOrganization();
  const [form,setForm]=useState({name:asset.name||'',license_plate:asset.license_plate||'',car_model:asset.car_model||'',department:'',department_id:asset.department_id||'',manager_staff_id:asset.manager_staff_id||'',enabled:asset.enabled!==false,profile:{...asset.profile}}),[saving,setSaving]=useState(false),[error,setError]=useState('');
  const field=(key,value)=>setForm(p=>({...p,[key]:value}));
  const profile=(key,value)=>setForm(p=>({...p,profile:{...p.profile,[key]:value}}));
  async function save(e){e.preventDefault();if(saving)return;setSaving(true);setError('');try{
    const p={...form,profile:{...form.profile},department_id:Number(form.department_id)||null,manager_staff_id:form.manager_staff_id?Number(form.manager_staff_id):null,updated_at:asset.updated_at};
    for(const key of ['odometer_km','next_service_km','model_year','engine_cc','purchase_price_krw','fuel_efficiency_kmpl']) if(key in p.profile) p.profile[key]=p.profile[key]===''?null:Number(p.profile[key]);
    if(asset.id)await api.updateFleetVehicle(asset.id,p);else await api.createFleetVehicle(p);onSaved();
  }catch(e){setError(e.message||'차량을 저장하지 못했습니다.');}finally{setSaving(false);}}
  return <Modal open title={asset.id?'차량 정보 수정':'차량 등록'} onClose={onClose}><form onSubmit={save} className="fleet-asset-form">
    <div className="fleet-asset-fields"><FormField label="차량명" required><Input required maxLength={120} value={form.name} onChange={e=>field('name',e.target.value)}/></FormField><FormField label="차량번호"><Input maxLength={32} value={form.license_plate} onChange={e=>field('license_plate',e.target.value)}/></FormField><FormField label="차종"><Input maxLength={120} value={form.car_model} onChange={e=>field('car_model',e.target.value)}/></FormField><FormField label="부서"><Select value={form.department_id} onChange={e=>field('department_id',e.target.value)}><option value="">미지정</option>{(org.data||[]).filter(i=>i.kind==='department'&&(i.active||i.id===asset.department_id)).map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</Select></FormField><FormField label="담당자"><Select value={form.manager_staff_id} onChange={e=>field('manager_staff_id',e.target.value)}><option value="">미지정</option>{staff.filter(s=>s.active||s.id===asset.manager_staff_id).map(s=><option key={s.id} value={s.id}>{s.name}{!s.active?' (비활성)':''}</option>)}</Select></FormField><FormField label="계기판 누적거리 (km)"><Input type="number" min="0" step="0.1" value={form.profile.odometer_km??''} onChange={e=>profile('odometer_km',e.target.value)}/></FormField></div>
    <fieldset><legend>점검 일정</legend><div className="fleet-asset-fields">{[['next_service_date','다음 정비일'],['insurance_expiry','보험 만료일'],['inspection_expiry','검사 만료일']].map(([key,label])=><FormField key={key} label={label}><Input type="date" value={form.profile[key]||''} onChange={e=>profile(key,e.target.value)}/></FormField>)}<FormField label="다음 정비 주행거리 (km)"><Input type="number" min="0" value={form.profile.next_service_km??''} onChange={e=>profile('next_service_km',e.target.value)}/></FormField></div></fieldset>
    <details><summary>연식·취득·연료 정보</summary><div className="fleet-asset-fields">{[['model_year','연식'],['engine_cc','배기량 (cc)'],['purchase_price_krw','취득가액 (원)'],['fuel_efficiency_kmpl','연비 (km/L)']].map(([key,label])=><FormField key={key} label={label}><Input type="number" min="0" step={key==='fuel_efficiency_kmpl'?'0.1':'1'} value={form.profile[key]??''} onChange={e=>profile(key,e.target.value)}/></FormField>)}<FormField label="취득일"><Input type="date" value={form.profile.acquired_at||''} onChange={e=>profile('acquired_at',e.target.value)}/></FormField><FormField label="차량 유형"><Select value={form.profile.vehicle_type||''} onChange={e=>profile('vehicle_type',e.target.value)}><option value="">미지정</option>{[['sedan','승용'],['van','승합'],['truck','화물'],['special','특수'],['ev','전기']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></FormField><FormField label="연료"><Select value={form.profile.fuel_type||''} onChange={e=>profile('fuel_type',e.target.value)}><option value="">미지정</option>{[['gasoline','휘발유'],['diesel','경유'],['lpg','LPG'],['ev','전기']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></FormField></div></details>
    <FormField label="메모"><Textarea maxLength={2000} value={form.profile.note||''} onChange={e=>profile('note',e.target.value)}/></FormField><label className="fleet-asset-toggle"><input type="checkbox" checked={form.enabled} onChange={e=>field('enabled',e.target.checked)}/>사용 가능</label>
    {error&&<p role="alert" className="business-error">{error}</p>}<div className="business-dialog-actions"><Button type="button" variant="ghost" onClick={onClose} disabled={saving}>취소</Button><Button type="submit" disabled={saving}>{saving?'저장 중…':'저장'}</Button></div>
  </form></Modal>;
}
export function FleetAssetDetail({asset,devices,onClose,onChanged,onEdit,onMap,meta,onReport}) {
  const access=useFleetAccess();
  const qc=useQueryClient();
  const all=useFleetAssets().data||[];
  const assignedElsewhere=id=>all.find(v=>v.id!==asset.id&&v.bindings.some(b=>b.device_id===id));
  const [tab,setTab]=useState('status');
  const [selected,setSelected]=useState(asset.bindings.map(b=>b.device_id));
  const [primary,setPrimary]=useState(asset.bindings.find(b=>b.is_primary)?.device_id||'');
  const [version]=useState(asset.updated_at);
  const [saving,setSaving]=useState(false),[error,setError]=useState('');
  const device=projectFleetAssets([asset],devices)[0];
  const status=classifyDevice(device,meta);
  const history=useQuery({queryKey:[...fleetAssetsKey,asset.id,'bindings',asset.updated_at],queryFn:()=>api.fleetVehicleBindings(asset.id),enabled:tab==='history'});
  async function save(){
    setSaving(true);setError('');
    try {
      await api.connectFleetVehicle(asset.id,{device_ids:selected,primary_device_id:primary?Number(primary):null,updated_at:version});
      await qc.invalidateQueries({queryKey:fleetAssetsKey});onChanged();onClose();
    } catch(e){setError(e.message||'연결을 저장하지 못했습니다.');}
    finally{setSaving(false);}
  }
  return <BusinessDrawer title={asset.name} subtitle={asset.license_plate||'차량번호 미등록'} onClose={onClose}>
    <div className="business-switch">{[['status','상태·위치'],['connections','단말기 연결'],['files','사진·서류'],['history','연결 이력']].filter(([key])=>key==='status'||(key==='files'?access.manage_reports:access.manage_vehicles)).map(([key,label])=><button key={key} className="business-switch-item" aria-pressed={tab===key} onClick={()=>setTab(key)}>{label}</button>)}</div>
    {tab==='status'&&<>
      <BusinessMap devices={[device]}/>
      <dl className="business-detail-facts">
        <div><dt>차량 상태</dt><dd>{asset.enabled?'사용 가능':'사용 정지'}</dd></div>
        <div><dt>대표 단말기</dt><dd>{device.display_name}</dd></div>
        <div><dt>단말기 상태</dt><dd>{device.source_device_id?status.label:'미연결'}</dd></div>
        <div><dt>최근 통신</dt><dd>{device.last_seen_at?ageString(device.last_seen_at):'수신 이력 없음'}</dd></div>
        <div><dt>마지막 위치 수신</dt><dd>{device.last_fix_at?kstDateTime(device.last_fix_at):'수신 이력 없음'}</dd></div>
      </dl>
      {device.source_device_id&&<BatteryStatus reading={deviceBattery(device,meta)}/>}
      <dl className="business-detail-facts">{[['next_service_date','다음 정비일'],['insurance_expiry','보험 만료일'],['inspection_expiry','검사 만료일']].map(([key,label])=><div key={key}><dt>{label}</dt><dd>{asset.profile[key]||'미등록'}</dd></div>)}</dl>
      {access.manage_vehicles&&<button className="business-button" onClick={onEdit}>차량·점검 정보 수정</button>}
      {onReport&&<button className="business-button is-primary" onClick={()=>{onClose();onReport(asset);}}>운행기록부 보기</button>}
      {onMap&&device.source_device_id&&<button className="business-button" onClick={()=>{onClose();onMap(device.source_device_id);}}>전체 지도 보기</button>}
    </>}
    {tab==='connections'&&<>
      <p className="business-note">대표 단말기의 위치와 운행거리를 사용합니다. 연결 해제 후에도 기존 기록은 유지됩니다.</p>
      <div className="fleet-connection-list">{devices.map(d=><label key={d.id}><input type="checkbox" checked={selected.includes(d.id)} disabled={saving||!!assignedElsewhere(d.id)} onChange={e=>{
        setSelected(ids=>e.target.checked?[...ids,d.id]:ids.filter(id=>id!==d.id));
        if(!e.target.checked&&primary===d.id)setPrimary('');
        if(e.target.checked&&!primary)setPrimary(d.id);
      }}/>{d.display_name||d.device_uid}{assignedElsewhere(d.id)&&<small> · {assignedElsewhere(d.id).name} 연결 중</small>}</label>)}</div>
      {!devices.length&&<p>단말기 메뉴에서 SIM을 먼저 등록해 주세요.</p>}
      <FormField label="대표 단말기"><Select value={primary} disabled={saving||!selected.length} onChange={e=>setPrimary(Number(e.target.value)||'')}><option value="">선택</option>{devices.filter(d=>selected.includes(d.id)).map(d=><option key={d.id} value={d.id}>{d.display_name||d.device_uid}</option>)}</Select></FormField>
      {error&&<p role="alert" className="business-error">{error}</p>}
      <button className="business-button is-primary" disabled={saving||(selected.length>0&&!primary)} onClick={save}>{saving?'저장 중…':'연결 저장'}</button>
    </>}
    {tab==='files'&&<FleetAssetMedia asset={asset} onChanged={onChanged}/>}
    {tab==='history'&&(history.isPending?<p>불러오는 중…</p>:history.error?<div role="alert">이력을 불러오지 못했습니다.<button className="business-button" onClick={()=>history.refetch()}>다시 시도</button></div>:history.data?.length?history.data.map(b=><article className="business-history-item" key={b.id}><strong>{b.terminal_name} {b.is_primary?'· 대표':''}</strong><p>{b.reason==='legacy_import'?'기존 기록부터':kstDateTime(b.started_at)} → {b.ended_at?kstDateTime(b.ended_at):'현재 연결'}</p></article>):<p>연결 이력이 없습니다.</p>)}
  </BusinessDrawer>;
}

const reservationsKey=['business','corporate','vehicle-reservations'];
export function useFleetReservations(params,options={}){return useQuery({queryKey:[...reservationsKey,params],queryFn:()=>api.listFleetReservations(params),...options});}
function useBookingMutation(fn){const qc=useQueryClient();return useMutation({mutationFn:fn,onSuccess:()=>qc.invalidateQueries({queryKey:reservationsKey})});}
export const useCreateFleetReservation=()=>useBookingMutation(body=>api.createFleetReservation(body));
export const useUpdateFleetReservation=()=>useBookingMutation(({id,body})=>api.updateFleetReservation(id,body));
export const useCancelFleetReservation=()=>useBookingMutation(id=>api.cancelFleetReservation(id));
export function useAssetStats(devices){const now=useBusinessClock();const q=useQuery({queryKey:[...fleetAssetsKey,'stats'],queryFn:()=>api.fleetVehicleStats(),staleTime:60000,refetchInterval:60000});return {...fleetDistance(devices,q.data?.per_device,now),loading:q.isLoading,error:q.error,refetch:q.refetch};}

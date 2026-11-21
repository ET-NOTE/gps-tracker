import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { officeCatalogKey, officeBookKey } from './rentalOfficeKeys';
import { useRentalAssets } from './RentalAssets';
import { rentalInventory, agreedPrice, matchesVehicle } from '../../lib/rentalInventory';
import { won } from '../../lib/rentalOffice';
import { api } from '../../api';
import { businessDate, vehicleName } from '../../lib/business';
import { useCreateRental, useUpdateRental } from '../../state';
import { Button, FormField, Input, Modal, Select, Textarea } from '../ui';
import { confirmDialog } from '../Dialog';

const channels = ['전화', '방문', '홈페이지', '제휴', '기타'];
export const kstInput = value => new Date(new Date(value).getTime() + 9 * 3600000).toISOString().slice(0, 16);
export const fromKst = value => new Date(value + ':00+09:00').toISOString();
const clean = value => value.trim() || null;
const numeric = value => value === '' ? null : Number(value);

export function useRentalCatalog() {
  return useQuery({queryKey:officeCatalogKey(), queryFn:()=>api.rentalOffice('GET','/catalog')});
}

export default function RentalBookingForm({ init, devices = [], vehicles: suppliedVehicles, branches: configuredBranches = [], presetDate, presetDeviceId, presetVehicleId, onClose, onSaved }) {
  const cat = useRentalCatalog(), qc = useQueryClient();
  const assets = useRentalAssets();
  const vehicles=suppliedVehicles || rentalInventory(assets.data || [], devices);
  const pricing=agreedPrice(init), agreed=!init || !!pricing;
  const catalog = cat.data || {}, people = (catalog.customers || []).filter(v=>v.active!==false), rates = (catalog.rates || []).filter(v=>v.active!==false);
  const profile = id => vehicles.find(v=>String(v.id)===String(id));
  const model = d => profile(d?.id)?.class_name?.trim() || d?.car_model?.trim() || '차종 미지정';
  const date = presetDate || businessDate(), initialDevice = init?.vehicle_id ?? presetVehicleId ?? vehicles.find(v=>init ? matchesVehicle(init,v) : presetDeviceId!=null && String(v.device_id)===String(presetDeviceId))?.id ?? '';
  const preset = vehicles.find(d=>String(d.id)===String(initialDevice));
  const [f,setForm] = useState(()=>({
    renter:init?.renter_name || '', phone:init?.renter_phone || '', id4:init?.renter_id_last4 || '', same:!init?.rental_terms?.driver_name || init.rental_terms.driver_name===init.renter_name,
    customerId:init?.rental_terms?.customer_id ?? null,driverId:init?.rental_terms?.driver_id ?? null,
    driver:init?.rental_terms?.driver_name || '', channel:init?.rental_terms?.channel || '전화',
    car:String(initialDevice), model:init?.rental_terms?.requested_model || '', pickup:init?.pickup_location || '', drop:init?.return_location || '',
    start:init?kstInput(init.starts_at):date+'T09:00', end:init?kstInput(init.ends_at):kstInput(new Date(date+'T09:00:00+09:00').getTime()+86400000),
    rateType:init?.rate_type || 'daily', rate:pricing?.base_krw ?? init?.rate_amount_krw ?? 0, option:pricing?.option_krw ?? 0,discount:pricing?.discount_krw ?? 0, deposit:init?.deposit_krw ?? 0, rateId:'', covered:false,
    included:init?.included_km_per_day ?? '', over:init?.over_km_price_krw ?? '', note:init?.note || '',
  }));
  const [error,setError]=useState(''), [checking,setChecking]=useState(false);
  const create=useCreateRental(), update=useUpdateRental(), busy = checking || create.isPending || update.isPending;
  const extend = init && ['active','overdue'].includes(init.status);
  const patch = fields => {setError('');setForm(v=>({...v,...fields}));};
  const field = name => ({value:f[name],onChange:e=>patch({[name]:e.target.value,...(name==='renter' || name==='phone'?{customerId:null}:{}),...(name==='driver'?{driverId:null}:{}),...(['rate','rateType'].includes(name)?{rateId:'',covered:false}:{})})});
  const rentalDays=Math.max(1,Math.ceil((Date.parse(f.end)-Date.parse(f.start))/86400000)) || 1;
  const ratePlan = rates.find(r=>String(r.id)===f.rateId);
  function chooseRate(id) {
    const r=rates.find(v=>String(v.id)===id);
    patch(r?{rateId:id,rateType:'daily',rate:Number(r.daily_krw)*(agreed?rentalDays:1),option:0,deposit:r.deposit_krw,covered:false}:{rateId:'',covered:false});
  }
  const requested = f.model || (preset ? model(preset) : '');
  const options = vehicles.filter(d=>d.enabled!==false && profile(d.id)?.readiness!=='hold');
  const models = [...new Set([...options.map(model), ...(requested?[requested]:[])])].sort();
  const branches = [...new Set([...configuredBranches.map(b=>typeof b==='string'?b:b.name),...vehicles.map(p=>p.branch?.trim())].filter(Boolean))].sort();
  const selected = options.find(d=>String(d.id)===f.car);
  const pickup = f.pickup || profile(selected?.id)?.branch || '', drop = f.drop || pickup;
  const cars = options.filter(d=>model(d)===requested && (!vehicles.some(p=>p.branch?.trim()) || !pickup || profile(d.id)?.branch===pickup));
  const positiveMoney = ['rate','deposit','included','over','option','discount'].every(k=> f[k]==='' || (Number.isSafeInteger(Number(f[k])) && Number(f[k])>=0));
  async function save() {
    if (busy) return;
    if (!requested || !f.renter.trim() || (!f.same && !f.driver.trim()) || !f.start || !f.end || f.end<=f.start || !positiveMoney) {
      setError('고객, 운전자, 차종과 이용 기간을 확인해 주세요. 금액과 거리는 0 이상의 정수로 입력하세요.');return;
    }
    if (agreed && ([f.rate,f.option,f.discount].some(v=>v==='' || Number(v)>1000000000) || Number(f.discount)>Number(f.rate)+Number(f.option))) {setError('합의 요금·옵션·할인은 각각 10억 원 이하로 입력하고, 할인은 기본 요금과 옵션의 합계 이내로 입력해 주세요.');return;}
    if (branches.length && (!pickup || !drop)) {setError('인수·반납 지점을 선택해 주세요.');return;}
    if (f.id4 && !/^\d{4}$/.test(f.id4)) {setError('신분증 뒤 4자리를 확인해 주세요.');return;}
    setChecking(true);setError('');
    try {
      if (!init && f.phone.trim().length>=7) {
        const result=await api.checkBlacklist(f.phone.trim());
        if (result.blacklisted && result.entry?.severity==='block') {setError('차단 등록된 고객입니다. 임차인 관리에서 등록 상태를 확인해 주세요.');return;}
        if (result.blacklisted && !await confirmDialog({title:'주의 고객 예약',body:result.entry?.reason || '주의 고객으로 등록되어 있습니다. 예약을 계속할까요?'})) return;
      }
      const body={vehicle_id:extend?init.vehicle_id:f.car?Number(f.car):null,device_id:extend?init.device_id:selected?.device_id ?? null,renter_name:f.renter.trim(),renter_phone:clean(f.phone),renter_id_last4:clean(f.id4),
        starts_at:fromKst(f.start),ends_at:fromKst(f.end),rate_type:f.rateType,rate_amount_krw:Number(f.rate),deposit_krw:Number(f.deposit),
        included_km_per_day:numeric(f.included),over_km_price_krw:numeric(f.over),pickup_odometer_km:init?.pickup_odometer_km ?? null,
        pickup_location:clean(pickup),return_location:clean(drop),status:init?.status || 'draft',note:clean(f.note),
        rental_terms:{...(agreed?{pricing:{mode:'agreed',base_krw:Number(f.rate),option_krw:Number(f.option),discount_krw:Number(f.discount)}}:{}),customer_id:f.customerId,driver_id:f.same?f.customerId:f.driverId,driver_name:(f.same?f.renter:f.driver).trim(),requested_model:requested,channel:f.channel}};
      const saved=init?await update.mutateAsync({id:init.id,body}):await create.mutateAsync(body);
      qc.invalidateQueries({queryKey:officeBookKey()});
      qc.invalidateQueries({queryKey:officeCatalogKey(true)});
      onSaved(saved);
    } catch(e) {setError(e.message || '예약을 저장하지 못했습니다.');}
    finally {setChecking(false);}
  }
  function location(label, value, change) {
    return <FormField label={label}>{branches.length?<Select value={value} onChange={change}><option value="">지점 선택</option>{[...new Set([...branches,...(value?[value]:[])])].map(v=><option key={v}>{v}</option>)}</Select>:<Input value={value} maxLength={100} onChange={change} />}</FormField>;
  }
  return <Modal open title={extend?'대여 기간 연장':init?'예약·배차 변경':'렌트카 예약 등록'} size="lg" onClose={busy?undefined:onClose}
    footer={<><Button onClick={onClose} disabled={busy}>닫기</Button><Button variant="primary" onClick={save} busy={busy} disabled={assets.isLoading || !!assets.error}>{extend?'기간 연장':init?'변경 저장':'예약 확정'}</Button></>}>
    {error && <p role="alert" className="business-error">{error}</p>}
    {assets.error && <p role="alert">차량 배차 정보를 가져오지 못했습니다. <button onClick={()=>assets.refetch()}>다시 조회</button></p>}
    {extend ? <FormField label="반납 예정 (한국 시간)"><Input type="datetime-local" {...field('end')} /></FormField> : <div className="rental-form-sections">
      <section><h3>고객과 실운전자</h3><div className="rental-form-grid">
        {!!people.length && <FormField label="등록 고객 불러오기"><Select defaultValue="" onChange={e=>{const p=people.find(v=>String(v.id)===e.target.value);if(p)patch({customerId:p.id,renter:p.name,phone:p.phone || ''});}}><option value="">직접 입력</option>{people.map(p=><option key={p.id} value={p.id}>{p.name} · {p.phone || '연락처 미등록'}</option>)}</Select></FormField>}
        <FormField label="계약 고객"><Input maxLength={100} {...field('renter')} required /></FormField>
        <FormField label="연락처"><Input type="tel" maxLength={30} {...field('phone')} /></FormField>
        <FormField label="신분증 뒤 4자리 (선택)"><Input inputMode="numeric" maxLength={4} {...field('id4')} /></FormField>
        <label className="rental-check"><input type="checkbox" checked={f.same} onChange={e=>patch({same:e.target.checked})}/>고객과 실운전자가 같습니다</label>
        {!f.same && !!people.length && <FormField label="등록 운전자 불러오기"><Select defaultValue="" onChange={e=>{const p=people.find(v=>String(v.id)===e.target.value);if(p)patch({driver:p.name,driverId:p.id});}}><option value="">직접 입력</option>{people.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</Select></FormField>}
        {!f.same && <FormField label="실운전자"><Input maxLength={100} {...field('driver')} required /></FormField>}
      </div></section>
      <section><h3>이용 일정과 배차</h3><div className="rental-form-grid">
        <FormField label="인수 예정 (한국 시간)"><Input type="datetime-local" {...field('start')} /></FormField>
        <FormField label="반납 예정 (한국 시간)"><Input type="datetime-local" {...field('end')} /></FormField>
        {location('인수 지점',pickup,e=>patch({pickup:e.target.value,car:''}))}
        {location('반납 지점',drop,e=>patch({drop:e.target.value}))}
        <FormField label="예약 차종"><Select value={requested} onChange={e=>patch({model:e.target.value,car:''})}><option value="">차종 선택</option>{models.map(v=><option key={v}>{v}</option>)}</Select></FormField>
        <FormField label="배정 차량"><Select value={f.car} onChange={e=>patch({car:e.target.value})}><option value="">나중에 배정</option>{cars.map(d=><option key={d.id} value={d.id}>{vehicleName(d)}</option>)}</Select></FormField>
        <FormField label="예약 경로"><Select {...field('channel')}>{channels.map(v=><option key={v}>{v}</option>)}</Select></FormField>
      </div></section>
      <section><h3>약정 요금</h3><div className="rental-form-grid">
        {!!rates.length && <FormField label="요금표 적용"><Select value={f.rateId} onChange={e=>chooseRate(e.target.value)}><option value="">직접 입력</option>{rates.map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</Select></FormField>}
        {ratePlan && Number(ratePlan.coverage_krw)>0 && <label className="rental-check"><input type="checkbox" checked={f.covered} onChange={e=>patch({covered:e.target.checked,...(agreed?{option:e.target.checked?Number(ratePlan.coverage_krw)*rentalDays:0}:{rate:Number(ratePlan.daily_krw)+(e.target.checked?Number(ratePlan.coverage_krw):0)})})}/>보장 옵션 포함 (+{Number(ratePlan.coverage_krw).toLocaleString()}원/일)</label>}
        {!agreed && <FormField label="요금 단위"><Select {...field('rateType')}><option value="hourly">시간당</option><option value="daily">일당</option><option value="monthly">30일당</option></Select></FormField>}
        <FormField label={agreed?"합의 대여료 (원)":"단위 요금 (원)"}><Input type="number" min="0" {...field('rate')} /></FormField>
        {agreed && <><FormField label="옵션 금액 (원)"><Input type="number" min="0" step="1" {...field('option')}/></FormField><FormField label="할인 금액 (원)"><Input type="number" min="0" step="1" {...field('discount')}/></FormField></>}
        <FormField label="약정 보증금 (원)"><Input type="number" min="0" {...field('deposit')} /></FormField>
        {!agreed && <><FormField label="1일 포함 거리 (km)"><Input type="number" min="0" placeholder="무제한" {...field('included')} /></FormField>
        <FormField label="초과 주행 단가 (원/km)"><Input type="number" min="0" {...field('over')} /></FormField></>}
        {agreed && <p aria-live="polite">합의 대여료 합계 <strong>{won(Math.max(0,Number(f.rate)+Number(f.option)-Number(f.discount)+Number(pricing?.extension_krw||0)))}</strong></p>}
      </div></section>
      <FormField label="예약 메모"><Textarea maxLength={1000} {...field('note')} /></FormField>
    </div>}
  </Modal>;
}

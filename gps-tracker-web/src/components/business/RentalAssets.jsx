import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { Button, FormField, Input, Modal, Select } from '../ui';
import { terminalName } from '../../lib/corporateOverview';
import { qk } from '../../state';
import { officeBookKey } from './rentalOfficeKeys';

export const assetKey = () => [authScope(),'rental-assets'];
export const useRentalAssets = () => useQuery({queryKey:assetKey(),queryFn:api.rentalAssets,staleTime:15000});

export function RentalDeviceLink({terminal,vehicles,onClose}) {
  const qc=useQueryClient(), current=vehicles.find(v=>v.device_id===terminal.id);
  const [vehicleId,setVehicleId]=useState(String(current?.id ?? ''));
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  async function save() {
    if (busy) return;
    const target=vehicleId ? vehicles.find(v=>String(v.id)===vehicleId) : current;
    if (!target) return;
    setBusy(true);setError('');
    try {
      await api.linkRentalDevice(target.id,{device_id:vehicleId ? terminal.id : null,revision:target.revision});
      await Promise.all([assetKey(),qk.rentals()].map(queryKey=>qc.invalidateQueries({queryKey})));onClose();
    }catch(e){setError(e.message);await qc.invalidateQueries({queryKey:assetKey()});}
    finally{setBusy(false);}
  }
  return <Modal open title="단말기 차량 연결" subtitle={terminalName(terminal)} onClose={busy?undefined:onClose}
    footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>닫기</Button>
      <Button onClick={save} busy={busy} disabled={vehicleId===String(current?.id ?? '')}>연결 저장</Button></>}>
    <FormField label="연결 차량"><Select value={vehicleId} onChange={e=>setVehicleId(e.target.value)}><option value="">연결 안 함</option>
      {vehicles.filter(v=>current ? v.id===current.id : v.device_id==null).map(v=><option key={v.id} value={v.id}>{v.plate || v.display_name || v.model}</option>)}
    </Select></FormField>
    {current && <p>차량을 교체하려면 현재 연결을 해제한 뒤 새 차량을 선택해 주세요.</p>}
    {error && <p className="business-error" role="alert">{error}</p>}
  </Modal>;
}

export default function RentalAssetEditor({asset, terminals, vehicles, branches=[], onClose}) {
  const [form,setForm] = useState(()=>({plate:asset?.plate || '',model:asset?.model || '',display_name:asset?.display_name || '',
    branch:asset?.branch || '',class_name:asset?.class_name || '',readiness:asset?.readiness || 'ready',
    odometer_km:asset?.odometer_km ?? '',fuel_level:asset?.fuel_level ?? ''}));
  const [binding,setBinding]=useState(String(asset?.device_id ?? ''));
  const [savedAsset,setSavedAsset]=useState(asset);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const qc=useQueryClient(),branchList=useId();
  const change = key => e=>setForm(v=>({...v,[key]:e.target.value}));
  const occupied=new Set(vehicles.filter(v=>v.id!==savedAsset?.id && v.device_id!=null).map(v=>v.device_id));
  async function refresh(){
    await Promise.all([assetKey(),qk.rentals(),officeBookKey()].map(queryKey=>qc.invalidateQueries({queryKey})));
  }
  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);setError('');
    try {
      const body={...form,plate:form.plate.trim(),model:form.model.trim(),display_name:form.display_name.trim(),
        branch:form.branch.trim(),class_name:form.class_name.trim(),odometer_km:form.odometer_km===''?null:Number(form.odometer_km),fuel_level:form.fuel_level===''?null:Number(form.fuel_level)};
      const saved=await api.saveRentalAsset(savedAsset?.id,{...body,...(savedAsset?{revision:savedAsset.revision}:{})});
      setSavedAsset(saved);
      if (String(saved.device_id ?? '')!==binding) {
        const linked=await api.linkRentalDevice(saved.id,{device_id:binding?Number(binding):null,revision:saved.revision});
        setSavedAsset(linked);
      }
      await refresh();onClose();
    } catch(e){setError(e.message || '차량 정보를 저장하지 못했습니다.');await refresh();}
    finally{setBusy(false);}
  }
  return <Modal open mobileForm size="lg" title={savedAsset?'렌트 차량 정보 수정':'렌트 차량 등록'} onClose={busy?undefined:onClose}>
    <form className="rfl-form" onSubmit={save}><fieldset className="rfl-form-fields" disabled={busy}>
      <FormField label="차량번호"><Input required maxLength={40} value={form.plate} onChange={change('plate')}/></FormField>
      <FormField label="모델명"><Input required maxLength={100} value={form.model} onChange={change('model')}/></FormField>
      <FormField label="차량명"><Input maxLength={100} value={form.display_name} onChange={change('display_name')}/></FormField>
      <FormField label="차종 등급"><Input maxLength={80} placeholder={form.model || '미입력 시 모델명 적용'} value={form.class_name} onChange={change('class_name')}/></FormField>
      <FormField label="소속 지점"><Input list={branchList} maxLength={80} value={form.branch} onChange={change('branch')}/></FormField>
      <datalist id={branchList}>{branches.filter(b=>b.active!==false).map(b=><option key={b.id} value={b.name}/>)}</datalist>
      <FormField label="배차 상태"><Select value={form.readiness} onChange={change('readiness')}><option value="ready">배차 허용</option><option value="hold">배차 보류</option></Select></FormField>
      <FormField label="누적 거리 (km)"><Input type="number" min={asset?.odometer_km || 0} max="2147483647" step="1" value={form.odometer_km} onChange={change('odometer_km')}/></FormField>
      <FormField label="연료·충전량 (%)"><Input type="number" min="0" max="100" step="1" value={form.fuel_level} onChange={change('fuel_level')}/></FormField>
      <FormField label="연결 단말기"><Select value={binding} onChange={e=>setBinding(e.target.value)}>
        <option value="">연결 안 함</option>{terminals.filter(d=>!occupied.has(d.id)).map(d=><option key={d.id} value={d.id}>{terminalName(d)}</option>)}
      </Select></FormField>
    </fieldset>
    {error && <p className="business-error" role="alert">{error}</p>}
    <div className="rfl-form-actions"><Button variant="ghost" disabled={busy} onClick={onClose}>닫기</Button><button className="business-button is-primary" type="submit" disabled={busy}>{busy?'저장 중…':'차량 저장'}</button></div></form>
  </Modal>;
}

import { useState } from 'react';
import { kstDateTime } from '../../lib/businessExport';
import { contractStage, isIncident, repairNames, workState } from '../../lib/rentalFleet';
import { matchesVehicle } from '../../lib/rentalInventory';
import CarImage from '../CarImage';
import Icon from '../Icon';
import sedan from '../entry/login-vehicle.png';
import { BusinessButton, useBusinessVehicle } from './BusinessWorkspace';
import RentalAssetEditor from './RentalAssets';
import { WorkEditor } from './RentalFleetWork';
import RentalRecordDrawer, { RecordFields } from './RentalRecordDrawer';

export default function RentalVehicleRecord({ row, contracts, work, now, vehicles, trackers, branches, onClose, onWorkDetail, onWorkSaved, onContracts }) {
  const [editor,setEditor] = useState(null);
  const openTerminal = useBusinessVehicle();
  const { device, label, branch, className, state, terminal, signal } = row;
  const profile = device.rental_profile;
  if (editor==='asset') return <RentalAssetEditor asset={profile} terminals={trackers} vehicles={vehicles} branches={branches} onClose={() => setEditor(null)}/>;
  if (editor==='work') return <WorkEditor devices={vehicles} contracts={contracts} presetVehicleId={device.id} onClose={() => setEditor(null)} onSave={() => {setEditor(null);onWorkSaved();}}/>;
  const rentals = contracts.filter(c => c.status !== 'cancelled' && matchesVehicle(c, device))
    .sort((a,b) => Date.parse(b.starts_at) - Date.parse(a.starts_at)).slice(0,4);
  const maintenance = work.filter(w => !isIncident(w.kind) && workState(w) === 'open' && matchesVehicle(w, device));
  const fuel = { gasoline:'휘발유', diesel:'경유', ev:'전기', lpg:'LPG' }[device.fuel_type] || device.fuel_type;
  return <RentalRecordDrawer title="렌트카 차량 상세" subtitle={[label,device.car_model].filter(Boolean).join(' · ')} onClose={onClose}
    footer={<><BusinessButton onClick={() => setEditor('work')}>세차·정비</BusinessButton><BusinessButton onClick={() => setEditor('asset')}>정보 수정</BusinessButton>
      <BusinessButton primary onClick={() => onContracts({new:true,vehicleId:device.id})}>예약 등록</BusinessButton></>}>
    <div className="rental-vehicle-hero">
      <div><strong>{label}</strong><small>{device.car_model}</small></div>
      <span className="rfl-badge" data-tone={state.code}>{state.label}</span>
      <CarImage deviceId={device.device_id} version={device.terminal?.car_image_url} fallback={<img src={sedan} alt=""/>}/>
    </div>
    <section><h3>차량 정보</h3><RecordFields rows={[
      ['차종 등급',className],['소속 지점',branch],['누적 거리',profile.odometer_km != null ? profile.odometer_km.toLocaleString() + ' km' : null],
      ['연료 · 잔량',[fuel,profile.fuel_level != null ? profile.fuel_level + '%' : null].filter(Boolean).join(' · ')],
      ['준비 상태',device.enabled === false ? '운영 중지' : profile.readiness === 'hold' ? '배차 보류' : '배차 허용'],
      ['보험 만료일',device.insurance_expiry],['검사 예정일',device.inspection_expiry],
    ]}/></section>
    <section><h3>단말 수신</h3><RecordFields rows={[
      ['연결 단말',device.terminal && openTerminal ? <button type="button" className="business-link" onClick={() => openTerminal(device.terminal)}>{terminal}</button> : terminal],
      ['수신 상태',signal.label],['마지막 수신',device.last_seen_at ? kstDateTime(device.last_seen_at) : null],
    ]}/></section>
    <section><header className="rental-related-header"><h3>연결된 예약·계약</h3><BusinessButton onClick={() => onContracts({vehicleId:device.id})}>계약 보기</BusinessButton></header>
      {rentals.length ? rentals.map(c => <button type="button" key={c.id} className="rental-record-related" onClick={() => onContracts({contract:c})}>
        <span>R-{c.id} · {c.renter_name}<small>{kstDateTime(c.starts_at)} ~ {kstDateTime(c.ends_at)}</small></span><span>{contractStage(c,now)}</span>
      </button>) : <p className="rental-record-text">조회 기간에 연결된 예약·계약이 없습니다.</p>}
    </section>
    {maintenance.length > 0 && <section><h3>예정된 세차·정비</h3>{maintenance.map(w => <button type="button" key={w.id} className="rental-record-related" onClick={() => onWorkDetail(w.id)}>
      <span>{repairNames[w.kind]} · {kstDateTime(w.starts_at)}</span><Icon name="chevron-right" size={15}/>
    </button>)}</section>}
  </RentalRecordDrawer>;
}

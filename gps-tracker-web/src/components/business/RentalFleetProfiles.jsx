import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { Modal } from '../ui';
import { BusinessButton } from './BusinessWorkspace';
import { rentalFleetLabel } from '../../lib/rentalFleet';
import VehicleCarePanel from '../VehicleCarePanel';

export const profileKey = () => [authScope(), 'rental-vehicle-profiles'];
export const useRentalProfiles = () => useQuery({ queryKey: profileKey(), queryFn: api.rentalFleetProfiles, staleTime: 15000 });

export default function RentalFleetProfileEditor({ device, onClose, onDevicesChange, branches = [] }) {
  const [tab, setTab] = useState('rental'), profile = device.rental_profile || {};
  const [revision] = useState(() => profile.revision || 0);
  const [form, setForm] = useState(() => ({
    branch: profile.branch || '', class_name: profile.class_name || '', readiness: profile.readiness || 'ready',
    odometer_km: profile.odometer_km ?? '', fuel_level: profile.fuel_level ?? '',
  }));
  const qc = useQueryClient(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const branchList = useId();
  function change(key, value) { setForm(old => ({ ...old, [key]: value })); }
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const updated = await api.saveRentalFleetProfile(device.id, { ...form, revision,
        odometer_km: form.odometer_km === '' ? null : Number(form.odometer_km), fuel_level: form.fuel_level === '' ? null : Number(form.fuel_level) });
      qc.setQueryData(profileKey(), old => [...(old || []).filter(p => p.device_id !== updated.device_id), updated]);
      qc.invalidateQueries({ queryKey: profileKey() });
      onClose();
    } catch (err) { setError(err.message); qc.invalidateQueries({ queryKey: profileKey() }); } finally { setBusy(false); }
  }
  return <Modal open size="lg" title="차량 정보 수정" subtitle={rentalFleetLabel(device)} onClose={busy ? undefined : onClose}>
    <div className="rfl-switch">{[['rental', '렌트카 운영'], ['vehicle', '차량·점검']].map(([key, label]) => <button key={key} type="button" className="rfl-profile-tab" aria-pressed={tab === key} onClick={() => setTab(key)}>{label}</button>)}</div>
    {tab === 'vehicle' ? <VehicleCarePanel device={device} onUpdated={onDevicesChange} /> : <form className="rfl-form" onSubmit={save}>
      <div className="rfl-form-fields">
        <label>소속 지점<input maxLength={80} list={branchList} value={form.branch} onChange={e => change('branch', e.target.value)} />
          <datalist id={branchList}>{branches.filter(b=>b.active !== false).map(b=><option key={b.id} value={b.name} />)}</datalist>
        </label>
        <label>차종 등급<input maxLength={80} value={form.class_name} placeholder={device.car_model || '차종 미지정'} onChange={e => change('class_name', e.target.value)} /></label>
        <label>누적 거리 (km)<input type="number" min={profile.odometer_km || 0} max={2147483647} step="1" value={form.odometer_km} onChange={e => change('odometer_km', e.target.value)} /></label>
        <label>연료·충전 잔량 (%)<input type="number" min="0" max="100" step="1" value={form.fuel_level} onChange={e => change('fuel_level', e.target.value)} /></label>
        <label>배차 상태<select value={form.readiness} onChange={e => change('readiness', e.target.value)}><option value="ready">배차 허용</option><option value="hold">배차 보류</option></select></label>
        {error && <p role="alert" className="rfl-error rfl-wide">{error}</p>}
      </div>
      <div className="rfl-form-actions rfl-wide"><BusinessButton disabled={busy} onClick={onClose}>닫기</BusinessButton><button type="submit" disabled={busy} className="business-button is-primary">{busy ? '저장 중…' : '저장'}</button></div>
    </form>}
  </Modal>;
}

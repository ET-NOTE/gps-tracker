import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { rememberFleetOwner } from '../../lib/fleetSession';
import { SERVICES } from './platformModel';
import './deviceSettings.css';

const connectionPages = {
  corporate_fleet:'/corporate?page=devices', rentcar:'/rentcar?page=devices', delivery:'/cargo?page=cargo-devices',
};

export default function DeviceServiceSettings({ device, services, onChanged }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  async function change(value) {
    setSaving(true);
    setError('');
    try { onChanged(await api.setDeviceAccountType(device.id, value || null)); }
    catch (e) { setError(e.message || '업무 구분을 저장하지 못했습니다.'); }
    finally { setSaving(false); }
  }
  const current = device.account_type_override || '';
  const labels = {unspecified:'개인', ...Object.fromEntries(SERVICES.map(s => [s.key,s.label]))};
  return <section className="pt-device-assignment">
    <label>단말기 업무 구분
      <select value={current} disabled={saving} onChange={e => change(e.target.value)}>
        <option value="">계정 기본값</option>
        {[...new Set(['unspecified', ...services, ...(current ? [current] : [])])].map(key => <option key={key} value={key}>{labels[key] || key}</option>)}
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
    <div className="pt-connection-links">{SERVICES.filter(s => services.includes(s.key)).map(s =>
      <Link key={s.key} to={connectionPages[s.key]} onClick={() => {if (s.key === 'corporate_fleet') rememberFleetOwner(null);}}>{s.label} 차량 연결</Link>)}</div>
  </section>;
}

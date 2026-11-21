import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { rememberFleetOwner } from '../../lib/fleetSession';
import Icon from '../Icon';
import Modal from '../ui/Modal';
import { terminalName } from '../../lib/corporateOverview';
import { SERVICES } from './platformModel';
import './deviceSettings.css';

const connectionPages = {
  corporate_fleet:'/corporate?page=devices', rentcar:'/rentcar?page=devices', delivery:'/cargo?page=cargo-devices',
};

export default function DeviceServiceSettings({ device, services, onChanged, onNavigate }) {
  const [open, setOpen] = useState(false);
  const current = device.account_type_override || '';
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState('');
  async function save() {
    if (pending.current) return;
    pending.current = true;
    setSaving(true);
    setError('');
    try {
      if (value !== current) onChanged(await api.setDeviceAccountType(device.id, value || null));
      setOpen(false);
    }
    catch (e) { setError(e.message || '업무 구분을 저장하지 못했습니다.'); }
    finally { pending.current = false; setSaving(false); }
  }
  const labels = {unspecified:'개인', ...Object.fromEntries(SERVICES.map(s => [s.key,s.label]))};
  return <><button type="button" className="pt-button" onClick={() => {setValue(current); setError(''); setOpen(true);}}>
    <Icon name="link" size={15}/>차량 연결 설정</button>
    {open && <Modal open mobileForm size={530} className="pt-standard-dialog" title="차량 연결 설정" subtitle={terminalName(device)}
      onClose={saving ? undefined : () => setOpen(false)} footer={<div className="pt-dialog-actions">
        <button type="button" className="pt-button" disabled={saving} onClick={() => setOpen(false)}>취소</button>
        <button type="button" className="pt-button pt-primary" disabled={saving} onClick={save}>{saving?'저장 중…':'업무 구분 저장'}</button></div>}>
    <section className="pt-terminal-fields">
    <label>단말기 업무 구분
      <select value={value} disabled={saving} onChange={e => setValue(e.target.value)}>
        <option value="">계정 기본값</option>
        {[...new Set(['unspecified', ...services, ...(current ? [current] : [])])].map(key => <option key={key} value={key}>{labels[key] || key}</option>)}
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
    <div className="pt-connection-links">{SERVICES.filter(s => services.includes(s.key)).map(s =>
      <Link key={s.key} to={connectionPages[s.key]} onClick={event => {if (pending.current) {event.preventDefault();return;} if (s.key === 'corporate_fleet') rememberFleetOwner(null);onNavigate?.();}}>{s.label} 차량 연결</Link>)}</div>
    </section></Modal>}
  </>;
}

import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../Icon';
import Modal from '../ui/Modal';
import { ageString, classifyDevice } from '../../colors';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { terminalName } from '../../lib/corporateOverview';
import { deviceBucket } from './platformModel';
import DeviceReadingTime from './DeviceReadingTime';

export default function TerminalAlerts({ devices = [], meta = {}, onDevice, scopeLabel, className = 'pt-icon-button pt-alert-trigger' }) {
  const [open, setOpen] = useState(false);
  const now = useVisibleNow(true, 60000);
  const alerts = devices.map(device => ({ device, state: classifyDevice(device, meta?.[device.id], now) }))
    .filter(({ state }) => ['offline', 'attention'].includes(deviceBucket(state)));
  const close = () => setOpen(false);
  return <>
    <button type="button" className={className} aria-label={'단말기 상태 알림 ' + alerts.length + '건'} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(true)}>
      <Icon name="bell" size={19}/>{alerts.length > 0 && <i/>}
    </button>
    <Modal open={open} className="pt-standard-dialog" size={530} title="단말기 상태 알림" subtitle="최근 수신 정보를 기준으로 표시합니다." onClose={close}
      footer={<div className="pt-dialog-actions">
        <button type="button" className="pt-button" aria-label="알림 닫기" onClick={close}>닫기</button>
        <Link to="/devices" className="pt-button pt-primary" onClick={close}>단말기 목록</Link>
      </div>}>
      {scopeLabel && <p className="pt-alert-summary">조회 범위 · {scopeLabel}</p>}
      {alerts.length ? <div className="pt-search-results pt-status-list">{alerts.map(({ device, state }) =>
        <button type="button" key={device.id} onClick={() => {close(); onDevice(device.id);}}>
          <Icon name="antenna"/><span>{terminalName(device)}<small title={device.last_seen_at ? ageString(device.last_seen_at) : undefined}>{device.last_seen_at?<>마지막 통신 <DeviceReadingTime value={device.last_seen_at}/></>:'아직 통신을 수신하지 않았습니다.'}</small></span>
          <span className="pt-state" style={{color:state.color,background:state.background}}>{state.label}</span>
        </button>)}</div> : <p className="pt-empty">현재 조회 범위에서 확인할 단말기 알림이 없습니다.</p>}
      <Link to="/profile?tab=notif" className="pt-button pt-status-settings" onClick={close}>알림 설정</Link>
    </Modal>
  </>;
}

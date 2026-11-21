import { useState } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../Icon';
import Modal from '../ui/Modal';
import { ageString, classifyDevice } from '../../colors';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import { terminalName } from '../../lib/corporateOverview';
import { deviceBucket } from './platformModel';

export default function TerminalAlerts({ devices = [], meta = {}, onDevice, className = 'pt-icon-button pt-alert-trigger' }) {
  const [open, setOpen] = useState(false);
  const now = useVisibleNow(true, 60000);
  const alerts = devices.map(device => ({ device, state: classifyDevice(device, meta?.[device.id], now) }))
    .filter(({ state }) => ['offline', 'attention'].includes(deviceBucket(state)));
  const close = () => setOpen(false);
  return <>
    <button type="button" className={className} aria-label={'단말기 상태 알림 ' + alerts.length + '건'} aria-haspopup="dialog" aria-expanded={open} onClick={()=>setOpen(true)}>
      <Icon name="bell" size={19}/>{alerts.length > 0 && <i/>}
    </button>
    <Modal open={open} title="단말기 상태 알림" onClose={close}
      footer={<div className="pt-dialog-actions">
        <button type="button" className="pt-button" aria-label="알림 닫기" onClick={close}>닫기</button>
        <Link to="/devices" className="pt-button pt-primary" onClick={close}>단말기 목록</Link>
      </div>}>
      {alerts.length ? <div className="pt-search-results">{alerts.map(({ device, state }) =>
        <button type="button" key={device.id} onClick={() => {close(); onDevice(device.id);}}>
          <Icon name="antenna"/><span>{terminalName(device)}<small>{state.label} · {ageString(device.last_seen_at)}</small></span><Icon name="chevron-right" size={15}/>
        </button>)}</div> : <p className="pt-empty">현재 조회 범위에서 확인할 단말기 알림이 없습니다.</p>}
      <Link to="/profile?tab=notif" className="pt-button" onClick={close}>알림 설정</Link>
    </Modal>
  </>;
}

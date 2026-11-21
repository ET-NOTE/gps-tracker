import Icon from '../Icon';
import { classifyDevice } from '../../colors';
import { deviceBattery } from '../../lib/battery';
import { terminalName } from '../../lib/corporateOverview';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import DeviceReadingTime from './DeviceReadingTime';

export default function MapDeviceCard({vehicles, device, meta, onDetail, onList}) {
  const now = useVisibleNow(true, 60000);
  if (!vehicles.length) return null;
  if (!device) {
    const positioned = vehicles.filter(v => v.last_lat != null && v.last_lng != null).length;
    return <section className="pt-position-card" aria-label="단말기 위치 현황">
      <header><Icon name="mapPin" size={18}/><strong>단말기 위치</strong></header>
      <dl><div><dt>등록 단말기</dt><dd>{vehicles.length}대</dd></div><div><dt>위치 수신</dt><dd>{positioned}대</dd></div></dl>
      <button type="button" onClick={onList}>단말기 목록<Icon name="chevron-right" size={14}/></button>
    </section>;
  }
  const status = classifyDevice(device, meta, now);
  const battery = deviceBattery(device, meta);
  return <section className="pt-position-card" aria-label="선택한 단말기">
    <header><Icon name="antenna" size={18}/><strong>{terminalName(device)}</strong><span className="pt-state" style={{color:status.color, background:status.background}}>{status.label}</span></header>
    <dl><div><dt>최근 위치</dt><dd><DeviceReadingTime value={device.last_fix_at}/></dd></div><div><dt>최근 통신</dt><dd><DeviceReadingTime value={device.last_seen_at}/></dd></div><div><dt>배터리</dt><dd>{battery.percent == null ? '미수신' : '약 ' + battery.percent + '%'}</dd></div></dl>
    <button type="button" onClick={() => onDetail(device.id)}>상세 보기<Icon name="chevron-right" size={14}/></button>
  </section>;
}

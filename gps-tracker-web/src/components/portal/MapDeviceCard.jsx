import Icon from '../Icon';
import { classifyDevice } from '../../colors';
import { deviceBattery } from '../../lib/battery';
import { terminalName } from '../../lib/corporateOverview';
import { validPosition } from '../../lib/businessWorkspace';
import { useVisibleNow } from '../../hooks/useVisibleNow';
import DeviceReadingTime from './DeviceReadingTime';

export default function MapDeviceCard({vehicles, device, meta, onDetail, onList}) {
  const now = useVisibleNow(true, 60000);
  if (!vehicles.length) return null;
  if (!device) {
    const positioned = vehicles.filter(validPosition).length;
    return <section className="pt-position-card" aria-label="단말기 위치 현황">
      <header><Icon name="mapPin" size={18}/><strong>단말기 위치</strong></header>
      <dl><div><dt>등록 단말기</dt><dd>{vehicles.length}대</dd></div><div><dt>위치 수신</dt><dd>{positioned}대</dd></div></dl>
      <button type="button" onClick={onList}>단말기 목록<Icon name="chevron-right" size={14}/></button>
    </section>;
  }
  const status = classifyDevice(device, meta, now);
  const battery = deviceBattery(device, meta);
  const positioned = validPosition(device);
  const kind = device.license_plate || device.car_plate || device.device_uid;
  return <section className="pt-position-card" aria-label="선택한 단말기">
    <header><span className="pt-position-icon"><Icon name={device.license_plate ? 'car' : 'antenna'} size={19}/></span><div className="pt-position-name"><button type="button" onClick={() => onDetail(device.id)}>{terminalName(device)}</button>{kind && kind !== terminalName(device) && <small>{kind}</small>}</div><span className="pt-state" style={{color:status.color, background:status.background}}>{status.label}</span></header>
    <p className="pt-position-line"><Icon name="mapPin" size={15}/>{positioned ? '마지막 수신 위치' : '위치 수신 대기'}</p>
    <dl>
      <div><dt>최근 위치</dt><dd><DeviceReadingTime shortFor={now} value={positioned ? device.last_fix_at : null}/></dd></div>
      <div><dt>최근 통신</dt><dd><DeviceReadingTime shortFor={now} value={device.last_seen_at}/></dd></div>
      <div><dt>배터리</dt><dd>{battery.percent == null ? '미수신' : <span title={'예상 충전율 약 ' + battery.percent + '%'}>{battery.percent}<small>%</small></span>}</dd></div>
    </dl>
    <footer><span>{positioned ? '마지막 수신 위치 기준' : '첫 위치 수신 대기'}</span><button type="button" onClick={() => onDetail(device.id)}>상세 보기</button></footer>
  </section>;
}

import { batteryLevelHelp, batteryPolicy, batteryVoltageHelp } from '../lib/battery';
import Icon from './Icon';
import './BatteryStatus.css';
import BatteryRuntime from './BatteryRuntime';

export default function BatteryStatus({ reading, compact = false, showRuntime = true, sourceCaption = false }) {
  return <div className={`battery-status${compact ? ' battery-status-compact' : ''}`} style={{ '--battery-color': reading.color }} title={`${batteryLevelHelp} ${batteryVoltageHelp} ${batteryPolicy.charging_reference.note}`}>
    <div className="battery-status-value"><Icon name="battery" size={16} /><strong>{reading.percent == null ? (sourceCaption ? '잔량 미수신' : '—') : `약 ${reading.percent}%`}</strong>{(!sourceCaption || reading.voltage !== '—') && <span>{reading.voltage}</span>}</div>
    <div className="battery-status-caption"><span>{reading.label}{sourceCaption && reading.percent != null && ' · 최근 수신값 기준'}</span></div>
    {sourceCaption && reading.percent == null && <div className="battery-status-meter" aria-hidden="true"/>}
    {!compact && reading.percent != null && <div className="battery-status-meter" role="meter" aria-label="배터리 잔량" aria-valuemin={0} aria-valuemax={100} aria-valuenow={reading.percent}><span style={{ width: `${reading.percent}%` }} /></div>}
    {showRuntime && <BatteryRuntime estimate={reading.runtime} />}
  </div>;
}

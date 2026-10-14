import { batteryPolicy } from '../lib/battery';
import Icon from './Icon';
import './BatteryStatus.css';
import BatteryRuntime from './BatteryRuntime';

export default function BatteryStatus({ reading, compact = false, showRuntime = true }) {
  return <div className={`battery-status${compact ? ' battery-status-compact' : ''}`} style={{ '--battery-color': reading.color }} title={`${batteryPolicy.estimate_note} ${batteryPolicy.calibration.note} ${batteryPolicy.charging_reference.note}`}>
    <div className="battery-status-value"><Icon name="battery" size={16} /><strong>{reading.percent == null ? '—' : `약 ${reading.percent}%`}</strong><span>{reading.voltage}</span></div>
    <div className="battery-status-caption"><span>{reading.label}</span></div>
    {!compact && reading.percent != null && <div className="battery-status-meter" role="meter" aria-label="배터리 잔량" aria-valuemin={0} aria-valuemax={100} aria-valuenow={reading.percent}><span style={{ width: `${reading.percent}%` }} /></div>}
    {showRuntime && <BatteryRuntime estimate={reading.runtime} />}
  </div>;
}

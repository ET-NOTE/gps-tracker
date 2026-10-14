import { batteryPolicy } from '../lib/battery';
import Icon from './Icon';
import './BatteryStatus.css';

export default function BatteryStatus({ reading, compact = false }) {
  return <div className={`battery-status${compact ? ' battery-status-compact' : ''}`} style={{ '--battery-color': reading.color }} title={`${batteryPolicy.estimate_note} ${batteryPolicy.calibration.note}`}>
    <div className="battery-status-value"><Icon name="battery" size={16} /><strong>{reading.percent == null ? '—' : `약 ${reading.percent}%`}</strong><span>{reading.voltage}</span></div>
    <div className="battery-status-caption"><span>{reading.label}</span><span>{reading.outsideCalibration ? '범위 밖 추정' : '추정 잔량'}</span></div>
    {!compact && reading.percent != null && <div className="battery-status-meter" role="meter" aria-label="전압 기반 추정 잔량" aria-valuemin={0} aria-valuemax={100} aria-valuenow={reading.percent}><span style={{ width: `${reading.percent}%` }} /></div>}
  </div>;
}

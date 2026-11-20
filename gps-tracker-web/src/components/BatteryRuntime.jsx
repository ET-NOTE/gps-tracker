import { useVisibleNow } from '../hooks/useVisibleNow';
import { batteryRuntimeView } from '../lib/batteryRuntime';
import './BatteryStatus.css';

export default function BatteryRuntime({ estimate, compact = false }) {
  const now = useVisibleNow(!!estimate, 30_000);
  const view = batteryRuntimeView(estimate, now);
  if (!view) return null;
  return <div className="battery-runtime" title={`${estimate.reference_label}. ${estimate.note}`}>
    <span className="battery-runtime-time">{view.text}</span>
    {!compact && view.date && <span>{view.date}</span>}
    {!compact && <span className="battery-runtime-basis">동일 배터리·절전 해제·미충전 기준</span>}
  </div>;
}

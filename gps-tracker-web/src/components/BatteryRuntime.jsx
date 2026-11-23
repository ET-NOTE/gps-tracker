import { useVisibleNow } from '../hooks/useVisibleNow';
import { batteryRuntimeView } from '../lib/batteryRuntime';
import runtimePolicy from '../../../gps-tracker-api/battery-runtime-policy.json';
import './BatteryStatus.css';

export default function BatteryRuntime({ estimate, compact = false }) {
  const now = useVisibleNow(!!estimate, 30_000);
  const view = batteryRuntimeView(estimate, now);
  if (!view) return null;
  const note = estimate.model === runtimePolicy.version
    ? '충전하지 않고 측정 당시와 같은 부하로 사용할 때의 예상입니다. 배터리 용량·온도·통신 상태·절전 여부에 따라 달라집니다. 측정 당시 전원을 분리한 정확한 시각은 확인되지 않았습니다. 저전압으로 단말기가 재시작할 때까지의 시간이며 배터리의 안전 방전 한계를 뜻하지 않습니다.'
    : estimate.note;
  return <div className="battery-runtime" title={`${estimate.reference_label}. ${note}`}>
    <span className="battery-runtime-time">{view.text}</span>
    {!compact && view.date && <span>{view.date}</span>}
    {!compact && <span className="battery-runtime-basis">동일 배터리·절전 해제·미충전 기준</span>}
  </div>;
}

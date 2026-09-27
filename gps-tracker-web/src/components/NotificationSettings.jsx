// 알림 설정 — STATUS 분류와 1:1 매핑.
//   통신 상태:    signal_loss / offline / online (복구)
//   배터리:       low_batt
//   GPS·전원:    device_health (gps_anomaly + brownout)
//   절전 사이클: sleep_enter / wake / lost (24h+)
//   기타:         motion / geofence
import { useState, useEffect } from 'react';
import { api } from '../api';

export default function NotificationSettings() {
  const [s, setS]       = useState(null);
  const [busy, setBusy] = useState(false);
  // (2026-07-01) 저장 결과 UI — auto-save 가 조용히 실패하던 케이스 진단용.
  const [saveMsg, setSaveMsg] = useState(null);   // {ok: bool, text: string}

  const [loadError, setLoadError] = useState(false);
  async function load() {
    setLoadError(false);
    try { setS(await api.getNotificationSettings()); }
    catch { setLoadError(true); }
  }
  useEffect(() => { load(); }, []);

  async function patch(updates) {
    if (busy) return;
    const previous = s;
    setS(prev => ({ ...prev, ...updates }));
    setBusy(true);
    setSaveMsg(null);
    try {
      setS(await api.updateNotificationSettings(updates));
      setSaveMsg({ ok: true, text: '알림 설정을 저장했습니다.' });
    } catch {
      setS(previous);
      setSaveMsg({ ok: false, text: '설정을 저장하지 못해 이전 값으로 되돌렸습니다. 연결을 확인한 뒤 다시 변경해 주세요.' });
    } finally { setBusy(false); }
  }

  if (!s) return <div role="status" style={{ color: 'var(--text-3)', padding: 16 }}>
    {loadError ? <>알림 설정을 불러오지 못했습니다. <button onClick={load}>다시 시도</button></> : '알림 설정을 불러오는 중…'}
  </div>;

  return (
    <fieldset disabled={busy} aria-busy={busy} style={{ display: 'flex', flexDirection: 'column', gap: 14, border: 0, padding: 0, margin: 0, minWidth: 0 }}>
      <p style={{ color: 'var(--text-3)', margin: 0, fontSize: 12 }}>변경한 설정은 자동으로 저장됩니다. 휴대폰 알림 설정에서도 소리와 표시 방식을 조절할 수 있습니다.</p>

      {/* ─── 통신 상태 ─────────────────────────── */}
      <Group title="통신 상태" desc="장치 정보의 수신이 지연되거나 연결이 복구될 때">
        <Toggle label="새 정보 수신 지연"
          sub={`${s.signal_loss_minutes}분 동안 장치의 새 정보가 도착하지 않을 때`}
          value={s.signal_loss_alert}
          onChange={v => patch({ signal_loss_alert: v })} />
        <Toggle label="연결 확인 필요"
          sub={`${s.offline_minutes}분 동안 장치의 새 정보가 도착하지 않을 때`}
          value={s.offline_alert}
          onChange={v => patch({ offline_alert: v })} />
        <Toggle label="연결 복구"
          sub="끊겼다가 다시 연결됐을 때"
          value={s.online_alert}
          onChange={v => patch({ online_alert: v })} />
        <NumField label="수신 지연 안내까지 (분)"
          value={s.signal_loss_minutes} min={1} max={Math.min(30, s.offline_minutes - 1)}
          onCommit={v => patch({ signal_loss_minutes: v })} />
        <NumField label="연결 확인 안내까지 (분)"
          value={s.offline_minutes} min={Math.max(5, s.signal_loss_minutes + 1)} max={120}
          onCommit={v => patch({ offline_minutes: v })} />
      </Group>

      {/* ─── 절전 / 회복 사이클 ─────────────────── */}
      <Group title="장치 작동 상태" desc="절전 모드 전환과 작동 재개를 안내합니다. 차량의 주행 여부와는 다를 수 있습니다.">
        <Toggle label="절전 모드 전환"
          sub="배터리를 아끼기 위해 장치가 절전 모드로 전환될 때"
          value={s.sleep_alert}
          onChange={v => patch({ sleep_alert: v })} />
        <Toggle label="장치 작동 재개"
          sub="장치가 켜지거나 깨어날 때 (움직임 감지는 아래에서 별도 설정)"
          value={s.wake_alert}
          onChange={v => patch({ wake_alert: v })} />
        <Toggle label="기동 후 첫 위치 확인"
          sub="장치 기동 후 GPS 위치가 처음 확인될 때. 실제 이동을 뜻하지는 않습니다."
          value={s.cycle_first_fix_alert ?? false}
          onChange={v => patch({ cycle_first_fix_alert: v })} />
      </Group>

      {/* ─── 배터리 / 전원 / GPS ────────────────── */}
      <Group title="배터리와 위치 상태">
        <Toggle label="배터리 확인 필요"
          sub={`배터리 전압이 설정한 기준보다 낮을 때`}
          value={s.low_batt_alert}
          onChange={v => patch({ low_batt_alert: v })} />
        <Toggle label="위치·전원 이상"
          sub="위치 확인이 반복해서 지연되거나 전압 저하로 장치가 재시작될 때"
          value={s.device_health_alert ?? true}
          onChange={v => patch({ device_health_alert: v })} />
        <NumField label="배터리 알림 전압 (mV)"
          value={s.low_batt_threshold_mv} min={3000} max={4200}
          onCommit={v => patch({ low_batt_threshold_mv: v })} />
      </Group>

      {/* ─── 그 외 ──────────────────────────────── */}
      <Group title="움직임과 설정 구역">
        <Toggle label="움직임으로 깨어남"
          sub="움직임 센서로 장치가 깨어났을 때. 차량 이동을 확정하는 알림은 아닙니다."
          value={s.motion_alert}
          onChange={v => patch({ motion_alert: v })} />
        <Toggle label="설정한 구역 출입"
          value={s.geofence_alert}
          onChange={v => patch({ geofence_alert: v })} />
      </Group>

      <div role="status" aria-live="polite" style={{ fontSize: 12, color: saveMsg?.ok === false ? 'var(--danger)' : 'var(--text-2)' }}>
        {busy ? '저장 중…' : saveMsg?.text}
      </div>
    </fieldset>
  );
}

function Group({ title, desc, children }) {
  return (
    <div>
      <div style={{
        fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
        textTransform: 'uppercase', letterSpacing: '0.04em',
        marginBottom: 4,
      }}>{title}</div>
      {desc && (
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>{desc}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>{children}</div>
    </div>
  );
}

function Toggle({ label, sub, value, onChange }) {
  return (
    <div style={row}>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 13, color: 'var(--text)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
      </div>
      <button type="button" role="switch" aria-label={label} aria-checked={!!value} onClick={() => onChange(!value)} style={{
        ...sw, background: value ? 'var(--accent)' : 'var(--surface)',
        flexShrink: 0,
      }}>
        <span style={{
          ...swKnob, transform: `translateX(${value ? 20 : 0}px)`,
        }} />
      </button>
    </div>
  );
}

function NumField({ label, value, min, max, onCommit }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  return (
    <div style={row}>
      <span style={{ fontSize: 13, color: 'var(--text-2)' }}>{label}</span>
      <input aria-label={label} type="number" value={v} min={min} max={max}
        onChange={e => setV(e.target.value)}
        onBlur={() => {
          const n = parseInt(v, 10);
          if (!isNaN(n) && n !== value && (min == null || n >= min) && (max == null || n <= max)) {
            onCommit(n);
          } else {
            setV(String(value));
          }
        }}
        style={input} />
    </div>
  );
}

const row = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  gap: 12, padding: '10px 12px',
  background: 'var(--surface-2)', borderRadius: 8,
};
const sw    = {
  position: 'relative', width: 44, height: 24, borderRadius: 12,
  border: '1px solid var(--border)', cursor: 'pointer',
  transition: 'background .15s', padding: 0,
};
const swKnob = {
  position: 'absolute', left: 1, top: 1, width: 20, height: 20, borderRadius: 10,
  background: 'white', transition: 'transform .15s',
  boxShadow: '0 1px 3px rgba(0,0,0,.2)',
};
const input = {
  width: 80, padding: '4px 8px',
  background: 'var(--surface)', border: '1px solid var(--border)',
  borderRadius: 4, color: 'var(--text)', fontSize: 13, textAlign: 'right',
};

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

  useEffect(() => {
    api.getNotificationSettings().then(setS).catch(console.error);
  }, []);

  async function patch(updates) {
    setS(prev => ({ ...prev, ...updates }));   // optimistic
    setBusy(true);
    setSaveMsg(null);
    try {
      const next = await api.updateNotificationSettings(updates);
      setS(next);
    } catch (e) {
      // (2026-07-01) alert 대신 화면에 남는 error msg — 사용자가 놓치지 않게.
      console.error('[NotificationSettings] auto-save failed:', e);
      setSaveMsg({ ok: false, text: `자동 저장 실패: ${e.message}` });
    } finally {
      setBusy(false);
    }
  }

  // (2026-07-01) 명시적 저장 — auto-save 실패 시 사용자가 강제로 현재 UI 상태 전체를 backend 에 재전송.
  // 원인 진단: patch() 는 매 토글 마다 호출되지만 network / auth / silent 401 등 이유로 fail 시 UI 만 켜져
  // 있고 backend 는 반영 안 됨. 이 버튼으로 명시적 flush + 결과 표시.
  async function saveAll() {
    if (!s) return;
    setBusy(true);
    setSaveMsg(null);
    const payload = {
      motion_alert:          s.motion_alert,
      low_batt_alert:        s.low_batt_alert,
      offline_alert:         s.offline_alert,
      geofence_alert:        s.geofence_alert,
      device_health_alert:   s.device_health_alert,
      lost_alert:            s.lost_alert,
      signal_loss_alert:     s.signal_loss_alert,
      online_alert:          s.online_alert,
      sleep_alert:           s.sleep_alert,
      wake_alert:            s.wake_alert,
      cycle_first_fix_alert: s.cycle_first_fix_alert,
      low_batt_threshold_mv: s.low_batt_threshold_mv,
      offline_minutes:       s.offline_minutes,
      signal_loss_minutes:   s.signal_loss_minutes,
    };
    try {
      const next = await api.updateNotificationSettings(payload);
      setS(next);
      setSaveMsg({ ok: true, text: '저장 완료 — backend 반영됨' });
    } catch (e) {
      console.error('[NotificationSettings] explicit save failed:', e);
      setSaveMsg({ ok: false, text: `저장 실패: ${e.message}` });
    } finally {
      setBusy(false);
    }
  }

  if (!s) return <div style={{ color: 'var(--text-3)', padding: 16 }}>로딩...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

      {/* ─── 통신 상태 ─────────────────────────── */}
      <Group title="통신 상태" desc="디바이스가 정해진 시간 동안 응답이 없거나 다시 연결될 때">
        <Toggle label="📶 통신 약함"
          sub={`${s.signal_loss_minutes}분 무소식 — 단기 끊김 (지하·실내·터널 등)`}
          value={s.signal_loss_alert}
          onChange={v => patch({ signal_loss_alert: v })} />
        <Toggle label="📡 통신 두절 (오프라인)"
          sub={`${s.offline_minutes}분 무소식 — 연결 회복 안 됨`}
          value={s.offline_alert}
          onChange={v => patch({ offline_alert: v })} />
        <Toggle label="✅ 통신 복구"
          sub="끊겼다가 다시 연결됐을 때"
          value={s.online_alert}
          onChange={v => patch({ online_alert: v })} />
        <NumField label="통신 약함 임계 (분)"
          value={s.signal_loss_minutes} min={1} max={30}
          onCommit={v => patch({ signal_loss_minutes: v })} />
        <NumField label="통신 두절 임계 (분)"
          value={s.offline_minutes} min={5} max={120}
          onCommit={v => patch({ offline_minutes: v })} />
      </Group>

      {/* ─── 절전 / 회복 사이클 ─────────────────── */}
      <Group title="절전 / 깨어남" desc="스위치·모션·타이머에 의한 sleep ↔ wake 전이">
        <Toggle label="🌙 절전 진입"
          sub="sleep 모드 들어갈 때 (스위치/타이머/저전압 트리거)"
          value={s.sleep_alert}
          onChange={v => patch({ sleep_alert: v })} />
        <Toggle label="☀️ 깨어남"
          sub="모션·스위치로 다시 동작 시작"
          value={s.wake_alert}
          onChange={v => patch({ wake_alert: v })} />
        <Toggle label="📍 사이클 첫 좌표"
          sub="깨어남 후 GPS 가 좌표 잡힌 시점 1회 (외출 시작 신호)"
          value={s.cycle_first_fix_alert ?? false}
          onChange={v => patch({ cycle_first_fix_alert: v })} />
        <Toggle label="❗ 장기 무응답 (꺼진 후 무소식)"
          sub="sleep 후 24시간 넘게 안 깨어났을 때"
          value={s.lost_alert ?? true}
          onChange={v => patch({ lost_alert: v })} />
      </Group>

      {/* ─── 배터리 / 전원 / GPS ────────────────── */}
      <Group title="하드웨어 상태">
        <Toggle label="🔋 저전압"
          sub={`배터리 ${s.low_batt_threshold_mv}mV 미만`}
          value={s.low_batt_alert}
          onChange={v => patch({ low_batt_alert: v })} />
        <Toggle label="🛰️ 기기 건강 (GPS / 전원)"
          sub="GPS 신호 약함, 브라운아웃 등 펌웨어 진단"
          value={s.device_health_alert ?? true}
          onChange={v => patch({ device_health_alert: v })} />
        <NumField label="저전압 임계 (mV)"
          value={s.low_batt_threshold_mv} min={3000} max={4200}
          onCommit={v => patch({ low_batt_threshold_mv: v })} />
      </Group>

      {/* ─── 그 외 ──────────────────────────────── */}
      <Group title="모션 / 지오펜스">
        <Toggle label="🏃 모션 감지"
          value={s.motion_alert}
          onChange={v => patch({ motion_alert: v })} />
        <Toggle label="📍 지오펜스 진입/이탈"
          value={s.geofence_alert}
          onChange={v => patch({ geofence_alert: v })} />
      </Group>

      {/* (2026-07-01) 명시적 저장 — auto-save 조용히 fail 하는 경우 강제 재-flush */}
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: '12px 0', marginTop: 4,
        borderTop: '1px solid var(--border)',
      }}>
        <button
          onClick={saveAll}
          disabled={busy || !s}
          style={{
            width: '100%', padding: '12px 16px',
            background: busy ? 'var(--surface-2)' : 'var(--accent)',
            color: busy ? 'var(--text-3)' : 'white',
            border: 'none', borderRadius: 8,
            fontSize: 14, fontWeight: 600,
            cursor: busy ? 'default' : 'pointer',
          }}>
          {busy ? '저장 중...' : '💾 저장'}
        </button>
        {saveMsg && (
          <div style={{
            fontSize: 12, padding: '8px 12px', borderRadius: 6,
            background: saveMsg.ok ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
            color: saveMsg.ok ? '#16a34a' : '#dc2626',
            border: `1px solid ${saveMsg.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
          }}>
            {saveMsg.text}
          </div>
        )}
      </div>
    </div>
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
      <button onClick={() => onChange(!value)} style={{
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
      <input type="number" value={v} min={min} max={max}
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

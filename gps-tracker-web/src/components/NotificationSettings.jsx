// 알림 설정 — iOS style: 섹션 카드 + 컬러 아이콘 배지.
//   통신 상태:    signal_loss / offline / online (복구)
//   배터리:       low_batt
//   GPS·전원:    device_health (gps_anomaly + brownout)
//   절전 사이클: sleep_enter / wake / lost (24h+)
//   기타:         motion / geofence
import React, { useState, useEffect } from 'react';
import { api } from '../api';
import Icon from './Icon';

export default function NotificationSettings() {
  const [s, setS]       = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.getNotificationSettings().then(setS).catch(console.error);
  }, []);

  async function patch(updates) {
    setS(prev => ({ ...prev, ...updates }));   // optimistic
    setBusy(true);
    try {
      const next = await api.updateNotificationSettings(updates);
      setS(next);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!s) return <div style={{ color: 'var(--text-3)', padding: 16 }}>로딩...</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>

      {/* ─── 통신 상태 ─────────────────────────── */}
      <Group title="통신 상태">
        <Toggle
          icon="warn" iconBg="#FEF3C7" iconColor="#D97706"
          label="통신 약함"
          sub={`${s.signal_loss_minutes}분 무소식 — 단기 끊김`}
          value={s.signal_loss_alert}
          onChange={v => patch({ signal_loss_alert: v })} />
        <Toggle
          icon="unlink" iconBg="#FEE2E2" iconColor="#DC2626"
          label="통신 두절"
          sub={`${s.offline_minutes}분 무소식 — 연결 회복 안 됨`}
          value={s.offline_alert}
          onChange={v => patch({ offline_alert: v })} />
        <Toggle
          icon="link" iconBg="#D1FAE5" iconColor="#059669"
          label="통신 복구"
          sub="끊겼다가 다시 연결됐을 때"
          value={s.online_alert}
          onChange={v => patch({ online_alert: v })} />
        <NumField
          icon="clock" iconBg="#FEF9C3" iconColor="#CA8A04"
          label="통신 약함 임계 (분)"
          value={s.signal_loss_minutes} min={1} max={30}
          onCommit={v => patch({ signal_loss_minutes: v })} />
        <NumField
          icon="clock" iconBg="#FEE2E2" iconColor="#DC2626"
          label="통신 두절 임계 (분)"
          value={s.offline_minutes} min={5} max={120}
          onCommit={v => patch({ offline_minutes: v })} />
      </Group>

      {/* ─── 절전 / 회복 사이클 ─────────────────── */}
      <Group title="절전 / 깨어남">
        <Toggle
          icon="moon" iconBg="#EDE9FE" iconColor="#7C3AED"
          label="절전 진입"
          sub="sleep 모드 들어갈 때"
          value={s.sleep_alert}
          onChange={v => patch({ sleep_alert: v })} />
        <Toggle
          icon="sun" iconBg="#FEF3C7" iconColor="#D97706"
          label="깨어남"
          sub="모션·스위치로 다시 동작 시작"
          value={s.wake_alert}
          onChange={v => patch({ wake_alert: v })} />
        <Toggle
          icon="clock" iconBg="#FFEDD5" iconColor="#EA580C"
          label="장기 무응답"
          sub="sleep 후 24시간 넘게 안 깨어났을 때"
          value={s.lost_alert ?? true}
          onChange={v => patch({ lost_alert: v })} />
      </Group>

      {/* ─── 배터리 / 전원 / GPS ────────────────── */}
      <Group title="하드웨어 상태">
        <Toggle
          icon="battery" iconBg="#FEE2E2" iconColor="#DC2626"
          label="저전압"
          sub={`배터리 ${s.low_batt_threshold_mv}mV 미만`}
          value={s.low_batt_alert}
          onChange={v => patch({ low_batt_alert: v })} />
        <Toggle
          icon="sat" iconBg="#DBEAFE" iconColor="#2563EB"
          label="기기 건강 (GPS / 전원)"
          sub="GPS 신호 약함, 브라운아웃 등 펌웨어 진단"
          value={s.device_health_alert ?? true}
          onChange={v => patch({ device_health_alert: v })} />
        <NumField
          icon="battery" iconBg="#FEE2E2" iconColor="#DC2626"
          label="저전압 임계 (mV)"
          value={s.low_batt_threshold_mv} min={3000} max={4200}
          onCommit={v => patch({ low_batt_threshold_mv: v })} />
      </Group>

      {/* ─── 그 외 ──────────────────────────────── */}
      <Group title="모션 / 지오펜스">
        <Toggle
          icon="target" iconBg="#D1FAE5" iconColor="#059669"
          label="모션 감지"
          value={s.motion_alert}
          onChange={v => patch({ motion_alert: v })} />
        <Toggle
          icon="mapPin" iconBg="#EEF2FF" iconColor="#4F46E5"
          label="지오펜스 진입/이탈"
          value={s.geofence_alert}
          onChange={v => patch({ geofence_alert: v })} />
      </Group>

      {busy && <div style={{ color: 'var(--text-3)', fontSize: 11, textAlign: 'right' }}>저장 중...</div>}
    </div>
  );
}

function Group({ title, children }) {
  const arr = Array.isArray(children) ? children : [children];
  return (
    <div>
      <div style={st.groupTitle}>{title}</div>
      <div style={st.card}>
        {arr.map((child, i) =>
          child ? React.cloneElement(child, { isLast: i === arr.length - 1, key: i }) : null
        )}
      </div>
    </div>
  );
}

function Toggle({ icon, iconBg, iconColor, label, sub, value, onChange, isLast }) {
  return (
    <div style={{ ...st.row, borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
      <div style={{ ...st.iconBox, background: iconBg, color: iconColor }}>
        <Icon name={icon} size={16} stroke={2} />
      </div>
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={st.label}>{label}</div>
        {sub && <div style={st.sub}>{sub}</div>}
      </div>
      <button onClick={() => onChange(!value)} style={{
        ...st.sw,
        background: value ? 'var(--accent, #4f46e5)' : 'var(--border)',
      }}>
        <span style={{
          ...st.swKnob, transform: `translateX(${value ? 20 : 2}px)`,
        }} />
      </button>
    </div>
  );
}

function NumField({ icon, iconBg, iconColor, label, value, min, max, onCommit, isLast }) {
  const [v, setV] = useState(String(value));
  useEffect(() => { setV(String(value)); }, [value]);
  return (
    <div style={{ ...st.row, borderBottom: isLast ? 'none' : '1px solid var(--border)' }}>
      <div style={{ ...st.iconBox, background: iconBg, color: iconColor }}>
        <Icon name={icon} size={16} stroke={2} />
      </div>
      <span style={{ ...st.label, flex: 1 }}>{label}</span>
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
        style={st.input} />
    </div>
  );
}

const st = {
  groupTitle: {
    fontSize: 11, fontWeight: 700, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '0.05em',
    marginBottom: 6, paddingLeft: 4,
  },
  card: {
    borderRadius: 14,
    overflow: 'hidden',
    border: '1px solid var(--border)',
    background: 'var(--surface)',
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '11px 14px',
  },
  iconBox: {
    width: 32, height: 32, borderRadius: 8,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    flexShrink: 0,
  },
  label: {
    fontSize: 13, fontWeight: 500, color: 'var(--text)',
  },
  sub: {
    fontSize: 11, color: 'var(--text-3)', marginTop: 2,
  },
  sw: {
    position: 'relative', width: 44, height: 26, borderRadius: 13,
    border: 'none', cursor: 'pointer',
    transition: 'background .2s', padding: 0, flexShrink: 0,
  },
  swKnob: {
    position: 'absolute', top: 2, left: 0, width: 22, height: 22, borderRadius: 11,
    background: 'white', transition: 'transform .2s',
    boxShadow: '0 1px 4px rgba(0,0,0,.25)',
  },
  input: {
    width: 72, padding: '5px 8px',
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 8, color: 'var(--text)', fontSize: 13,
    textAlign: 'right',
  },
};

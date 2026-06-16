// 홈 탭에서 지오펜스 관리를 띄우는 시트.
// - mobile/tablet: 화면 하단 슬라이드업 시트
// - desktop:       지도 우측 패널 (380px)
// 탭: 목록 (펜스 CRUD) / 이력 (진입·이탈·활성화 이벤트)
import { useEffect, useState } from 'react';
import GeofencePanel from './GeofencePanel';
import Icon from './Icon';
import useBreakpoint from '../useBreakpoint';
import useSwipeDownClose from '../useSwipeDownClose';
import { api } from '../api';

const KIND_META = {
  geofence_armed: { icon: '●', label: '활성화', color: 'var(--text-2)' },
  geofence_in:    { icon: '↘', label: '진입',   color: 'var(--accent)' },
  geofence_out:   { icon: '↗', label: '이탈',   color: 'var(--danger)' },
};

export default function GeofenceSheet({
  devices, mapRef, onClose,
  fences, onChange,
  showFences, onToggleShow,
  alertEnabled, onToggleAlert,
  filterDeviceId,
}) {
  const bp = useBreakpoint();
  const isDesktop = bp === 'desktop';
  const [tab, setTab] = useState('list');   // 'list' | 'history'

  // 모달 내 디바이스 선택 — 전역 필터 default, 사용자가 모달 내에서 임의 변경 가능.
  // null = 전체. 전역 필터 변경 시 동기화.
  const [localDevId, setLocalDevId] = useState(filterDeviceId ?? null);
  useEffect(() => { setLocalDevId(filterDeviceId ?? null); }, [filterDeviceId]);

  // master(알림) 가 off 면 sub(표시) 도 시각적으로 off + 비활성.
  const effectiveShow = !!alertEnabled && !!showFences;

  const swipe = useSwipeDownClose(onClose, { enabled: !isDesktop });

  return (
    <>
      <div style={isDesktop ? s.deskWindow : s.bottom}>
        <header style={s.header} {...swipe}>
          {!isDesktop && <div style={s.dragHandle} />}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
            <Icon name="fence" size={16} style={{ color: 'var(--primary)' }} />
            지오펜스
          </span>
          <button onClick={onClose} style={s.closeBtn} title="닫기">
            <Icon name="close" size={14} />
          </button>
        </header>

        {/* 2단 토글 — 알림(master) 가 표시(sub) 의 상위 호환 */}
        <div style={s.toggleBlock}>
          <ToggleRow
            label="펜스 알림"
            sub="진입·이탈·활성화 푸시 발송"
            value={!!alertEnabled}
            onChange={(v) => onToggleAlert?.(v)}
            primary
          />
          <ToggleRow
            label="지도 표시"
            sub={alertEnabled ? '활성 펜스를 지도에 그림' : '알림 끄면 자동으로 꺼짐'}
            value={effectiveShow}
            disabled={!alertEnabled}
            onChange={(v) => onToggleShow?.(v)}
          />
        </div>

        {/* 디바이스 필터 — 모달 안에서 자유 선택 (전역 필터와 별개) */}
        <div style={s.deviceFilter}>
          <span style={{ fontSize: 11, color: 'var(--text-3)' }}>보기 대상</span>
          <select value={localDevId ?? 'all'}
            onChange={e => setLocalDevId(e.target.value === 'all' ? null : parseInt(e.target.value, 10))}
            style={s.deviceSelect}>
            <option value="all">전체 디바이스</option>
            {devices.map(d => (
              <option key={d.id} value={d.id}>
                {d.display_name || d.device_uid}
              </option>
            ))}
          </select>
        </div>

        {/* 탭 */}
        <div style={s.tabs}>
          {[
            { id: 'list',    label: '목록' },
            { id: 'history', label: '이력' },
          ].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              ...s.tab, ...(tab === t.id ? s.tabOn : null),
            }}>
              {t.label}
            </button>
          ))}
        </div>

        <div style={s.body}>
          {tab === 'list'    && <GeofencePanel devices={devices} mapRef={mapRef}
                                                fences={fences} onChange={onChange}
                                                filterDeviceId={localDevId} />}
          {tab === 'history' && <HistoryView devices={devices} filterDeviceId={localDevId} />}
        </div>
      </div>
    </>
  );
}

function ToggleRow({ label, sub, value, disabled, onChange, primary }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '10px 14px',
      opacity: disabled ? 0.5 : 1,
      borderTop: primary ? 'none' : '1px solid var(--border)',
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: primary ? 600 : 500, color: 'var(--text)' }}>{label}</div>
        {sub && <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{sub}</div>}
      </div>
      <button onClick={() => !disabled && onChange?.(!value)}
        disabled={disabled}
        style={{
          position: 'relative', width: 40, height: 22, borderRadius: 11,
          border: 'none', padding: 0,
          cursor: disabled ? 'not-allowed' : 'pointer',
          background: value ? 'var(--primary)' : 'var(--surface-2)',
          transition: 'background .15s',
        }}>
        <span style={{
          position: 'absolute', top: 2, left: 2,
          width: 18, height: 18, borderRadius: 9,
          background: 'white',
          transform: `translateX(${value ? 18 : 0}px)`,
          transition: 'transform .15s',
        }} />
      </button>
    </div>
  );
}

function HistoryView({ devices, filterDeviceId }) {
  const [rows, setRows]     = useState(null);
  const [error, setError]   = useState(null);

  useEffect(() => {
    api.geofenceHistoryAll()
      .then(setRows)
      .catch(e => setError(e.message || '이력을 불러올 수 없습니다.'));
  }, []);

  if (error) return <div style={s.empty}>{error}</div>;
  if (rows === null) return <div style={s.empty}>로딩...</div>;

  // 필터 존중 — 선택된 디바이스의 이벤트만
  const filtered = filterDeviceId == null
    ? rows
    : rows.filter(r => r.device_id === filterDeviceId);

  if (filtered.length === 0) {
    return <div style={s.empty}>
      {filterDeviceId == null
        ? <>아직 펜스 이벤트가 없습니다.<br />펜스 진입·이탈·활성화 시 여기에 기록됩니다.</>
        : <>이 디바이스의 펜스 이벤트가 아직 없습니다.</>}
    </div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {filtered.map(r => {
        const meta = KIND_META[r.kind] || { icon: '·', label: r.kind, color: 'var(--text-2)' };
        const dev  = devices.find(d => d.id === r.device_id);
        const devName = dev?.display_name || dev?.device_uid || `device #${r.device_id}`;
        const distTxt = r.distance_m != null
          ? r.distance_m >= 1000
            ? `${(r.distance_m / 1000).toFixed(2)} km`
            : `${r.distance_m} m`
          : '';
        return (
          <div key={r.id} style={s.row}>
            <span style={{ ...s.kindIcon, color: meta.color }}>{meta.icon}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>
                {r.geofence_name || `펜스 #${r.geofence_id ?? '?'}`} <span style={{ color: meta.color, fontWeight: 500 }}>· {meta.label}</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
                {devName}{distTxt && ` · ${distTxt}`}
                {r.kind === 'geofence_armed' && r.inside !== null && (
                  <> · {r.inside ? '안에 있음' : '밖에 있음'}</>
                )}
              </div>
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
              {fmtTime(r.occurred_at)}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  if (same) return d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  // 며칠 전 — 짧게
  return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const s = {
  backdrop: {
    position: 'fixed', inset: 0,
    background: 'rgba(0,0,0,.4)',
    zIndex: 150,
  },
  // 모바일/태블릿: 화면 하단 sheet (FAB 우하단 영역은 살짝 가려지지만 한 번에 하나만 열림)
  bottom: {
    position: 'fixed', left: 0, right: 0, bottom: 0,
    maxHeight: '78vh',
    background: 'var(--surface)',
    borderTop: '1px solid var(--border)',
    borderRadius: '14px 14px 0 0',
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 -8px 24px rgba(0,0,0,.25)',
    zIndex: 11,
    paddingBottom: 'env(safe-area-inset-bottom, 0)',
    animation: 'fadeInUp .18s ease-out',
  },
  // 데스크톱: 지도 영역의 우상단 floating window — FAB 와 공존, seeker 와 동시 오픈 가능
  deskWindow: {
    position: 'absolute',
    top: 12, right: 12,
    width: 340, maxWidth: 'calc(100% - 24px)',
    maxHeight: 'calc(100% - 24px)',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    display: 'flex', flexDirection: 'column',
    boxShadow: '0 6px 24px rgba(0,0,0,.18)',
    zIndex: 11,
    animation: 'fadeInDown .18s ease-out',
  },
  header: {
    position: 'relative',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    padding: '12px 14px',
    borderBottom: '1px solid var(--border)',
    flexShrink: 0,
    touchAction: 'none',
  },
  dragHandle: {
    position: 'absolute',
    top: 6, left: '50%', transform: 'translateX(-50%)',
    width: 36, height: 4, borderRadius: 2,
    background: 'var(--text-3)', opacity: 0.35,
    pointerEvents: 'none',
  },
  closeBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    color: 'var(--text-2)',
    width: 28, height: 28, borderRadius: 6,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  toggleBlock: {
    flexShrink: 0,
    background: 'var(--surface-2)',
    borderBottom: '1px solid var(--border)',
  },
  deviceFilter: {
    flexShrink: 0,
    display: 'flex', alignItems: 'center', gap: 8,
    padding: '8px 14px',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
  },
  deviceSelect: {
    flex: 1,
    padding: '6px 8px',
    fontSize: 12, color: 'var(--text)',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)', borderRadius: 6,
    cursor: 'pointer',
  },
  tabs: {
    display: 'flex', flexShrink: 0,
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface)',
  },
  tab: {
    flex: 1, padding: '10px 12px',
    background: 'transparent', color: 'var(--text-2)',
    border: 'none', borderBottom: '2px solid transparent',
    fontSize: 12, fontWeight: 500, cursor: 'pointer',
    transition: 'color .15s, border-color .15s',
  },
  tabOn: {
    color: 'var(--primary)',
    borderBottomColor: 'var(--primary)',
    fontWeight: 600,
  },
  body: {
    flex: 1, minHeight: 0, overflowY: 'auto',
    padding: 14,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 10,
    padding: 10,
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 8,
  },
  kindIcon: {
    fontSize: 16, lineHeight: 1, flexShrink: 0, width: 18, textAlign: 'center',
  },
  empty: {
    color: 'var(--text-3)', fontSize: 12,
    padding: '24px 0', textAlign: 'center', lineHeight: 1.6,
  },
};

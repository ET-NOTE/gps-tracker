// (2026-07-28) Phase F4-b — Fleet dashboard 우측 event feed panel.
// 참고 이미지 스타일: 운행 시작/종료 · 지오펜스 진입/이탈 · 알림 색상 코딩.
//
// F4-b-1 은 스켈레톤 + 선택된 device 의 최근 이벤트 정도. Fleet-wide feed 는 backend
// 엔드포인트가 필요 (없으면 per-device polling — F4-c 에서 확장).

import { PageHeader } from '../ui';
import Icon from '../Icon';

const EVENT_META = {
  wake:                    { label: '운행 시작', icon: 'route',  color: 'var(--accent)' },
  sleep_enter:             { label: '운행 종료', icon: 'moon',   color: 'var(--text-2)' },
  geofence_enter:          { label: '지점 진입', icon: 'mapPin', color: 'var(--primary)' },
  geofence_exit:           { label: '지점 이탈', icon: 'mapPin', color: 'var(--warning)' },
  rental_ending:           { label: '반납 임박', icon: 'clock',  color: 'var(--warning)' },
  rental_overdue:          { label: '반납 연체', icon: 'warn',   color: 'var(--danger)' },
  rental_pickup_done:      { label: '차량 인수', icon: 'check',  color: 'var(--accent)' },
  rental_return_done:      { label: '차량 반납', icon: 'check',  color: 'var(--primary)' },
  rental_return_submitted: { label: '반납 제출', icon: 'check',  color: 'var(--primary)' },
};

export default function EventFeedPanel({ events, selectedDevice, loading }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--surface)', borderLeft: '1px solid var(--border)',
      height: '100%', minHeight: 0,
    }}>
      <div style={{
        padding: 'var(--space-3) var(--space-4)',
        borderBottom: '1px solid var(--border)',
      }}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>
          {selectedDevice
            ? `${selectedDevice.license_plate || selectedDevice.display_name || '#' + selectedDevice.id} 이벤트`
            : '실시간 이벤트'}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
          {selectedDevice ? '최근 20건' : '차량 선택 시 표시'}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--space-2)' }}>
        {!selectedDevice && (
          <div style={{
            padding: 'var(--space-6)', textAlign: 'center',
            color: 'var(--text-3)', fontSize: 12, lineHeight: 1.6,
          }}>
            좌측 목록에서 차량을 선택하면<br/>
            운행 시작/종료 · 지점 진입/이탈 등<br/>
            최근 이벤트가 여기 표시됩니다.
          </div>
        )}
        {selectedDevice && loading && (
          <div style={{ padding: 'var(--space-4)', color: 'var(--text-3)', fontSize: 12 }}>
            로딩...
          </div>
        )}
        {selectedDevice && !loading && events && events.length === 0 && (
          <div style={{ padding: 'var(--space-4)', color: 'var(--text-3)', fontSize: 12 }}>
            최근 이벤트 없음
          </div>
        )}
        {selectedDevice && events && events.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {events.map((ev, i) => (
              <EventRow key={ev.id || i} ev={ev} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function EventRow({ ev }) {
  const meta = EVENT_META[ev.kind] || {
    label: ev.kind, icon: 'info', color: 'var(--text-2)',
  };
  const when = new Date(ev.occurred_at);
  return (
    <div style={{
      display: 'flex', gap: 'var(--space-2)', alignItems: 'flex-start',
      padding: 'var(--space-2) var(--space-3)',
      borderLeft: `3px solid ${meta.color}`,
      background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)',
    }}>
      <div style={{
        width: 24, height: 24, borderRadius: 'var(--radius-sm)',
        background: `color-mix(in srgb, ${meta.color} 15%, transparent)`,
        color: meta.color,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        flexShrink: 0,
      }}>
        <Icon name={meta.icon} size={13} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
          {meta.label}
        </div>
        {ev.data && (ev.data.address || ev.data.geofence_name || ev.data.renter_name) && (
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ev.data.geofence_name || ev.data.renter_name || ev.data.address}
          </div>
        )}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', flexShrink: 0, textAlign: 'right' }}>
        {when.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
        <div style={{ fontSize: 9 }}>
          {when.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}
        </div>
      </div>
    </div>
  );
}

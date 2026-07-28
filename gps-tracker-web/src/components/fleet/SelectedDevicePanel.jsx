// (2026-07-28) Phase F4-b-2 — Fleet dashboard 우측 selected-device panel.
// EventFeedPanel 대체. tabbed 구조 (이벤트 | 운행 이력).
// 운행 이력 클릭 시 map 에 seeker path 재생.

import { useEffect, useState } from 'react';
import Icon from '../Icon';
import { api } from '../../api';

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

export default function SelectedDevicePanel({
  selectedDevice, events, evLoading,
  onTripSelect,     // (trip) => void — 선택된 trip 을 map 에 그림
  selectedTripKey,  // string | null — 선택된 trip 강조
}) {
  const [tab, setTab] = useState('events');   // events | trips

  if (!selectedDevice) {
    return (
      <div style={panelWrap}>
        <div style={panelHead}>
          <div style={{ fontSize: 13, fontWeight: 800 }}>실시간 이벤트</div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
            차량 선택 시 표시
          </div>
        </div>
        <div style={{
          padding: 'var(--space-6)', textAlign: 'center',
          color: 'var(--text-3)', fontSize: 12, lineHeight: 1.6,
        }}>
          좌측 목록에서 차량을 선택하면<br/>
          이벤트 · 운행 이력이 여기 표시됩니다.
        </div>
      </div>
    );
  }

  return (
    <div style={panelWrap}>
      <div style={panelHead}>
        <div style={{ fontSize: 13, fontWeight: 800, color: 'var(--text)' }}>
          {selectedDevice.license_plate || selectedDevice.display_name || `#${selectedDevice.id}`}
        </div>
        {selectedDevice.display_name && selectedDevice.license_plate && (
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
            {selectedDevice.display_name}
          </div>
        )}
      </div>
      {/* tab bar */}
      <div style={{
        display: 'flex', gap: 4, padding: '0 var(--space-3)',
        borderBottom: '1px solid var(--border)',
      }}>
        {[
          { id: 'events', label: '이벤트' },
          { id: 'trips',  label: '운행 이력' },
        ].map(t => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              style={{
                padding: '10px 12px', background: 'transparent', border: 'none',
                borderBottom: '2px solid ' + (on ? 'var(--primary)' : 'transparent'),
                color: on ? 'var(--primary)' : 'var(--text-2)',
                fontSize: 12, fontWeight: on ? 700 : 500,
                cursor: 'pointer',
              }}>{t.label}</button>
          );
        })}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--space-2)' }}>
        {tab === 'events' && (
          <EventsTab events={events} loading={evLoading} />
        )}
        {tab === 'trips' && (
          <TripsTab deviceId={selectedDevice.id} onSelect={onTripSelect} selectedKey={selectedTripKey} />
        )}
      </div>
    </div>
  );
}

function EventsTab({ events, loading }) {
  if (loading) return <div style={{ padding: 'var(--space-4)', color: 'var(--text-3)', fontSize: 12 }}>로딩...</div>;
  if (!events || events.length === 0) return <div style={{ padding: 'var(--space-4)', color: 'var(--text-3)', fontSize: 12 }}>최근 이벤트 없음</div>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {events.map((ev, i) => <EventRow key={ev.id || i} ev={ev} />)}
    </div>
  );
}

function EventRow({ ev }) {
  const meta = EVENT_META[ev.kind] || { label: ev.kind, icon: 'info', color: 'var(--text-2)' };
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
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
      }}>
        <Icon name={meta.icon} size={13} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>{meta.label}</div>
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

function TripsTab({ deviceId, onSelect, selectedKey }) {
  const [trips, setTrips] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let cancelled = false;
    setTrips(null); setError(null);
    // 최근 30일
    const now = new Date();
    const from = new Date(now.getTime() - 30 * 86400_000).toISOString();
    const to   = now.toISOString();
    api.listTrips(deviceId, { from, to }).then(ts => {
      if (cancelled) return;
      // 최신 우선.
      setTrips((ts || []).slice().sort((a, b) =>
        new Date(b.started_at) - new Date(a.started_at)));
    }).catch(e => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [deviceId]);

  if (error) return <div style={{ padding: 'var(--space-4)', color: 'var(--danger)', fontSize: 12 }}>{error}</div>;
  if (!trips) return <div style={{ padding: 'var(--space-4)', color: 'var(--text-3)', fontSize: 12 }}>로딩...</div>;
  if (trips.length === 0) return <div style={{ padding: 'var(--space-4)', color: 'var(--text-3)', fontSize: 12 }}>최근 30일 운행 없음</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {trips.map((t, i) => {
        const key = t.started_at;
        const sel = key === selectedKey;
        const start = new Date(t.started_at);
        const end = t.ended_at ? new Date(t.ended_at) : null;
        const km = ((t.distance_m || 0) / 1000).toFixed(1);
        return (
          <button key={key} onClick={() => onSelect?.(t)}
            style={{
              display: 'flex', flexDirection: 'column', gap: 3,
              padding: 'var(--space-2) var(--space-3)',
              background: sel
                ? 'color-mix(in srgb, var(--primary) 12%, var(--surface-2))'
                : 'var(--surface-2)',
              border: '1px solid ' + (sel ? 'var(--primary)' : 'transparent'),
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer', textAlign: 'left', font: 'inherit',
            }}>
            <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
              <span style={{ fontSize: 12, fontWeight: 800, color: 'var(--text)' }}>
                {start.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })}
                {' '}
                {start.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
              </span>
              {end && (
                <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  ~ {end.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}
                </span>
              )}
              <span style={{ marginLeft: 'auto', fontSize: 11, fontWeight: 700, color: 'var(--primary)' }}>
                {km} km
              </span>
            </div>
            {(t.start_address || t.end_address) && (
              <div style={{ fontSize: 10, color: 'var(--text-3)',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {(t.start_address || '?').slice(0, 20)}
                {' → '}
                {(t.end_address || '?').slice(0, 20)}
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

const panelWrap = {
  display: 'flex', flexDirection: 'column',
  background: 'var(--surface)', borderLeft: '1px solid var(--border)',
  height: '100%', minHeight: 0,
};
const panelHead = {
  padding: 'var(--space-3) var(--space-4)',
  borderBottom: '1px solid var(--border)',
};

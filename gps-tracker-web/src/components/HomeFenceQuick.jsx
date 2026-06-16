// 홈 탭 — 지오펜스 가장자리 레이어 (지도 가림 최소).
//
// 패널 형식 (운행 탭) 의 풀 기능 (알람 토글 / 이력 탭) 은 빼고, 가장자리만 사용:
//   ┌────────────────────────────┐
//   │ [DeviceFilter]   [+ 펜스] │ ← 우상단 = 새로 만들기 (popover)
//   │                            │
//   │                            │
//   │ ┌─ 등록된 펜스 ─┐          │
//   │ │ ● 우리집  안   │          │ ← 좌하단 max 영역 vertical scroll
//   │ │ ● 회사   밖   │          │
//   │ │ ● 학교   안   │          │
//   │ │ ...           │          │
//   │ └───────────────┘          │
//   │                            │
//   └────────────────────────────┘
//
// 장치 필터 = 홈 DeviceFilter 의 filterDeviceId 그대로 사용 — 별도 select 안 만듦.
import { useState, useEffect } from 'react';
import { api } from '../api';
import Icon from './Icon';

// haversine — 디바이스/펜스 거리 (GeofencePanel 과 동일)
function haversineM(la1, lo1, la2, lo2) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa/2)**2 + Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLo/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function isAnyInside(fence, devices) {
  const targets = fence.device_id
    ? devices.filter(d => d.id === fence.device_id)
    : devices;
  return targets.some(d => {
    if (d.last_lat == null || d.last_lng == null) return false;
    return haversineM(d.last_lat, d.last_lng, fence.center_lat, fence.center_lng) <= fence.radius_m;
  });
}

export default function HomeFenceQuick({
  devices, mapRef, fences = [], onChange,
  filterDeviceId = null,
  bottomLift = 0,   // 간이 시커 활성 시 시간 strip 높이만큼 위로 — FenceList 용
  fabBottom = 16,   // 우하단 FAB 칼럼의 기준 bottom — Dashboard 가 계산해서 넘김 (strip + tooltip lift 포함)
  enabled = true,   // 펜스 토글 (= Dashboard 의 showFences) — false 면 토글 FAB 만 노출.
  onToggleEnabled,  // (v) => void
  listSide = 'left',   // 'left' (모바일 기본, 좌하단) | 'right' (PC, FAB 칼럼 왼쪽 우하단)
}) {
  // 홈 DeviceFilter 의 선택을 따름 — 전체면 모든 펜스, 디바이스면 해당 펜스+전체 펜스
  const list = filterDeviceId == null
    ? fences
    : fences.filter(f => f.device_id == null || f.device_id === filterDeviceId);

  return (
    <>
      {/* 펜스 ON/OFF 토글 — 우하단 FAB 칼럼 (기존 geofence FAB 자리, baseBottom + 0). */}
      <FenceToggle
        on={enabled}
        onClick={() => onToggleEnabled?.(!enabled)}
        count={list.length}
        fabBottom={fabBottom}
      />
      {enabled && (
        <>
          <FenceCreator
            mapRef={mapRef}
            filterDeviceId={filterDeviceId}
            onCreated={onChange}
            fabBottom={fabBottom}
          />
          <FenceList
            fences={list}
            devices={devices}
            mapRef={mapRef}
            onChange={onChange}
            bottomLift={bottomLift}
            side={listSide}
          />
        </>
      )}
    </>
  );
}

// ────────────────────────────────────────────────────────────
// 우하단 FAB 칼럼 — geofence 가 운행 탭으로 이전하면서 비워진 자리에 ON/OFF 토글.
// 기존 FAB (trackLive +180, miniSeeker +60) 와 같은 column. 토글 = 가장 아래 (+0).
// ────────────────────────────────────────────────────────────
function FenceToggle({ on, onClick, count, fabBottom }) {
  return (
    <button onClick={onClick}
      title={on ? '펜스 끄기' : '펜스 켜기'}
      className="btn-bounce"
      style={{
        ...ts.btn,
        bottom: fabBottom,
        background: on ? 'var(--primary)' : 'var(--surface)',
        color: on ? 'var(--primary-fg, white)' : 'var(--primary)',
        border: on ? 'none' : '1px solid var(--border)',
      }}>
      <Icon name="fence" size={20} />
      {on && count > 0 && <span style={ts.badge}>{count}</span>}
    </button>
  );
}
const ts = {
  // 기존 FAB 와 동일 사이즈 (48x48 원형) — trackLive/miniSeeker 와 통일.
  btn: {
    position: 'absolute', right: 16,
    width: 48, height: 48, borderRadius: 24,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3,
    fontSize: 11, fontWeight: 700, cursor: 'pointer',
    boxShadow: '0 4px 12px rgba(0,0,0,.25)',
    zIndex: 12,
    transition: 'background .15s, color .15s, bottom .22s ease',
  },
  badge: {
    position: 'absolute',
    top: -4, right: -4,
    minWidth: 18, height: 18, padding: '0 4px',
    borderRadius: 9,
    background: 'var(--accent)', color: 'white',
    fontSize: 10, lineHeight: '18px', fontWeight: 700,
    fontVariantNumeric: 'tabular-nums',
    boxShadow: '0 1px 3px rgba(0,0,0,.3)',
    textAlign: 'center',
  },
};

// ────────────────────────────────────────────────────────────
// 우하단 FAB 칼럼 — 새 펜스 만들기. 토글 ON 일 때만 노출 (slot = fabBottom + 120,
// 즉 기존 panel-seeker FAB 자리). 열림: 좌측 popover 카드 (FAB 칼럼 왼쪽).
// ────────────────────────────────────────────────────────────
function FenceCreator({ mapRef, filterDeviceId, onCreated, fabBottom }) {
  const [open, setOpen] = useState(false);
  const [name, setName]     = useState('');
  const [radius, setRadius] = useState(200);
  const [busy, setBusy]     = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [pickedCenter, setPickedCenter] = useState(null);

  function reset() {
    setName(''); setRadius(200);
    setSearchQuery(''); setSearchResults([]); setPickedCenter(null);
  }
  function closeAndReset() {
    setOpen(false); reset();
  }

  function doSearch() {
    if (!searchQuery.trim()) return;
    if (!window.kakao?.maps?.services) {
      alert('카카오 지도 서비스가 아직 로드되지 않았습니다.');
      return;
    }
    setSearchBusy(true); setSearchResults([]);
    const geo = new window.kakao.maps.services.Geocoder();
    geo.addressSearch(searchQuery, (result, status) => {
      if (status === window.kakao.maps.services.Status.OK && result.length > 0) {
        setSearchResults(result.map(r => ({
          label: r.road_address?.address_name || r.address?.address_name || searchQuery,
          sub:   r.road_address?.building_name || r.address?.address_name || '',
          lat:   parseFloat(r.y),
          lng:   parseFloat(r.x),
        })));
        setSearchBusy(false);
      } else {
        const places = new window.kakao.maps.services.Places();
        places.keywordSearch(searchQuery, (kw, kwStatus) => {
          setSearchBusy(false);
          if (kwStatus === window.kakao.maps.services.Status.OK && kw.length > 0) {
            setSearchResults(kw.slice(0, 6).map(p => ({
              label: p.place_name,
              sub:   p.road_address_name || p.address_name || '',
              lat:   parseFloat(p.y),
              lng:   parseFloat(p.x),
            })));
          } else {
            setSearchResults([]);
            alert('검색 결과 없음');
          }
        });
      }
    });
  }
  function pickResult(r) {
    setPickedCenter({ lat: r.lat, lng: r.lng, label: r.label });
    setSearchResults([]); setSearchQuery('');
    mapRef.current?.panToCoord(r.lat, r.lng);
  }

  async function handleCreate() {
    const center = pickedCenter || mapRef.current?.getCurrentCenter();
    if (!center) { alert('펜스 중심을 결정할 수 없습니다.'); return; }
    if (!name.trim()) { alert('이름을 입력하세요.'); return; }
    setBusy(true);
    try {
      await api.createGeofence({
        name:       name.trim(),
        center_lat: center.lat,
        center_lng: center.lng,
        radius_m:   parseInt(radius, 10),
        // 홈 DeviceFilter 선택 그대로 — 전체면 모든 디바이스 적용 (null).
        // 더 정교한 적용은 운행 탭에서 편집.
        device_id:  filterDeviceId ?? null,
      });
      closeAndReset();
      await onCreated?.();
    } catch (e) {
      alert(e.message || '생성 실패');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)}
        className="btn-bounce"
        style={{ ...cs.fab, bottom: fabBottom + 60 }}
        title="새 지오펜스">
        <Icon name="plus" size={20} />
      </button>
    );
  }

  return (
    <div style={{ ...cs.popover, bottom: fabBottom + 16 }}>
      <div style={cs.popHeader}>
        <span style={cs.popTitle}>새 펜스</span>
        <button onClick={closeAndReset} style={cs.popClose} title="취소">
          <Icon name="close" size={12} />
        </button>
      </div>

      <input placeholder="이름 (예: 집)" value={name}
        onChange={e => setName(e.target.value)} style={cs.input} />

      <div style={{ display: 'flex', gap: 4 }}>
        <input placeholder="주소/장소 검색" value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doSearch()}
          style={{ ...cs.input, flex: 1, marginTop: 0 }} />
        <button onClick={doSearch} disabled={searchBusy} style={cs.searchBtn}>
          {searchBusy ? '...' : '검색'}
        </button>
      </div>

      {searchResults.length > 0 && (
        <div style={cs.searchMenu}>
          {searchResults.map((r, i) => (
            <button key={i} onClick={() => pickResult(r)} style={cs.searchItem}>
              <div style={cs.searchItemMain}>{r.label}</div>
              {r.sub && <div style={cs.searchItemSub}>{r.sub}</div>}
            </button>
          ))}
        </div>
      )}

      <div style={cs.centerHint}>
        {pickedCenter
          ? <>중심: <b>{pickedCenter.label}</b><button onClick={() => setPickedCenter(null)} style={cs.unpickBtn}>× 해제</button></>
          : '검색 안 하면 지도 중심 사용'}
      </div>

      <div style={cs.radiusRow}>
        <span style={cs.radiusLabel}>반경(m)</span>
        <input type="number" value={radius}
          onChange={e => setRadius(e.target.value)}
          style={{ ...cs.input, marginTop: 0, width: 84 }} />
      </div>

      <button onClick={handleCreate} disabled={busy}
        className="btn-bounce"
        style={cs.createBtn}>
        {busy ? '생성 중...' : '생성'}
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// 좌하단 — 등록된 펜스 vertical scroll list.
// 행: dot · 이름 · 안/밖 배지 · toggle · 삭제. 한 줄.
// ────────────────────────────────────────────────────────────
function FenceList({ fences, devices, mapRef, onChange, bottomLift, side = 'left' }) {
  const [, force] = useState(0);   // 디바이스 위치 갱신 시 안/밖 재계산용
  useEffect(() => { force(x => x + 1); }, [devices]);

  if (fences.length === 0) return null;

  function focus(f) { mapRef.current?.panToCoord(f.center_lat, f.center_lng); }
  async function toggle(f) {
    try { await api.updateGeofence(f.id, { active: !f.active }); await onChange?.(); }
    catch (e) { alert(e.message); }
  }
  async function remove(f) {
    if (!confirm(`'${f.name}' 펜스를 삭제할까요?`)) return;
    try {
      await api.deleteGeofence(f.id);
      mapRef.current?.removeGeofence(f.id);
      await onChange?.();
    } catch (e) { alert(e.message); }
  }

  // side=='left' (모바일): 좌하단. 간이 시커 활성 시 DateBox 와 충돌 회피 차 left:116.
  // side=='right' (PC): 우하단, FAB 칼럼 (right:16, width:48) 왼쪽 → right:76.
  // 바텀 라인 = 8px 갭 → DateBox / 컴팩트 툴팁 (둘 다 `+ 8px`) 과 정렬.
  const dateBoxPresent = bottomLift > 0;
  const positionStyle = side === 'right'
    ? { right: 76, bottom: `calc(${bottomLift}px + 8px)`,
        maxHeight: dateBoxPresent ? 'calc(100% - 300px)' : 'calc(100% - 220px)' }
    : { left: dateBoxPresent ? 116 : 8, bottom: `calc(${bottomLift}px + 8px)`,
        maxHeight: dateBoxPresent ? 'calc(100% - 300px)' : 'calc(100% - 220px)' };
  return (
    <div style={{ ...ls.wrap, ...positionStyle }}>
      <div style={ls.head}>
        <Icon name="fence" size={11} style={{ color: 'var(--text-3)' }} />
        <span>펜스 ({fences.length})</span>
      </div>
      <div style={ls.scroll}>
        {fences.map(f => {
          const inside = isAnyInside(f, devices);
          const dot = f.active ? (inside ? '#EF4444' : '#10B981') : 'var(--text-3)';
          return (
            <div key={f.id}
              className="fade-color"
              style={{ ...ls.row, opacity: f.active ? 1 : 0.55 }}>
              <button onClick={() => focus(f)}
                className="btn-bounce btn-hover-bg"
                style={ls.rowMain} title="펜스로 이동">
                <span style={{ ...ls.dot, background: dot }} />
                <span style={ls.name}>{f.name}</span>
                {f.active && (
                  <span style={{ ...ls.badge, color: inside ? '#EF4444' : '#10B981' }}>
                    {inside ? '안' : '밖'}
                  </span>
                )}
              </button>
              <button onClick={() => toggle(f)}
                className="btn-bounce btn-hover-bg"
                style={ls.iconBtn}
                title={f.active ? '비활성화' : '활성화'}>
                {f.active ? '●' : '○'}
              </button>
              <button onClick={() => remove(f)}
                className="btn-bounce btn-hover-bg"
                style={{ ...ls.iconBtn, color: 'var(--danger)' }}
                title="삭제">
                <Icon name="trash2" size={11} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════
// 스타일
// ════════════════════════════════════════════════════════════
const cs = {  // creator
  // 닫혀있는 FAB — 우상단 (DeviceFilter 와 같은 라인은 아니고 그 아래 약간 우측).
  // top:12 right:12 로 두면 페어링 모달 헤더 영역과 겹칠 수 있어 top:14, right:12 로.
  fab: {
    // fence cluster — toggle (+0) 바로 위 슬롯 (+60). 같은 primary 컬러로 페어 시각 통일.
    position: 'absolute', right: 16,
    width: 48, height: 48, borderRadius: 24,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--surface)', color: 'var(--primary)',
    border: '1px solid var(--primary)',
    boxShadow: '0 4px 12px rgba(0,0,0,.25)',
    cursor: 'pointer',
    zIndex: 12,
    transition: 'background .15s, color .15s, bottom .22s ease',
    animation: 'fadeInUp .22s ease-out',  // 토글 ON → "+" 가 토글 위로 부드럽게 슬라이드 인
  },
  popover: {
    // FAB 칼럼 (right:16, width:48) 왼쪽으로 — right:76. bottom 은 fabBottom+16 (FAB 칼럼 하단 정렬).
    position: 'absolute', right: 76,
    width: 260, maxWidth: 'calc(100vw - 92px)',
    zIndex: 13,
    padding: 10,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    boxShadow: '0 4px 16px rgba(0,0,0,.2)',
    display: 'flex', flexDirection: 'column', gap: 6,
    animation: 'fadeInDown .15s ease-out',
  },
  popHeader: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
  },
  popTitle: {
    fontSize: 12, fontWeight: 700, color: 'var(--text)',
  },
  popClose: {
    width: 22, height: 22, borderRadius: 11,
    background: 'transparent', color: 'var(--text-3)',
    border: '1px solid var(--border)', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  input: {
    display: 'block', width: '100%',
    padding: '6px 8px',
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 5,
    color: 'var(--text)', fontSize: 11,
    boxSizing: 'border-box',
    marginTop: 2,
  },
  searchBtn: {
    padding: '0 10px',
    background: 'var(--surface-2)', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 5,
    fontSize: 11, cursor: 'pointer',
    flexShrink: 0,
  },
  searchMenu: {
    maxHeight: 140, overflowY: 'auto',
    border: '1px solid var(--border)', borderRadius: 6,
    background: 'var(--surface-2)',
  },
  searchItem: {
    display: 'block', width: '100%',
    padding: '6px 8px', textAlign: 'left',
    background: 'transparent', color: 'var(--text)',
    border: 'none', borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
  },
  searchItemMain: { fontSize: 11, fontWeight: 500, color: 'var(--text)' },
  searchItemSub:  { fontSize: 10, color: 'var(--text-3)', marginTop: 2 },
  centerHint: {
    fontSize: 10, color: 'var(--text-3)',
    display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap',
  },
  unpickBtn: {
    marginLeft: 4,
    background: 'transparent', border: 'none', color: 'var(--text-3)',
    cursor: 'pointer', fontSize: 10, padding: 0,
  },
  radiusRow: {
    display: 'flex', alignItems: 'center', gap: 6,
  },
  radiusLabel: { fontSize: 11, color: 'var(--text-2)' },
  createBtn: {
    width: '100%', padding: '8px 10px',
    background: 'var(--primary)', color: 'var(--primary-fg, white)',
    border: 'none', borderRadius: 6,
    fontSize: 12, fontWeight: 600, cursor: 'pointer',
  },
};

const ls = {  // list — left/right/bottom/maxHeight 은 side 별로 inline 으로 주입.
  wrap: {
    position: 'absolute',
    width: 156,
    minHeight: 60,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    boxShadow: '0 2px 8px rgba(0,0,0,.18)',
    zIndex: 6,
    display: 'flex', flexDirection: 'column',
    pointerEvents: 'auto',
    animation: 'fadeInUp .15s ease-out',
  },
  head: {
    flexShrink: 0,
    display: 'flex', alignItems: 'center', gap: 4,
    padding: '5px 8px',
    fontSize: 10, fontWeight: 700, color: 'var(--text-3)',
    borderBottom: '1px solid var(--border)',
    background: 'var(--surface-2)',
    borderTopLeftRadius: 8, borderTopRightRadius: 8,
    letterSpacing: '.04em',
  },
  scroll: {
    flex: 1, minHeight: 0,
    overflowY: 'auto',
    display: 'flex', flexDirection: 'column',
    padding: 4,
    gap: 2,
  },
  row: {
    display: 'flex', alignItems: 'center', gap: 2,
    padding: '2px 4px',
    borderRadius: 5,
    minHeight: 28,
  },
  rowMain: {
    flex: 1, minWidth: 0,
    display: 'flex', alignItems: 'center', gap: 5,
    background: 'transparent', border: 'none',
    cursor: 'pointer', padding: '2px 0',
    textAlign: 'left',
  },
  dot: {
    width: 6, height: 6, borderRadius: 3,
    flexShrink: 0,
  },
  name: {
    flex: 1, minWidth: 0,
    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    fontSize: 11, fontWeight: 600, color: 'var(--text)',
  },
  badge: {
    flexShrink: 0,
    fontSize: 9, fontWeight: 600,
  },
  iconBtn: {
    width: 22, height: 22, borderRadius: 11,
    background: 'transparent', color: 'var(--text-3)',
    border: 'none', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 12, flexShrink: 0,
  },
};

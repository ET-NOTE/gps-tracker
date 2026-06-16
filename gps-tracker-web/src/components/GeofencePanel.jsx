import { useState } from 'react';
import { api } from '../api';
import Icon from './Icon';

// haversine — 펜스/디바이스 거리 계산용 (서버 로직과 동일)
function haversineM(la1, lo1, la2, lo2) {
  const R = 6371000, r = Math.PI / 180;
  const dLa = (la2 - la1) * r, dLo = (lo2 - lo1) * r;
  const a = Math.sin(dLa/2)**2 + Math.cos(la1*r)*Math.cos(la2*r)*Math.sin(dLo/2)**2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// 한 펜스에 대해 적용 디바이스 중 한 대라도 안에 있으면 true
function isAnyInside(fence, devices) {
  const targets = fence.device_id
    ? devices.filter(d => d.id === fence.device_id)
    : devices;
  return targets.some(d => {
    if (d.last_lat == null || d.last_lng == null) return false;
    return haversineM(d.last_lat, d.last_lng, fence.center_lat, fence.center_lng) <= fence.radius_m;
  });
}

// fences: Dashboard 가 관리. onChange() 호출로 Dashboard 가 다시 fetch.
// 그리기 자체는 Dashboard 의 useEffect 가 담당 (시트 마운트 여부 무관).
// filterDeviceId: 홈 탭에서 선택된 디바이스 — null=전체. 목록·기본값 모두 영향.
export default function GeofencePanel({ devices, mapRef, fences = [], onChange, filterDeviceId = null }) {
  const [creating, setCreating] = useState(false);
  const [name, setName]     = useState('');
  const [radius, setRadius] = useState(200);
  const [deviceId, setDeviceId] = useState(filterDeviceId ? String(filterDeviceId) : 'all');
  const [busy, setBusy]     = useState(false);

  // 주소 검색
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchBusy, setSearchBusy] = useState(false);
  const [pickedCenter, setPickedCenter] = useState(null);  // { lat, lng, label }

  const refresh = () => onChange?.();
  // 필터 존중: 선택된 디바이스에 적용되는 펜스 + '전체 디바이스' 펜스만
  const list = filterDeviceId == null
    ? fences
    : fences.filter(f => f.device_id == null || f.device_id === filterDeviceId);

  // ─── 주소/장소 검색 (Kakao SDK services) ─────────────────────
  function doSearch() {
    if (!searchQuery.trim()) return;
    if (!window.kakao?.maps?.services) {
      alert('카카오 지도 서비스가 아직 로드되지 않았습니다.');
      return;
    }
    setSearchBusy(true);
    setSearchResults([]);
    const geo = new window.kakao.maps.services.Geocoder();
    geo.addressSearch(searchQuery, (result, status) => {
      if (status === window.kakao.maps.services.Status.OK && result.length > 0) {
        setSearchResults(result.map(r => ({
          label:   r.road_address?.address_name || r.address?.address_name || searchQuery,
          sub:     r.road_address?.building_name || r.address?.address_name || '',
          lat:     parseFloat(r.y),
          lng:     parseFloat(r.x),
        })));
        setSearchBusy(false);
      } else {
        // 주소 검색 실패 → 키워드(장소) 검색으로 폴백
        const places = new window.kakao.maps.services.Places();
        places.keywordSearch(searchQuery, (kw, kwStatus) => {
          setSearchBusy(false);
          if (kwStatus === window.kakao.maps.services.Status.OK && kw.length > 0) {
            setSearchResults(kw.slice(0, 8).map(p => ({
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
    setSearchResults([]);
    setSearchQuery('');
    mapRef.current?.panToCoord(r.lat, r.lng);
  }

  async function handleCreate() {
    const center = pickedCenter || mapRef.current?.getCurrentCenter();
    if (!center) { alert('펜스 중심 위치를 정할 수 없습니다.'); return; }
    if (!name.trim()) { alert('이름을 입력하세요.'); return; }
    setBusy(true);
    try {
      await api.createGeofence({
        name:       name.trim(),
        center_lat: center.lat,
        center_lng: center.lng,
        radius_m:   parseInt(radius, 10),
        device_id:  deviceId === 'all' ? null : parseInt(deviceId, 10),
      });
      setCreating(false);
      setName(''); setRadius(200); setDeviceId('all');
      setPickedCenter(null);
      await refresh();
    } catch (e) { alert(e.message); }
    finally { setBusy(false); }
  }

  async function handleToggle(f) {
    try {
      await api.updateGeofence(f.id, { active: !f.active });
      await refresh();
    } catch (e) { alert(e.message); }
  }

  async function handleDelete(id) {
    if (!confirm('지오펜스를 삭제할까요?')) return;
    try {
      await api.deleteGeofence(id);
      mapRef.current?.removeGeofence(id);
      await refresh();
    } catch (e) { alert(e.message); }
  }

  function focusFence(f) {
    mapRef.current?.panToCoord(f.center_lat, f.center_lng);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* 신규 생성 폼 */}
      <div style={s.card}>
        <div style={s.cardTitle}>새 지오펜스</div>
        {!creating ? (
          <button onClick={() => setCreating(true)} style={s.btn}>
            <Icon name="plus" size={14} /> 만들기
          </button>
        ) : (
          <>
            {/* 이름 */}
            <input placeholder="이름 (예: 집)" value={name}
              onChange={e => setName(e.target.value)} style={s.input} />

            {/* 주소/장소 검색 */}
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4 }}>
                위치 검색 (도로명/지번/장소명)
              </div>
              <div style={{ display: 'flex', gap: 4 }}>
                <input placeholder="예: 강남대로 100, 익산 터미널"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && doSearch()}
                  style={{ ...s.input, flex: 1 }} />
                <button onClick={doSearch} disabled={searchBusy}
                  style={{ ...s.btnSecondary, width: 'auto', padding: '0 14px' }}>
                  {searchBusy ? '...' : '검색'}
                </button>
              </div>
              {searchResults.length > 0 && (
                <div style={s.searchMenu}>
                  {searchResults.map((r, i) => (
                    <button key={i} onClick={() => pickResult(r)} style={s.searchItem}>
                      <div style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500 }}>{r.label}</div>
                      {r.sub && <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>{r.sub}</div>}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                {pickedCenter
                  ? <>선택됨: <b style={{ color: 'var(--text-2)' }}>{pickedCenter.label}</b></>
                  : '검색 결과를 고르거나, 지도 중심을 그대로 사용합니다.'}
                {pickedCenter && (
                  <button onClick={() => setPickedCenter(null)}
                    style={{ marginLeft: 6, background: 'none', border: 'none', color: 'var(--text-3)', cursor: 'pointer', fontSize: 11 }}>
                    × 해제
                  </button>
                )}
              </div>
            </div>

            {/* 반경 */}
            <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>반경(m)</span>
              <input type="number" value={radius}
                onChange={e => setRadius(e.target.value)}
                style={{ ...s.input, width: 100 }} />
            </div>

            {/* 적용 디바이스 */}
            <select value={deviceId} onChange={e => setDeviceId(e.target.value)}
              style={{ ...s.input, marginTop: 6 }}>
              <option value="all">모든 디바이스</option>
              {devices.map(d => (
                <option key={d.id} value={d.id}>{d.display_name || d.device_uid}</option>
              ))}
            </select>

            <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
              <button onClick={handleCreate} disabled={busy} style={{ ...s.btn, flex: 1 }}>
                {busy ? '...' : '생성'}
              </button>
              <button onClick={() => {
                setCreating(false); setSearchResults([]); setPickedCenter(null);
              }} style={{ ...s.btnSecondary, flex: 1 }}>취소</button>
            </div>
          </>
        )}
      </div>

      {/* 기존 목록 */}
      <div style={s.cardTitle}>등록된 펜스 ({list.length})</div>
      {list.length === 0 && (
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>아직 펜스가 없습니다.</div>
      )}
      {list.map(f => {
        const inside = isAnyInside(f, devices);
        return (
          <div key={f.id} style={{ ...s.card, opacity: f.active ? 1 : 0.55 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0, cursor: 'pointer' }} onClick={() => focusFence(f)}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 4,
                    background: f.active ? (inside ? '#EF4444' : '#10B981') : 'var(--text-3)',
                  }} />
                  <span style={{ fontWeight: 600, fontSize: 13 }}>{f.name}</span>
                  {f.active && (
                    <span style={{
                      fontSize: 10, fontWeight: 500,
                      color: inside ? '#EF4444' : '#10B981',
                    }}>
                      {inside ? '안' : '밖'}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 2 }}>
                  반경 {f.radius_m}m · {f.device_id
                    ? (devices.find(d => d.id === f.device_id)?.display_name || `device #${f.device_id}`)
                    : '모든 디바이스'}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
                <button onClick={() => handleToggle(f)} style={{
                  ...s.tinyBtn,
                  color: f.active ? 'var(--primary)' : 'var(--text-3)',
                }} title={f.active ? '비활성화' : '활성화'}>
                  {f.active ? '●' : '○'}
                </button>
                <button onClick={() => handleDelete(f.id)}
                  style={{ ...s.tinyBtn, color: 'var(--danger)' }} title="삭제">
                  <Icon name="trash2" size={14} />
                </button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const s = {
  card: {
    background: 'var(--surface-2)',
    border: '1px solid var(--border)',
    borderRadius: 8, padding: 10,
  },
  cardTitle: {
    fontWeight: 700, fontSize: 11, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '0.04em',
  },
  input: {
    display: 'block', width: '100%', padding: '7px 9px',
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', fontSize: 12,
    boxSizing: 'border-box',
  },
  btn: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    width: '100%', padding: '8px 10px',
    background: 'var(--primary)', color: 'var(--primary-fg)',
    border: 'none', borderRadius: 6,
    fontWeight: 600, fontSize: 12, cursor: 'pointer',
  },
  btnSecondary: {
    width: '100%', padding: '8px 10px',
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 12, cursor: 'pointer',
  },
  tinyBtn: {
    background: 'transparent', border: 'none', cursor: 'pointer',
    width: 26, height: 26, borderRadius: 6,
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14,
  },
  searchMenu: {
    marginTop: 6,
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    overflow: 'hidden',
    maxHeight: 220,
    overflowY: 'auto',
  },
  searchItem: {
    display: 'block', width: '100%',
    padding: '8px 10px', textAlign: 'left',
    background: 'transparent', color: 'var(--text)',
    border: 'none', borderBottom: '1px solid var(--border)',
    cursor: 'pointer',
  },
};

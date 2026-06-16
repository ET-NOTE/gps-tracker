// 법인차 운영 패널 — 4개 서브탭: 회사정보 / 직원 / 운행 리포트 / 구독.
// 운행 리포트는 디바이스 + 날짜 범위 선택 → 운행 목록 + 주석 편집 + 인쇄.
//
// 인쇄: 브라우저 window.print() 호출. @media print 로 nav/사이드 다 숨기고 리포트만.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import Icon from './Icon';
import { confirmDialog, alertDialog } from './Dialog';

const PURPOSE_LABEL = {
  commute:     '출퇴근',
  business:    '업무',
  other:       '기타',
  unspecified: '미지정',
};

export default function CorporatePanel({ devices }) {
  const [tab, setTab] = useState(() => localStorage.getItem('corporate_tab') || 'report');
  const setTabPersist = (t) => { setTab(t); try { localStorage.setItem('corporate_tab', t); } catch {} };

  const [sub, setSub] = useState(null);

  useEffect(() => {
    api.getCorporateSubscription().then(setSub).catch(() => {});
  }, []);

  const tabs = [
    { id: 'report', label: '운행 리포트', icon: 'route' },
    { id: 'staff',  label: '직원',       icon: 'user' },
    { id: 'info',   label: '회사 정보',   icon: 'list' },
    { id: 'sub',    label: '구독',       icon: 'coin' },
  ];

  return (
    <div style={st.wrap}>
      <div style={st.tabBar} className="no-print">
        {tabs.map(t => {
          const on = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTabPersist(t.id)}
              style={{
                ...st.tabBtn,
                color: on ? 'var(--primary)' : 'var(--text-2)',
                background: on ? 'var(--surface-2)' : 'transparent',
                fontWeight: on ? 700 : 500,
                borderBottom: on ? '2px solid var(--primary)' : '2px solid transparent',
              }}>
              <Icon name={t.icon} size={14} />
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={st.body}>
        {tab === 'report' && <ReportTab devices={devices} sub={sub} onSubChange={setSub} />}
        {tab === 'staff'  && <StaffTab />}
        {tab === 'info'   && <InfoTab />}
        {tab === 'sub'    && <SubTab sub={sub} onChange={setSub} />}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 회사 정보
// ════════════════════════════════════════════════════════
function InfoTab() {
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.getCorporateInfo().then(setInfo).catch(() => {}); }, []);

  async function save() {
    setBusy(true);
    try {
      const r = await api.putCorporateInfo({
        business_number: info.business_number || null,
        company_name:    info.company_name    || null,
        address:         info.address         || null,
        representative:  info.representative   || null,
      });
      setInfo(r);
      await alertDialog({ title: '저장 완료', tone: 'success', body: '리포트 헤더에 반영됩니다.' });
    } catch (e) { await alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' }); }
    finally { setBusy(false); }
  }

  if (!info) return <div style={st.muted}>로딩...</div>;
  const set = (k, v) => setInfo(prev => ({ ...prev, [k]: v }));

  return (
    <Card title="회사 정보 (리포트 헤더용)">
      <Field label="사업자번호" value={info.business_number || ''} placeholder="000-00-00000"
        onChange={v => set('business_number', v)} />
      <Field label="회사명"     value={info.company_name || ''}    placeholder="○○ 주식회사"
        onChange={v => set('company_name', v)} />
      <Field label="대표자"     value={info.representative || ''}  placeholder="홍길동"
        onChange={v => set('representative', v)} />
      <Field label="주소"       value={info.address || ''}          placeholder="서울특별시 ..."
        onChange={v => set('address', v)} />
      <button onClick={save} disabled={busy}
        style={{ ...st.btnPrimary, marginTop: 8 }}>
        {busy ? '저장 중...' : '저장'}
      </button>
    </Card>
  );
}

// ════════════════════════════════════════════════════════
// 직원
// ════════════════════════════════════════════════════════
function StaffTab() {
  const [list, setList] = useState(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    try { setList(await api.listStaff()); } catch {}
  }
  useEffect(() => { load(); }, []);

  async function add() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await api.createStaff({ name: name.trim(), role: role || null, phone: phone || null });
      setName(''); setRole(''); setPhone('');
      load();
    } catch (e) { await alertDialog({ title: '실패', body: e.message, tone: 'danger' }); }
    finally { setBusy(false); }
  }

  async function toggle(s) {
    try {
      await api.updateStaff(s.id, { name: s.name, role: s.role, phone: s.phone, active: !s.active });
      load();
    } catch (e) { await alertDialog({ title: '실패', body: e.message, tone: 'danger' }); }
  }

  async function remove(s) {
    const ok = await confirmDialog({
      title: '직원 비활성화',
      body: `${s.name} — 비활성화 합니다. 과거 운행일지 기록은 유지됩니다.`,
      danger: true,
    });
    if (!ok) return;
    try { await api.removeStaff(s.id); load(); }
    catch (e) { await alertDialog({ title: '실패', body: e.message, tone: 'danger' }); }
  }

  if (!list) return <div style={st.muted}>로딩...</div>;

  return (
    <>
      <Card title="직원 추가">
        <Field label="이름" value={name} onChange={setName} placeholder="이름" />
        <Field label="역할" value={role} onChange={setRole} placeholder="영업 / 사무 / 배차 ..." />
        <Field label="연락처" value={phone} onChange={setPhone} placeholder="010-..." />
        <button onClick={add} disabled={busy || !name.trim()}
          style={{ ...st.btnPrimary, marginTop: 8 }}>
          {busy ? '...' : '추가'}
        </button>
      </Card>

      <Card title={`직원 목록 (${list.filter(s => s.active).length}명)`}>
        {list.length === 0 && <div style={st.muted}>아직 등록된 직원이 없습니다.</div>}
        {list.map(s => (
          <div key={s.id} style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 0', borderBottom: '1px solid var(--border)',
            opacity: s.active ? 1 : 0.5,
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{s.name}</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {s.role ? `${s.role} · ` : ''}{s.phone || '연락처 없음'}
              </div>
            </div>
            <button onClick={() => toggle(s)} style={st.btnGhost}>
              {s.active ? '비활성' : '활성'}
            </button>
            {s.active && (
              <button onClick={() => remove(s)} style={{ ...st.btnGhost, color: 'var(--danger)' }}>
                <Icon name="trash2" size={12} />
              </button>
            )}
          </div>
        ))}
      </Card>
    </>
  );
}

// ════════════════════════════════════════════════════════
// 운행 리포트 — 본 메인 기능
// ════════════════════════════════════════════════════════
function ReportTab({ devices, sub, onSubChange }) {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);

  const [deviceId, setDeviceId] = useState(devices[0]?.id || null);
  // hard refresh 시 useState 초기값은 첫 렌더의 devices(=[])를 캡처해서 deviceId=null 로 박힘.
  // devices 가 나중에 도착하면 deviceId 자동 채움 (사용자가 직접 안 골라도 첫 디바이스 선택).
  useEffect(() => {
    if (deviceId == null && devices.length > 0) setDeviceId(devices[0].id);
  }, [devices, deviceId]);
  const [from, setFrom] = useState(monthAgo);
  const [to,   setTo]   = useState(today);
  const [trips, setTrips] = useState(null);
  const [staff, setStaff] = useState([]);
  const [info, setInfo] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);   // 편집 중인 trip {trip, deviceId}
  const [downloading, setDownloading] = useState(false);
  // 추가 필터 — 운전자별 / 용무별 / 최소 운행 시간(시간). all/'' 이면 미적용. AND.
  const [driverFilter,  setDriverFilter]  = useState('all');
  const [purposeFilter, setPurposeFilter] = useState('all');
  const [minHours,      setMinHours]      = useState('');

  const device = devices.find(d => d.id === deviceId);

  useEffect(() => {
    api.listStaff().then(s => setStaff((s || []).filter(x => x.active))).catch(() => {});
    api.getCorporateInfo().then(setInfo).catch(() => {});
  }, []);

  async function load() {
    if (!deviceId) return;
    setLoading(true); setError(null);
    try {
      const t = await api.listTrips(deviceId, { from, to });
      setTrips(t || []);
    } catch (e) {
      setError(e.message);
      setTrips([]);
    } finally { setLoading(false); }
  }
  useEffect(() => { load(); }, [deviceId, from, to]);  // eslint-disable-line

  // 추가 필터 적용된 trip 목록 — 운전자/용무/최소시간 AND.
  const filteredTrips = useMemo(() => {
    if (!trips) return null;
    const minH = parseFloat(minHours);
    const minMin = !isNaN(minH) && minH > 0 ? minH * 60 : 0;
    return trips.filter(t => {
      if (driverFilter !== 'all') {
        if (driverFilter === 'unassigned') {
          if (t.annotation?.driver_staff_id != null) return false;
        } else {
          if (t.annotation?.driver_staff_id !== Number(driverFilter)) return false;
        }
      }
      if (purposeFilter !== 'all') {
        const p = t.annotation?.purpose || 'unspecified';
        if (p !== purposeFilter) return false;
      }
      if (minMin > 0 && (t.duration_min || 0) < minMin) return false;
      return true;
    });
  }, [trips, driverFilter, purposeFilter, minHours]);

  // 일자별 누적거리 — 화면에 보이는(필터된) 운행 기준으로 계산.
  const dailyDistance = useMemo(() => {
    if (!filteredTrips) return new Map();
    const m = new Map();
    for (const t of filteredTrips) {
      const d = kstDate(t.started_at);
      m.set(d, (m.get(d) || 0) + (t.distance_m || 0));
    }
    return m;
  }, [filteredTrips]);

  const filterActive = driverFilter !== 'all' || purposeFilter !== 'all' || (parseFloat(minHours) > 0);
  function resetFilters() {
    setDriverFilter('all');
    setPurposeFilter('all');
    setMinHours('');
  }

  if (!sub) {
    return <div style={st.muted}>구독 상태 로딩 중...</div>;
  }
  if (!sub.active) {
    return (
      <Card title="법인운행 리포트 — 구독 필요">
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12, lineHeight: 1.6 }}>
          법인운행 리포트는 월 구독제로 제공됩니다.<br/>
          포인트 <b>{sub.price_krw.toLocaleString()}원</b> 으로 30일간 이용 가능.<br/>
          <span style={{ color: 'var(--text-3)', fontSize: 11 }}>
            * 보유 포인트가 부족하면 내정보 → 포인트 탭에서 충전 요청을 먼저 진행하세요.
          </span>
        </div>
        <button onClick={async () => {
          const ok = await confirmDialog({
            title: '법인운행 리포트 구독',
            body: `30일 구독을 시작합니다. ${sub.price_krw.toLocaleString()}원이 포인트에서 차감됩니다.`,
            confirmLabel: `${sub.price_krw.toLocaleString()}원 결제`,
            tone: 'success',
          });
          if (!ok) return;
          try {
            const r = await api.buyCorporateSubscription();
            onSubChange(r);
            await alertDialog({ title: '구독 시작', body: `${new Date(r.expires_at).toLocaleDateString('ko-KR')} 까지 사용 가능합니다.`, tone: 'success' });
          } catch (e) { await alertDialog({ title: '결제 실패', body: e.message, tone: 'danger' }); }
        }} style={st.btnPrimary}>구독 시작</button>
      </Card>
    );
  }

  return (
    <>
      {/* 컨트롤 — 인쇄 시 숨김 */}
      <div className="no-print" style={st.controls}>
        <select value={deviceId || ''} onChange={e => setDeviceId(parseInt(e.target.value, 10) || null)}
          style={st.select}>
          {devices.map(d => (
            <option key={d.id} value={d.id}>
              {d.display_name || d.device_uid}
            </option>
          ))}
        </select>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={st.dateInput} />
        <span style={{ color: 'var(--text-3)' }}>~</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={st.dateInput} />
        <button onClick={load} style={st.btnGhost} disabled={loading}>
          <Icon name="refresh" size={12} /> 새로고침
        </button>
        <button onClick={async () => {
          setDownloading(true);
          try {
            const { blob, filename } = await api.tripsCsv(deviceId, { from, to });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = filename; a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
          } catch (e) { await alertDialog({ title: '다운로드 실패', body: e.message, tone: 'danger' }); }
          finally { setDownloading(false); }
        }} style={st.btnGhost} disabled={downloading || !deviceId}>
          <Icon name="share" size={12} /> CSV (엑셀)
        </button>
        <button onClick={() => window.print()} style={st.btnPrimary}>
          <Icon name="share" size={12} /> 인쇄 / PDF
        </button>
      </div>

      {/* 추가 필터 row — 운전자 / 용무 / 최소시간. AND, 초기화 버튼. */}
      <div className="no-print" style={st.filters}>
        <select value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={st.select}>
          <option value="all">운전자 전체</option>
          <option value="unassigned">미지정</option>
          {staff.map(s => (
            <option key={s.id} value={String(s.id)}>{s.name}</option>
          ))}
        </select>
        <select value={purposeFilter} onChange={e => setPurposeFilter(e.target.value)} style={st.select}>
          <option value="all">용무 전체</option>
          <option value="commute">출퇴근</option>
          <option value="business">업무</option>
          <option value="other">기타</option>
          <option value="unspecified">미지정</option>
        </select>
        <input type="number" placeholder="최소 시간(h)"
          value={minHours} step="0.5" min="0"
          onChange={e => setMinHours(e.target.value)}
          style={{ ...st.dateInput, minWidth: 110 }} />
        {filterActive && (
          <button onClick={resetFilters} style={st.btnGhost}>
            <Icon name="close" size={12} /> 필터 초기화
          </button>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
          {trips && filteredTrips
            ? (filterActive
                ? `${filteredTrips.length} / ${trips.length}건`
                : `${trips.length}건`)
            : ''}
        </span>
      </div>

      {/* 리포트 본문 — 인쇄 영역 */}
      <div className="report-area" style={st.reportArea}>
        <ReportHeader info={info} device={device} from={from} to={to} />
        {loading && <div style={st.muted}>운행 데이터 로딩 중...</div>}
        {error   && <div style={{ ...st.muted, color: 'var(--danger)' }}>{error}</div>}
        {trips && trips.length === 0 && !loading && (
          <div style={st.muted}>이 기간에 운행 기록이 없습니다.</div>
        )}
        {trips && trips.length > 0 && filteredTrips.length === 0 && (
          <div style={st.muted}>필터 조건에 맞는 운행이 없습니다.</div>
        )}
        {filteredTrips && filteredTrips.length > 0 && (
          <TripsTable trips={filteredTrips} dailyDistance={dailyDistance}
            onEdit={(t) => setEditing(t)} />
        )}
      </div>

      {editing && (
        <TripEditorModal trip={editing} staff={staff} deviceId={deviceId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); }} />
      )}
    </>
  );
}

function ReportHeader({ info, device, from, to }) {
  const company = info?.company_name || '—';
  const biznum  = info?.business_number || '—';
  const dev     = device?.display_name || device?.device_uid || '—';
  return (
    <div style={st.reportHead}>
      <div style={{ fontSize: 18, fontWeight: 800, marginBottom: 8 }}>법인 차량 운행 일지</div>
      <table style={st.headerTable}>
        <tbody>
          <tr>
            <th style={st.th}>회사명</th><td style={st.td}>{company}</td>
            <th style={st.th}>사업자번호</th><td style={st.td}>{biznum}</td>
          </tr>
          <tr>
            <th style={st.th}>단말기</th><td style={st.td}>{dev}</td>
            <th style={st.th}>차량번호</th><td style={st.td}>{device?.display_name || '—'}</td>
          </tr>
          <tr>
            <th style={st.th}>기간</th>
            <td style={st.td} colSpan={3}>{from} ~ {to}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function TripsTable({ trips, dailyDistance, onEdit }) {
  return (
    // 모바일 — 9열 표가 좁은 폭을 넘김. 가로 스크롤 컨테이너로 감쌈.
    // 인쇄 시 @media print 가 nav/sidebar 만 숨기고 reportArea 는 그대로 노출, 인쇄 페이지 폭에 맞춤.
    <div style={st.tripsTableScroll}>
    <table style={st.tripsTable}>
      <thead>
        <tr>
          <th style={st.th}>날짜</th>
          <th style={st.th}>시간</th>
          <th style={st.th}>용무</th>
          <th style={st.th}>출발지</th>
          <th style={st.th}>도착지</th>
          <th style={st.th}>주행거리</th>
          <th style={st.th}>일별 누적</th>
          <th style={st.th}>유류</th>
          <th style={st.th}>운전자</th>
          <th style={{ ...st.th, width: 36 }} className="no-print"></th>
        </tr>
      </thead>
      <tbody>
        {trips.map((t, i) => {
          const d = kstDate(t.started_at);
          const dailyKm = ((dailyDistance.get(d) || 0) / 1000).toFixed(1);
          const firstOfDay = !trips.slice(0, i).some(x => kstDate(x.started_at) === d);
          return (
            <TripRow key={t.started_at} t={t}
              date={d} dailyKm={firstOfDay ? `${dailyKm} km` : ''}
              onEdit={() => onEdit(t)} />
          );
        })}
      </tbody>
    </table>
    </div>
  );
}

function TripRow({ t, date, dailyKm, onEdit }) {
  const ann = t.annotation || {};
  const purpose = ann.purpose || 'unspecified';
  const km = (t.distance_m / 1000).toFixed(1);
  const time = `${kstTime(t.started_at)}~${t.ended_at ? kstTime(t.ended_at) : '—'}`;

  return (
    <tr>
      <td style={st.td}>{date}</td>
      <td style={st.td}>{time}</td>
      <td style={st.td}>
        {PURPOSE_LABEL[purpose] || '미지정'}
        {purpose === 'other' && ann.purpose_note && (
          <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{ann.purpose_note}</div>
        )}
      </td>
      <td style={st.td}>
        <div>{t.start_address || '—'}</div>
        {t.start_lat != null && (
          <div style={{ fontSize: 9, color: 'var(--text-3)' }}>
            {t.start_lat.toFixed(5)}, {t.start_lng.toFixed(5)}
          </div>
        )}
      </td>
      <td style={st.td}>
        <div>{t.end_address || '—'}</div>
        {t.end_lat != null && (
          <div style={{ fontSize: 9, color: 'var(--text-3)' }}>
            {t.end_lat.toFixed(5)}, {t.end_lng.toFixed(5)}
          </div>
        )}
      </td>
      <td style={{ ...st.td, textAlign: 'right' }}>{km} km</td>
      <td style={{ ...st.td, textAlign: 'right' }}>{dailyKm}</td>
      <td style={st.td}>
        {ann.fuel_liters ? `${ann.fuel_liters}L` : '—'}
        {ann.fuel_cost ? ` / ${ann.fuel_cost.toLocaleString()}원` : ''}
      </td>
      <td style={st.td}>{ann.driver_name || '—'}</td>
      <td style={{ ...st.td, padding: 4 }} className="no-print">
        <button onClick={onEdit} style={{
          width: 26, height: 26, borderRadius: 6,
          background: 'var(--surface-2)', color: 'var(--text-2)',
          border: '1px solid var(--border)', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        }} title="편집">
          <Icon name="edit" size={12} />
        </button>
      </td>
    </tr>
  );
}

// ─── 운행 편집 모달 — 한 화면에서 용무/운전자/유류 전부 입력 ──
function TripEditorModal({ trip, staff, deviceId, onClose, onSaved }) {
  const ann = trip.annotation || {};
  const [purpose, setPurpose]      = useState(ann.purpose || 'unspecified');
  const [purposeNote, setPurposeNote] = useState(ann.purpose_note || '');
  const [driverId, setDriverId]    = useState(ann.driver_staff_id || '');
  const [fuelLiters, setFuelLiters] = useState(ann.fuel_liters != null ? String(ann.fuel_liters) : '');
  const [fuelCost, setFuelCost]    = useState(ann.fuel_cost != null ? String(ann.fuel_cost) : '');
  const [note, setNote]            = useState(ann.note || '');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api.upsertTripAnnotation(deviceId, {
        trip_started_at: trip.started_at,
        purpose,
        purpose_note: purpose === 'other' ? (purposeNote.trim() || null) : null,
        driver_staff_id: driverId ? parseInt(driverId, 10) : null,
        fuel_liters: fuelLiters.trim() ? parseFloat(fuelLiters) : null,
        fuel_cost:   fuelCost.trim()   ? parseInt(fuelCost, 10) : null,
        note: note.trim() || null,
      });
      onSaved?.();
    } catch (e) {
      await alertDialog({ title: '저장 실패', body: e.message, tone: 'danger' });
    } finally { setBusy(false); }
  }

  const km = (trip.distance_m / 1000).toFixed(1);

  return (
    // 외부 클릭으로 닫히지 않음 — 편집 중 데이터 손실 방지. X / 취소 버튼만 닫기.
    <div style={mst.backdrop}>
      <div style={mst.modal}>
        {/* 헤더 — 운행 요약 */}
        <div style={mst.header}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 700 }}>
              {kstDate(trip.started_at)} · {kstTime(trip.started_at)}~{trip.ended_at ? kstTime(trip.ended_at) : '진행 중'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              {trip.start_address || '—'} → {trip.end_address || '—'} · {km} km
            </div>
          </div>
          <button onClick={onClose} style={mst.closeBtn}><Icon name="close" size={14} /></button>
        </div>

        <div style={mst.body}>
          {/* 용무 */}
          <Field label="용무">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6 }}>
              {[
                ['unspecified', '미지정'],
                ['commute',     '출퇴근'],
                ['business',    '업무'],
                ['other',       '기타'],
              ].map(([id, label]) => {
                const on = purpose === id;
                return (
                  <button key={id} onClick={() => setPurpose(id)}
                    style={{
                      padding: '8px 4px',
                      background: on ? 'var(--primary)' : 'var(--surface-2)',
                      color:      on ? 'white' : 'var(--text)',
                      border: '1px solid ' + (on ? 'var(--primary)' : 'var(--border)'),
                      borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: on ? 700 : 500,
                    }}>{label}</button>
                );
              })}
            </div>
            {purpose === 'other' && (
              <input value={purposeNote} onChange={e => setPurposeNote(e.target.value)}
                placeholder="예: 거래처 미팅, 외근, 출장..."
                style={{ ...mst.input, marginTop: 6 }} autoFocus />
            )}
          </Field>

          {/* 운전자 */}
          <Field label="운전자">
            {staff.length === 0 ? (
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                직원 탭에서 운전자 후보를 먼저 등록하세요.
              </div>
            ) : (
              <select value={driverId} onChange={e => setDriverId(e.target.value)}
                style={mst.input}>
                <option value="">— 미지정 —</option>
                {staff.map(s => (
                  <option key={s.id} value={s.id}>
                    {s.name}{s.role ? ` (${s.role})` : ''}
                  </option>
                ))}
              </select>
            )}
          </Field>

          {/* 유류 */}
          <Field label="유류">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <div>
                <input type="number" step="0.1" value={fuelLiters}
                  onChange={e => setFuelLiters(e.target.value)}
                  placeholder="리터 (L)" style={mst.input} />
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>리터</div>
              </div>
              <div>
                <input type="number" value={fuelCost}
                  onChange={e => setFuelCost(e.target.value)}
                  placeholder="비용 (원)" style={mst.input} />
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>원</div>
              </div>
            </div>
          </Field>

          {/* 비고 */}
          <Field label="비고 (선택)">
            <input value={note} onChange={e => setNote(e.target.value)}
              placeholder="메모"
              style={mst.input} />
          </Field>
        </div>

        <div style={mst.actions}>
          <button onClick={onClose} style={mst.btnSecondary}>취소</button>
          <button onClick={save} disabled={busy} style={mst.btnPrimary}>
            {busy ? '저장 중...' : '저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════
// 구독
// ════════════════════════════════════════════════════════
function SubTab({ sub, onChange }) {
  const [busy, setBusy] = useState(false);

  async function buy() {
    const ok = await confirmDialog({
      title: '구독 결제',
      body: `${sub.price_krw.toLocaleString()}원 — 포인트에서 차감되며 30일 추가됩니다.`,
      confirmLabel: '결제',
      tone: 'success',
    });
    if (!ok) return;
    setBusy(true);
    try {
      const r = await api.buyCorporateSubscription();
      onChange(r);
    } catch (e) { await alertDialog({ title: '결제 실패', body: e.message, tone: 'danger' }); }
    finally { setBusy(false); }
  }

  if (!sub) return <div style={st.muted}>로딩...</div>;
  return (
    <Card title="법인운행 리포트 구독">
      <div style={{ fontSize: 13, marginBottom: 12 }}>
        상태: <b style={{ color: sub.active ? 'var(--accent)' : 'var(--text-3)' }}>
          {sub.active ? '활성' : '비활성'}
        </b>
        {sub.expires_at && (
          <span style={{ color: 'var(--text-2)' }}>
            {' '}— {new Date(sub.expires_at).toLocaleDateString('ko-KR')} 까지
          </span>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 12 }}>
        월 {sub.price_krw.toLocaleString()}원 · 30일 추가 (기존 만료일 + 30일)
      </div>
      <button onClick={buy} disabled={busy} style={st.btnPrimary}>
        {busy ? '...' : (sub.active ? '30일 추가 결제' : '구독 시작')}
      </button>
    </Card>
  );
}

// ─── 공용 sub-컴포넌트 ─────────────────────────────────
function Card({ title, children }) {
  return (
    <div style={st.card}>
      {title && <div style={st.cardTitle}>{title}</div>}
      {children}
    </div>
  );
}

// 사용처 두 군데:
//  1) value/onChange 받으면 단순 input (info/staff form 용)
//  2) children 받으면 children 그대로 (TripEditorModal 의 복합 필드용)
function Field({ label, value, onChange, placeholder, children }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 4, fontWeight: 600 }}>{label}</div>
      {children != null ? children : (
        <input value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
          style={st.input} />
      )}
    </div>
  );
}

// ─── TripEditorModal 전용 스타일 ─────────────────────
const mst = {
  backdrop: {
    position: 'fixed', inset: 0, zIndex: 900,
    background: 'rgba(0,0,0,0.5)',
    backdropFilter: 'blur(4px)',
    WebkitBackdropFilter: 'blur(4px)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    padding: 16,
    animation: 'fadeInUp .15s ease-out',
  },
  modal: {
    background: 'var(--surface)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 14,
    width: '100%', maxWidth: 460, overflow: 'hidden',
    boxShadow: '0 20px 60px rgba(0,0,0,.4)',
    animation: 'fadeInUp .18s ease-out',
    display: 'flex', flexDirection: 'column',
    maxHeight: '90vh',
  },
  header: {
    display: 'flex', alignItems: 'flex-start', gap: 8,
    padding: '14px 16px', borderBottom: '1px solid var(--border)',
  },
  closeBtn: {
    width: 28, height: 28, borderRadius: 6,
    background: 'transparent', color: 'var(--text-3)',
    border: 'none', cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  },
  body: {
    padding: 16, overflowY: 'auto', flex: 1,
  },
  input: {
    display: 'block', width: '100%', padding: '8px 10px',
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
    fontSize: 13, boxSizing: 'border-box', outline: 'none',
  },
  actions: {
    display: 'flex', gap: 8, padding: '12px 16px',
    borderTop: '1px solid var(--border)',
  },
  btnPrimary: {
    flex: 1, padding: '10px 16px',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 8,
    fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  btnSecondary: {
    flex: 1, padding: '10px 16px',
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 8,
    fontSize: 13, cursor: 'pointer',
  },
};

function kstDate(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
function kstTime(iso) {
  const d = new Date(new Date(iso).getTime() + 9 * 3600 * 1000);
  return d.toISOString().slice(11, 16);
}

const st = {
  wrap: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 },
  tabBar: {
    display: 'flex', overflowX: 'auto', flexShrink: 0,
    background: 'var(--surface)', borderBottom: '1px solid var(--border)',
  },
  tabBtn: {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '10px 14px', fontSize: 12, cursor: 'pointer',
    background: 'transparent', border: 'none',
    whiteSpace: 'nowrap', flexShrink: 0,
  },
  body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: 12 },
  card: {
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 10, padding: 12, marginBottom: 10,
  },
  cardTitle: {
    fontWeight: 700, fontSize: 11, color: 'var(--text-2)',
    textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8,
  },
  input: {
    display: 'block', width: '100%', padding: '8px 10px',
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 6, color: 'var(--text)', fontSize: 13, boxSizing: 'border-box',
  },
  controls: {
    display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
    marginBottom: 12, padding: '0 4px',
  },
  filters: {
    display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap',
    marginBottom: 12, padding: '0 4px',
  },
  select: {
    flex: 1, minWidth: 160, padding: '8px 10px',
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6, fontSize: 13,
  },
  dateInput: {
    padding: '7px 10px', fontSize: 13,
    background: 'var(--surface-2)', color: 'var(--text)',
    border: '1px solid var(--border)', borderRadius: 6,
  },
  btnPrimary: {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    padding: '8px 14px',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 6, cursor: 'pointer',
    fontSize: 12, fontWeight: 600,
  },
  btnGhost: {
    display: 'inline-flex', alignItems: 'center', gap: 4,
    padding: '6px 10px', fontSize: 11,
    background: 'transparent', color: 'var(--text-2)',
    border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
  },
  reportArea: {
    background: 'var(--surface)', padding: 16,
    border: '1px solid var(--border)', borderRadius: 8,
  },
  reportHead: { marginBottom: 16 },
  headerTable: {
    width: '100%', borderCollapse: 'collapse', fontSize: 12,
  },
  tripsTableScroll: {
    overflowX: 'auto',
    WebkitOverflowScrolling: 'touch',
    marginTop: 8,
  },
  tripsTable: {
    width: '100%', minWidth: 720,
    borderCollapse: 'collapse', fontSize: 11,
  },
  th: {
    background: 'var(--surface-2)', fontWeight: 700,
    padding: '6px 8px', textAlign: 'left',
    border: '1px solid var(--border)', whiteSpace: 'nowrap',
  },
  td: {
    padding: '6px 8px', border: '1px solid var(--border)',
    verticalAlign: 'top',
  },
  muted: { color: 'var(--text-3)', fontSize: 12, padding: 16, textAlign: 'center' },
};

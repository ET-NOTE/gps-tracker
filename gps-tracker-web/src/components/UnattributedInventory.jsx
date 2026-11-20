import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { inventoryCategories, inventoryFilters, inventoryLinks, recentInventoryDates } from '../lib/unattributedInventory';
import './PrivacyRequests.css';

export default function UnattributedInventory() {
  const [form, setForm] = useState(() => ({ kind: 'location', ...recentInventoryDates(), device: '' }));
  const [page, setPage] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const request = useRef(null), filters = useRef(null);
  const invalidate = () => { request.current?.abort(); request.current = null; setBusy(false); setPage(null); setError(''); };
  useEffect(() => () => request.current?.abort(), []);
  function edit(key, value) { invalidate(); filters.current = null; setForm(current => ({ ...current, [key]: value })); }
  async function load(next = false) {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller;
    setPage(null); setError(''); setBusy(true);
    try {
      const query = next ? { ...filters.current, cursor: page.next_cursor } : inventoryFilters(form);
      const result = await api.adminUnattributed(query, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      filters.current = query; setPage(result);
    } catch (e) { if (request.current === controller && e.name !== 'AbortError') setError(e.message); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  }
  return <section className="rights-panel rights-card" style={{ marginTop: 16 }} aria-label="귀속 미상 자료 검토">
    <h3>귀속 미상 자료 검토</h3>
    <p>수집 당시 계정이 없는 위치·이벤트의 분류 목록입니다. 현재 장치 연결은 과거 소유자나 실제 정보주체를 확정하는 근거가 아닙니다.</p>
    <p>좌표·원문은 표시하지 않습니다. 발생 원인과 처리 근거를 별도 확인하며, 이 화면에서 귀속을 바꾸거나 삭제하지 않습니다.</p>
    <form onSubmit={e => { e.preventDefault(); load(); }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(min(100%,180px),1fr))', gap: 12 }}>
        <label>자료 종류<select value={form.kind} onChange={e => edit('kind', e.target.value)}><option value="location">위치 기록</option><option value="event">이벤트</option></select></label>
        <label>시작일<input type="date" value={form.start} onChange={e => edit('start', e.target.value)} required/></label>
        <label>종료일<input type="date" value={form.end} onChange={e => edit('end', e.target.value)} required/></label>
        <label>장치 번호 (선택)<input inputMode="numeric" value={form.device} onChange={e => edit('device', e.target.value)} placeholder="전체 장치"/></label>
      </div>
      <p>한국시간 기준 · 종료일 포함 최대 31일 · 페이지당 최대 50개 분류</p>
      <button type="submit" disabled={busy}>처음부터 조회</button>{busy && <button type="button" onClick={invalidate}>조회 취소</button>}
    </form>
    {busy && <p role="status">조회 중…</p>}{error && <p role="alert">{error}</p>}
    {page && <>
      <p>{page.notice}</p>
      <p>이번 페이지: {page.items.length}개 분류 / {page.items.reduce((sum, row) => sum + row.records, 0).toLocaleString()}개 기록{page.next_cursor ? ' · 다음 페이지 있음' : ''}</p>
      {page.items.length === 0 ? <p>선택한 조건에 귀속 미상 자료가 없습니다. 다른 기간이나 외부 사본의 확인을 완료한 것은 아닙니다.</p> :
        <div style={{ overflowX: 'auto' }}><table style={{ width: '100%', minWidth: 560, textAlign: 'left' }}><thead><tr>{['기록일 (한국시간)', '장치 번호', '수집 방식·이벤트', '기록 수', '현재 연결 상태'].map(label => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{page.items.map(row => <tr key={`${row.day}-${row.device_id}-${row.category}`}><td>{row.day}</td><td>{row.device_id}</td><td>{inventoryCategories[row.category] || '확인 필요'}</td><td>{row.records.toLocaleString()}</td><td>{inventoryLinks[row.current_link] || '확인 필요'}</td></tr>)}</tbody></table></div>}
      <p>전체 자료의 합계가 아닙니다. 자료가 변경되면 처음부터 다시 조회해 주세요.</p>
      {page.next_cursor && <button type="button" disabled={busy} onClick={() => load(true)}>다음 페이지</button>}
    </>}
  </section>;
}

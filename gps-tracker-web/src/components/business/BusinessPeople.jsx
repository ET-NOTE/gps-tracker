import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useStaff, useCreateStaff, useUpdateStaff, useRemoveStaff, useRenters, useRenterDetail, useAddBlacklist, useRemoveBlacklist, qk } from '../../state';
import { Modal, FormField, Input, Textarea, Button, SkeletonList } from '../ui';
import { BusinessButton, BusinessEmpty, BusinessError, BusinessMetrics, BusinessSection } from './BusinessWorkspace';
import { kstDateTime } from '../../lib/businessExport';

function PeopleSearch({ label, placeholder, value, onChange }) {
  return <label className="business-search"><span className="business-sr-only">{label}</span><input type="search" aria-label={label} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} /></label>;
}
function PeopleFilters({ options, value, onChange, label }) {
  return <div className="business-task-filters" aria-label={label}>{options.map(([id, text, count]) => <button type="button" className="business-task-filter" key={id} aria-pressed={value === id} onClick={() => onChange(id)}>{text} <span>{count}</span></button>)}</div>;
}
function PersonHeading({ name, subtitle, children }) {
  return <div className="business-person-heading"><span className="business-person-avatar" aria-hidden="true">{(name || '?').trim().slice(0, 2)}</span><div><strong>{name || '이름 미등록'}</strong><p>{subtitle}</p></div>{children}</div>;
}

export function BusinessStaff() {
  const result = useStaff(), [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [adding, setAdding] = useState(false), [changing, setChanging] = useState(null);
  const list = result.data || [], active = list.filter(s => s.active).length;
  const rows = list.filter(s => (filter === 'all' || !!s.active === (filter === 'active')) && [s.name, s.role, s.phone].some(v => String(v || '').toLowerCase().includes(query.trim().toLowerCase())));
  return <div className="business-support">
    <BusinessMetrics items={[
      { label: '전체 운전자', value: result.error || !result.data ? null : list.length, unit: '명', hint: '등록한 운전자', icon: 'user' },
      { label: '활성 운전자', value: result.error || !result.data ? null : active, unit: '명', hint: '예약·운행 배정에 사용', icon: 'check', tone: 'good' },
      { label: '비활성 운전자', value: result.error || !result.data ? null : list.length - active, unit: '명', hint: '과거 운행기록 유지', icon: 'user' },
    ]} />
    <BusinessSection title="운전자 목록" description="이름과 연락처를 확인하고 배정할 운전자를 관리하세요." action={<BusinessButton primary icon="plus" onClick={() => setAdding(true)}>운전자 추가</BusinessButton>}>
      <div className="business-support-toolbar"><PeopleSearch label="운전자 검색" placeholder="이름 · 역할 · 연락처 검색" value={query} onChange={setQuery} /></div>
      {result.data && !result.error && <PeopleFilters label="운전자 상태 필터" value={filter} onChange={setFilter} options={[["all", "전체", list.length], ["active", "활성", active], ["inactive", "비활성", list.length - active]]} />}
      {result.error ? <BusinessError onRetry={result.refetch}>운전자 정보를 불러오지 못했습니다.</BusinessError> : !result.data ? <SkeletonList count={3} itemHeight={80} /> : rows.length ? <div className="business-people-grid">{rows.map(s => <article className="business-person-card" key={s.id}>
        <PersonHeading name={s.name} subtitle={s.role || '역할 미등록'}><span className={`business-badge ${s.active ? 'good' : ''}`}>{s.active ? '활성' : '비활성'}</span></PersonHeading>
        <dl className="business-person-facts"><div><dt>연락처</dt><dd>{s.phone || '미등록'}</dd></div></dl>
        <div className="business-person-actions"><BusinessButton onClick={() => setChanging(s)} aria-label={`${s.name} ${s.active ? '비활성화' : '활성화'}`}>{s.active ? '비활성화' : '활성화'}</BusinessButton></div>
      </article>)}</div> : <BusinessEmpty title={list.length ? '검색 조건에 맞는 운전자가 없습니다.' : '등록된 운전자가 없습니다.'}>{list.length ? '검색어나 상태 필터를 변경해 주세요.' : '운전자를 추가하면 예약과 운행기록에 배정할 수 있습니다.'}</BusinessEmpty>}
    </BusinessSection>
    {adding && <StaffAddModal onClose={() => setAdding(false)} />}
    {changing && <StaffStatusModal staff={changing} onClose={() => setChanging(null)} />}
  </div>;
}
function StaffAddModal({ onClose }) {
  const [form, setForm] = useState({ name: '', role: '', phone: '' }), [error, setError] = useState(''), lock = useRef(false), mutation = useCreateStaff();
  const set = key => e => { setError(''); setForm(v => ({ ...v, [key]: e.target.value })); };
  async function save() {
    if (lock.current) return;
    if (!form.name.trim()) { setError('운전자 이름을 입력해 주세요.'); return; }
    lock.current = true; setError('');
    try { await mutation.mutateAsync({ name: form.name.trim(), role: form.role.trim() || null, phone: form.phone.trim() || null }); onClose(); }
    catch { setError('운전자를 저장하지 못했습니다. 입력 내용을 확인하고 다시 시도해 주세요.'); }
    finally { lock.current = false; }
  }
  return <Modal open title="운전자 추가" subtitle="예약·운행기록에 배정할 운전자를 등록하세요." onClose={mutation.isPending ? undefined : onClose} closeOnBackdrop={false} closeOnEsc={!mutation.isPending} footer={<><Button className="business-form-cancel" variant="ghost" disabled={mutation.isPending} onClick={onClose}>취소</Button><Button className="business-form-submit" busy={mutation.isPending} onClick={save}>운전자 저장</Button></>}>
    {error && <BusinessError>{error}</BusinessError>}
    <FormField label="이름 (필수)"><Input autoFocus value={form.name} onChange={set('name')} disabled={mutation.isPending} autoComplete="name" /></FormField>
    <FormField label="역할 (선택)"><Input value={form.role} onChange={set('role')} disabled={mutation.isPending} placeholder="예: 영업 · 배차" /></FormField>
    <FormField label="연락처 (선택)"><Input type="tel" value={form.phone} onChange={set('phone')} disabled={mutation.isPending} autoComplete="tel" placeholder="010-0000-0000" /></FormField>
  </Modal>;
}
function StaffStatusModal({ staff, onClose }) {
  const remove = useRemoveStaff(), update = useUpdateStaff(), lock = useRef(false), [error, setError] = useState('');
  const busy = remove.isPending || update.isPending, label = staff.active ? '비활성화' : '활성화';
  async function save() {
    if (lock.current) return; lock.current = true; setError('');
    try { if (staff.active) await remove.mutateAsync(staff.id); else await update.mutateAsync({ id: staff.id, body: { name: staff.name, role: staff.role, phone: staff.phone, active: true } }); onClose(); }
    catch { setError('운전자 상태를 변경하지 못했습니다. 다시 시도해 주세요.'); } finally { lock.current = false; }
  }
  return <Modal open title={`운전자 ${label}`} onClose={busy ? undefined : onClose} closeOnEsc={!busy} closeOnBackdrop={false} footer={<><Button className="business-form-cancel" variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button className="business-form-submit" busy={busy} onClick={save}>{label} 확인</Button></>}>
    <p className="business-support-message"><strong>{staff.name}</strong> 운전자를 {label}합니다. 과거 운행기록은 유지됩니다.</p>
    {error && <BusinessError>{error}</BusinessError>}
  </Modal>;
}

export function BusinessRenters() {
  const result = useRenters(), [query, setQuery] = useState(''), [filter, setFilter] = useState('all'), [detail, setDetail] = useState(null), [editing, setEditing] = useState(null);
  const list = result.data || [], ready = !!result.data && !result.error, repeat = list.filter(r => r.contracts_count >= 2).length, flagged = list.filter(r => r.blacklisted).length;
  const rows = list.filter(r => (filter === 'all' || (filter === 'repeat' ? r.contracts_count >= 2 : r.blacklisted)) && [r.renter_name, r.renter_phone].some(v => String(v || '').toLowerCase().includes(query.trim().toLowerCase())));
  return <div className="business-support"><BusinessMetrics items={[
    { label: '전체 임차인', value: ready ? list.length : null, unit: '명', hint: '계약 이력에 등록된 고객', icon: 'user' },
    { label: '재방문', value: ready ? repeat : null, unit: '명', hint: '계약 이력 2회 이상', icon: 'refresh' },
    { label: '경고·차단', value: ready ? flagged : null, unit: '명', hint: '계약 전 확인할 고객', icon: 'warn', tone: flagged ? 'urgent' : '' },
    { label: '누적 매출', value: ready ? list.reduce((sum, r) => sum + (r.total_revenue || 0), 0).toLocaleString() : null, unit: '원', hint: '전체 임차인 합계', icon: 'coin' },
  ]} /><BusinessSection title="임차인 목록" description="임차인은 계약에 입력한 정보를 기준으로 표시됩니다." action={<PeopleSearch label="임차인 검색" placeholder="이름 · 전화번호 검색" value={query} onChange={setQuery} />}>
    {ready && <PeopleFilters label="임차인 필터" value={filter} onChange={setFilter} options={[["all", "전체", list.length], ["repeat", "재방문", repeat], ["flagged", "경고·차단", flagged]]} />}
    {result.error ? <BusinessError onRetry={result.refetch}>임차인 정보를 불러오지 못했습니다.</BusinessError> : !result.data ? <SkeletonList count={3} itemHeight={100} /> : rows.length ? <div className="business-people-grid">{rows.map(r => <article key={r.renter_phone} className="business-person-card">
      <PersonHeading name={r.renter_name} subtitle={r.renter_phone}><RenterBadge renter={r} /></PersonHeading>
      <dl className="business-person-facts"><div><dt>이용 / 반납</dt><dd>{r.contracts_count}회 / {r.returned_count}회</dd></div><div><dt>누적 매출</dt><dd>{(r.total_revenue || 0).toLocaleString()}원</dd></div><div><dt>최근 이용</dt><dd>{dateLabel(r.last_at)}</dd></div><div><dt>연체 / 지연 반납</dt><dd>{r.overdue_count || 0}건 / {r.late_count || 0}건</dd></div></dl>
      <div className="business-person-actions"><BusinessButton onClick={() => setDetail(r)} aria-label={`${r.renter_name || r.renter_phone} 이용 이력`}>이용 이력</BusinessButton><BusinessButton onClick={() => setEditing(r)} aria-label={`${r.renter_name || r.renter_phone} 유의사항 관리`}>유의사항 관리</BusinessButton></div>
    </article>)}</div> : <BusinessEmpty title={list.length ? '검색 조건에 맞는 임차인이 없습니다.' : '등록된 임차인이 없습니다.'}>{list.length ? '검색어나 필터를 변경해 주세요.' : '계약을 등록하면 임차인과 이용 이력이 표시됩니다.'}</BusinessEmpty>}
  </BusinessSection>{detail && <RenterDetail renter={detail} onClose={() => setDetail(null)} />}{editing && <RenterNotice renter={editing} onClose={() => setEditing(null)} />}</div>;
}
function dateLabel(value) { return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' }) : '미확인'; }
function RenterBadge({ renter }) { return renter.blacklisted ? <span className={`business-badge ${renter.blacklist_severity === 'block' ? 'urgent' : 'warning'}`}>{renter.blacklist_severity === 'block' ? '신규 계약 차단' : '계약 시 경고'}</span> : renter.contracts_count >= 2 ? <span className="business-badge info">재방문</span> : null; }
function RenterDetail({ renter, onClose }) {
  const result = useRenterDetail(renter.renter_phone), summary = result.data?.summary;
  const statuses = { draft: '초안', active: '임대 중', overdue: '반납 지연', returned: '반납 완료', cancelled: '취소' };
  return <Modal open title="임차인 이용 이력" subtitle={`${renter.renter_name || '이름 미등록'} · ${renter.renter_phone}`} size="lg" onClose={onClose} footer={<Button full variant="ghost" onClick={onClose}>닫기</Button>}>
    {result.error ? <BusinessError onRetry={result.refetch}>이용 이력을 불러오지 못했습니다.</BusinessError> : !result.data ? <SkeletonList count={3} itemHeight={60} /> : <>
      {summary && <><dl className="business-support-summary"><div><dt>이용 / 반납</dt><dd>{summary.contracts_count}회 / {summary.returned_count}회</dd></div><div><dt>누적 매출</dt><dd>{(summary.total_revenue || 0).toLocaleString()}원</dd></div><div><dt>최초 이용</dt><dd>{dateLabel(summary.first_at)}</dd></div><div><dt>최근 이용</dt><dd>{dateLabel(summary.last_at)}</dd></div><div><dt>연체 / 지연 반납</dt><dd>{summary.overdue_count || 0}건 / {summary.late_count || 0}건</dd></div></dl>{summary.blacklisted && <div className="business-support-notice"><RenterBadge renter={summary} /><p>{summary.blacklist_reason || '사유 미등록'}</p></div>}</>}
      <h3 className="business-support-title">계약 이력</h3><div className="business-person-history">{result.data.contracts?.length ? result.data.contracts.map(c => <article key={c.id}><div><strong>{c.license_plate || c.device_name || `차량 #${c.device_id}`}</strong><span className={`business-badge ${c.status === 'overdue' ? 'urgent' : ''}`}>{statuses[c.status] || '상태 확인'}</span></div><p>{kstDateTime(c.starts_at)} ~ {kstDateTime(c.ends_at)}</p><p>{c.settled_amount_krw == null ? '미정산' : `정산 ${c.settled_amount_krw.toLocaleString()}원`}</p></article>) : <BusinessEmpty compact title="계약 이력이 없습니다." />}</div>
    </>}
  </Modal>;
}
function RenterNotice({ renter, onClose }) {
  const [reason, setReason] = useState(renter.blacklist_reason || ''), [severity, setSeverity] = useState(renter.blacklist_severity || 'warn'), [error, setError] = useState(''), [busy, setBusy] = useState(false), [confirmRemove, setConfirmRemove] = useState(false);
  const add = useAddBlacklist(), remove = useRemoveBlacklist(), qc = useQueryClient(), lock = useRef(false);
  async function save(removing = false) {
    if (lock.current) return;
    if (!removing && !reason.trim()) { setError('유의사항 사유를 입력해 주세요.'); return; }
    lock.current = true; setBusy(true); setError('');
    try {
      if (removing) { const list = await api.listBlacklist(); const item = list.find(r => r.renter_phone === renter.renter_phone); if (!item) throw Error('missing'); await remove.mutateAsync(item.id); }
      else await add.mutateAsync({ renter_phone: renter.renter_phone, renter_name: renter.renter_name, reason: reason.trim(), severity });
      qc.invalidateQueries({ queryKey: qk.renterDetail(renter.renter_phone) }); onClose();
    } catch { setError(removing ? '해제하지 못했습니다. 다시 조회한 뒤 시도해 주세요.' : '유의사항을 저장하지 못했습니다. 입력 내용은 유지됩니다.'); }
    finally { lock.current = false; setBusy(false); }
  }
  return <Modal open title="임차인 유의사항" subtitle={`${renter.renter_name || '이름 미등록'} · ${renter.renter_phone}`} onClose={busy ? undefined : onClose} closeOnBackdrop={false} closeOnEsc={!busy} footer={<><Button className="business-form-cancel" variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button className="business-form-submit" busy={busy} onClick={() => save(false)}>유의사항 저장</Button></>}>
    <p className="business-note">신규 계약 시 확인할 사유와 처리 수준을 지정하세요.</p>{error && <BusinessError>{error}</BusinessError>}
    <FormField label="사유 (필수)"><Textarea value={reason} onChange={e => { setError(''); setReason(e.target.value); }} disabled={busy} placeholder="예: 이전 계약의 미정산 내역 확인 필요" /></FormField>
    <fieldset className="business-choice-group" disabled={busy}><legend>계약 시 처리</legend>{[['warn', '경고', '계약 시 사유를 확인하도록 안내합니다.'], ['block', '신규 계약 차단', '새 계약의 등록을 제한합니다.']].map(([value, title, text]) => <label key={value}><input type="radio" name="renter-severity" value={value} checked={severity === value} onChange={() => setSeverity(value)} /><span><strong>{title}</strong><small>{text}</small></span></label>)}</fieldset>
    {renter.blacklisted && <div className="business-support-notice">{confirmRemove ? <><p>등록된 경고·차단을 해제할까요? 기존 계약 이력은 유지됩니다.</p><div className="business-person-actions"><Button variant="ghost" disabled={busy} onClick={() => setConfirmRemove(false)}>유지</Button><Button variant="danger" disabled={busy} onClick={() => save(true)}>해제 확인</Button></div></> : <BusinessButton disabled={busy} onClick={() => setConfirmRemove(true)}>경고·차단 해제</BusinessButton>}</div>}
  </Modal>;
}

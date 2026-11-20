import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { kstDateTime } from '../../lib/businessExport';
import { isIncident, kstInput, rentalFleetLabel, repairNames, sameId, workStageName, workState } from '../../lib/rentalFleet';
import { Modal } from '../ui';
import { BusinessButton, BusinessEmpty } from './BusinessWorkspace';
import BusinessDrawer from './BusinessDrawer';

export const fleetWorkKey = () => [authScope(), 'rental-fleet-work'];

function WorkEditor({ devices, contracts, initial, incident, onClose, onSave }) {
  const start = Date.now();
  const [form, setForm] = useState(() => ({
    device: String(initial?.device_id || devices[0]?.id || ''), contract: String(initial?.contract_id || ''),
    kind: initial?.kind || (incident ? 'accident' : 'cleaning'), note: initial?.note || '',
    from: kstInput(initial?.starts_at || new Date(start).toISOString()),
    to: kstInput(initial?.ends_at || new Date(start + 3600000).toISOString()),
  }));
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  function change(field, value) {
    setForm(prev => ({ ...prev, [field]: value, ...(field === 'device' ? { contract: '' } : {}) }));
  }
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const result = await api.saveRentalFleetWork(initial?.id, {
        device_id: Number(form.device), contract_id: form.contract ? Number(form.contract) : null,
        kind: form.kind, starts_at: new Date(form.from + ':00+09:00').toISOString(),
        ends_at: incident ? null : new Date(form.to + ':00+09:00').toISOString(), note: form.note.trim(),
      });
      onSave(result);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const title = incident ? '사고·고장 접수' : initial ? '작업 일정 수정' : '세차·정비 일정 등록';
  return <Modal open title={title} onClose={busy ? undefined : onClose} size="lg">
    <form className="rfl-form" onSubmit={save} aria-busy={busy}>
      <label>차량<select required disabled={!!initial} value={form.device} onChange={e => change('device', e.target.value)}>
        <option value="">차량 선택</option>{devices.map(d => <option key={d.id} value={d.id}>{rentalFleetLabel(d)}</option>)}
      </select></label>
      <label>작업 구분<select value={form.kind} onChange={e => change('kind', e.target.value)}>
        {Object.entries(repairNames).filter(([key]) => isIncident(key) === incident).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
      </select></label>
      {incident && <label className="rfl-wide">연결 계약<select value={form.contract} onChange={e => change('contract', e.target.value)}>
        <option value="">계약 연결 안 함</option>{contracts.filter(c => sameId(c.device_id, form.device) && c.status !== 'cancelled').map(c => <option key={c.id} value={c.id}>#{c.id} · {c.renter_name} · {kstDateTime(c.starts_at)}</option>)}
      </select></label>}
      <label>{incident ? '발생 일시' : '시작 일시'}<input required type="datetime-local" value={form.from} onChange={e => change('from', e.target.value)} /></label>
      {!incident && <label>종료 일시<input required type="datetime-local" value={form.to} onChange={e => change('to', e.target.value)} /></label>}
      <label className="rfl-wide">{incident ? '접수 내용' : '작업 내용'}<textarea required={incident} maxLength={1000} value={form.note} onChange={e => change('note', e.target.value)} rows={3} /></label>
      {error && <p role="alert" className="rfl-error rfl-wide">{error}</p>}
      <div className="rfl-form-actions rfl-wide"><BusinessButton disabled={busy} onClick={onClose}>닫기</BusinessButton><button type="submit" className="business-button is-primary" disabled={busy || !form.device}>{busy ? '저장 중…' : '저장'}</button></div>
    </form>
  </Modal>;
}

export default function RentalFleetWork({ incident, devices, contracts, work, now, initialId, onNavigate }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(initialId ? 'all' : 'open'), [deviceId, setDeviceId] = useState(''), [kind, setKind] = useState('');
  const [edit, setEdit] = useState(null), [id, setId] = useState(initialId), [closing, setClosing] = useState(false);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const current = work.find(row => sameId(row.id, id)), matching = work.filter(row => isIncident(row.kind) === incident);
  const rows = matching.filter(row => (!kind || row.kind === kind) && (!deviceId || sameId(row.device_id, deviceId))
    && (status === 'all' || (status === 'open' ? workState(row) !== 'done' : workState(row) === 'done')));
  const names = new Map(devices.map(d => [Number(d.id), rentalFleetLabel(d)]));
  function saved(row) {
    qc.setQueryData(fleetWorkKey(), old => [row, ...(old || []).filter(item => item.id !== row.id)].sort((a,b) => Date.parse(b.starts_at) - Date.parse(a.starts_at) || b.id - a.id));
    qc.invalidateQueries({ queryKey: fleetWorkKey() });
    setEdit(null); setClosing(false); setNote(''); setId(row.id);
  }
  async function complete(event) {
    event.preventDefault();
    if (busy || !current) return;
    setBusy(true); setError('');
    try { saved(await api.completeRentalFleetWork(current.id, { resolution: note, release: workState(current) === 'review' })); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const stage = current && workState(current);
  const action = stage === 'review' ? '점검 완료' : incident ? '사고·고장 처리 완료' : '작업 완료';
  return <div className="rfl-page">
    <div className="rfl-toolbar"><span className="rfl-total">{incident ? '사고·고장' : '세차·정비 일정'} <b>{rows.length}</b></span>
      {devices.length ? <BusinessButton primary icon="plus" onClick={() => setEdit({})}>{incident ? '사고·고장 접수' : '일정 등록'}</BusinessButton>
        : onNavigate && <BusinessButton icon="antenna" onClick={() => onNavigate('devices')}>단말기 등록</BusinessButton>}</div>
    <div className="rfl-filters">
      <label>차량<select value={deviceId} onChange={e => setDeviceId(e.target.value)}><option value="">전체 차량</option>{devices.map(d => <option key={d.id} value={d.id}>{rentalFleetLabel(d)}</option>)}</select></label>
      <label>작업 구분<select value={kind} onChange={e => setKind(e.target.value)}><option value="">전체 구분</option>{Object.entries(repairNames).filter(([k]) => isIncident(k) === incident).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>상태<select value={status} onChange={e => setStatus(e.target.value)}><option value="open">{incident ? '처리·점검 중' : '예정·진행'}</option><option value="done">완료</option><option value="all">전체 상태</option></select></label>
    </div>
    <section className="rfl-card" aria-label={incident ? '사고·고장 내역' : '세차·정비 내역'}>
      {rows.length > 0 ? <table className="rfl-table"><thead><tr><th>차량</th><th>구분</th><th>{incident ? '발생 일시' : '작업 기간'}</th><th>내용</th><th>상태</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}>
        <td data-label="차량"><button className="rfl-link" onClick={() => setId(row.id)}>{names.get(row.device_id) || '이전 차량'} <span aria-hidden="true">›</span></button></td>
        <td data-label="구분">{repairNames[row.kind]}</td><td data-label="일시">{kstDateTime(row.starts_at)}{row.ends_at && <small>{kstDateTime(row.ends_at)} 종료</small>}</td>
        <td data-label="내용">{row.note || '—'}</td><td data-label="상태"><span className="rfl-badge" data-tone={row.closed_at ? 'ready' : 'service'}>{workStageName(row)}</span></td>
      </tr>)}</tbody></table> : <BusinessEmpty title={devices.length ? '조회된 내역이 없습니다.' : '연결된 렌트카 차량이 없습니다.'} />}
    </section>
    {current && <BusinessDrawer title={repairNames[current.kind] + ' 상세'} subtitle={names.get(current.device_id) || '이전 차량'} onClose={() => setId(null)}>
      <dl className="rfl-facts">
        {[
          ['상태', workStageName(current)], ['차량', names.get(current.device_id) || '이전 차량'],
          [incident ? '발생 일시' : '시작 일시', kstDateTime(current.starts_at)], ['종료 예정', kstDateTime(current.ends_at)],
          ['연결 계약', current.contract_id && '#' + current.contract_id], ['내용', current.note], ['처리 완료', kstDateTime(current.closed_at)],
          ['처리 내용', current.resolution], ['점검 완료', kstDateTime(current.inspection_released_at)],
        ].filter(([,v]) => v).map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
      {stage !== 'done' && <div className="rfl-form-actions">
        {!incident && !current.return_inspection && <BusinessButton icon="edit" onClick={() => setEdit(current)}>일정 수정</BusinessButton>}
        <BusinessButton primary disabled={Date.parse(current.starts_at) > now} onClick={() => { setClosing(true); setNote(''); setError(''); }}>{action}</BusinessButton>
      </div>}
    </BusinessDrawer>}
    {edit && <WorkEditor devices={devices} contracts={contracts} incident={incident} initial={edit.id ? edit : null} onSave={saved} onClose={() => setEdit(null)} />}
    {closing && current && <Modal open title={action} onClose={busy ? undefined : () => setClosing(false)}>
      <form className="rfl-form" onSubmit={complete}>
        <p className="rfl-wide">{names.get(current.device_id)} · {stage === 'review' ? '차량 점검을 완료하고 배차 보류를 해제합니다.' : kstDateTime(current.starts_at)}</p>
        {incident && stage === 'open' && <label className="rfl-wide">처리 내용<textarea required maxLength={800} rows={3} value={note} onChange={e => setNote(e.target.value)} /></label>}
        {error && <p role="alert" className="rfl-error rfl-wide">{error}</p>}
        <div className="rfl-form-actions rfl-wide"><BusinessButton disabled={busy} onClick={() => setClosing(false)}>닫기</BusinessButton><button type="submit" className="business-button is-primary" disabled={busy}>{action}</button></div>
      </form>
    </Modal>}
  </div>;
}

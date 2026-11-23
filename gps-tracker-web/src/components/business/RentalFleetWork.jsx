import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { kstDateTime } from '../../lib/businessExport';
import { matchesVehicle } from '../../lib/rentalInventory';
import { isIncident, kstInput, rentalFleetLabel, repairNames, sameId, workStageName, workState } from '../../lib/rentalFleet';
import { Modal } from '../ui';
import { BusinessButton, BusinessEmpty } from './BusinessWorkspace';
import BusinessDrawer from './BusinessDrawer';

export const fleetWorkKey = () => [authScope(), 'rental-fleet-work'];

export function WorkEditor({ devices, contracts, initial, presetVehicleId, incident, onClose, onSave }) {
  const start = Date.now();
  const [requestKey] = useState(() => incident && !initial ? crypto.randomUUID() : undefined);
  const [form, setForm] = useState(() => ({
    device: String(initial?.vehicle_id || devices.find(d=>matchesVehicle(initial,d))?.id || presetVehicleId || devices[0]?.id || ''), contract: String(initial?.contract_id || ''),
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
        request_key: requestKey,
        vehicle_id: Number(form.device), device_id:devices.find(v=>sameId(v.id,form.device))?.device_id ?? null, contract_id: form.contract ? Number(form.contract) : null,
        kind: form.kind, starts_at: new Date(form.from + ':00+09:00').toISOString(),
        ends_at: incident ? null : new Date(form.to + ':00+09:00').toISOString(), note: form.note.trim(),
      });
      onSave(result);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  const title = incident ? '사고·고장 접수' : initial ? '작업 일정 수정' : '세차·정비 일정 등록';
  return <Modal open mobileForm title={title} onClose={busy ? undefined : onClose} size="lg">
    <form className="rfl-form" onSubmit={save} aria-busy={busy}>
      <div className="rfl-form-fields">
        <label>차량<select required disabled={!!initial} value={form.device} onChange={e => change('device', e.target.value)}>
          <option value="">차량 선택</option>{devices.map(d => <option key={d.id} value={d.id}>{rentalFleetLabel(d)}</option>)}
        </select></label>
        <label>작업 구분<select value={form.kind} onChange={e => change('kind', e.target.value)}>
          {Object.entries(repairNames).filter(([key]) => isIncident(key) === incident).map(([key, label]) => <option value={key} key={key}>{label}</option>)}
        </select></label>
        {incident && <label className="rfl-wide">연결 계약<select value={form.contract} onChange={e => change('contract', e.target.value)}>
          <option value="">계약 연결 안 함</option>{contracts.filter(c => matchesVehicle(c,devices.find(v=>sameId(v.id,form.device))) && c.status !== 'cancelled').map(c => <option key={c.id} value={c.id}>#{c.id} · {c.renter_name} · {kstDateTime(c.starts_at)}</option>)}
        </select></label>}
        <label>{incident ? '발생 일시' : '시작 일시'}<input required type="datetime-local" value={form.from} onChange={e => change('from', e.target.value)} /></label>
        {!incident && <label>종료 일시<input required type="datetime-local" value={form.to} onChange={e => change('to', e.target.value)} /></label>}
        <label className="rfl-wide">{incident ? '접수 내용' : '작업 내용'}<textarea required={incident} maxLength={1000} value={form.note} onChange={e => change('note', e.target.value)} rows={3} /></label>
        {error && <p role="alert" className="rfl-error rfl-wide">{error}</p>}
      </div>
      <div className="rfl-form-actions rfl-wide"><BusinessButton disabled={busy} onClick={onClose}>닫기</BusinessButton><button type="submit" className="business-button is-primary" disabled={busy || !form.device}>{busy ? '저장 중…' : '저장'}</button></div>
    </form>
  </Modal>;
}

export default function RentalFleetWork({ incident, devices, branches=[], contracts, work, now, initialId, onVehicles }) {
  const qc = useQueryClient();
  const [status, setStatus] = useState(initialId ? 'all' : 'open'), [deviceId, setDeviceId] = useState(''), [kind, setKind] = useState('');
  const [edit, setEdit] = useState(null), [id, setId] = useState(initialId), [closing, setClosing] = useState(false);
  const [note, setNote] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [branch,setBranch]=useState('');
  const current = work.find(row => sameId(row.id, id)), matching = work.filter(row => isIncident(row.kind) === incident);
  const branchNames=[...new Set([...branches.map(b=>typeof b==='string'?b:b.name),...devices.map(v=>v.branch)].filter(Boolean))].sort();
  const eligible=branch?devices.filter(v=>v.branch===branch):devices;
  const rows = matching.filter(row => (!branch||eligible.some(v=>matchesVehicle(row,v))) && (!kind || row.kind === kind) && (!deviceId || matchesVehicle(row,eligible.find(v=>sameId(v.id,deviceId))))
    && (status === 'all' || (status === 'open' ? workState(row) !== 'done' : workState(row) === 'done')));
  const nameOf = row => { const vehicle=devices.find(v=>matchesVehicle(row,v)); return vehicle ? rentalFleetLabel(vehicle) : '이전 차량'; };
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
        : <BusinessButton icon="car" onClick={onVehicles}>차량 목록</BusinessButton>}</div>
    <div className="rfl-filters">
      <label>소속 지점<select aria-label="소속 지점" value={branch} onChange={e=>{setBranch(e.target.value);setDeviceId('');}}><option value="">전체 지점</option>{branchNames.map(name=><option key={name}>{name}</option>)}</select></label>
      <label>차량<select aria-label="차량" value={deviceId} onChange={e => setDeviceId(e.target.value)}><option value="">전체 차량</option>{eligible.map(d => <option key={d.id} value={d.id}>{rentalFleetLabel(d)}</option>)}</select></label>
      <label>{incident?'접수 구분':'작업 구분'}<select value={kind} onChange={e => setKind(e.target.value)}><option value="">전체 구분</option>{Object.entries(repairNames).filter(([k]) => isIncident(k) === incident).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>{incident?'처리 상태':'진행 상태'}<select value={status} onChange={e => setStatus(e.target.value)}><option value="open">{incident ? '처리·점검 중' : '예정·진행'}</option><option value="done">완료</option><option value="all">전체 상태</option></select></label>
      <div className="rfl-filter-summary"><span>전체 {matching.length}건 중 {rows.length}건 조회</span><BusinessButton className="fleet-filter-reset-link" icon="refresh" onClick={()=>{setBranch('');setDeviceId('');setKind('');setStatus('open');}}>필터 초기화</BusinessButton></div>
    </div>
    <p className="rfl-caption">{incident ? '사고 처리와 차량 점검 상태를 구분해 관리합니다.' : '완료된 작업은 차량 상태와 함께 기록됩니다.'}</p>
    <section className="rfl-card rfl-list-card" aria-label={incident ? '사고·고장 내역' : '세차·정비 내역'}>
      <div className="rfl-table-scroll" tabIndex={0} role="region" aria-label={incident?'사고·고장 목록':'세차·정비 목록'}>
        <table className="rfl-table"><thead><tr>{(incident?['발생 일시','차량','구분','연결 계약','상태','발생 내용']:['차량','작업','시작','종료','상태','작업 내용']).map(label=><th key={label} scope="col">{label}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>
          {incident&&<td>{kstDateTime(row.starts_at)}</td>}<td><button className="rfl-link" onClick={() => setId(row.id)}>{nameOf(row)} <span aria-hidden="true">›</span></button></td>
          <td>{repairNames[row.kind]}</td>{incident?<td>{row.contract_id?'R-'+row.contract_id:'미연결'}</td>:<><td>{kstDateTime(row.starts_at)}</td><td>{row.closed_at||row.ends_at?kstDateTime(row.closed_at||row.ends_at):'—'}</td></>}
          <td><span className="rfl-badge" data-tone={workState(row)==='done'?'ready':'service'}>{workStageName(row)}</span></td><td>{row.note || '—'}</td>
        </tr>)}</tbody></table></div>
      {!rows.length&&<BusinessEmpty title={devices.length ? '조회된 내역이 없습니다.' : '등록된 렌트카 차량이 없습니다.'} />}
    </section>
    {current && <BusinessDrawer title={repairNames[current.kind] + ' 상세'} subtitle={nameOf(current)} onClose={() => setId(null)}>
      <dl className="rfl-facts">
        {[
          ['상태', workStageName(current)], ['차량', nameOf(current)],
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
        <div className="rfl-form-fields">
          <p className="rfl-wide">{nameOf(current)} · {stage === 'review' ? '차량 점검을 완료하고 배차 보류를 해제합니다.' : kstDateTime(current.starts_at)}</p>
          {incident && stage === 'open' && <label className="rfl-wide">처리 내용<textarea required maxLength={800} rows={3} value={note} onChange={e => setNote(e.target.value)} /></label>}
          {error && <p role="alert" className="rfl-error rfl-wide">{error}</p>}
        </div>
        <div className="rfl-form-actions rfl-wide"><BusinessButton disabled={busy} onClick={() => setClosing(false)}>닫기</BusinessButton><button type="submit" className="business-button is-primary" disabled={busy}>{action}</button></div>
      </form>
    </Modal>}
  </div>;
}

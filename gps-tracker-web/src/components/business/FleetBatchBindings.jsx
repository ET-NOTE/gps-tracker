import {useRef, useState} from 'react';
import {api} from '../../api';
import {fleetAssetLabel} from '../../lib/fleetAssets';
import {Modal} from '../ui';
import './fleet-batch-bindings.css';

function snapshot(assets, devices) {
  const terminals = new Map(devices.map(d => [d.id, {
    id: d.id, label: d.display_name || d.device_uid || String(d.id), vehicle: null,
  }]));
  const vehicles = assets.map(v => {
    const active = (v.bindings || []).filter(b => !b.ended_at);
    for (const b of active) {
      if (b.device_id == null) continue;
      const entry = terminals.get(b.device_id) || {id: b.device_id, label: b.terminal_name || String(b.device_id)};
      entry.vehicle = v.id;
      terminals.set(b.device_id, entry);
    }
    return {
      id: v.id, label: fleetAssetLabel(v), version: v.updated_at,
      primary: active.find(b => b.is_primary)?.device_id ?? null,
      incomplete: active.some(b => b.device_id == null),
    };
  });
  return {vehicles, terminals: [...terminals.values()].sort((a, b) => a.label.localeCompare(b.label, 'ko', {numeric: true}))};
}

export default function FleetBatchBindings({assets, devices, onChanged}) {
  const [data, setData] = useState(null);
  const [notice, setNotice] = useState('');
  return <>
    <button type="button" className="business-button" disabled={!assets.length}
      onClick={() => {setNotice(''); setData(snapshot(assets, devices));}}>단말기 일괄 연결</button>
    {notice && <span className="fleet-batch-notice" role="status">{notice}</span>}
    {data && <BindingDialog data={data} onClose={() => setData(null)} onSaved={count => {
      setData(null);
      setNotice(`차량 ${count}대 연결 변경 완료`);
      onChanged();
    }}/>}
  </>;
}

function BindingDialog({data: {vehicles, terminals}, onClose, onSaved}) {
  const [selected, setSelected] = useState([]);
  const [step, setStep] = useState('vehicles');
  const [targets, setTargets] = useState({});
  const [primaries, setPrimaries] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const submitting = useRef(false);
  const chosen = vehicles.filter(v => selected.includes(v.id));
  const available = terminals.filter(t => t.vehicle == null || selected.includes(t.vehicle));
  const targetOf = t => Object.hasOwn(targets, t.id) ? targets[t.id] : t.vehicle;
  const plans = chosen.map(v => {
    const before = available.filter(t => t.vehicle === v.id);
    const after = available.filter(t => targetOf(t) === v.id);
    const preferred = primaries[v.id] ?? v.primary;
    const primary = after.find(t => t.id === preferred)?.id ?? after.find(t => t.id === v.primary)?.id ?? after[0]?.id ?? null;
    const changed = primary !== v.primary || before.length !== after.length || before.some(t => targetOf(t) !== v.id);
    return {vehicle: v, before, after, primary, changed};
  });
  const changes = plans.filter(p => p.changed);
  const overLimit = plans.some(p => p.after.length > 20);
  const names = (list, primary) => list.map(t => t.label + (t.id === primary ? ' (대표)' : '')).join(', ') || '미연결';
  const vehicleName = id => vehicles.find(v => v.id === id)?.label || '미연결';
  const back = () => {
    setError('');
    if (step === 'review') setStep('assign');
    else {setTargets({}); setPrimaries({}); setStep('vehicles');}
  };
  async function save() {
    if (submitting.current || !changes.length || overLimit) return;
    submitting.current = true;
    setSaving(true);
    setError('');
    try {
      await api.connectFleetVehicles({vehicles: changes.map(({vehicle, after, primary}) => ({
        vehicle_id: vehicle.id, updated_at: vehicle.version, device_ids: after.map(t => t.id), primary_device_id: primary,
      }))});
    } catch (e) {
      setError(e.message || '연결 변경을 저장하지 못했습니다. 다시 시도해 주세요.');
      submitting.current = false;
      setSaving(false);
      return;
    }
    onSaved(changes.length);
  }
  const action = (label, onClick, disabled, primary = false) =>
    <button type="button" className={`business-button${primary ? ' is-primary' : ''}`} onClick={onClick} disabled={disabled}>{label}</button>;
  const title = {vehicles: '차량 선택', assign: '단말기 배정', review: '변경 확인'}[step];
  return <Modal open size="xl" title={`단말기 일괄 연결 · ${title}`} onClose={saving ? undefined : onClose}
    footer={<div className="fleet-batch-actions">
      {step !== 'vehicles' && action('이전', back, saving)}
      {action('취소', onClose, saving)}
      {step === 'vehicles' && action('단말기 배정', () => setStep('assign'), !selected.length, true)}
      {step === 'assign' && action('변경 확인', () => setStep('review'), !changes.length || overLimit, true)}
      {step === 'review' && action(saving ? '저장 중…' : `차량 ${changes.length}대 저장`, save, saving, true)}
    </div>}>
    <div className="fleet-batch-body">
      {step === 'vehicles' && <>
        <p>연결을 변경할 차량을 선택해 주세요. 단말기를 옮기려면 기존 차량과 새 차량을 함께 선택해 주세요.</p>
        <fieldset><legend>대상 차량 ({selected.length}대)</legend>
          {vehicles.map(v => <label className="fleet-batch-vehicle" key={v.id}>
            <input type="checkbox" checked={selected.includes(v.id)} disabled={v.incomplete || (!selected.includes(v.id) && selected.length >= 100)}
              onChange={e => setSelected(e.target.checked ? [...selected, v.id] : selected.filter(id => id !== v.id))}/>
            {v.label}{v.incomplete && <small>단말기 정보 확인 필요</small>}
          </label>)}
        </fieldset>
      </>}
      {step === 'assign' && <>
        <fieldset><legend>단말기별 연결 차량</legend>
          {!available.length && <p>선택한 차량에 배정할 단말기가 없습니다.</p>}
          {available.map(t => <label className="fleet-batch-row" key={t.id}>
            <span>{t.label}<small>현재 {vehicleName(t.vehicle)}</small></span>
            <select aria-label={`${t.label} 연결 차량`} value={targetOf(t) ?? ''} onChange={e => setTargets({...targets, [t.id]: Number(e.target.value) || null})}>
              <option value="">미연결</option>{chosen.map(v => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>)}
        </fieldset>
        {plans.some(p => p.after.length > 0) && <fieldset><legend>차량별 대표 단말기</legend>
          {plans.filter(p => p.after.length).map(({vehicle, after, primary}) => <label className="fleet-batch-row" key={vehicle.id}>
            <span>{vehicle.label}</span>
            <select aria-label={`${vehicle.label} 대표 단말기`} value={primary} onChange={e => setPrimaries({...primaries, [vehicle.id]: Number(e.target.value)})}>
              {after.map(t => <option key={t.id} value={t.id}>{t.label}</option>)}
            </select>
          </label>)}
        </fieldset>}
        {overLimit && <p role="alert">차량 한 대에는 단말기를 최대 20대까지 연결할 수 있습니다.</p>}
      </>}
      {step === 'review' && <fieldset><legend>변경할 차량 {changes.length}대</legend>
        {changes.map(({vehicle, before, after, primary}) => <div className="fleet-batch-review" key={vehicle.id}>
          <strong>{vehicle.label}</strong>
          <dl><dt>현재 연결</dt><dd>{names(before, vehicle.primary)}</dd><dt>변경 후</dt><dd>{names(after, primary)}</dd></dl>
        </div>)}
      </fieldset>}
      {error && <p role="alert">{error}</p>}
    </div>
  </Modal>;
}

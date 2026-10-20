import { useId, useRef, useState } from 'react';
import { api } from '../api';
import Button from './ui/Button';
import FormField, { Input } from './ui/FormField';
import Icon from './Icon';
import CarImage from './CarImage';
import './VehicleCarePanel.css';

const groups = [
  { title: '차량 정보', fields: [
    ['car_plate', '차량 번호', 'text', '예: 123가 4567'], ['car_model', '차종', 'text', '예: 아반떼'],
  ] },
  { title: '정비 일정', fields: [
    ['next_service_date', '다음 정비일', 'date'], ['next_service_km', '다음 정비 주행거리', 'number', 'km'],
  ] },
  { title: '보험·검사', fields: [
    ['insurance_expiry', '보험 만료일', 'date'], ['inspection_expiry', '검사 만료일', 'date'],
  ] },
];
const fields = groups.flatMap(g => g.fields);
export default function VehicleCarePanel({ device, onUpdated }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(([key]) => [key, device[key] ?? ''])));
  const [photo, setPhoto] = useState(device.car_image_url);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(null);
  const picker = useRef(null);
  const helpId = useId();
  async function save(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setStatus(null);
    try {
      const body = Object.fromEntries(fields.map(([key, , type]) => [key, values[key] === '' ? null : type === 'number' ? Number(values[key]) : values[key].trim()]));
      const updated = await api.updateDevice(device.id, body);
      onUpdated?.(updated); setStatus({ ok: true, text: '차량 정보를 저장했습니다.' });
    } catch (e) { setStatus({ ok: false, text: e.message }); } finally { setBusy(false); }
  }
  async function upload(file) {
    if (!file || busy) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setStatus({ ok: false, text: 'JPG, PNG, WebP 사진을 5MB 이하로 선택해 주세요.' }); return;
    }
    setBusy(true); setStatus(null);
    try {
      const res = await api.uploadCarImage(device.id, file);
      setPhoto(res.url); onUpdated?.({ ...device, car_image_url: res.url });
      setStatus({ ok: true, text: '대표 사진을 변경했습니다.' });
    } catch (e) { setStatus({ ok: false, text: e.message }); } finally { setBusy(false); }
  }
  async function removePhoto() {
    setBusy(true); setStatus(null);
    try {
      const updated = await api.updateDevice(device.id, { car_image_url: null });
      setPhoto(null); onUpdated?.(updated); setStatus({ ok: true, text: '대표 사진을 해제했습니다.' });
    } catch (e) { setStatus({ ok: false, text: e.message }); } finally { setBusy(false); }
  }
  return <form className="vehicle-care" onSubmit={save} aria-busy={busy}>
    <p className="vehicle-care-hint">필요한 항목만 입력해 주세요. 사진은 선택하면 바로 저장됩니다.</p>
    <div className="vehicle-photo">
      <div className="vehicle-photo-preview">
        <CarImage deviceId={device.id} version={photo} alt="차량 대표 사진" fallback={<><Icon name="cam" size={26} /><span>대표 사진</span></>} />
      </div>
      <div className="vehicle-photo-actions">
        <Button variant="ghost" disabled={busy} onClick={() => picker.current?.click()} aria-describedby={helpId}>
          <Icon name="upload" size={16} />{photo ? '사진 변경' : '사진 추가'}
        </Button>
        {photo && <Button variant="link" disabled={busy} onClick={removePhoto}>사진 해제</Button>}
        <p id={helpId} className="vehicle-care-hint">JPG · PNG · WebP / 최대 5MB</p>
        <input ref={picker} type="file" hidden accept="image/jpeg,image/png,image/webp" disabled={busy} aria-label="차량 대표 사진 선택"
          onChange={e => { upload(e.target.files[0]); e.target.value = ''; }} />
      </div>
    </div>
    {groups.map(group => <fieldset key={group.title} className="vehicle-care-group" disabled={busy}>
      <legend>{group.title}</legend>
      <div className="vehicle-care-fields">
        {group.fields.map(([key, label, type, placeholder]) => <FormField key={key} label={label} hint={type === 'number' ? '차량의 누적 주행거리 기준 (km)' : undefined}>
          <Input type={type} min={type === 'number' ? 0 : undefined} step={type === 'number' ? 1 : undefined}
            maxLength={100} placeholder={placeholder} value={values[key]} inputMode={type === 'number' ? 'numeric' : undefined}
            onChange={e => { setValues(v => ({ ...v, [key]: e.target.value })); setStatus(null); }} />
        </FormField>)}
      </div>
    </fieldset>)}
    <div className="vehicle-care-footer">
      <Button type="submit" busy={busy} full>{busy ? '처리 중…' : '차량 정보 저장'}</Button>
      {status && <p role={status.ok ? 'status' : 'alert'} className={'form-feedback ' + (status.ok ? 'success' : 'error')}>{status.text}</p>}
    </div>
  </form>;
}

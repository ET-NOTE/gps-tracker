import { useState } from 'react';
import { api } from '../api';

const fields = [
  ['car_plate', '차량 번호', 'text'], ['car_model', '차종', 'text'],
  ['next_service_date', '다음 정비일', 'date'], ['next_service_km', '다음 정비 주행거리 (km)', 'number'],
  ['insurance_expiry', '보험 만료일', 'date'], ['inspection_expiry', '검사 만료일', 'date'],
];
export default function VehicleCarePanel({ device, onUpdated }) {
  const [values, setValues] = useState(() => Object.fromEntries(fields.map(([key]) => [key, device[key] ?? ''])));
  const [photo, setPhoto] = useState(device.car_image_url);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  async function save(e) {
    e.preventDefault(); setBusy(true); setStatus('');
    try {
      const body = Object.fromEntries(fields.map(([key, , type]) => [key, values[key] === '' ? null : type === 'number' ? Number(values[key]) : values[key]]));
      const updated = await api.updateDevice(device.id, body);
      onUpdated?.(updated); setStatus('저장했습니다.');
    } catch (e) { setStatus(e.message); } finally { setBusy(false); }
  }
  async function upload(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { setStatus('사진은 5 MiB 이하로 선택해주세요.'); return; }
    setBusy(true); setStatus('');
    try { const res = await api.uploadCarImage(device.id, file); setPhoto(res.url); onUpdated?.({ ...device, car_image_url: res.url }); }
    catch (e) { setStatus(e.message); } finally { setBusy(false); }
  }
  return <form onSubmit={save} style={{ display: 'grid', gap: 10 }}>
    {photo && <img src={photo} alt="차량 대표 사진" style={{ width: '100%', maxHeight: 180, objectFit: 'contain', borderRadius: 8 }} />}
    <label>대표 사진 (JPEG·PNG·WebP, 최대 5 MiB)<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => upload(e.target.files[0])} /></label>
    {photo && <button type="button" disabled={busy} onClick={async () => {
      setBusy(true); try { const updated = await api.updateDevice(device.id, { car_image_url: null }); setPhoto(null); onUpdated?.(updated); }
      catch (e) { setStatus(e.message); } finally { setBusy(false); }
    }}>대표 사진 해제</button>}
    {fields.map(([key, label, type]) => <label key={key} style={{ display: 'grid', gap: 4 }}>{label}
      <input type={type} min={type === 'number' ? 0 : undefined} maxLength={100} value={values[key]} disabled={busy}
        onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} />
    </label>)}
    <button type="submit" disabled={busy}>{busy ? '처리 중…' : '차량 관리 저장'}</button>
    <div role="status">{status}</div>
  </form>;
}

import { useEffect, useState } from 'react';
import { api } from '../api';
import { confirmDialog } from './Dialog';
import Button from './ui/Button';
import FormField, { Input } from './ui/FormField';
import { toast } from './ui/Toast';
import './ShareLinkPanel.css';

const COST = 5;
const OPTIONS = [[1, '1시간'], [6, '6시간'], [24, '24시간'], [168, '7일'], [720, '30일']];
export default function ShareLinkPanel({ deviceId }) {
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(null);
  const [hours, setHours] = useState(24);
  const [note, setNote] = useState('');
  const [copyUrl, setCopyUrl] = useState('');
  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError('');
    api.listShares(deviceId).then(list => { if (!cancelled) setShares(list); })
      .catch(() => { if (!cancelled) setError('공유 링크를 불러오지 못했습니다. 다시 시도해 주세요.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [deviceId, refresh]);
  function openForm(value) { setForm(value); setHours(24); setNote(''); setError(''); }
  async function copy(token) {
    const prefix = window.location.hostname === 'gps.serial.kr' ? '' : '/gps-tracker/app';
    const url = window.location.origin + prefix + '/s/' + token;
    try { await navigator.clipboard.writeText(url); toast.success('공유 링크를 복사했습니다.'); setCopyUrl(''); }
    catch { setCopyUrl(url); }
  }
  async function save(e) {
    e.preventDefault();
    const value = Number(hours);
    if (busy || !Number.isInteger(value) || value < 1 || value > 720) return;
    setBusy(true); setError('');
    const extending = form !== 'new';
    try {
      if (!await confirmDialog({ title: extending ? '공유 시간 연장' : '공유 링크 만들기',
        body: value + '시간에 ' + (value * COST).toLocaleString() + '포인트가 차감됩니다.',
        confirmLabel: extending ? '연장하기' : '만들기' })) return;
      if (extending) {
        const updated = await api.extendShare(form.id, value);
        setShares(prev => prev.map(x => x.id === updated.id ? updated : x));
        toast.success('공유 시간을 연장했습니다.');
      } else {
        const created = await api.createShare(deviceId, { ttl_hours: value, note: note.trim() || null });
        setShares(prev => [created, ...prev]);
        await copy(created.token);
      }
      setForm(null);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function revoke(id) {
    if (busy) return;
    setBusy(true); setError('');
    try {
      if (!await confirmDialog({ title: '공유 링크 해제', body: '이 링크로 위치를 볼 수 없게 됩니다. 남은 시간의 포인트는 환불되지 않습니다.', confirmLabel: '해제하기', danger: true })) return;
      await api.revokeShare(id);
      setShares(prev => prev.filter(x => x.id !== id));
      toast.success('공유 링크를 해제했습니다.');
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const active = shares.filter(s => !s.revoked_at && new Date(s.expires_at) > new Date());
  return <div className="share-panel" aria-busy={busy || loading}>
    <p className="share-help">선택한 시간 동안 링크를 받은 사람이 이 장치의 위치를 볼 수 있습니다.</p>
    {loading && <p className="share-help" role="status">공유 링크를 불러오는 중…</p>}
    {error && <div role="alert" className="share-error">{error}
      {!form && <Button variant="ghost" disabled={busy} onClick={() => setRefresh(v => v + 1)}>다시 불러오기</Button>}
    </div>}
    {!loading && !error && active.length === 0 && <div className="share-empty">사용 중인 공유 링크가 없습니다.</div>}
    {active.map(sh => <article className="share-card" key={sh.id}>
      <strong>{sh.note || '위치 공유 링크'}</strong>
      <p className="share-help">만료 {new Date(sh.expires_at).toLocaleString('ko-KR')} · 조회 {sh.view_count}회</p>
      <div className="share-actions">
        <Button variant="ghost" disabled={busy} onClick={() => copy(sh.token)}>링크 복사</Button>
        <Button variant="ghost" disabled={busy} onClick={() => openForm(sh)}>시간 연장</Button>
        <Button variant="link" disabled={busy} onClick={() => revoke(sh.id)} style={{ color: 'var(--danger)' }}>공유 해제</Button>
      </div>
    </article>)}
    {copyUrl && <FormField label="공유 링크" hint="복사 권한이 없어 자동 복사하지 못했습니다. 주소를 길게 눌러 복사해 주세요.">
      <Input readOnly value={copyUrl} onFocus={e => e.target.select()} />
    </FormField>}
    {form ? <form className="share-form" onSubmit={save}>
      <strong>{form === 'new' ? '새 공유 링크' : '공유 시간 연장'}</strong>
      <div className="share-duration" role="group" aria-label="공유 시간 선택">
        {OPTIONS.map(([v,label]) => <Button key={v} variant={Number(hours) === v ? 'primary' : 'ghost'} disabled={busy}
          aria-pressed={Number(hours) === v} onClick={() => setHours(v)}>{label}</Button>)}
      </div>
      {form !== 'new' && <FormField label="연장할 시간" hint="1~720시간 사이의 정수로 입력해 주세요.">
        <Input type="number" min="1" max="720" step="1" required value={hours} disabled={busy} onChange={e => setHours(e.target.value)} />
      </FormField>}
      {form === 'new' && <FormField label="메모 (선택)">
        <Input value={note} maxLength={100} placeholder="예: 업무용 위치 공유" disabled={busy} onChange={e => setNote(e.target.value)} />
      </FormField>}
      <p className="share-cost">사용 포인트 <strong>{(Number(hours || 0) * COST).toLocaleString()} P</strong><span>시간당 {COST} P</span></p>
      <div className="share-actions">
        <Button type="submit" busy={busy}>{busy ? '처리 중…' : form === 'new' ? '만들고 복사하기' : '시간 연장하기'}</Button>
        <Button variant="ghost" disabled={busy} onClick={() => setForm(null)}>취소</Button>
      </div>
    </form> : <Button variant="ghost" full disabled={busy || loading || !!error} onClick={() => openForm('new')}>새 공유 링크 만들기</Button>}
  </div>;
}

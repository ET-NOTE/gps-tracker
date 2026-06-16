// 공유 링크 패널 — 생성/복사/철회/연장.
// 과금: 1시간당 5 포인트 (백엔드 share::CREDITS_PER_HOUR 와 일치).
import { useEffect, useState } from 'react';
import { api } from '../api';

// 백엔드와 동기화. 다르면 미리보기와 실제 차감액 어긋나니 한쪽 바꾸면 같이 갱신.
const CREDITS_PER_HOUR = 5;
const MAX_TTL_HOURS    = 720;   // 30일

const TTL_OPTIONS = [
  { v: 1,    label: '1시간' },
  { v: 6,    label: '6시간' },
  { v: 24,   label: '24시간' },
  { v: 168,  label: '7일' },
  { v: 720,  label: '30일' },
];

export default function ShareLinkPanel({ deviceId }) {
  const [shares, setShares] = useState([]);
  const [loading, setLoading] = useState(false);
  const [ttl, setTtl] = useState(24);
  const [note, setNote] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const list = await api.listShares(deviceId);
      setShares(list);
    } catch {} finally {
      setLoading(false);
    }
  }
  useEffect(() => { load(); }, [deviceId]);

  async function handleCreate() {
    const cost = ttl * CREDITS_PER_HOUR;
    if (!confirm(`공유 링크를 ${ttl}시간 동안 활성화합니다. ${cost.toLocaleString()} 포인트가 차감됩니다.`)) return;
    setBusy(true);
    try {
      const sh = await api.createShare(deviceId, { ttl_hours: ttl, note: note || null });
      setShares(prev => [sh, ...prev]);
      const url = buildUrl(sh.token);
      try { await navigator.clipboard.writeText(url); alert('링크가 클립보드에 복사되었습니다.\n' + url); }
      catch { prompt('링크를 복사하세요:', url); }
      setShowForm(false);
      setNote('');
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function handleRevoke(id) {
    if (!confirm('이 공유 링크를 철회하시겠습니까?\n남은 포인트는 환불되지 않습니다.')) return;
    try {
      await api.revokeShare(id);
      setShares(prev => prev.map(x => x.id === id ? { ...x, revoked_at: new Date().toISOString() } : x));
    } catch (e) { alert(e.message); }
  }

  async function handleCopy(token) {
    const url = buildUrl(token);
    try { await navigator.clipboard.writeText(url); alert('복사됨: ' + url); }
    catch { prompt('링크를 복사하세요:', url); }
  }

  async function handleExtend(sh) {
    // 가장 큰 정수만 선택지 — 1, 6, 24, 168, 720 같은 옵션을 prompt 로.
    const v = prompt(
      `연장할 시간 (1~${MAX_TTL_HOURS} 시간)을 입력하세요.\n` +
      `현재 만료: ${new Date(sh.expires_at).toLocaleString('ko-KR')}\n` +
      `시간당 ${CREDITS_PER_HOUR} 포인트 차감 — 예: 24시간 = ${24 * CREDITS_PER_HOUR}포인트`,
      '24'
    );
    if (v == null) return;
    const hours = parseInt(v, 10);
    if (!(hours >= 1 && hours <= MAX_TTL_HOURS)) {
      alert('잘못된 입력입니다.');
      return;
    }
    const cost = hours * CREDITS_PER_HOUR;
    if (!confirm(`+${hours} 시간 연장 — ${cost.toLocaleString()} 포인트 차감.`)) return;
    try {
      const updated = await api.extendShare(sh.id, hours);
      setShares(prev => prev.map(x => x.id === sh.id ? updated : x));
    } catch (e) { alert(e.message); }
  }

  const active = shares.filter(s => !s.revoked_at && new Date(s.expires_at) > new Date());
  const previewCost = ttl * CREDITS_PER_HOUR;

  return (
    <div style={{ marginTop: 8 }}>
      <div style={s.title}>공유 링크</div>

      {loading && <div style={s.muted}>로딩...</div>}

      {!loading && active.length === 0 && !showForm && (
        <div style={s.muted}>활성 링크 없음</div>
      )}

      {active.map(sh => (
        <div key={sh.id} style={s.row}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={s.token}>…{sh.token.slice(-8)}</div>
            <div style={s.subline}>
              만료 {fmtRelative(sh.expires_at)} · 조회 {sh.view_count}
              {sh.credits_spent ? ` · ${sh.credits_spent.toLocaleString()}포인트 사용` : ''}
              {sh.note && <> · {sh.note}</>}
            </div>
          </div>
          <button onClick={() => handleCopy(sh.token)} style={s.btn}>복사</button>
          <button onClick={() => handleExtend(sh)} style={s.btn}>연장</button>
          <button onClick={() => handleRevoke(sh.id)} style={{ ...s.btn, color: 'var(--danger)' }}>철회</button>
        </div>
      ))}

      {showForm ? (
        <div style={{ marginTop: 6, padding: 8, background: 'var(--surface-2)', borderRadius: 6 }}>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 6 }}>
            {TTL_OPTIONS.map(o => (
              <button key={o.v} onClick={() => setTtl(o.v)} style={{
                padding: '4px 8px', fontSize: 11, borderRadius: 4, border: 'none', cursor: 'pointer',
                background: ttl === o.v ? 'var(--primary)' : 'var(--surface)',
                color:      ttl === o.v ? 'var(--primary-fg)' : 'var(--text-2)',
              }}>{o.label}</button>
            ))}
          </div>
          <input placeholder="메모 (선택, 예: 김기사님)"
            value={note} onChange={e => setNote(e.target.value)}
            style={{ width: '100%', padding: 6, fontSize: 12, marginBottom: 6, boxSizing: 'border-box',
                     background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text)' }} />
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
            차감: <b>{previewCost.toLocaleString()}</b> 포인트 ({ttl}시간 × {CREDITS_PER_HOUR})
          </div>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={handleCreate} disabled={busy} style={{ ...s.btn, flex: 1, background: 'var(--primary)', color: 'var(--primary-fg)' }}>
              {busy ? '...' : '생성 + 복사'}
            </button>
            <button onClick={() => setShowForm(false)} style={{ ...s.btn, background: 'var(--surface)' }}>취소</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)} style={{
          marginTop: 6, padding: 6, width: '100%', fontSize: 12,
          background: 'var(--surface-2)', color: 'var(--text)', border: '1px dashed var(--border)',
          borderRadius: 4, cursor: 'pointer',
        }}>+ 새 공유 링크</button>
      )}
    </div>
  );
}

function buildUrl(token) {
  // 도메인별 prefix 분기:
  //   gps.serial.kr → /s/<token> (clean root)
  //   기타          → /gps-tracker/app/s/<token>
  const origin = window.location.origin;
  if (window.location.hostname === 'gps.serial.kr') {
    return `${origin}/s/${token}`;
  }
  return `${origin}/gps-tracker/app/s/${token}`;
}

function fmtRelative(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return '만료됨';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}분 후`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h 후`;
  return `${Math.floor(h / 24)}일 후`;
}

const s = {
  title: { fontSize: 11, fontWeight: 'bold', color: '#aaa', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 },
  muted: { color: '#666', fontSize: 12, fontStyle: 'italic' },
  row:   { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 0', fontSize: 12 },
  token: { fontFamily: 'monospace', fontSize: 11, color: 'var(--text)' },
  subline: { fontSize: 10, color: 'var(--text-3)', marginTop: 2 },
  btn: {
    padding: '4px 8px', fontSize: 11, border: 'none', borderRadius: 4,
    background: 'var(--surface-2)', color: 'var(--text)', cursor: 'pointer',
  },
};

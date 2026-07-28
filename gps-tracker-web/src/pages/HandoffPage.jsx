// (2026-07-28) Stage-R9-a: 렌트카 임차인 self-handoff 페이지 (auth-free).
//
// 링크 예: https://gps.serial.kr/handoff/{22자토큰}
// 흐름: 요약 확인 → 오도미터 사진 촬영 → 서명 → 제출.
// pickup / return 두 케이스 지원 (백엔드 purpose 로 분기).

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';

const RATE_LABEL = { hourly: '시간', daily: '일', monthly: '개월' };

export default function HandoffPage({ token }) {
  const [view,  setView]  = useState(null);
  const [error, setError] = useState(null);
  const [step,  setStep]  = useState('summary');   // summary → photo → sign → submitting → done
  const [odometer, setOdometer] = useState('');
  const [nameConfirm, setNameConfirm] = useState('');
  const [photoDataUrl, setPhotoDataUrl] = useState(null);
  const [signatureSvg, setSignatureSvg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  useEffect(() => {
    if (!token) return;
    api.handoffView(token).then(v => {
      setView(v);
      if (v.pickup_odometer_km != null && v.purpose === 'return') {
        // return 은 이미 pickup 시 오도미터 있음. 참고용으로 힌트만.
      }
    }).catch(e => setError(e.message));
  }, [token]);

  const purposeLabel = view?.purpose === 'pickup' ? '차량 인수' : '차량 반납';

  if (error) return <ErrorScreen title="링크를 열 수 없습니다" body={error} />;
  if (!view) return <div style={sx.loading}>로딩 중...</div>;

  if (view.status === 'revoked')  return <ErrorScreen title="취소된 링크" body="임대인이 이 링크를 취소했습니다." />;
  if (view.status === 'expired')  return <ErrorScreen title="만료된 링크" body="새 링크를 요청해주세요." />;
  if (view.status === 'used' && step !== 'done') {
    return <ErrorScreen title="이미 제출됨" body={`이 링크는 ${new Date(view.used_at).toLocaleString('ko-KR')} 에 제출되었습니다.`} />;
  }

  async function submit() {
    if (!odometer)      { setSubmitError('오도미터를 입력해주세요.'); return; }
    if (!photoDataUrl)  { setSubmitError('오도미터 사진이 필요합니다.'); return; }
    if (!signatureSvg)  { setSubmitError('서명이 필요합니다.'); return; }
    setBusy(true); setSubmitError(null); setStep('submitting');
    try {
      await api.handoffSubmit(token, {
        odometer_km:            Number(odometer),
        photo_data_url:         photoDataUrl,
        signature_svg:          signatureSvg,
        renter_confirmed_name:  nameConfirm.trim() || null,
      });
      setStep('done');
    } catch (e) {
      setSubmitError(e.message);
      setStep('sign');   // 다시 서명 단계로
    } finally { setBusy(false); }
  }

  return (
    <div style={sx.wrap}>
      <div style={sx.card}>
        <div style={sx.header}>
          <div style={sx.company}>{view.company_name || '렌트카'}</div>
          <div style={sx.badge}>{purposeLabel}</div>
        </div>
        <ContractSummary view={view} />

        {step === 'summary' && (
          <>
            <div style={sx.hint}>
              아래 순서로 진행됩니다.<br/>
              1. 오도미터 사진 촬영 · 수치 입력<br/>
              2. 서명<br/>
              3. 제출
            </div>
            <button onClick={() => setStep('photo')} style={sx.btnPrimary}>시작하기</button>
          </>
        )}

        {step === 'photo' && (
          <PhotoStep
            purpose={view.purpose}
            odometer={odometer} setOdometer={setOdometer}
            photoDataUrl={photoDataUrl} setPhotoDataUrl={setPhotoDataUrl}
            onNext={() => setStep('sign')}
            onBack={() => setStep('summary')}
            pickupOdometer={view.pickup_odometer_km}
          />
        )}

        {step === 'sign' && (
          <SignStep
            renterName={view.renter_name}
            nameConfirm={nameConfirm} setNameConfirm={setNameConfirm}
            onSignature={setSignatureSvg}
            onBack={() => setStep('photo')}
            onSubmit={submit}
            busy={busy}
            error={submitError}
          />
        )}

        {step === 'submitting' && <div style={sx.loading}>제출 중...</div>}

        {step === 'done' && (
          <div style={{ padding: 20, textAlign: 'center' }}>
            <div style={{ fontSize: 48 }}>✅</div>
            <div style={{ fontSize: 18, fontWeight: 800, margin: '8px 0' }}>{purposeLabel} 완료</div>
            <div style={{ fontSize: 13, color: '#666' }}>임대인에게 자동으로 알림이 전송되었습니다.</div>
          </div>
        )}
      </div>
    </div>
  );
}

function ContractSummary({ view }) {
  return (
    <div style={sx.summary}>
      <Row label="차량" value={`${view.license_plate || ''} ${view.device_name || ''}`.trim() || '-'} />
      <Row label="임차인" value={view.renter_name} />
      <Row label="기간"
        value={`${fmt(view.starts_at)} ~ ${fmt(view.ends_at)}`} />
      <Row label="요금"
        value={`${(view.rate_amount_krw || 0).toLocaleString()}원 / ${RATE_LABEL[view.rate_type] || view.rate_type}`} />
      {view.deposit_krw > 0 && (
        <Row label="보증금" value={`${view.deposit_krw.toLocaleString()}원`} />
      )}
    </div>
  );
}

function Row({ label, value }) {
  return (
    <div style={sx.row}>
      <span style={sx.rowLabel}>{label}</span>
      <span style={sx.rowValue}>{value}</span>
    </div>
  );
}

// ─── STEP: 사진 ────────────────────────────────────
function PhotoStep({ purpose, odometer, setOdometer, photoDataUrl, setPhotoDataUrl, onNext, onBack, pickupOdometer }) {
  const inputRef = useRef();

  function handleFile(f) {
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        // 1600px 최장변으로 리사이즈 → JPEG 0.8
        const maxSide = 1600;
        const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        setPhotoDataUrl(canvas.toDataURL('image/jpeg', 0.8));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(f);
  }

  return (
    <>
      <div style={sx.stepTitle}>1. 오도미터 확인</div>
      {pickupOdometer != null && purpose === 'return' && (
        <div style={sx.hintBox}>
          인수 시 오도미터: <b>{pickupOdometer.toLocaleString()} km</b>
        </div>
      )}
      <input
        type="number"
        value={odometer}
        onChange={e => setOdometer(e.target.value)}
        placeholder="현재 오도미터 (km)"
        style={sx.input}
        inputMode="numeric"
      />
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={e => handleFile(e.target.files?.[0])}
        style={{ display: 'none' }}
      />
      <button onClick={() => inputRef.current?.click()} style={sx.btnSecondary}>
        {photoDataUrl ? '📷 다시 촬영' : '📷 오도미터 사진 촬영'}
      </button>
      {photoDataUrl && (
        <img src={photoDataUrl} alt="odometer" style={sx.thumb} />
      )}
      <div style={sx.stepBtns}>
        <button onClick={onBack} style={sx.btnGhost}>이전</button>
        <button
          onClick={onNext}
          disabled={!odometer || !photoDataUrl}
          style={{ ...sx.btnPrimary, opacity: (!odometer || !photoDataUrl) ? 0.5 : 1 }}
        >다음</button>
      </div>
    </>
  );
}

// ─── STEP: 서명 ───────────────────────────────────
function SignStep({ renterName, nameConfirm, setNameConfirm, onSignature, onBack, onSubmit, busy, error }) {
  const canvasRef = useRef();
  const drawing = useRef(false);
  const paths = useRef([]);   // Array<Array<{x,y}>>
  const [hasStrokes, setHasStrokes] = useState(false);

  function pos(e) {
    const c = canvasRef.current;
    const rect = c.getBoundingClientRect();
    const t = e.touches?.[0] || e.changedTouches?.[0];
    const cx = t ? t.clientX : e.clientX;
    const cy = t ? t.clientY : e.clientY;
    return { x: (cx - rect.left) * (c.width / rect.width),
             y: (cy - rect.top)  * (c.height / rect.height) };
  }
  function start(e) {
    e.preventDefault();
    drawing.current = true;
    paths.current.push([pos(e)]);
    setHasStrokes(true);
  }
  function move(e) {
    if (!drawing.current) return;
    e.preventDefault();
    const p = pos(e);
    paths.current[paths.current.length - 1].push(p);
    const ctx = canvasRef.current.getContext('2d');
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const line = paths.current[paths.current.length - 1];
    if (line.length >= 2) {
      const a = line[line.length - 2];
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
    }
  }
  function end() { drawing.current = false; }

  function clear() {
    paths.current = [];
    setHasStrokes(false);
    const c = canvasRef.current;
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  function buildSvg() {
    const c = canvasRef.current;
    const w = c.width, h = c.height;
    const pathD = paths.current.map(line => {
      if (!line.length) return '';
      const [first, ...rest] = line;
      return `M${first.x.toFixed(1)},${first.y.toFixed(1)} ` +
             rest.map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    }).join(' ');
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">` +
      `<path d="${pathD}" fill="none" stroke="#111" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  }

  async function handleSubmit() {
    if (!hasStrokes) { alert('서명이 필요합니다.'); return; }
    onSignature(buildSvg());
    // parent state update async — 다음 tick 에 submit 이 signatureSvg 를 사용
    setTimeout(onSubmit, 0);
  }

  return (
    <>
      <div style={sx.stepTitle}>2. 서명</div>
      <div style={sx.hintBox}>
        임차인 이름: <b>{renterName}</b>
      </div>
      <input
        value={nameConfirm}
        onChange={e => setNameConfirm(e.target.value)}
        placeholder="본인 확인용 이름 재입력 (선택)"
        style={sx.input}
      />
      <div style={sx.signCanvasWrap}>
        <canvas
          ref={canvasRef}
          width={600} height={220}
          onMouseDown={start} onMouseMove={move} onMouseUp={end} onMouseLeave={end}
          onTouchStart={start} onTouchMove={move} onTouchEnd={end}
          style={sx.signCanvas}
        />
        {!hasStrokes && (
          <div style={sx.signPlaceholder}>여기에 서명해주세요</div>
        )}
      </div>
      <button onClick={clear} style={{ ...sx.btnGhost, fontSize: 12 }}>지우기</button>
      {error && <div style={{ color: '#EF4444', fontSize: 13 }}>{error}</div>}
      <div style={sx.stepBtns}>
        <button onClick={onBack} disabled={busy} style={sx.btnGhost}>이전</button>
        <button onClick={handleSubmit} disabled={busy || !hasStrokes} style={sx.btnPrimary}>
          {busy ? '제출 중...' : '제출'}
        </button>
      </div>
    </>
  );
}

function ErrorScreen({ title, body }) {
  return (
    <div style={sx.wrap}>
      <div style={sx.card}>
        <div style={{ fontSize: 48, textAlign: 'center' }}>⚠️</div>
        <div style={{ fontSize: 18, fontWeight: 800, textAlign: 'center', margin: '8px 0' }}>{title}</div>
        <div style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>{body}</div>
      </div>
    </div>
  );
}

function fmt(iso) {
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
}

const sx = {
  wrap: {
    minHeight: '100vh', background: '#F5F5F7',
    display: 'flex', justifyContent: 'center', padding: '16px',
  },
  card: {
    background: '#FFF', borderRadius: 12, padding: 20,
    width: '100%', maxWidth: 480,
    display: 'flex', flexDirection: 'column', gap: 12,
    boxShadow: '0 2px 10px rgba(0,0,0,0.06)',
  },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  company: { fontSize: 16, fontWeight: 800, color: '#111' },
  badge: {
    padding: '4px 10px', borderRadius: 999,
    background: '#EEF2FF', color: '#3B82F6',
    fontSize: 12, fontWeight: 700,
  },
  summary: {
    background: '#F9FAFB', padding: 12, borderRadius: 8,
    display: 'flex', flexDirection: 'column', gap: 4,
  },
  row: { display: 'flex', justifyContent: 'space-between', fontSize: 13 },
  rowLabel: { color: '#666', minWidth: 60 },
  rowValue: { fontWeight: 600, color: '#111', textAlign: 'right', flex: 1 },
  hint: { fontSize: 13, color: '#666', lineHeight: 1.6, padding: 8 },
  hintBox: {
    padding: '8px 10px', background: '#EEF2FF', borderRadius: 6,
    fontSize: 12, color: '#3B82F6',
  },
  stepTitle: { fontSize: 14, fontWeight: 800, color: '#111' },
  stepBtns: { display: 'flex', gap: 8, marginTop: 8 },
  btnPrimary: {
    flex: 1, padding: '14px', borderRadius: 8, border: 'none',
    background: '#3B82F6', color: '#FFF', fontSize: 14, fontWeight: 700,
    cursor: 'pointer',
  },
  btnSecondary: {
    padding: '14px', borderRadius: 8, border: '1px solid #3B82F6',
    background: '#EEF2FF', color: '#3B82F6', fontSize: 14, fontWeight: 700,
    cursor: 'pointer',
  },
  btnGhost: {
    flex: 1, padding: '14px', borderRadius: 8, border: '1px solid #E5E7EB',
    background: '#FFF', color: '#374151', fontSize: 14, fontWeight: 600,
    cursor: 'pointer',
  },
  input: {
    padding: '12px 14px', borderRadius: 8, border: '1px solid #E5E7EB',
    fontSize: 14, outline: 'none',
  },
  thumb: {
    maxWidth: '100%', maxHeight: 240, borderRadius: 8, objectFit: 'contain',
    border: '1px solid #E5E7EB',
  },
  signCanvasWrap: { position: 'relative' },
  signCanvas: {
    width: '100%', height: 180, background: '#FFF',
    border: '2px dashed #E5E7EB', borderRadius: 8, touchAction: 'none',
    display: 'block',
  },
  signPlaceholder: {
    position: 'absolute', top: '50%', left: '50%',
    transform: 'translate(-50%, -50%)',
    color: '#C7C7CC', fontSize: 14, pointerEvents: 'none',
  },
  loading: { padding: 40, textAlign: 'center', color: '#666' },
};

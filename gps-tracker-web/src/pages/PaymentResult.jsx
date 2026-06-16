// /payments/toss/success 와 /payments/toss/fail 두 경로에서 렌더.
// Toss 가 결제 결과와 함께 redirect 보낸 query string 을 받아서:
//   success → 백엔드 /payments/toss/confirm 호출 → 잔액 갱신 → 메인으로 복귀
//   fail    → 백엔드 /payments/toss/fail 마킹 → 메인으로 복귀
//
// 이 페이지는 App 의 라우팅 단계에서 분기 (App.jsx).
import { useEffect, useState } from 'react';
import { api } from '../api';

export default function PaymentResult({ kind }) {
  // kind: 'success' | 'fail'
  const params = new URLSearchParams(window.location.search);
  const orderId    = params.get('orderId') || '';
  const paymentKey = params.get('paymentKey') || '';
  const amount     = parseInt(params.get('amount') || '0', 10);
  const code       = params.get('code') || '';
  const message    = params.get('message') || '';

  const [status, setStatus] = useState('processing');   // processing|done|error
  const [info, setInfo]     = useState(null);
  const [error, setError]   = useState(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (kind === 'success') {
          if (!orderId || !paymentKey || !amount) {
            throw new Error('결제 정보가 누락됐습니다.');
          }
          const r = await api.tossConfirm({ paymentKey, orderId, amount });
          if (cancelled) return;
          setInfo(r);
          setStatus('done');
        } else {
          await api.tossMarkFailed(orderId, code, message);
          if (cancelled) return;
          setStatus('done');
        }
      } catch (e) {
        if (cancelled) return;
        setError(e.message || '오류');
        setStatus('error');
      }
    })();
    return () => { cancelled = true; };
  }, [kind, orderId, paymentKey, amount, code, message]);

  function goHome() {
    // SPA 가 아닌 location 변경 — 결과 query 정리
    window.location.replace(window.location.pathname.startsWith('/gps-tracker/app/')
      ? '/gps-tracker/app/'
      : '/');
  }

  const ok       = kind === 'success' && status === 'done' && info?.status === 'confirmed';
  const waiting  = kind === 'success' && status === 'done' && info?.status === 'waiting';
  const isFail   = kind === 'fail' || status === 'error';

  return (
    <div style={s.root}>
      <div style={s.card}>
        {status === 'processing' && (
          <>
            <div style={s.spinner} />
            <div style={s.title}>결제 처리 중...</div>
            <div style={s.sub}>잠시만 기다려주세요</div>
          </>
        )}
        {ok && (
          <>
            <div style={{ ...s.icon, color: 'var(--accent)' }}>✓</div>
            <div style={s.title}>결제 완료</div>
            <div style={s.sub}>
              {info?.amount?.toLocaleString()}원 충전됐습니다.<br/>
              잔액: <b>{info?.balance?.toLocaleString()}원</b>
            </div>
            <button onClick={goHome} style={s.btnPrimary}>홈으로</button>
          </>
        )}
        {waiting && (
          <>
            <div style={{ ...s.icon, color: 'var(--warning, #fbbf24)' }}>⌛</div>
            <div style={s.title}>가상계좌 발급 완료</div>
            <div style={s.sub}>
              아래 계좌로 <b>{info?.amount?.toLocaleString()}원</b>을 입금해주세요.<br/>
              입금이 확인되면 자동으로 포인트가 적립됩니다.
            </div>
            {info?.virtual_account && (
              <div style={s.vaBox}>
                <div style={s.vaRow}>
                  <span style={s.vaK}>은행</span>
                  <span style={s.vaV}>{info.virtual_account.bank || info.virtual_account.bankCode || '—'}</span>
                </div>
                <div style={s.vaRow}>
                  <span style={s.vaK}>계좌번호</span>
                  <span style={{ ...s.vaV, fontFamily: 'monospace', fontSize: 15 }}>
                    {info.virtual_account.accountNumber || '—'}
                  </span>
                </div>
                <div style={s.vaRow}>
                  <span style={s.vaK}>예금주</span>
                  <span style={s.vaV}>{info.virtual_account.customerName || info.virtual_account.accountHolderName || '—'}</span>
                </div>
                {info.virtual_account.dueDate && (
                  <div style={s.vaRow}>
                    <span style={s.vaK}>입금 마감</span>
                    <span style={s.vaV}>
                      {new Date(info.virtual_account.dueDate).toLocaleString('ko-KR')}
                    </span>
                  </div>
                )}
              </div>
            )}
            <button onClick={goHome} style={s.btnPrimary}>홈으로</button>
          </>
        )}
        {isFail && status !== 'processing' && (
          <>
            <div style={{ ...s.icon, color: 'var(--danger)' }}>!</div>
            <div style={s.title}>{kind === 'fail' ? '결제 취소/실패' : '결제 처리 오류'}</div>
            <div style={s.sub}>
              {error || message || code || '사용자 취소 또는 결제 실패'}
            </div>
            <button onClick={goHome} style={s.btnPrimary}>홈으로</button>
          </>
        )}
      </div>
    </div>
  );
}

const s = {
  root: {
    minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: 'var(--bg)', padding: 16,
  },
  card: {
    width: '100%', maxWidth: 360,
    background: 'var(--surface)', border: '1px solid var(--border)',
    borderRadius: 14, padding: '32px 24px',
    textAlign: 'center',
  },
  spinner: {
    width: 36, height: 36, margin: '0 auto 16px',
    border: '3px solid var(--surface-2)',
    borderTopColor: 'var(--primary)', borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  icon: {
    fontSize: 48, fontWeight: 700, marginBottom: 12,
  },
  title: { fontSize: 18, fontWeight: 700, marginBottom: 8, color: 'var(--text)' },
  sub:   { fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, marginBottom: 20 },
  btnPrimary: {
    padding: '10px 28px',
    background: 'var(--primary)', color: 'white',
    border: 'none', borderRadius: 8,
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
  },
  vaBox: {
    background: 'var(--surface-2)', border: '1px solid var(--border)',
    borderRadius: 10, padding: 14, margin: '0 0 16px',
    textAlign: 'left',
  },
  vaRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    fontSize: 13, padding: '4px 0',
  },
  vaK: { color: 'var(--text-3)' },
  vaV: { color: 'var(--text)', fontWeight: 600 },
};

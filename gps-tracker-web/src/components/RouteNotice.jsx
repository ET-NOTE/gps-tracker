import { Link } from 'react-router-dom';

export default function RouteNotice({ kind = 'missing', onRetry }) {
  const copy = {
    missing: ['페이지를 찾을 수 없습니다', '주소가 변경되었거나 존재하지 않는 페이지입니다.'],
    denied: ['이 계정에서 사용할 수 없는 화면입니다', '계정 유형과 접근 권한을 확인해 주세요.'],
    loading: ['접근 권한 확인 중…', '계정 정보를 불러오고 있습니다.'],
    error: ['계정 정보를 불러오지 못했습니다', '연결 상태를 확인하고 다시 시도해 주세요.'],
  }[kind];
  const link = { padding: '12px 16px', borderRadius: 10, border: '1px solid var(--border)',
    color: 'var(--primary)', background: 'var(--surface)', textDecoration: 'none', fontSize: 14 };
  return <section role={kind === 'error' ? 'alert' : 'status'} style={{ flex: 1, minWidth: 0,
    overflow: 'auto', display: 'grid', placeItems: 'center', padding: 24, background: 'var(--bg)' }}>
    <div style={{ maxWidth: 440, textAlign: 'center', color: 'var(--text)' }}>
      <h1 style={{ fontSize: 22 }}>{copy[0]}</h1>
      <p style={{ color: 'var(--text-2)', lineHeight: 1.7 }}>{copy[1]}</p>
      <div style={{ display: 'flex', justifyContent: 'center', flexWrap: 'wrap', gap: 10, marginTop: 24 }}>
        {onRetry && <button type="button" style={link} onClick={onRetry}>다시 시도</button>}
        <Link to="/" style={link}>홈으로</Link>
        {kind === 'denied' && <Link to="/profile?tab=account" style={link}>계정 확인</Link>}
      </div>
    </div>
  </section>;
}

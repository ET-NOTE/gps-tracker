// (2026-07-28) Phase F1 primitive — PageHeader (섹션 상단).
//
// 사용:
//   <PageHeader title="임대 계약" subtitle="30일 창" actions={<button>...</button>} />
//   <PageHeader title="..." backTo={() => nav(-1)} />

import Icon from '../Icon';

export default function PageHeader({
  title,
  subtitle,
  actions,
  backTo,          // function () => void — 뒤로가기 버튼 (좌측)
  style,
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
      padding: 'var(--space-3) var(--space-4)',
      ...style,
    }}>
      {backTo && (
        <button onClick={backTo} style={{
          background: 'transparent', border: 'none', color: 'var(--text-2)',
          cursor: 'pointer', padding: 'var(--space-1) var(--space-2)',
          display: 'inline-flex', alignItems: 'center', gap: 4,
          borderRadius: 'var(--radius-sm)',
        }} aria-label="뒤로가기">
          <Icon name="chevron-left" size={16} /> 뒤로
        </button>
      )}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: 'var(--text)' }}>{title}</div>
        {subtitle && (
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{subtitle}</div>
        )}
      </div>
      {actions && (
        <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>{actions}</div>
      )}
    </div>
  );
}

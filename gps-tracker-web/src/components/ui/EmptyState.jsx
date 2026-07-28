// (2026-07-28) Phase F1 primitive — EmptyState.
// "임차인이 없습니다" "계약이 없습니다" 등 반복되는 빈 상태 표시.
//
// 사용:
//   <EmptyState title="임차인 없음" body="첫 계약을 만들어 시작하세요." action={<Button>새 계약</Button>} />
//   <EmptyState icon={<Icon name="user" size={32}/>} title="..." />

export default function EmptyState({ icon, title, body, action, style }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      gap: 'var(--space-3)',
      padding: 'var(--space-6) var(--space-4)',
      color: 'var(--text-3)', textAlign: 'center',
      ...style,
    }}>
      {icon && <div style={{ opacity: 0.6 }}>{icon}</div>}
      {title && <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-2)' }}>{title}</div>}
      {body && <div style={{ fontSize: 12, maxWidth: 320, lineHeight: 1.5 }}>{body}</div>}
      {action && <div style={{ marginTop: 'var(--space-2)' }}>{action}</div>}
    </div>
  );
}

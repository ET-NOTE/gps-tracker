// The visible track stays compact while the complete button remains easy to tap.
export default function Switch({ label, checked, disabled = false, onChange }) {
  return <button type="button" role="switch" aria-label={label} aria-checked={!!checked} disabled={disabled}
    onClick={() => onChange?.(!checked)} style={{ width: 48, height: 44, minHeight: 44, padding: 4, flexShrink: 0,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', border: 0,
      background: 'transparent', cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? .6 : 1 }}>
    <span aria-hidden="true" style={{ position: 'relative', width: 40, height: 24, borderRadius: 12,
      background: checked ? 'var(--primary)' : 'var(--border)', transition: 'background .15s' }}>
      <span style={{ position: 'absolute', top: 3, left: 3, width: 18, height: 18, borderRadius: 9,
        background: checked ? 'var(--primary-fg)' : 'var(--surface)',
        transform: `translateX(${checked ? 16 : 0}px)`, transition: 'transform .15s' }} />
    </span>
  </button>;
}

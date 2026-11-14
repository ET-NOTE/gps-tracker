// Shared map-tool geometry; each panel retains its existing scrolling and gestures.
export const mapSheet = {
  header: { position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '12px 14px', borderBottom: '1px solid var(--border)', flexShrink: 0, fontSize: 'var(--font-title)', fontWeight: 600 },
  close: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, flexShrink: 0, border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', background: 'var(--surface)', color: 'var(--text-2)', cursor: 'pointer' },
  surface: { borderRadius: 'var(--radius-2xl) var(--radius-2xl) 0 0', boxShadow: 'var(--shadow-lg)' },
};

// 바텀 네비게이션 — pill-shaped expandable tab bar.
// active 탭은 pill 배경 + label 확장, inactive 는 아이콘만.
import Icon from './Icon';

const BASE_TABS = [
  { id: 'home',    label: '홈',     icon: 'home' },
  { id: 'devices', label: '단말기', icon: 'list' },
  { id: 'tools',   label: '운행',   icon: 'mapPin' },
  { id: 'profile', label: '내정보', icon: 'user' },
];

export const BOTTOM_NAV_HEIGHT = 72;

export default function BottomNav({ active, onChange, isAdmin, isCorporate }) {
  const tabs = [...BASE_TABS];
  if (isCorporate) tabs.push({ id: 'corporate', label: '법인',   icon: 'route' });
  if (isAdmin)     tabs.push({ id: 'admin',     label: '관리자', icon: 'wrench' });

  return (
    <nav style={s.wrap}>
      <div style={s.pill}>
        {tabs.map(t => {
          const on = t.id === active;
          return (
            <button
              key={t.id}
              onClick={() => onChange(t.id)}
              style={{
                ...s.btn,
                ...(on ? s.btnActive : {}),
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                <Icon name={t.icon} size={22} stroke={on ? 2.2 : 1.6} />
              </span>
              <span style={{
                ...s.label,
                maxWidth: on ? 80 : 0,
                opacity: on ? 1 : 0,
                marginLeft: on ? 8 : 0,
              }}>
                {t.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

const s = {
  wrap: {
    position: 'relative',
    zIndex: 20,
    flexShrink: 0,
    background: 'var(--surface)',
    borderTop: '1px solid var(--border)',
    paddingBottom: 'env(safe-area-inset-bottom, 0)',
    backdropFilter: 'saturate(140%) blur(12px)',
    WebkitBackdropFilter: 'saturate(140%) blur(12px)',
  },
  pill: {
    maxWidth: 480,
    margin: '0 auto',
    height: BOTTOM_NAV_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '0 16px',
  },
  btn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 16px',
    height: 46,
    borderRadius: 999,
    border: 'none',
    cursor: 'pointer',
    background: 'transparent',
    color: 'var(--text-3)',
    fontWeight: 500,
    fontSize: 14,
    transition: 'background .22s ease, color .22s ease, padding .22s ease',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  btnActive: {
    background: 'var(--primary)',
    color: 'white',
  },
  label: {
    display: 'inline-block',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
    fontWeight: 700,
    fontSize: 14,
    lineHeight: 1,
    transition: 'max-width .22s ease, opacity .18s ease, margin-left .22s ease',
  },
};

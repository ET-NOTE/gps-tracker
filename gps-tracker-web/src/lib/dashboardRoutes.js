const views = {
  '/': 'home', '/devices': 'devices', '/devices/pair': 'devices',
  '/profile': 'profile', '/admin': 'admin', '/corporate': 'corporate',
  '/rentcar': 'rentcar', '/delivery': 'delivery',
};

export function dashboardView(pathname) {
  return views[pathname.replace(/\/+$/, '') || '/'] ?? null;
}

export function routeAccess(view, me, accountType) {
  if (view === 'admin') return me?.role === 'admin';
  const types = { corporate: 'corporate_fleet', rentcar: 'rentcar', delivery: 'delivery' };
  return !types[view] || accountType === types[view];
}

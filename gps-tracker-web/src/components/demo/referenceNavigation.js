const corporate = 'dashboard vehicles live devices maintenance reservations trips expenses approvals trip-stats cost-stats users organization permissions purposes policies notifications company'.split(' ');
const rental = 'reservations dispatch contracts checkout active return customers accounts rates payments refunds costs policies templates dashboard vehicles service incidents devices live reports utilization'.split(' ').map(name => 'rent-' + name);
const cargo = 'orders recurring dispatch schedule shipments proofs shippers carriers locations rates billing payables charges policies codes integrations dashboard vehicles drivers maintenance incidents devices live reports profit utilization'.split(' ').map(name => 'cargo-' + name);
const platform = ['platform-home', 'platform-devices', 'platform-account'];
const shared = new Set(['users', 'organization', 'permissions', 'notifications', 'company']);
const routes = new Set([...corporate, ...rental, ...cargo, ...platform]);
const areas = {corporate: '/demo/corporate', rental: '/demo/rentcar', cargo: '/demo/cargo'};
const defaults = {platform: 'platform-home', corporate: 'dashboard', rental: 'rent-dashboard', cargo: 'cargo-dashboard'};
const oldPages = {
  corporate: {vehicles: 'vehicles', trips: 'trips', expenses: 'expenses'},
  rental: {reservations: 'rent-reservations', fleet: 'rent-vehicles'},
  cargo: {dispatch: 'cargo-dispatch', orders: 'cargo-orders'},
};

export function referenceTarget(route, service) {
  if (!routes.has(route)) return null;
  if (platform.includes(route)) return {route, service: 'platform'};
  if (shared.has(route) && Object.hasOwn(areas, service)) return {route, service};
  return {route, service: route.startsWith('rent-') ? 'rental' : route.startsWith('cargo-') ? 'cargo' : 'corporate'};
}

export function demoTarget(pathname, search) {
  const path = pathname.replace(/\/+$/, '');
  const service = Object.keys(areas).find(key => areas[key] === path) || 'platform';
  const params = new URLSearchParams(search);
  const page = params.get('page');
  const legacy = oldPages[service];
  const route = params.get('view') || (legacy && Object.hasOwn(legacy, page) && legacy[page]) || defaults[service];
  const target = referenceTarget(route, service);
  return target?.service === service ? target : referenceTarget(defaults[service], service);
}

export function demoHref({route, service}) {
  const path = areas[service] || '/demo';
  return defaults[service] === route ? path : path + '?view=' + encodeURIComponent(route);
}

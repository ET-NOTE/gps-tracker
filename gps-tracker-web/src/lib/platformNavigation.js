export const businessServices = {
  corporate_fleet: '/corporate',
  rentcar: '/rentcar',
  delivery: '/cargo',
};

export function ownerServices(settings) {
  const values = settings?.enabled_services ?? [settings?.account_type];
  return Object.keys(businessServices).filter(key => values.includes(key));
}

export function internalDestination(value) {
  if (typeof value !== 'string' || !/^\/(?!\/)/.test(value) || /[\\\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value, 'https://local.invalid');
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== 'https://local.invalid' || /[\\\u0000-\u001f\u007f]/.test(path) || /^\/\/|^\/(login|start)(\/|$)/i.test(path)) return null;
    return url.pathname + url.search + url.hash;
  } catch { return null; }
}

const lastViewKey = id => 'platform.lastView.' + id;
export function memorableView(pathname, search = '') {
  if (!['/', '/devices', '/profile', '/corporate', '/rentcar', '/cargo', '/delivery'].includes(pathname)) return null;
  const path = pathname === '/delivery' ? '/cargo' : pathname;
  const parameters = new URLSearchParams(search);
  if ([...parameters.keys()].some(key => !['page','tab'].includes(key))) return null;
  const key = path === '/profile' ? 'tab' : 'page';
  const page = parameters.get(key);
  return page && /^[a-z][a-z0-9-]{0,50}$/.test(page) ? path + '?' + key + '=' + page : path;
}
export function rememberView(id, pathname, search) {
  const path = memorableView(pathname, search);
  if (path && id) try { localStorage.setItem(lastViewKey(id), path); } catch { /* Storage can be disabled. */ }
}

export function requestedStart(settings, id) {
  let route = settings?.start_route;
  if (route === 'last') {
    try { route = id && localStorage.getItem(lastViewKey(id)); } catch { route = null; }
  }
  if (!route || !internalDestination(route)) return '/';
  const url = new URL(route, 'https://local.invalid');
  const path = memorableView(url.pathname, url.search);
  return path || '/';
}

export function startDestination(settings, id, memberships = []) {
  const path = requestedStart(settings, id);
  const business = Object.entries(businessServices).find(([,prefix]) => prefix === path.split('?')[0]);
  return business && ![...ownerServices(settings), ...memberships].includes(business[0]) ? '/' : path;
}

export function classifyOwnedDevices(devices, settings, vehicles = [], cargoVehicles = []) {
  const assignments = new Map();
  function add(id, service) {
    if (!id) return;
    if (!assignments.has(id)) assignments.set(id, new Set());
    assignments.get(id).add(service);
  }
  for (const vehicle of vehicles) {
    for (const binding of vehicle.bindings || []) if (!binding.ended_at) add(binding.device_id, 'corporate_fleet');
  }
  for (const vehicle of cargoVehicles) add(Number(vehicle.deviceId), 'delivery');
  return devices.map(device => {
    const types = new Set(assignments.get(device.id));
    const type = device.account_type_override ?? (types.size ? null : settings?.account_type);
    if (type && Object.hasOwn(businessServices, type)) types.add(type);
    return {...device, portalServices: [...types]};
  });
}

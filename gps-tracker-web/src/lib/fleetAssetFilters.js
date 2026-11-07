// These are manually recorded odometer readings, not GPS trip totals.
export const emptyAssetFilters = { distance: 'all', minKm: '', maxKm: '', from: '', to: '' };
export function assetOdometer(asset) {
  const value = asset.profile?.odometer_km;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
export function assetRegistrationDay(value) {
  const time = value ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? new Date(time + 9 * 3600000).toISOString().slice(0, 10) : '';
}
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export function assetFilterError(filters) {
  const f = { ...emptyAssetFilters, ...filters };
  if (f.distance !== 'missing') {
    for (const value of [f.minKm, f.maxKm]) {
      if (value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 10000000))
        return '계기판 거리는 0~10,000,000km로 입력해 주세요.';
    }
    if (f.minKm !== '' && f.maxKm !== '' && Number(f.minKm) > Number(f.maxKm))
      return '최소 거리가 최대 거리보다 큽니다.';
  }
  if ([f.from, f.to].some(day => day && !validDay(day))) return '등록일을 올바른 날짜로 입력해 주세요.';
  if (f.from && f.to && f.from > f.to) return '등록 시작일이 종료일보다 늦습니다.';
  return '';
}
export function filterFleetAssets(assets, { query = '', status = 'all', sort = 'name', ...filters } = {}, staff = []) {
  const f = { ...emptyAssetFilters, ...filters };
  if (assetFilterError(f)) return [];
  const term = query.trim().toLocaleLowerCase('ko');
  const managers = new Map(staff.map(s => [s.id, s.name]));
  const hasRange = f.minKm !== '' || f.maxKm !== '';
  return assets.filter(v => {
    const km = assetOdometer(v), day = assetRegistrationDay(v.created_at);
    return (status === 'all' || v.enabled === (status === 'enabled'))
      && [v.name, v.license_plate, v.department, managers.get(v.manager_staff_id), ...(v.bindings || []).map(b => b.terminal_name)]
        .some(s => String(s || '').toLocaleLowerCase('ko').includes(term))
      && (f.distance === 'missing' ? km === null : (f.distance !== 'recorded' && !hasRange || km !== null)
        && (f.minKm === '' || km >= Number(f.minKm)) && (f.maxKm === '' || km <= Number(f.maxKm)))
      && (!f.from || day && day >= f.from) && (!f.to || day && day <= f.to);
  }).sort((a, b) => {
    let result = 0;
    if (sort === 'distanceAsc' || sort === 'distanceDesc') {
      const ak = assetOdometer(a), bk = assetOdometer(b);
      // Unknown readings remain last in either direction; never turn null into 0.
      result = ak === null ? (bk === null ? 0 : 1) : bk === null ? -1 : (ak - bk) * (sort === 'distanceDesc' ? -1 : 1);
    } else if (sort === 'created') result = (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0);
    return result || String(a.name || '').localeCompare(String(b.name || ''), 'ko', { numeric: true }) || a.id - b.id;
  });
}

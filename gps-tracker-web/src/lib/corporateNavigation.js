// Keep destination IDs stable while grouping features by the Cartax taxonomy.
// Keep company workflows grouped consistently on desktop and mobile.
export const corporateTabs = [
  { id: 'overview', label: '운영 현황', icon: 'home', group: 'overview' },
  { id: 'vehicles', label: '차량 관리', icon: 'list', group: 'vehicles' },
  { id: 'reservations', label: '차량 예약', icon: 'clock', group: 'vehicles' },
  { id: 'staff', label: '사용자', icon: 'user', group: 'staff' },
  { id: 'sites', label: '지점', icon: 'mapPin', group: 'sites' },
  { id: 'report', label: '운행기록부', icon: 'route', group: 'driving' },
  { id: 'monthly', label: '월간 요약', icon: 'bar', group: 'driving' },
  { id: 'expenses', label: '지출 내역', icon: 'coin', group: 'expenses' },
  { id: 'expense-categories', label: '항목 관리', icon: 'list', group: 'expenses' },
  { id: 'settings', label: '시스템 설정', icon: 'wrench', group: 'settings' },
];
export const corporateGroups = [
  { id: 'overview', label: '운영 현황', icon: 'home' },
  { id: 'vehicles', label: '차량', icon: 'list' },
  { id: 'staff', label: '사용자', icon: 'user' },
  { id: 'sites', label: '지점', icon: 'mapPin' },
  { id: 'driving', label: '운행', icon: 'route' },
  { id: 'expenses', label: '지출', icon: 'coin' },
  { id: 'settings', label: '시스템 설정', icon: 'wrench' },
];

// Stable page IDs also serve as return destinations from the full map.
export const corporateTabs = [
  { id: 'overview', label: '운영 현황', icon: 'home', group: 'overview' },
  { id: 'live', label: '실시간 관제', icon: 'map', group: 'live' },
  { id: 'vehicles', label: '차량 목록', icon: 'car', group: 'vehicles' },
  { id: 'devices', label: '단말기 관리', icon: 'link', group: 'vehicles' },
  { id: 'maintenance', label: '정비·보험', icon: 'wrench', group: 'vehicles' },
  { id: 'staff', label: '사용자 목록', icon: 'user', group: 'staff' },
  { id: 'sites', label: '지점 관리', icon: 'mapPin', group: 'staff' },
  { id: 'reservations', label: '차량 예약', icon: 'clock', group: 'reservations' },
  { id: 'report', label: '운행기록부', icon: 'route', group: 'driving' },
  { id: 'monthly', label: '월간 요약', icon: 'bar', group: 'driving' },
  { id: 'expenses', label: '지출 내역', icon: 'coin', group: 'expenses' },
  { id: 'approvals', label: '승인 관리', icon: 'check', group: 'expenses' },
  { id: 'expense-categories', label: '항목 관리', icon: 'list', group: 'expenses' },
  { id: 'analytics', label: '통계·리포트', icon: 'bar', group: 'analytics' },
  { id: 'settings', label: '관리 설정', icon: 'wrench', group: 'settings' },
];
export const corporateGroups = [
  { id: 'overview', label: '운영 현황', icon: 'home' },
  { id: 'live', label: '실시간 관제', icon: 'map' },
  { id: 'vehicles', label: '차량 관리', icon: 'car' },
  { id: 'staff', label: '사용자 관리', icon: 'user' },
  { id: 'reservations', label: '차량 예약', icon: 'clock' },
  { id: 'driving', label: '운행일지', icon: 'route' },
  { id: 'expenses', label: '지출 관리', icon: 'coin' },
  { id: 'analytics', label: '통계·리포트', icon: 'bar' },
  { id: 'settings', label: '관리 설정', icon: 'wrench' },
];

const pageHints = {
  overview: '차량 위치와 오늘 처리할 업무를 확인하세요.',
  vehicles: '차량의 기본 정보와 운영 상태를 확인하세요.',
  live: '차량의 마지막 위치와 수신 상태를 확인하세요.',
  devices: '단말기의 수신 상태와 차량 연결 이력을 확인하세요.',
  maintenance: '정비·보험 일정을 관리하고 완료한 점검을 기록하세요.',
  reservations: '예약 목록과 주간 일정에서 차량별 이용 시간을 확인하세요.',
  report: '차량·기간별 운행을 조회하고 운전자와 운행 목적을 기록하세요.',
  monthly: '월별 주행거리와 비용을 조회하고 운행기록부를 내려받으세요.',
  expenses: '차량 운영 지출과 증빙, 승인 현황을 확인하세요.',
  approvals: '예약과 지출의 요청 내역을 검토하세요.',
  'expense-categories': '지출을 분류할 비용 항목을 관리하세요.',
};
const sectionHints = {
  users:'사용자별 담당 차량, 부서와 권한을 확인하세요.', organization:'부서와 직책을 관리하세요.',
  permissions:'업무별 접근 권한을 정하고 사용자에게 그룹을 적용하세요.', audit:'사용자와 권한의 변경 내역을 확인하세요.',
  sites:'지점의 위치와 방문 반경을 관리하세요.', visits:'차량별 지점 방문 시각을 확인하세요.', groups:'지점을 그룹으로 분류하세요.',
  purposes:'회사의 운행 목적을 등록하고 관리하세요.', policy:'예약 승인 기준과 운행 허용 시간을 설정하세요.',
  notifications:'회사에서 받을 업무 알림을 선택하세요.', company:'운행기록부에 표시할 회사 정보를 관리하세요.',
  subscription:'이용 중인 리포트 서비스와 이용 기간을 확인하세요.',
  trips:'기간별 주행거리와 운행 건수를 비교하세요.', costs:'기간별 지출과 승인된 비용을 확인하세요.',
};
export function corporatePageHint(page,section) {
  return pageHints[page] || sectionHints[section] || '';
}

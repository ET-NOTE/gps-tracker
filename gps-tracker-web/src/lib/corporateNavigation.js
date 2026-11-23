// Stable page IDs also serve as return destinations from the full map.
export const corporateTabs = [
  { id: 'overview', label: '운영현황', icon: 'grid', group: 'overview' },
  { id: 'live', label: '실시간 관제', icon: 'map', group: 'live' },
  { id: 'vehicles', label: '차량 목록', icon: 'car', group: 'vehicles' },
  { id: 'devices', label: '단말기 관리', icon: 'link', group: 'vehicles' },
  { id: 'maintenance', label: '정비·보험', icon: 'wrench', group: 'vehicles' },
  { id: 'staff', label: '사용자 목록', icon: 'user', group: 'staff' },
  { id: 'sites', label: '지점 관리', icon: 'mapPin', group: 'staff', nav: false },
  { id: 'reservations', label: '차량 예약', icon: 'calendar', group: 'reservations' },
  { id: 'report', label: '운행일지', icon: 'route', group: 'driving' },
  { id: 'monthly', label: '월간 요약', icon: 'bar', group: 'driving' },
  { id: 'expenses', label: '지출 내역', icon: 'wallet', group: 'expenses' },
  { id: 'approvals', label: '승인 관리', icon: 'check', group: 'expenses' },
  { id: 'expense-categories', label: '항목 관리', icon: 'list', group: 'expenses' },
  { id: 'analytics', label: '통계·리포트', icon: 'bar', group: 'analytics' },
  { id: 'settings', label: '관리 설정', icon: 'settings', group: 'settings' },
];
export const corporateGroups = [
  { id: 'overview', label: '운영현황', icon: 'grid' },
  { id: 'live', label: '실시간 관제', icon: 'map' },
  { id: 'vehicles', label: '차량 관리', icon: 'car' },
  { id: 'staff', label: '사용자 관리', icon: 'users' },
  { id: 'reservations', label: '차량 예약', icon: 'calendar' },
  { id: 'driving', label: '운행일지', icon: 'route' },
  { id: 'expenses', label: '지출 관리', icon: 'wallet' },
  { id: 'analytics', label: '통계·리포트', icon: 'bar' },
  { id: 'settings', label: '관리 설정', icon: 'settings' },
];

export function corporateSections(canManageTeam) {
  return {
    // A third item {hidden:true} keeps a section reachable from its page without a sidebar link.
    staff: [['users','사용자 목록'],['organization','조직·지점 관리'],['permissions','권한 그룹'],...(canManageTeam?[['audit','변경 이력',{hidden:true}]]:[])],
    sites: [['sites','지점 목록'],['visits','방문 기록'],...(canManageTeam?[['groups','그룹 관리']]:[])],
    settings: [['purposes','운행 목적'],['policy','운영 정책'],['notifications','알림 설정'],['company','회사·서비스 정보'],['subscription','이용권 관리',{hidden:true}]],
    analytics: [['trips','운행 통계'],['costs','지출 통계']],
  };
}

const pageHints = {
  overview: '오늘의 차량 운영과 확인할 업무를 한눈에 확인하세요.',
  vehicles: '차량을 선택해 기본정보와 운행 상태를 확인하고 관리하세요.',
  live: '단말기에서 수신한 위치와 차량 상태를 확인하는 화면입니다.',
  devices: '단말기와 차량의 연결, 수신 상태, 연결 이력을 관리하세요.',
  maintenance: '다가오는 점검과 보험 일정을 확인하고 완료 내역을 기록하세요.',
  reservations: '차량 이용 일정과 승인 현황을 관리합니다.',
  report: '운행 목적과 경로를 확인하고 운행 기록을 정리합니다.',
  monthly: '월별 주행거리와 비용을 조회하고 운행기록부를 내려받으세요.',
  expenses: '차량 운영에 사용한 비용과 증빙을 관리합니다.',
  approvals: '예약과 지출 요청을 확인하고 승인 또는 반려합니다.',
  'expense-categories': '지출을 분류할 비용 항목을 관리하세요.',
};
const sectionHints = {
  users:'소속 조직과 권한 그룹을 관리합니다.', organization:'사용자와 차량의 소속 정보를 관리합니다.',
  permissions:'업무에 맞는 권한을 묶어 사용자에게 적용합니다.', audit:'사용자와 권한의 변경 내역을 확인하세요.',
  sites:'지점의 위치와 방문 반경을 관리하세요.', visits:'차량별 지점 방문 시각을 확인하세요.', groups:'지점을 그룹으로 분류하세요.',
  purposes:'예약과 운행일지에서 선택할 목적을 관리합니다.', policy:'예약 가능 시간과 승인 기준을 설정합니다.',
  notifications:'받을 알림과 수신 방법을 선택합니다.', company:'회사 기본 정보와 서비스 이용 현황을 확인합니다.',
  subscription:'이용 중인 리포트 서비스와 이용 기간을 확인하세요.',
  trips:'차량과 운전자별 운행 실적을 기간별로 확인합니다.', costs:'지출 항목과 차량별 비용 변화를 확인합니다.',
};
export function corporatePageHint(page,section) {
  return pageHints[page] || sectionHints[section] || '';
}

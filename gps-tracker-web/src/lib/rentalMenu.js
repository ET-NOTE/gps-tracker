export const rentalMenu = [
  {id:'home', label:'운영현황', icon:'home', pages:[['fleet','운영현황']]},
  {id:'booking', label:'예약·배차', icon:'clock', pages:[['reservations','예약 목록'],['schedule','배차 캘린더']]},
  {id:'rental', label:'대여·반납', icon:'file', pages:[['contracts','계약 목록'],['checkout','출고 관리'],['active','대여 중 관리'],['returns','반납 관리'],['history','계약 조회·내보내기']]},
  {id:'customer', label:'고객 관리', icon:'users', pages:[['rent-customers','고객 목록'],['rent-accounts','법인·거래처']]},
  {id:'fleetGroup', label:'차량 관리', icon:'car', pages:[['vehicles','차량 목록'],['service','정비·세차'],['incidents','사고·고장'],['devices','단말기 관리']]},
  {id:'control', label:'실시간 관제', icon:'map', pages:[['live','실시간 관제']]},
  {id:'finance', label:'요금·정산', icon:'coin', pages:[['rent-rates','요금표'],['rent-payments','청구·수납'],['rent-refunds','환불·보증금'],['rent-costs','차량 운영비']]},
  {id:'analysis', label:'통계·리포트', icon:'bar', pages:[['rent-reports','대여·매출 통계'],['rent-utilization','차량 가동·운영비']]},
  {id:'team', label:'사용자 관리', icon:'users', pages:[['staff','사용자 목록'],['branches','조직·지점 관리'],['groups','권한 그룹']]},
  {id:'settings', label:'관리 설정', icon:'settings', pages:[['policy','대여 정책'],['rent-templates','계약서 양식'],['notifications','알림 설정'],['settings','회사·서비스 정보']]},
];

export const rentalPages = new Map(rentalMenu.flatMap(g => g.pages));

export const rentalPageHeadings = {
  "rent-customers": "고객 목록", "rent-accounts": "법인 거래처", "rent-rates": "요금표",
  "rent-payments": "청구·수납", "rent-costs": "차량 운영비", policy: "대여 정책",
  service: "정비·세차", incidents: "사고·고장", devices: "단말기 관리",
};

export const rentalPageDescriptions = {
  fleet:'오늘 인도·반납과 준비할 업무를 확인하세요.',
  reservations:'고객과 이용 일정, 합의 요금을 관리합니다.',
  schedule:'대여와 차량 준비 일정을 확인하고 실제 차량을 배정합니다.',
  contracts:'계약 고객과 실운전자, 대여 조건과 처리 이력을 확인합니다.',
  checkout:'운전자와 계약, 결제를 확인하고 차량을 인도합니다.',
  active:'운행 중인 대여 건의 연장과 반납 일정을 관리합니다.',
  returns:'실제 반납과 차량 검수, 남은 정산 내역을 확인합니다.',
  'rent-customers':'고객 정보와 면허 확인 상태, 대여 이력을 관리합니다.',
  'rent-accounts':'법인 고객의 소속과 정산 방식을 관리합니다.',
  'rent-rates':'차종별 기본 요금과 보증금, 자차 보장료를 설정합니다.',
  'rent-payments':'계약별 이용료와 미수금, 별도 보증금 잔액을 확인합니다.',
  'rent-refunds':'이용료 환불과 보증금의 수납·반환을 구분해 관리합니다.',
  'rent-costs':'차량별 세차·정비·주유 비용을 기록하고 조회합니다.',
  policy:'예약 간격과 출고 전 확인 조건을 설정합니다.',
  'rent-templates':'대여 계약서의 문구를 편집하고 계약 정보를 넣어 미리 확인합니다.',
  vehicles:'차량의 대여 상태와 준비 상태를 함께 관리합니다.',
  service:'차량 준비 일정과 완료 상태를 관리합니다.',
  incidents:'접수 내역과 차량의 조치 상태를 관리합니다.',
  devices:'렌트카 차량과 단말기의 연결·수신 상태를 확인합니다.',
  live:'차량의 마지막 수신 위치와 대여 상태를 확인합니다.',
  'rent-reports':'기간별 계약과 대여료 수납·운영 지출을 확인합니다.',
  'rent-utilization':'차량별 대여 시간과 운영비를 비교합니다.',
  settings:'대여 계약에 사용하는 사업자 정보와 서비스 이용 현황을 확인합니다.',
};

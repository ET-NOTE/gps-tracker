export const rentalMenu = [
  {id:'home', label:'운영현황', icon:'home', pages:[['fleet','운영현황']]},
  {id:'booking', label:'예약·배차', icon:'clock', pages:[['reservations','예약 목록'],['schedule','배차 캘린더']]},
  {id:'rental', label:'대여·반납', icon:'file', pages:[['contracts','계약 목록'],['checkout','출고 관리'],['active','대여 중 관리'],['returns','반납 관리'],['history','계약 조회·내보내기']]},
  {id:'customer', label:'고객 관리', icon:'users', pages:[['rent-customers','고객 목록'],['rent-accounts','법인·거래처']]},
  {id:'fleetGroup', label:'차량 관리', icon:'car', pages:[['vehicles','차량 목록'],['service','정비·세차'],['incidents','사고·보험'],['devices','차량·단말기 연결']]},
  {id:'control', label:'실시간 관제', icon:'map', pages:[['live','실시간 관제']]},
  {id:'finance', label:'요금·정산', icon:'coin', pages:[['rent-rates','요금·옵션'],['rent-payments','청구·수납'],['rent-refunds','환불·보증금'],['rent-costs','지출 내역']]},
  {id:'analysis', label:'통계·리포트', icon:'bar', pages:[['rent-reports','대여·매출 통계'],['rent-utilization','차량 가동·운영비']]},
  {id:'team', label:'사용자 관리', icon:'users', pages:[['staff','사용자 목록'],['branches','조직·지점 관리'],['groups','권한 그룹']]},
  {id:'settings', label:'관리 설정', icon:'settings', pages:[['policy','대여 정책'],['rent-templates','계약서 양식'],['notifications','알림 설정'],['settings','서비스·이용권']]},
];

export const rentalPages = new Map(rentalMenu.flatMap(g => g.pages));

export const rentalPageHeadings = {
  "rent-customers": "고객 관리", "rent-accounts": "법인 거래처", "rent-rates": "요금표",
  "rent-payments": "청구·결제 기록", "rent-costs": "차량 운영비", policy: "대여 운영 정책",
  service: "세차·정비", incidents: "사고·고장", devices: "단말기 관리",
};

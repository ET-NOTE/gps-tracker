export const freightMenu = [
  ['home','운영현황','home',[['cargo-dashboard','운영현황']]],
  ['live','실시간 관제','map',[['cargo-live','실시간 관제']]],
  ['order','운송주문','file',[['cargo-orders','주문 목록'],['cargo-recurring','정기·반복 주문']]],
  ['dispatch','배차관리','clock',[['cargo-dispatch','통합 배차'],['cargo-schedule','배차 일정']]],
  ['transport','운송관리','route',[['cargo-shipments','운송 현황'],['cargo-proofs','인수증·완료 확인'],['cargo-incidents','지연·사고 처리']]],
  ['fleet','차량·기사 관리','car',[['cargo-vehicles','차량 목록'],['cargo-drivers','기사 목록'],['cargo-maintenance','정비·보험'],['cargo-devices','단말기 관리']]],
  ['partners','거래처 관리','users',[['cargo-shippers','화주 목록'],['cargo-carriers','협력 운송사'],['cargo-locations','상·하차지']]],
  ['finance','운임·정산','coin',[['cargo-rates','운임표·계약 요율'],['cargo-billing','화주 청구·수납'],['cargo-payables','운송비 정산·지급'],['cargo-charges','추가 비용']]],
  ['reports','통계·리포트','bar',[['cargo-reports','주문·배차 실적'],['cargo-profit','운송 손익'],['cargo-utilization','차량 가동·공차']]],
  ['team','사용자 관리','users',[['users','사용자 목록'],['organization','조직·지점 관리'],['permissions','권한 그룹']]],
  ['settings','관리 설정','settings',[['cargo-policies','배차·운송 정책'],['cargo-codes','기준정보'],['cargo-integrations','알림·연동'],['company','회사 정보']]]
].map(([id,label,icon,pages])=>({id,label,icon,pages}));
export const freightPages=new Map(freightMenu.flatMap(g=>g.pages));

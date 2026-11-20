// Public, synthetic records for the read-only rental and freight tour, KST 2026-11-20 15:00.
import { demoVehicles } from './demoVehicles';

const airportCar = demoVehicles.find(v => v.id === 'rental-01');
const deliveryTruck = demoVehicles.find(v => v.id === 'cargo-01');

const rentalFleet = [
  { plate: airportCar.plate, name: airportCar.name, model: airportCar.model, branch: '인천공항점', status: '대여 중', km: '18,620 km', mapId: airportCar.id },
  { plate: '24호 5602', name: '도심 대여 2호', model: '아반떼', branch: '운서역점', status: '출고 준비', km: '12,140 km' },
  { plate: '36허 7803', name: '송도 대여 3호', model: '카니발', branch: '송도점', status: '사용 가능', km: '26,480 km' },
];

const reservations = [
  { id: 'R-1120-01', customer: '이서윤', channel: '온라인 예약', vehicle: rentalFleet[0], start: '11.20 14:00', end: '11.21 14:00', from: '인천공항점', to: '운서역점', amount: '86,000원', status: '대여 중' },
  { id: 'R-1120-02', customer: '최동현', channel: '지점 접수', vehicle: rentalFleet[1], start: '11.20 16:30', end: '11.22 16:30', from: '운서역점', to: '운서역점', amount: '124,000원', status: '출고 준비' },
  { id: 'R-1120-03', customer: '강유진', channel: '온라인 예약', requested: '카니발', start: '11.21 09:00', end: '11.23 09:00', from: '송도점', to: '송도점', amount: '256,000원', status: '배차 대기' },
  { id: 'R-1119-04', customer: '한지민', channel: '지점 접수', vehicle: rentalFleet[2], start: '11.19 10:00', end: '11.20 10:00', from: '송도점', to: '송도점', amount: '128,000원', status: '반납 완료' },
];

const freightFleet = [
  { plate: deliveryTruck.plate, name: deliveryTruck.name, model: deliveryTruck.model, driver: '정다온', office: '직영', kg: 1000, available: '11.20 16:30', mapId: deliveryTruck.id },
  { plate: '86사 6203', name: '서부 운송 2호', model: '마이티 2.5톤 윙바디', driver: '유현우', office: '직영', kg: 2500, available: '11.20 15:00' },
  { plate: '91아 7405', name: '협력 운송 3호', model: '메가트럭 5톤 윙바디', driver: '문지안', office: '협력 운송사', kg: 5000, available: '11.20 18:00' },
];

const orders = [
  { id: 'O-1120-01', customer: '해온상사', from: '인천항', to: '남동산단', cargo: '포장 자재', kg: 680, load: '11.20 14:05', unload: '11.20 15:30', price: '125,000원', status: '배차 완료', stage: '운송 중', vehicle: freightFleet[0] },
  { id: 'O-1120-02', customer: '온빛유통', from: '송도 물류센터', to: '부평 집배송장', cargo: '생활용품', kg: 1600, load: '11.20 16:00', unload: '11.20 17:40', price: '180,000원', status: '미배차' },
  { id: 'O-1120-03', customer: '새봄패키징', from: '영종 물류센터', to: '김포 창고', cargo: '빈 포장 상자', kg: 750, load: '11.20 17:00', unload: '11.20 18:40', price: '140,000원', status: '미배차' },
  { id: 'O-1119-04', customer: '나루산업', from: '부평 집배송장', to: '송도 물류센터', cargo: '설비 부품', kg: 1800, load: '11.19 10:00', unload: '11.19 11:40', price: '210,000원', status: '운송 완료', stage: '하차 완료', vehicle: freightFleet[1] },
];

const weight = kg => kg.toLocaleString('ko-KR') + ' kg';

export const reservationRows = reservations.map(r => ({
  id: r.id, mapId: r.vehicle?.mapId, status: r.status, subtitle: r.customer,
  cells: [[r.id, r.channel], [r.customer], [r.vehicle?.plate || '차량 미배정', r.vehicle?.model || r.requested],
    [r.start, r.end + ' 반납'], [r.amount]],
  facts: [['고객명', r.customer], ['예약 경로', r.channel], ['차량', r.vehicle ? r.vehicle.plate + ' · ' + r.vehicle.model : r.requested + ' 배정 대기'],
    ['인수 지점', r.from], ['인수 예정', r.start], ['반납 지점', r.to], ['반납 예정', r.end], ['약정 대여료', r.amount]],
}));

export const rentalFleetRows = rentalFleet.map(v => ({
  id: v.plate, mapId: v.mapId, status: v.status, subtitle: v.name,
  cells: [[v.plate, v.name], [v.model], [v.branch], [v.km]],
  facts: [['차량명', v.name], ['차종', v.model], ['소속 지점', v.branch], ['누적 거리', v.km],
    ['최근 예약', reservations.find(r => r.vehicle === v)?.id || '없음']],
}));

export const orderRows = orders.map(o => ({
  id: o.id, mapId: o.vehicle?.mapId, status: o.status, subtitle: o.customer,
  cells: [[o.id, o.customer], [o.from, o.to + ' 도착'], [o.cargo, weight(o.kg)], [o.load, o.unload + ' 하차']],
  facts: [['화주', o.customer], ['화물', o.cargo], ['중량', weight(o.kg)], ['상차지', o.from], ['상차 예정', o.load],
    ['하차지', o.to], ['하차 예정', o.unload], ['운임', o.price], ['배정 차량', o.vehicle?.plate || '미배정'],
    ['담당 기사', o.vehicle?.driver || '미배정'], ['운송 단계', o.stage || '배차 대기']],
}));

export const pendingOrders = orders.filter(o => o.status === '미배차');

export function candidates(order) {
  return freightFleet.map(v => {
    const status = v.kg < order.kg ? '적재량 부족' : v.available > order.load ? '일정 중복' : '배차 가능';
    return {
      id: v.plate, mapId: v.mapId, status, subtitle: v.name,
      cells: [[v.plate, v.model], [v.driver, v.office], [weight(v.kg)]],
      facts: [['선택한 주문', order.id], ['차량명', v.name], ['차종', v.model], ['소속', v.office], ['담당 기사', v.driver],
        ['최대 적재량', weight(v.kg)], ['주문 중량', weight(order.kg)], ['운행 가능 시각', v.available], ['상차 예정', order.load]],
    };
  }).sort((a, b) => Number(b.status === '배차 가능') - Number(a.status === '배차 가능'));
}

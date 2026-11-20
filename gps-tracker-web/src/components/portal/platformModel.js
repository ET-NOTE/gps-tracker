import { businessServices } from '../../lib/platformNavigation.js';
export { ownerServices } from '../../lib/platformNavigation.js';

export const SERVICES = [
  { key: 'corporate_fleet', view: 'corporate', path: businessServices.corporate_fleet, label: '법인운행', icon: 'office', description: '업무용 차량의 예약, 운행기록부와 지출을 관리합니다.', features: ['차량·사용자 관리', '차량 예약', '운행기록부·지출'] },
  { key: 'rentcar', view: 'rentcar', path: businessServices.rentcar, label: '렌트카 운영', icon: 'car', description: '예약과 배차부터 차량 출고, 반납, 정산까지 관리합니다.', features: ['예약·배차', '대여·반납', '고객·요금 관리'] },
  { key: 'delivery', view: 'delivery', path: businessServices.delivery, label: '화물배차', icon: 'route', description: '화물 오더, 차량 배차와 운송 진행 상황을 확인합니다.', features: ['오더·배차', '운송 관제', '거래처·정산'] },
];

export const CORE_LINKS = [
  { view: 'home', path: '/', label: '홈', icon: 'map' },
  { view: 'devices', path: '/devices', label: '단말기', icon: 'antenna' },
  { view: 'profile', path: '/profile', label: '내정보', icon: 'user' },
];

export function deviceMatches(device, search) {
  const query = search.trim().toLocaleLowerCase();
  return !query || [device.display_name, device.device_uid, device.car_plate, device.license_plate]
    .some(value => value != null && String(value).toLocaleLowerCase().includes(query));
}

export function deviceBucket(status) {
  if (status.id === 'offline' || status.id === 'lost') return 'offline';
  if (status.id === 'unknown') return 'unknown';
  if (status.id === 'active' || status.id === 'sleeping' || status.id === 'idle') return 'normal';
  return 'attention';
}

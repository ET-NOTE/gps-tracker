import { businessServices } from '../../lib/platformNavigation.js';
export { ownerServices } from '../../lib/platformNavigation.js';

export const SERVICES = [
  { key: 'corporate_fleet', view: 'corporate', path: businessServices.corporate_fleet, label: '법인운행', icon: 'car',
    description: '회사 차량의 예약과 운행, 비용을 함께 관리하세요.', tags: ['차량 예약','운행일지','지출 관리'],
    features: ['운영현황과 실시간 관제', '차량·운전자와 단말기 연결', '차량 예약과 운행 목적', '운행일지와 지출 승인', '회사 구성원·조직·권한 관리'] },
  { key: 'rentcar', view: 'rentcar', path: businessServices.rentcar, label: '렌트카 운영', icon: 'calendar',
    description: '예약부터 계약, 출고와 반납까지 한곳에서 확인하세요.', tags: ['대여 계약','출고·반납','대여 정산'],
    features: ['예약과 차량 가용 현황', '대여 계약과 고객 정보', '차량 출고·반납 점검', '대여 요금과 정산', '차량 위치와 정비 관리'] },
  { key: 'delivery', view: 'delivery', path: businessServices.delivery, label: '화물배차', icon: 'truck',
    description: '화물 주문과 배차, 운송 진행 상황을 확인하세요.', tags: ['주문·배차','실시간 관제','운임 정산'],
    features: ['화물 주문과 배차 계획', '기사·차량과 운송사 관리', '실시간 운송 관제', '상·하차와 인수증 확인', '운임·운송료 정산'] },
];

export const CORE_LINKS = [
  { view: 'home', path: '/', label: '홈', icon: 'map' },
  { view: 'devices', path: '/devices', label: '단말기', icon: 'wifi' },
  { view: 'profile', path: '/profile', label: '내정보', icon: 'users' },
];

export function searchKey(value) {
  return String(value ?? '').toLocaleLowerCase().replace(/\s+/g,'');
}

export function deviceMatches(device, search) {
  const query = searchKey(search);
  return !query || [device.display_name || device.device_uid || `단말 ${device.id}`, device.device_uid, device.car_plate, device.license_plate]
    .some(value => searchKey(value).includes(query));
}

export function deviceBucket(status) {
  if (status.id === 'offline' || status.id === 'lost') return 'offline';
  if (status.id === 'unknown') return 'unknown';
  if (status.id === 'active' || status.id === 'sleeping' || status.id === 'idle') return 'normal';
  return 'attention';
}

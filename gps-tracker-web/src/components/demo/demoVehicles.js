export const demoVehicles = [
  {
    id: 'seoul-01', service: 'corporate', name: '서울 영업 1호', plate: '서울 데모 01', model: '쏘나타',
    city: '서울 성동구', from: '성수역', to: '서울숲', start: '13:40', end: '14:05', km: 3.2,
    points: [[37.5446,127.0556],[37.5439,127.0542],[37.5427,127.0515],[37.5413,127.0484],[37.5407,127.0468],[37.5417,127.0458],[37.5429,127.0448],[37.544,127.0425],[37.5444,127.0406]],
  },
  {
    id: 'incheon-02', service: 'corporate', name: '인천 지원 2호', plate: '인천 데모 02', model: '코나',
    city: '인천 연수구', from: '송도 센트럴파크역', to: '인천대입구역', start: '14:10', end: '14:35', km: 4.1,
    points: [[37.3931,126.6349],[37.3921,126.6363],[37.3909,126.6385],[37.3897,126.6405],[37.3889,126.6417],[37.3883,126.6411],[37.3876,126.6402],[37.3865,126.6395]],
  },
  {
    id: 'rental-01', service: 'rentcar', name: '공항 대여 1호', plate: '12하 3401', model: '쏘나타',
    city: '인천 중구', from: '인천공항 제1터미널', to: '운서역', start: '14:00', end: '14:30', km: 13.4,
    points: [[37.4484,126.4507],[37.4532,126.4517],[37.4617,126.4564],[37.4691,126.4654],[37.4776,126.4784],[37.4879,126.4897],[37.4936,126.4937],[37.4932,126.4917]],
  },
  {
    id: 'cargo-01', service: 'cargo', name: '배송 1호', plate: '80바 5102', model: '포터Ⅱ 1톤 탑차',
    city: '인천 중구·남동구', from: '인천항', to: '남동산단', start: '14:05', end: '14:55', km: 18.6,
    points: [[37.4551,126.6213],[37.4535,126.6278],[37.4519,126.6361],[37.4489,126.6422],[37.4419,126.6525],[37.4341,126.6663],[37.4238,126.6765],[37.412,126.6824],[37.4056,126.6897]],
  },
];

export function demoPointTime(vehicle, index) {
  const minutes = time => Number(time.slice(0,2)) * 60 + Number(time.slice(3));
  const first = minutes(vehicle.start);
  const current = first + Math.round((minutes(vehicle.end) - first) * index / (vehicle.points.length - 1));
  return String(Math.floor(current / 60)).padStart(2,'0') + ':' + String(current % 60).padStart(2,'0');
}

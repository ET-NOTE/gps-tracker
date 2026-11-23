export const notificationTopics = [
  { key: 'reservation', label: '차량 예약', hint: '예약 승인·반려 결과를 확인합니다.', icon: 'calendar' },
  { key: 'trip', label: '운행 시작·종료', hint: '차량의 운행 시작과 종료를 확인합니다.', icon: 'route' },
  { key: 'maintenance', label: '점검 일정', hint: '다가오는 정비·점검 일정을 확인합니다.', icon: 'wrench' },
  { key: 'connection', label: '단말 수신 이상', hint: '단말 수신 지연과 연결 상태를 확인합니다.', icon: 'wifi' },
  { key: 'expense', label: '지출 승인·반려', hint: '신청한 지출의 처리 결과를 확인합니다.', icon: 'wallet' },
];

export function selectedAttention(events, policy) {
  if (!policy?.in_app) return [];
  return events.filter(event => policy[event.id.startsWith('maintenance-') ? 'maintenance' : 'connection']);
}

const decisionLabels = {
  reservation: {planned: '예약 승인', rejected: '예약 반려'},
  expense: {approved: '지출 승인', rejected: '지출 반려'},
  trip: {in_progress: '예약 차량 운행 시작', completed: '예약 차량 운행 완료'},
};
export function notificationDecisions(rows, policy) {
  if (!policy?.in_app) return [];
  return rows.flatMap(row => {
    const label = decisionLabels[row.category]?.[row.status];
    return label && policy[row.category] ? [{...row,label}] : [];
  });
}

export function recordedTripNotices(trips,device,from,until) {
  const events=[];
  for(const t of trips) {
    if(t.allocation_status==='boundary_review')continue;
    const running=t.quality?.status==='running'&&!t.ended_at;
    const start=Date.parse(t.started_at),end=Date.parse(t.ended_at);
    const completed=t.quality?.report_included!==false && end>start;
    if(!running&&!completed)continue;
    if(start>=from&&start<=until)events.push({id:device.id+'-'+start+'-start',device,at:start,label:'운행 시작'});
    if(completed&&end>=from&&end<=until)events.push({id:device.id+'-'+start+'-end',device,at:end,label:'운행 종료'});
  }
  return events.sort((a,b)=>b.at-a.at);
}

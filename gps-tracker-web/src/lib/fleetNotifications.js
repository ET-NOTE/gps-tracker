export const notificationTopics = [
  { key: 'reservation', label: '차량 예약', hint: '예약 승인·반려 결과', icon: 'calendar' },
  { key: 'trip', label: '운행 시작·종료', hint: '예약 운행 상태 변경 및 운행기록부에 감지된 운행', icon: 'route' },
  { key: 'maintenance', label: '점검 일정', hint: '정비·보험·검사 예정일', icon: 'wrench' },
  { key: 'connection', label: '단말 수신 이상', hint: '연결된 단말기의 통신·배터리 상태', icon: 'link' },
  { key: 'expense', label: '지출 승인·반려', hint: '지출 신청의 처리 결과', icon: 'coin' },
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

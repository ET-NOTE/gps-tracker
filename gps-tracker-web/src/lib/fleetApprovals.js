import {kstDateTime} from './businessExport.js';
import {expenseMoney} from './fleetExpenses.js';

export const approvalLabels={pending:'승인 대기',approved:'승인 완료',rejected:'반려',cancelled:'취소'};
const bookingDecision={pending:'pending',planned:'approved',in_progress:'approved',completed:'approved',rejected:'rejected',cancelled:'cancelled'};

export function approvalRecords(bookings, expenses, staff, {visitTitle=false}={}) {
  const people=new Map(staff.map(person=>[person.id,person]));
  const bookingRows=bookings.filter(row=>row.approval_required&&row.can_review&&bookingDecision[row.status]).map(row=>{
    const driver=people.get(row.driver_staff_id);
    return {type:'reservation',kind:'차량 예약',raw:row,status:bookingDecision[row.status],person:row.driver_name,personId:row.driver_staff_id,
      department:driver?.department,departmentUnknown:row.driver_staff_id!=null&&!driver,departmentId:driver?.department_id,vehicle:row.vehicle_name||row.license_plate||row.device_name,
      title:(visitTitle?row.purpose||row.company_purpose_name:row.company_purpose_name||row.purpose)||'차량 예약',date:kstDateTime(row.created_at),period:kstDateTime(row.starts_at)+' ~ '+kstDateTime(row.ends_at)};
  });
  const expenseRows=expenses.filter(row=>row.can_review&&approvalLabels[row.status]).map(row=>({
    type:'expense',kind:'지출',raw:row,status:row.status,person:row.staff_name,personId:row.staff_id,department:row.department_name,
    departmentId:row.department_id,vehicle:row.vehicle_name||row.license_plate,title:[row.group_name,row.category_name].filter(Boolean).join(' · ')||'지출',
    date:kstDateTime(row.created_at),period:expenseMoney(row.amount_krw)+'원',
  }));
  return [...bookingRows,...expenseRows].map(row=>({...row,key:row.type+':'+row.raw.id,
    personKey:row.personId!=null?String(row.personId):row.person?'name:'+row.person:'unassigned',
    departmentKey:row.departmentUnknown?'unknown':row.departmentId!=null?String(row.departmentId):row.department?'name:'+row.department:'unassigned',
  })).sort((a,b)=>b.date.localeCompare(a.date)||b.raw.id-a.raw.id);
}

export function filterApprovals(records,{status,person,department,query}) {
  const terms=query.toLocaleLowerCase('ko').trim().split(/\s+/).filter(Boolean);
  return records.filter(row=>{
    if(status&&row.status!==status||person&&row.personKey!==person||department&&row.departmentKey!==department)return false;
    const text=[row.title,row.vehicle,row.person,row.department,row.raw.license_plate,row.raw.destination_address,row.raw.note].filter(Boolean).join(' ').toLocaleLowerCase('ko');
    return terms.every(term=>text.includes(term));
  });
}

export function approvalReport(records,filters){
  return {title:'예약·지출 승인 요청',filename:'승인_요청_'+filters.from+'_'+filters.to,
    meta:['차량 이용일·지출일 '+filters.from+' ~ '+filters.to],summary:records.length+'건',
    columns:[['kind','요청 구분'],['title','요청 내용'],['vehicle','차량'],['person','요청자'],['department','부서'],['date','요청일'],['period','금액 / 일정'],['status','상태']].map(([key,label])=>({key,label})),
    rows:records.map(({kind,title,vehicle,person,department,date,period,status})=>({kind,title,vehicle,person,department,date,period,status:approvalLabels[status]}))};
}

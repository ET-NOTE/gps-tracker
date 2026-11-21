export function scopedStaff(rows, access) {
  const allowed=access.role!=='owner'&&Array.isArray(access.staff_ids)?new Set(access.staff_ids):null;
  return rows.filter(s=>(s.user_id==null || access.owner_id==null || s.user_id===access.owner_id) && (!allowed || allowed.has(s.id)));
}
export function matchesPerson(row, query, role) {
  const roleMatches=!role || (row.access_role||'member')===role || (row.permission_group_id!=null && role==='group:'+row.permission_group_id);
  return roleMatches && [row.name,row.department,row.position,row.phone,row.account_email]
    .some(v=>String(v||'').toLowerCase().includes(query.trim().toLowerCase()));
}
export function inDepartment(row, id) {
  return !id || (id==='unassigned' ? !row.department_id : String(row.department_id)===String(id));
}
export function inStatus(row, status) {
  return status==='all' || Boolean(row.active)===(status==='active');
}

// Staff and group names must be authorized again at download time. The two
// access reads also detect an in-flight department or membership change.
export async function freshPeopleReport({api, access, filters, assertCurrent, onAccessChange, roles}) {
  async function checkAccess() {
    assertCurrent();
    const current=await api.fleetAccess();
    assertCurrent();
    if(JSON.stringify(current)!==JSON.stringify(access)){
      onAccessChange(current);
      throw new Error('회사 권한이 변경되었습니다. 새 목록을 확인한 뒤 다시 다운로드해 주세요.');
    }
  }
  await checkAccess();
  const [staff,groups]=await Promise.all([api.listStaff(),access.role==='owner'?api.fleetPermissionGroups():[]]);
  await checkAccess();
  if(!Array.isArray(staff)||!Array.isArray(groups))throw new Error('사용자 목록을 다시 조회해 주세요.');
  const {query,department,status,role}=filters;
  const groupNames=new Map(groups.map(g=>[g.id,g.name]));
  const keys=['이름','이메일','부서','직책','기본 역할','권한 그룹','계정 상태'];
  const rows=scopedStaff(staff,access).filter(s=>matchesPerson(s,query,role)&&inDepartment(s,department)&&inStatus(s,status)).map(s=>({
    이름:s.name, 이메일:s.account_email, 부서:s.department, 직책:s.position, '기본 역할':roles[s.access_role]||'일반 사용자',
    '권한 그룹':groupNames.get(s.permission_group_id)||(s.permission_group_id==null?'기본 역할':'맞춤 그룹'), '계정 상태':s.active?'활성':'비활성',
  }));
  return {filename:'사용자목록',columns:keys.map(key=>({key,label:key})),rows};
}

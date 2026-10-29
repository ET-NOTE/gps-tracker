export const tripAssignmentKey = t => `${t.source_device_id}:${t.binding_id}:${t.source_started_at || t.started_at}`;
export const tripAssignmentRef = t => ({source_device_id:t.source_device_id,binding_id:t.binding_id,trip_started_at:t.source_started_at || t.started_at});
export function canAssignTrip(t, access) {
  return t.allocation_status === 'assigned' && t.source_device_id != null && t.binding_id != null
    && new Date(t.ended_at) > new Date(t.source_started_at || t.started_at)
    && (access.manage_reports || t.annotation?.driver_staff_id == null || t.annotation.driver_staff_id === access.staff_id);
}
export function assignmentSource(source) {
  if (!source) return '';
  return ({reservation:'예약',default:'기본 규칙',weekly:'반복 규칙',manual:'직접 지정'})[source.kind] + (source.name ? ` · ${source.name}` : source.kind==='reservation' ? ` #${source.id}` : '');
}

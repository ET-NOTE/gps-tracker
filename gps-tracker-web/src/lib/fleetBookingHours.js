// An end time exactly at midnight belongs to the preceding occupied day.
export function outsideBookingHours(hours, start, end) {
  if (!(start<end)) return false;
  const day=86400000;
  const offset=9*3600000;
  const a=start+offset, b=end+offset;
  const first=Math.floor(a/day), last=Math.floor((b-1)/day);
  for(let i=first; i<=Math.min(last,first+6); i++) {
    const weekday=(new Date(i*day).getUTCDay()+6)%7;
    if(!(hours.week_mask & (1<<weekday))) return true;
  }
  return a-first*day<hours.open_minute*60000 || b-last*day>hours.close_minute*60000 ||
    (first!==last && (hours.open_minute!==0 || hours.close_minute!==1440));
}

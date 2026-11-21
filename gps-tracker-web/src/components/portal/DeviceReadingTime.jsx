const stamp = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export default function DeviceReadingTime({value}) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return <span>수신 대기</span>;
  return <time dateTime={date.toISOString()}>{stamp.format(date)}</time>;
}

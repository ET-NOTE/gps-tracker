const stamp = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export default function DeviceReadingTime({value, split = false, shortFor}) {
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) return <span>수신 대기</span>;
  if (split || shortFor != null) {
    const parts = Object.fromEntries(stamp.formatToParts(date).map(part => [part.type, part.value]));
    if (shortFor != null) {
      const today = Object.fromEntries(stamp.formatToParts(shortFor).map(part => [part.type,part.value]));
      const sameDay = ['year','month','day'].every(key => parts[key] === today[key]);
      return <time dateTime={date.toISOString()} title={stamp.format(date)}>{!sameDay && parts.month + '.' + parts.day + ' '}{parts.hour}:{parts.minute}</time>;
    }
    return <time dateTime={date.toISOString()}><span>{parts.year}.{parts.month}.{parts.day}</span><small>{parts.hour}:{parts.minute}</small></time>;
  }
  return <time dateTime={date.toISOString()}>{stamp.format(date)}</time>;
}

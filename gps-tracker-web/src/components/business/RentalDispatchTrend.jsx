export default function RentalDispatchTrend({days}) {
  const highest = Math.max(1, ...days.map(day => day.count));
  const magnitude = 10 ** Math.floor(Math.log10(highest / 4));
  const step = [1, 2, 5, 10].find(unit => unit * magnitude >= highest / 4) * magnitude;
  const intervals = Math.ceil(highest / step);
  const top = intervals * step;
  const ticks = Array.from({length: intervals + 1}, (_, index) => index * step);
  const points = days.map(({day, count}, index) => ({
    day, count, x: index * 100 / Math.max(1, days.length - 1), y: 100 * (1 - count / top)
  }));

  return <figure className="rental-line-chart" aria-label="최근 7일 날짜별 출고 건수">
    <span className="rental-axis-unit" aria-hidden="true">건</span>
    <div className="rental-trend-plot">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        {ticks.map(value => <line key={value} x1="0" x2="100" y1={100 * (1 - value / top)} y2={100 * (1 - value / top)} />)}
        <polyline points={points.map(p => p.x + ',' + p.y).join(' ')} />
      </svg>
      {ticks.map(value => <span key={value} className="rental-axis-value" aria-hidden="true" style={{top:(1-value/top)*100+'%'}}>{value.toLocaleString('ko-KR',{minimumFractionDigits:step < 1 ? 1 : 0})}</span>)}
      {points.map(({day, count, x, y}, i) => <div key={day} className="rental-trend-day" style={{left:x+'%'}} data-edge={i === 0 ? 'first' : i === points.length-1 ? 'last' : undefined}>
        <span className="rental-trend-point" tabIndex={0} role="img" aria-label={day + ' 출고 ' + count + '건'} style={{top:y+'%'}}>
          <span className="rental-trend-tooltip" aria-hidden="true">{day.slice(5).replace('-', '.')} · {count.toLocaleString('ko-KR')}건</span>
        </span>
        {(i % 2 === 0 || i === points.length-1) && <span className="rental-axis-date" aria-hidden="true">{day.slice(5).replace('-', '.')}</span>}
      </div>)}
    </div>
  </figure>;
}

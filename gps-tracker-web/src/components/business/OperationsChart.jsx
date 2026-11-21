import './operations-reports.css';

export function ChartPanel({title,subtitle,children}) {
  return <section className="ops-chart-panel">
    <header><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</header>
    <div className="ops-chart-body">{children}</div>
  </section>;
}

export function ReportBars({values,unit,height=200,empty='표시할 데이터가 없습니다.'}) {
  if (!values.length) return <p className="ops-chart-empty" style={{height}}>{empty}</p>;
  const max=values.reduce((largest,item)=>Math.max(largest,item.value),1);
  return <ul className="ops-bars" style={{height,'--ops-count':values.length}} aria-label={'항목별 비교 ('+unit+')'}>
    {values.map(({label,value},i)=><li key={i} tabIndex={0}>
      <div><span title={label}>{label}</span><span>{Number(value).toLocaleString('ko-KR')}{unit}</span></div>
      <span className="ops-track" aria-hidden="true"><i style={{width:(value/max*100)+'%'}}/></span>
    </li>)}
  </ul>;
}

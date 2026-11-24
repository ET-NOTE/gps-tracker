import { axisLabelIndexes, niceTicks, shortDay } from '../../lib/lineChart';
import './mockup-line-chart.css';

/**
 * Desktop design line chart: unit at the top right, a 0-based y axis with rounded ticks,
 * horizontal grid lines, a 2.25px line with white points and a tooltip on hover or focus,
 * and MM.DD labels at every ceil(n / 6)-th point plus the last one.
 * `points` is [{day, value}]; the values stay as given. A visually hidden table keeps them readable.
 */
export default function MockupLineChart({ points, unit, format = v => v.toLocaleString('ko-KR'), height = 230, label }) {
  const ticks = niceTicks(Math.max(0, ...points.map(p => p.value))), top = ticks.at(-1);
  const at = (i) => points.length === 1 ? 50 : 100 * i / (points.length - 1);
  const y = value => 100 - 100 * Math.max(0, value) / top;
  const line = points.map((p, i) => at(i) + ',' + y(p.value)).join(' ');
  const labels = axisLabelIndexes(points.length);
  return <div className="mlc" style={{ height }} role="group" aria-label={label}>
    <span className="mlc-unit" aria-hidden="true">{unit}</span>
    <div className="mlc-y" aria-hidden="true">{ticks.map(t => <span key={t} style={{ bottom: 100 * t / top + '%' }}>{t.toLocaleString('ko-KR')}</span>)}</div>
    <div className="mlc-plot">
      {ticks.map(t => <div key={t} className="mlc-grid" style={{ bottom: 100 * t / top + '%' }} aria-hidden="true"/>)}
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polyline points={line} fill="none" stroke="#3676e5" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
      </svg>
      {points.map((p, i) => {
        const tip = shortDay(p.day) + ' · ' + format(p.value) + ' ' + unit;
        return <span key={p.day} className="mlc-point" tabIndex={0} aria-label={tip} style={{ left: at(i) + '%', top: y(p.value) + '%' }}><span className="mlc-tip" aria-hidden="true">{tip}</span></span>;
      })}
      <div className="mlc-x" aria-hidden="true">{labels.map((i, n) => <span key={i} data-edge={n === 0 ? 'start' : i === points.length - 1 ? 'end' : undefined} style={{ left: at(i) + '%' }}>{shortDay(points[i].day)}</span>)}</div>
    </div>
    <table className="mlc-sr"><caption>{label}</caption><tbody>{points.map(p => <tr key={p.day}><th scope="row">{p.day}</th><td>{format(p.value)} {unit}</td></tr>)}</tbody></table>
  </div>;
}

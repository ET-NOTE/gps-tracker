import { useState } from 'react';
import Icon from '../Icon';
import Modal from '../ui/Modal';
import { candidates, orderRows, pendingOrders, rentalFleetRows, reservationRows } from './demoOperationsData';
import './DemoOperations.css';

const pages = {
  rentcar: [['reservations', '예약 목록'], ['fleet', '차량 현황']],
  cargo: [['dispatch', '통합 배차'], ['orders', '주문 목록']],
};

const lists = {
  reservations: { noun: '예약', title: '예약 목록', search: '예약번호, 고객명, 차량번호 검색', columns: ['예약번호', '고객', '차량 · 차종', '이용 기간', '약정 대여료'], rows: reservationRows },
  fleet: { noun: '차량', title: '차량 현황', search: '차량번호, 차종, 지점 검색', columns: ['차량', '차종', '소속 지점', '누적 거리'], rows: rentalFleetRows },
  orders: { noun: '주문', title: '운송 주문 목록', search: '주문번호, 화주, 운송 구간 검색', columns: ['주문 · 화주', '운송 구간', '화물', '상차 · 하차 예정'], rows: orderRows },
};

const tones = {
  '대여 중': 'blue', '출고 준비': 'green', '배차 대기': 'amber', '사용 가능': 'green',
  '미배차': 'amber', '배차 완료': 'blue', '배차 가능': 'green', '적재량 부족': 'amber', '일정 중복': 'amber',
};

function Status({ value }) {
  return <span className={'dop-status ' + (tones[value] || '')}>{value}</span>;
}

function Results({ columns, rows, title, onDetail }) {
  return <div className="dop-table-wrap"><table className="dop-table" aria-label={title}>
    <thead><tr>{columns.map(label => <th key={label} scope="col">{label}</th>)}<th scope="col">상태</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.id}>
      {row.cells.map(([primary, secondary], index) => <td key={columns[index]} data-label={columns[index]}>
        <div>{index === 0
          ? <button className="dop-detail-link" type="button" aria-label={row.id + ' 상세'} onClick={() => onDetail(row)}>
              {primary}<Icon name="chevron-right" size={14}/>
            </button>
          : <span>{primary}</span>}
          {secondary && <small>{secondary}</small>}
        </div>
      </td>)}
      <td className="dop-status-cell"><Status value={row.status}/></td>
    </tr>)}</tbody>
  </table></div>;
}

function RecordList({ config, onDetail }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const { rows, columns, title, noun } = config;
  const statuses = [...new Set(rows.map(row => row.status))];
  const needle = query.trim().toLocaleLowerCase();
  const shown = rows.filter(row => (!status || row.status === status) &&
    [...row.cells.flat(), ...row.facts.map(([,value]) => value)].some(value => value.toLocaleLowerCase().includes(needle)));
  return <section className="dop-panel">
    <div className="dop-panel-head"><h2>{title}</h2><span className="dop-count" role="status">{shown.length}{noun === '차량' ? '대' : '건'}</span></div>
    <div className="dop-filters">
      <label className="dop-search"><Icon name="search" size={18}/><input type="search" aria-label={noun + ' 검색'} placeholder={config.search} value={query} onChange={e => setQuery(e.target.value)}/></label>
      <label className="dop-select"><span>상태</span><select aria-label={noun + ' 상태'} value={status} onChange={e => setStatus(e.target.value)}>
        <option value="">전체</option>{statuses.map(s => <option key={s}>{s}</option>)}
      </select></label>
    </div>
    {shown.length ? <Results columns={columns} rows={shown} title={title} onDetail={onDetail}/> :
      <div className="dop-empty"><p>조건에 맞는 {noun === '차량' ? '차량이' : noun + '이'} 없습니다.</p>
        <button className="dop-plain" type="button" onClick={() => {setQuery(''); setStatus('');}}>검색 조건 초기화</button>
      </div>}
  </section>;
}

function Dispatch({ onDetail }) {
  const [selectedId, setSelectedId] = useState(pendingOrders[0].id);
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const order = pendingOrders.find(o => o.id === selectedId);
  const rows = candidates(order).filter(v => !onlyAvailable || v.status === '배차 가능');
  return <div className="dop-dispatch">
    <section className="dop-panel">
      <div className="dop-panel-head"><h2>미배차 주문</h2><span className="dop-count">{pendingOrders.length}건</span></div>
      <div className="dop-picks">{pendingOrders.map(o => <button type="button" className="dop-order-pick" key={o.id} aria-label={o.id + ' 선택'} aria-pressed={o.id === selectedId} onClick={() => setSelectedId(o.id)}>
        <span>{o.id} · {o.customer}</span><strong>{o.from} <span aria-hidden="true">→</span> {o.to}</strong>
        <span>{o.load} 상차 · {o.kg.toLocaleString('ko-KR')} kg</span>
      </button>)}</div>
    </section>
    <section className="dop-panel">
      <div className="dop-panel-head"><h2>차량·기사 후보</h2><span className="dop-count" role="status">{rows.length}대</span></div>
      <div className="dop-dispatch-tools"><label><input type="checkbox" checked={onlyAvailable} onChange={e => setOnlyAvailable(e.target.checked)}/>배차 가능만</label>
        <button className="dop-plain" type="button" onClick={() => onDetail(orderRows.find(r => r.id === selectedId))}>선택 주문 상세</button>
      </div>
      <Results title="차량·기사 후보" columns={['차량 · 차종','기사 · 소속','최대 적재량']} rows={rows} onDetail={onDetail}/>
    </section>
  </div>;
}

function OperationsPage({ view, choices, onPage, onMap }) {
  const [detail, setDetail] = useState(null);
  return <div className="dop-workspace">
    <nav className="dop-tabs" aria-label="업무 메뉴">{choices.map(([key, label]) =>
      <button type="button" aria-current={key === view ? 'page' : undefined} key={key} onClick={() => onPage(key)}>{label}</button>)}
    </nav>
    {view === 'dispatch' ? <Dispatch onDetail={setDetail}/> : <RecordList config={lists[view]} onDetail={setDetail}/>}
    {detail && <Modal open title={detail.id + ' 상세'} subtitle={detail.subtitle} onClose={() => setDetail(null)} size="lg"
      footer={detail.mapId && <button className="dop-map-link" type="button" onClick={() => {setDetail(null); onMap(detail.mapId);}}>
        <Icon name="mapPin" size={16}/>지도에서 보기</button>}>
      <dl className="dop-facts"><div><dt>상태</dt><dd><Status value={detail.status}/></dd></div>
        {detail.facts.map(([k,v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
      </dl>
    </Modal>}
  </div>;
}

export default function DemoOperations({ service, page, onPage, onMap }) {
  const choices = pages[service];
  const view = choices.some(([key]) => key === page) ? page : choices[0][0];
  return <OperationsPage key={view} view={view} choices={choices} onPage={onPage} onMap={onMap}/>;
}

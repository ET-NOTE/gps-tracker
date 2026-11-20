import React from 'react';
import Icon from '../Icon';
import './fleet-records.css';

export default function FleetRecordMetrics({ label, items }) {
  return <dl className="fleet-record-metrics no-print" aria-label={label}>
    {items.map(({ name, value, unit, icon, tone }) => <div key={name} data-tone={tone}>
      <dt>{name}{icon && <Icon name={icon} size={16}/>}</dt>
      <dd>{value == null ? '—' : <>{typeof value === 'number' ? value.toLocaleString('ko-KR') : value}<small>{unit}</small></>}</dd>
    </div>)}
  </dl>;
}

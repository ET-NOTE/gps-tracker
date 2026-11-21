import BusinessDrawer from './BusinessDrawer';
import './rental-record-drawer.css';

export default function RentalRecordDrawer({title,subtitle,onClose,footer,children}) {
  return <BusinessDrawer title={title} subtitle={subtitle} onClose={onClose}>
    <div className="rental-record-drawer">
      <div className="rental-record-body">{children}</div>
      {footer && <footer className="rental-record-footer">{footer}</footer>}
    </div>
  </BusinessDrawer>;
}

export function RecordFields({rows}) {
  return <dl className="rental-record-fields">{rows.map(([label,value])=>
    <div key={label}><dt>{label}</dt><dd>{value==null || value==='' ? '—' : value}</dd></div>
  )}</dl>;
}

export function CustomerFields({person, accounts=[]}) {
  const account=accounts.find(item=>String(item.id)===String(person.account_id));
  return <>
    <RecordFields rows={[
      ['구분',person.kind==='business'?'법인 고객':'개인'],['연락처',person.phone],['이메일',person.email],
      ['법인 거래처',account?.name],['운전면허',person.license_type],['면허 확인',person.license_checked?'확인 완료':'확인 필요'],
    ]}/>
    {person.memo && <section><h3>메모</h3><p className="rental-record-text">{person.memo}</p></section>}
  </>;
}

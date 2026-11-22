import FreightCatalog from './FreightCatalog';
import FreightCharges from './FreightCharges';
import FreightDevices from './FreightDevices';
import FreightLedger from './FreightLedger';
import {FreightRecordActions} from './FreightWorkflow';

export default function FreightOffice({page,...props}) {
  const name=page.replace(/^cargo-/,'');
  if (name==='devices')return <FreightDevices {...props}/>;
  if (name==='charges')return <FreightRecordActions key={name} {...props}>{({open})=><FreightCharges {...props} onOpenFinance={id=>open('finance',id)}/>}</FreightRecordActions>;
  if (['billing','payables'].includes(name))return <FreightRecordActions key={name} {...props}>{({open})=><FreightLedger kind={name} {...props} onOpenShipment={id=>open('shipments',id)}/>}</FreightRecordActions>;
  return <FreightRecordActions key={name} {...props}>{({open})=><FreightCatalog kind={name==='maintenance'?'services':name} {...props} onOpenRecord={open}/>}</FreightRecordActions>;
}

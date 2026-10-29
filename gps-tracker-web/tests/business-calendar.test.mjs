import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create, act} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as business from '../src/lib/business.js';
import * as businessExport from '../src/lib/businessExport.js';
import * as businessWorkspace from '../src/lib/businessWorkspace.js';
import * as businessAttention from '../src/lib/businessAttention.js';
import * as corporateOverview from '../src/lib/corporateOverview.js';

// Render the actual calendar bodies, not just the date helper. Unrelated panel
// dependencies are stubbed; no network, storage or customer data is involved.
async function calendar(file, name) {
  const source = await readFile(new URL(`../src/components/${file}.jsx`, import.meta.url), 'utf8');
  const context = vm.createContext({console});
  const noop = () => null;
  const moduleOf = exports => new vm.SyntheticModule(Object.keys(exports), function() {
    for (const [k,v] of Object.entries(exports)) this.setExport(k,v);
  }, {context});
  const code = (await transform(source + `\nexport { ${name} };`, {loader:'jsx', jsx:'automatic', format:'esm'})).code;
  const mod = new vm.SourceTextModule(code, {context});
  await mod.link(specifier => {
    if (specifier==='react') return moduleOf(React);
    if (specifier==='react/jsx-runtime') return moduleOf(jsx);
    if (specifier==='../lib/business') return moduleOf(business);
    if (specifier==='../lib/businessExport') return moduleOf(businessExport);
    if (specifier==='../lib/businessWorkspace') return moduleOf(businessWorkspace);
    if (specifier==='../lib/businessAttention') return moduleOf(businessAttention);
    if (specifier==='../lib/corporateOverview') return moduleOf(corporateOverview);
    // Only the named exports requested by this module are needed. None of these
    // hooks/components run while rendering a calendar.
    const exports = {default:noop,api:{},qk:{},useQueryClient:noop,ageString:noop,classifyDevice:noop,deviceBattery:noop,
      BusinessWorkspace:noop,BusinessLocation:noop,useBusinessVehicle:noop,BusinessButton:noop,BusinessError:noop,BusinessEmpty:noop,BusinessSection:noop,BusinessMetrics:noop,BusinessTask:noop,BusinessSettings:noop,BusinessVehicles:noop,
      useBusinessClock:noop,useRentalOperations:noop,useBusinessSubscription:noop,
      BusinessStaff:noop,BusinessRenters:noop,BusinessCompanyInfo:noop,BusinessSubscription:noop,
      alertDialog:noop,confirmDialog:noop,StatCard:noop,StatCardGrid:noop,useFleetStats:noop,
      Modal:noop,FormField:noop,Input:noop,Select:noop,Textarea:noop,Button:noop,Pill:noop,SkeletonList:noop,toast:noop};
    for(const name of ['useRentals','useCreateRental','useUpdateRental','useReturnRental','useDeleteRental','useRenters','useRenterDetail','useAddBlacklist','useRemoveBlacklist','useHandoffTokens','useIssueHandoffToken','useRevokeHandoffToken','useRentalPhotos','useUploadRentalPhoto','useDeleteRentalPhoto','useCorporateInfo','useStaff','useReservations','useDocuments','useCreateReservation','useUpdateReservation','useDeleteReservation','useCreateStaff','useUpdateStaff','useRemoveStaff','useUploadDocument','useDeleteDocument']) exports[name]=noop;
    return moduleOf(exports);
  });
  await mod.evaluate();
  return mod.namespace[name];
}
for (const [file,name] of [['RentcarPanel','RentalCalendar'],['CorporatePanel','ReservationCalendar']]) {
  test(`${name}: empty month renders 42 cells; day selection and KST event opening work`, async () => {
    const Calendar = await calendar(file,name);
    const dates=[], opened=[];
    const props={ym:'2026-10',list:[],onDayClick:d=>dates.push(d),onEventClick:r=>opened.push(r)};
    let r;
    await act(async()=>{r=create(React.createElement(Calendar,props));});
    const days=()=>r.root.findAll(n=>n.type==='div' && typeof n.props.onClick==='function' && n.props.style?.minHeight);
    assert.equal(days().length,42);
    // October 1 is Thursday; index 12 is October 9, irrespective of host TZ.
    await act(async()=>days()[12].props.onClick());
    assert.deepEqual(dates,['2026-10-09']);
    await act(async()=>days()[0].props.onClick());
    assert.equal(dates.length,1,'padding days must not create an entry');
    const entry={id:7,device_id:9,license_plate:'TEST-009',renter_name:'Fixture',purpose:'Fixture',status:'active',starts_at:'2026-10-08T15:10:00Z',ends_at:'2026-10-08T15:55:00Z'};
    await act(async()=>r.update(React.createElement(Calendar,{...props,list:[entry]})));
    const badge=days()[12].findAll(n=>n.type==='div' && n.props.title?.includes('TEST-009'));
    assert.equal(badge.length,1,'UTC October 8 event belongs in Korean October 9');
    assert.equal(days()[11].findAll(n=>n.props.title?.includes('TEST-009')).length,0);
    let stopped=false;
    await act(async()=>badge[0].props.onClick({stopPropagation:()=>{stopped=true;}}));
    assert.equal(stopped,true);
    assert.equal(opened[0],entry);
    assert.equal(dates.length,1,'entry click must not also create an empty form');
    await act(async()=>r.unmount());
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import {tripAssignmentKey,tripAssignmentRef,canAssignTrip} from '../src/lib/tripAssignments.js';
import {ntsTripReport} from '../src/lib/ntsReport.js';
import {reportPdfDefinition} from '../src/lib/businessExport.js';
const trip={source_device_id:2,binding_id:3,source_started_at:'2026-10-26T00:00:00Z',started_at:'2026-10-26T00:01:00Z',ended_at:'2026-10-26T01:00:00Z',allocation_status:'assigned',distance_m:12000};
test('assignment identifies original SIM and binding, not presentation time or vehicle ID',()=>{
 assert.deepEqual(tripAssignmentRef(trip),{source_device_id:2,binding_id:3,trip_started_at:trip.source_started_at});
 assert.notEqual(tripAssignmentKey(trip),tripAssignmentKey({...trip,binding_id:4}));
 assert.notEqual(tripAssignmentKey(trip),tripAssignmentKey({...trip,source_device_id:9}));
});
test('selection excludes open or ambiguous trips and protects other staff records',()=>{
 const member={manage_reports:false,staff_id:8};
 assert.ok(canAssignTrip(trip,member));
 for(const t of [{...trip,ended_at:null},{...trip,allocation_status:'boundary'},{...trip,binding_id:null},{...trip,annotation:{driver_staff_id:9}}])assert.equal(canAssignTrip(t,member),false);
 assert.ok(canAssignTrip({...trip,annotation:{driver_staff_id:9}},{manage_reports:true}));
});
test('NTS PDF uses all nine template fields and the same classified totals as CSV',()=>{
 const report=ntsTripReport([{...trip,annotation:{purpose:'commute',driver_name:'김사용',driver_department:'영업팀'}}],{device:{car_model:'아반떼',car_plate:'12가3456'},info:{company_name:'예시 법인',business_number:'123-45-67890'},from:'2026-10-01',to:'2026-10-31'});
 const pdf=reportPdfDefinition(report),table=pdf.content.find(x=>x.table).table;
 assert.equal(pdf.pageOrientation,'landscape');assert.equal(table.body[0].length,9);
 assert.deepEqual(table.body[0].map(c=>c.text),report.columns.map(c=>c.pdfLabel));
 assert.ok(!table.body[0].some(c=>/[①-⑳㎞]/.test(c.text)));
 assert.equal(table.body[1][3].text,'');assert.equal(table.body[1][6].text,'12');assert.equal(table.body[1][7].text,'0');
 assert.match(pdf.content.at(-1).text,/총주행거리: 12 km/);
 assert.ok(report.warnings.some(x=>x.includes('차량 이용자')));
});

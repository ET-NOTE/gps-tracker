import test from 'node:test';
import assert from 'node:assert/strict';
import {parseStaffCsv,staffCsvTemplate} from '../src/lib/staffImport.js';
import {inspectIncompleteTrips,tripNeedsDetails} from '../src/lib/incompleteTrips.js';
import {tripCompleteness} from '../src/lib/businessWorkspace.js';

test('CSV keeps phone zeroes, quoted commas, doubled quotes and Korean text',()=>{
 const rows=parseStaffCsv(staffCsvTemplate+'"김,담당",010-0123-4567,영업팀,팀장,"고객 ""지원"""\r\n');
 assert.deepEqual(rows,[{name:'김,담당',phone:'010-0123-4567',department:'영업팀',position:'팀장',role:'고객 "지원"'}]);
 assert.equal(parseStaffCsv(staffCsvTemplate+'김담당,,,,\n\n').length,1);
 assert.equal(parseStaffCsv(staffCsvTemplate+'=1+1,,,,')[0].name,'=1+1');
});
test('CSV rejects wrong headers, column mismatch, malformed quotes, empty and excessive files',()=>{
 for(const x of ['',staffCsvTemplate,'이름,부서,연락처,직책,담당 업무\na,,,,',staffCsvTemplate+'a,b',staffCsvTemplate+'"a,b,,,',staffCsvTemplate+'"a"b,,,,',staffCsvTemplate+'a"b,,,,',staffCsvTemplate+('a,,,,\n'.repeat(501)),staffCsvTemplate+'a'.repeat(1024*1024)])assert.throws(()=>parseStaffCsv(x));
});
test('Incomplete criteria match the report even with historical driver name only',()=>{
 const trips=[{}, {annotation:{purpose:'business'}},{annotation:{driver_staff_id:1}}, {annotation:{purpose:'business',driver_name:'이전 운전자'}},{annotation:{purpose:'other',driver_staff_id:1}},{annotation:{purpose:'unspecified',driver_staff_id:1}}];
 assert.equal(trips.filter(tripNeedsDetails).length,4);
 const c=tripCompleteness(trips);assert.equal(c.total-c.complete,4);
});
test('Overview limits requests to two and retains failures distinct from zero',async()=>{
 let inflight=0,peak=0;const result=[];
 await inspectIncompleteTrips([1,2,3,4].map(id=>({id})),async d=>{peak=Math.max(peak,++inflight);await new Promise(r=>setTimeout(r,5));inflight--;if(d.id===3)throw Error('failure');return d.id===1?[{}]:[];},r=>result.push(r));
 assert.equal(peak,2);assert.equal(result.length,4);assert.deepEqual(result.find(r=>r.id===3),{id:3,error:true});assert.equal(result.find(r=>r.id===2).missing,0);assert.equal(result.find(r=>r.id===1).missing,1);
});
test('Closing overview stops queued reads and late result updates',async()=>{
 let cancelled=false,calls=0,received=0;
 await inspectIncompleteTrips([1,2,3,4].map(id=>({id})),async()=>{calls++;await new Promise(r=>setTimeout(r,5));cancelled=true;return[];},()=>received++,()=>cancelled);
 assert.equal(calls,2);assert.equal(received,0);
});

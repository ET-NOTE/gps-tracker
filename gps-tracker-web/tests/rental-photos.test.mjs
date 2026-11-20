import test from 'node:test';
import assert from 'node:assert/strict';
import { PHOTO_KINDS, PHOTO_INPUT_LIMIT, photoTimestamp, photoGroups, photoFileError } from '../src/lib/rentalPhotos.js';

test('photo times use the actual server uploaded_at and retain legacy fallback', () => {
  assert.equal(photoTimestamp({uploaded_at:'2026-10-15T12:00:00Z',created_at:'old'}),'2026-10-15T12:00:00Z');
  assert.equal(photoTimestamp({created_at:'legacy'}),'legacy');
  assert.equal(photoTimestamp({}),null);
});
test('photo comparisons separate evidence type and phase without inferring matching angles', () => {
  const photos=[{id:3,kind:'return_damage',uploaded_at:'2026-10-15T12:00:00Z'},{id:2,kind:'pickup_fuel'},{id:1,kind:'pickup_damage',uploaded_at:'2026-10-10T12:00:00Z'},{id:5,kind:'return_odometer'},{id:4,kind:'future_type'}];
  const {groups,other}=photoGroups(photos);
  assert.deepEqual(groups.map(g=>[g.id,g.pickup.map(p=>p.id),g.returned.map(p=>p.id)]),[['damage',[1],[3]],['odometer',[],[5]],['fuel',[2],[]]]);
  assert.deepEqual(other.map(p=>p.id),[4]);
  assert.equal(photoGroups(photos,'fuel').groups.length,1);
  assert.deepEqual(photoGroups(photos,'fuel').other,[]);
  assert.deepEqual(photos.map(p=>p.id),[3,2,1,5,4]);
  assert.equal(Object.keys(PHOTO_KINDS).length,6);
});
test('empty, unsupported and oversized photos cannot be sent to compression/upload', () => {
  for(const type of ['image/jpeg','image/png','image/webp']) assert.equal(photoFileError({type,size:PHOTO_INPUT_LIMIT}),'');
  for(const file of [null,{type:'image/png',size:0},{type:'image/svg+xml',size:100},{type:'text/html',size:100},{type:'image/heic',size:100},{type:'image/png',size:PHOTO_INPUT_LIMIT+1}]) assert.ok(photoFileError(file));
});

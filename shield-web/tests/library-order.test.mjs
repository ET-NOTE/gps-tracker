import test from 'node:test';
import assert from 'node:assert/strict';
import { moveItem, sortByOrder, sortLessons } from '../src/libraryOrder.js';
import { featuredLessons } from '../src/lessonContent.js';

test('manual lesson order overrides guide/attachment priority without changing content', () => {
  const posts = [{id:'guide',category:'시작하기'}, {id:'plain',category:'시작하기'}, {id:'file',category:'시작하기',attachments:[{}]}, {id:'sensor',category:'센서'}];
  const before = structuredClone(posts);
  const result = sortLessons(featuredLessons(posts,'guide'),{categories:['센서','시작하기'],lessons:{시작하기:['plain','file','guide']}});
  assert.deepEqual(result.map(p=>p.id),['sensor','plain','file','guide']);
  assert.deepEqual(posts,before);
});
test('new, hidden, renamed and removed items have deterministic fallback positions', () => {
  const posts = [{id:'new',category:'A'}, {id:'saved',category:'A'}, {id:'moved',category:'B'}, {id:'uncategorized',category:' '}];
  const order = {categories:['gone','A'],lessons:{A:['hidden','moved','saved']}};
  assert.deepEqual(sortLessons(posts,order).map(p=>p.id),['saved','new','moved','uncategorized']);
  assert.deepEqual(sortByOrder(['A','B','C'],['B'],x=>x),['B','A','C']);
});
test('moving list items preserves every id exactly once and respects boundaries', () => {
  const values=['a','b','c'];
  assert.deepEqual(moveItem(values,0,2),['b','c','a']);
  assert.deepEqual(moveItem(values,2,0),['c','a','b']);
  assert.equal(moveItem(values,0,-1),values);
  assert.equal(moveItem(values,2,3),values);
  assert.deepEqual(values,['a','b','c']);
});

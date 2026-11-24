import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

// Layout fixes are CSS; these checks keep the rules that prevent the reported overlaps in place.
const css=name=>readFile(new URL('../src/components/'+name,import.meta.url),'utf8');
const flat=text=>text.replace(/\s+/g,' ');

test('sidebars scroll their menu while the bottom tools stay clear of it',async()=>{
  const rental=flat(await css('business/workspace-mockup-sync.css')),corporate=flat(await css('business/fleet-mockup-sync.css'));
  assert.match(rental,/\.rnt-shell \.rnt-sidebar > \.rnt-nav \{ flex: 1 1 auto; min-height: 0; overflow-y: auto; \}/);
  assert.match(rental,/\.rnt-shell \.rnt-sidebar > :is\(\.rnt-nav-tools, \.rnt-account\) \{ flex: none; \}/);
  assert.match(corporate,/\.business-nav-tools \{position:sticky; bottom:-16px;/);
});

test('phone header keeps the screen name on one line with an ellipsis',async()=>{
  const header=flat(await css('business/workspace-header.css'));
  const block=header.slice(header.lastIndexOf('@media (max-width:767px)'));
  assert.match(block,/\.ws-member-top \.ws-crumb span \{display:block; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; word-break:keep-all;/);
  assert.match(block,/\.ws-member-top \.ws-crumb\[data-has-page="true"\] :is\(\.ws-crumb-group, svg\) \{display:none\}/);
});

test('dialog footers and setup buttons keep an 8px gap',async()=>{
  assert.match(flat(await css('business/business.css')),/\.business-dialog-actions \{ display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; \}/);
  assert.match(flat(await css('business/workspace-mockup-sync.css')),/\.rnt-prerequisites \{ display: flex; flex-wrap: wrap; align-items: center; gap: 8px; \}/);
});

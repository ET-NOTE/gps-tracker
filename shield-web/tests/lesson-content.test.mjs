import test from 'node:test';
import assert from 'node:assert/strict';
import { lessonLinks, lessonReplacement, visibleLessons, featuredLessons } from '../src/lessonContent.js';
import { deviceDemo } from '../src/deviceDemo.js';

test('lesson links keep basic instructions readable and reject executable/external redirect schemes', () => {
  assert.deepEqual(lessonLinks('먼저 [설치](/examples/arduino-basics-install) 후 [문서](https://docs.arduino.cc/)'), [
    {text:'먼저 '}, {text:'설치',href:'/examples/arduino-basics-install'}, {text:' 후 '}, {text:'문서',href:'https://docs.arduino.cc/'}
  ]);
  for (const url of ['javascript:alert', 'data:text/html,evil', '//evil.test', '/\\evil.test', 'https://user:pass@evil.test/', 'https://evil.test\\x']) {
    assert.ok(lessonLinks(`[링크](${url})`).every((part) => !part.href), url);
  }
  assert.deepEqual(lessonLinks('<script>'), [{text:'<script>'}]);
});
test('legacy tutorials remain until their complete replacement is publicly available', () => {
  const legacy = {id:'dht11'}, full = {id:'shield-uno-dht11',attachments:[{}]}, guide = {id:'start'};
  assert.equal(lessonReplacement('dht11',[legacy]),null);
  assert.deepEqual(visibleLessons([legacy]),[legacy]);
  assert.deepEqual(featuredLessons([legacy,full,{id:'other'},guide],'start').map(p=>p.id),['start','shield-uno-dht11','other']);
  assert.equal(lessonReplacement('dht11',[{...full,kind:'project'}]),null);
  assert.equal(lessonReplacement('dht11',[{...legacy,revision:2},full]),null);
});
test('device demo is a local sample with nonnumeric identity and sample quota', () => {
  const sample=deviceDemo();
  assert.equal(sample.id,'demo');
  assert.equal(sample.summary.device.id,'demo');
  assert.equal(sample.sim.sim.usage.remaining_mb,350);
  assert.ok(sample.readings.items.length > 0);
  assert.ok(sample.readings.items.every(r=>Number.isFinite(r.values_json.temperature)));
});

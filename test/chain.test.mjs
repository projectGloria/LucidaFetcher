import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, nextAttempt, advanceAfter } from '../src/engine/chain.mjs';

const spec = {
  variants: ['Fetish Obzkure', 'Fetish'],
  services: ['qobuz', 'amazon'],
};

test('walks every store, then Monochrome, then SoundCloud, then YouTube last', () => {
  const plan = buildPlan(spec);
  assert.deepEqual(plan.map((s) => `${s.service}:${s.variantIndex}`), [
    'qobuz:0', 'qobuz:1', 'amazon:0', 'amazon:1',
    'monochrome:0', 'monochrome:1', 'soundcloud:0', 'youtube:0',
  ]);
});

test('an exact upload is fetched before anything is searched', () => {
  const plan = buildPlan({ ...spec, directUrl: 'https://soundcloud.com/a/b' });
  assert.equal(plan[0].source, 'direct');
  assert.equal(plan[0].url, 'https://soundcloud.com/a/b');
  assert.equal(plan[1].service, 'qobuz');
});

test('Jamendo is an opt-in native source with one strict attempt', () => {
  const plan = buildPlan({ ...spec, jamendo: true });
  assert.equal(plan[0].source, 'jamendo');
  assert.equal(plan[0].service, 'jamendo');
  assert.equal(plan.filter((s) => s.service === 'jamendo').length, 1);
  assert.equal(plan[1].service, 'qobuz');
});

test("Lucida's SoundCloud store gives way to the native stage", () => {
  // Both would be keyed 'soundcloud', and advanceAfter skips BY SERVICE - so a
  // dead Lucida store would take the working native source down with it.
  const plan = buildPlan({ ...spec, services: ['qobuz', 'soundcloud'] });
  const sc = plan.filter((s) => s.service === 'soundcloud');
  assert.equal(sc.length, 1);
  assert.equal(sc[0].source, 'soundcloud');

  const keptWhenNativeIsOff = buildPlan({ ...spec, services: ['soundcloud'], soundcloud: false });
  assert.ok(keptWhenNativeIsOff.some((s) => s.source === 'lucida' && s.service === 'soundcloud'));
});

test('caps how many variants each store is worth', () => {
  const plan = buildPlan({ ...spec, variants: ['a', 'b', 'c', 'd'], maxVariantsPerSource: 1 });
  assert.deepEqual(plan.filter((s) => s.service === 'qobuz').length, 1);
});

test('the terminal fallback can be turned off', () => {
  const plan = buildPlan({ ...spec, youtube: false, monochrome: false, soundcloud: false });
  assert.ok(plan.every((s) => s.source === 'lucida'));
});

test('an empty query list yields no plan at all', () => {
  assert.deepEqual(buildPlan({ ...spec, variants: [] }), []);
});

test('skips a store that is currently down', () => {
  const plan = buildPlan(spec);
  const step = nextAttempt(plan, { index: 0, skip: ['qobuz'] });
  assert.equal(step.service, 'amazon');
});

test('returns null once the plan is exhausted', () => {
  const plan = buildPlan(spec);
  assert.equal(nextAttempt(plan, { index: plan.length }), null);
});

test('a rephrasable failure moves to the next variant', () => {
  const plan = buildPlan(spec);
  assert.equal(advanceAfter(plan, 0, 'no-results'), 1);
  assert.equal(plan[1].service, 'qobuz');
});

test('a store that cannot supply the track loses its remaining variants', () => {
  // Rewording a query does not make a catalogue contain a track it lacks, and
  // each retry costs a full page load of a heavy SPA.
  const plan = buildPlan(spec);
  const next = advanceAfter(plan, 0, 'provider-failed');
  assert.equal(plan[next].service, 'amazon');
});

test('exhausting the last source ends the plan', () => {
  const plan = buildPlan(spec);
  assert.equal(advanceAfter(plan, plan.length - 1, 'provider-failed'), plan.length);
});

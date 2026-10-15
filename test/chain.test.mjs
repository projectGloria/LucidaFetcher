import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, nextAttempt, advanceAfter } from '../src/engine/chain.mjs';

const spec = {
  variants: ['Fetish Obzkure', 'Fetish'],
  services: ['qobuz', 'amazon'],
};

test('walks only enabled stores', () => {
  const plan = buildPlan(spec);
  assert.deepEqual(plan.map((s) => `${s.service}:${s.variantIndex}`), [
    'qobuz:0', 'qobuz:1', 'amazon:0', 'amazon:1',
  ]);
});

test('imported media URLs cannot bypass the enabled sources', () => {
  for (const directService of ['soundcloud', 'youtube']) {
    assert.deepEqual(buildPlan({ ...spec, directUrl: 'https://example.com/upload', directService }), buildPlan(spec));
  }
});


test('blocked services stay blocked even when explicitly requested', () => {
  assert.deepEqual(buildPlan({ variants: ['song'], services: ['youtube', 'soundcloud'], youtube: true, soundcloud: true }), []);
});

test('Monochrome requires explicit selection and no sources means no attempts', () => {
  assert.deepEqual(buildPlan({ variants: ['song'], services: [] }), []);
  assert.equal(buildPlan({ variants: ['song'], services: ['monochrome'] })[0].source, 'monochrome');
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

test('the outcomes the worker really emits skip the rest of a dead store', () => {
  // advanceAfter was written against 'service-unavailable', which nothing ever
  // emits. The worker says 'search-unavailable' when the search never happened
  // and 'navigation-timeout' when the store's page never arrived; both used to
  // fall through to `default` and re-ask a dead store under another wording.
  const plan = buildPlan({
    variants: ['a', 'b'], services: ['qobuz', 'tidal'],
    monochrome: false, soundcloud: false, youtube: false,
  });
  for (const outcome of ['search-unavailable', 'navigation-timeout', 'provider-failed']) {
    const next = advanceAfter(plan, 0, outcome);
    assert.notEqual(plan[next] && plan[next].service, 'qobuz',
      `${outcome} kept asking the same store`);
  }
});

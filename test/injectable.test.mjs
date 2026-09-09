import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normWith, toksWith, scoreWith, isAcceptableWith,
  injectableScorer, score, FOLD, STOP, ALTERING, MIN_TITLE_SCORE,
} from '../src/engine/matching.mjs';

// Re-create a function from its own source, in a scope that has nothing but the
// globals. Any reference to a module-level binding then throws ReferenceError.
//
// This is the exact failure that shipped: the cascades are generated with
// Function.prototype.toString(), the bundler minified the module and renamed
// FOLD/STOP/norm, and the stringified bodies went looking for names the
// generated wrapper never declared - "Se is not defined", thrown inside the page
// on every search. Dev and the unit tests were unminified, so nothing caught it.
// These functions must therefore be closed over NOTHING.
const isolate = (fn) => new Function(`return (${fn.toString()})`)();

const DEPS = { FOLD, STOP, ALTERING, toks: toksWith, norm: normWith };

test('normWith survives being torn out of its module', () => {
  const f = isolate(normWith);
  assert.equal(f('MATEØ Café', FOLD), 'mateo cafe');
});

test('toksWith survives being torn out of its module', () => {
  const f = isolate(toksWith);
  assert.deepEqual(f('The Original Mix', FOLD, STOP, normWith), []);
  assert.deepEqual(f('Dark Essence', FOLD, STOP, normWith), ['dark', 'essence']);
});

test('scoreWith survives being torn out of its module', () => {
  const f = isolate(scoreWith);
  assert.deepEqual(f({ title: 'Fetish', artist: 'Obzkure' }, 'Fetish', 'Obzkure', DEPS), { t: 1, p: 1, a: 1 });
});

test('isAcceptableWith survives being torn out of its module', () => {
  const f = isolate(isAcceptableWith);
  assert.equal(f({ t: 1, p: 1, a: 1 }, 0.6), true);
  assert.equal(f({ t: 1, p: 1, a: 0 }, 0.6), false);
});

test('the generated scorer runs with no access to the module', () => {
  // Exactly how the webview receives it: source text, evaluated on its own.
  const src = injectableScorer({ title: 'Fetish', artist: 'Obzkure' }, MIN_TITLE_SCORE);
  const run = new Function(`
    ${src}
    return {
      right: score('Fetish', 'Obzkure'),
      wrongArtist: score('Fetish', 'Selena Gomez'),
      superset: score('Money Fetish', 'Obzkure'),
      accepted: isAcceptable(score('Fetish', 'Obzkure'), MIN_TITLE_SCORE),
      tokens: toks('Fetish (Original Mix)', FOLD, STOP, norm),
    };
  `);
  const out = run();

  assert.deepEqual(out.right, { t: 1, p: 1, a: 1 });
  assert.equal(out.wrongArtist.a, 0);
  assert.ok(out.superset.p < out.right.p, 'precision must still separate a superset title');
  assert.equal(out.accepted, true);
  assert.deepEqual(out.tokens, ['fetish'], 'STOP must reach the injected scope');
});

test('the injected scorer agrees with the module scorer', () => {
  // The whole reason for generating the injected code from these functions is
  // that the two cannot drift. Check it rather than assume it.
  const cases = [
    [{ title: 'Fetish', artist: 'Obzkure' }, 'Fetish', 'Obzkure'],
    [{ title: 'Fetish', artist: 'Obzkure' }, 'Money Fetish', 'Obzkure'],
    [{ title: 'No Glory (Remix)', artist: 'X' }, 'No Glory', 'X'],
    [{ title: 'The Mad Devil', artist: 'MATEØ' }, 'The Mad Devil (MATEØ)', 'Rok Nardin'],
    [{ title: 'Dark Essence', artist: 'Dirrek, Tsunca' }, 'Dark Essence (feat. Tsunca)', 'Dirrek'],
  ];
  for (const [expected, candTitle, candArtist] of cases) {
    const run = new Function(`
      ${injectableScorer(expected, MIN_TITLE_SCORE)}
      return score(${JSON.stringify(candTitle)}, ${JSON.stringify(candArtist)});
    `);
    assert.deepEqual(run(), score(expected, candTitle, candArtist),
      `disagreement on ${candTitle} - ${candArtist}`);
  }
});

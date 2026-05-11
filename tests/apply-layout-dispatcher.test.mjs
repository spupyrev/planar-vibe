import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  commandForImplementation,
  normalizeImplementation,
  parseDispatcherArgs
} from '../scripts/apply-layout.mjs';

test('apply-layout dispatcher normalizes implementation aliases', () => {
  assert.equal(normalizeImplementation(), 'cpp');
  assert.equal(normalizeImplementation('cpp'), 'cpp');
  assert.equal(normalizeImplementation('c++'), 'cpp');
  assert.equal(normalizeImplementation('js'), 'js');
  assert.equal(normalizeImplementation('javascript'), 'js');
  assert.equal(normalizeImplementation('python'), 'python');
  assert.equal(normalizeImplementation('py'), 'python');
  assert.throws(() => normalizeImplementation('ruby'), /Unknown implementation/);
});

test('apply-layout dispatcher strips implementation flag before forwarding', () => {
  assert.deepEqual(
    parseDispatcherArgs([
      'benchmark/named.dot',
      'sample1',
      '--implementation',
      'javascript',
      '--algorithm',
      'tutte'
    ]),
    {
      implementation: 'js',
      forwarded: ['benchmark/named.dot', 'sample1', '--algorithm', 'tutte'],
      sawHelp: false
    }
  );

  assert.deepEqual(
    parseDispatcherArgs(['--implementation=c++', 'benchmark/named.dot', 'sample1', 'tutte']),
    {
      implementation: 'cpp',
      forwarded: ['benchmark/named.dot', 'sample1', 'tutte'],
      sawHelp: false
    }
  );
});

test('apply-layout dispatcher selects the requested implementation command', () => {
  const js = commandForImplementation('js', ['a']);
  assert.equal(js.command, process.execPath);
  assert.equal(path.basename(js.args[0]), 'apply-layout-js.mjs');
  assert.deepEqual(js.args.slice(1), ['a']);

  const py = commandForImplementation('py', ['b']);
  assert.equal(py.command, 'python3');
  assert.match(py.args[0], /src-python\/scripts\/apply_layout\.py$/);
  assert.deepEqual(py.args.slice(1), ['b']);

  const cpp = commandForImplementation('cpp', ['c']);
  assert.match(cpp.command, /src-cpp\/build\/apply_layout$/);
  assert.deepEqual(cpp.args, ['c']);
});

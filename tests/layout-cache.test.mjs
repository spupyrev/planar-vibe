import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAYOUT_TABLE_CACHE_ALGORITHMS,
  LAYOUT_TABLE_CACHE_TARGETS,
  runCli
} from '../scripts/layout-cache.mjs';

const EXPECTED_ALGORITHMS = [
  'schnyder',
  'fpp',
  'tutte',
  'ceg_bfs',
  'ceg_xy',
  'reweight',
  'forcedir',
  'impred',
  'air',
  'anglebalancer',
  'edgebalancer',
  'facebalancer',
  'gpt',
  'claude'
];

test('cache rebuild manifest uses the agreed algorithm set', () => {
  assert.deepEqual(LAYOUT_TABLE_CACHE_ALGORITHMS, EXPECTED_ALGORITHMS);
  assert.equal(LAYOUT_TABLE_CACHE_ALGORITHMS.includes('fabalancer'), false);
});

test('cache rebuild manifest covers every cache file', () => {
  assert.deepEqual(LAYOUT_TABLE_CACHE_TARGETS.map((target) => target.outputPath), [
    'evaluation_data/sample-graphs-layout-table-cache.json',
    'evaluation_data/named-layout-table-cache.json',
    'evaluation_data/gd-collection-coords-layout-table-cache.json',
    'evaluation_data/gd-collection-layout-table-cache.json',
    'evaluation_data/north-layout-table-cache.json',
    'evaluation_data/rome-layout-table-cache.json'
  ]);
});

test('cache rebuild manifest includes input only when coordinates are present', () => {
  const algorithmsByName = Object.fromEntries(
    LAYOUT_TABLE_CACHE_TARGETS.map((target) => [target.name, target.algorithms])
  );
  assert.deepEqual(algorithmsByName.sample, ['input', ...EXPECTED_ALGORITHMS]);
  assert.deepEqual(algorithmsByName['gd-collection-coords'], ['input', ...EXPECTED_ALGORITHMS]);
  assert.deepEqual(algorithmsByName.named, EXPECTED_ALGORITHMS);
  assert.deepEqual(algorithmsByName['gd-collection'], EXPECTED_ALGORITHMS);
  assert.deepEqual(algorithmsByName.north, EXPECTED_ALGORITHMS);
  assert.deepEqual(algorithmsByName.rome, EXPECTED_ALGORITHMS);
});

test('cache rebuild --list prints the explicit commands', async () => {
  const stdout = [];
  const stderr = [];
  await runCli(['--list', '--only', 'sample,named'], {
    stdout: { write(chunk) { stdout.push(String(chunk)); } },
    stderr: { write(chunk) { stderr.push(String(chunk)); } }
  });
  assert.equal(stderr.join(''), '');
  assert.match(stdout.join(''), /sample: benchmark\/sample_graphs_coords\.dot "\*" --algorithms input,schnyder,fpp,tutte,ceg_bfs,ceg_xy,reweight,forcedir,impred,air,anglebalancer,edgebalancer,facebalancer,gpt,claude --output evaluation_data\/sample-graphs-layout-table-cache\.json/);
  assert.match(stdout.join(''), /named: benchmark\/named\.dot "\*" --algorithms schnyder,fpp,tutte,ceg_bfs,ceg_xy,reweight,forcedir,impred,air,anglebalancer,edgebalancer,facebalancer,gpt,claude --output evaluation_data\/named-layout-table-cache\.json/);
});

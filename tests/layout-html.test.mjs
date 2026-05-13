import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LAYOUT_TABLE_REFRESH_TARGETS,
  runCli
} from '../scripts/layout-html.mjs';

test('refresh layout table manifest stores explicit cache to html mappings', () => {
  assert.deepEqual(LAYOUT_TABLE_REFRESH_TARGETS, [
    {
      name: 'sample',
      cachePath: 'evaluation_data/sample-graphs-layout-table-cache.json',
      outputPath: 'layout-table-sample.html'
    },
    {
      name: 'named',
      cachePath: 'evaluation_data/named-layout-table-cache.json',
      outputPath: 'layout-table-named.html'
    },
    {
      name: 'gallery',
      outputPath: 'gallery.html',
      sources: [
        {
          cachePath: 'evaluation_data/sample-graphs-layout-table-cache.json'
        },
        {
          cachePath: 'evaluation_data/named-layout-table-cache.json'
        },
        {
          cachePath: 'evaluation_data/gd-collection-coords-layout-table-cache.json',
          sampleSize: 50,
          sampleSeed: 'gallery-gd-collection'
        }
      ]
    },
    {
      name: 'gd-collection',
      cachePath: 'evaluation_data/gd-collection-coords-layout-table-cache.json',
      outputPath: 'layout-table-gd-collection.html'
    }
  ]);
});

test('refresh layout table --list prints the explicit mappings', async () => {
  const stdout = [];
  const stderr = [];
  await runCli(['--list'], {
    stdout: { write(chunk) { stdout.push(String(chunk)); } },
    stderr: { write(chunk) { stderr.push(String(chunk)); } }
  });

  assert.equal(stderr.join(''), '');
  assert.match(stdout.join(''), /sample: evaluation_data\/sample-graphs-layout-table-cache\.json -> layout-table-sample\.html/);
  assert.match(stdout.join(''), /named: evaluation_data\/named-layout-table-cache\.json -> layout-table-named\.html/);
  assert.match(stdout.join(''), /gallery: evaluation_data\/sample-graphs-layout-table-cache\.json, evaluation_data\/named-layout-table-cache\.json, evaluation_data\/gd-collection-coords-layout-table-cache\.json -> gallery\.html/);
  assert.match(stdout.join(''), /gd-collection: evaluation_data\/gd-collection-coords-layout-table-cache\.json -> layout-table-gd-collection\.html/);
});

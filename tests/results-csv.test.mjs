import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { parseCsv } from '../scripts/report-shared.mjs';

const execFileAsync = promisify(execFile);
const HEADER = [
  'dataset',
  'graph',
  'n',
  'm',
  'algorithm',
  'algorithmLabel',
  'runtimeMs',
  'ok',
  'message',
  'breakageType',
  'missingMetrics',
  'isPlane',
  'angularResolution',
  'aspectRatio',
  'convexity',
  'edgeLengthDeviation',
  'edgeRatio',
  'edgeOrthogonality',
  'face',
  'nodeUniformity',
  'alignment',
  'spacing'
];

test('results-csv replaces selected rows from cache', async () => {
  const resultsPath = path.join(process.cwd(), 'tmp-cache-update-results.csv');
  const cachePath = path.join(process.cwd(), 'tmp-cache-update-layout-table-cache.json');
  fs.writeFileSync(resultsPath, [
    HEADER.join(','),
    'toy,g1,3,2,tutte,Tutte,1,1,old,ok,,1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1',
    'toy,g1,3,2,gpt,GPT,1,1,stale,ok,,1,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.2',
    'toy,g2,4,3,tutte,Tutte,1,1,old,ok,,1,0.3,0.3,0.3,0.3,0.3,0.3,0.3,0.3,0.3,0.3',
    ''
  ].join('\n'));
  fs.writeFileSync(cachePath, JSON.stringify({
    schema: 'planarvibe-layout-table-cache',
    version: 1,
    dataset: { name: 'toy', filePath: 'toy.dot' },
    graphPattern: '*',
    algorithms: [{ key: 'gpt', label: 'GPT' }, { key: 'claude', label: 'Claude' }],
    rows: [
      {
        graphName: 'g1',
        parsed: { nodeIds: ['a', 'b', 'c'], edgePairs: [['a', 'b'], ['b', 'c']] },
        results: [
          {
            dataset: 'toy',
            graph: 'g1',
            n: 3,
            m: 2,
            algorithm: 'gpt',
            algorithmLabel: 'GPT',
            runtimeMs: 12,
            ok: true,
            message: 'fresh, quoted',
            isPlane: 1,
            angularResolution: 0.9,
            aspectRatio: 0.9,
            convexity: 0.9,
            edgeLengthDeviation: 0.9,
            edgeRatio: 0.9,
            edgeOrthogonality: 0.9,
            face: 0.9,
            nodeUniformity: 0.9,
            alignment: 0.9,
            spacing: 0.9,
            positions: {}
          },
          {
            dataset: 'toy',
            graph: 'g1',
            n: 3,
            m: 2,
            algorithm: 'claude',
            algorithmLabel: 'Claude',
            runtimeMs: 13,
            ok: false,
            message: 'failed',
            isPlane: null,
            positions: {}
          }
        ]
      },
      {
        graphName: 'g2',
        parsed: { nodeIds: ['a', 'b', 'c', 'd'], edgePairs: [['a', 'b'], ['b', 'c'], ['c', 'd']] },
        results: [
          {
            dataset: 'toy',
            graph: 'g2',
            n: 4,
            m: 3,
            algorithm: 'gpt',
            algorithmLabel: 'GPT',
            runtimeMs: 14,
            ok: true,
            message: 'fresh',
            isPlane: 1,
            angularResolution: 0.8,
            aspectRatio: 0.8,
            convexity: 0.8,
            edgeLengthDeviation: 0.8,
            edgeRatio: 0.8,
            edgeOrthogonality: 0.8,
            face: 0.8,
            nodeUniformity: 0.8,
            alignment: 0.8,
            spacing: 0.8,
            positions: {}
          }
        ]
      }
    ]
  }, null, 2));

  try {
    await execFileAsync(
      process.execPath,
      [
        'scripts/results-csv.mjs',
        '--results', resultsPath,
        '--caches', cachePath,
        '--algorithms', 'gpt,claude'
      ],
      { cwd: process.cwd() }
    );

    const rows = parseCsv(fs.readFileSync(resultsPath, 'utf8'));
    const header = rows[0];
    const ix = Object.fromEntries(header.map((column, index) => [column, index]));
    assert.deepEqual(rows.slice(1).map((row) => `${row[ix.graph]}:${row[ix.algorithm]}`), [
      'g1:tutte',
      'g1:gpt',
      'g1:claude',
      'g2:tutte',
      'g2:gpt'
    ]);
    assert.equal(rows[2][ix.message], 'fresh, quoted');
    assert.equal(rows[2][ix.angularResolution], '0.9');
    assert.equal(rows[3][ix.breakageType], 'algorithm_failed');
    assert.equal(rows[3][ix.missingMetrics], 'angularResolution|aspectRatio|convexity|edgeLengthDeviation|edgeRatio|edgeOrthogonality|face|nodeUniformity|alignment|spacing');
  } finally {
    for (const filePath of [resultsPath, cachePath]) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli } from '../scripts/aggregate-metric.mjs';

test('aggregate_metric prints overall and per-benchmark metric aggregates', async () => {
  const csvPath = path.join(process.cwd(), 'tmp-aggregate-metric.csv');
  fs.writeFileSync(csvPath, [
    'dataset,graph,n,m,algorithm,algorithmLabel,runtimeMs,ok,message,angularResolution,spacing',
    'rome,g1,3,3,tutte,Tutte,1,1,,0.2,0.5',
    'rome,g2,3,3,tutte,Tutte,1,1,,0.4,0.7',
    'north,g3,3,3,tutte,Tutte,1,1,,0.6,0.9',
    'rome,g1,3,3,air,Air,1,1,,0.8,0.2',
    'north,g3,3,3,air,Air,1,0,failed,,',
    ''
  ].join('\n'));

  try {
    const stdout = [];
    const stderr = [];
    await runCli(
      [csvPath, '--metric=angular*'],
      {
        stdout: { write(chunk) { stdout.push(String(chunk)); } },
        stderr: { write(chunk) { stderr.push(String(chunk)); } }
      }
    );

    const output = stdout.join('');
    assert.equal(stderr.join(''), '');
    assert.match(output, /## Angular Resolution \(angularResolution\)/);
    assert.match(output, /\| Tutte\s+\|\s+3 \| 0\.400 \+-/);
    assert.match(output, /\| Air\s+\|\s+1 \| 0\.800 \+- 0\.000 \|/);
    assert.match(output, /\| Algorithm \|\s+north \|\s+rome \|/);
    assert.match(output, /\| Tutte\s+\| 0\.600 \+- 0\.000 \(n=1\) \| 0\.300 \+-/);
    assert.match(output, /\| Air\s+\|\s+-- \| 0\.800 \+- 0\.000 \(n=1\) \|/);
  } finally {
    if (fs.existsSync(csvPath)) {
      fs.unlinkSync(csvPath);
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli } from '../scripts/layout-html-renderer.mjs';

test('layout-table renderer writes an html table with graph rows and algorithm columns', async () => {
  const outputPath = path.join(process.cwd(), 'tmp-layout-table-test.html');
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  try {
    const stdout = [];
    const stderr = [];
    await runCli(
      [
        'benchmark/sample_graphs_coords.dot',
        'sample1',
        '--algorithms', 'input,tutte',
        '--timeout', '30',
        '--output', outputPath
      ],
      {
        stdout: { write(chunk) { stdout.push(String(chunk)); } },
        stderr: { write(chunk) { stderr.push(String(chunk)); } }
      }
    );

    assert.equal(stderr.join(''), '');
    assert.equal(fs.existsSync(outputPath), true);

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.match(html, /<table>/);
    assert.match(html, />Graph</);
    assert.match(html, />Human</);
    assert.doesNotMatch(html, />Input</);
    assert.match(html, />Tutte</);
    assert.match(html, /sample1<br><span class="graph-size">\|V\| = 50, \|E\| = 96<\/span>/);
    assert.match(html, /<svg\b/);
    assert.match(html, /Layout Table/);
    assert.match(stdout.join(''), /Wrote .*tmp-layout-table-test\.html/);
  } finally {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  }
});

test('layout-table renderer accepts glob patterns for algorithm selection', async () => {
  const outputPath = path.join(process.cwd(), 'tmp-layout-table-glob-test.html');
  if (fs.existsSync(outputPath)) {
    fs.unlinkSync(outputPath);
  }

  try {
    await runCli(
      [
        'benchmark/sample_graphs_coords.dot',
        'sample1',
        '--algorithms', 'input,*tte*',
        '--timeout', '30',
        '--output', outputPath
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      }
    );

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.match(html, />Human</);
    assert.doesNotMatch(html, />Input</);
    assert.match(html, />Tutte</);
    assert.doesNotMatch(html, />Air</);
  } finally {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  }
});

test('layout-table renderer can render html from a cached layout table payload', async () => {
  const cachePath = path.join(process.cwd(), 'tmp-layout-table-cache-test.json');
  const outputPath = path.join(process.cwd(), 'tmp-layout-table-from-cache-test.html');
  for (const filePath of [cachePath, outputPath]) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  try {
    const cacheStdout = [];
    await runCli(
      [
        'benchmark/sample_graphs_coords.dot',
        'sample1',
        '--algorithms', 'input,tutte',
        '--timeout', '30',
        '--cache-only',
        '--output', cachePath
      ],
      {
        stdout: { write(chunk) { cacheStdout.push(String(chunk)); } },
        stderr: { write() {} }
      }
    );

    assert.equal(fs.existsSync(cachePath), true);
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.equal(cache.schema, 'planarvibe-layout-table-cache');
    assert.equal(cache.version, 1);
    assert.equal(cache.dataset.filePath, 'benchmark/sample_graphs_coords.dot');
    assert.equal(cache.graphPattern, 'sample1');
    assert.deepEqual(cache.algorithms.map((alg) => alg.label), ['Input', 'Tutte']);
    assert.equal(cache.rows.length, 1);
    assert.equal(cache.rows[0].results.length, 2);
    assert.ok(cache.rows[0].results[0].positions);
    assert.match(cacheStdout.join(''), /Wrote .*tmp-layout-table-cache-test\.json/);

    const htmlStdout = [];
    await runCli(
      [
        '--from-cache', cachePath,
        '--output', outputPath
      ],
      {
        stdout: { write(chunk) { htmlStdout.push(String(chunk)); } },
        stderr: { write() {} }
      }
    );

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.match(html, />Human</);
    assert.doesNotMatch(html, />Input</);
    assert.match(html, />Tutte</);
    assert.match(html, /sample1<br><span class="graph-size">\|V\| = 50, \|E\| = 96<\/span>/);
    assert.match(html, /<svg\b/);
    assert.match(htmlStdout.join(''), /Read .*tmp-layout-table-cache-test\.json/);
    assert.match(htmlStdout.join(''), /Wrote .*tmp-layout-table-from-cache-test\.html/);
  } finally {
    for (const filePath of [cachePath, outputPath]) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }
});

test('layout-table renderer orders cached columns for display', async () => {
  const cachePath = path.join(process.cwd(), 'tmp-layout-table-order-cache-test.json');
  const outputPath = path.join(process.cwd(), 'tmp-layout-table-order-test.html');
  for (const filePath of [cachePath, outputPath]) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }

  try {
    const cache = {
      schema: 'planarvibe-layout-table-cache',
      version: 1,
      generatedAt: '2026-05-11T00:00:00.000Z',
      dataset: {
        name: 'sample_graphs_coords',
        filePath: 'benchmark/sample_graphs_coords.dot'
      },
      graphPattern: 'sample1',
      algorithms: [
        { key: 'tutte', label: 'Tutte' },
        { key: 'claude', label: 'Claude' },
        { key: 'schnyder', label: 'Schnyder' },
        { key: 'gpt', label: 'GPT' },
        { key: 'input', label: 'Input' }
      ],
      rows: [
        {
          graphName: 'sample1',
          parsed: {
            nodeIds: ['0', '1'],
            edgePairs: [['0', '1']]
          },
          results: [
            { algorithm: 'tutte', ok: false, message: 'test' },
            { algorithm: 'claude', ok: false, message: 'test' },
            { algorithm: 'schnyder', ok: false, message: 'test' },
            { algorithm: 'gpt', ok: false, message: 'test' },
            { algorithm: 'input', ok: false, message: 'test' }
          ]
        }
      ]
    };
    fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`);

    await runCli(
      [
        '--from-cache', cachePath,
        '--output', outputPath
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      }
    );

    const html = fs.readFileSync(outputPath, 'utf8');
    const headers = [...html.matchAll(/<th scope="col">([^<]+)<\/th>/g)].map((match) => match[1]);
    assert.deepEqual(headers, ['Graph', 'Human', 'GPT', 'Claude', 'Schnyder', 'Tutte']);
  } finally {
    for (const filePath of [cachePath, outputPath]) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
  }
});

test('layout-table renderer cache-only update mode preserves cached algorithm results', async () => {
  const cachePath = path.join(process.cwd(), 'tmp-layout-table-update-cache-test.json');
  if (fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }

  try {
    await runCli(
      [
        'benchmark/sample_graphs_coords.dot',
        'sample1',
        '--algorithms', 'input',
        '--timeout', '30',
        '--cache-only',
        '--output', cachePath
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      }
    );

    await runCli(
      [
        'benchmark/sample_graphs_coords.dot',
        'sample1',
        '--algorithms', 'tutte',
        '--timeout', '30',
        '--concurrency', '2',
        '--cache-only',
        '--update-cache',
        '--output', cachePath
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      }
    );

    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    assert.deepEqual(cache.algorithms.map((alg) => alg.key), ['input', 'tutte']);
    assert.equal(cache.rows.length, 1);
    assert.deepEqual(cache.rows[0].results.map((result) => result.algorithm), ['input', 'tutte']);
    assert.ok(cache.rows[0].results[0].positions);
    assert.ok(cache.rows[0].results[1].positions);
  } finally {
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath);
    }
  }
});

test('layout-table renderer still renders non-plane input drawings when positions are available', async () => {
  const datasetPath = path.join(process.cwd(), 'tmp-nonplane-input.dot');
  const outputPath = path.join(process.cwd(), 'tmp-layout-table-nonplane-test.html');

  fs.writeFileSync(datasetPath, [
    'graph crossing_sample {',
    '  v 0 0 0;',
    '  v 1 100 100;',
    '  v 2 0 100;',
    '  v 3 100 0;',
    '  0 -- 1;',
    '  2 -- 3;',
    '}',
    ''
  ].join('\n'));

  try {
    await runCli(
      [
        datasetPath,
        'crossing_sample',
        '--algorithms', 'input',
        '--timeout', '30',
        '--output', outputPath
      ],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      }
    );

    const html = fs.readFileSync(outputPath, 'utf8');
    assert.match(html, />Human</);
    assert.doesNotMatch(html, />Input</);
    assert.match(html, /cell-status is-fail">failed</);
    assert.match(html, /Used input coordinates \[non-plane drawing\]/);
    assert.match(html, /<svg\b/);
  } finally {
    if (fs.existsSync(datasetPath)) {
      fs.unlinkSync(datasetPath);
    }
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  }
});

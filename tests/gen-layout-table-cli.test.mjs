import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { runCli } from '../scripts/gen-layout-table.mjs';

test('gen_layout_table writes an html table with graph rows and algorithm columns', async () => {
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
    assert.match(html, />Input</);
    assert.match(html, />Tutte</);
    assert.match(html, /sample1 \(50v, 96e\)/);
    assert.match(html, /<svg\b/);
    assert.match(html, /Layout Table/);
    assert.match(stdout.join(''), /Wrote .*tmp-layout-table-test\.html/);
  } finally {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  }
});

test('gen_layout_table accepts glob patterns for algorithm selection', async () => {
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
    assert.match(html, />Input</);
    assert.match(html, />Tutte</);
    assert.doesNotMatch(html, />Air</);
  } finally {
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }
  }
});

test('gen_layout_table still renders non-plane input drawings when positions are available', async () => {
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
    assert.match(html, />Input</);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runCli } from '../scripts/apply-layout-js.mjs';
import {
  createMockCy,
  initializeMockCyPositions,
  loadBrowserModules,
  parseEdgeListText
} from '../scripts/report-shared.mjs';

test('apply_layout runs a layout on regex-matched graphs and prints metrics', async () => {
  const stdout = [];
  const stderr = [];
  await runCli(
    ['benchmark/named.dot', 'sample*', '--algorithm', 'tutte', '--timeout', '30'],
    {
      stdout: { write(chunk) { stdout.push(String(chunk)); } },
      stderr: { write(chunk) { stderr.push(String(chunk)); } }
    }
  );

  const output = stdout.join('');
  assert.equal(stderr.join(''), '');

  assert.match(output, /Dataset File: benchmark\/named\.dot/);
  assert.match(output, /Graph Pattern: sample\*/);
  assert.match(output, /Matched Graphs: 7/);
  assert.match(output, /Algorithm: Tutte/);
  assert.match(output, /Timeout \(s\): 30\.0000/);
  assert.match(output, /\[1\/7\] Running sample1/);
  assert.match(output, /=== sample1 ===/);
  assert.match(output, /=== sample2 ===/);
  assert.match(output, /Angular Resolution\s+: \d+\.\d{4}/);
  assert.match(output, /Aspect Ratio\s+: \d+\.\d{4}/);
  assert.match(output, /Edge-Length Deviation\s+: \d+\.\d{4}/);
  assert.match(output, /Face-Area Uniformity\s+: \d+\.\d{4}/);
  assert.match(output, /Spacing Uniformity\s+: \d+\.\d{4}/);
  assert.doesNotMatch(output, /Missing Metrics: /);
});

test('apply_layout accepts benchmark dot collections with embedded vertex coordinates', async () => {
  const stdout = [];
  const stderr = [];
  await runCli(
    ['benchmark/sample_graphs_coords.dot', 'sample1', '--algorithm', 'tutte', '--timeout', '30'],
    {
      stdout: { write(chunk) { stdout.push(String(chunk)); } },
      stderr: { write(chunk) { stderr.push(String(chunk)); } }
    }
  );

  const output = stdout.join('');
  assert.equal(stderr.join(''), '');
  assert.match(output, /Dataset File: benchmark\/sample_graphs_coords\.dot/);
  assert.match(output, /Matched Graphs: 1/);
  assert.match(output, /=== sample1 ===/);
  assert.match(output, /Angular Resolution\s+: \d+\.\d{4}/);
});

test('apply_layout uses embedded coordinates when --algorithm input is selected', async () => {
  const stdout = [];
  const stderr = [];
  await runCli(
    ['benchmark/sample_graphs_coords.dot', 'sample1', '--algorithm', 'input', '--timeout', '30'],
    {
      stdout: { write(chunk) { stdout.push(String(chunk)); } },
      stderr: { write(chunk) { stderr.push(String(chunk)); } }
    }
  );

  const output = stdout.join('');
  assert.equal(stderr.join(''), '');
  assert.match(output, /Algorithm: Input/);
  assert.match(output, /Status: ok/);
  assert.match(output, /Message: Used input coordinates/);
  assert.match(output, /Angular Resolution\s+: \d+\.\d{4}/);
});

test('apply_layout accepts algorithm glob patterns with --algorithm', async () => {
  const stdout = [];
  const stderr = [];
  await runCli(
    ['benchmark/sample_graphs_coords.dot', 'sample1', '--algorithm', 'input,*tte*', '--timeout', '30'],
    {
      stdout: { write(chunk) { stdout.push(String(chunk)); } },
      stderr: { write(chunk) { stderr.push(String(chunk)); } }
    }
  );

  const output = stdout.join('');
  assert.equal(stderr.join(''), '');
  assert.match(output, /Matched Algorithms: 2/);
  assert.match(output, /Algorithms: Input, Tutte/);
  assert.match(output, /\[1\/2\] Running sample1 :: Input/);
  assert.match(output, /\[2\/2\] Running sample1 :: Tutte/);
  assert.match(output, /Message: Used input coordinates/);
  assert.match(output, /Message: Applied Tutte/);
});

test('mock layout initialization uses explicit input coordinates when present', () => {
  const windowObj = loadBrowserModules();
  const cy = createMockCy(['a', 'b', 'c'], [['a', 'b'], ['b', 'c'], ['c', 'a']]);
  const pos = initializeMockCyPositions(
    cy,
    ['a', 'b', 'c'],
    'seed-key',
    {
      a: { x: 0, y: 0 },
      b: { x: 1000, y: 0 },
      c: { x: 0, y: 1000 }
    },
    windowObj.GeometryUtils
  );

  assert.deepEqual(Object.keys(pos).sort(), ['a', 'b', 'c']);
  assert.equal(Number.isFinite(pos.a.x), true);
  assert.equal(Number.isFinite(pos.a.y), true);
  assert.equal(Number.isFinite(pos.b.x), true);
  assert.equal(Number.isFinite(pos.c.y), true);
  assert.ok(Math.abs(pos.a.x - 164) < 1e-6);
  assert.ok(Math.abs(pos.a.y - 24) < 1e-6);
  assert.ok(Math.abs(pos.b.x - 736) < 1e-6);
  assert.ok(Math.abs(pos.c.y - 596) < 1e-6);
});

test('Claude module candidates receive initial positions during preparation', async () => {
  const windowObj = loadBrowserModules();
  const parsed = parseEdgeListText(windowObj.PlanarVibeGraphGenerator.getSample('xtree30'));
  const cy = createMockCy(parsed.nodeIds, parsed.edgePairs);
  initializeMockCyPositions(
    cy,
    parsed.nodeIds,
    'named:xtree30',
    null,
    windowObj.GeometryUtils
  );

  const originalPrepare = windowObj.PlanarVibeEdgeBalancer.prepareGraphData;
  const sawCurrentPositions = [];
  windowObj.PlanarVibeEdgeBalancer.prepareGraphData = function (graph, options) {
    sawCurrentPositions.push(!!(options && options.currentPositions));
    return originalPrepare.call(this, graph, options);
  };

  try {
    const result = await windowObj.PlanarVibeClaude.applyLayout(cy);
    assert.equal(result && result.ok, true, result && result.message ? result.message : 'Claude failed');
  } finally {
    windowObj.PlanarVibeEdgeBalancer.prepareGraphData = originalPrepare;
  }

  assert.ok(sawCurrentPositions.length > 0, 'Claude should run the EdgeBalancer candidate');
  assert.deepEqual(sawCurrentPositions, sawCurrentPositions.map(() => true));
});

test('Claude skips balancer candidates when augmented interior is above cap', async () => {
  const windowObj = loadBrowserModules();
  const parsed = parseEdgeListText(windowObj.PlanarVibeGraphGenerator.getSample('xtree30'));
  const cy = createMockCy(parsed.nodeIds, parsed.edgePairs);
  initializeMockCyPositions(
    cy,
    parsed.nodeIds,
    'named:xtree30',
    null,
    windowObj.GeometryUtils
  );

  const originalPrepare = windowObj.PlanarVibeEdgeBalancer.prepareGraphData;
  const originalCompute = windowObj.PlanarVibeEdgeBalancer.computePositions;
  let prepareCount = 0;
  let computeCalled = false;
  windowObj.PlanarVibeEdgeBalancer.prepareGraphData = function () {
    prepareCount += 1;
    return {
      ok: true,
      augmented: {
        graph: {
          nodeIds: Array.from({ length: 450 }, (_, i) => String(i))
        }
      },
      augmentedOuterFace: Array.from({ length: 10 }, (_, i) => String(i))
    };
  };
  windowObj.PlanarVibeEdgeBalancer.computePositions = function () {
    computeCalled = true;
    return { ok: false, message: 'should have been skipped' };
  };

  try {
    const result = await windowObj.PlanarVibeClaude.applyLayout(cy);
    assert.equal(result && result.ok, true, result && result.message ? result.message : 'Claude failed');
  } finally {
    windowObj.PlanarVibeEdgeBalancer.prepareGraphData = originalPrepare;
    windowObj.PlanarVibeEdgeBalancer.computePositions = originalCompute;
  }

  assert.equal(prepareCount, 1);
  assert.equal(computeCalled, false);
});

test('layout algorithms use input coordinates to choose the outer face when available', async () => {
  const stdoutPlain = [];
  await runCli(
    ['benchmark/named.dot', 'sample5', '--algorithm', 'air', '--timeout', '30'],
    {
      stdout: { write(chunk) { stdoutPlain.push(String(chunk)); } },
      stderr: { write() {} }
    }
  );

  const stdoutCoords = [];
  await runCli(
    ['benchmark/sample_graphs_coords.dot', 'sample5', '--algorithm', 'air', '--timeout', '30'],
    {
      stdout: { write(chunk) { stdoutCoords.push(String(chunk)); } },
      stderr: { write() {} }
    }
  );

  assert.match(stdoutPlain.join(''), /Message: Applied Air \(9-vertex outer face,/);
  assert.match(stdoutCoords.join(''), /Message: Applied Air \(23-vertex outer face,/);
});

test('apply_layout reports a clear failure for --algorithm input without coordinates', async () => {
  const stdout = [];
  const stderr = [];
  await runCli(
    ['benchmark/named.dot', 'sample1', '--algorithm', 'input', '--timeout', '30'],
    {
      stdout: { write(chunk) { stdout.push(String(chunk)); } },
      stderr: { write(chunk) { stderr.push(String(chunk)); } }
    }
  );

  const output = stdout.join('');
  assert.equal(stderr.join(''), '');
  assert.match(output, /Algorithm: Input/);
  assert.match(output, /Status: failed/);
  assert.match(output, /Message: Input coordinates are missing or invalid for one or more vertices/);
  assert.match(output, /Missing Metrics: /);
});

test('apply_layout exports svg and pdf when requested', async () => {
  const cleanup = ['sample1.svg', 'sample1.pdf', 'tmp-named-layout.svg', 'tmp-named-layout.pdf'];
  for (const file of cleanup) {
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  }

  try {
    const stdoutSvg = [];
    await runCli(
      ['benchmark/named.dot', 'sample1', '--algorithm', 'tutte', '--timeout', '30', '--export=svg'],
      {
        stdout: { write(chunk) { stdoutSvg.push(String(chunk)); } },
        stderr: { write() {} }
      }
    );
    assert.equal(fs.existsSync('sample1.svg'), true);
    const svgText = fs.readFileSync('sample1.svg', 'utf8');
    assert.match(svgText, /<svg\b/);
    assert.match(svgText, /<circle[^>]* r="6"/);
    assert.doesNotMatch(svgText, /<text\b/);
    assert.match(stdoutSvg.join(''), /Exported SVG : sample1\.svg/);

    const stdoutPdf = [];
    await runCli(
      ['benchmark/named.dot', 'sample1', '--algorithm', 'tutte', '--timeout', '30', '--export=pdf'],
      {
        stdout: { write(chunk) { stdoutPdf.push(String(chunk)); } },
        stderr: { write() {} }
      }
    );
    assert.equal(fs.existsSync('sample1.pdf'), true);
    const pdfBytes = fs.readFileSync('sample1.pdf');
    const pdfHeader = pdfBytes.subarray(0, 8).toString('utf8');
    assert.match(pdfHeader, /%PDF-1\./);
    assert.doesNotMatch(pdfBytes.toString('latin1'), / Tj\b/);
    assert.match(stdoutPdf.join(''), /Exported PDF : sample1\.pdf/);

    const stdoutNamedSvg = [];
    await runCli(
      ['benchmark/named.dot', 'sample1', '--algorithm', 'tutte', '--timeout', '30', '--export=tmp-named-layout.svg'],
      {
        stdout: { write(chunk) { stdoutNamedSvg.push(String(chunk)); } },
        stderr: { write() {} }
      }
    );
    assert.equal(fs.existsSync('tmp-named-layout.svg'), true);
    assert.match(fs.readFileSync('tmp-named-layout.svg', 'utf8'), /<circle[^>]* r="6"/);
    assert.match(stdoutNamedSvg.join(''), /Exported SVG : tmp-named-layout\.svg/);

    const stdoutNamedPdf = [];
    await runCli(
      ['benchmark/named.dot', 'sample1', '--algorithm', 'tutte', '--timeout', '30', '--export=tmp-named-layout.pdf'],
      {
        stdout: { write(chunk) { stdoutNamedPdf.push(String(chunk)); } },
        stderr: { write() {} }
      }
    );
    assert.equal(fs.existsSync('tmp-named-layout.pdf'), true);
    assert.match(fs.readFileSync('tmp-named-layout.pdf').subarray(0, 8).toString('utf8'), /%PDF-1\./);
    assert.match(stdoutNamedPdf.join(''), /Exported PDF : tmp-named-layout\.pdf/);
  } finally {
    for (const file of cleanup) {
      if (fs.existsSync(file)) {
        fs.unlinkSync(file);
      }
    }
  }
});

test('apply_layout rejects one named export file for multiple matched graphs', async () => {
  await assert.rejects(
    () => runCli(
      ['benchmark/named.dot', 'sample*', '--algorithm', 'tutte', '--timeout', '30', '--export=tmp-many.svg'],
      {
        stdout: { write() {} },
        stderr: { write() {} }
      }
    ),
    /names one file, but "sample\*" matched 7 graphs/
  );
});

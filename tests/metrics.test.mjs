import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function loadMetricsModules() {
  const window = {};
  window.window = window;

  const context = vm.createContext({
    window,
    console,
    Math,
    Set,
    Map,
    Array,
    Object,
    String,
    Number
  });

  const files = [
    'static/js/planarity-test.js',
    'static/js/metrics.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    const script = new vm.Script(code, { filename: rel });
    script.runInContext(context);
  }

  return window.PlanarVibeMetrics;
}

const Metrics = loadMetricsModules();

test('computeUniformityScore: uniform distribution scores 1', () => {
  const values = [0.25, 0.25, 0.25, 0.25];
  const ideal = [0.25, 0.25, 0.25, 0.25];
  const score = Metrics.computeUniformityScore(values, ideal);
  assert.equal(score, 1);
});

test('computeUniformityScore: simplex extreme scores 0 for uniform ideal', () => {
  const values = [1, 0, 0, 0];
  const ideal = [0.25, 0.25, 0.25, 0.25];
  const score = Metrics.computeUniformityScore(values, ideal);
  assert.equal(score, 0);
});

test('computeUniformityScore: custom ideal accepts non-uniform target', () => {
  const ideal = [0.5, 0.3, 0.2];
  const same = Metrics.computeUniformityScore([0.5, 0.3, 0.2], ideal);
  const different = Metrics.computeUniformityScore([0.2, 0.2, 0.6], ideal);
  assert.equal(same, 1);
  assert.ok(different < 1);
  assert.ok(different >= 0);
});

test('computeUniformEdgeLengthScore normalizes and sorts edge lengths', () => {
  const edges = [['1', '2'], ['2', '3']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 3, y: 0 }
  };

  const result = Metrics.computeUniformEdgeLengthScore(edges, posById);
  assert.equal(result.ok, true);
  assert.equal(result.values.length, 2);
  assert.ok(Math.abs(result.values[0] - 1 / 3) < 1e-9);
  assert.ok(Math.abs(result.values[1] - 2 / 3) < 1e-9);
  assert.equal(result.ideal, 0.5);
  assert.ok(Math.abs(result.quality - Metrics.computeDistributionQuality(result.values)) < 1e-12);
});

test('computeUniformFaceAreaScore returns two equal bounded faces on a triangulated square', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const edgePairs = [
    ['1', '2'],
    ['2', '3'],
    ['3', '4'],
    ['4', '1'],
    ['1', '3']
  ];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 1, y: 1 },
    '4': { x: 0, y: 1 }
  };

  const result = Metrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById);
  assert.equal(result.ok, true);
  assert.equal(result.values.length, 2);
  assert.ok(Math.abs(result.values[0] - 0.5) < 1e-9);
  assert.ok(Math.abs(result.values[1] - 0.5) < 1e-9);
  assert.equal(result.ideal, 0.5);
  assert.equal(result.quality, 1);
});

test('computeUniformFaceAreaScore fails for non-planar graph', () => {
  const left = ['a', 'b', 'c'];
  const right = ['x', 'y', 'z'];
  const nodeIds = left.concat(right);
  const edgePairs = [];
  for (const u of left) {
    for (const v of right) {
      edgePairs.push([u, v]);
    }
  }
  const posById = {};
  for (let i = 0; i < nodeIds.length; i += 1) {
    posById[nodeIds[i]] = { x: i, y: 0 };
  }

  const result = Metrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Graph is not planar');
});

test('hasCrossingsFromPositions detects crossing and non-crossing drawings', () => {
  const crossingEdges = [['1', '2'], ['3', '4']];
  const crossingPos = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 1 },
    '3': { x: 0, y: 1 },
    '4': { x: 1, y: 0 }
  };
  assert.equal(Metrics.hasCrossingsFromPositions(crossingPos, crossingEdges), true);

  const nonCrossingEdges = [['1', '2'], ['2', '3']];
  const nonCrossingPos = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 2, y: 0 }
  };
  assert.equal(Metrics.hasCrossingsFromPositions(nonCrossingPos, nonCrossingEdges), false);
});

test('isBipartiteGraph works for even cycle and odd cycle', () => {
  const evenNodes = ['1', '2', '3', '4'];
  const evenEdges = [['1', '2'], ['2', '3'], ['3', '4'], ['4', '1']];
  assert.equal(Metrics.isBipartiteGraph(evenNodes, evenEdges), true);

  const oddNodes = ['1', '2', '3'];
  const oddEdges = [['1', '2'], ['2', '3'], ['3', '1']];
  assert.equal(Metrics.isBipartiteGraph(oddNodes, oddEdges), false);
});

test('computeUniformAngleResolutionScore is better on symmetric K4 than skewed K4', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const edgePairs = [
    ['1', '2'], ['2', '3'], ['3', '1'],
    ['1', '4'], ['2', '4'], ['3', '4']
  ];
  const sqrt3 = Math.sqrt(3);
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 0 },
    '3': { x: 1, y: sqrt3 },
    '4': { x: 1, y: sqrt3 / 3 }
  };

  const skewedPosById = {
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 0 },
    '3': { x: 1, y: sqrt3 },
    '4': { x: 0.2, y: 0.1 }
  };

  const symmetric = Metrics.computeUniformAngleResolutionScore(nodeIds, edgePairs, posById);
  const skewed = Metrics.computeUniformAngleResolutionScore(nodeIds, edgePairs, skewedPosById);

  assert.equal(symmetric.ok, true);
  assert.equal(skewed.ok, true);
  assert.ok(symmetric.score >= 0 && symmetric.score <= 1);
  assert.ok(skewed.score >= 0 && skewed.score <= 1);
  assert.ok(symmetric.score > skewed.score + 0.05);
});

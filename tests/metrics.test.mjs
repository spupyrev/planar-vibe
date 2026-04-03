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
    'static/js/linear-algebra.js',
    'static/js/geometry-utils.js',
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/metrics.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    const script = new vm.Script(code, { filename: rel });
    script.runInContext(context);
  }

  return {
    GraphUtils: window.GraphUtils,
    Metrics: window.PlanarVibeMetrics,
    PlanarityTest: window.PlanarVibePlanarityTest
  };
}

const loaded = loadMetricsModules();
const GraphUtils = loaded.GraphUtils;
const Metrics = loaded.Metrics;
const PlanarityTest = loaded.PlanarityTest;

test('adjacency builders normalize duplicate simple edges consistently', () => {
  const nodeIds = ['1', '2', '3'];
  const edgePairs = [
    ['1', '2'],
    ['2', '1'],
    ['1', '2'],
    ['2', '2'],
    ['2', '3']
  ];

  const adjacencyArrays = GraphUtils.buildAdjacencyArrays(nodeIds, edgePairs);
  assert.deepEqual(JSON.parse(JSON.stringify(adjacencyArrays)), {
    '1': ['2'],
    '2': ['1', '3'],
    '3': ['2']
  });

  const adjacencySets = GraphUtils.buildAdjacencySets(nodeIds, edgePairs);
  assert.deepEqual({
    '1': Array.from(adjacencySets['1']).sort(),
    '2': Array.from(adjacencySets['2']).sort(),
    '3': Array.from(adjacencySets['3']).sort()
  }, {
    '1': ['2'],
    '2': ['1', '3'],
    '3': ['2']
  });
});

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

test('computeEdgeLengthRatio returns shortest/longest ratio', () => {
  const edges = [['1', '2'], ['2', '3']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 3, y: 0 }
  };
  const result = Metrics.computeEdgeLengthRatio(edges, posById);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.minLength - 1) < 1e-12);
  assert.ok(Math.abs(result.maxLength - 2) < 1e-12);
  assert.ok(Math.abs(result.ratio - 0.5) < 1e-12);
});

test('computeEdgeLengthRatio fails with no valid lengths', () => {
  const edges = [['1', '2']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 0, y: 0 }
  };
  const result = Metrics.computeEdgeLengthRatio(edges, posById);
  assert.equal(result.ok, false);
});

test('computeUniformFaceAreaScore uses bounded-face weights from the embedding', () => {
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
  const emb = PlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
  assert.equal(result.ok, true);
  assert.equal(result.values.length, 2);
  const outerFace = emb.outerFace || [];
  const bounded = emb.faces.filter((face) => face.join('|') !== outerFace.join('|') && face.slice().reverse().join('|') !== outerFace.join('|'));
  const expectedIdeal = bounded
    .map((face) => Math.max(1, face.length - 2))
    .map((w, _, arr) => w / arr.reduce((s, x) => s + x, 0))
    .sort((a, b) => a - b);
  assert.deepEqual(result.idealValues, expectedIdeal);
  assert.equal(result.idealValues.length, 2);
  assert.deepEqual(result.values, expectedIdeal);
  assert.equal(result.quality, 1);
});

test('computeUniformFaceAreaScore uses |f|-2 weights for non-triangular bounded faces', () => {
  const nodeIds = ['1', '2', '3', '4', '5'];
  const edgePairs = [
    ['1', '2'],
    ['2', '3'],
    ['3', '4'],
    ['4', '5'],
    ['5', '1'],
    ['1', '3']
  ];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 0 },
    '3': { x: 3, y: 1 },
    '4': { x: 1.5, y: 3 },
    '5': { x: -1, y: 2 }
  };

  const result = Metrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById);
  const emb = PlanarityTest.computePlanarEmbedding(nodeIds, edgePairs);
  assert.equal(result.ok, true);
  assert.equal(result.values.length, 2);
  assert.equal(result.idealValues.length, 2);
  const outerFace = emb.outerFace || [];
  const bounded = emb.faces.filter((face) => face.join('|') !== outerFace.join('|') && face.slice().reverse().join('|') !== outerFace.join('|'));
  const expectedIdeal = bounded
    .map((face) => Math.max(1, face.length - 2))
    .map((w, _, arr) => w / arr.reduce((s, x) => s + x, 0))
    .sort((a, b) => a - b);
  assert.deepEqual(result.idealValues, expectedIdeal);
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
  assert.equal(GraphUtils.hasPositionCrossings(crossingPos, crossingEdges), true);

  const nonCrossingEdges = [['1', '2'], ['2', '3']];
  const nonCrossingPos = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 2, y: 0 }
  };
  assert.equal(GraphUtils.hasPositionCrossings(nonCrossingPos, nonCrossingEdges), false);
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

test('computeSpacingUniformityScore is 1 for equal nearest-neighbor spacing', () => {
  const nodeIds = ['1', '2', '3', '4', '5', '6'];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 2, y: 0 },
    '4': { x: 3, y: 0 },
    '5': { x: 4, y: 0 },
    '6': { x: 5, y: 0 }
  };
  const result = Metrics.computeSpacingUniformityScore(nodeIds, posById, { boundaryTrimQuantile: 0 });
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.score - 1) < 1e-12);
});

test('computeSpacingUniformityScore decreases for uneven spacing', () => {
  const nodeIds = ['1', '2', '3', '4', '5'];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 0.1, y: 0 },
    '3': { x: 0.2, y: 0 },
    '4': { x: 5, y: 0 },
    '5': { x: 10, y: 0 }
  };
  const result = Metrics.computeSpacingUniformityScore(nodeIds, posById, { boundaryTrimQuantile: 0 });
  assert.equal(result.ok, true);
  assert.ok(result.score < 0.6);
});

test('computeSpacingUniformityScore returns no-data for insufficient valid distances', () => {
  const nodeIds = ['1', '2', '3'];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 0, y: 0 },
    '3': { x: 0, y: 0 }
  };
  const result = Metrics.computeSpacingUniformityScore(nodeIds, posById);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Not enough valid nearest-neighbor distances');
});

test('hasCrossingsFromPositions rejects a vertex on a non-incident edge', () => {
  const edgePairs = [['1', '2']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 10, y: 0 },
    '3': { x: 5, y: 0 }
  };
  assert.equal(GraphUtils.hasPositionCrossings(posById, edgePairs), true);
});

test('computeAxisAlignmentScore is 0 when all x and y coordinates are distinct with zero tolerance', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 2 },
    '3': { x: 2, y: 4 },
    '4': { x: 3, y: 6 }
  };
  const result = Metrics.computeAxisAlignmentScore(nodeIds, posById, { tolerance: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.lineCountX, 4);
  assert.equal(result.lineCountY, 4);
  assert.equal(result.score, 0);
});

test('computeAxisAlignmentScore gives 0.5 when all points share one x-line but all y coordinates are distinct', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const posById = {
    '1': { x: 5, y: 0 },
    '2': { x: 5, y: 1 },
    '3': { x: 5, y: 2 },
    '4': { x: 5, y: 3 }
  };
  const result = Metrics.computeAxisAlignmentScore(nodeIds, posById, { tolerance: 0 });
  assert.equal(result.ok, true);
  assert.equal(result.lineCountX, 1);
  assert.equal(result.lineCountY, 4);
  assert.equal(result.scoreX, 1);
  assert.equal(result.scoreY, 0);
  assert.equal(result.score, 0.5);
});

test('computeAxisAlignmentScore auto-clusters jittered coordinates into reused axis lines', () => {
  const nodeIds = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const posById = {
    '1': { x: 0.00, y: 0 },
    '2': { x: 0.01, y: 1 },
    '3': { x: 0.02, y: 2 },
    '4': { x: 1.00, y: 3 },
    '5': { x: 1.01, y: 4 },
    '6': { x: 1.02, y: 5 },
    '7': { x: 2.00, y: 6 },
    '8': { x: 2.01, y: 7 },
    '9': { x: 2.02, y: 8 }
  };
  const result = Metrics.computeAxisAlignmentScore(nodeIds, posById);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.clusterSizesX), [3, 3, 3]);
  assert.deepEqual(Array.from(result.clusterSizesY), [1, 1, 1, 1, 1, 1, 1, 1, 1]);
  assert.ok(Math.abs(result.scoreX - 0.75) < 1e-9);
  assert.ok(Math.abs(result.scoreY - 0) < 1e-9);
  assert.ok(Math.abs(result.score - 0.375) < 1e-9);
});

test('computeAxisAlignmentScore ignores zero gaps when estimating tolerance', () => {
  const nodeIds = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const posById = {
    '1': { x: 0.0, y: 0 },
    '2': { x: 0.0, y: 1 },
    '3': { x: 0.0, y: 2 },
    '4': { x: 10.0, y: 3 },
    '5': { x: 10.1, y: 4 },
    '6': { x: 10.2, y: 5 },
    '7': { x: 20.0, y: 6 },
    '8': { x: 20.0, y: 7 },
    '9': { x: 20.0, y: 8 }
  };
  const result = Metrics.computeAxisAlignmentScore(nodeIds, posById);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.clusterSizesX), [3, 3, 3]);
  assert.ok(result.toleranceX > 0.19);
  assert.equal(result.toleranceSourceX, 'quantile');
});

test('computeAxisAlignmentScore treats one heavy line plus one outlier as more aligned than a balanced two-line split', () => {
  const nodeIds = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const skewedPosById = {
    '1': { x: 0, y: 0 },
    '2': { x: 0, y: 1 },
    '3': { x: 0, y: 2 },
    '4': { x: 0, y: 3 },
    '5': { x: 0, y: 4 },
    '6': { x: 0, y: 5 },
    '7': { x: 0, y: 6 },
    '8': { x: 0, y: 7 },
    '9': { x: 10, y: 8 }
  };
  const balancedPosById = {
    '1': { x: 0, y: 0 },
    '2': { x: 0, y: 1 },
    '3': { x: 0, y: 2 },
    '4': { x: 0, y: 3 },
    '5': { x: 0, y: 4 },
    '6': { x: 10, y: 5 },
    '7': { x: 10, y: 6 },
    '8': { x: 10, y: 7 },
    '9': { x: 10, y: 8 }
  };
  const skewed = Metrics.computeAxisAlignmentScore(nodeIds, skewedPosById, { tolerance: 0.1 });
  const balanced = Metrics.computeAxisAlignmentScore(nodeIds, balancedPosById, { tolerance: 0.1 });
  assert.equal(skewed.ok, true);
  assert.equal(balanced.ok, true);
  assert.equal(skewed.lineCountX, 2);
  assert.equal(balanced.lineCountX, 2);
  assert.ok(skewed.effectiveLineCountX < balanced.effectiveLineCountX);
  assert.ok(skewed.scoreX > balanced.scoreX);
  assert.ok(skewed.score > balanced.score);
});

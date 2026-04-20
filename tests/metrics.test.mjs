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
    'static/js/graph-generator.js',
    'static/js/planarity-test.js',
    'static/js/linear-algebra.js',
    'static/js/geometry-utils.js',
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/metrics.js',
    'static/js/rotation.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    const script = new vm.Script(code, { filename: rel });
    script.runInContext(context);
  }

  return {
    GraphGenerator: window.PlanarVibeGraphGenerator,
    GeometryUtils: window.GeometryUtils,
    GraphUtils: window.GraphUtils,
    Metrics: window.PlanarVibeMetrics,
    Rotation: window.PlanarVibeRotation,
    PlanarityTest: window.PlanarVibePlanarityTest,
    PlanarGraphUtils: window.PlanarGraphUtils
  };
}

const loaded = loadMetricsModules();
const GraphGenerator = loaded.GraphGenerator;
const GeometryUtils = loaded.GeometryUtils;
const GraphUtils = loaded.GraphUtils;
const Metrics = loaded.Metrics;
const Rotation = loaded.Rotation;
const PlanarityTest = loaded.PlanarityTest;
const PlanarGraphUtils = loaded.PlanarGraphUtils;

function parseSampleWithCoordinates(text) {
  const nodeIds = [];
  const nodeSet = new Set();
  const posById = {};
  const edgePairs = [];
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' || parts[0] === 'V') {
      if (parts.length < 4) continue;
      const id = String(parts[1]);
      posById[id] = { x: Number(parts[2]), y: Number(parts[3]) };
      if (!nodeSet.has(id)) {
        nodeSet.add(id);
        nodeIds.push(id);
      }
      continue;
    }
    if (parts.length < 2) continue;
    const u = String(parts[0]);
    const v = String(parts[1]);
    edgePairs.push([u, v]);
    if (!nodeSet.has(u)) {
      nodeSet.add(u);
      nodeIds.push(u);
    }
    if (!nodeSet.has(v)) {
      nodeSet.add(v);
      nodeIds.push(v);
    }
  }
  return { nodeIds, edgePairs, posById };
}

function computePositionMapCenter(posById) {
  const ids = Object.keys(posById || {});
  let sx = 0;
  let sy = 0;
  let count = 0;
  for (const id of ids) {
    const p = posById[id];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    sx += p.x;
    sy += p.y;
    count += 1;
  }
  return count > 0 ? { x: sx / count, y: sy / count } : { x: 0, y: 0 };
}

test('GraphUtils.createGraph rejects duplicate and non-simple edges', () => {
  const nodeIds = ['1', '2', '3'];
  const edgePairs = [
    ['1', '2'],
    ['2', '1'],
    ['1', '2'],
    ['2', '2'],
    ['2', '3']
  ];

  assert.throws(() => GraphUtils.createGraph(nodeIds, edgePairs), /Graph edges must be unique|Graph edges must be simple and cannot contain self-loops/);
});

test('adjacency builders use canonical graph edges consistently', () => {
  const graph = GraphUtils.createGraph(
    ['1', '2', '3'],
    [['1', '2'], ['2', '3']]
  );
  const adjacencyArrays = graph.adjacency;
  assert.deepEqual(JSON.parse(JSON.stringify(adjacencyArrays)), {
    '1': ['2'],
    '2': ['1', '3'],
    '3': ['2']
  });

  const adjacencySets = graph.adjacencySets;
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

test('computeAspectRatioScore returns width-height ratio of the bounding box', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 0 },
    '3': { x: 2, y: 1 },
    '4': { x: 0, y: 1 }
  };
  const result = Metrics.computeAspectRatioScore(nodeIds, posById);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.width - 2) < 1e-12);
  assert.ok(Math.abs(result.height - 1) < 1e-12);
  assert.ok(Math.abs(result.score - 0.5) < 1e-12);
});

test('computeAspectRatioScore follows metrics.md on degenerate bounding boxes', () => {
  const nodeIds = ['1', '2', '3'];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 0, y: 1 },
    '3': { x: 0, y: 5 }
  };
  const result = Metrics.computeAspectRatioScore(nodeIds, posById);
  assert.equal(result.ok, true);
  assert.equal(result.score, 1);
});

test('computeNodeUniformityScore is 1 when nodes fill the grid evenly', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 0 },
    '3': { x: 0, y: 2 },
    '4': { x: 2, y: 2 }
  };
  const result = Metrics.computeNodeUniformityScore(nodeIds, posById);
  assert.equal(result.ok, true);
  assert.equal(result.rows, 2);
  assert.equal(result.cols, 2);
  assert.equal(result.score, 1);
});

test('computeNodeUniformityScore matches the metrics.md worst-case normalization', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 0, y: 0 },
    '3': { x: 0, y: 0 },
    '4': { x: 0, y: 0 }
  };
  const result = Metrics.computeNodeUniformityScore(nodeIds, posById);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.score - 0) < 1e-12);
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

  const emb = PlanarGraphUtils.extractEmbeddingFromPositions(nodeIds, edgePairs, posById);
  const result = Metrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById, emb);
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

  const emb = PlanarGraphUtils.extractEmbeddingFromPositions(nodeIds, edgePairs, posById);
  const result = Metrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById, emb);
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

test('computeUniformFaceAreaScore requires embedding', () => {
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

  const result = Metrics.computeUniformFaceAreaScore(nodeIds, edgePairs, posById, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Planar embedding required');
});

test('computeConvexityScore is 1 when every bounded face is convex', () => {
  const nodeIds = ['o1', 'o2', 'o3', 'a', 'b', 'c'];
  const posById = {
    o1: { x: -10, y: -10 },
    o2: { x: 10, y: -10 },
    o3: { x: 0, y: 10 },
    a: { x: 0, y: 0 },
    b: { x: 2, y: 0 },
    c: { x: 1, y: 2 }
  };
  const embedding = {
    ok: true,
    faces: [
      ['o1', 'o2', 'o3'],
      ['a', 'b', 'c']
    ],
    outerFace: ['o1', 'o2', 'o3']
  };
  const result = Metrics.computeConvexityScore(nodeIds, [], posById, embedding);
  assert.equal(result.ok, true);
  assert.equal(result.faceCount, 1);
  assert.equal(result.convexFaceCount, 1);
  assert.equal(result.score, 1);
});

test('computeConvexityScore detects a non-convex bounded face', () => {
  const nodeIds = ['o1', 'o2', 'o3', '1', '2', '3', '4'];
  const posById = {
    o1: { x: -10, y: -10 },
    o2: { x: 10, y: -10 },
    o3: { x: 0, y: 10 },
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 0 },
    '3': { x: 1, y: 0.5 },
    '4': { x: 0, y: 2 }
  };
  const embedding = {
    ok: true,
    faces: [
      ['o1', 'o2', 'o3'],
      ['1', '2', '3', '4']
    ],
    outerFace: ['o1', 'o2', 'o3']
  };
  const result = Metrics.computeConvexityScore(nodeIds, [], posById, embedding);
  assert.equal(result.ok, true);
  assert.equal(result.faceCount, 1);
  assert.equal(result.convexFaceCount, 0);
  assert.equal(result.score, 0);
});

test('computeConvexityScore requires embedding', () => {
  const result = Metrics.computeConvexityScore(['1', '2', '3'], [], {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 0, y: 1 }
  }, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Planar embedding required');
});

test('hasCrossingsFromPositions detects crossing and non-crossing drawings', () => {
  const crossingEdges = [['1', '2'], ['3', '4']];
  const crossingPos = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 1 },
    '3': { x: 0, y: 1 },
    '4': { x: 1, y: 0 }
  };
  assert.equal(GeometryUtils.hasPositionCrossings(crossingPos, crossingEdges), true);

  const nonCrossingEdges = [['1', '2'], ['2', '3']];
  const nonCrossingPos = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 2, y: 0 }
  };
  assert.equal(GeometryUtils.hasPositionCrossings(nonCrossingPos, nonCrossingEdges), false);
});

test('isBipartiteGraph works for even cycle and odd cycle', () => {
  const evenGraph = GraphUtils.createGraph(
    ['1', '2', '3', '4'],
    [['1', '2'], ['2', '3'], ['3', '4'], ['4', '1']]
  );
  assert.equal(Metrics.isBipartiteGraph(evenGraph), true);

  const oddGraph = GraphUtils.createGraph(
    ['1', '2', '3'],
    [['1', '2'], ['2', '3'], ['3', '1']]
  );
  assert.equal(Metrics.isBipartiteGraph(oddGraph), false);
});

test('computeAngularResolutionScore is better on symmetric K4 than skewed K4', () => {
  const graph = GraphUtils.createGraph(
    ['1', '2', '3', '4'],
    [
      ['1', '2'], ['2', '3'], ['3', '1'],
      ['1', '4'], ['2', '4'], ['3', '4']
    ]
  );
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

  const symmetric = Metrics.computeAngularResolutionScore(graph, posById);
  const skewed = Metrics.computeAngularResolutionScore(graph, skewedPosById);

  assert.equal(symmetric.ok, true);
  assert.equal(skewed.ok, true);
  assert.ok(symmetric.score >= 0 && symmetric.score <= 1);
  assert.ok(skewed.score >= 0 && skewed.score <= 1);
  assert.ok(symmetric.score > skewed.score + 0.01);
});

test('computeAngularResolutionScore is 1 when each eligible vertex reaches its ideal minimum angle', () => {
  const graph = GraphUtils.createGraph(
    ['c', 'a', 'b', 'd'],
    [['c', 'a'], ['c', 'b'], ['c', 'd']]
  );
  const sqrt3 = Math.sqrt(3);
  const posById = {
    c: { x: 0, y: 0 },
    a: { x: 1, y: 0 },
    b: { x: -0.5, y: sqrt3 / 2 },
    d: { x: -0.5, y: -sqrt3 / 2 }
  };
  const result = Metrics.computeAngularResolutionScore(graph, posById);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.score - 1) < 1e-12);
});

test('computeAngularResolutionScore decreases when the minimum incident angle shrinks', () => {
  const graph = GraphUtils.createGraph(
    ['c', 'a', 'b', 'd'],
    [['c', 'a'], ['c', 'b'], ['c', 'd']]
  );
  const posById = {
    c: { x: 0, y: 0 },
    a: { x: 1, y: 0 },
    b: { x: 0.99, y: 0.1 },
    d: { x: -1, y: 0 }
  };
  const result = Metrics.computeAngularResolutionScore(graph, posById);
  assert.equal(result.ok, true);
  assert.ok(result.score < 0.1);
});

test('computeAngularResolutionScore does not require extracting a plane embedding', () => {
  const graph = GraphUtils.createGraph(
    ['1', '2', '3', '4'],
    [
      ['1', '2'],
      ['2', '3'],
      ['3', '4'],
      ['4', '1']
    ]
  );
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 1 },
    '3': { x: 0, y: 1 },
    '4': { x: 1, y: 0 }
  };

  const result = Metrics.computeAngularResolutionScore(graph, posById);
  assert.equal(result.ok, true);
  assert.equal(result.usedNodeCount, 4);
  assert.equal(result.values.length, 4);
  assert.equal(result.reason, undefined);
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

test('computeSpacingUniformityScore accepts a single positive nearest-neighbor distance', () => {
  const nodeIds = ['1', '2'];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 3, y: 4 }
  };
  const result = Metrics.computeSpacingUniformityScore(nodeIds, posById);
  assert.equal(result.ok, true);
  assert.equal(result.usedNodeCount, 2);
  assert.equal(result.meanNN, 5);
  assert.equal(result.stdNN, 0);
  assert.equal(result.cv, 0);
  assert.equal(result.score, 1);
});

test('computeEdgeLengthDeviationScore is 1 for equal edge lengths', () => {
  const edgePairs = [['1', '2'], ['2', '3']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 2, y: 0 }
  };
  const result = Metrics.computeEdgeLengthDeviationScore(edgePairs, posById);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.score - 1) < 1e-12);
});

test('computeEdgeLengthDeviationScore matches the metrics.md formula', () => {
  const edgePairs = [['1', '2'], ['2', '3']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 3, y: 0 }
  };
  const result = Metrics.computeEdgeLengthDeviationScore(edgePairs, posById);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.meanLength - 1.5) < 1e-12);
  assert.ok(Math.abs(result.avgRelativeDeviation - (1 / 3)) < 1e-12);
  assert.ok(Math.abs(result.score - 0.75) < 1e-12);
});

test('computeEdgeOrthogonalityScore is 1 for horizontal and vertical edges', () => {
  const edgePairs = [['1', '2'], ['3', '4']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 0 },
    '3': { x: 0, y: 0 },
    '4': { x: 0, y: 3 }
  };
  const result = Metrics.computeEdgeOrthogonalityScore(edgePairs, posById);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.score - 1) < 1e-12);
});

test('computeEdgeOrthogonalityScore is 0 for a 45-degree edge', () => {
  const edgePairs = [['1', '2']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 1 }
  };
  const result = Metrics.computeEdgeOrthogonalityScore(edgePairs, posById);
  assert.equal(result.ok, true);
  assert.ok(Math.abs(result.score - 0) < 1e-12);
});

test('computeOptimalWeightedEdgeRotation prefers an equilateral triangle with one side horizontal', () => {
  const sqrt3 = Math.sqrt(3);
  const edgePairs = [['1', '2'], ['2', '3'], ['3', '1']];
  const flatPosById = {
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 0 },
    '3': { x: 1, y: sqrt3 }
  };
  const rotatedPosById = GeometryUtils.rotatePositionMap(flatPosById, { x: 1, y: sqrt3 / 3 }, Math.PI / 6);

  const result = Rotation.computeOptimalWeightedEdgeRotation(edgePairs, rotatedPosById);
  assert.equal(result.ok, true);
  assert.ok(result.improved);
  assert.ok(result.scoreAfter > result.scoreBefore + 1e-6 ||
    result.matchedCountAfter1 > result.matchedCountBefore1 ||
    result.matchedCountAfter3 > result.matchedCountBefore3 ||
    result.matchedCountAfter5 > result.matchedCountBefore5);
});

test('computeOptimalWeightedEdgeRotation returns no improvement when already optimal', () => {
  const edgePairs = [['1', '2'], ['2', '3']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 0 },
    '3': { x: 5, y: 0 }
  };
  const result = Rotation.computeOptimalWeightedEdgeRotation(edgePairs, posById);
  assert.equal(result.ok, true);
  assert.equal(result.improved, false);
  assert.ok(Math.abs(result.scoreAfter - result.scoreBefore) < 1e-12);
});

test('sample5 input coordinates stay put under the exact-horizontal bonus objective', () => {
  const parsed = parseSampleWithCoordinates(GraphGenerator.getSample('sample5'));
  const rotation = Rotation.computeOptimalWeightedEdgeRotation(parsed.edgePairs, parsed.posById);

  assert.equal(rotation.ok, true);
  assert.equal(rotation.improved, false);
  assert.equal(rotation.angle, 0);
  assert.equal(rotation.matchedCountBefore0, 6);
  assert.equal(rotation.matchedCountAfter0, 6);
  assert.equal(rotation.matchedCountBefore1, 7);
  assert.equal(rotation.matchedCountAfter1, 7);
  assert.equal(rotation.matchedCountBefore3, 7);
  assert.equal(rotation.matchedCountAfter3, 7);
  assert.equal(rotation.matchedCountBefore5, 7);
  assert.equal(rotation.matchedCountAfter5, 7);
  assert.ok(Math.abs(rotation.scoreAfter - rotation.scoreBefore) < 1e-12);
});

test('sample6 input coordinates rotate to make one long edge exactly horizontal under the exact-horizontal bonus objective', () => {
  const parsed = parseSampleWithCoordinates(GraphGenerator.getSample('sample6'));
  const rotation = Rotation.computeOptimalWeightedEdgeRotation(parsed.edgePairs, parsed.posById);

  assert.equal(rotation.ok, true);
  assert.equal(rotation.improved, true);
  assert.ok(Math.abs((rotation.angle * 180 / Math.PI) + 59.94) < 0.2);
  assert.equal(rotation.matchedCountBefore0, 0);
  assert.equal(rotation.matchedCountAfter0, 1);
  assert.equal(rotation.matchedCountBefore1, 1);
  assert.equal(rotation.matchedCountAfter1, 1);
  assert.equal(rotation.matchedCountBefore3, 1);
  assert.equal(rotation.matchedCountAfter3, 1);
  assert.equal(rotation.matchedCountBefore5, 2);
  assert.equal(rotation.matchedCountAfter5, 2);
  assert.ok(rotation.scoreAfter > rotation.scoreBefore);
});

test('hasCrossingsFromPositions rejects a vertex on a non-incident edge', () => {
  const edgePairs = [['1', '2']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 10, y: 0 },
    '3': { x: 5, y: 0 }
  };
  assert.equal(GeometryUtils.hasPositionCrossings(posById, edgePairs), true);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {
  createMockCy,
  loadBrowserModules,
  parseEdgeListText,
  positionsFromCy,
  seedPositions
} from '../scripts/report-shared.mjs';

function loadAlignmentModules() {
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
    'static/js/metrics.js',
    'static/js/rotation.js',
    'static/js/alignment.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    const script = new vm.Script(code, { filename: rel });
    script.runInContext(context);
  }

  return {
    GeometryUtils: window.GeometryUtils,
    GraphUtils: window.GraphUtils,
    Metrics: window.PlanarVibeMetrics,
    Alignment: window.PlanarVibeAlignment
  };
}

const loaded = loadAlignmentModules();
const GraphUtils = loaded.GraphUtils;
const GeometryUtils = loaded.GeometryUtils;
const Metrics = loaded.Metrics;
const Alignment = loaded.Alignment;

test('pointOnSegmentInterior rejects points that are only inside the segment bounding box', () => {
  const a = { x: 150, y: -300 };
  const b = { x: 0, y: -300 };
  const p = { x: -449.381, y: -0.193 };

  assert.equal(GeometryUtils.pointOnSegmentInterior(a, b, p, 1e-9), false);
});

test('alignToAxisGreedy preserves a jittered plane path when no safe group merge is available', () => {
  const nodeIds = ['1', '2', '3', '4', '5', '6'];
  const edgePairs = [['1', '2'], ['2', '3'], ['3', '4'], ['4', '5'], ['5', '6']];
  const posById = {
    '1': { x: 0.00, y: 0 },
    '2': { x: 0.02, y: 1 },
    '3': { x: 1.00, y: 2 },
    '4': { x: 1.03, y: 3 },
    '5': { x: 2.00, y: 4 },
    '6': { x: 2.01, y: 5 }
  };

  const before = Metrics.computeAxisAlignmentScore(nodeIds, posById, { tolerance: 0 });
  const result = Alignment.alignToAxisGreedy(nodeIds, edgePairs, posById);
  const after = Metrics.computeAxisAlignmentScore(nodeIds, result.positions, { tolerance: 0 });

  assert.equal(result.ok, true);
  assert.equal(GeometryUtils.hasPositionCrossings(result.positions, edgePairs), false);
  assert.ok(after.score >= before.score - 1e-12);
});

test('alignToAxisGreedy can improve both axes on a jittered rectangle', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const edgePairs = [['1', '2'], ['2', '4'], ['4', '3'], ['3', '1']];
  const posById = {
    '1': { x: 0.00, y: 0.00 },
    '2': { x: 0.02, y: 1.01 },
    '3': { x: 1.00, y: 0.03 },
    '4': { x: 1.02, y: 1.00 }
  };

  const before = Metrics.computeAxisAlignmentScore(nodeIds, posById);
  const result = Alignment.alignToAxisGreedy(nodeIds, edgePairs, posById);
  assert.equal(result.ok, true);
  assert.equal(GeometryUtils.hasPositionCrossings(result.positions, edgePairs), false);
  assert.ok(result.scoreAfter >= before.score - 1e-12 || result.changed === false);
});

test('alignToAxisGreedy rejects drawings that already have crossings', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const edgePairs = [['1', '2'], ['3', '4']];
  const posById = {
    '1': { x: 0, y: 0 },
    '2': { x: 2, y: 2 },
    '3': { x: 0, y: 2 },
    '4': { x: 2, y: 0 }
  };

  const result = Alignment.alignToAxisGreedy(nodeIds, edgePairs, posById);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'Drawing is not plane');
});

test('alignToAxisGreedy improves sample5 from its input coordinates', () => {
  const windowObj = loadBrowserModules();
  const sampleText = windowObj.PlanarVibeGraphGenerator.getSample('sample5');
  const parsed = windowObj.PlanarVibePlugin.parseEdgeList(sampleText);
  const nodeIds = parsed.elements
    .filter((el) => el && el.data && el.data.id && !(el.data.source && el.data.target))
    .map((el) => String(el.data.id));
  const edgePairs = parsed.elements
    .filter((el) => el && el.data && el.data.source && el.data.target)
    .map((el) => [String(el.data.source), String(el.data.target)]);

  const before = windowObj.PlanarVibeMetrics.computeAxisAlignmentScore(nodeIds, parsed.positionsById);
  const result = windowObj.PlanarVibeAlignment.alignToAxisGreedy(nodeIds, edgePairs, parsed.positionsById);
  const after = windowObj.PlanarVibeMetrics.computeAxisAlignmentScore(nodeIds, result.positions);

  assert.equal(parsed.hasExplicitPositions, true);
  assert.equal(windowObj.GeometryUtils.hasPositionCrossings(parsed.positionsById, edgePairs), false);
  assert.equal(result.ok, true);
  assert.equal(windowObj.GeometryUtils.hasPositionCrossings(result.positions, edgePairs), false);
  assert.ok(after.score > before.score, `expected sample5 alignment to improve score: ${before.score} -> ${after.score}`);
});

test('alignToAxisGreedy avoids placing sample5 node 6 onto edge (2,3) after UI normalization', () => {
  const windowObj = loadBrowserModules();
  const sampleText = windowObj.PlanarVibeGraphGenerator.getSample('sample5');
  const parsed = windowObj.PlanarVibePlugin.parseEdgeList(sampleText);
  const nodeIds = parsed.elements
    .filter((el) => el && el.data && el.data.id && !(el.data.source && el.data.target))
    .map((el) => String(el.data.id));
  const edgePairs = parsed.elements
    .filter((el) => el && el.data && el.data.source && el.data.target)
    .map((el) => [String(el.data.source), String(el.data.target)]);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const id of nodeIds) {
    const p = parsed.positionsById[id];
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  const pad = 24;
  const targetWidth = 900;
  const targetHeight = 620;
  const scale = Math.min(
    (targetWidth - 2 * pad) / Math.max(1e-9, maxX - minX),
    (targetHeight - 2 * pad) / Math.max(1e-9, maxY - minY)
  );
  const normalizedPos = {};
  for (const id of nodeIds) {
    const p = parsed.positionsById[id];
    normalizedPos[id] = {
      x: (p.x - minX) * scale + pad,
      y: (p.y - minY) * scale + pad
    };
  }

  const before = windowObj.PlanarVibeMetrics.computeAxisAlignmentScore(nodeIds, normalizedPos);
  const result = windowObj.PlanarVibeAlignment.alignToAxisGreedy(nodeIds, edgePairs, normalizedPos);
  const after = windowObj.PlanarVibeMetrics.computeAxisAlignmentScore(nodeIds, result.positions);
  const p2 = result.positions['2'];
  const p3 = result.positions['3'];
  const p6 = result.positions['6'];
  const area2 = (p3.x - p2.x) * (p6.y - p2.y) - (p3.y - p2.y) * (p6.x - p2.x);

  assert.equal(result.ok, true);
  assert.equal(windowObj.GeometryUtils.hasPositionCrossings(result.positions, edgePairs), false);
  assert.equal(windowObj.GeometryUtils.pointOnSegmentInterior(p2, p3, p6, 1e-9) && Math.abs(area2) <= 1e-9, false);
  assert.ok(after.score > before.score, `expected normalized sample5 alignment to improve score: ${before.score} -> ${after.score}`);
});

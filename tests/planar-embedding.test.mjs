import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

function parseEdgeListText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const nodes = new Set();
  const edges = [];
  const seen = new Set();
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' || parts[0] === 'V') {
      if (parts.length >= 2) nodes.add(parts[1]);
      continue;
    }
    if (parts.length < 2) throw new Error(`Invalid edge line: ${line}`);
    const a = parts[0];
    const b = parts[1];
    if (a === b) continue;
    nodes.add(a);
    nodes.add(b);
    const k = a < b ? `${a}::${b}` : `${b}::${a}`;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push([a, b]);
  }
  return { nodeIds: [...nodes], edgePairs: edges };
}

function parseVertexPositionsFromEdgeList(text) {
  const pos = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if ((parts[0] === 'v' || parts[0] === 'V') && parts.length >= 4) {
      const x = Number(parts[2]);
      const y = Number(parts[3]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        pos[String(parts[1])] = { x, y };
      }
    }
  }
  return pos;
}

function loadBrowserModules() {
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
    'static/js/planarvibe-plugin.js',
    'static/js/graph-generator.js',
    'static/js/planarity-test.js',
    'static/js/metrics.js',
    'static/js/linear-algebra.js',
    'static/js/geometry-utils.js',
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/playground-utils.js',
    'static/js/layout-tutte.js',
    'static/js/layout-tutte-adaptive.js',
    'static/js/layout-fpp.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    new vm.Script(code, { filename: rel }).runInContext(context);
  }

  return window;
}

function faceCanonicalKey(face) {
  const arr = (face || []).map(String);
  if (!arr.length) return '';
  let best = '';
  for (let i = 0; i < arr.length; i += 1) {
    const rot = arr.slice(i).concat(arr.slice(0, i));
    const rev = rot.slice().reverse();
    const a = rot.join(' ');
    const b = rev.join(' ');
    const cand = a < b ? a : b;
    if (!best || cand < best) best = cand;
  }
  return best;
}

const modules = loadBrowserModules();
const Generator = modules.PlanarVibeGraphGenerator;
const GraphUtils = modules.GraphUtils;
const PlanarGraphUtils = modules.PlanarGraphUtils;
const Planarity = modules.PlanarVibePlanarityTest;

test('PlanarEmbedding.fromDrawing captures the literal outer face of the drawing', () => {
  const text = Generator.getSample('sample5');
  const graph = parseEdgeListText(text);
  const pos = parseVertexPositionsFromEdgeList(text);
  const embedding = PlanarGraphUtils.PlanarEmbedding.fromDrawing(graph.nodeIds, graph.edgePairs, pos);

  assert.ok(embedding, 'expected drawing embedding');
  assert.ok(Array.isArray(embedding.outerFace) && embedding.outerFace.length > 3);
  assert.equal(embedding.hasFace(embedding.outerFace), true);

  const abstractEmbedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.notEqual(
    faceCanonicalKey(embedding.outerFace),
    faceCanonicalKey(GraphUtils.chooseOuterFaceFromEmbedding(abstractEmbedding))
  );
});

test('PlanarEmbedding.addFaceDummy preserves the chosen outer face when splitting an interior face', () => {
  const text = Generator.getSample('sample5');
  const graph = parseEdgeListText(text);
  const pos = parseVertexPositionsFromEdgeList(text);
  const embedding = PlanarGraphUtils.PlanarEmbedding.fromDrawing(graph.nodeIds, graph.edgePairs, pos);
  const outer = embedding.outerFace.slice();
  const interiorFace = embedding.faces.find((face) =>
    face.length > 3 && faceCanonicalKey(face) !== faceCanonicalKey(outer));

  assert.ok(interiorFace, 'expected a non-triangular interior face');
  embedding.addFaceDummy(interiorFace, '@testDummy');

  assert.equal(embedding.hasFace(outer), true, 'outer face should be preserved');
  assert.ok(embedding.faces.some((face) => face.includes('@testDummy')), 'new dummy should appear in faces');
});

test('PlanarEmbedding distinguishes the reversed inner face from the chosen outer face on a cycle', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const embeddingObject = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const embedding = PlanarGraphUtils.PlanarEmbedding.fromEmbeddingObject(
    graph.nodeIds,
    graph.edgePairs,
    embeddingObject,
    embeddingObject.outerFace
  );
  const outer = embedding.outerFace.slice();
  const reversed = outer.slice().reverse();

  assert.equal(PlanarGraphUtils.sameCyclicDirection(outer, reversed), false);

  const matched = embedding.getFace(reversed);
  assert.equal(PlanarGraphUtils.sameCyclicDirection(matched, reversed), true);
});

test('PlanarEmbedding.addFaceDummy can split the reversed inner face of a cycle without treating it as outer', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const embeddingObject = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const embedding = PlanarGraphUtils.PlanarEmbedding.fromEmbeddingObject(
    graph.nodeIds,
    graph.edgePairs,
    embeddingObject,
    embeddingObject.outerFace
  );
  const outer = embedding.outerFace.slice();
  const inner = outer.slice().reverse();

  embedding.addFaceDummy(inner, '@innerDummy');

  assert.equal(embedding.hasFace(outer), true, 'outer face should remain present');
  assert.ok(embedding.faces.some((face) => face.includes('@innerDummy')), 'new dummy should appear after splitting the inner face');
});

test('PlanarEmbedding.addFaceDummy can split the chosen outer face when a replacement outer face is supplied', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const embeddingObject = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const embedding = PlanarGraphUtils.PlanarEmbedding.fromEmbeddingObject(
    graph.nodeIds,
    graph.edgePairs,
    embeddingObject,
    embeddingObject.outerFace
  );
  const outer = embedding.outerFace.slice();

  embedding.addFaceDummy(outer, '@outerDummy', {
    newOuterFace: ['@outerDummy', outer[0], outer[1]]
  });

  assert.equal(faceCanonicalKey(embedding.outerFace || []), faceCanonicalKey(['@outerDummy', outer[0], outer[1]]));
});

test('PlanarEmbedding.addOuterFaceCycle handles an outer face with repeated vertices', () => {
  const graph = {
    nodeIds: ['a', 'b', 'c', 'd', 'e'],
    edgePairs: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['b', 'd'], ['d', 'e'], ['e', 'b']]
  };
  const pos = {
    a: { x: 0, y: 0 },
    b: { x: 1, y: 1 },
    c: { x: 0, y: 2 },
    d: { x: 3, y: 2 },
    e: { x: 3, y: 0 }
  };
  const embedding = PlanarGraphUtils.PlanarEmbedding.fromDrawing(graph.nodeIds, graph.edgePairs, pos);
  const outer = embedding.outerFace.slice();

  assert.equal(outer.filter((id) => id === 'b').length, 2, 'expected repeated articulation vertex on the outer face');

  const dummyIds = embedding.addOuterFaceCycle(outer);

  assert.equal(dummyIds.length, outer.length);
  assert.deepEqual(embedding.outerFace, dummyIds);
  for (const face of embedding.faces) {
    if (faceCanonicalKey(face) === faceCanonicalKey(dummyIds)) {
      continue;
    }
    assert.equal(face.length, 3, `expected triangulated non-outer face, got ${face.join(',')}`);
  }
});

test('triangulateByFaceStellation preserves the literal drawing outer face on sample5', () => {
  const text = Generator.getSample('sample5');
  const graph = parseEdgeListText(text);
  const pos = parseVertexPositionsFromEdgeList(text);
  const drawingEmbedding = GraphUtils.extractEmbeddingFromPositions(graph.nodeIds, graph.edgePairs, pos);
  const outer = drawingEmbedding.outerFace.slice();

  const augmented = GraphUtils.triangulateByFaceStellation(
    graph.nodeIds,
    graph.edgePairs,
    drawingEmbedding,
    outer
  );

  assert.equal(augmented.ok, true, augmented.reason || 'triangulation failed');
  assert.equal(GraphUtils.embeddingHasFace(augmented.embedding, outer), true, 'outer face should still be present after augmentation');
});

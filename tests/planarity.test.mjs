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
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      throw new Error(`Invalid edge line: ${line}`);
    }
    const a = parts[0];
    const b = parts[1];
    if (a === b) {
      continue;
    }
    nodes.add(a);
    nodes.add(b);
    const k = a < b ? `${a}::${b}` : `${b}::${a}`;
    if (seen.has(k)) {
      continue;
    }
    seen.add(k);
    edges.push([a, b]);
  }

  return { nodeIds: [...nodes], edgePairs: edges };
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
    'static/js/planar-graph-core.js',
    'static/js/fpp-layout.js'
  ];

  for (const rel of files) {
    const abs = path.resolve(process.cwd(), rel);
    const code = fs.readFileSync(abs, 'utf8');
    const script = new vm.Script(code, { filename: rel });
    script.runInContext(context);
  }

  return window;
}

const modules = loadBrowserModules();
const Generator = modules.PlanarVibeGraphGenerator;
const Planarity = modules.PlanarVibePlanarityTest;
const FPP = modules.PlanarVibeFPP;

function buildMockCy(nodeIds, edgePairs) {
  const nodeMap = new Map();
  const nodeObjs = nodeIds.map((id) => {
    const obj = {
      _id: String(id),
      _pos: null,
      id() {
        return this._id;
      },
      position(pos) {
        this._pos = { x: pos.x, y: pos.y };
      }
    };
    nodeMap.set(String(id), obj);
    return obj;
  });

  const edgeObjs = edgePairs.map(([u, v]) => ({
    source() {
      return { id: () => String(u) };
    },
    target() {
      return { id: () => String(v) };
    }
  }));

  return {
    _nodeObjs: nodeObjs,
    _edgeObjs: edgeObjs,
    _fitCalls: 0,
    nodes() {
      return this._nodeObjs;
    },
    edges() {
      return this._edgeObjs;
    },
    fit() {
      this._fitCalls += 1;
    }
  };
}

function orientation(a, b, c) {
  const val = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
  if (Math.abs(val) < 1e-9) {
    return 0;
  }
  return val > 0 ? 1 : 2;
}

function onSegment(a, b, c) {
  return (
    Math.min(a.x, c.x) - 1e-9 <= b.x &&
    b.x <= Math.max(a.x, c.x) + 1e-9 &&
    Math.min(a.y, c.y) - 1e-9 <= b.y &&
    b.y <= Math.max(a.y, c.y) + 1e-9
  );
}

function segmentsIntersect(p1, q1, p2, q2) {
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  if (o1 !== o2 && o3 !== o4) {
    return true;
  }
  if (o1 === 0 && onSegment(p1, p2, q1)) return true;
  if (o2 === 0 && onSegment(p1, q2, q1)) return true;
  if (o3 === 0 && onSegment(p2, p1, q2)) return true;
  if (o4 === 0 && onSegment(p2, q1, q2)) return true;
  return false;
}

function hasEdgeCrossing(nodeIds, edgePairs, positionsById) {
  function shareEndpoint(e1, e2) {
    return (
      e1[0] === e2[0] ||
      e1[0] === e2[1] ||
      e1[1] === e2[0] ||
      e1[1] === e2[1]
    );
  }

  for (let i = 0; i < edgePairs.length; i += 1) {
    for (let j = i + 1; j < edgePairs.length; j += 1) {
      const e1 = edgePairs[i];
      const e2 = edgePairs[j];
      if (shareEndpoint(e1, e2)) {
        continue;
      }

      const p1 = positionsById[e1[0]];
      const q1 = positionsById[e1[1]];
      const p2 = positionsById[e2[0]];
      const q2 = positionsById[e2[1]];
      if (!p1 || !q1 || !p2 || !q2) {
        return true;
      }

      if (segmentsIntersect(p1, q1, p2, q2)) {
        return true;
      }
    }
  }
  return false;
}

test('sample3 (K3,3) is non-planar', () => {
  const text = Generator.getSample('sample3');
  const graph = parseEdgeListText(text);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, false);
});

test('large non-planar generator stays non-planar', () => {
  const text = Generator.nonPlanarK33PlusPath(30);
  const graph = parseEdgeListText(text);
  assert.equal(graph.nodeIds.length, 30);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, false);
});

test('large planar stellation generator stays planar', () => {
  const text = Generator.planarStellationGraph(40, 9);
  const graph = parseEdgeListText(text);
  assert.equal(graph.nodeIds.length, 40);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, true);
});

test('10 random planar graphs (100 vertices) from stellation are planar', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.planarStellationGraph(100, 10, seed);
    const graph = parseEdgeListText(text);
    assert.equal(graph.nodeIds.length, 100);
    const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    assert.equal(emb.ok, true, `expected planar for seed=${seed}`);
  }
});

test('10 random non-planar graphs (100 vertices) from K3,3 core are non-planar', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.nonPlanarK33PlusPath(100, seed);
    const graph = parseEdgeListText(text);
    assert.equal(graph.nodeIds.length, 100);
    const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    assert.equal(emb.ok, false, `expected non-planar for seed=${seed}`);
  }
});

test('maximal planar 3-tree generator returns planar 3-tree', () => {
  const text = Generator.maximalPlanar3Tree(30);
  const graph = parseEdgeListText(text);

  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, true);
  assert.equal(emb.idByIndex.length, 30);

  const is3Tree = Planarity.isPlanar3Tree(graph.nodeIds, graph.edgePairs);
  assert.equal(is3Tree, true);

  const analysis = Planarity.analyzePlanar3Tree(graph.nodeIds, graph.edgePairs);
  assert.equal(analysis.ok, true);
  assert.equal(analysis.outerFace.length, 3);
  assert.equal(analysis.elimination.length, 27);
});

test('cycle graph is planar but not planar 3-tree', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  assert.equal(Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs).ok, true);
  assert.equal(Planarity.isPlanar3Tree(graph.nodeIds, graph.edgePairs), false);
});

test('wheel graph W7 is planar and not planar 3-tree', () => {
  const text = Generator.wheelGraph(7);
  const graph = parseEdgeListText(text);
  assert.equal(Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs).ok, true);
  assert.equal(Planarity.isPlanar3Tree(graph.nodeIds, graph.edgePairs), false);
});

test('planar augmentation triangulates non-triangular planar faces', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const prepared = FPP.prepareTriangulatedEmbedding(graph.nodeIds, graph.edgePairs);

  assert.equal(prepared.ok, true);
  assert.equal(prepared.augmentedDummyCount > 0, true);
  assert.equal(prepared.embedding.ok, true);

  const n = prepared.embedding.idByIndex.length;
  const m = prepared.embedding.edges.length;
  assert.equal(m, 3 * n - 6);
  for (const f of prepared.embedding.faces) {
    assert.equal(f.length, 3);
  }
});

test('canonical ordering works on 10 random planar 3-trees (100 vertices)', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.maximalPlanar3Tree(100 + seed);
    const graph = parseEdgeListText(text);
    const prepared = FPP.prepareTriangulatedEmbedding(graph.nodeIds, graph.edgePairs);
    assert.equal(prepared.ok, true, `prepare failed for seed=${seed}`);

    const canonical = FPP.computeCanonicalOrdering(prepared);
    assert.equal(canonical.ok, true, `canonical ordering failed for seed=${seed}`);
    assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
    assert.equal(new Set(canonical.order).size, canonical.order.length);
    assert.equal(canonical.outerFace.length, 3);
    assert.equal(canonical.order[0], canonical.outerFace[0]);
    assert.equal(canonical.order[1], canonical.outerFace[1]);
    assert.equal(canonical.order[2], canonical.outerFace[2]);
  }
});

test('FPP layout applies on 10 random planar 3-trees', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.maximalPlanar3Tree(60 + seed);
    const graph = parseEdgeListText(text);
    const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

    const result = FPP.applyFPPLayout(cy);
    assert.equal(result.ok, true, `applyFPPLayout failed for seed=${seed}: ${result.message}`);
    assert.equal(cy._fitCalls > 0, true);

    const positionsById = {};
    for (const node of cy.nodes()) {
      assert.equal(node._pos !== null, true, `missing position for node ${node.id()} seed=${seed}`);
      assert.equal(Number.isFinite(node._pos.x), true);
      assert.equal(Number.isFinite(node._pos.y), true);
      positionsById[node.id()] = node._pos;
    }

    const crossing = hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById);
    assert.equal(crossing, false, `FPP produced crossings for seed=${seed}`);
  }
});

test('FPP layout produces non-crossing drawings on 10 small planar 3-trees', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.maximalPlanar3Tree(12 + seed);
    const graph = parseEdgeListText(text);
    const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

    const result = FPP.applyFPPLayout(cy);
    assert.equal(result.ok, true, `applyFPPLayout failed for small seed=${seed}: ${result.message}`);
    assert.equal(cy._fitCalls > 0, true);

    const positionsById = {};
    for (const node of cy.nodes()) {
      assert.equal(node._pos !== null, true, `missing position for small node ${node.id()} seed=${seed}`);
      assert.equal(Number.isFinite(node._pos.x), true);
      assert.equal(Number.isFinite(node._pos.y), true);
      positionsById[node.id()] = node._pos;
    }

    const crossing = hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById);
    assert.equal(crossing, false, `FPP produced crossings for small seed=${seed}`);
  }
});

test('canonical ordering rejects random planar non-3-tree graph', () => {
  const text = Generator.planarStellationGraph(80, 10, 42);
  const graph = parseEdgeListText(text);
  const prepared = FPP.prepareTriangulatedEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(prepared.ok, true);

  const canonical = FPP.computeCanonicalOrdering(prepared);
  assert.equal(canonical.ok, false);
});

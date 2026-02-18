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
    'static/js/metrics.js',
    'static/js/planar-graph-core.js',
    'static/js/layout-tutte.js',
    'static/js/layout-reweight.js',
    'static/js/layout-fpp.js'
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
const Metrics = modules.PlanarVibeMetrics;
const FPP = modules.PlanarVibeFPP;
const Reweight = modules.PlanarVibeReweightTutte;

function buildMockCy(nodeIds, edgePairs) {
  const nodeMap = new Map();
  const nodeObjs = nodeIds.map((id) => {
    const obj = {
      _id: String(id),
      _pos: null,
      id() {
        return this._id;
      },
      data(key) {
        if (key === 'label') {
          return this._id;
        }
        return undefined;
      },
      position(pos) {
        if (pos === undefined) {
          if (this._pos === null) {
            return { x: 0, y: 0 };
          }
          return { x: this._pos.x, y: this._pos.y };
        }
        this._pos = { x: pos.x, y: pos.y };
      }
    };
    nodeMap.set(String(id), obj);
    return obj;
  });

  const edgeObjs = edgePairs.map(([u, v]) => ({
    _id: `${u}--${v}`,
    id() {
      return this._id;
    },
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
      const arr = this._nodeObjs;
      arr.toArray = function toArray() {
        return arr.slice();
      };
      return arr;
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

test('canonical ordering works on sample planar3tree10', () => {
  const text = Generator.getSample('planar3tree10');
  const graph = parseEdgeListText(text);
  const prepared = FPP.prepareTriangulatedEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(prepared.ok, true);

  const canonical = FPP.computeCanonicalOrdering(prepared);
  assert.equal(canonical.ok, true, canonical.reason || 'canonical ordering failed on planar3tree10');
  assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
  assert.equal(new Set(canonical.order).size, canonical.order.length);
});

test('canonical ordering works on 10 random small planar 3-trees', () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.maximalPlanar3Tree(10 + seed);
    const graph = parseEdgeListText(text);
    const prepared = FPP.prepareTriangulatedEmbedding(graph.nodeIds, graph.edgePairs);
    assert.equal(prepared.ok, true, `prepare failed for small seed=${seed}`);

    const canonical = FPP.computeCanonicalOrdering(prepared);
    assert.equal(canonical.ok, true, `canonical ordering failed for small seed=${seed}: ${canonical.reason || ''}`);
    assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
    assert.equal(new Set(canonical.order).size, canonical.order.length);
  }
});

test('canonical ordering works on small triangulated planar non-3-tree (octahedron)', () => {
  // Octahedron graph: maximal planar on 6 vertices, not a planar 3-tree.
  const text = [
    '1 2', '1 3', '1 4', '1 5',
    '6 2', '6 3', '6 4', '6 5',
    '2 3', '3 4', '4 5', '5 2'
  ].join('\n') + '\n';

  const graph = parseEdgeListText(text);
  assert.equal(Planarity.isPlanar3Tree(graph.nodeIds, graph.edgePairs), false);

  const prepared = FPP.prepareTriangulatedEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(prepared.ok, true);
  assert.equal(prepared.embedding.edges.length, 12);
  assert.equal(prepared.embedding.idByIndex.length, 6);

  const canonical = FPP.computeCanonicalOrdering(prepared);
  assert.equal(canonical.ok, true, canonical.reason || 'canonical ordering failed on octahedron');
  assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
  assert.equal(new Set(canonical.order).size, canonical.order.length);
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

test('FPP layout produces non-crossing drawing on sample planar3tree10', () => {
  const text = Generator.getSample('planar3tree10');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = FPP.applyFPPLayout(cy);
  assert.equal(result.ok, true, `applyFPPLayout failed on planar3tree10: ${result.message}`);
  assert.equal(cy._fitCalls > 0, true);

  const positionsById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing position for node ${node.id()} in planar3tree10`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
    positionsById[node.id()] = node._pos;
  }

  const crossing = hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById);
  assert.equal(crossing, false, 'FPP produced crossings for planar3tree10');
});

test('FPP layout produces non-crossing drawings on 5 large planar 3-trees', () => {
  for (let seed = 1; seed <= 5; seed += 1) {
    const text = Generator.maximalPlanar3Tree(250 + seed);
    const graph = parseEdgeListText(text);
    const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

    const result = FPP.applyFPPLayout(cy);
    assert.equal(result.ok, true, `applyFPPLayout failed for large seed=${seed}: ${result.message}`);
    assert.equal(cy._fitCalls > 0, true);

    const positionsById = {};
    for (const node of cy.nodes()) {
      assert.equal(node._pos !== null, true, `missing position for large node ${node.id()} seed=${seed}`);
      assert.equal(Number.isFinite(node._pos.x), true);
      assert.equal(Number.isFinite(node._pos.y), true);
      positionsById[node.id()] = node._pos;
    }

    const crossing = hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById);
    assert.equal(crossing, false, `FPP produced crossings for large seed=${seed}`);
  }
});

test('FPP layout applies on 5 random planar non-3-tree graphs', () => {
  for (let seed = 1; seed <= 5; seed += 1) {
    const text = Generator.planarStellationGraph(80 + seed, 10, seed);
    const graph = parseEdgeListText(text);
    const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

    const result = FPP.applyFPPLayout(cy);
    assert.equal(result.ok, true, `applyFPPLayout failed for planar non-3-tree seed=${seed}: ${result.message}`);
    assert.equal(cy._fitCalls > 0, true);

    const positionsById = {};
    for (const node of cy.nodes()) {
      assert.equal(node._pos !== null, true, `missing position for non-3-tree node ${node.id()} seed=${seed}`);
      assert.equal(Number.isFinite(node._pos.x), true);
      assert.equal(Number.isFinite(node._pos.y), true);
      positionsById[node.id()] = node._pos;
    }

    const crossing = hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById);
    assert.equal(crossing, false, `FPP produced crossings for planar non-3-tree seed=${seed}`);
  }
});

test('canonical ordering works on random planar non-3-tree graph', () => {
  const text = Generator.planarStellationGraph(80, 10, 42);
  const graph = parseEdgeListText(text);
  const prepared = FPP.prepareTriangulatedEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(prepared.ok, true);

  const canonical = FPP.computeCanonicalOrdering(prepared);
  assert.equal(canonical.ok, true, canonical.reason || 'canonical ordering failed on random non-3-tree');
  assert.equal(canonical.order.length, prepared.embedding.idByIndex.length);
  assert.equal(new Set(canonical.order).size, canonical.order.length);
});

test('ReweightTutte keeps outer-face coordinates fixed across iterations', async () => {
  const text = Generator.planarStellationGraph(40, 8, 7);
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  // Seed an initial position set so Reweight has a viewport-relative frame.
  for (let i = 0; i < graph.nodeIds.length; i += 1) {
    const id = graph.nodeIds[i];
    const node = cy.nodes().find((n) => n.id() === id);
    node.position({ x: (i % 10) * 40, y: Math.floor(i / 10) * 40 });
  }

  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb && emb.ok, true);
  let outer = emb.faces[0];
  for (let i = 1; i < emb.faces.length; i += 1) {
    if (emb.faces[i].length > outer.length) {
      outer = emb.faces[i];
    }
  }
  outer = outer.map(String);

  const snapshots = [];
  const result = await Reweight.applyReweightTutteLayout(cy, {
    onIteration(step) {
      const snap = {};
      for (const v of outer) {
        const p = step.positions[v];
        snap[v] = { x: p.x, y: p.y };
      }
      snapshots.push(snap);
    }
  });

  assert.equal(result.ok, true, result.message || 'Reweight failed');
  assert.ok(snapshots.length >= 2, 'expected multiple iterations');

  const first = snapshots[0];
  for (let i = 1; i < snapshots.length; i += 1) {
    for (const v of outer) {
      const a = first[v];
      const b = snapshots[i][v];
      assert.ok(Math.abs(a.x - b.x) < 1e-9, `outer x moved for vertex ${v}`);
      assert.ok(Math.abs(a.y - b.y) < 1e-9, `outer y moved for vertex ${v}`);
    }
  }
});

test('ReweightTutte on sample1 computes Face Areas Score', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  for (let i = 0; i < graph.nodeIds.length; i += 1) {
    const id = graph.nodeIds[i];
    const node = cy.nodes().find((n) => n.id() === id);
    node.position({ x: (i % 10) * 40, y: Math.floor(i / 10) * 40 });
  }

  const result = await Reweight.applyReweightTutteLayout(cy);
  assert.equal(result.ok, true, result.message || 'ReweightTutte failed');
  assert.equal(cy._fitCalls > 0, true);

  const face = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
  assert.equal(face.ok, true, face.reason || 'Face area score failed');
  assert.ok(Number.isFinite(face.quality), 'Face area quality is not finite');
  assert.ok(face.quality >= 0 && face.quality <= 1, `Face area quality out of [0,1]: ${face.quality}`);
});

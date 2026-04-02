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
    if (parts[0] === 'v' || parts[0] === 'V') {
      if (parts.length >= 2) {
        nodes.add(parts[1]);
      }
      continue;
    }
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

function parseVertexPositionsFromEdgeList(text) {
  const lines = String(text || '').split(/\r?\n/);
  const pos = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const parts = line.split(/\s+/);
    if ((parts[0] === 'v' || parts[0] === 'V') && parts.length >= 4) {
      const id = String(parts[1]);
      const x = Number(parts[2]);
      const y = Number(parts[3]);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        pos[id] = { x, y };
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
    'static/js/planar-graph-utils.js',
    'static/js/graph-utils.js',
    'static/js/playground-utils.js',
    'static/js/layout-tutte.js',
    'static/js/layout-air.js',
    'static/js/layout-ppag.js',
    'static/js/layout-facebalancer.js',
    'static/js/layout-ceg23.js',
    'static/js/layout-impred.js',
    'static/js/layout-reweight.js',
    'static/js/layout-fd-uniform.js',
    'static/js/layout-p3t.js',
    'static/js/layout-fpp.js',
    'static/js/layout-schnyder.js'
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
const GraphUtils = modules.GraphUtils;
const Metrics = modules.PlanarVibeMetrics;
const Tutte = modules.PlanarVibeTutte;
const Air = modules.PlanarVibeAir;
const PPAG = modules.PlanarVibePPAG;
const FaceBalancer = modules.PlanarVibeFaceBalancer;
const CEG23 = modules.PlanarVibeCEG23Bfs;
const CEG23XY = modules.PlanarVibeCEG23Xy;
const ImPrEd = modules.PlanarVibeImPrEd;
const FPP = modules.PlanarVibeFPP;
const Schnyder = modules.PlanarVibeSchnyder;
const P3T = modules.PlanarVibeP3T;
const Reweight = modules.PlanarVibeReweightTutte;
const FDUniform = modules.PlanarVibeFDUniform;
const PlaygroundUtils = modules.PlaygroundUtils;

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

function faceCanonicalKeyForTest(face) {
  if (!face || face.length === 0) {
    return '';
  }
  const arr = face.map(String);
  const n = arr.length;
  let best = null;
  for (let i = 0; i < n; i += 1) {
    const rot = arr.slice(i).concat(arr.slice(0, i)).join('|');
    if (best === null || rot < best) {
      best = rot;
    }
  }
  const rev = arr.slice().reverse();
  for (let i = 0; i < n; i += 1) {
    const rot = rev.slice(i).concat(rev.slice(0, i)).join('|');
    if (best === null || rot < best) {
      best = rot;
    }
  }
  return best || '';
}

function polygonAreaAbs(face, positionsById) {
  let sum = 0;
  for (let i = 0; i < face.length; i += 1) {
    const a = positionsById[String(face[i])];
    const b = positionsById[String(face[(i + 1) % face.length])];
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) / 2;
}

function minBoundedFaceArea(graph, positionsById) {
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  if (!embedding || !embedding.ok) {
    return null;
  }
  const outerKey = faceCanonicalKeyForTest(GraphUtils.chooseOuterFaceFromEmbedding(embedding) || []);
  let minArea = Infinity;
  for (const face of embedding.faces || []) {
    if (faceCanonicalKeyForTest(face) === outerKey) {
      continue;
    }
    const area = polygonAreaAbs(face, positionsById);
    if (area < minArea) {
      minArea = area;
    }
  }
  return Number.isFinite(minArea) ? minArea : null;
}

function edgeLengthRatio(edgePairs, positionsById) {
  let minLen = Infinity;
  let maxLen = 0;
  for (const [u, v] of edgePairs) {
    const pu = positionsById[String(u)];
    const pv = positionsById[String(v)];
    const dx = pu.x - pv.x;
    const dy = pu.y - pv.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < minLen) {
      minLen = len;
    }
    if (len > maxLen) {
      maxLen = len;
    }
  }
  if (!(minLen >= 0) || !(maxLen > 0)) {
    return null;
  }
  return minLen / maxLen;
}

function seedGridPositions(cy, nodeIds) {
  for (let i = 0; i < nodeIds.length; i += 1) {
    const id = nodeIds[i];
    const node = cy.nodes().find((n) => n.id() === id);
    node.position({ x: (i % 10) * 40, y: Math.floor(i / 10) * 40 });
  }
}

function assertNoVertexOverlaps(cy, messagePrefix = 'vertex overlap') {
  const seen = new Set();
  for (const node of cy.nodes()) {
    const p = node._pos;
    assert.equal(!!p, true, `${messagePrefix}: missing position for node ${node.id()}`);
    const key = `${p.x},${p.y}`;
    assert.equal(seen.has(key), false, `${messagePrefix}: node ${node.id()} overlaps at ${key}`);
    seen.add(key);
  }
}

test('nonplanar1 (K3,3) is non-planar', () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb.ok, false);
});

test('edge-list parser accepts explicit vertex coordinates via "v id x y"', () => {
  const parsed = modules.PlanarVibePlugin.parseEdgeList(
    [
      'v a 10 20',
      'v b -5.5 7.25',
      'a b'
    ].join('\n')
  );
  assert.equal(parsed.nodeCount, 2);
  assert.equal(parsed.edgeCount, 1);
  assert.equal(parsed.hasExplicitPositions, true);
  assert.equal(parsed.positionsById.a.x, 10);
  assert.equal(parsed.positionsById.a.y, 20);
  assert.equal(parsed.positionsById.b.x, -5.5);
  assert.equal(parsed.positionsById.b.y, 7.25);
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

test('random planar sample set has requested sizes and is planar', () => {
  const expected = [
    { key: 'randomplanar1', n: 30, m: 80 },
    { key: 'randomplanar2', n: 50, m: 130 },
    { key: 'randomplanar3', n: 50, m: 144 },
    { key: 'randomplanar4', n: 60, m: 150 },
    { key: 'randomplanar5', n: 70, m: 200 }
  ];
  for (const item of expected) {
    const text = Generator.getSample(item.key);
    const graph = parseEdgeListText(text);
    assert.equal(graph.nodeIds.length, item.n, `${item.key} vertex count mismatch`);
    assert.equal(graph.edgePairs.length, item.m, `${item.key} edge count mismatch`);
    const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
    assert.equal(emb.ok, true, `${item.key} expected planar`);
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

test('face stellation adds one dummy vertex for every non-triangular face including the outer face', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);

  assert.equal(embedding.ok, true);

  const augmented = GraphUtils.augmentByFaceStellation(graph.nodeIds, graph.edgePairs, embedding);
  const dummyIds = Object.keys(augmented.dummyFaceVerticesById || {});

  assert.equal(augmented.dummyCount, 2);
  assert.equal(dummyIds.length, 2);
  for (const dummyId of dummyIds) {
    const face = augmented.dummyFaceVerticesById[dummyId];
    assert.equal(face.length, 8);
    for (const v of face) {
      assert.equal(
        augmented.edgePairs.some(([a, b]) =>
          (String(a) === String(dummyId) && String(b) === String(v)) ||
          (String(a) === String(v) && String(b) === String(dummyId))
        ),
        true,
        `missing stellation edge ${dummyId}-${v}`
      );
    }
  }
});

test('triangulated augmentation removes degree-3 dummy vertices from the final graph', () => {
  const text = Generator.getSample('sample5');
  const graph = parseEdgeListText(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const outerFace = GraphUtils.chooseOuterFaceFromEmbedding(embedding);
  const prepared = GraphUtils.triangulateByFaceStellation(
    graph.nodeIds,
    graph.edgePairs,
    embedding,
    outerFace
  );

  assert.equal(prepared.ok, true);

  const degreeById = {};
  for (const id of prepared.nodeIds) {
    degreeById[String(id)] = 0;
  }
  for (const [a, b] of prepared.edgePairs) {
    degreeById[String(a)] += 1;
    degreeById[String(b)] += 1;
  }

  const dummyIds = Object.keys(prepared.dummyFaceVerticesById || {});
  const degreeThreeDummies = dummyIds.filter((dummyId) => degreeById[String(dummyId)] === 3);

  assert.equal(degreeThreeDummies.length, 0);
});

test('triangulateByFaceStellation triangulates a cycle when the outer face must also be triangulated', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const outerFace = embedding.outerFace.slice();

  const prepared = GraphUtils.triangulateByFaceStellation(
    graph.nodeIds,
    graph.edgePairs,
    embedding,
    outerFace,
    { triangulateOuterFace: true }
  );

  assert.equal(prepared.ok, true, prepared.reason || 'triangulation failed');
  for (const face of prepared.embedding.faces) {
    assert.equal(face.length, 3);
  }
});

test('common outer-face helper prefers a chordless explicit outer face and otherwise falls back to the longest chordless face', () => {
  const explicit = GraphUtils.chooseOuterFaceFromEmbedding({
    outerFace: ['a', 'b', 'c'],
    edges: [['a', 'b'], ['b', 'c'], ['c', 'a'], ['x', 'y'], ['y', 'z'], ['z', 'w'], ['w', 'x']],
    faces: [['x', 'y', 'z', 'w']]
  });
  assert.deepEqual(explicit, ['a', 'b', 'c']);

  const fallback = GraphUtils.chooseOuterFaceFromEmbedding({
    edges: [
      ['1', '2'], ['2', '3'], ['3', '1'],
      ['4', '5'], ['5', '6'], ['6', '7'], ['7', '4'], ['4', '6'],
      ['8', '9'], ['9', '10'], ['10', '11'], ['11', '12'], ['12', '8']
    ],
    faces: [['1', '2', '3'], ['4', '5', '6', '7'], ['8', '9', '10', '11', '12']]
  });
  assert.deepEqual(fallback, ['8', '9', '10', '11', '12']);
});

test('common outer-face helper ignores an explicit outer face when it contains a chord', () => {
  const chosen = GraphUtils.chooseOuterFaceFromEmbedding({
    outerFace: ['1', '2', '3', '4'],
    edges: [
      ['1', '2'], ['2', '3'], ['3', '4'], ['4', '1'], ['1', '3'],
      ['5', '6'], ['6', '7'], ['7', '8'], ['8', '9'], ['9', '5']
    ],
    faces: [['1', '2', '3', '4'], ['5', '6', '7', '8', '9']]
  });
  assert.deepEqual(chosen, ['5', '6', '7', '8', '9']);
});

test('outer-face helper recovers the visible outer face from a plane drawing', () => {
  const text = Generator.getSample('sample5');
  const graph = parseEdgeListText(text);
  const pos = parseVertexPositionsFromEdgeList(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const fromEmbedding = GraphUtils.chooseOuterFaceFromEmbedding(embedding);
  const outer = GraphUtils.chooseOuterFaceFromPositions(graph.nodeIds, graph.edgePairs, pos);
  assert.ok(Array.isArray(outer) && outer.length >= 3, 'expected a geometric outer face');
  assert.notEqual(faceCanonicalKeyForTest(outer || []), faceCanonicalKeyForTest(fromEmbedding || []));
});

test('shared initializer prefers the current plane drawing when choosing the outer face', () => {
  const text = Generator.getSample('sample5');
  const graph = parseEdgeListText(text);
  const pos = parseVertexPositionsFromEdgeList(text);
  const outer = GraphUtils.chooseOuterFaceFromPositions(graph.nodeIds, graph.edgePairs, pos);
  const prepared = PlaygroundUtils.prepareGraphAndLayoutData(graph, {
    failureLabel: 'test',
    currentPositions: pos
  });
  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'shared initializer failed');
  assert.equal(
    faceCanonicalKeyForTest(prepared.outerFace || []),
    faceCanonicalKeyForTest(outer || [])
  );
});

test('shared embedding-position verifier rejects degenerate faces', () => {
  const embedding = {
    ok: true,
    idByIndex: ['1', '2', '3'],
    edges: [['1', '2'], ['2', '3'], ['3', '1']],
    faces: [['1', '2', '3']],
    outerFace: ['1', '2', '3']
  };
  const pos = {
    '1': { x: 0, y: 0 },
    '2': { x: 1, y: 0 },
    '3': { x: 2, y: 0 }
  };

  const verify = PlaygroundUtils.verifyEmbeddingWithPositions(embedding, pos);
  assert.equal(verify.ok, false);
  assert.match(String(verify.message || ''), /degenerate/i);
});

test('shared initializer rejects grid2x20 when the chosen embedding outer face yields a degenerate seed', () => {
  const text = Generator.getSample('grid2x20');
  const graph = parseEdgeListText(text);
  const prepared = PlaygroundUtils.prepareGraphAndLayoutData(graph, {
    failureLabel: 'Shared seed test'
  });

  assert.equal(prepared && prepared.ok, false);
  assert.match(String(prepared && prepared.message || ''), /verification|crossings|degenerate/i);
});

test('raw shared barycentric seed on grid2x20 returns coordinates that fail embedding verification', () => {
  const text = Generator.getSample('grid2x20');
  const graph = parseEdgeListText(text);
  const prepared = PlaygroundUtils.prepareGraphData(graph, {
    failureLabel: 'Shared seed test'
  });

  assert.equal(prepared && prepared.ok, true, prepared && prepared.message ? prepared.message : 'prepareGraphData failed');

  const seed = PlaygroundUtils.computeSharedBarycentricSeed(
    prepared.augmented.nodeIds,
    prepared.augmented.edgePairs,
    prepared.outerFace,
    {
      graph: prepared.graph,
      baseEmbedding: prepared.baseEmbedding,
      augmented: prepared.augmented,
      outerFace: prepared.outerFace
    }
  );

  assert.equal(seed && seed.ok, true, seed && seed.message ? seed.message : 'shared seed failed');
  assert.ok(seed && seed.pos, 'expected raw seed coordinates');

  const verify = PlaygroundUtils.verifyEmbeddingWithPositions(prepared.augmented.embedding, seed.pos, {
    edgePairs: prepared.augmented.edgePairs,
    outerFace: prepared.outerFace
  });

  assert.equal(verify.ok, false);
  assert.match(String(verify.message || ''), /crossings|degenerate/i);
});

test('shared movement convergence helper stops after enough stable iterations', () => {
  const prev = {
    a: { x: 0, y: 0 },
    b: { x: 10, y: 0 }
  };
  const next = {
    a: { x: 0.001, y: 0 },
    b: { x: 10.001, y: 0 }
  };
  const stats = GraphUtils.computePositionMoveStats(['a', 'b'], prev, next, { moveTol: 1e-4 });
  assert.ok(stats.maxMove > 0, 'expected non-zero movement');
  assert.equal(stats.movedVertices, 2);

  const tracker = GraphUtils.createMovementConvergenceTracker({
    minItersBeforeStop: 3,
    stableIterLimit: 2,
    maxMoveTol: 0.01,
    avgMoveTol: 0.01
  });
  const s1 = tracker.update({ maxMove: stats.maxMove, avgMove: stats.avgMove }, 1);
  const s2 = tracker.update({ maxMove: stats.maxMove, avgMove: stats.avgMove }, 2);
  const s3 = tracker.update({ maxMove: stats.maxMove, avgMove: stats.avgMove }, 3);
  assert.equal(s1.converged, false);
  assert.equal(s2.converged, false);
  assert.equal(s3.converged, true);
  assert.equal(s3.reason, 'movement-converged');
});

test('shared outer-face positioning ignores seed positions when useSeedOuter is false', () => {
  const nodeIds = ['1', '2', '3', '4'];
  const outerFace = ['1', '2', '3', '4'];
  const baseline = modules.PlanarVibeTutteAlgorithm.placeOuterFaceVertices(nodeIds, outerFace, {
    useSeedOuter: false,
    defaultCenterX: 2000,
    defaultCenterY: 2000,
    defaultRadius: 1000
  });
  const withSeed = modules.PlanarVibeTutteAlgorithm.placeOuterFaceVertices(nodeIds, outerFace, {
    useSeedOuter: false,
    seedPos: {
      '1': { x: 0, y: 0 },
      '2': { x: 10, y: 0 },
      '3': { x: 10, y: 10 },
      '4': { x: 0, y: 10 }
    },
    defaultCenterX: 2000,
    defaultCenterY: 2000,
    defaultRadius: 1000
  });
  assert.deepEqual(withSeed, baseline);
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

test('Schnyder layout applies on planar sample and assigns finite positions', () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = Schnyder.applySchnyderLayout(cy);
  assert.equal(result.ok, true, result.message || 'Schnyder failed');
  assert.equal(cy._fitCalls > 0, true);

  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing Schnyder position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
  }
});

test('Schnyder layout applies on a non-triangulated cycle graph', () => {
  const text = Generator.cycleGraph(8);
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = Schnyder.applySchnyderLayout(cy);
  assert.equal(result.ok, true, result.message || 'Schnyder failed on cycle graph');

  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing Schnyder position for cycle node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
  }
});

test('Schnyder layout rejects non-planar graphs', () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = Schnyder.applySchnyderLayout(cy);
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /not planar|planar graph/i);
});

test('Schnyder layout produces non-crossing drawing on randomplanar3', () => {
  const text = Generator.getSample('randomplanar3');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = Schnyder.applySchnyderLayout(cy);
  assert.equal(result.ok, true, result.message || 'Schnyder failed on randomplanar3');
  const posById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing Schnyder position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
    posById[String(node.id())] = { x: node._pos.x, y: node._pos.y };
  }
  assertNoVertexOverlaps(cy, 'Schnyder randomplanar3');
  assert.equal(GraphUtils.hasPositionCrossings(posById, graph.edgePairs), false);
});

test('Schnyder layout produces non-crossing drawing on randomplanar2 (G(50, 130))', () => {
  const text = Generator.getSample('randomplanar2');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = Schnyder.applySchnyderLayout(cy);
  assert.equal(result.ok, true, result.message || 'Schnyder failed on randomplanar2');
  const posById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing Schnyder position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
    posById[String(node.id())] = { x: node._pos.x, y: node._pos.y };
  }
  assertNoVertexOverlaps(cy, 'Schnyder randomplanar2');
  assert.equal(GraphUtils.hasPositionCrossings(posById, graph.edgePairs), false);
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

test('FPP layout regression: randomplanar4 should not fail during augmentation', () => {
  const text = Generator.getSample('randomplanar4');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = FPP.applyFPPLayout(cy);
  assert.equal(result.ok, true, `applyFPPLayout failed on randomplanar4: ${result.message}`);

  const posById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing FPP position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
    posById[String(node.id())] = { x: node._pos.x, y: node._pos.y };
  }
  assert.equal(GraphUtils.hasPositionCrossings(posById, graph.edgePairs), false, 'FPP produced crossings for randomplanar4');
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

test('ReweightTutte uses the same outer-face coordinates as Tutte', async () => {
  const text = Generator.planarStellationGraph(40, 8, 7);
  const graph = parseEdgeListText(text);
  const emb = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  assert.equal(emb && emb.ok, true);
  const outer = GraphUtils.chooseOuterFaceFromEmbedding(emb);

  const cyTutte = buildMockCy(graph.nodeIds, graph.edgePairs);
  const tutte = Tutte.applyTutteLayout(cyTutte);
  assert.equal(tutte.ok, true, tutte.message || 'Tutte failed');

  const cyReweight = buildMockCy(graph.nodeIds, graph.edgePairs);
  for (let i = 0; i < graph.nodeIds.length; i += 1) {
    const id = graph.nodeIds[i];
    const node = cyReweight.nodes().find((n) => n.id() === id);
    node.position({ x: (i % 10) * 40, y: Math.floor(i / 10) * 40 });
  }
  const reweight = await Reweight.applyReweightTutteLayout(cyReweight, { delayMs: 0 });
  assert.equal(reweight.ok, true, reweight.message || 'Reweight failed');

  for (const v of outer) {
    const pT = cyTutte.nodes().find((n) => n.id() === String(v))._pos;
    const pR = cyReweight.nodes().find((n) => n.id() === String(v))._pos;
    assert.ok(Math.abs(pT.x - pR.x) < 1e-9, `outer x mismatch for vertex ${v}`);
    assert.ok(Math.abs(pT.y - pR.y) < 1e-9, `outer y mismatch for vertex ${v}`);
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

test('Tutte layout applies on planar sample and assigns finite positions', () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = Tutte.applyTutteLayout(cy);
  assert.equal(result.ok, true, result.message || 'Tutte failed');
  assert.equal(cy._fitCalls > 0, true);

  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing Tutte position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
  }
});

test('Air layout applies on planar sample and improves bounded face balance', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const baseline = Tutte.applyTutteLayout(cy);
  assert.equal(baseline.ok, true, baseline.message || 'Tutte baseline failed');
  const before = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
  assert.equal(before.ok, true, before.reason || 'Baseline face score failed');

  const result = await Air.applyAirLayout(cy, { delayMs: 0, yieldEvery: 50 });
  assert.equal(result.ok, true, result.message || 'Air failed');
  assert.equal(cy._fitCalls > 0, true);

  const after = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
  assert.equal(after.ok, true, after.reason || 'Air face score failed');
  assert.ok(Number.isFinite(after.quality), 'Air face quality is not finite');
  assert.ok(after.quality + 1e-6 >= before.quality, `Air worsened face balance: before=${before.quality}, after=${after.quality}`);

  const positionsById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing Air position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
    positionsById[node.id()] = node._pos;
  }
  assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById), false, 'Air introduced crossings on sample1');
});

test('Air layout rejects non-planar graphs', async () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await Air.applyAirLayout(cy, { delayMs: 0 });
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /planar graph/i);
});

test('Air layout stays plane on 5 random planar graphs', async () => {
  for (let seed = 1; seed <= 5; seed += 1) {
    const text = Generator.randomPlanarGraphNM(25 + seed, 3 * (25 + seed) - 10, seed);
    const graph = parseEdgeListText(text);
    const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

    const result = await Air.applyAirLayout(cy, { delayMs: 0, yieldEvery: 50 });
    assert.equal(result.ok, true, `Air failed for seed=${seed}: ${result.message || ''}`);

    const positionsById = {};
    for (const node of cy.nodes()) {
      assert.equal(node._pos !== null, true, `missing Air position for node ${node.id()} seed=${seed}`);
      positionsById[node.id()] = node._pos;
    }
    assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById), false, `Air produced crossings for seed=${seed}`);
  }
});

test('PPAG layout applies on planar sample and improves bounded face balance', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const baseline = Tutte.applyTutteLayout(cy);
  assert.equal(baseline.ok, true, baseline.message || 'Tutte baseline failed');
  const before = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
  assert.equal(before.ok, true, before.reason || 'Baseline face score failed');

  const result = await PPAG.applyPPAGLayout(cy, { delayMs: 0, yieldEvery: 50 });
  assert.equal(result.ok, true, result.message || 'PPAG failed');
  assert.equal(cy._fitCalls > 0, true);

  const after = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
  assert.equal(after.ok, true, after.reason || 'PPAG face score failed');
  assert.ok(Number.isFinite(after.quality), 'PPAG face quality is not finite');
  assert.ok(after.quality + 1e-6 >= before.quality, `PPAG worsened face balance: before=${before.quality}, after=${after.quality}`);

  const positionsById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing PPAG position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
    positionsById[node.id()] = node._pos;
  }
  assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById), false, 'PPAG introduced crossings on sample1');
});

test('PPAG layout rejects non-planar graphs', async () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await PPAG.applyPPAGLayout(cy, { delayMs: 0 });
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /planar graph/i);
});

test('PPAG layout stays plane on 5 random planar graphs', async () => {
  for (let seed = 1; seed <= 5; seed += 1) {
    const text = Generator.randomPlanarGraphNM(25 + seed, 3 * (25 + seed) - 10, seed);
    const graph = parseEdgeListText(text);
    const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

    const result = await PPAG.applyPPAGLayout(cy, { delayMs: 0, yieldEvery: 50 });
    assert.equal(result.ok, true, `PPAG failed for seed=${seed}: ${result.message || ''}`);

    const positionsById = {};
    for (const node of cy.nodes()) {
      assert.equal(node._pos !== null, true, `missing PPAG position for node ${node.id()} seed=${seed}`);
      positionsById[node.id()] = node._pos;
    }
    assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById), false, `PPAG produced crossings for seed=${seed}`);
  }
});

test('PPAG layout still improves formerly plateaued instances under the simplified stop rules', async () => {
  for (const sampleName of ['grid4x20', 'sample4']) {
    const text = Generator.getSample(sampleName);
    const graph = parseEdgeListText(text);
    const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

    const baseline = Tutte.applyTutteLayout(cy);
    assert.equal(baseline.ok, true, `Tutte baseline failed on ${sampleName}: ${baseline.message || ''}`);
    const before = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
    assert.equal(before.ok, true, `Baseline face score failed on ${sampleName}: ${before.reason || ''}`);

    const result = await PPAG.applyPPAGLayout(cy, { delayMs: 0, maxIters: 200 });
    assert.equal(result.ok, true, `PPAG failed on ${sampleName}: ${result.message || ''}`);
    assert.equal(result.iters <= 200, true, `PPAG exceeded maxIters on ${sampleName}: ${result.iters}`);

    const after = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
    assert.equal(after.ok, true, `PPAG face score failed on ${sampleName}: ${after.reason || ''}`);
    assert.ok(after.quality + 1e-6 >= before.quality, `PPAG worsened face balance on ${sampleName}: before=${before.quality}, after=${after.quality}`);
  }
});

test('PPAG layout stays plane on randomplanar5 benchmark graph', async () => {
  const text = Generator.getSample('randomplanar5');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await PPAG.applyPPAGLayout(cy, { delayMs: 0, maxIters: 200, yieldEvery: 50 });
  assert.equal(result.ok, true, `PPAG failed on randomplanar5: ${result.message || ''}`);

  const positionsById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing PPAG position for node ${node.id()}`);
    positionsById[node.id()] = node._pos;
  }
  assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById), false, 'PPAG produced crossings on randomplanar5');
});

test('FaceBalancer layout applies on planar sample and improves bounded face balance', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const baseline = Tutte.applyTutteLayout(cy);
  assert.equal(baseline.ok, true, baseline.message || 'Tutte baseline failed');
  const before = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
  assert.equal(before.ok, true, before.reason || 'Baseline face score failed');

  const result = await FaceBalancer.applyFaceBalancerLayout(cy, { delayMs: 0, maxIters: 25 });
  assert.equal(result.ok, true, result.message || 'FaceBalancer failed');
  assert.equal(cy._fitCalls > 0, true);

  const after = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
  assert.equal(after.ok, true, after.reason || 'FaceBalancer face score failed');
  assert.ok(Number.isFinite(after.quality), 'FaceBalancer face quality is not finite');
  assert.ok(after.quality + 1e-6 >= before.quality, `FaceBalancer worsened face balance: before=${before.quality}, after=${after.quality}`);

  const positionsById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing FaceBalancer position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
    positionsById[node.id()] = node._pos;
  }
  assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById), false, 'FaceBalancer introduced crossings on sample1');
});

test('FaceBalancer layout rejects non-planar graphs', async () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await FaceBalancer.applyFaceBalancerLayout(cy, { delayMs: 0 });
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /planar graph/i);
});

test('FaceBalancer handles randomplanar4 without failing', async () => {
  const text = Generator.getSample('randomplanar4');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await FaceBalancer.applyFaceBalancerLayout(cy, { delayMs: 0, maxIters: 20 });
  assert.equal(result.ok, true, result.message || 'FaceBalancer failed on randomplanar4');
});

test('FaceBalancer preserves a plane drawing on planar3tree100', async () => {
  const text = Generator.getSample('planar3tree100');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await FaceBalancer.applyFaceBalancerLayout(cy, { delayMs: 0, maxIters: 40 });
  assert.equal(result.ok, true, result.message || 'FaceBalancer failed on planar3tree100');

  const positionsById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing FaceBalancer position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
    positionsById[node.id()] = node._pos;
  }

  assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById), false, 'FaceBalancer introduced crossings on planar3tree100');
});

test('FaceBalancer avoids severe edge and face collapse on planar3tree30', async () => {
  const text = Generator.getSample('planar3tree30');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await FaceBalancer.applyFaceBalancerLayout(cy, { delayMs: 0, maxIters: 40 });
  assert.equal(result.ok, true, result.message || 'FaceBalancer failed on planar3tree30');

  const positionsById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing FaceBalancer position for node ${node.id()}`);
    positionsById[node.id()] = node._pos;
  }

  assert.equal(hasEdgeCrossing(graph.nodeIds, graph.edgePairs, positionsById), false, 'FaceBalancer introduced crossings on planar3tree30');
  assert.ok((edgeLengthRatio(graph.edgePairs, positionsById) || 0) > 1e-6, 'FaceBalancer still collapses an original edge on planar3tree30');
  assert.ok((minBoundedFaceArea(graph, positionsById) || 0) > 1e-4, 'FaceBalancer still collapses a bounded face on planar3tree30');
});

test('CEG23-bfs layout applies on planar sample and assigns finite positions', () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = CEG23.applyCEG23BfsLayout(cy);
  assert.equal(result.ok, true, result.message || 'CEG23-bfs failed');
  assert.equal(cy._fitCalls > 0, true);

  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing CEG23-bfs position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
  }
});

test('CEG23-bfs rejects non-planar graphs', () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = CEG23.applyCEG23BfsLayout(cy);
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /planar graph/i);
});

test('CEG23-xy layout applies on planar sample and assigns finite positions', () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = CEG23XY.applyCEG23XyLayout(cy);
  assert.equal(result.ok, true, result.message || 'CEG23-xy failed');
  assert.equal(cy._fitCalls > 0, true);

  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing CEG23-xy position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
  }
});

test('CEG23-xy rejects non-planar graphs', () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = CEG23XY.applyCEG23XyLayout(cy);
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /planar graph/i);
});

test('CEG23-xy runs on G(50, 144) without crossings', () => {
  const text = Generator.getSample('randomplanar3'); // G(50, 144)
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = CEG23XY.applyCEG23XyLayout(cy);
  assert.equal(result.ok, true, result.message || 'CEG23-xy failed on G(50,144)');
  assert.equal(cy._fitCalls > 0, true);

  const posById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing CEG23-xy position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
    posById[String(node.id())] = { x: node._pos.x, y: node._pos.y };
  }
  assert.equal(GraphUtils.hasPositionCrossings(posById, graph.edgePairs), false);
});

test('ImPrEd layout applies on sample1 and assigns finite positions', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await ImPrEd.applyImPrEdLayout(cy, { maxIters: 40, delayMs: 0, fit: true });
  assert.equal(result.ok, true, result.message || 'ImPrEd failed');
  assert.equal(cy._fitCalls > 0, true);

  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing ImPrEd position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
  }
});

test('ImPrEd rejects non-planar graphs', async () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await ImPrEd.applyImPrEdLayout(cy, { maxIters: 30, delayMs: 0 });
  assert.equal(result.ok, false, 'ImPrEd should reject non-planar graphs');
  assert.match(String(result.message || ''), /requires a planar graph/i);
});

test('ImPrEd keeps planar G(50, 144) drawing without crossings', async () => {
  const text = Generator.getSample('randomplanar3'); // G(50, 144)
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await ImPrEd.applyImPrEdLayout(cy, { maxIters: 60, delayMs: 0 });
  assert.equal(result.ok, true, result.message || 'ImPrEd failed on G(50,144)');

  const posById = {};
  for (const node of cy.nodes()) {
    posById[String(node.id())] = { x: node._pos.x, y: node._pos.y };
  }
  assert.equal(GraphUtils.hasPositionCrossings(posById, graph.edgePairs), false);
});

test('ImPrEd rebuilds a crossing start on xtree30 into a plane drawing', async () => {
  const text = Generator.getSample('xtree30');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const before = {};
  for (const node of cy.nodes()) {
    before[String(node.id())] = { x: node.position().x, y: node.position().y };
  }
  assert.equal(GraphUtils.hasPositionCrossings(before, graph.edgePairs), true, 'xtree30 mock start should be non-plane');

  const result = await ImPrEd.applyImPrEdLayout(cy, { maxIters: 120, delayMs: 0 });
  assert.equal(result.ok, true, result.message || 'ImPrEd failed on xtree30');

  const after = {};
  for (const node of cy.nodes()) {
    after[String(node.id())] = { x: node.position().x, y: node.position().y };
  }
  assert.equal(GraphUtils.hasPositionCrossings(after, graph.edgePairs), false, 'ImPrEd should rebuild xtree30 to a plane drawing');
});

test('ImPrEd does not introduce crossings on sample1 with original coordinates', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const initialPos = parseVertexPositionsFromEdgeList(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  for (const node of cy.nodes()) {
    const id = String(node.id());
    const p = initialPos[id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      node.position({ x: p.x, y: p.y });
    }
  }

  const before = {};
  for (const node of cy.nodes()) {
    before[String(node.id())] = { x: node.position().x, y: node.position().y };
  }
  assert.equal(GraphUtils.hasPositionCrossings(before, graph.edgePairs), false, 'sample1 initial coordinates should be plane');

  const result = await ImPrEd.applyImPrEdLayout(cy, { maxIters: 80, delayMs: -1 });
  assert.equal(result.ok, true, result.message || 'ImPrEd failed on sample1');

  const after = {};
  for (const node of cy.nodes()) {
    after[String(node.id())] = { x: node.position().x, y: node.position().y };
  }
  assert.equal(GraphUtils.hasPositionCrossings(after, graph.edgePairs), false, 'ImPrEd introduced crossings on sample1');
});

test('ImPrEd keeps drawing plane after every iteration on sample1 coordinates', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const initialPos = parseVertexPositionsFromEdgeList(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  for (const node of cy.nodes()) {
    const id = String(node.id());
    const p = initialPos[id];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      node.position({ x: p.x, y: p.y });
    }
  }

  const before = {};
  for (const node of cy.nodes()) {
    before[String(node.id())] = { x: node.position().x, y: node.position().y };
  }
  assert.equal(GraphUtils.hasPositionCrossings(before, graph.edgePairs), false, 'sample1 initial coordinates should be plane');

  let seenIterations = 0;
  const result = await ImPrEd.applyImPrEdLayout(cy, {
    maxIters: 80,
    delayMs: -1,
    onIteration(progress) {
      seenIterations += 1;
      assert.equal(!!(progress && progress.hasCrossings), false, `crossings introduced at iteration ${progress ? progress.iter : '?'}`);
    }
  });
  assert.equal(result.ok, true, result.message || 'ImPrEd failed on sample1');
  assert.ok(seenIterations > 0, 'ImPrEd did not report iterations');
});

test('ImPrEd default iteration budget exceeds legacy short run length', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);
  let reportedMaxIters = null;

  const result = await ImPrEd.applyImPrEdLayout(cy, {
    delayMs: -1,
    onIteration(progress) {
      if (progress && reportedMaxIters === null) {
        reportedMaxIters = progress.maxIters;
      }
    }
  });
  assert.equal(result.ok, true, result.message || 'ImPrEd failed on sample1');
  assert.ok(reportedMaxIters > 120, `expected default maxIters to exceed 120, got ${reportedMaxIters}`);
});

test('ImPrEd stops early when movements become insignificant', async () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = await ImPrEd.applyImPrEdLayout(cy, {
    maxIters: 500,
    minItersBeforeStop: 1,
    stableIterLimit: 1,
    movementStopTol: 1e9,
    avgMovementStopTol: 1e9,
    delayMs: -1
  });
  assert.equal(result.ok, true, result.message || 'ImPrEd failed on sample1');
  assert.notEqual(result.stopReason, 'max-iters');
  assert.ok(result.iterations < 500, `expected early convergence stop, got ${result.iterations} iterations`);
});

test('CEG23-bfs parameter sweep on sample1/sample2 tunes Face Areas score', () => {
  const samples = ['sample1', 'sample2'];
  const depthSources = ['outer-multi', 'outer-single'];
  const edgeDepthModes = ['min', 'avg', 'max'];
  const decayR = [1.10, 1.20, 1.30, 1.45, 1.60, 1.80];
  const scaleA = [0.5, 1.0, 2.0];
  const maxIters = 800;

  for (const sampleName of samples) {
    const text = Generator.getSample(sampleName);
    const graph = parseEdgeListText(text);

    const baselineCy = buildMockCy(graph.nodeIds, graph.edgePairs);
    seedGridPositions(baselineCy, graph.nodeIds);
    const baselineRes = CEG23.applyCEG23BfsLayout(baselineCy, {
      depthSource: 'outer-multi',
      edgeDepthMode: 'min',
      a: 1.0,
      r: 1.35,
      maxIters
    });
    assert.equal(baselineRes.ok, true, `baseline CEG23-bfs failed on ${sampleName}`);
    const baselineFace = Metrics.computeUniformFaceAreaScoreFromCy(baselineCy, graph.edgePairs);
    assert.equal(baselineFace.ok, true, `baseline face metric failed on ${sampleName}: ${baselineFace.reason || ''}`);

    let bestScore = baselineFace.quality;
    let bestParams = {
      depthSource: 'outer-multi',
      edgeDepthMode: 'min',
      a: 1.0,
      r: 1.35
    };

    const t0 = Date.now();
    let runs = 0;
    for (const depthSource of depthSources) {
      for (const edgeDepthMode of edgeDepthModes) {
        for (const r of decayR) {
          for (const a of scaleA) {
            const cy = buildMockCy(graph.nodeIds, graph.edgePairs);
            seedGridPositions(cy, graph.nodeIds);
            const result = CEG23.applyCEG23BfsLayout(cy, {
              depthSource: depthSource,
              edgeDepthMode: edgeDepthMode,
              a: a,
              r: r,
              maxIters: maxIters
            });
            assert.equal(result.ok, true, `CEG23-bfs failed on ${sampleName} with ${depthSource}/${edgeDepthMode}/a=${a}/r=${r}`);
            const face = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
            assert.equal(face.ok, true, `face metric failed on ${sampleName}: ${face.reason || ''}`);
            runs += 1;
            if (face.quality > bestScore) {
              bestScore = face.quality;
              bestParams = { depthSource, edgeDepthMode, a, r };
            }
          }
        }
      }
    }
    const elapsedMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      `[CEG23-bfs sweep] ${sampleName}: baseline=${baselineFace.quality.toFixed(4)} best=${bestScore.toFixed(4)} ` +
      `params=${JSON.stringify(bestParams)} runs=${runs} time_ms=${elapsedMs}`
    );

    assert.ok(Number.isFinite(bestScore), `best score is not finite for ${sampleName}`);
    assert.ok(bestScore >= baselineFace.quality - 1e-12, `sweep regressed ${sampleName}`);
  }
});

test('Tutte rejects graphs with fewer than 3 vertices', () => {
  const graph = {
    nodeIds: ['a', 'b'],
    edgePairs: [['a', 'b']]
  };
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);
  const result = Tutte.applyTutteLayout(cy);
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /at least 3 vertices/i);
});

test('3-connectivity helpers distinguish strict and internal 3-connectivity', () => {
  const graph = {
    nodeIds: ['1', '2', '3', '4'],
    edgePairs: [['1', '2'], ['2', '3'], ['3', '4'], ['4', '1']]
  };

  const strict = GraphUtils.analyzeThreeConnectivity(graph.nodeIds, graph.edgePairs);
  assert.equal(strict.ok, false);
  assert.match(String(strict.reason || ''), /3-connected/i);

  const internal = GraphUtils.analyzeInternallyThreeConnected(graph.nodeIds, graph.edgePairs, ['1', '2', '3', '4']);
  assert.equal(internal.ok, true, internal.reason || 'cycle should be internally 3-connected with its outer cycle');
});

test('Tutte uses the common outer face and succeeds on grid2x10 after augmentation', () => {
  const text = Generator.getSample('grid2x10');
  const graph = parseEdgeListText(text);
  const embedding = Planarity.computePlanarEmbedding(graph.nodeIds, graph.edgePairs);
  const outer = GraphUtils.chooseOuterFaceFromEmbedding(embedding);
  assert.equal(Array.isArray(outer), true);
  assert.equal(outer.length, 4);
  assert.equal(GraphUtils.analyzeInternallyThreeConnected(graph.nodeIds, graph.edgePairs, outer).ok, false);

  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = Tutte.applyTutteLayout(cy);
  assert.equal(result.ok, true, result.message || 'Tutte should succeed on grid2x10 after augmentation');
});

test('FD-uniform applies on planar sample and assigns finite positions', () => {
  const text = Generator.getSample('sample1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = FDUniform.applyFDUniformLayout(cy, { maxIters: 120 });
  assert.equal(result.ok, true, result.message || 'FD-uniform failed');
  assert.equal(cy._fitCalls > 0, true);

  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing FD-uniform position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
  }
});

test('FD-uniform rejects non-planar graphs', () => {
  const text = Generator.getSample('nonplanar1');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = FDUniform.applyFDUniformLayout(cy);
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /planar graph/i);
});

test('FD-uniform preserves planarity on randomplanar2 (G(50, 130))', () => {
  const text = Generator.getSample('randomplanar2');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = FDUniform.applyFDUniformLayout(cy, { maxIters: 160 });
  assert.equal(result.ok, true, result.message || 'FD-uniform failed on randomplanar2');

  const posById = {};
  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing FD-uniform position for node ${node.id()}`);
    posById[String(node.id())] = { x: node._pos.x, y: node._pos.y };
  }
  assert.equal(GraphUtils.hasPositionCrossings(posById, graph.edgePairs), false);
});

test('P3T layout applies on planar3tree10 sample', () => {
  const text = Generator.getSample('planar3tree10');
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = P3T.applyP3TLayout(cy);
  assert.equal(result.ok, true, result.message || 'P3T failed');
  assert.equal(cy._fitCalls > 0, true);

  for (const node of cy.nodes()) {
    assert.equal(node._pos !== null, true, `missing P3T position for node ${node.id()}`);
    assert.equal(Number.isFinite(node._pos.x), true);
    assert.equal(Number.isFinite(node._pos.y), true);
  }
});

test('P3T rejects planar non-3-tree graph', () => {
  const text = Generator.wheelGraph(7);
  const graph = parseEdgeListText(text);
  const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

  const result = P3T.applyP3TLayout(cy);
  assert.equal(result.ok, false);
  assert.match(String(result.message || ''), /planar 3-tree/i);
});

test('ReweightTutte quality stays above threshold on 10 random planar graphs', async () => {
  for (let seed = 1; seed <= 10; seed += 1) {
    const text = Generator.planarStellationGraph(100, 10, seed);
    const graph = parseEdgeListText(text);
    const cy = buildMockCy(graph.nodeIds, graph.edgePairs);

    for (let i = 0; i < graph.nodeIds.length; i += 1) {
      const id = graph.nodeIds[i];
      const node = cy.nodes().find((n) => n.id() === id);
      node.position({ x: (i % 10) * 40, y: Math.floor(i / 10) * 40 });
    }

    const result = await Reweight.applyReweightTutteLayout(cy, { delayMs: 0 });
    assert.equal(result.ok, true, `Reweight failed for seed=${seed}: ${result.message || ''}`);

    const face = Metrics.computeUniformFaceAreaScoreFromCy(cy, graph.edgePairs);
    assert.equal(face.ok, true, `Face metric failed for seed=${seed}: ${face.reason || ''}`);
    assert.ok(face.quality >= 0.60, `Low Reweight quality for seed=${seed}: ${face.quality}`);
  }
});
